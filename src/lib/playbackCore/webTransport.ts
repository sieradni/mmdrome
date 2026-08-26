/**
 * WebTransport (TODO 1.0 Step 2) — the foreground web adapter over the
 * a/b-element engine (audioManager). It owns:
 *  - the element listeners (play/pause/ended/error/waiting/playing) that used
 *    to live in `playbackManager._attachPlaybackListeners`;
 *  - the crossfade arm (`prepareNext`) — remembering the armed target id and
 *    replay-gain fields (the manager's `_crossfadeTrackId` moves here);
 *  - the replay-gain refresh on a switch (1.10-3): the engine's standby node
 *    got the armed linear gain at fade-in (A7), but its current track/album
 *    gain fields still hold the OLD track's values — a later mode change
 *    would re-apply stale gain to the new active element;
 *  - the error retry machine: `RetryPolicy` (web 3×1s/2s/4s) + the timer and
 *    the last-played-track validity check — per RetryPolicy's documented
 *    contract ("the adapter owns the setTimeout, the track-keyed validity
 *    check... and the give-up action"). The give-up fires `onTrackEnded`
 *    with `fromError: true` (the manager's advance chain skips the sleep
 *    park on those). The play()-rejection loop in `playLoaded` is
 *    DELIBERATELY outside RetryPolicy (autoplay-policy problem, not backoff).
 *
 * Boundary: the transport never touches the queue, stores, or sleep timer.
 * The engine is injected (audioManager satisfies the interface
 * structurally), and the timers are injectable so the suite can run
 * deterministically under node --test.
 */

import { RetryPolicy, type RetryPolicyConfig } from './retryPolicy'
import type { PlaybackTransport, ReplayGainFields, TransportEndedEvent, TransportTrack } from './types'

/** The audioManager surface the transport drives. */
export interface WebTransportEngine {
  a: HTMLAudioElement
  b: HTMLAudioElement
  readonly activeElement: HTMLAudioElement
  readonly playbackElement: HTMLAudioElement
  setNextTrack(url: string | null, replayGainLinear?: number, nextDurationSeconds?: number): void
  cancelNextTrack(): void
  onTrackEnd: (() => void) | null
  reapplyEffects(): void
  applyReplayGain(trackGainDb?: number | null, albumGainDb?: number | null): void
}

export interface WebTransportTimers {
  sleep(ms: number): Promise<void>
  schedule(delayMs: number, fn: () => void): () => void
}

const defaultTimers: WebTransportTimers = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  schedule: (delayMs, fn) => {
    const id = setTimeout(fn, delayMs)
    return () => clearTimeout(id)
  },
}

const WEB_RETRY: RetryPolicyConfig = { maxAttempts: 3, baseDelayMs: 1000 }

export class WebTransport implements PlaybackTransport {
  private readonly _engine: WebTransportEngine
  private readonly _timers: WebTransportTimers
  private readonly _retry = new RetryPolicy(WEB_RETRY)
  private _crossfadeTargetId: string | null = null
  private _armedRg: ReplayGainFields | null = null
  private _lastTrackId: string | null = null
  private _retryTrackId: string | null = null
  private _retryCancel: (() => void) | null = null

  onTrackEnded: ((event: TransportEndedEvent) => void) | null = null
  onRetry: ((trackId: string) => void) | null = null
  onPlaybackState: ((state: 'playing' | 'paused' | 'buffering') => void) | null = null

  constructor(engine: WebTransportEngine, timers: WebTransportTimers = defaultTimers) {
    this._engine = engine
    this._timers = timers
  }

  get playbackElement(): HTMLAudioElement {
    return this._engine.playbackElement
  }

  async init(): Promise<void> {
    this._engine.onTrackEnd = () => this._handleEngineCrossfadeEnd()
    const { a, b } = this._engine
    for (const el of [a, b]) {
      el.addEventListener('play', this._onPlay)
      el.addEventListener('pause', this._onPause)
      el.addEventListener('ended', this._onEnded)
      el.addEventListener('error', this._onError)
      el.addEventListener('waiting', this._onWaiting)
      el.addEventListener('playing', this._onPlaying)
    }
  }

  destroy(): void {
    this._engine.onTrackEnd = null
    this._resetRetry()
    this._crossfadeTargetId = null
    this._armedRg = null
    this._engine.cancelNextTrack()
    const { a, b } = this._engine
    for (const el of [a, b]) {
      el.removeEventListener('play', this._onPlay)
      el.removeEventListener('pause', this._onPause)
      el.removeEventListener('ended', this._onEnded)
      el.removeEventListener('error', this._onError)
      el.removeEventListener('waiting', this._onWaiting)
      el.removeEventListener('playing', this._onPlaying)
    }
  }

  async playLoaded(track: TransportTrack): Promise<boolean> {
    const el = this._engine.activeElement
    let playAttempt = 0
    let played = false
    while (playAttempt < 3 && !played) {
      try {
        await el.play()
        played = true
      } catch {
        playAttempt++
        if (playAttempt >= 3) return false
        await this._timers.sleep(Math.pow(2, playAttempt) * 500)
      }
    }
    this._engine.reapplyEffects()
    this._engine.applyReplayGain(track.replayGain, track.albumReplayGain)
    this._resetRetry()
    this._lastTrackId = track.trackId
    return true
  }

  prepareNext(
    targetId: string | null,
    url: string | null,
    rg?: ReplayGainFields,
    nextDuration?: number,
  ): void {
    this._crossfadeTargetId = targetId
    this._armedRg = rg ?? null
    this._engine.setNextTrack(url, rg?.linearGain ?? undefined, nextDuration)
  }

  cancelNext(): void {
    this._crossfadeTargetId = null
    this._armedRg = null
    this._engine.cancelNextTrack()
  }

  private _handleEngineCrossfadeEnd(): void {
    const targetId = this._crossfadeTargetId
    const rg = this._armedRg
    this._crossfadeTargetId = null
    this._armedRg = null

    // RG refresh on switch (1.10-3): the standby node already holds the armed
    // linear gain (A7), but the engine's current track/album fields still
    // describe the OLD track — a later mode change would re-apply stale gain.
    // Re-applying is idempotent in every mode (same values → same node gain).
    this._engine.applyReplayGain(rg?.trackGainDb ?? null, rg?.albumGainDb ?? null)

    if (targetId !== null) {
      // The switch IS a successful end of the old track — cancel any pending
      // retry and make the switched-to track the validity anchor.
      this._resetRetry()
      this._lastTrackId = targetId
    }

    this.onTrackEnded?.({ kind: 'crossfade', targetId })
  }

  private readonly _onPlay = (): void => {
    this.onPlaybackState?.('playing')
  }

  private readonly _onPause = (e: Event): void => {
    const target = e.target as HTMLAudioElement
    if (target !== this._engine.activeElement) return
    if (target.ended) return
    this.onPlaybackState?.('paused')
  }

  private readonly _onEnded = (e: Event): void => {
    const target = e.target as HTMLAudioElement
    if (target !== this._engine.activeElement) return
    this._resetRetry()
    this.onTrackEnded?.({ kind: 'natural', fromError: false })
  }

  private readonly _onError = (e: Event): void => {
    const target = e.target as HTMLAudioElement
    if (target !== this._engine.activeElement) return
    this._handleElementError()
  }

  private readonly _onWaiting = (): void => {
    this.onPlaybackState?.('buffering')
  }

  private readonly _onPlaying = (): void => {
    this.onPlaybackState?.('playing')
  }

  private _handleElementError(): void {
    if (this._lastTrackId === null) return
    if (this._retryTrackId !== this._lastTrackId) this._resetRetry()
    const decision = this._retry.onError()
    if (decision.kind === 'give-up') {
      this._resetRetry()
      this.onTrackEnded?.({ kind: 'natural', fromError: true })
      return
    }
    this._retryTrackId = this._lastTrackId
    this._retryCancel = this._timers.schedule(decision.delayMs, () => {
      this._retryCancel = null
      if (this._retryTrackId !== null && this._retryTrackId === this._lastTrackId) {
        this.onRetry?.(this._retryTrackId)
      }
    })
  }

  private _resetRetry(): void {
    this._retry.reset()
    this._retryTrackId = null
    if (this._retryCancel !== null) {
      this._retryCancel()
      this._retryCancel = null
    }
  }
}
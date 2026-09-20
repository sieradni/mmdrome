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
import { dbgAlways, dbgDanger } from '../debugLog'
import { assessEnded } from './truncationEvidence'
import type { PlaybackTransport, PlayLoadedResult, ReplayGainFields, TransportEndedEvent, TransportTrack } from './types'

/** The HTMLMediaElement error dictionary (mediaError.code) — the ONE
 *  diagnostic an element error carries. Names map to the user-meaningful
 *  failure classes: 1 aborted, 2 network, 3 decode, 4 src-not-supported. */
const MEDIA_ERROR_NAMES: Record<number, string> = {
  1: 'MEDIA_ERR_ABORTED',
  2: 'MEDIA_ERR_NETWORK',
  3: 'MEDIA_ERR_DECODE',
  4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
}

function mediaErrorLabel(el: HTMLMediaElement): string {
  const err = el.error
  if (!err) return 'error event without MediaError'
  const name = MEDIA_ERROR_NAMES[err.code] ?? `MEDIA_ERR_${err.code}`
  return `${name} (${err.message || 'no message'})`
}

/** Truncation evidence at the `ended` boundary (OBSERVE-ONLY, 2026-09-20):
 *  the web mirror of the native premature-completion gate, logging without
 *  acting. A stream cut mid-body fires `ended` when the DATA runs out while
 *  the container's metadata duration still claims full length — the same
 *  "where is the rest of the audio" question the native elapsed gate asks.
 *  Margin 1.5 s absorbs codec delay-presentation padding and the metadata
 *  duration's rounding; a legit end lands within milliseconds of duration. */
const TRUNCATION_MARGIN_S = 1.5

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

/** A pending-forever el.play() — observed under extreme CPU/memory pressure
 *  where the element starts neither decoding nor erroring — is the ONE
 *  pre-start failure the rejection loop below cannot see (the promise never
 *  rejects, so the attempts never advance and the queue sits silent at
 *  playhead 0). The settle watch races each play() and declares it dead only
 *  after CONSECUTIVE NO-PROGRESS windows: a healthy element that is merely
 *  BUFFERING (slow network, cold start) shows readyState/buffered/time
 *  movement and is never declared stalled — the watch must not convert
 *  "slow" into "failed". A stalled attempt then rides the SAME 1 s/2 s
 *  backoff and re-issue as a real rejection (calling play() again returns
 *  the still-pending promise, so the re-issue is free). A genuinely
 *  superseded hung promise self-rejects with AbortError when a later load
 *  re-assigns src. The watch uses the injectable `schedule` so the suite
 *  can drive it deterministically. */
const PLAY_WATCH_MS = 3000
const PLAY_WATCH_STALLED_WINDOWS = 2

/** Cheap progress fingerprint of a media element: any change across watch
 *  windows means the element is working (loading/decoding/playing). */
function elProgress(el: HTMLMediaElement): string {
  let end = 0
  try {
    const b = el.buffered
    for (let i = 0; i < b.length; i++) end = Math.max(end, b.end(i))
  } catch { /* torn-down element */ }
  return `${el.readyState}|${end.toFixed(3)}|${el.currentTime.toFixed(3)}`
}

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

  async playLoaded(track: TransportTrack): Promise<PlayLoadedResult> {
    const el = this._engine.activeElement
    let playAttempt = 0
    let played = false
    let errorName: string | null = null
    while (playAttempt < 3 && !played) {
      try {
        await this._playWithSettleWatch(el)
        played = true
      } catch (err) {
        // The rejection NAME is the diagnosis the manager routes on
        // (NotAllowedError = policy → stay; NotSupportedError = bad bytes →
        // advance; AbortError = superseded → silent). Never invented: an
        // exotic rejection keeps whatever name it carried (or none), which
        // routes to the legacy stop. PlaySettleTimeout (synthetic, from the
        // settle watch) also routes to the legacy stop — conservative: a
        // device too starved to START audio must not auto-advance forever,
        // and a slow network is excluded by the watch's progress check.
        errorName = err instanceof Error ? err.name : null
        playAttempt++
        // Parity with the native transport's error events (2026-09-20): the
        // rejection name + attempt are the decision input the manager routes
        // on — a web skip report must show them where native shows its
        // engine error + retry verdict.
        dbgDanger(
          'playback',
          `play() rejected attempt ${playAttempt}/3 name=${errorName ?? 'unknown'} track=${track.trackId}`,
        )
        if (playAttempt >= 3) {
          dbgAlways('playback', `play() abandoned after 3 attempts track=${track.trackId} lastError=${errorName ?? 'unknown'}`)
          return { started: false, errorName }
        }
        await this._timers.sleep(Math.pow(2, playAttempt) * 500)
      }
    }
    this._engine.reapplyEffects()
    this._engine.applyReplayGain(track.replayGain, track.albumReplayGain)
    this._resetRetry()
    this._lastTrackId = track.trackId
    return { started: true, errorName: null }
  }

  /** One el.play() raced against the progress-aware settle watch. The
   *  underlying promise is not cancellable; the loser of the race is simply
   *  unobserved (its handlers are attached here, so no unhandled-rejection
   *  noise). Re-arming rides the injectable `schedule`. */
  private _playWithSettleWatch(el: HTMLAudioElement): Promise<void> {
    const playPromise = el.play()
    return new Promise<void>((resolve, reject) => {
      let settled = false
      let stalledWindows = 0
      let lastState = elProgress(el)
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        fn()
      }
      const armWatch = (): void => {
        const cancel = this._timers.schedule(PLAY_WATCH_MS, () => {
          const state = elProgress(el)
          if (state !== lastState) {
            // The element is working (buffering/decoding) — healthy-slow.
            lastState = state
            stalledWindows = 0
            armWatch()
            return
          }
          stalledWindows++
          if (stalledWindows >= PLAY_WATCH_STALLED_WINDOWS) {
            // The watch's verdict must be verifiable: which fingerprint
            // stalled twice decides whether this was a genuine hang or a
            // progress fingerprint that moved too subtly to count.
            dbgDanger('playback', `play() stalled: no element progress across ${PLAY_WATCH_STALLED_WINDOWS} windows (state=${state})`)
            finish(() => reject(Object.assign(new Error('play() pending with no element progress'), { name: 'PlaySettleTimeout' })))
            return
          }
          armWatch()
        })
        cancelRef.cancel = cancel
      }
      const cancelRef: { cancel: () => void } = { cancel: () => {} }
      // `finish` must also stop the CURRENT watch arm.
      const finishAll = (fn: () => void) => {
        cancelRef.cancel()
        finish(fn)
      }
      armWatch()
      playPromise.then(
        () => finishAll(resolve),
        (err) => finishAll(() => reject(err)),
      )
    })
  }

  prepareNext(
    targetId: string | null,
    url: string | null,
    rg?: ReplayGainFields,
    nextDuration?: number,
  ): void {
    // Parity with the native 'crossfade' domain (fade start/abort): the arm
    // + cancel decisions are the web fade lifecycle's two visible edges.
    if (targetId !== this._crossfadeTargetId) {
      dbgAlways(
        'crossfade',
        targetId !== null ? `fade armed target=${targetId} dur=${nextDuration ?? '?'}` : `fade disarmed (was ${this._crossfadeTargetId ?? 'none'})`,
      )
    }
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

    // Parity with the native 'crossfade' info ("fade complete track=..."):
    // the switch IS the web fade's completion event.
    dbgAlways('crossfade', `fade complete target=${targetId ?? 'null (cancelled arm)'}`)

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
    // OBSERVE-ONLY truncation gate (2026-09-20, ledger item #2's first step):
    // ended + currentTime well short of the metadata duration is the web's
    // cut-position-independent truncation evidence — the same question the
    // native elapsed gate asks at completion time. Logged, never acted on:
    // acting (drop + bounded retry like native) waits for field evidence.
    const verdict = assessEnded({
      currentTime: target.currentTime,
      duration: target.duration,
      marginSeconds: TRUNCATION_MARGIN_S,
    })
    if (verdict.kind === 'ended-early') {
      dbgDanger('playback', `ended EARLY by ${verdict.shortfallSeconds}s (pos=${target.currentTime.toFixed(1)} dur=${target.duration.toFixed(1)}) — observe-only, advancing`)
    }
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
    // The MediaError dict is the ONE diagnosis an element error carries —
    // record it verbatim (parity with native's engine-error events).
    dbgDanger('playback', `element error: ${mediaErrorLabel(this._engine.activeElement)} track=${this._lastTrackId}`)
    if (this._retryTrackId !== this._lastTrackId) this._resetRetry()
    const decision = this._retry.onError()
    if (decision.kind === 'give-up') {
      // Parity with the native trail's retryGiveUp marker.
      dbgAlways('playback', `retry give-up track=${this._lastTrackId} — advancing fromError`)
      this._resetRetry()
      this.onTrackEnded?.({ kind: 'natural', fromError: true })
      return
    }
    dbgAlways('playback', `retry ${decision.attempt}/${WEB_RETRY.maxAttempts} in ${decision.delayMs}ms track=${this._lastTrackId}`)
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
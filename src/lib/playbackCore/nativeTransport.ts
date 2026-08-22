/**
 * NativeTransport (TODO 1.0 Step 4) — the native iOS adapter over the
 * `BackgroundAudio` plugin bridge. A SIBLING of WebBgTransport, NOT a
 * `PlaybackTransport`: that contract is element-shaped
 * (`playLoaded`/`prepareNext`/`playbackElement`); the native engine is
 * command/event-shaped (it owns the clock and emits trackChanged/ended/error).
 *
 * The transport owns (A6 boundary — it NEVER touches the queue, stores, or
 * sleep timer):
 *  - the plugin listeners (`init` via the injected client — the client is
 *    `nativeEngine`, which satisfies the interface structurally);
 *  - the position poll: enabled while ENGAGED, stopped on disengage/destroy
 *    (parity-plus over the old always-on poll — no bridge chatter at rest);
 *  - `engage` (setQueue + playTrackAt + engaged flag) with THREE guards:
 *    the **fail-fast** check (1.6 — an empty active url rejects before any
 *    plugin call; no more fake 'playing' over a dead engine), the
 *    **stale-settle guard** (an engagement generation bumped by
 *    disengage/destroy drops a settle that lands after a stop) and the
 *    **serialization** (the pre-existing interleave race — two rapid engages
 *    used to emit setQueue(A)→setQueue(B)→playTrackAt(B)→playTrackAt(A),
 *    leaving the engine on queue B at index A; engages now run one cycle at
 *    a time with a pending-latest slot — queued requests supersede each
 *    other, the cycle drains at most one survivor per completed engage);
 *  - the retry machine: `RetryPolicy` native `{maxAttempts: 2,
 *    baseDelayMs: 1000}` (1s/2s; bounded — a failed reload keeps the backoff, unlike the old 1s-forever),
 *    track-keyed validity, superseded timers cancelled, give-up →
 *    `onTrackEnded({kind:'natural', fromError:true})` (the manager's A4 chain
 *    advances); the timer + validity live HERE, the reload action resolves
 *    manager-side via `onRetry(trackId)` (the manager re-engages; a bridge rejection there → engage() false, a (d) recovery decision);
 *  - the seek-retry memory (1.7): `seek` remembers {trackId, position}; a
 *    retry's reload engage of the SAME track re-issues the seek after
 *    playTrackAt resolves (the Swift `loadAndStart` wipes positionBias);
 *    consumed on re-apply, cleared on disengage/give-up. The re-apply
 *    condition requires an ACTIVE retry for that track — a plain re-engage
 *    (loop-one restart, user replay) never re-seeks;
 *  - `scheduleSync(factory)` — the queue-tail refresh with microtask
 *    coalescing: same-task bursts collapse to ONE refreshQueue call; the
 *    factory is evaluated AT FIRE TIME (lazy → always the final snapshot) and
 *    `null` skips the refresh. Re-checks `engaged` at fire time so a
 *    disengage mid-tick never refreshes; the refresh AWAITS any in-flight
 *    engage cycle so a tail write can never interleave setQueue/playTrackAt;
 *  - the command pass-throughs (play/pause/seek/setLoopMode).
 *
 * Policy events (wired by the manager in (d)):
 *  - `onTrackChanged(trackId)` — the manager re-anchors the queue by trackId
 *    (B1);
 *  - `onTrackEnded` — natural (engine `ended`) or fromError (retry give-up) —
 *    the manager runs the A4 advance chain (fromError skips the sleep park);
 *  - `onRetry(trackId)` — a retry timer fired for the last-engaged track; the
 *    manager re-loads it (track-keyed validity check manager-side too);
 *  - `onPlaybackState('playing'|'paused')` — from playbackStateChanged;
 *  - `onTick(position)` — the 250 ms poll for the UI clock.
 *
 * Structural types (no nativePlugin import — the suites run under plain
 * node): `NativeLoopMode`/`NativeSnapshotTrack`/`NativePollState` are
 * minimal shapes the real plugin types satisfy; method-style declarations for
 * TS bivariance (see WebTransportEngine) make the real `nativeEngine`
 * assignable to `NativeEngineClient` (pinned by tests/nativePluginShape.test.ts).
 */

import { RetryPolicy, type RetryPolicyConfig } from './retryPolicy'
import type { TransportEndedEvent } from './types'

export type NativeLoopMode = 'none' | 'one' | 'all'

/** Minimal snapshot row — the full NativeTrackSnapshot satisfies it. */
export interface NativeSnapshotTrack {
  index: number
  trackId: string
  url: string
}

/** The engine-state surface the poll handler reads (NativeEngineState satisfies it). */
export interface NativePollState {
  trackId: string
  position: number
  playing: boolean
}

export interface NativeRefreshPayload {
  tracks: NativeSnapshotTrack[]
  activeIndex: number
}

/** The plugin surface the transport drives (BackgroundAudioPlugin satisfies it). */
export interface NativePluginClient {
  setQueue(options: { tracks: NativeSnapshotTrack[]; activeIndex: number; loopMode: NativeLoopMode }): Promise<void>
  setQueueAndPlay?(options: {
    tracks: NativeSnapshotTrack[]
    activeIndex: number
    loopMode: NativeLoopMode
    autoPlay?: boolean
  }): Promise<void>
  refreshQueue(options: { tracks: NativeSnapshotTrack[]; activeIndex: number }): Promise<void>
  playTrackAt(options: { index: number; autoPlay: boolean }): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  seek(options: { position: number }): Promise<void>
  setLoopMode(options: { loopMode: NativeLoopMode }): Promise<void>
  getState(): Promise<NativePollState>
}

/** The client wrapper surface — the real `nativeEngine` satisfies it. */
export interface NativeEngineClient {
  init(callbacks: {
    onTrackChanged(trackId: string): void
    onPlaybackStateChanged(playing: boolean): void
    onQueueEnded(): void
    onError(message: string): void
  }): Promise<void>
  setPositionPolling(enabled: boolean, handler: (state: NativePollState) => void): void
  plugin(): NativePluginClient
  destroy(): Promise<void>
}

export interface NativeTransportTimers {
  schedule(delayMs: number, fn: () => void): () => void
}

const defaultTimers: NativeTransportTimers = {
  schedule: (delayMs, fn) => {
    const id = setTimeout(fn, delayMs)
    return () => clearTimeout(id)
  },
}

const NATIVE_RETRY: RetryPolicyConfig = { maxAttempts: 2, baseDelayMs: 1000 }

interface EngageRequest {
  snapshot: NativeSnapshotTrack[]
  activeIndex: number
  loopMode: NativeLoopMode
  /** Resolves the CALLER's promise with this request's own outcome (see engage). */
  resolve: (ok: boolean) => void
}

function deferred(): { promise: Promise<boolean>; resolve: (ok: boolean) => void } {
  let resolve!: (ok: boolean) => void
  const promise = new Promise<boolean>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

interface SeekMemory {
  trackId: string
  position: number
}

export class NativeTransport {
  private readonly _client: NativeEngineClient
  private readonly _timers: NativeTransportTimers
  private readonly _retry = new RetryPolicy(NATIVE_RETRY)
  private _engaged = false
  private _syncScheduled = false
  private _syncFactory: (() => NativeRefreshPayload | null) | null = null
  /** Bumped by disengage/destroy — a stale engage settle must never re-engage. */
  private _engagement = 0
  private _lastTrackId: string | null = null
  private _retryTrackId: string | null = null
  private _retryCancel: (() => void) | null = null
  private _seekMemory: SeekMemory | null = null
  private _engageCycle: Promise<boolean> | null = null
  private _pendingEngage: EngageRequest | null = null

  onTrackChanged: ((trackId: string) => void) | null = null
  onTrackEnded: ((event: TransportEndedEvent) => void) | null = null
  onPlaybackState: ((state: 'playing' | 'paused') => void) | null = null
  onRetry: ((trackId: string) => void) | null = null
  onTick: ((position: number) => void) | null = null

  constructor(client: NativeEngineClient, timers: NativeTransportTimers = defaultTimers) {
    this._client = client
    this._timers = timers
  }

  /** True while a queue snapshot is live in the engine (the `_hasNativeEngaged` analog). */
  get engaged(): boolean {
    return this._engaged
  }

  async init(): Promise<void> {
    await this._client.init({
      onTrackChanged: (trackId) => {
        // Engine-truth: while engaged, trackChanged is the authoritative last
        // track for retry validity and seek-memory targeting. Gated on
        // `_engaged` so a stray event after a stop can't resurrect state.
        if (this._engaged) this._lastTrackId = trackId
        this.onTrackChanged?.(trackId)
      },
      onPlaybackStateChanged: (playing) => this.onPlaybackState?.(playing ? 'playing' : 'paused'),
      onQueueEnded: () => this.onTrackEnded?.({ kind: 'natural', fromError: false }),
      onError: (message) => this._handleEngineError(message),
    })
  }

  /**
   * Sends the full queue snapshot and starts the active track. Returns false
   * when the active track has no url (fail-fast, 1.6 — no plugin calls), when
   * the bridge rejected, or when the settle is stale (a disengage/destroy
   * mid-flight bumped the engagement generation). Engages serialize: a
   * request arriving while one is in flight is queued as the pending-latest
   * (superseding earlier queued requests) and runs when the in-flight one
   * completes — the old code interleaved setQueue/playTrackAt across rapid
   * engages, leaving the engine on the wrong queue/index.
   *
   * Each call resolves with ITS OWN request's outcome, not the cycle's: a
   * request superseded by a newer queued engage never runs and resolves
   * `true` (a no-op — the newer request took its place, nothing failed); a
   * request dropped by a mid-flight disengage resolves `false`.
   */
  engage(
    snapshot: NativeSnapshotTrack[],
    activeIndex: number,
    loopMode: NativeLoopMode,
  ): Promise<boolean> {
    const { promise, resolve } = deferred()
    const request: EngageRequest = { snapshot, activeIndex, loopMode, resolve }
    if (this._engageCycle !== null) {
      if (this._pendingEngage !== null) this._pendingEngage.resolve(true)
      this._pendingEngage = request
      return promise
    }
    this._kickCycle(request)
    return promise
  }

  /**
   * Starts the serialization cycle and keeps the in-flight flag honest. The
   * `.finally` MUST hand off a settle-window request instead of dropping it:
   * the caller's continuation (triggered by the last request's deferred
   * resolve, which happens inside `_doEngage` BEFORE the drain loop's final
   * re-check) can queue another engage while the cycle promise is settling
   * but before this finally runs — e.g. `await engage(); await seek();
   * engage()` — and that request would otherwise be orphaned with a promise
   * that never resolves.
   */
  private _kickCycle(first: EngageRequest): void {
    this._engageCycle = this._runEngageCycle(first).finally(() => {
      const next = this._pendingEngage
      if (next !== null) {
        this._pendingEngage = null
        this._kickCycle(next)
      } else {
        this._engageCycle = null
      }
    })
  }

  private async _runEngageCycle(first: EngageRequest): Promise<boolean> {
    const gen = this._engagement
    let result = await this._doEngage(first, gen)
    for (;;) {
      const pending = this._pendingEngage
      if (!pending) break
      this._pendingEngage = null
      // Fresh gen at run time: a request enqueued AFTER a disengage (a new
      // user action) runs; one read before the disengage was dropped by the
      // gen check inside _doEngage (disengage also clears the slot).
      result = await this._doEngage(pending, this._engagement)
    }
    return result
  }

  private async _doEngage(request: EngageRequest, expectedGen: number): Promise<boolean> {
    const active = request.snapshot[request.activeIndex]
    if (!active || !active.url) {
      console.error('[native] failed to start playback: no playable track at index', request.activeIndex)
      request.resolve(false)
      return false
    }
    try {
      const plugin = this._client.plugin()
      if (typeof plugin.setQueueAndPlay === 'function') {
        await plugin.setQueueAndPlay({
          tracks: request.snapshot,
          activeIndex: request.activeIndex,
          loopMode: request.loopMode,
          autoPlay: true,
        })
      } else {
        await plugin.setQueue({
          tracks: request.snapshot,
          activeIndex: request.activeIndex,
          loopMode: request.loopMode,
        })
        await plugin.playTrackAt({ index: request.activeIndex, autoPlay: true })
      }
    } catch (err) {
      console.error('[native] failed to start playback:', err)
      // A replacement engage may have stopped the previously active native
      // queue before failing. Do not leave the adapter claiming that stale
      // queue is live: clear polling/retry identity and best-effort pause any
      // audio left behind by a partially-applied bridge command. This is an
      // internal reset rather than `disengage()`, so a pending-latest engage
      // can still run in the same serialized cycle.
      await this._markEngagementFailed()
      request.resolve(false)
      return false
    }
    if (expectedGen !== this._engagement) {
      request.resolve(false)
      return false
    }
    this._engaged = true
    this._client.setPositionPolling(true, (state) => this.onTick?.(state.position))
    this._lastTrackId = active.trackId
    const retryTarget = this._retryTrackId
    const mem = this._seekMemory
    this._resetRetry()
    if (mem && retryTarget !== null && retryTarget === mem.trackId && retryTarget === this._lastTrackId) {
      // 1.7: this engage IS the retry's reload — re-issue the clamped seek
      // (Swift's loadAndStart wiped positionBias).
      this._seekMemory = null
      void this._client.plugin().seek({ position: mem.position }).catch(() => {})
    }
    request.resolve(true)
    return true
  }

  /** Clears transport state after a bridge command failed during an engage.
   *  Unlike `disengage()`, this does not bump the engagement generation or drop
   *  a pending-latest request; the current engage cycle may still hand off to
   *  that newer request. The best-effort pause is awaited so it cannot land
   *  after a newer engage's play command. When a newer request is already
   *  queued, its setQueue replaces the partial state and avoiding pause also
   *  prevents an old pause from racing that handoff. */
  private async _markEngagementFailed(): Promise<void> {
    this._engaged = false
    this._syncFactory = null
    this._lastTrackId = null
    this._seekMemory = null
    this._resetRetry()
    this._client.setPositionPolling(false, () => {})
    if (this._pendingEngage === null) {
      await this._client.plugin().pause().catch(() => {})
    }
  }

  /** Marks the engine idle: poll stops, retry/seek state dropped, later
   *  queue writes are ignored. */
  disengage(): void {
    this._engagement++
    this._engaged = false
    this._syncFactory = null
    if (this._pendingEngage !== null) {
      this._pendingEngage.resolve(false)
      this._pendingEngage = null
    }
    this._lastTrackId = null
    this._seekMemory = null
    this._resetRetry()
    this._client.setPositionPolling(false, () => {})
  }

  /**
   * Adopts an already-playing engine state without re-sending the snapshot
   * (1.5 webview-reload reconcile): the engine kept playing across a reload
   * while this transport instance is fresh and disengaged. Marks the transport
   * engaged, remembers the track for retry/seek-memory targeting, and starts
   * the position poll. Deliberately does NOT call setQueue/playTrackAt — that
   * would restart the engine and kill the live playback being recovered.
   */
  adopt(trackId: string): void {
    this._engaged = true
    this._lastTrackId = trackId
    this._client.setPositionPolling(true, (state) => this.onTick?.(state.position))
  }

  /**
   * Coalesced queue-tail refresh: same-task bursts collapse into ONE
   * refreshQueue call for the final snapshot. The factory is evaluated at
   * microtask fire time (live state, never stale); returning null skips the
   * refresh. Ignored while disengaged.
   */
  scheduleSync(factory: () => NativeRefreshPayload | null): void {
    if (!this._engaged) return
    this._syncFactory = factory
    if (this._syncScheduled) return
    this._syncScheduled = true
    queueMicrotask(() => {
      this._syncScheduled = false
      if (!this._engaged) return
      const pending = this._syncFactory
      this._syncFactory = null
      const payload = pending ? pending() : null
      if (!payload) return
      void this._refreshQueue(payload)
    })
  }

  private async _refreshQueue(payload: NativeRefreshPayload): Promise<void> {
    // Serialize against engage: the tail refresh must never land between an
    // engage's setQueue and playTrackAt. Engage cycles drain one pending
    // request at a time and null the cycle flag in their finally, so waiting
    // until the flag clears is bounded.
    while (this._engageCycle !== null) {
      await this._engageCycle
    }
    if (!this._engaged) return
    try {
      await this._client.plugin().refreshQueue({ tracks: payload.tracks, activeIndex: payload.activeIndex })
    } catch (err) {
      console.error('[native] refreshQueue failed:', err)
    }
  }

  play(): Promise<void> {
    return this._client.plugin().play()
  }

  pause(): Promise<void> {
    return this._client.plugin().pause()
  }

  /**
   * Forwards the clamped position and remembers it for the retry-reload case
   * (1.7): if this track errors, the retry's reload re-issues the seek after
   * playTrackAt resolves. Only an engage that IS the retry reload re-applies
   * it — plain re-engages (loop-one restart, user replay) never re-seek.
   */
  seek(position: number): Promise<void> {
    if (this._lastTrackId !== null) {
      this._seekMemory = { trackId: this._lastTrackId, position }
    }
    return this._client.plugin().seek({ position })
  }

  setLoopMode(mode: NativeLoopMode): Promise<void> {
    return this._client.plugin().setLoopMode({ loopMode: mode })
  }

  getState(): Promise<NativePollState> {
    return this._client.plugin().getState()
  }

  private _handleEngineError(message: string): void {
    console.error('[native] engine error:', message)
    const last = this._lastTrackId
    if (last === null) return
    if (this._retryTrackId !== last) this._resetRetry()
    const decision = this._retry.onError()
    if (decision.kind === 'give-up') {
      this._resetRetry()
      this._seekMemory = null
      this.onTrackEnded?.({ kind: 'natural', fromError: true })
      return
    }
    this._retryTrackId = last
    if (this._retryCancel !== null) {
      this._retryCancel()
      this._retryCancel = null
    }
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

  async destroy(): Promise<void> {
    this._engagement++
    this._engaged = false
    this._syncScheduled = false
    this._syncFactory = null
    if (this._pendingEngage !== null) {
      this._pendingEngage.resolve(false)
      this._pendingEngage = null
    }
    this._lastTrackId = null
    this._seekMemory = null
    this._resetRetry()
    await this._client.destroy()
  }
}

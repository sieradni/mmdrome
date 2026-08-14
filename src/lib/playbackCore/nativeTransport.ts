/**
 * NativeTransport (TODO 1.0 Step 4, sub-step b — skeleton) — the native iOS
 * adapter over the `BackgroundAudio` plugin bridge. A SIBLING of
 * WebBgTransport, NOT a `PlaybackTransport`: that contract is element-shaped
 * (`playLoaded`/`prepareNext`/`playbackElement`); the native engine is
 * command/event-shaped (it owns the clock and emits trackChanged/ended/error).
 *
 * This skeleton owns (A6 boundary — the transport NEVER touches the queue,
 * stores, or sleep timer):
 *  - the plugin listeners (`init` via the injected client — the client is
 *    `nativeEngine`, which satisfies the interface structurally);
 *  - the position poll: enabled while ENGAGED, stopped on disengage/destroy
 *    (parity-plus over the old always-on poll — no bridge chatter at rest);
 *  - `engage` (setQueue + playTrackAt + engaged flag) and `disengage`;
 *  - `scheduleSync(factory)` — the queue-tail refresh with microtask
 *    coalescing: same-task bursts collapse to ONE refreshQueue call; the
 *    factory is evaluated AT FIRE TIME (lazy → always the final snapshot) and
 *    `null` skips the refresh (the manager's factory bails on an invalid
 *    active index). Re-checks `engaged` at fire time so a disengage mid-tick
 *    never refreshes;
 *  - the command pass-throughs (play/pause/seek/setLoopMode) the manager will
 *    route through in sub-step (d).
 *
 * Policy events (wired by the manager in (d)):
 *  - `onTrackChanged(trackId)` — the manager re-anchors the queue by trackId
 *    (B1) — the native analog of WebTransport's onTrackEnded routing;
 *  - `onTrackEnded({kind:'natural'})` — the engine's `ended` (queue tail
 *    exhausted) — the manager runs the A4 advance chain;
 *  - `onPlaybackState('playing'|'paused')` — from playbackStateChanged;
 *  - `onTick(position)` — the 250 ms poll for the UI clock.
 *
 * Sub-step (c) hardens the error path: RetryPolicy (native cap 2), the
 * give-up → onTrackEnded({kind:'natural', fromError:true}) wiring, the
 * seek-retry memory (1.7), the fail-fast empty-url engage guard (1.6) and the
 * engage serialization (settle-style in-flight guard + pending-latest) —
 * until then the raw `error` listener only logs.
 *
 * Structural types (no nativePlugin import — the suites run under plain
 * node): `NativeLoopMode`/`NativeSnapshotTrack`/`NativePollState` are
 * minimal shapes the real plugin types satisfy; method-style declarations for
 * TS bivariance (see WebTransportEngine) make the real `nativeEngine`
 * assignable to `NativeEngineClient`.
 */

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
  refreshQueue(options: { tracks: NativeSnapshotTrack[]; activeIndex: number }): Promise<void>
  playTrackAt(options: { index: number; autoPlay: boolean }): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  seek(options: { position: number }): Promise<void>
  setLoopMode(options: { loopMode: NativeLoopMode }): Promise<void>
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

export class NativeTransport {
  private readonly _client: NativeEngineClient
  private _engaged = false
  private _syncScheduled = false
  private _syncFactory: (() => NativeRefreshPayload | null) | null = null
  /** Bumped by disengage/destroy — a stale engage settle must never re-engage. */
  private _engagement = 0

  onTrackChanged: ((trackId: string) => void) | null = null
  onTrackEnded: ((event: TransportEndedEvent) => void) | null = null
  onPlaybackState: ((state: 'playing' | 'paused') => void) | null = null
  onTick: ((position: number) => void) | null = null

  constructor(client: NativeEngineClient) {
    this._client = client
  }

  /** True while a queue snapshot is live in the engine (the `_hasNativeEngaged` analog). */
  get engaged(): boolean {
    return this._engaged
  }

  async init(): Promise<void> {
    await this._client.init({
      onTrackChanged: (trackId) => this.onTrackChanged?.(trackId),
      onPlaybackStateChanged: (playing) => this.onPlaybackState?.(playing ? 'playing' : 'paused'),
      onQueueEnded: () => this.onTrackEnded?.({ kind: 'natural', fromError: false }),
      onError: (message) => console.error('[native] engine error:', message),
    })
  }

  /**
   * Sends the full queue snapshot and starts the active track. Returns false
   * when the bridge rejected OR the settle is stale — a disengage/destroy
   * mid-flight bumps the engagement generation, and the completed engage must
   * not re-engage a stopped engine (the stale settle is dropped, parity with
   * the bg settle token). Sub-step (c) adds the fail-fast guard, the in-flight
   * serialization and the retry interplay.
   */
  async engage(
    snapshot: NativeSnapshotTrack[],
    activeIndex: number,
    loopMode: NativeLoopMode,
  ): Promise<boolean> {
    const engagement = this._engagement
    try {
      await this._client.plugin().setQueue({ tracks: snapshot, activeIndex, loopMode })
      await this._client.plugin().playTrackAt({ index: activeIndex, autoPlay: true })
    } catch (err) {
      console.error('[native] failed to start playback:', err)
      return false
    }
    if (engagement !== this._engagement) return false
    this._engaged = true
    this._client.setPositionPolling(true, (state) => this.onTick?.(state.position))
    return true
  }

  /** Marks the engine idle: poll stops, later queue writes are ignored. */
  disengage(): void {
    this._engagement++
    this._engaged = false
    this._syncFactory = null
    this._client.setPositionPolling(false, () => {})
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

  seek(position: number): Promise<void> {
    return this._client.plugin().seek({ position })
  }

  setLoopMode(mode: NativeLoopMode): Promise<void> {
    return this._client.plugin().setLoopMode({ loopMode: mode })
  }

  async destroy(): Promise<void> {
    this._engagement++
    this._engaged = false
    this._syncScheduled = false
    this._syncFactory = null
    await this._client.destroy()
  }
}

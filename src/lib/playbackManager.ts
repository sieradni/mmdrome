import { get } from 'svelte/store'
import { Capacitor } from '@capacitor/core'
import { audioManager } from './audioManager'
import { engine } from './engineFacade'
import { libraryFilters } from './libraryFilters'
import { nativeEngine, BackgroundAudio, type NativeTrackSnapshot } from './nativePlugin'
import { queueManager } from './queueManager'
import { advanceTargetIndex } from './queueMutation'
import { inscribeRecent, RECENT_LIMIT } from './recentWindow'
import { setup as setupPreloader, teardown as teardownPreloader, resolveSrc } from './preloader'
import { setupMediaSession } from './mediaSession'
import { getCoverUrl } from './coverArtCache'
import { getCachedConfig, buildStreamUrl, buildCoverArtUrl, resolveCoverArtId } from './navidromeApi'
import { scrobbleManager } from './scrobbleManager'
import { sleepTimerManager } from './sleepTimer'
import { WebTransport } from './playbackCore/webTransport'
import { WebBgTransport, type BgFacts, type LoadDecision } from './playbackCore/webBgTransport'
import { NativeTransport } from './playbackCore/nativeTransport'
import { reconcileReload } from './playbackCore/nativeReconcile'
import { decideAdvance, type LoopMode } from './playbackCore/advanceDecider'
import { reconcileCrossfadeTarget } from './playbackCore/crossfadeReconcile'
import { computeReplayGainFields } from './playbackCore/replayGain'
import {
  currentTrack,
  playbackState,
  queue,
  library,
  settings,
  shuffleEnabled,
  playbackSpeed,
  pitchOctaves,
  tapeMode,
  snapTolerance,
  masterGain,
  currentTime,
  loopMode,
  metadataScanState,
  setCurrentTrack,
  setPlaybackState,
  setActiveQueueIndex,
  autoQueueFilters,
} from '../stores/appState'
import { saveQueue } from './db'
import { currentEqState, eqBypassed } from './eq/eqStore'
import type { Track } from '../stores/appState'

export class PlaybackManager {
  private _initialized = false
  private _handlingEnd = false
  private _handlingNativeEnd = false
  private _webTransport: WebTransport | null = null
  private _bgTransport: WebBgTransport | null = null
  private _nativeTransport: NativeTransport | null = null
  /** Test override for Capacitor.isNativePlatform — the glue suite runs under Node. */
  private _isNative: (() => boolean) | null = null
  private _refreshPositionState: () => void = () => {}
  /** The track an in-flight bg load request resolved to — the machine's
   *  'reload' decision loads this (an exit-race re-routes it to the fg path). */
  private _pendingBgTrack: Track | null = null
  private _lastSortKey = ''
  /** Trailing debounce for the auto-queue replenish reaction (filter edits /
   *  scope changes), owned here and cleared by `destroy()`. */
  private _replenishTimer: ReturnType<typeof setTimeout> | null = null
  /** Subscription teardown handles collected from `_subscribeShared` and the
   *  native-only `loopMode` wiring, released by `destroy()`. */
  private _unsubscribers: Array<() => void> = []
  private _amOverride: typeof audioManager | null = null
  private _qmOverride: typeof queueManager | null = null
  private _stmOverride: typeof sleepTimerManager | null = null
  private _engineOverride: typeof engine | null = null

  /**
   * Injectable deps for the glue tests: transports + engine adapters default to
   * the module singletons, but tests pass fakes so the manager's bg wiring can
   * be exercised in Node without a DOM or Dexie. `_initWeb` still constructs
   * the real transports over whatever was injected.
   *
   * The engine deps are LAZY (see the getters below): reading a module
   * singleton during construction is an eval-time read that breaks if that
   * module imports this one back (F2b) — deferred to first use, the bindings
   * are always initialized. Only the override fields are captured here.
   */
  constructor(deps: {
    audioManager?: typeof audioManager
    engine?: typeof engine
    queueManager?: typeof queueManager
    sleepTimerManager?: typeof sleepTimerManager
    webTransport?: WebTransport | null
    bgTransport?: WebBgTransport | null
    nativeTransport?: NativeTransport | null
    isNative?: () => boolean
  } = {}) {
    this._amOverride = deps.audioManager ?? null
    this._engineOverride = deps.engine ?? null
    this._qmOverride = deps.queueManager ?? null
    this._stmOverride = deps.sleepTimerManager ?? null
    this._webTransport = deps.webTransport ?? null
    this._bgTransport = deps.bgTransport ?? null
    this._nativeTransport = deps.nativeTransport ?? null
    this._isNative = deps.isNative ?? null
  }

  private get _am(): typeof audioManager {
    return this._amOverride ?? audioManager
  }

  private get _qm(): typeof queueManager {
    return this._qmOverride ?? queueManager
  }

  private get _stm(): typeof sleepTimerManager {
    return this._stmOverride ?? sleepTimerManager
  }

  private get _engine(): typeof engine {
    return this._engineOverride ?? engine
  }

  /**
   * Coalesces queue-driven native refreshes. User queue mutations (add/remove/
   * reorder/clear via QueueView, "Add next", play history, etc.) go through the
   * `queue` store but don't run through the native-bound call sites; refreshing
   * on every store write would re-arm the native crossfade several times per
   * transition. The transport owns the microtask coalescing (same-task bursts
   * collapse into ONE `refreshQueue` call); the factory is evaluated at fire
   * time so it always carries the final snapshot.
   */
  private _scheduleNativeQueueSync(): void {
    if (!this.isNative() || !this._nativeTransport?.engaged || !this._initialized) return
    this._nativeTransport.scheduleSync(() => {
      const combined = this._qm.getCombinedQueue()
      const activeIndex = get(queue).activeIndex
      if (activeIndex < 0 || activeIndex >= combined.length) return null
      return { tracks: this._buildSnapshot(combined), activeIndex }
    })
  }

  private isNative(): boolean {
    return this._isNative !== null ? this._isNative() : Capacitor.isNativePlatform()
  }

  async init(): Promise<void> {
    if (this._initialized) return

    if (this.isNative()) {
      await this._initNative()
    } else {
      await this._initWeb()
    }

    scrobbleManager.init()
    scrobbleManager.enable()
    await this._stm.init()
    // Invert the sleep-timer → manager dependency: sleepTimer must not import
    // this module (that import is a module-eval cycle that resolves to
    // `undefined` in the production bundle). The web minutes-countdown expiry
    // pauses through this callback instead.
    this._stm.setExpireHandler(() => this.pause())
    this._unsubscribers.push(...this._subscribeShared())
    this._initialized = true
  }

  private async _initWeb(): Promise<void> {
    await this._am.init()

    const transport = new WebTransport(this._am)
    this._webTransport = transport
    transport.onTrackEnded = (event) => {
      if (event.kind === 'crossfade') {
        void this._handleCrossfadeEnd(event.targetId)
      } else {
        void this._onTrackEnded(event.fromError)
      }
    }
    transport.onRetry = (trackId) => {
      // Track-keyed validity: a stale retry (superseded by a manual load or a
      // sleep park) must never re-load a track that left the active slot.
      if (get(currentTrack)?.trackId !== trackId) return
      const t = this._qm.findTrack(trackId)
      if (t) void this._loadAndPlay(t)
    }
    transport.onPlaybackState = (state) => {
      // The engaged-pause filter: the bg swap pauses the fg element, whose
      // pause event would otherwise write 'paused' while bg audio is playing.
      if (this._bgTransport?.engaged && state === 'paused') return
      setPlaybackState(state)
    }
    await transport.init()

    const bg = new WebBgTransport(
      this._am,
      {
        facts: () => this._bgFacts(),
        // Resolved at use: the fg a/b element can flip on crossfade switches
        // before an engagement, so the swap must read the CURRENT active one.
        fgElement: () => this._am.activeElement,
      },
      {
        interval: (ms, fn) => {
          const id = setInterval(fn, ms)
          return () => clearInterval(id)
        },
      },
    )
    this._bgTransport = bg
    bg.onLoad = (target, decision) => this._handleBgLoad(target, decision)
    bg.onStop = (target) => {
      if (target === 'fg') this._stopPlayback()
    }
    bg.onParked = (trackId) => {
      this._stm.parkAtEnd(trackId)
      setPlaybackState('paused')
    }
    bg.onTick = (position) => {
      currentTime.set(position)
      this._refreshPositionState()
    }
    bg.init()

    this._am.onSpeedChange = (speed: number) => playbackSpeed.set(speed)
    this._am.onPitchChange = (pitch: number) => pitchOctaves.set(pitch)
    this._am.onTapeModeChange = (enabled: boolean) => tapeMode.set(enabled)
    this._am.onSnapToleranceChange = (tolerance: number) => snapTolerance.set(tolerance)

    // The persisted stores were already restored by initStores; push them to
    // the engine in the required order (snap tolerance before pitch).
    this._applyPlaybackParams()

    this._refreshPositionState = setupMediaSession(
      () => { this.play() },
      () => { this.pause() },
      () => this.next(),
      () => this.prev(),
      (t) => this.seek(t),
      (track) => {
        const config = getCachedConfig()
        if (!config) return undefined
        return getCoverUrl(track, config, 512) || undefined
      },
      {
        getPositionElement: () => this._bgTransport!.sessionElement,
        a: this._am.a,
        b: this._am.b,
      },
    ).refreshPositionState

    setupPreloader(() => transport.playbackElement, (trackId) => this._resolveUrl(trackId))
  }

  private async _initNative(): Promise<void> {
    const transport = this._nativeTransport ?? new NativeTransport(nativeEngine)
    this._nativeTransport = transport
    transport.onTrackChanged = (trackId) => { this._onNativeTrackChanged(trackId) }
    transport.onTrackEnded = (event) => {
      if (event.kind === 'natural') void this._onNativeTrackEnded(event.fromError)
    }
    transport.onRetry = (trackId) => { void this._onNativeRetry(trackId) }
    transport.onPlaybackState = (state) => setPlaybackState(state)
    transport.onTick = (position) => currentTime.set(position)
    await transport.init()

    // 1.5 — recover a track the engine kept playing across a webview reload.
    await this._reconcileNativeReload()

    const s = get(settings)
    // The persisted stores were already restored by initStores; push them to
    // the engine in the required order (snap tolerance before pitch).
    this._applyPlaybackParams()
    this._engine.setCrossfade(s.crossfadeDuration ?? 0)
    BackgroundAudio.setPreloadCount({ count: s.preloadTracks ?? 0 }).catch(() => {})
    this._engine.pushNativeEqFromStore()

    BackgroundAudio.setReplayGainMode({ mode: s.replayGainMode ?? 'off' }).catch(() => {})
    transport.setLoopMode(get(loopMode)).catch(() => {})

    this._unsubscribers.push(loopMode.subscribe((m) => {
      transport.setLoopMode(m).catch(() => {})
    }))
  }

  /**
   * Pushes the restored playback params to the engine, shared by web and native
   * (the facade delegates to the audioManager on web and the plugin on native).
   * The persisted stores were already restored by `initStores`, so this reads
   * `get(store)` — never a re-read of Dexie — and applies them.
   *
   * Order matters: snap tolerance BEFORE pitch, because `setPitchOctaves`
   * quantizes the raw value against the current tolerance — pitch-first would
   * re-snap a saved off-grid pitch against the 0.15 default.
   */
  private _applyPlaybackParams(): void {
    this._engine.setSnapTolerance(get(snapTolerance))
    this._engine.setPitchOctaves(get(pitchOctaves))
    this._engine.setSpeed(get(playbackSpeed))
    this._engine.setTapeMode(get(tapeMode))
    this._engine.setMasterVolume(get(masterGain))
  }

  private _subscribeShared(): Array<() => void> {
    const unsubs: Array<() => void> = []

    // Settings that still drive engine effects (crossfade / replay-gain). The
    // pitch/speed/volume params are `persisted` stores applied by
    // `_applyPlaybackParams`, so their persistence + engine echo no longer live
    // here. The `_initialized` guard skips the immediate fire for the
    // track-scoped replay-gain apply (no track is loaded yet at subscribe time).
    unsubs.push(settings.subscribe((s) => {
      this._engine.setCrossfade(s.crossfadeDuration ?? 0)
      if (this.isNative()) {
        BackgroundAudio.setPreloadCount({ count: s.preloadTracks ?? 0 }).catch(() => {})
        if (s.replayGainMode) {
          BackgroundAudio.setReplayGainMode({ mode: s.replayGainMode }).catch(() => {})
        }
      } else {
        const track = get(currentTrack)
        if (this._initialized && track && s.replayGainMode) {
          this._am.setReplayGainMode(s.replayGainMode)
          this._am.applyReplayGain(track.replayGain, track.albumReplayGain)
        }
      }
    }))

    // The bg element's playback rate is owned by the transport (applied at
    // swap/load), so this is the one store→engine edge left for speed.
    unsubs.push(playbackSpeed.subscribe((v) => {
      this._bgTransport?.setSpeed(v)
    }))

    this._qm.replenishAutoQueue()

    unsubs.push(library.subscribe(() => {
      if (this._initialized) {
        // Replenish (never rebuild) on library changes: the queued auto head —
        // including any armed crossfade target — stays in place while the fill
        // re-ranks by current metadata. A rebuild could drop an armed track,
        // and the crossfade-end handler would then rescue it back into the
        // user queue mid-play. The queue→native microtask sync covers the
        // native tail, so no explicit refresh here.
        this._qm.replenishAutoQueue()
      }
    }))

    // A completed metadata scan refreshed rating/loved — re-rank the auto
    // queue fill so it follows the Songs-view sort. Replenish (not rebuild)
    // keeps the currently queued head untouched, so nothing armed is dropped
    // and the user queue is never mutated by the crossfade rescue path.
    unsubs.push(metadataScanState.subscribe((st) => {
      if (!this._initialized) return
      if (st.status !== 'complete') return
      const f = get(libraryFilters)
      if (get(shuffleEnabled)) return
      if (f.sortBy !== 'rating' && f.sortBy !== 'loved') return
      this._qm.replenishAutoQueue()
    }))

    unsubs.push(shuffleEnabled.subscribe(() => {
      if (this._initialized) {
        this._qm.rebuildAutoQueue()
      }
    }))

    unsubs.push(autoQueueFilters.subscribe(() => {
      if (!this._initialized) return
      // Filter edits / scope changes re-rank the auto queue — trailing-
      // debounced so typing in the search box doesn't re-rank per keystroke.
      // The reaction layer owns the timer (cleared by destroy()).
      if (this._replenishTimer) clearTimeout(this._replenishTimer)
      this._replenishTimer = setTimeout(() => {
        this._replenishTimer = null
        this._qm.replenishAutoQueue()
      }, 250)
    }))

    // Rebuild the auto queue when the shared sort changes so it follows the
    // Songs-view ordering while shuffle is off. Only sortBy/sortAsc matter here
    // (the rank map in queueManager ignores the filter ranges), so skip no-op
    // subscription fires and opening/closing the filter panel.
    this._lastSortKey = `${get(libraryFilters).sortBy}|${get(libraryFilters).sortAsc}`
    unsubs.push(libraryFilters.subscribe((f) => {
      if (!this._initialized) return
      if (get(shuffleEnabled)) return
      const key = `${f.sortBy}|${String(f.sortAsc)}`
      if (key === this._lastSortKey) return
      this._lastSortKey = key
      this._qm.rebuildAutoQueue()
    }))

    // Keep the native engine's queue snapshot in step with ANY queue mutation
    // (user edits add/remove/reorder/clear, plus promotions/replenishments).
    // The transport's scheduleSync coalesces same-task bursts into one refresh.
    unsubs.push(queue.subscribe(() => {
      this._scheduleNativeQueueSync()
    }))

    return unsubs
  }

  private _resolveUrl(trackId: string): string {
    const config = getCachedConfig()
    if (!config) return ''
    const track = this._qm.findTrack(trackId)
    if (!track) return ''
    return buildStreamUrl(config, track.trackId.replace(/^navidrome-/, ''))
  }

  // MARK: - Native engine path

  /** Builds a full queue snapshot (current combined queue) for the native engine. */
  private _buildSnapshot(combined: string[]): NativeTrackSnapshot[] {
    const config = getCachedConfig()
    return combined.map((id, index) => {
      const track = this._qm.findTrack(id)
      const snapshot: NativeTrackSnapshot = {
        index,
        trackId: id,
        title: track?.title ?? id,
        artist: track?.artist ?? '',
        album: track?.album ?? '',
        duration: track?.duration ?? 0,
        url: config ? buildStreamUrl(config, id.replace(/^navidrome-/, '')) : '',
      }
      if (track) {
        if (config) snapshot.coverUrl = buildCoverArtUrl(config, resolveCoverArtId(track), 512)
        if (track.replayGain != null) snapshot.replayGain = track.replayGain
        if (track.albumReplayGain != null) snapshot.albumReplayGain = track.albumReplayGain
      }
      return snapshot
    })
  }

  private async _nativeLoadPlay(track: Track): Promise<void> {
    const combined = this._qm.getCombinedQueue()
    const activeIndex = get(queue).activeIndex
    if (activeIndex < 0 || activeIndex >= combined.length) return

    const snapshot = this._buildSnapshot(combined)
    setCurrentTrack(track)
    currentTime.set(0)

    const ok = await this._nativeTransport!.engage(snapshot, activeIndex, get(loopMode))
    // A superseded engage must not reflect its outcome: a newer load already
    // moved currentTrack, so this request's success/failure is stale.
    if (get(currentTrack)?.trackId !== track.trackId) return
    if (!ok) {
      setCurrentTrack(null)
      setPlaybackState('stopped')
      return
    }

    setPlaybackState('playing')
    // setQueue stopped the engine, which also cancelled any armed sleep timer
    // (native `stopPlayback` invalidates the Timer + end-of-track flag). Re-arm
    // the mirror so the sleep intent survives this snapshot (0.2).
    await this._stm.rearmAfterSnapshot()
    // Track is now playing — promote it from auto to user queue
    this._qm.promoteActiveTrack()
    this._qm.replenishAutoQueue()
  }

  /**
   * 1.5 — webview-reload reconciliation. After a reload the native engine
   * keeps playing while the JS stores reset and this transport instance is
   * fresh and disengaged. Recover the engine's current track by trackId
   * (NEVER by `state.index` — E7: the engine's index refers to the last-sent
   * snapshot, which queue mutations may have reindexed): adopt it back into
   * the queue/stores and mark the transport engaged WITHOUT re-sending the
   * snapshot (`setQueue` would restart the engine and kill the live playback).
   * An unknown trackId warns + stops (the UI cannot represent what it cannot
   * identify); a `getState` rejection skips gracefully (the plugin may not be
   * ready yet).
   */
  private async _reconcileNativeReload(): Promise<void> {
    const transport = this._nativeTransport
    if (!transport) return
    const state = await transport.getState().catch(() => null)
    if (!state) return
    const decision = reconcileReload(
      state,
      this._qm.getCombinedQueue(),
      (trackId) => Boolean(this._qm.findTrack(trackId)),
    )
    if (decision.kind === 'resync') {
      transport.adopt(decision.trackId)
      this._onNativeTrackChanged(decision.trackId)
      currentTime.set(decision.position)
      setPlaybackState('playing')
    } else if (decision.kind === 'stop') {
      console.warn('[native] reload reconcile: engine plays an unknown track, stopping:', state.trackId)
      // The engine is audibly playing here (state.playing was true) and the
      // bridge has no `stop` command — `_stopPlayback` only disengages JS
      // (poll + state), leaving the audio running under a "stopped" UI. Pause
      // first so the unrecoverable audio actually stops.
      await transport.pause().catch(() => {})
      this._stopPlayback()
    }
    // 'idle' — the engine has no audible track; nothing to resync.
  }

  private _onNativeTrackChanged(trackId: string): void {
    if (this._handlingNativeEnd) return
    const combined = this._qm.getCombinedQueue()
    let idx = combined.indexOf(trackId)
    const track = this._qm.findTrack(trackId)
    if (!track) {
      console.warn('[native] trackChanged for unknown track:', trackId)
      return
    }

    if (idx < 0) {
      // The playing track left the combined queue (dropped auto prefix, etc.) — re-adopt it.
      const prevIdx = get(queue).activeIndex
      const prevId = prevIdx >= 0 ? combined[prevIdx] : undefined
      queue.update((q) => {
        const userQueue = [...q.userQueue, trackId]
        const updated = {
          ...q,
          userQueue,
          activeIndex: userQueue.length - 1,
          recentTrackIds: prevId ? inscribeRecent(q.recentTrackIds, prevId, RECENT_LIMIT) : q.recentTrackIds,
        }
        saveQueue(updated)
        return updated
      })
      idx = get(queue).activeIndex
    } else {
      const prevIdx = get(queue).activeIndex
      const prevId = prevIdx >= 0 && prevIdx !== idx ? combined[prevIdx] : undefined
      if (prevId) {
        this._qm.advanceTo(idx, prevId)
      } else {
        setActiveQueueIndex(idx)
      }
    }

    setCurrentTrack(track)
    this._qm.promoteActiveTrack()
    this._qm.replenishAutoQueue()
  }

  /**
   * Native `ended` → the uniform A4 advance chain. The native engine owns the
   * clock and advances through the snapshot itself (emitting trackChanged per
   * row); `ended` fires only when it exhausts its snapshot. `parkArmed` is
   * always false — end-of-track sleep parks in the engine (E8), never here.
   * `fromError` (retry give-up) skips the park the same way the web chain does.
   */
  private async _onNativeTrackEnded(fromError = false): Promise<void> {
    if (this._handlingNativeEnd) return
    const decision = decideAdvance({
      fromError,
      parkArmed: false,
      loopMode: get(loopMode),
      hasNext: this._hasNextQueued(),
      hasUserQueue: get(queue).userQueue.length > 0,
    })

    this._handlingNativeEnd = true
    try {
      switch (decision) {
        case 'restart': {
          const track = get(currentTrack)
          // 2.7: loop-one restarts only tracks still in the combined queue — a
          // played-out removed row can't re-engage (its index is out of range)
          // and must stop instead of stranding in a stale 'playing' state.
          if (track && this._qm.getCombinedQueue().includes(track.trackId)) {
            await this._loadAndPlay(track)
          } else {
            this._stopPlayback()
          }
          return
        }
        case 'advance': {
          const nextTrack = this._qm.advanceQueue()
          if (nextTrack) await this._loadAndPlay(nextTrack)
          else this._stopPlayback()
          return
        }
        case 'wrap': {
          const q = get(queue)
          setActiveQueueIndex(0)
          const track = this._qm.findTrack(q.userQueue[0])
          if (track) await this._loadAndPlay(track)
          else this._stopPlayback()
          return
        }
        case 'stop':
          this._stopPlayback()
          return
        case 'park':
          return // unreachable natively — parkArmed is always false
      }
    } finally {
      this._handlingNativeEnd = false
    }
  }

  /**
   * A native retry timer fired for the last-engaged track. Track-keyed validity
   * (A5): a stale retry must never re-load a track that left the active slot
   * (e.g. the user skipped away during the backoff window). The transport owns
   * the timer + give-up; this just re-runs the load.
   */
  private async _onNativeRetry(trackId: string): Promise<void> {
    if (get(currentTrack)?.trackId !== trackId) return
    const t = this._qm.findTrack(trackId)
    if (t) await this._loadAndPlay(t)
  }

  // MARK: - Web engine path

  /**
   * Routes a resolved track to the platform-specific load path. The background
   * transport exists only on web; native playback must never inspect it before
   * dispatching to `_loadAndPlay`.
   */
  private async _loadTrack(track: Track): Promise<void> {
    if (!this.isNative() && this._bgTransport?.engaged) {
      await this._loadAndPlayInBg(track)
    } else {
      await this._loadAndPlay(track)
    }
  }

  private async _loadAndPlay(track: Track): Promise<void> {
    if (this.isNative()) {
      await this._nativeLoadPlay(track)
      return
    }

    this._webTransport!.cancelNext()

    const rawUrl = this._resolveUrl(track.trackId)
    if (!rawUrl) return
    const url = await resolveSrc(rawUrl)

    await this._am.ensureWebAudioReady()

    const eqState = get(currentEqState)
    if (eqState && eqState.filters.length > 0) {
      this._am.setPreampDb(eqState.preampDb)
      if (eqState.mode === 'graphic' && !eqState.isBuiltin) {
        this._am.applyGraphicEQ(eqState.filters, eqState.graphicEqCurves)
      } else {
        this._am.applyFiltersConfig(eqState.filters)
      }
    }

    if (get(eqBypassed)) {
      this._am.setEqBypass(true)
    }

    this._am.setMasterVolume(get(masterGain))

    const el = this._am.activeElement
    setCurrentTrack(track)
    currentTime.set(0)
    this._bgTransport!.syncSource(url)
    el.src = url

    // The end-of-track sleep timer fired during this transition: keep the
    // loaded track parked instead of letting the play() below resume it.
    if (this._stm.consumePendingStop()) {
      setPlaybackState('paused')
      this._qm.promoteActiveTrack()
      this._qm.replenishAutoQueue()
      return
    }

    const started = await this._webTransport!.playLoaded(track)
    if (!started) {
      setCurrentTrack(null)
      setPlaybackState('stopped')
      return
    }

    // Push the RG mode onto the engine on every web load (parity with the
    // pre-extraction path): the settings subscription's `_initialized` guard
    // skips its startup fire, so without this the engine keeps the 'off'
    // default until the user toggles the mode. playLoaded already applied this
    // track's gain fields; setReplayGainMode re-applies them under the mode.
    this._am.setReplayGainMode(get(settings).replayGainMode ?? 'off')

    // Track is now playing — promote it from auto to user queue
    this._qm.promoteActiveTrack()
    this._qm.replenishAutoQueue()

    setPlaybackState('playing')

    await this._setupNextTrack()
    if (get(loopMode) === 'one') {
      this._webTransport!.cancelNext()
    }
  }

  private async _setupNextTrack(): Promise<void> {
    // While an end-of-track sleep is armed, no next track is prepared and no
    // crossfade armed — the current track must end naturally and park.
    if (this._stm.isEndOfTrackArmed()) {
      this._webTransport!.cancelNext()
      return
    }
    const combined = this._qm.getCombinedQueue()
    const q = get(queue)
    const nextIdx = q.activeIndex + 1
    if (nextIdx >= 0 && nextIdx < combined.length) {
      const nextTrack = this._qm.findTrack(combined[nextIdx])
      const rawUrl = this._resolveUrl(combined[nextIdx])
      if (rawUrl) {
        const url = await resolveSrc(rawUrl)
        const rg = computeReplayGainFields(get(settings).replayGainMode ?? 'off', nextTrack)
        // The target duration rides along for the engine's nextTooShort gate
        // (a shorter-than-fade target would end mid-ramp — native parity).
        this._webTransport!.prepareNext(combined[nextIdx], url, rg, nextTrack?.duration ?? undefined)
      } else {
        // No URL for the next row — disarm (a stale arm could crossfade into
        // an old target at the transition point).
        this._webTransport!.prepareNext(null, null)
      }
    } else {
      this._webTransport!.prepareNext(null, null)
    }
  }

  /**
   * End-of-track sleep park guard (web parity with the native engine's
   * `handleSegmentCompletion` sleep check). When the sleep is armed, the advance
   * decision is consumed here instead of proceeding: the element is paused just
   * below its end (never ended) so any later play — in-app or the bg lock
   * screen — plays the last ~0.05s and the re-fired `ended` drives the natural
   * advance. Runs at the exact moment an advance is decided — no polling cadence
   * or race margin.
   */
  private _parkAtTrackEnd(): boolean {
    if (!this._stm.isEndOfTrackArmed()) return false
    this._stm.parkAtEnd(get(currentTrack)?.trackId ?? '')
    const el = this._am.activeElement
    const dur = get(currentTrack)?.duration ?? 0
    if (dur > 0 && el.currentTime >= dur - 0.5) {
      // Nudge below the end: play() on an ENDED element seeks to the start,
      // which would replay the whole track instead of advancing.
      el.currentTime = Math.min(el.currentTime, dur - 0.05)
    }
    el.pause()
    setPlaybackState('paused')
    return true
  }

  private _hasNextQueued(): boolean {
    const q = get(queue)
    const combined = this._qm.getCombinedQueue()
    // Playing-track-aware: after an active-row removal (2.4 option b) the row
    // AT activeIndex is the next playable one — `activeIndex + 1 < length`
    // would wrongly read as "queue ended" and stop/wrap.
    const target = advanceTargetIndex(q, combined, get(currentTrack)?.trackId)
    return target >= 0 && target < combined.length
  }

  /** Uniform end-of-queue stop (A4): the machine's stop{fg} and the fg advance
   *  chain map here. */
  private _stopPlayback(): void {
    setPlaybackState('stopped')
    setCurrentTrack(null)
    this._webTransport?.cancelNext()
    this._nativeTransport?.disengage()
    if (!this.isNative()) {
      this._am.activeElement.src = ''
    }
  }

  private async _onTrackEnded(
    fromError = false,
    opts: { skipPark?: boolean; loopMode?: LoopMode } = {},
  ): Promise<void> {
    if (this._handlingEnd) return
    // Park beats loop-one/loop-all by guard order; error-driven advances skip
    // the park (a dead stream can't play out its end — advancing is correct).
    // User-initiated removal (2.7) also skips it: the user's skip supersedes
    // the end-of-track sleep park, matching the native engine's divergence
    // stop, which cancels its own sleep timer.
    if (!fromError && !opts.skipPark && this._parkAtTrackEnd()) return

    // ONE decideAdvance for the whole chain (A4) — the queue facts are computed
    // BEFORE any mutation. park is unreachable here (handled above).
    const decision = decideAdvance({
      fromError,
      parkArmed: false,
      loopMode: opts.loopMode ?? get(loopMode),
      hasNext: this._hasNextQueued(),
      hasUserQueue: get(queue).userQueue.length > 0,
    })

    this._handlingEnd = true
    try {
      switch (decision) {
        case 'restart': {
          const track = get(currentTrack)
          // 2.7: a removed track is unloopable — a played-out row that left the
          // combined queue (active-last-row removal) must STOP, never loop.
          if (track && !this._qm.getCombinedQueue().includes(track.trackId)) {
            this._stopPlayback()
            return
          }
          this._webTransport!.cancelNext()
          const el = this._am.activeElement
          el.currentTime = 0
          try { await el.play() } catch { /* user may have paused */ }
          await this._setupNextTrack()
          if (get(loopMode) === 'one') {
            this._webTransport!.cancelNext()
          }
          return
        }
        case 'advance': {
          const nextTrack = this._qm.advanceQueue()
          if (nextTrack) {
            await this._loadAndPlay(nextTrack)
          } else {
            this._stopPlayback()
          }
          return
        }
        case 'wrap': {
          const q = get(queue)
          setActiveQueueIndex(0)
          const track = this._qm.findTrack(q.userQueue[0])
          if (track) {
            await this._loadAndPlay(track)
          } else {
            this._stopPlayback()
          }
          return
        }
        case 'stop':
          this._stopPlayback()
          return
        case 'park':
          return // unreachable — consumed by _parkAtTrackEnd above
      }
    } finally {
      this._handlingEnd = false
    }
  }

  private _bgFacts(): BgFacts {
    const q = get(queue)
    return {
      currentTrackId: get(currentTrack)?.trackId ?? null,
      parkArmed: this._stm.isEndOfTrackArmed(),
      loopMode: get(loopMode),
      hasNext: q.activeIndex >= 0 && this._hasNextQueued(),
      hasUserQueue: q.userQueue.length > 0,
      duration: get(currentTrack)?.duration ?? 0,
    }
  }

  /** Resolves the machine's load decision against the real queue. Mutations
   *  (advance/wrap) run HERE, after the machine decided — the events carried
   *  the pre-mutation facts. */
  private _resolveBgLoad(decision: LoadDecision): Track | null {
    switch (decision) {
      case 'restart':
        return get(currentTrack)
      case 'advance':
        return this._qm.advanceQueue()
      case 'wrap': {
        const q = get(queue)
        if (q.userQueue.length > 0) {
          setActiveQueueIndex(0)
          return this._qm.findTrack(q.userQueue[0]) ?? null
        }
        return null
      }
      case 'reload':
        // The caller (next/prev/select/play while engaged) resolved the track
        // and recorded it; an in-flight bg load records it before settling.
        return this._pendingBgTrack
    }
  }

  private async _handleBgLoad(target: 'fg' | 'bg', decision: LoadDecision): Promise<void> {
    const track = this._resolveBgLoad(decision)
    if (!track) {
      if (target === 'fg') {
        // The exit-ended chain resolved to nothing (queue shrank) — stop.
        this._stopPlayback()
      } else {
        // No track to load — idle in bg-paused (machine bgFailed analog).
        this._bgTransport!.abortBgLoad()
      }
      return
    }
    if (target === 'fg') {
      // The exit path awaits this: the crossfade re-arm runs after the load.
      await this._loadAndPlay(track)
      return
    }
    await this._bgLoad(track)
  }

  private async _bgLoad(track: Track): Promise<void> {
    // Record the in-flight target so an exit-race reload resolves it.
    this._pendingBgTrack = track
    const url = this._resolveUrl(track.trackId)
    if (!url) {
      this._bgTransport!.abortBgLoad()
      return
    }

    // Same guard as _loadAndPlay: an end-of-track sleep that fired mid-transition
    // must not be undone by the bg load's autoplay — and the machine must still
    // settle (abort idles it in bg-paused instead of stranding in handoff).
    if (this._stm.consumePendingStop()) {
      this._bgTransport!.abortBgLoad()
      setPlaybackState('paused')
      this._qm.promoteActiveTrack()
      return
    }

    // The stores reflect the resolved track BEFORE the settle: a settle dropped
    // by a racing lock-screen pause (token bumped) must not leave the UI on the
    // previous track while the element/queue already moved on. The pause's
    // 'paused' write lands after; a dropped settle by an exit re-route is
    // idempotent (the fg load re-sets everything).
    setCurrentTrack(track)
    currentTime.set(0)
    setPlaybackState('playing')

    const started = await this._bgTransport!.startBgLoad(url)
    if (!started) {
      // The load was superseded (newer load, park, or an exit that re-routed
      // the resolution to the fg path) — the machine already decided.
      return
    }

    this._qm.promoteActiveTrack()
    this._qm.replenishAutoQueue()
    await this._setupNextTrack()
    if (get(loopMode) === 'one') {
      this._webTransport!.cancelNext()
    }
  }

  private async _loadAndPlayInBg(track: Track): Promise<void> {
    const s = get(settings)
    if (s.replayGainMode && s.replayGainMode !== 'off') {
      this._am.applyReplayGain(track.replayGain, track.albumReplayGain)
    } else {
      this._am.applyReplayGain()
    }

    // The queue was already advanced by the caller (next/prev/select/play);
    // the machine's 'reload' decision loads this resolved track.
    this._pendingBgTrack = track
    this._bgTransport!.loadRequest()
  }

  private async _handleCrossfadeEnd(targetId: string | null): Promise<void> {
    if (this._handlingEnd) return
    if (this._parkAtTrackEnd()) return

    if (get(loopMode) === 'one') {
      const current = get(currentTrack)
      if (current) {
        await this._loadAndPlay(current)
      }
      return
    }

    this._handlingEnd = true
    try {
      const advanced = this._qm.advanceQueue()

      // Reconcile queue state with the track that is actually playing via
      // crossfade. targetId is null when the arm was cancelled mid-fade — no
      // reconcile (parity with the old `_crossfadeTrackId == null` skip).
      const q = get(queue)
      const result = reconcileCrossfadeTarget({
        targetId,
        combined: this._qm.getCombinedQueue(),
        activeIndex: q.activeIndex,
        userQueue: q.userQueue,
        advanced: advanced !== null,
        loopMode: get(loopMode),
      })
      if (result.kind === 'repoint') {
        setActiveQueueIndex(result.index)
      } else if (result.kind === 'rescue') {
        // Anchor-CHANGING write — deliberately NOT routed through
        // `_mutateQueue`'s id re-anchor (B1 scope boundary).
        queue.update((q) => {
          const updated = { ...q, userQueue: result.userQueue, activeIndex: 0 }
          saveQueue(updated)
          return updated
        })
      } else if (result.kind === 'wrap') {
        setActiveQueueIndex(result.index)
      }

      this._qm.promoteActiveTrack()
      const combined = this._qm.getCombinedQueue()
      const currentId = combined[get(queue).activeIndex]
      if (currentId) {
        const track = this._qm.findTrack(currentId)
        if (track) setCurrentTrack(track)
      }
      await this._setupNextTrack()
    } finally {
      this._handlingEnd = false
    }
  }

  async playTrackById(trackId: string): Promise<void> {
    this._stm.clearPendingStop()
    const track = this._qm.findTrack(trackId)
    if (!track) return

    const q = get(queue)
    const combined = this._qm.getCombinedQueue()
    const existingIdx = combined.indexOf(trackId)
    if (existingIdx >= 0) {
      await this.playTrackAt(existingIdx)
    } else {
      const prevId = q.activeIndex >= 0 ? combined[q.activeIndex] : undefined
      queue.update((q) => {
        const userQueue = [...q.userQueue, trackId]
        const newIndex = userQueue.length - 1
        const updated = { ...q, userQueue, activeIndex: newIndex }
        if (prevId) {
          updated.recentTrackIds = inscribeRecent(q.recentTrackIds, prevId, RECENT_LIMIT)
        }
        saveQueue(updated)
        return updated
      })
      await this._loadTrack(track)
    }
  }

  async playTrackAt(index: number): Promise<void> {
    this._stm.clearPendingStop()
    const combined = this._qm.getCombinedQueue()
    if (index < 0 || index >= combined.length) return

    // A forward/backward jump makes the current track leave the active slot —
    // mark it so it cools down like any other heard track (same-index replays
    // and plain resumes stay unmarked).
    const prevIdx = get(queue).activeIndex
    if (prevIdx >= 0 && prevIdx !== index) {
      const prevId = combined[prevIdx]
      if (prevId) {
        this._qm.advanceTo(index, prevId)
      } else {
        setActiveQueueIndex(index)
      }
    } else {
      setActiveQueueIndex(index)
    }
    const track = this._qm.findTrack(combined[index])
    if (track) {
      await this._loadTrack(track)
    }
  }

  async play(): Promise<void> {
    this._stm.clearPendingStop()
    if (this.isNative()) {
      if (get(currentTrack) && this._nativeTransport?.engaged) {
        await this._nativeTransport.play().catch(() => {})
        setPlaybackState('playing')
      } else {
        await this._playFirstInQueue()
      }
      return
    }

    // Lock-screen/app play while bg-engaged (also consumes a bg park — the
    // machine resumes the parked tail). Never touches the fg elements.
    const bg = this._bgTransport
    if (bg?.engaged) {
      bg.mediaPlay()
      setPlaybackState('playing')
      return
    }

    await this._am.ensureWebAudioReady()

    // A previous end-of-track park left the element paused just below its end
    // (never ended), so plain play() continues the tail and the re-fired
    // `ended` advances. clearPendingStop() above already cleared the park state.
    const el = this._am.activeElement
    if (el.src && el.src !== '') {
      try {
        await el.play()
        setPlaybackState('playing')
      } catch {
        /* play rejected — autoplay policy or no user gesture */
      }
    } else {
      await this._playFirstInQueue()
    }
  }

  pause(): void {
    if (this.isNative()) {
      this._nativeTransport?.pause().catch(() => {})
      setPlaybackState('paused')
      return
    }
    // The engaged-pause filter: while bg-engaged the AUDIBLE element is the bg
    // element (via the machine) — pausing the fg element would silently fail
    // to stop background audio, and a swap-settle fg pause must never write
    // 'paused' while bg audio is playing.
    const bg = this._bgTransport
    if (bg?.engaged) {
      bg.mediaPause()
      setPlaybackState('paused')
      return
    }
    this._am.activeElement.pause()
    setPlaybackState('paused')
  }

  togglePlayPause(): void {
    if (get(playbackState) === 'playing') {
      this.pause()
    } else {
      this.play()
    }
  }

  /**
   * The user removed a row from the queue. When that row was the PLAYING
   * track, playback skips to the next row NOW — the 2.4 decision applied
   * consistently on both platforms (2.7). Native is engine-driven: the 1.4
   * divergence branch of `refreshQueue` emits `ended` and the manager's A4
   * chain advances (even under loop-one the engage targets `activeIndex`,
   * which post-removal IS the next row). Web mirrors that here: the same A4
   * chain runs immediately, with the park skipped (the skip supersedes the
   * end-of-track sleep park, like the engine's divergence stop cancels its
   * timer) and loop-one disabled — a removed track is unloopable and must
   * never restart.
   *
   * No successor (the removed row was the active LAST one, or the queue
   * emptied): the native sync guard bails on the out-of-range index, so the
   * engine plays the track out and the natural-end chain stops/wraps. Mirror
   * that exactly instead of cutting the audio — parity, not a second policy.
   */
  async handleQueueRowRemoved(removedId: string): Promise<void> {
    if (this.isNative()) return // native: engine-driven skip (1.4)
    if (removedId !== get(currentTrack)?.trackId) return
    // No successor → let it play out (native parity, see above).
    if (!this._hasNextQueued()) return
    this._stm.clearPendingStop()
    await this._onTrackEnded(false, { skipPark: true, loopMode: 'none' })
  }

  async next(): Promise<void> {
    this._stm.clearPendingStop()
    const combined = this._qm.getCombinedQueue()
    const q = get(queue)
    const playingId = get(currentTrack)?.trackId
    const nextIndex = advanceTargetIndex(q, combined, playingId)
    if (nextIndex >= 0 && nextIndex < combined.length) {
      const currentId = q.activeIndex >= 0 && q.activeIndex < combined.length ? combined[q.activeIndex] : undefined
      // Never pre-mark the next row (it's about to play) — after an active-row
      // removal the leaving track is the removed PLAYING track instead.
      this._qm.advanceTo(nextIndex, (playingId ?? currentId) ?? undefined)

      const track = this._qm.findTrack(combined[nextIndex])
      if (track) {
        await this._loadTrack(track)
      }
    }
  }

  async prev(): Promise<void> {
    this._stm.clearPendingStop()
    const q = get(queue)

    // Native parity: restart the current track if more than a few seconds in.
    if (get(currentTime) > 3) {
      this.seek(0)
      return
    }

    const combined = this._qm.getCombinedQueue()
    const currentId = q.activeIndex >= 0 ? combined[q.activeIndex] : undefined
    const prevIndex = q.activeIndex - 1
    if (prevIndex >= 0) {
      this._qm.advanceTo(prevIndex, currentId ?? undefined)
      const track = this._qm.findTrack(combined[prevIndex])
      if (track) {
        await this._loadTrack(track)
      }
      return
    }

    if (get(loopMode) === 'all') {
      const lastIndex = combined.length - 1
      if (lastIndex >= 0) {
        this._qm.advanceTo(lastIndex, currentId ?? undefined)
        const track = this._qm.findTrack(combined[lastIndex])
        if (track) {
          await this._loadTrack(track)
        }
      }
      return
    }

    // First track, loop-mode off — restart from the beginning.
    this.seek(0)
  }

  seek(time: number): void {
    this._stm.clearPendingStop()
    if (this.isNative()) {
      const track = get(currentTrack)
      const metaDur = track?.duration || time
      const clamped = Math.min(time, metaDur)
      this._nativeTransport?.seek(clamped).catch(() => {})
      currentTime.set(clamped)
      return
    }
    const el = this._bgTransport!.sessionElement
    if (!el.src) {
      this.play()
      return
    }
    const track = get(currentTrack)
    const metaDur = (track?.duration) || time
    const clamped = Math.min(time, metaDur)
    // User scrubbing owns the transition state (A12): the engine latches the
    // crossfade suppression when the position lands in the window and collapses
    // any in-flight fade. BG-engaged seeks drive the bg element — no fg fade
    // machinery applies there.
    if (!this._bgTransport!.engaged) {
      this._am.markUserSeeked(clamped)
    }
    el.currentTime = clamped
    currentTime.set(clamped)
  }

  private async _playFirstInQueue(): Promise<void> {
    if (get(queue).activeIndex >= 0) {
      await this.playTrackAt(get(queue).activeIndex)
      return
    }
    const combined = this._qm.getCombinedQueue()
    if (combined.length > 0) {
      setActiveQueueIndex(0)
      await this.playTrackAt(0)
    }
  }

  destroy(): void {
    if (this._replenishTimer) {
      clearTimeout(this._replenishTimer)
      this._replenishTimer = null
    }
    for (const unsubscribe of this._unsubscribers) unsubscribe()
    this._unsubscribers = []
    if (this.isNative()) {
      void this._nativeTransport?.destroy()
      return
    }
    this._webTransport?.destroy()
    this._bgTransport?.teardown()
    teardownPreloader()
  }
}

export const playbackManager = new PlaybackManager()
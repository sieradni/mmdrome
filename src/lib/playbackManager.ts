import { get } from 'svelte/store'
import { Capacitor } from '@capacitor/core'
import { audioManager } from './audioManager'
import { engine } from './engineFacade'
import { libraryFilters } from './libraryFilters'
import { nativeEngine, BackgroundAudio, type NativeTrackSnapshot } from './nativePlugin'
import { queueManager } from './queueManager'
import { inscribeRecent, RECENT_LIMIT } from './recentWindow'
import { setup as setupPreloader, teardown as teardownPreloader, resolveSrc } from './preloader'
import { setupMediaSession } from './mediaSession'
import { getCoverUrl } from './coverArtCache'
import { getCachedConfig, buildStreamUrl, buildCoverArtUrl, resolveCoverArtId } from './navidromeApi'
import { scrobbleManager } from './scrobbleManager'
import { sleepTimerManager } from './sleepTimer'
import { WebTransport } from './playbackCore/webTransport'
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
  currentTime,
  loopMode,
  metadataScanState,
  setCurrentTrack,
  setPlaybackState,
  setActiveQueueIndex,
  autoQueueFilters,
} from '../stores/appState'
import { getSetting, setSetting, saveQueue } from './db'
import { currentEqState, eqBypassed } from './eq/eqStore'
import type { Track } from '../stores/appState'

class PlaybackManager {
  private _initialized = false
  private _handlingEnd = false
  private _handlingNativeEnd = false
  private _nativeRetryTrackId: string | null = null
  private _nativeRetryAttempt = 0
  private _nativeRetryTimer: ReturnType<typeof setTimeout> | null = null
  private _webTransport: WebTransport | null = null
  private _hasNativeEngaged = false
  private _lastSortKey = ''
  private _queueSyncScheduled = false

  /**
   * Coalesces queue-driven native refreshes. User queue mutations (add/remove/
   * reorder/clear via QueueView, "Add next", play history, etc.) go through the
   * `queue` store but don't run through the native-bound call sites; refreshing
   * on every store write would re-arm the native crossfade several times per
   * transition. Queueing a microtask collapses same-task mutations into one
   * `refreshQueue` call for the final snapshot.
   */
  private _scheduleNativeQueueSync(): void {
    if (!this.isNative() || !this._hasNativeEngaged || !this._initialized) return
    if (this._queueSyncScheduled) return
    this._queueSyncScheduled = true
    queueMicrotask(() => {
      this._queueSyncScheduled = false
      void this._refreshNativeQueue()
    })
  }

  private isNative(): boolean {
    return Capacitor.isNativePlatform()
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
    await sleepTimerManager.init()
    this._subscribeShared()
    this._initialized = true
  }

  private async _initWeb(): Promise<void> {
    await audioManager.init()

    const transport = new WebTransport(audioManager)
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
      const t = queueManager.findTrack(trackId)
      if (t) void this._loadAndPlay(t)
    }
    transport.onPlaybackState = (state) => setPlaybackState(state)
    await transport.init()

    audioManager.onBgTrackEnd = () => this._onBgTrackEnd()
    audioManager.onBgError = () => this._onBgTrackEnd()
    audioManager.onExitBackground = (state) => this._handleExitBackground(state)
    audioManager.onSpeedChange = (speed: number) => playbackSpeed.set(speed)
    audioManager.onPitchChange = (pitch: number) => pitchOctaves.set(pitch)

    const savedSpeed = await getSetting<number>('playbackSpeed')
    const savedPitch = await getSetting<number>('pitchOctaves')
    const savedGain = await getSetting<number>('masterGain')
    if (savedSpeed !== undefined && savedSpeed !== 1) audioManager.setSpeed(savedSpeed)
    if (savedPitch !== undefined && savedPitch !== 0) audioManager.setPitchOctaves(savedPitch)
    if (savedGain !== undefined && audioManager.preamp) {
      audioManager.setMasterVolume(savedGain)
    }

    setupMediaSession(
      () => { this.play() },
      () => { this.pause() },
      () => this.next(),
      () => this.prev(),
      (track) => {
        const config = getCachedConfig()
        if (!config) return undefined
        return getCoverUrl(track, config, 512) || undefined
      },
    )

    setupPreloader(() => transport.playbackElement, (trackId) => this._resolveUrl(trackId))

    settings.subscribe((s) => {
      audioManager.crossfadeDuration = s.crossfadeDuration ?? 0
      const track = get(currentTrack)
      if (this._initialized && track && s.replayGainMode) {
        audioManager.setReplayGainMode(s.replayGainMode)
        audioManager.applyReplayGain(track.replayGain, track.albumReplayGain)
      }
      if (s.masterGain !== undefined && audioManager.preamp) {
        audioManager.setMasterVolume(s.masterGain)
      }
    })
  }

  private async _initNative(): Promise<void> {
    await nativeEngine.init({
      onTrackChanged: (trackId) => { void this._onNativeTrackChanged(trackId) },
      onPlaybackStateChanged: (playing) => setPlaybackState(playing ? 'playing' : 'paused'),
      onQueueEnded: () => { void this._onNativeEnd() },
      onError: (message) => this._onNativeError(message),
    })

    const savedSpeed = await getSetting<number>('playbackSpeed')
    const savedPitch = await getSetting<number>('pitchOctaves')
    const savedGain = await getSetting<number>('masterGain')
    const s = get(settings)
    if (savedSpeed !== undefined) engine.setSpeed(savedSpeed)
    if (savedPitch !== undefined) engine.setPitchOctaves(savedPitch)
    if (savedGain !== undefined) engine.setMasterVolume(savedGain)
    engine.setTapeMode(s.tapeMode ?? false)
    engine.setCrossfade(s.crossfadeDuration ?? 0)
    engine.pushNativeEqFromStore()

    // Sync the stores so the shared subscriptions below (which fire immediately)
    // don't clobber the restored settings with their defaults.
    playbackSpeed.set(savedSpeed ?? 1)
    pitchOctaves.set(savedPitch ?? 0)

    BackgroundAudio.setReplayGainMode({ mode: s.replayGainMode ?? 'off' }).catch(() => {})
    BackgroundAudio.setLoopMode({ loopMode: get(loopMode) }).catch(() => {})

    loopMode.subscribe((m) => {
      BackgroundAudio.setLoopMode({ loopMode: m }).catch(() => {})
    })

    settings.subscribe((sv) => {
      engine.setCrossfade(sv.crossfadeDuration ?? 0)
      if (sv.replayGainMode) {
        BackgroundAudio.setReplayGainMode({ mode: sv.replayGainMode }).catch(() => {})
      }
      if (sv.masterGain !== undefined) engine.setMasterVolume(sv.masterGain)
      if (sv.tapeMode !== undefined) engine.setTapeMode(sv.tapeMode)
    })

    // The native engine owns the playback clock — poll position for the UI.
    nativeEngine.setPositionPolling(true, (state) => {
      currentTime.set(state.position)
    })
  }

  private _subscribeShared(): void {
    playbackSpeed.subscribe((v) => { setSetting('playbackSpeed', v); engine.setSpeed(v) })
    pitchOctaves.subscribe((v) => { setSetting('pitchOctaves', v); engine.setPitchOctaves(v) })

    queueManager.replenishAutoQueue()

    library.subscribe(() => {
      if (this._initialized) {
        // Replenish (never rebuild) on library changes: the queued auto head —
        // including any armed crossfade target — stays in place while the fill
        // re-ranks by current metadata. A rebuild could drop an armed track,
        // and the crossfade-end handler would then rescue it back into the
        // user queue mid-play. The queue→native microtask sync covers the
        // native tail, so no explicit refresh here.
        queueManager.replenishAutoQueue()
      }
    })

    // A completed metadata scan refreshed rating/loved — re-rank the auto
    // queue fill so it follows the Songs-view sort. Replenish (not rebuild)
    // keeps the currently queued head untouched, so nothing armed is dropped
    // and the user queue is never mutated by the crossfade rescue path.
    metadataScanState.subscribe((st) => {
      if (!this._initialized) return
      if (st.status !== 'complete') return
      const f = get(libraryFilters)
      if (get(shuffleEnabled)) return
      if (f.sortBy !== 'rating' && f.sortBy !== 'loved') return
      queueManager.replenishAutoQueue()
    })

    shuffleEnabled.subscribe(() => {
      if (this._initialized) {
        queueManager.rebuildAutoQueue()
        this._refreshNativeQueue()
      }
    })

    autoQueueFilters.subscribe(() => {
      if (this._initialized) {
        queueManager.replenishAutoQueue()
      }
    })

    // Rebuild the auto queue when the shared sort changes so it follows the
    // Songs-view ordering while shuffle is off. Only sortBy/sortAsc matter here
    // (the rank map in queueManager ignores the filter ranges), so skip no-op
    // subscription fires and opening/closing the filter panel.
    this._lastSortKey = `${get(libraryFilters).sortBy}|${get(libraryFilters).sortAsc}`
    libraryFilters.subscribe((f) => {
      if (!this._initialized) return
      if (get(shuffleEnabled)) return
      const key = `${f.sortBy}|${String(f.sortAsc)}`
      if (key === this._lastSortKey) return
      this._lastSortKey = key
      queueManager.rebuildAutoQueue()
      this._refreshNativeQueue()
    })

    // Keep the native engine's queue snapshot in step with ANY queue mutation
    // (user edits add/remove/reorder/clear, plus promotions/replenishments done
    // outside `_refreshNativeQueue`'s explicit call sites). The microtask
    // coalescing turns same-task bursts into a single refresh.
    this._queueSyncScheduled = false
    queue.subscribe(() => {
      this._scheduleNativeQueueSync()
    })
  }

  private _resolveUrl(trackId: string): string {
    const config = getCachedConfig()
    if (!config) return ''
    const track = queueManager.findTrack(trackId)
    if (!track) return ''
    return buildStreamUrl(config, track.trackId.replace(/^navidrome-/, ''))
  }

  // MARK: - Native engine path

  /** Builds a full queue snapshot (current combined queue) for the native engine. */
  private _buildSnapshot(combined: string[]): NativeTrackSnapshot[] {
    const config = getCachedConfig()
    return combined.map((id, index) => {
      const track = queueManager.findTrack(id)
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
    this._clearNativeRetry()

    const combined = queueManager.getCombinedQueue()
    const activeIndex = get(queue).activeIndex
    if (activeIndex < 0 || activeIndex >= combined.length) return

    const snapshot = this._buildSnapshot(combined)
    currentTime.set(0)
    setCurrentTrack(track)

    try {
      await BackgroundAudio.setQueue({ tracks: snapshot, activeIndex, loopMode: get(loopMode) })
      await BackgroundAudio.playTrackAt({ index: activeIndex, autoPlay: true })
    } catch (err) {
      console.error('[native] failed to start playback:', err)
      return
    }

    this._hasNativeEngaged = true
    setPlaybackState('playing')
    // setQueue stopped the engine, which also cancelled any armed sleep timer
    // (native `stopPlayback` invalidates the Timer + end-of-track flag). Re-arm
    // the mirror so the sleep intent survives this snapshot (0.2).
    await sleepTimerManager.rearmAfterSnapshot()
    // Track is now playing — promote it from auto to user queue
    queueManager.promoteActiveTrack()
    queueManager.replenishAutoQueue()
  }

  /**
   * Re-sends the current combined queue to the native engine without disturbing
   * the actively playing track, keeping its tail in sync with JS-side queue
   * mutations (promotions, auto-queue replenishment).
   */
  private async _refreshNativeQueue(): Promise<void> {
    if (!this.isNative() || !this._hasNativeEngaged) return
    const combined = queueManager.getCombinedQueue()
    const activeIndex = get(queue).activeIndex
    if (activeIndex < 0 || activeIndex >= combined.length) return
    const snapshot = this._buildSnapshot(combined)
    try {
      await BackgroundAudio.refreshQueue({ tracks: snapshot, activeIndex })
    } catch (err) {
      console.error('[native] refreshQueue failed:', err)
    }
  }

  private async _onNativeTrackChanged(trackId: string): Promise<void> {
    if (this._handlingNativeEnd) return
    const combined = queueManager.getCombinedQueue()
    let idx = combined.indexOf(trackId)
    const track = queueManager.findTrack(trackId)
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
        queueManager.advanceTo(idx, prevId)
      } else {
        setActiveQueueIndex(idx)
      }
    }

    setCurrentTrack(track)
    queueManager.promoteActiveTrack()
    queueManager.replenishAutoQueue()
    await this._refreshNativeQueue()
  }

  private async _onNativeEnd(): Promise<void> {
    if (this._handlingNativeEnd) return
    this._handlingNativeEnd = true
    try {
      queueManager.replenishAutoQueue()
      const combined = queueManager.getCombinedQueue()
      const q = get(queue)

      // Combined queue may have grown past the native list since the last refresh.
      const nextIdx = q.activeIndex + 1
      if (nextIdx >= 0 && nextIdx < combined.length) {
        const endedId = q.activeIndex >= 0 ? combined[q.activeIndex] : undefined
        queueManager.advanceTo(nextIdx, endedId ?? undefined)
        const track = queueManager.findTrack(combined[nextIdx])
        if (track) {
          await this._nativeLoadPlay(track)
          return
        }
      }

      if (get(loopMode) === 'all' && q.userQueue.length > 0) {
        const endedId = q.activeIndex >= 0 ? combined[q.activeIndex] : undefined
        queueManager.advanceTo(0, endedId ?? undefined)
        const track = queueManager.findTrack(q.userQueue[0])
        if (track) {
          await this._nativeLoadPlay(track)
          return
        }
      }

      setPlaybackState('stopped')
      setCurrentTrack(null)
      currentTime.set(0)
      this._hasNativeEngaged = false
    } finally {
      this._handlingNativeEnd = false
    }
  }

  private _onNativeError(message: string): void {
    console.error('[native] engine error:', message)
    const track = get(currentTrack)
    if (!track || this._handlingNativeEnd) return

    if (this._nativeRetryTrackId !== track.trackId) {
      this._clearNativeRetry()
    }
    if (this._nativeRetryAttempt >= 2) {
      this._clearNativeRetry()
      void this._onNativeEnd()
      return
    }
    this._nativeRetryTrackId = track.trackId
    this._nativeRetryAttempt++
    const delay = Math.pow(2, this._nativeRetryAttempt - 1) * 1000
    this._nativeRetryTimer = setTimeout(() => {
      this._nativeRetryTimer = null
      const t = get(currentTrack)
      if (t && t.trackId === this._nativeRetryTrackId) {
        void this._nativeLoadPlay(t)
      }
    }, delay)
  }

  private _clearNativeRetry(): void {
    this._nativeRetryTrackId = null
    this._nativeRetryAttempt = 0
    if (this._nativeRetryTimer !== null) {
      clearTimeout(this._nativeRetryTimer)
      this._nativeRetryTimer = null
    }
  }

  // MARK: - Web engine path

  private async _loadAndPlay(track: Track): Promise<void> {
    if (this.isNative()) {
      await this._nativeLoadPlay(track)
      return
    }

    this._webTransport!.cancelNext()

    const rawUrl = this._resolveUrl(track.trackId)
    if (!rawUrl) return
    const url = await resolveSrc(rawUrl)

    await audioManager.ensureWebAudioReady()

    const eqState = get(currentEqState)
    if (eqState && eqState.filters.length > 0) {
      audioManager.setPreampDb(eqState.preampDb)
      if (eqState.mode === 'graphic' && !eqState.isBuiltin) {
        audioManager.applyGraphicEQ(eqState.filters, eqState.graphicEqCurves)
      } else {
        audioManager.applyFiltersConfig(eqState.filters)
      }
    }

    if (get(eqBypassed)) {
      audioManager.setEqBypass(true)
    }

    const s = get(settings)
    if (s.masterGain !== undefined && audioManager.preamp) {
      audioManager.setMasterVolume(s.masterGain)
    }

    const el = audioManager.activeElement
    currentTime.set(0)
    setCurrentTrack(track)
    audioManager.syncBgSource(url)
    el.src = url

    // The end-of-track sleep timer fired during this transition: keep the
    // loaded track parked instead of letting the play() below resume it.
    if (sleepTimerManager.consumePendingStop()) {
      setPlaybackState('paused')
      queueManager.promoteActiveTrack()
      queueManager.replenishAutoQueue()
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
    audioManager.setReplayGainMode(get(settings).replayGainMode ?? 'off')

    // Track is now playing — promote it from auto to user queue
    queueManager.promoteActiveTrack()
    queueManager.replenishAutoQueue()

    setPlaybackState('playing')

    await this._setupNextTrack()
    if (get(loopMode) === 'one') {
      this._webTransport!.cancelNext()
    }
  }

  private async _setupNextTrack(): Promise<void> {
    // While an end-of-track sleep is armed, no next track is prepared and no
    // crossfade armed — the current track must end naturally and park.
    if (sleepTimerManager.isEndOfTrackArmed()) {
      this._webTransport!.cancelNext()
      return
    }
    const combined = queueManager.getCombinedQueue()
    const q = get(queue)
    const nextIdx = q.activeIndex + 1
    if (nextIdx >= 0 && nextIdx < combined.length) {
      const nextTrack = queueManager.findTrack(combined[nextIdx])
      const rawUrl = this._resolveUrl(combined[nextIdx])
      if (rawUrl) {
        const url = await resolveSrc(rawUrl)
        const rg = computeReplayGainFields(get(settings).replayGainMode ?? 'off', nextTrack)
        this._webTransport!.prepareNext(combined[nextIdx], url, rg)
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
    if (!sleepTimerManager.isEndOfTrackArmed()) return false
    sleepTimerManager.parkAtEnd(get(currentTrack)?.trackId ?? '')
    const el = audioManager.playbackElement
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

  private async _onTrackEnded(fromError = false): Promise<void> {
    if (this._handlingEnd) return
    // Park beats loop-one/loop-all by guard order; error-driven advances skip
    // the park (a dead stream can't play out its end — advancing is correct).
    if (!fromError && this._parkAtTrackEnd()) return

    if (get(loopMode) === 'one') {
      this._webTransport!.cancelNext()
      const el = audioManager.activeElement
      el.currentTime = 0
      try { await el.play() } catch { /* user may have paused */ }
      await this._setupNextTrack()
      if (get(loopMode) === 'one') {
        this._webTransport!.cancelNext()
      }
      return
    }

    this._handlingEnd = true
    try {
      const nextTrack = queueManager.advanceQueue()
      if (nextTrack) {
        await this._loadAndPlay(nextTrack)
      } else if (get(loopMode) === 'all') {
        const q = get(queue)
        if (q.userQueue.length > 0) {
          setActiveQueueIndex(0)
          const track = queueManager.findTrack(q.userQueue[0])
          if (track) await this._loadAndPlay(track)
        } else {
          setPlaybackState('stopped')
          setCurrentTrack(null)
          this._webTransport!.cancelNext()
          audioManager.activeElement.src = ''
        }
      } else {
        setPlaybackState('stopped')
        setCurrentTrack(null)
        this._webTransport!.cancelNext()
        audioManager.activeElement.src = ''
      }
    } finally {
      this._handlingEnd = false
    }
  }

  private async _loadAndPlayInBg(track: Track): Promise<void> {
    const url = this._resolveUrl(track.trackId)
    if (!url) return

    const s = get(settings)
    if (s.replayGainMode && s.replayGainMode !== 'off') {
      audioManager.applyReplayGain(track.replayGain, track.albumReplayGain)
    } else {
      audioManager.applyReplayGain()
    }

    // Same guard as _loadAndPlay: an end-of-track sleep that fired mid-transition
    // must not be undone by playBg's autoplay.
    if (sleepTimerManager.consumePendingStop()) {
      setPlaybackState('paused')
      queueManager.promoteActiveTrack()
      return
    }

    const started = await audioManager.playBg(url)

    if (!started && audioManager.isInBgMode) {
      return
    }

    if (!audioManager.isInBgMode) {
      await this._loadAndPlay(track)
      return
    }

    setCurrentTrack(track)
    currentTime.set(0)
    setPlaybackState('playing')
    queueManager.promoteActiveTrack()
    await this._setupNextTrack()
    if (get(loopMode) === 'one') {
      this._webTransport!.cancelNext()
    }
  }

  private async _onBgTrackEnd(): Promise<void> {
    if (this._handlingEnd) return
    if (!audioManager.isInBgMode) return
    if (this._parkAtTrackEnd()) return
    // The bg watchdog keeps polling t >= duration - 0.25 without a paused check,
    // so after a park (or a manual bg pause near the end) it would re-fire and
    // undo the pause by advancing. A paused near-end element must stay paused.
    if (audioManager.playbackElement.paused) return

    if (get(loopMode) === 'one') {
      const current = get(currentTrack)
      if (current) {
        await this._loadAndPlayInBg(current)
      }
      return
    }

    this._handlingEnd = true
    try {
      const nextTrack = queueManager.advanceQueue()
      if (nextTrack) {
        await this._loadAndPlayInBg(nextTrack)
      } else if (get(loopMode) === 'all') {
        const q = get(queue)
        if (q.userQueue.length > 0) {
          setActiveQueueIndex(0)
          const track = queueManager.findTrack(q.userQueue[0])
          if (track) await this._loadAndPlayInBg(track)
        }
      }
    } finally {
      this._handlingEnd = false
    }
  }

  private async _handleExitBackground(state: { ended: boolean; wasPlaying: boolean; currentTime: number }): Promise<void> {
    if (this._handlingEnd) return

    // Park here if the armed sleep never tripped while backgrounded. After any
    // park (now or in bg) the bg position isn't otherwise transferred (only the
    // wasPlaying branch carries it), so carry it to the foreground element and
    // stay paused — a later play() resumes the tail and advances. A fresh park
    // carries even when the bg element was playing; an already-parked pause
    // only carries while still paused (a resumed tail falls through to the
    // playing branch). The trackId gate keeps a stale park (consumed by a bg
    // lock-screen resume that already advanced) from landing on the wrong track.
    const parkedNow = this._parkAtTrackEnd()
    if (parkedNow) {
      const el = audioManager.activeElement
      const dur = get(currentTrack)?.duration ?? 0
      if (dur > 0) el.currentTime = Math.max(0, Math.min(state.currentTime, dur))
      return
    }
    if (sleepTimerManager.isParkedAtEnd()) {
      const t = get(currentTrack)
      if (!state.wasPlaying && sleepTimerManager.parkedTrackId() === t?.trackId) {
        const el = audioManager.activeElement
        const dur = t?.duration ?? 0
        if (dur > 0) el.currentTime = Math.max(0, Math.min(state.currentTime, dur))
        return
      }
    }

    this._handlingEnd = true
    try {
      if (state.ended) {
        const nextTrack = queueManager.advanceQueue()
        if (nextTrack) {
          await this._loadAndPlay(nextTrack)
        } else if (get(loopMode) === 'all') {
          const q = get(queue)
          if (q.userQueue.length > 0) {
            setActiveQueueIndex(0)
            const track = queueManager.findTrack(q.userQueue[0])
            if (track) await this._loadAndPlay(track)
          } else {
            setPlaybackState('stopped')
            setCurrentTrack(null)
            this._webTransport!.cancelNext()
            audioManager.activeElement.src = ''
          }
        } else {
          setPlaybackState('stopped')
          setCurrentTrack(null)
          this._webTransport!.cancelNext()
          audioManager.activeElement.src = ''
        }
      } else if (state.wasPlaying) {
        const el = audioManager.activeElement
        el.currentTime = state.currentTime
        await el.play().catch(() => {})
      }
    } finally {
      this._handlingEnd = false
    }
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
      const advanced = queueManager.advanceQueue()

      // Reconcile queue state with the track that is actually playing via
      // crossfade. targetId is null when the arm was cancelled mid-fade — no
      // reconcile (parity with the old `_crossfadeTrackId == null` skip).
      const q = get(queue)
      const result = reconcileCrossfadeTarget({
        targetId,
        combined: queueManager.getCombinedQueue(),
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

      queueManager.promoteActiveTrack()
      const combined = queueManager.getCombinedQueue()
      const currentId = combined[get(queue).activeIndex]
      if (currentId) {
        const track = queueManager.findTrack(currentId)
        if (track) setCurrentTrack(track)
      }
      await this._setupNextTrack()
    } finally {
      this._handlingEnd = false
    }
  }

  async playTrackById(trackId: string): Promise<void> {
    sleepTimerManager.clearPendingStop()
    const track = queueManager.findTrack(trackId)
    if (!track) return

    const q = get(queue)
    const combined = queueManager.getCombinedQueue()
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
      if (audioManager.isInBgMode) {
        await this._loadAndPlayInBg(track)
      } else {
        await this._loadAndPlay(track)
      }
    }
  }

  async playTrackAt(index: number): Promise<void> {
    sleepTimerManager.clearPendingStop()
    const combined = queueManager.getCombinedQueue()
    if (index < 0 || index >= combined.length) return

    // A forward/backward jump makes the current track leave the active slot —
    // mark it so it cools down like any other heard track (same-index replays
    // and plain resumes stay unmarked).
    const prevIdx = get(queue).activeIndex
    if (prevIdx >= 0 && prevIdx !== index) {
      const prevId = combined[prevIdx]
      if (prevId) {
        queueManager.advanceTo(index, prevId)
      } else {
        setActiveQueueIndex(index)
      }
    } else {
      setActiveQueueIndex(index)
    }
    const track = queueManager.findTrack(combined[index])
    if (track) {
      if (audioManager.isInBgMode) {
        await this._loadAndPlayInBg(track)
      } else {
        await this._loadAndPlay(track)
      }
    }
  }

  async play(): Promise<void> {
    sleepTimerManager.clearPendingStop()
    if (this.isNative()) {
      if (get(currentTrack) && this._hasNativeEngaged) {
        await BackgroundAudio.play().catch(() => {})
        setPlaybackState('playing')
      } else {
        await this._playFirstInQueue()
      }
      return
    }

    await audioManager.ensureWebAudioReady()

    // A previous end-of-track park left the element paused just below its end
    // (never ended), so plain play() continues the tail and the re-fired
    // `ended` advances. clearPendingStop() above already cleared the park state.
    const el = audioManager.activeElement
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
      BackgroundAudio.pause().catch(() => {})
      setPlaybackState('paused')
      return
    }
    // playbackElement respects iOS background mode (the audible element is
    // _bgEl there, not the foreground a/b element) — pausing activeElement
    // would silently fail to stop background audio.
    audioManager.playbackElement.pause()
    setPlaybackState('paused')
  }

  togglePlayPause(): void {
    if (get(playbackState) === 'playing') {
      this.pause()
    } else {
      this.play()
    }
  }

  async next(): Promise<void> {
    sleepTimerManager.clearPendingStop()
    const combined = queueManager.getCombinedQueue()
    const q = get(queue)
    const nextIndex = q.activeIndex + 1
    if (nextIndex >= 0 && nextIndex < combined.length) {
      const currentId = q.activeIndex >= 0 ? combined[q.activeIndex] : undefined
      queueManager.advanceTo(nextIndex, currentId ?? undefined)

      const track = queueManager.findTrack(combined[nextIndex])
      if (track) {
        if (audioManager.isInBgMode) {
          await this._loadAndPlayInBg(track)
        } else {
          await this._loadAndPlay(track)
        }
      }
    }
  }

  async prev(): Promise<void> {
    sleepTimerManager.clearPendingStop()
    const q = get(queue)

    // Native parity: restart the current track if more than a few seconds in.
    if (get(currentTime) > 3) {
      this.seek(0)
      return
    }

    const combined = queueManager.getCombinedQueue()
    const currentId = q.activeIndex >= 0 ? combined[q.activeIndex] : undefined
    const prevIndex = q.activeIndex - 1
    if (prevIndex >= 0) {
      queueManager.advanceTo(prevIndex, currentId ?? undefined)
      const track = queueManager.findTrack(combined[prevIndex])
      if (track) {
        if (audioManager.isInBgMode) {
          await this._loadAndPlayInBg(track)
        } else {
          await this._loadAndPlay(track)
        }
      }
      return
    }

    if (get(loopMode) === 'all') {
      const lastIndex = combined.length - 1
      if (lastIndex >= 0) {
        queueManager.advanceTo(lastIndex, currentId ?? undefined)
        const track = queueManager.findTrack(combined[lastIndex])
        if (track) {
          if (audioManager.isInBgMode) {
            await this._loadAndPlayInBg(track)
          } else {
            await this._loadAndPlay(track)
          }
        }
      }
      return
    }

    // First track, loop-mode off — restart from the beginning.
    this.seek(0)
  }

  seek(time: number): void {
    sleepTimerManager.clearPendingStop()
    if (this.isNative()) {
      const track = get(currentTrack)
      const metaDur = track?.duration || time
      const clamped = Math.min(time, metaDur)
      BackgroundAudio.seek({ position: clamped }).catch(() => {})
      currentTime.set(clamped)
      return
    }
    const el = audioManager.playbackElement
    if (!el.src) {
      this.play()
      return
    }
    const track = get(currentTrack)
    const metaDur = (track?.duration) || time
    const clamped = Math.min(time, metaDur)
    el.currentTime = clamped
    currentTime.set(clamped)
  }

  private async _playFirstInQueue(): Promise<void> {
    if (get(queue).activeIndex >= 0) {
      await this.playTrackAt(get(queue).activeIndex)
      return
    }
    const combined = queueManager.getCombinedQueue()
    if (combined.length > 0) {
      setActiveQueueIndex(0)
      await this.playTrackAt(0)
    }
  }

  destroy(): void {
    if (this.isNative()) {
      void nativeEngine.destroy()
      return
    }
    this._webTransport?.destroy()
    teardownPreloader()
  }
}

export const playbackManager = new PlaybackManager()
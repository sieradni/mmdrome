import { get } from 'svelte/store'
import { Capacitor } from '@capacitor/core'
import { audioManager } from './audioManager'
import { engine } from './engineFacade'
import { libraryFilters } from './libraryFilters'
import { nativeEngine, BackgroundAudio, type NativeTrackSnapshot } from './nativePlugin'
import { queueManager } from './queueManager'
import { setup as setupPreloader, teardown as teardownPreloader, resolveSrc } from './preloader'
import { setupMediaSession } from './mediaSession'
import { getCoverUrl } from './coverArtCache'
import { getCachedConfig, buildStreamUrl, buildCoverArtUrl, resolveCoverArtId } from './navidromeApi'
import { scrobbleManager } from './scrobbleManager'
import { sleepTimerManager } from './sleepTimer'
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
  setCurrentTrack,
  setPlaybackState,
  setActiveQueueIndex,
  pushHistory,
  autoQueueFilters,
} from '../stores/appState'
import { getSetting, setSetting, saveQueue } from './db'
import { currentEqState, eqBypassed } from './eq/eqStore'
import type { Track } from '../stores/appState'

class PlaybackManager {
  private _initialized = false
  private _handlingEnd = false
  private _retryTrackId: string | null = null
  private _retryAttempt = 0
  private _retryTimer: ReturnType<typeof setTimeout> | null = null
  private _crossfadeTrackId: string | null = null
  private _handlingNativeEnd = false
  private _nativeRetryTrackId: string | null = null
  private _nativeRetryAttempt = 0
  private _nativeRetryTimer: ReturnType<typeof setTimeout> | null = null
  private _hasNativeEngaged = false
  private _lastSortKey = ''

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

    audioManager.onTrackEnd = () => this._handleCrossfadeEnd()
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

    setupPreloader(() => audioManager.playbackElement, (trackId) => this._resolveUrl(trackId))

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

    this._attachPlaybackListeners()
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
        const f = get(libraryFilters)
        if (!get(shuffleEnabled) && (f.sortBy === 'rating' || f.sortBy === 'loved')) {
          // Rebuild so a refreshed library (ratings/loved read from disk) reorders
          // the queue to match the view; a plain replenish would keep the stale
          // order. Metadata-independent sorts just append new tracks like before.
          queueManager.rebuildAutoQueue()
          this._refreshNativeQueue()
        } else {
          queueManager.replenishAutoQueue()
        }
      }
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
  }

  private _attachPlaybackListeners(): void {
    const onPlay = () => setPlaybackState('playing')
    const onPause = (e: Event) => {
      const target = e.target as HTMLAudioElement
      if (target !== audioManager.activeElement) return
      if (target.ended) return
      setPlaybackState('paused')
    }
    const onEnded = (e: Event) => {
      const target = e.target as HTMLAudioElement
      if (target !== audioManager.activeElement) return
      this._clearRetry()
      this._onTrackEnded()
    }
    const onError = (e: Event) => {
      const target = e.target as HTMLAudioElement
      if (target !== audioManager.activeElement) return
      const track = get(currentTrack)
      if (!track) return
      this._handlePlaybackError(track)
    }
    const onWaiting = () => {
      setPlaybackState('buffering')
    }
    const onPlaying = () => {
      setPlaybackState('playing')
    }

    audioManager.a.addEventListener('play', onPlay)
    audioManager.a.addEventListener('pause', onPause)
    audioManager.a.addEventListener('ended', onEnded)
    audioManager.a.addEventListener('error', onError)
    audioManager.a.addEventListener('waiting', onWaiting)
    audioManager.a.addEventListener('playing', onPlaying)
    audioManager.b.addEventListener('play', onPlay)
    audioManager.b.addEventListener('pause', onPause)
    audioManager.b.addEventListener('ended', onEnded)
    audioManager.b.addEventListener('error', onError)
    audioManager.b.addEventListener('waiting', onWaiting)
    audioManager.b.addEventListener('playing', onPlaying)
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
    this._crossfadeTrackId = null

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
    if (!this.isNative()) return
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
      if (prevIdx >= 0) {
        const prevId = combined[prevIdx]
        if (prevId) pushHistory(prevId)
      }
      queue.update((q) => {
        const userQueue = [...q.userQueue, trackId]
        const updated = { ...q, userQueue, activeIndex: userQueue.length - 1 }
        saveQueue(updated)
        return updated
      })
      idx = get(queue).activeIndex
    } else {
      const prevIdx = get(queue).activeIndex
      if (prevIdx >= 0 && prevIdx !== idx) {
        const prevId = combined[prevIdx]
        if (prevId) pushHistory(prevId)
      }
      setActiveQueueIndex(idx)
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
        setActiveQueueIndex(nextIdx)
        const track = queueManager.findTrack(combined[nextIdx])
        if (track) {
          await this._nativeLoadPlay(track)
          return
        }
      }

      if (get(loopMode) === 'all' && q.userQueue.length > 0) {
        setActiveQueueIndex(0)
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

    this._crossfadeTrackId = null
    audioManager.cancelNextTrack()

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

    let playAttempt = 0
    let played = false
    while (playAttempt < 3 && !played) {
      try {
        await el.play()
        played = true
      } catch {
        playAttempt++
        if (playAttempt >= 3) {
          setCurrentTrack(null)
          setPlaybackState('stopped')
          return
        }
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, playAttempt) * 500))
      }
    }

    // Track is now playing — promote it from auto to user queue
    queueManager.promoteActiveTrack()
    queueManager.replenishAutoQueue()

    audioManager.reapplyEffects()
    setPlaybackState('playing')

    if (s.replayGainMode && s.replayGainMode !== 'off') {
      audioManager.setReplayGainMode(s.replayGainMode)
      audioManager.applyReplayGain(track.replayGain, track.albumReplayGain)
    } else {
      audioManager.applyReplayGain()
    }

    await this._setupNextTrack()
    if (get(loopMode) === 'one') {
      audioManager.cancelNextTrack()
    }
  }

  private async _setupNextTrack(): Promise<void> {
    const combined = queueManager.getCombinedQueue()
    const q = get(queue)
    const nextIdx = q.activeIndex + 1
    if (nextIdx >= 0 && nextIdx < combined.length) {
      this._crossfadeTrackId = combined[nextIdx]
      const rawUrl = this._resolveUrl(combined[nextIdx])
      if (rawUrl) {
        const url = await resolveSrc(rawUrl)
        let linearGain: number | undefined
        const nextTrack = queueManager.findTrack(combined[nextIdx])
        if (nextTrack) {
          const s = get(settings)
          if (s.replayGainMode === 'track' && nextTrack.replayGain != null) {
            linearGain = Math.pow(10, nextTrack.replayGain / 20)
          } else if (s.replayGainMode === 'album' && nextTrack.albumReplayGain != null) {
            linearGain = Math.pow(10, nextTrack.albumReplayGain / 20)
          }
        }
        audioManager.setNextTrack(url, linearGain)
      }
    } else {
      this._crossfadeTrackId = null
      audioManager.setNextTrack(null)
    }
  }

  private async _onTrackEnded(): Promise<void> {
    if (this._handlingEnd) return

    if (get(loopMode) === 'one') {
      audioManager.cancelNextTrack()
      const el = audioManager.activeElement
      el.currentTime = 0
      try { await el.play() } catch { /* user may have paused */ }
      await this._setupNextTrack()
      if (get(loopMode) === 'one') {
        audioManager.cancelNextTrack()
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
          audioManager.activeElement.src = ''
        }
      } else {
        setPlaybackState('stopped')
        setCurrentTrack(null)
        audioManager.activeElement.src = ''
      }
    } finally {
      this._handlingEnd = false
    }
  }

  private async _loadAndPlayInBg(track: Track): Promise<void> {
    this._crossfadeTrackId = null
    const url = this._resolveUrl(track.trackId)
    if (!url) return

    const s = get(settings)
    if (s.replayGainMode && s.replayGainMode !== 'off') {
      audioManager.applyReplayGain(track.replayGain, track.albumReplayGain)
    } else {
      audioManager.applyReplayGain()
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
      audioManager.cancelNextTrack()
    }
  }

  private async _onBgTrackEnd(): Promise<void> {
    if (this._handlingEnd) return
    if (!audioManager.isInBgMode) return

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
            audioManager.activeElement.src = ''
          }
        } else {
          setPlaybackState('stopped')
          setCurrentTrack(null)
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

  private _clearRetry(): void {
    this._retryTrackId = null
    this._retryAttempt = 0
    if (this._retryTimer !== null) {
      clearTimeout(this._retryTimer)
      this._retryTimer = null
    }
  }

  private _handlePlaybackError(track: Track): void {
    if (this._handlingEnd) return
    if (get(currentTrack)?.trackId !== track.trackId) return
    if (this._retryTrackId !== track.trackId) {
      this._clearRetry()
    }
    if (this._retryAttempt >= 3) {
      this._clearRetry()
      this._onTrackEnded()
      return
    }
    this._retryTrackId = track.trackId
    this._retryAttempt++
    const delay = Math.pow(2, this._retryAttempt - 1) * 1000
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null
      const t = get(currentTrack)
      if (t && t.trackId === this._retryTrackId) {
        this._loadAndPlay(t)
      }
    }, delay)
  }

  private async _handleCrossfadeEnd(): Promise<void> {
    if (this._handlingEnd) return

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

      // Reconcile queue state with the track that is actually playing via crossfade
      if (this._crossfadeTrackId) {
        const q = get(queue)
        const combined = queueManager.getCombinedQueue()
        const playingIdx = combined.indexOf(this._crossfadeTrackId)

        if (playingIdx >= 0) {
          // Track still in queue — ensure activeIndex points to it
          if (q.activeIndex !== playingIdx) {
            setActiveQueueIndex(playingIdx)
          }
        } else {
          // Track was removed from queue mid-crossfade — re-insert it
          queue.update((q) => {
            const userQueue = [this._crossfadeTrackId!, ...q.userQueue]
            const updated = { ...q, userQueue, activeIndex: 0 }
            saveQueue(updated)
            return updated
          })
        }

        // Loop-all: if advanced exhausted the queue, wrap to start
        if (!advanced && get(loopMode) === 'all') {
          const q2 = get(queue)
          if (q2.userQueue.length > 0) {
            const wrapIdx = queueManager.getCombinedQueue().indexOf(q2.userQueue[0])
            setActiveQueueIndex(wrapIdx >= 0 ? wrapIdx : 0)
          }
        }

        this._crossfadeTrackId = null
      }

      queueManager.promoteActiveTrack()
      const combined = queueManager.getCombinedQueue()
      const q = get(queue)
      const currentId = combined[q.activeIndex]
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
    const track = queueManager.findTrack(trackId)
    if (!track) return

    const q = get(queue)
    const combined = queueManager.getCombinedQueue()
    const existingIdx = combined.indexOf(trackId)
    if (existingIdx >= 0) {
      await this.playTrackAt(existingIdx)
    } else {
      queue.update((q) => {
        const userQueue = [...q.userQueue, trackId]
        const newIndex = userQueue.length - 1
        const updated = { ...q, userQueue, activeIndex: newIndex }
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
    const combined = queueManager.getCombinedQueue()
    if (index < 0 || index >= combined.length) return

    setActiveQueueIndex(index)
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
    audioManager.activeElement.pause()
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
    const combined = queueManager.getCombinedQueue()
    const q = get(queue)
    const nextIndex = q.activeIndex + 1
    if (nextIndex >= 0 && nextIndex < combined.length) {
      const currentId = combined[q.activeIndex]
      if (currentId && q.activeIndex >= 0) pushHistory(currentId)

      setActiveQueueIndex(nextIndex)
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
    const q = get(queue)
    const prevIndex = q.activeIndex - 1
    if (prevIndex >= 0) {
      setActiveQueueIndex(prevIndex)
      const combined = queueManager.getCombinedQueue()
      const track = queueManager.findTrack(combined[prevIndex])
      if (track) {
        if (audioManager.isInBgMode) {
          await this._loadAndPlayInBg(track)
        } else {
          await this._loadAndPlay(track)
        }
      }
    }
  }

  seek(time: number): void {
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
    this._crossfadeTrackId = null
    this._clearRetry()
    teardownPreloader()
    audioManager.cancelNextTrack()
    audioManager.onTrackEnd = null
  }
}

export const playbackManager = new PlaybackManager()
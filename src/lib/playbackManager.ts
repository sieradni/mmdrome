import { get } from 'svelte/store'
import { audioManager } from './audioManager'
import { setup as setupPreloader, teardown as teardownPreloader, resolveSrc } from './preloader'
import { setupMediaSession } from './mediaSession'
import { getCoverUrl } from './coverArtCache'
import { getCachedConfig, buildStreamUrl } from './navidromeApi'
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
  setCurrentTrack,
  setPlaybackState,
  setActiveQueueIndex,
  pushHistory,
  autoQueueFilters,
  metadataCache,
  updateSetting,
} from '../stores/appState'
import { saveQueue, getSetting, setSetting } from './db'
import { currentEqState } from './eq/eqStore'
import type { Track, AutoQueueFilters } from '../stores/appState'
import type { LocalMetadataStore } from './db'

class PlaybackManager {
  private _initialized = false
  private _handlingEnd = false

  async init(): Promise<void> {
    if (this._initialized) return

    await audioManager.init()

    audioManager.onTrackEnd = () => this._handleCrossfadeEnd()
    audioManager.onBgTrackEnd = () => this._onBgTrackEnd()
    audioManager.onSpeedChange = (speed: number) => playbackSpeed.set(speed)
    audioManager.onPitchChange = (pitch: number) => pitchOctaves.set(pitch)

    // Restore persisted speed/pitch/volume
    const savedSpeed = await getSetting<number>('playbackSpeed')
    const savedPitch = await getSetting<number>('pitchOctaves')
    const savedGain = await getSetting<number>('masterGain')
    if (savedSpeed !== undefined && savedSpeed !== 1) audioManager.setSpeed(savedSpeed)
    if (savedPitch !== undefined && savedPitch !== 0) audioManager.setPitchOctaves(savedPitch)
    if (savedGain !== undefined && audioManager.preamp) {
      audioManager.setMasterVolume(savedGain)
    }

    // Persist speed/pitch on change
    playbackSpeed.subscribe((v) => { setSetting('playbackSpeed', v) })
    pitchOctaves.subscribe((v) => { setSetting('pitchOctaves', v) })

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

    this._replenishAutoQueue()

    library.subscribe(() => {
      if (this._initialized) {
        this._replenishAutoQueue()
      }
    })

    shuffleEnabled.subscribe(() => {
      if (this._initialized) {
        this.reshuffleAutoQueue()
      }
    })

    autoQueueFilters.subscribe(() => {
      if (this._initialized) {
        this._replenishAutoQueue()
      }
    })

    this._initialized = true
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
      if ((e.target as HTMLAudioElement) !== audioManager.activeElement) return
      this._onTrackEnded()
    }

    audioManager.a.addEventListener('play', onPlay)
    audioManager.a.addEventListener('pause', onPause)
    audioManager.a.addEventListener('ended', onEnded)
    audioManager.b.addEventListener('play', onPlay)
    audioManager.b.addEventListener('pause', onPause)
    audioManager.b.addEventListener('ended', onEnded)
  }

  private _resolveUrl(trackId: string): string {
    const config = getCachedConfig()
    if (!config) return ''
    const track = this._findTrack(trackId)
    if (!track) return ''
    return buildStreamUrl(config, track.trackId.replace(/^navidrome-/, ''))
  }

  private _findTrack(trackId: string): Track | undefined {
    return get(library).find((t) => t.trackId === trackId)
  }

  private _getCombinedQueue(): string[] {
    const q = get(queue)
    return [...q.userQueue, ...q.autoQueue]
  }

  private async _loadAndPlay(track: Track): Promise<void> {
    this._promoteActiveTrack()
    audioManager.cancelNextTrack()

    const rawUrl = this._resolveUrl(track.trackId)
    if (!rawUrl) return
    const url = await resolveSrc(rawUrl)

    await audioManager.ensureWebAudioReady()

    // Apply stored EQ state to audio engine
    const eqState = get(currentEqState)
    if (eqState && eqState.filters.length > 0) {
      audioManager.setPreampDb(eqState.preampDb)
      audioManager.applyFiltersConfig(eqState.filters)
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
    try {
      await el.play()
    } catch {
      setCurrentTrack(null)
      setPlaybackState('stopped')
      return
    }
    audioManager.reapplyEffects()
    setPlaybackState('playing')

    if (s.replayGainMode && s.replayGainMode !== 'off') {
      audioManager.setReplayGainMode(s.replayGainMode)
      audioManager.applyReplayGain(track.replayGain, track.albumReplayGain)
    } else {
      audioManager.applyReplayGain()
    }

    await this._setupNextTrack()
  }

  private async _setupNextTrack(): Promise<void> {
    const q = get(queue)
    const combined = [...q.userQueue, ...q.autoQueue]
    const nextIdx = q.activeIndex + 1
    if (nextIdx >= 0 && nextIdx < combined.length) {
      const rawUrl = this._resolveUrl(combined[nextIdx])
      if (rawUrl) {
        const url = await resolveSrc(rawUrl)
        let linearGain: number | undefined
        const nextTrack = this._findTrack(combined[nextIdx])
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
      audioManager.setNextTrack(null)
    }
  }

  private _promoteActiveTrack(): void {
    queue.update((q) => {
      const combined = [...q.userQueue, ...q.autoQueue]
      const activeId = combined[q.activeIndex]
      if (!activeId) return q

      const autoIdx = q.autoQueue.indexOf(activeId)
      if (autoIdx < 0) return q

      const newUserQueue = [...q.userQueue, activeId]
      const newAutoQueue = q.autoQueue.slice(autoIdx + 1)
      const newActiveIndex = newUserQueue.length - 1

      const updated = { ...q, userQueue: newUserQueue, autoQueue: newAutoQueue, activeIndex: newActiveIndex }
      saveQueue(updated)
      return updated
    })
  }

  replenishAutoQueue(): void {
    this._replenishAutoQueue()
  }

  private _autoQueueCursor = 0

  private _matchesAutoQueueFilters(track: Track, filters: AutoQueueFilters, meta: Map<string, LocalMetadataStore>): boolean {
    const m = meta.get(track.trackId)
    const r = m?.rating ?? 0
    if (r < filters.minRating || r > filters.maxRating) return false
    if (filters.lovedOnly && !m?.loved) return false

    const fromYear = filters.fromYear !== null && filters.fromYear !== undefined && filters.fromYear !== '' ? Number(filters.fromYear) : null
    const toYear = filters.toYear !== null && filters.toYear !== undefined && filters.toYear !== '' ? Number(filters.toYear) : null
    const minLength = filters.minLength !== null && filters.minLength !== undefined && filters.minLength !== '' ? Number(filters.minLength) : null
    const maxLength = filters.maxLength !== null && filters.maxLength !== undefined && filters.maxLength !== '' ? Number(filters.maxLength) : null

    if (fromYear !== null && (track.year ?? 0) < fromYear) return false
    if (toYear !== null && (track.year ?? 9999) > toYear) return false
    if (minLength !== null && track.duration < minLength) return false
    if (maxLength !== null && track.duration > maxLength) return false

    if (filters.searchQuery) {
      const sq = filters.searchQuery.trim().toLowerCase()
      if (sq) {
        const matches =
          track.title.toLowerCase().includes(sq) ||
          track.artist.toLowerCase().includes(sq) ||
          track.album.toLowerCase().includes(sq) ||
          (track.composer ?? '').toLowerCase().includes(sq)
        if (!matches) return false
      }
    }

    return true
  }

  private _replenishAutoQueue(): void {
    const MAX_AUTO_QUEUE = 50
    const MAX_HISTORY = 100
    const q = get(queue)
    const lib = get(library)
    const libById = new Map(lib.map((t) => [t.trackId, t]))
    const shuffle = get(shuffleEnabled)
    const filters = get(autoQueueFilters)
    const meta = get(metadataCache)

    // Prune existing auto queue tracks that no longer match filters
    const keptAuto = q.autoQueue.filter((id) => {
      const t = libById.get(id)
      return t && this._matchesAutoQueueFilters(t, filters, meta)
    })

    const used = new Set([...q.userQueue, ...keptAuto])
    const recent = new Set(q.historyQueue)

    let eligible = lib.filter((t) => {
      if (used.has(t.trackId) || recent.has(t.trackId)) return false
      return this._matchesAutoQueueFilters(t, filters, meta)
    })

    const needed = Math.max(0, MAX_AUTO_QUEUE - keptAuto.length)

    // Fallback: if we still need tracks, allow matching tracks from history (oldest first)
    if (eligible.length < needed) {
      const historyMatches = lib.filter((t) => {
        if (used.has(t.trackId)) return false
        if (!this._matchesAutoQueueFilters(t, filters, meta)) return false
        return recent.has(t.trackId)
      })

      const historyOrder = q.historyQueue
      historyMatches.sort((a, b) => {
        const idxA = historyOrder.indexOf(a.trackId)
        const idxB = historyOrder.indexOf(b.trackId)
        return idxA - idxB
      })

      eligible = [...eligible, ...historyMatches]
    }

    if ((needed === 0 || eligible.length === 0) && keptAuto.length === q.autoQueue.length) return

    if (eligible.length > 0) {
      if (shuffle) {
        for (let i = eligible.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [eligible[i], eligible[j]] = [eligible[j], eligible[i]]
        }
      } else {
        const startIdx = this._autoQueueCursor % (lib.length || 1)
        const libPos = new Map(lib.map((t, i) => [t.trackId, i]))
        eligible.sort((a, b) => (libPos.get(a.trackId) ?? 0) - (libPos.get(b.trackId) ?? 0))
        const splitAt = eligible.findIndex(t => (libPos.get(t.trackId) ?? 0) >= startIdx)
        if (splitAt > 0) {
          eligible = [...eligible.slice(splitAt), ...eligible.slice(0, splitAt)]
        }
      }
    }

    const fill = eligible.slice(0, needed)
    if (!shuffle && fill.length > 0) {
      const libPos = new Map(lib.map((t, i) => [t.trackId, i]))
      const lastPickedPos = libPos.get(fill[fill.length - 1].trackId) ?? 0
      this._autoQueueCursor = (lastPickedPos + 1) % (lib.length || 1)
    }

    const fillIds = fill.map((t) => t.trackId)
    queue.update((q) => {
      const updated = { ...q, autoQueue: [...keptAuto, ...fillIds] }
      saveQueue(updated)
      return updated
    })
  }

  reshuffleAutoQueue(): void {
    this._rebuildAutoQueue()
  }

  private _rebuildAutoQueue(): void {
    const MAX_AUTO_QUEUE = 50
    const q = get(queue)
    const lib = get(library)
    const shuffle = get(shuffleEnabled)
    const filters = get(autoQueueFilters)
    const meta = get(metadataCache)

    // Exclude user queue tracks, include history tracks
    const userQueueSet = new Set(q.userQueue)
    let candidates = lib.filter((t) => {
      if (userQueueSet.has(t.trackId)) return false
      return this._matchesAutoQueueFilters(t, filters, meta)
    })

    if (candidates.length > 0) {
      if (shuffle) {
        for (let i = candidates.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
        }
      } else {
        const startIdx = this._autoQueueCursor % (lib.length || 1)
        const libPos = new Map(lib.map((t, i) => [t.trackId, i]))
        candidates.sort((a, b) => (libPos.get(a.trackId) ?? 0) - (libPos.get(b.trackId) ?? 0))
        const splitAt = candidates.findIndex(t => (libPos.get(t.trackId) ?? 0) >= startIdx)
        if (splitAt > 0) {
          candidates = [...candidates.slice(splitAt), ...candidates.slice(0, splitAt)]
        }
      }
    }

    const fill = candidates.slice(0, MAX_AUTO_QUEUE)
    if (!shuffle && fill.length > 0) {
      const libPos = new Map(lib.map((t, i) => [t.trackId, i]))
      const lastPickedPos = libPos.get(fill[fill.length - 1].trackId) ?? 0
      this._autoQueueCursor = (lastPickedPos + 1) % (lib.length || 1)
    }

    const fillIds = fill.map((t) => t.trackId)
    queue.update((q) => {
      const updated = { ...q, autoQueue: fillIds }
      saveQueue(updated)
      return updated
    })
  }

  private _advanceQueue(): Track | null {
    const q = get(queue)
    const combinedTrackIds = [...q.userQueue, ...q.autoQueue]
    const currentId = combinedTrackIds[q.activeIndex]
    if (currentId) {
      pushHistory(currentId)
    }

    const hist = get(queue).historyQueue
    if (hist.length > 100) {
      queue.update((q) => {
        const updated = { ...q, historyQueue: q.historyQueue.slice(0, 100) }
        saveQueue(updated)
        return updated
      })
    }

    const nextIndex = q.activeIndex + 1
    if (nextIndex >= 0 && nextIndex < combinedTrackIds.length) {
      setActiveQueueIndex(nextIndex)
      this._replenishAutoQueue()
      return this._findTrack(combinedTrackIds[nextIndex]) ?? null
    }

    this._replenishAutoQueue()
    const q2 = get(queue)
    const updatedCombined = [...q2.userQueue, ...q2.autoQueue]
    if (nextIndex >= 0 && nextIndex < updatedCombined.length) {
      setActiveQueueIndex(nextIndex)
      return this._findTrack(updatedCombined[nextIndex]) ?? null
    }

    setPlaybackState('stopped')
    setCurrentTrack(null)
    audioManager.activeElement.src = ''
    return null
  }

  private async _onTrackEnded(): Promise<void> {
    if (this._handlingEnd) return
    this._handlingEnd = true
    try {
      const nextTrack = this._advanceQueue()
      if (nextTrack) {
        await this._loadAndPlay(nextTrack)
      }
    } finally {
      this._handlingEnd = false
    }
  }

  /** Track ended while in iOS background mode — advance queue and play next on _bgEl */
  private async _onBgTrackEnd(): Promise<void> {
    if (this._handlingEnd) return
    if (!audioManager.isInBgMode) return /* _exitBackground already handled it */
    this._handlingEnd = true
    try {
      const nextTrack = this._advanceQueue()
      if (nextTrack) {
        const url = this._resolveUrl(nextTrack.trackId)
        if (url) {
          // Apply ReplayGain for the new track (takes effect on return to foreground)
          const s = get(settings)
          if (s.replayGainMode && s.replayGainMode !== 'off') {
            audioManager.applyReplayGain(nextTrack.replayGain, nextTrack.albumReplayGain)
          } else {
            audioManager.applyReplayGain()
          }
          await audioManager.playBg(url)
          if (!audioManager.isInBgMode) {
            /* User returned to foreground during playBg — transfer to active element */
            const el = audioManager.activeElement
            el.src = url
            el.currentTime = 0
            await el.play().catch(() => {})
          } else {
            audioManager.activeElement.src = url
          }
          setCurrentTrack(nextTrack)
          currentTime.set(0)
          setPlaybackState('playing')
          await this._setupNextTrack()
        }
      }
    } finally {
      this._handlingEnd = false
    }
  }

  private async _handleCrossfadeEnd(): Promise<void> {
    if (this._handlingEnd) return
    this._handlingEnd = true
    try {
      this._advanceQueue()
      this._promoteActiveTrack()
      const q = get(queue)
      const combined = [...q.userQueue, ...q.autoQueue]
      const currentId = combined[q.activeIndex]
      if (currentId) {
        const track = this._findTrack(currentId)
        if (track) setCurrentTrack(track)
      }
      await this._setupNextTrack()
    } finally {
      this._handlingEnd = false
    }
  }

  async playTrackById(trackId: string): Promise<void> {
    const track = this._findTrack(trackId)
    if (!track) return

    const q = get(queue)
    const combined = [...q.userQueue, ...q.autoQueue]
    const existingIdx = combined.indexOf(trackId)
    if (existingIdx >= 0) {
      await this.playTrackAt(existingIdx)
    } else {
      queue.update((q) => {
        const userQueue = [...q.userQueue, trackId]
        const newIndex = userQueue.length - 1
        saveQueue({ ...q, userQueue, activeIndex: newIndex })
        return { ...q, userQueue, activeIndex: newIndex }
      })
      await this._loadAndPlay(track)
    }
  }

  async playTrackAt(index: number): Promise<void> {
    const combined = this._getCombinedQueue()
    if (index < 0 || index >= combined.length) return

    setActiveQueueIndex(index)
    const track = this._findTrack(combined[index])
    if (track) await this._loadAndPlay(track)
  }

  async play(): Promise<void> {
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
    const q = get(queue)
    const combined = [...q.userQueue, ...q.autoQueue]
    const nextIndex = q.activeIndex + 1
    if (nextIndex >= 0 && nextIndex < combined.length) {
      const currentId = combined[q.activeIndex]
      if (currentId && q.activeIndex >= 0) pushHistory(currentId)

      setActiveQueueIndex(nextIndex)
      const track = this._findTrack(combined[nextIndex])
      if (track) await this._loadAndPlay(track)
    }
  }

  async prev(): Promise<void> {
    const q = get(queue)
    const prevIndex = q.activeIndex - 1
    if (prevIndex >= 0) {
      setActiveQueueIndex(prevIndex)
      const combined = [...q.userQueue, ...q.autoQueue]
      const track = this._findTrack(combined[prevIndex])
      if (track) await this._loadAndPlay(track)
    }
  }

  seek(time: number): void {
    const el = audioManager.activeElement
    if (!get(currentTrack) || !el.src) {
      this.play()
      return
    }
    el.currentTime = time
  }

  private async _playFirstInQueue(): Promise<void> {
    if (get(queue).activeIndex >= 0) {
      await this.playTrackAt(get(queue).activeIndex)
      return
    }
    const combined = this._getCombinedQueue()
    if (combined.length > 0) {
      setActiveQueueIndex(0)
      await this.playTrackAt(0)
    }
  }

  destroy(): void {
    teardownPreloader()
    audioManager.cancelNextTrack()
    audioManager.onTrackEnd = null
  }
}

export const playbackManager = new PlaybackManager()

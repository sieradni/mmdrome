import { get } from 'svelte/store'
import { audioManager } from './audioManager'
import { queueManager } from './queueManager'
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

  async init(): Promise<void> {
    if (this._initialized) return

    await audioManager.init()

    audioManager.onTrackEnd = () => this._handleCrossfadeEnd()
    audioManager.onBgTrackEnd = () => this._onBgTrackEnd()
    audioManager.onBgError = () => this._onBgTrackEnd()
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

    queueManager.replenishAutoQueue()

    library.subscribe(() => {
      if (this._initialized) {
        queueManager.replenishAutoQueue()
      }
    })

    shuffleEnabled.subscribe(() => {
      if (this._initialized) {
        queueManager.rebuildAutoQueue()
      }
    })

    autoQueueFilters.subscribe(() => {
      if (this._initialized) {
        queueManager.replenishAutoQueue()
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
      const target = e.target as HTMLAudioElement
      if (target !== audioManager.activeElement) return
      const track = get(currentTrack)
      const metaDur = track?.duration ?? 0
      const elemDur = target.duration || 0
      if (metaDur > 0 && elemDur > 0 && elemDur < metaDur - 5) {
        console.warn(`[PlaybackManager] Track ended early (element: ${elemDur}s, metadata: ${metaDur}s). Not advancing.`)
        return
      }
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

  private async _loadAndPlay(track: Track): Promise<void> {
    audioManager.cancelNextTrack()

    const rawUrl = this._resolveUrl(track.trackId)
    if (!rawUrl) return
    const url = await resolveSrc(rawUrl)

    await audioManager.ensureWebAudioReady()

    const eqState = get(currentEqState)
    if (eqState && eqState.filters.length > 0) {
      audioManager.setPreampDb(eqState.preampDb)
      audioManager.applyFiltersConfig(eqState.filters)
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
    const combined = queueManager.getCombinedQueue()
    const q = get(queue)
    const nextIdx = q.activeIndex + 1
    if (nextIdx >= 0 && nextIdx < combined.length) {
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
      audioManager.setNextTrack(null)
    }
  }

  private async _onTrackEnded(): Promise<void> {
    if (this._handlingEnd) return
    this._handlingEnd = true
    try {
      const nextTrack = queueManager.advanceQueue()
      if (nextTrack) {
        await this._loadAndPlay(nextTrack)
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
    const url = this._resolveUrl(track.trackId)
    if (!url) return

    const s = get(settings)
    if (s.replayGainMode && s.replayGainMode !== 'off') {
      audioManager.applyReplayGain(track.replayGain, track.albumReplayGain)
    } else {
      audioManager.applyReplayGain()
    }

    const el = audioManager.activeElement
    el.src = url
    el.currentTime = 0
    audioManager.setBgTrackEndHandled()

    const started = await audioManager.playBg(url)

    if (!started && audioManager.isInBgMode) {
      return
    }

    setCurrentTrack(track)
    currentTime.set(0)
    setPlaybackState('playing')
    queueManager.promoteActiveTrack()
    await this._setupNextTrack()
  }

  private async _onBgTrackEnd(): Promise<void> {
    if (this._handlingEnd) return
    if (!audioManager.isInBgMode) return
    this._handlingEnd = true
    try {
      const nextTrack = queueManager.advanceQueue()
      queueManager.promoteActiveTrack()
      if (nextTrack) {
        await this._loadAndPlayInBg(nextTrack)
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
    this._handlingEnd = true
    try {
      queueManager.advanceQueue()
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
    const el = audioManager.activeElement
    if (!get(currentTrack) || !el.src) {
      this.play()
      return
    }
    const clamped = Math.min(time, el.duration || time)
    el.currentTime = clamped
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
    this._clearRetry()
    teardownPreloader()
    audioManager.cancelNextTrack()
    audioManager.onTrackEnd = null
  }
}

export const playbackManager = new PlaybackManager()
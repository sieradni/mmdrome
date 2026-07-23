import { get } from 'svelte/store'
import { audioManager } from './audioManager'
import { setup as setupPreloader, teardown as teardownPreloader } from './preloader'
import { setupMediaSession } from './mediaSession'
import { getCoverUrl } from './coverArtCache'
import { getCachedConfig, buildStreamUrl } from './navidromeApi'
import {
  currentTrack,
  playbackState,
  queue,
  library,
  setCurrentTrack,
  setPlaybackState,
  setActiveQueueIndex,
  pushHistory,
} from '../stores/appState'
import { saveQueue } from './db'
import type { Track } from '../stores/appState'

class PlaybackManager {
  private _initialized = false
  private _handlingEnd = false

  async init(): Promise<void> {
    if (this._initialized) return

    await audioManager.init()

    audioManager.onTrackEnd = () => this._handleCrossfadeEnd()

    setupMediaSession(
      () => this.next(),
      () => this.prev(),
      (track) => getCoverUrl(track, 512) || undefined,
    )

    setupPreloader(audioManager.activeElement, (trackId) => this._resolveUrl(trackId))

    this._attachPlaybackListeners()

    this._initialized = true
  }

  private _attachPlaybackListeners(): void {
    const onPlay = () => setPlaybackState('playing')
    const onPause = () => {
      const el = audioManager.activeElement
      if (el.ended) return
      setPlaybackState('paused')
    }
    const onEnded = () => this._onTrackEnded()

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
    return buildStreamUrl(config, track.filePath)
  }

  private _findTrack(trackId: string): Track | undefined {
    return get(library).find((t) => t.trackId === trackId)
  }

  private _getCombinedQueue(): string[] {
    const q = get(queue)
    return [...q.userQueue, ...q.autoQueue]
  }

  private async _loadAndPlay(track: Track): Promise<void> {
    const url = this._resolveUrl(track.trackId)
    if (!url) return

    await audioManager.ensureWebAudioReady()

    const el = audioManager.activeElement
    el.src = url
    await el.play()
    setCurrentTrack(track)
    setPlaybackState('playing')

    this._setupNextTrack()
  }

  private _setupNextTrack(): void {
    const q = get(queue)
    const combined = [...q.userQueue, ...q.autoQueue]
    const nextIdx = q.activeIndex + 1
    if (nextIdx >= 0 && nextIdx < combined.length) {
      const url = this._resolveUrl(combined[nextIdx])
      if (url) {
        audioManager.setNextTrack(url)
      }
    } else {
      audioManager.setNextTrack(null)
    }
  }

  private _replenishAutoQueue(): void {
    const MAX_AUTO_QUEUE = 50
    const MAX_HISTORY = 100
    const q = get(queue)
    const lib = get(library)

    const allTrackIds = lib.map((t) => t.trackId)
    const used = new Set([...q.userQueue, ...q.autoQueue])
    const recent = new Set(q.historyQueue)

    const eligible = allTrackIds.filter((id) => !used.has(id) && !recent.has(id))
    const needed = Math.max(0, MAX_AUTO_QUEUE - q.autoQueue.length)
    if (needed === 0 || eligible.length === 0) return

    const fill = eligible.slice(0, needed)
    queue.update((q) => {
      const updated = { ...q, autoQueue: [...q.autoQueue, ...fill] }
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
    setPlaybackState('stopped')
    setCurrentTrack(null)
    audioManager.activeElement.src = ''
    return null
  }

  private _onTrackEnded(): void {
    if (this._handlingEnd) return
    this._handlingEnd = true
    try {
      const nextTrack = this._advanceQueue()
      if (nextTrack) {
        this._loadAndPlay(nextTrack)
      }
    } finally {
      this._handlingEnd = false
    }
  }

  private _handleCrossfadeEnd(): void {
    if (this._handlingEnd) return
    this._handlingEnd = true
    try {
      this._advanceQueue()
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

    const q = get(queue)
    const userQueueLen = q.userQueue.length
    if (index >= userQueueLen) {
      const autoIdx = index - userQueueLen
      const toConvert = q.autoQueue.slice(0, autoIdx)
      const convertIds = new Set(toConvert)
      queue.update((q) => ({
        ...q,
        userQueue: [...q.userQueue, ...toConvert],
        autoQueue: q.autoQueue.filter((id) => !convertIds.has(id)),
      }))
    }

    setActiveQueueIndex(index)
    const track = this._findTrack(combined[index])
    if (track) await this._loadAndPlay(track)
  }

  async play(): Promise<void> {
    await audioManager.ensureWebAudioReady()

    const el = audioManager.activeElement
    if (el.src && el.src !== '') {
      await el.play()
      setPlaybackState('playing')
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
    audioManager.activeElement.currentTime = time
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
    audioManager.onTrackEnd = null
  }
}

export const playbackManager = new PlaybackManager()

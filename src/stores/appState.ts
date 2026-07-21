import { writable, get } from 'svelte/store'
import type { LocalMetadataStore, PlayQueueState } from '$lib/db'
import { getSetting, setSetting, getQueue, saveQueue, getAllMetadata, upsertMetadata } from '$lib/db'

export type PlaybackState = 'playing' | 'paused' | 'stopped'

export interface Track {
  trackId: string
  title: string
  artist: string
  album: string
  year?: number
  duration: number
  filePath: string
  fileType: "mp3" | "flac" | "m4a" | "ogg" | "opus"
  composer?: string
  bitrate?: number
  size?: number
  createdAt?: number
  modifiedAt?: number
}

export interface TrackWithMeta extends Track {
  rating: number
  loved: boolean
}

export interface QueueState {
  userQueue: string[]
  autoQueue: string[]
  historyQueue: string[]
  activeIndex: number
}

export interface SettingsMap {
  preloadTracks?: number
  crossfadeDuration?: number
  masterGain?: number
  activeEqProfile?: string
  savedEqProfiles?: object
  webdavUrl?: string
  webdavUser?: string
  webdavToken?: string
  navidromeUrl?: string
  navidromeToken?: string
  tapeMode?: boolean
  snapTolerance?: number
}

export const currentTrack = writable<Track | null>(null)
export const playbackState = writable<PlaybackState>('stopped')
export const queue = writable<QueueState>({ userQueue: [], autoQueue: [], historyQueue: [], activeIndex: -1 })
export const settings = writable<SettingsMap>({})
export const metadataCache = writable<Map<string, LocalMetadataStore>>(new Map())
export const library = writable<Track[]>([])

export function setLibrary(tracks: Track[]): void {
  library.set(tracks)
}

let initialized = false

export async function initStores(): Promise<void> {
  if (initialized) return

  const [q, allMeta] = await Promise.all([
    getQueue(),
    getAllMetadata(),
    loadSettings(),
  ])

  if (q) {
    queue.set({ userQueue: q.userQueue, autoQueue: q.autoQueue, historyQueue: q.historyQueue, activeIndex: q.activeIndex })
  }

  const map = new Map<string, LocalMetadataStore>()
  for (const m of allMeta) {
    map.set(m.trackId, m)
  }
  metadataCache.set(map)

  initialized = true
}

async function loadSettings(): Promise<void> {
  const keys: (keyof SettingsMap)[] = ['preloadTracks', 'crossfadeDuration', 'masterGain', 'activeEqProfile', 'savedEqProfiles', 'webdavUrl', 'webdavUser', 'webdavToken', 'navidromeUrl', 'navidromeToken', 'tapeMode', 'snapTolerance']
  const entries = await Promise.all(keys.map(async (key) => {
    const value = await getSetting(key)
    return [key, value] as [typeof key, unknown]
  }))
  const s: SettingsMap = {}
  for (const [key, value] of entries) {
    if (value !== undefined) s[key] = value as any
  }
  settings.set(s)
}

export function setCurrentTrack(track: Track | null): void {
  currentTrack.set(track)
}

export function setPlaybackState(state: PlaybackState): void {
  playbackState.set(state)
}

export function addToUserQueue(trackId: string): void {
  queue.update((q) => {
    const userQueue = [...q.userQueue, trackId]
    saveQueue({ ...q, userQueue })
    return { ...q, userQueue }
  })
}

export function removeFromUserQueue(index: number): void {
  queue.update((q) => {
    const userQueue = q.userQueue.filter((_, i) => i !== index)
    const activeIndex = q.activeIndex >= index ? Math.max(0, q.activeIndex - 1) : q.activeIndex
    saveQueue({ ...q, userQueue, activeIndex })
    return { ...q, userQueue, activeIndex }
  })
}

export function setActiveQueueIndex(index: number): void {
  queue.update((q) => {
    saveQueue({ ...q, activeIndex: index })
    return { ...q, activeIndex: index }
  })
}

export function pushHistory(trackId: string): void {
  queue.update((q) => {
    const historyQueue = [...q.historyQueue, trackId]
    saveQueue({ ...q, historyQueue })
    return { ...q, historyQueue }
  })
}

export function updateSetting<K extends keyof SettingsMap>(key: K, value: SettingsMap[K]): void {
  settings.update((s) => {
    setSetting(key, value as string | number | boolean | object)
    return { ...s, [key]: value }
  })
}

export function updateMetadata(meta: LocalMetadataStore): void {
  metadataCache.update((map) => {
    map.set(meta.trackId, meta)
    return map
  })
  upsertMetadata(meta)
}

export function removeMetadata(trackId: string): void {
  metadataCache.update((map) => {
    map.delete(trackId)
    return map
  })
}

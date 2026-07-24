import { writable, get } from 'svelte/store'
import type { LocalMetadataStore, PlayQueueState } from '$lib/db'
import { getSetting, setSetting, getQueue, saveQueue, getAllMetadata, upsertMetadata, bulkUpsertMetadata } from '$lib/db'

export type PlaybackState = 'playing' | 'paused' | 'stopped'

export interface Track {
  trackId: string
  title: string
  artist: string
  album: string
  albumId?: string
  year?: number
  duration: number
  filePath: string
  fileType: "mp3" | "flac" | "m4a" | "ogg" | "opus"
  composer?: string
  bitrate?: number
  size?: number
  createdAt?: number
  modifiedAt?: number
  navidromePath?: string
  replayGain?: number
  albumReplayGain?: number
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

export interface MetadataScanState {
  status: 'idle' | 'scanning' | 'complete' | 'error'
  progress: { scanned: number; total: number; failed: number }
  error?: string
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
  navidromeUser?: string
  navidromePassword?: string
  tapeMode?: boolean
  snapTolerance?: number
  replayGainMode?: 'off' | 'track' | 'album'
}

export const currentTrack = writable<Track | null>(null)
export const playbackState = writable<PlaybackState>('stopped')
export const queue = writable<QueueState>({ userQueue: [], autoQueue: [], historyQueue: [], activeIndex: -1 })
export const settings = writable<SettingsMap>({})
export const metadataCache = writable<Map<string, LocalMetadataStore>>(new Map())
export const library = writable<Track[]>([])
export const webdavConnection = writable<{ connected: boolean; error?: string; checking: boolean }>({ connected: false, checking: false })
export const navidromeConnection = writable<{ connected: boolean; error?: string; checking: boolean; serverVersion?: string }>({ connected: false, checking: false })
export const navidromeLoadStatus = writable<{ loading: boolean; loaded: number; failed: number; error?: string }>({ loading: false, loaded: 0, failed: 0 })
export const shuffleEnabled = writable<boolean>(false)
export const currentTime = writable<number>(0)
export const playbackSpeed = writable<number>(1)
export const metadataScanState = writable<MetadataScanState>({ status: 'idle', progress: { scanned: 0, total: 0, failed: 0 } })

export interface AutoQueueFilters {
  minRating: number
  maxRating: number
  lovedOnly: boolean
  fromYear: number | ''
  toYear: number | ''
  minLength: number | ''
  maxLength: number | ''
  searchQuery?: string
}

export const autoQueueFilters = writable<AutoQueueFilters>({
  minRating: 0,
  maxRating: 100,
  lovedOnly: false,
  fromYear: '',
  toYear: '',
  minLength: '',
  maxLength: '',
  searchQuery: '',
})

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

  // Load and persist shuffle state
  const savedShuffle = await getSetting<boolean>('shuffleEnabled')
  if (savedShuffle !== undefined) {
    shuffleEnabled.set(savedShuffle)
  }
  shuffleEnabled.subscribe((v) => { setSetting('shuffleEnabled', v) })

  initialized = true
}

async function loadSettings(): Promise<void> {
  const keys: (keyof SettingsMap)[] = ['preloadTracks', 'crossfadeDuration', 'masterGain', 'activeEqProfile', 'savedEqProfiles', 'webdavUrl', 'webdavUser', 'webdavToken', 'navidromeUrl', 'navidromeUser', 'navidromePassword', 'tapeMode', 'snapTolerance', 'replayGainMode']
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

export function playNext(trackId: string): void {
  queue.update((q) => {
    const insertAt = q.activeIndex >= 0 ? q.activeIndex + 1 : q.userQueue.length
    const userQueue = [...q.userQueue.slice(0, insertAt), trackId, ...q.userQueue.slice(insertAt)]
    const adjustedIndex = q.activeIndex >= insertAt ? q.activeIndex + 1 : q.activeIndex
    saveQueue({ ...q, userQueue, activeIndex: adjustedIndex })
    return { ...q, userQueue, activeIndex: adjustedIndex }
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
    const next = new Map(map)
    next.set(meta.trackId, meta)
    return next
  })
  upsertMetadata(meta)
}

export function removeMetadata(trackId: string): void {
  metadataCache.update((map) => {
    const next = new Map(map)
    next.delete(trackId)
    return next
  })
}

export function toggleShuffle(): void {
  shuffleEnabled.update((v) => !v)
}

export function clearQueue(): void {
  queue.update((q) => {
    const combined = [...q.userQueue, ...q.autoQueue];
    const currentId = q.activeIndex >= 0 && q.activeIndex < combined.length ? combined[q.activeIndex] : null;
    const userQueue = currentId ? [currentId] : [];
    const updated = { ...q, userQueue, autoQueue: [], activeIndex: currentId ? 0 : -1 };
    saveQueue(updated);
    return updated;
  });
}

export function initMetadataForTracks(tracks: Track[]): void {
  const cache = get(metadataCache)
  const toInit: LocalMetadataStore[] = []
  for (const t of tracks) {
    if (!cache.has(t.trackId)) {
      toInit.push({
        trackId: t.trackId,
        rating: 0,
        loved: false,
        filePath: t.filePath,
        fileType: t.fileType,
        syncStatus: 'synced',
        lastModifiedLocally: Date.now(),
      })
    }
  }
  if (toInit.length === 0) return
  bulkUpsertMetadata(toInit)
  metadataCache.update((map) => {
    const next = new Map(map)
    for (const m of toInit) next.set(m.trackId, m)
    return next
  })
}

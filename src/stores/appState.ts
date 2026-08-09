import { writable, get, derived } from 'svelte/store'
import type { LocalMetadataStore, PlayQueueState } from '$lib/db'
import { getSetting, setSetting, getQueue, saveQueue, getAllMetadata, upsertMetadata, bulkUpsertMetadata, bulkDeleteMetadata } from '$lib/db'

export type PlaybackState = 'playing' | 'paused' | 'stopped' | 'buffering'

export interface Track {
  trackId: string
  title: string
  artist: string
  album: string
  albumId?: string
  year?: number
  duration: number
  fileType: "mp3" | "flac" | "m4a" | "ogg" | "opus" | "wav" | "aac" | "aiff" | "wma"
  composer?: string
  bitrate?: number
  size?: number
  createdAt?: number
  navidromePath?: string
  replayGain?: number
  albumReplayGain?: number
  albumArtist?: string
  trackNumber?: number
  comments?: string
  genre?: string
  starred?: boolean
  userRating?: number
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

export interface MetadataScanProgress {
  scanned: number
  total: number
  failed: number
  /** Rows whose previously-matched WebDAV file vanished (path cleared, re-matchable). */
  missing: number
  /** Rows with multiple equally-scored candidates — left untouched. */
  duplicateMatches: number
  /** Human label of the active scan ("Scanning all files..."/"Scanning changed files..."). */
  annotation?: string
}

export interface MetadataScanState {
  status: 'idle' | 'scanning' | 'complete' | 'error'
  progress: MetadataScanProgress
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
  playbackSpeed?: number
  pitchOctaves?: number
  scrobbling?: boolean
  ratingSource?: 'webdav' | 'navidrome'
  syncToNavidrome?: boolean
  writeTagsInNavidromeMode?: boolean
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
export const effectiveDuration = derived(
  [currentTrack],
  ([$ct]) => {
    return $ct?.duration ?? 0
  }
)
export const pitchOctaves = writable<number>(0)
export const metadataScanState = writable<MetadataScanState>({ status: 'idle', progress: { scanned: 0, total: 0, failed: 0, missing: 0, duplicateMatches: 0 } })

export interface AutoQueueFilters {
  minRating: number
  maxRating: number
  lovedOnly: boolean
  fromYear: number | ''
  toYear: number | ''
  minLength: number | ''
  maxLength: number | ''
  searchQuery?: string
  albumScope?: string
  artistScope?: string
  genre?: string
}

export type LoopMode = 'none' | 'one' | 'all'

export interface SleepTimerState {
  active: boolean
  mode: 'minutes' | 'endOfTrack'
  minutes: number
  /** Wall-clock timestamp at which the timer fires (minutes mode only). */
  endsAt: number
  /** Current-seconds label used by the now-playing overlay progress ring. */
  remainingSeconds: number
}

export const sleepTimer = writable<SleepTimerState>({
  active: false,
  mode: 'minutes',
  minutes: 30,
  endsAt: 0,
  remainingSeconds: 0,
})

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

export const loopMode = writable<LoopMode>('none')

/** Set when the non-shuffle auto queue wrapped back to the top of the sort order. */
export const queueWrapNotice = writable<boolean>(false)

export function setLibrary(tracks: Track[], complete = true): void {
  // A full (error-free) library load replaces the source of truth — reconcile
  // the queue and metadata cache against it so stale ids can't stall playback
  // or linger (pending rows are kept: they surface in Push Changes instead of
  // being silently lost).
  if (complete) {
    reconcileQueueWithLibrary(tracks)
    pruneStaleMetadata(tracks)
  }
  library.set(tracks)
}

function reconcileQueueWithLibrary(tracks: Track[]): void {
  const ids = new Set(tracks.map((t) => t.trackId))
  queue.update((q) => {
    const oldCombined = [...q.userQueue, ...q.autoQueue]
    const oldActiveId = q.activeIndex >= 0 && q.activeIndex < oldCombined.length ? oldCombined[q.activeIndex] : undefined

    const userQueue = q.userQueue.filter((id) => ids.has(id))
    const autoQueue = q.autoQueue.filter((id) => ids.has(id))
    const historyQueue = q.historyQueue.filter((id) => ids.has(id))
    const newCombined = [...userQueue, ...autoQueue]

    let activeIndex = q.activeIndex
    if (oldActiveId === undefined || !ids.has(oldActiveId)) {
      activeIndex = -1
    } else {
      const idx = newCombined.indexOf(oldActiveId)
      activeIndex = idx >= 0 ? idx : -1
    }

    const updated = { userQueue, autoQueue, historyQueue, activeIndex }
    saveQueue(updated)
    return updated
  })
}

function pruneStaleMetadata(tracks: Track[]): void {
  const ids = new Set(tracks.map((t) => t.trackId))
  const cache = get(metadataCache)
  const toDelete: string[] = []
  const remaining = new Map(cache)
  for (const [id, meta] of cache) {
    if (ids.has(id)) continue
    if (meta.syncStatus === 'pending_sync') continue
    remaining.delete(id)
    toDelete.push(id)
  }
  if (toDelete.length === 0) return
  metadataCache.set(remaining)
  void bulkDeleteMetadata(toDelete)
}

let initialized = false

export async function initStores(): Promise<void> {
  if (initialized) return

  const [q, allMeta] = await Promise.all([
    getQueue(),
    getAllMetadata(),
  ])
  await loadSettings()

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
  const keys: (keyof SettingsMap)[] = ['preloadTracks', 'crossfadeDuration', 'masterGain', 'activeEqProfile', 'savedEqProfiles', 'webdavUrl', 'webdavUser', 'webdavToken', 'navidromeUrl', 'navidromeUser', 'navidromePassword', 'tapeMode', 'snapTolerance', 'replayGainMode', 'playbackSpeed', 'pitchOctaves', 'scrobbling', 'ratingSource', 'syncToNavidrome', 'writeTagsInNavidromeMode']
  const entries = await Promise.all(keys.map(async (key) => {
    const value = await getSetting(key)
    return [key, value] as [typeof key, unknown]
  }))
  const s = Object.fromEntries(entries.filter(([, v]) => v !== undefined)) as SettingsMap
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

export function removeFromAutoQueue(trackId: string): void {
  queue.update((q) => {
    const autoQueue = q.autoQueue.filter((id) => id !== trackId)
    const historyQueue = [trackId, ...q.historyQueue].slice(0, 100)
    saveQueue({ ...q, autoQueue, historyQueue })
    return { ...q, autoQueue, historyQueue }
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

export function toggleShuffle(): void {
  shuffleEnabled.update((v) => !v)
  autoQueueFilters.update((f) => ({ ...f, albumScope: undefined, artistScope: undefined }))
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
        fileType: t.fileType,
        syncStatus: 'synced',
        lastModifiedLocally: Date.now(),
        comments: t.comments,
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

/**
 * Seeds rating/loved values carried by Navidrome songs (starred/userRating) into
 * the metadata cache so the UI shows server state without a full re-merge. Only
 * overwrites entries that were not locally modified (`syncStatus: 'synced'`).
 * In 'webdav' mode, existing WebDAV ratings take precedence over Navidrome's
 * integer-rounded star ratings.
 */
export function seedNavidromeFeedback(tracks: Track[]): void {
  const cache = get(metadataCache)
  const source = get(settings).ratingSource ?? 'webdav'
  const updates: LocalMetadataStore[] = []
  for (const t of tracks) {
    if (!t.trackId.startsWith('navidrome-')) continue
    const { starred, userRating } = t
    if (starred === undefined && userRating === undefined) continue
    const existing = cache.get(t.trackId)
    if (existing && existing.syncStatus === 'pending_sync') continue

    let rating = existing?.rating ?? 0
    if (source === 'navidrome' || !existing || (!existing.webdavPath && rating === 0)) {
      if (userRating !== undefined) {
        rating = Math.min(100, Math.round(userRating * 20))
      }
    }

    let loved = existing?.loved ?? false
    if (source === 'navidrome' || !existing || (!existing.webdavPath && !loved)) {
      if (starred !== undefined) {
        loved = starred === true
      }
    }

    const next: LocalMetadataStore = {
      trackId: t.trackId,
      rating,
      loved,
      fileType: t.fileType,
      syncStatus: existing?.syncStatus ?? 'synced',
      lastModifiedLocally: existing?.lastModifiedLocally ?? Date.now(),
      comments: existing?.comments ?? t.comments,
      webdavPath: existing?.webdavPath,
      webdavLastModified: existing?.webdavLastModified,
      webdavBase: existing?.webdavBase,
    }
    updates.push(next)
  }
  if (updates.length === 0) return
  bulkUpsertMetadata(updates)
  metadataCache.update((map) => {
    const next = new Map(map)
    for (const u of updates) next.set(u.trackId, u)
    return next
  })
}

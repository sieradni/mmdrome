import { writable, get, derived } from 'svelte/store'
import type { LocalMetadataStore } from '$lib/db'
import { getSetting, setSetting, getQueue, saveQueue, getAllMetadata, upsertMetadata, bulkUpsertMetadata, bulkDeleteMetadata } from '$lib/db'
import { persisted, type PersistedValue } from '$lib/persistedStore'
import { sanitizeRecent } from '$lib/recentWindow'

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
  /** Bounded LRU anti-repeat window (played/skipped/removed tracks), newest last. Owned by queueManager. */
  recentTrackIds: string[]
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
  webdavUrl?: string
  webdavUser?: string
  webdavToken?: string
  navidromeUrl?: string
  navidromeUser?: string
  navidromePassword?: string
  replayGainMode?: 'off' | 'track' | 'album'
  scrobbling?: boolean
  ratingSource?: 'webdav' | 'navidrome'
  syncToNavidrome?: boolean
  writeTagsInNavidromeMode?: boolean
}

export const currentTrack = writable<Track | null>(null)
export const playbackState = writable<PlaybackState>('stopped')
export const queue = writable<QueueState>({ userQueue: [], autoQueue: [], recentTrackIds: [], activeIndex: -1 })
export const settings = writable<SettingsMap>({})
export const metadataCache = writable<Map<string, LocalMetadataStore>>(new Map())
export const library = writable<Track[]>([])
export const webdavConnection = writable<{ connected: boolean; error?: string; checking: boolean }>({ connected: false, checking: false })
export const navidromeConnection = writable<{ connected: boolean; error?: string; checking: boolean; serverVersion?: string }>({ connected: false, checking: false })
export const navidromeLoadStatus = writable<{ loading: boolean; loaded: number; failed: number; error?: string; cached?: boolean }>({ loading: false, loaded: 0, failed: 0 })
// Engine-bound scalar settings: store-layer persistence via `persisted`, and
// the engine push lives in playbackManager (`_applyPlaybackParams` at restore,
// `_subscribeShared` reactions for the live edges). Restored once in
// `initStores`; the value is only trusted after `restore()` runs.
const _playbackSpeed = persisted<number>('playbackSpeed', 1)
const _pitchOctaves = persisted<number>('pitchOctaves', 0)
const _tapeMode = persisted<boolean>('tapeMode', false)
const _snapTolerance = persisted<number>('snapTolerance', 0.15)
const _masterGain = persisted<number>('masterGain', 1)
const _shuffleEnabled = persisted<boolean>('shuffleEnabled', false)
const _loopMode = persisted<LoopMode>('loopMode', 'none')

export const shuffleEnabled = _shuffleEnabled.store
export const currentTime = writable<number>(0)
export const playbackSpeed = _playbackSpeed.store
export const tapeMode = _tapeMode.store
export const snapTolerance = _snapTolerance.store
export const masterGain = _masterGain.store
export const loopMode = _loopMode.store
export const effectiveDuration = derived(
  [currentTrack],
  ([$ct]) => {
    return $ct?.duration ?? 0
  }
)
export const pitchOctaves = _pitchOctaves.store
export const metadataScanState = writable<MetadataScanState>({ status: 'idle', progress: { scanned: 0, total: 0, failed: 0, missing: 0, duplicateMatches: 0 } })

/** Fields the user edits in the Queue filter panel — persisted via `persisted`. */
export interface AutoQueueFilterFields {
  minRating: number
  maxRating: number
  lovedOnly: boolean
  fromYear: number | ''
  toYear: number | ''
  minLength: number | ''
  maxLength: number | ''
  genre?: string
  searchQuery?: string
}

/** Session-only auto-queue scoping (B5) — NEVER persisted. */
export interface AutoQueueScope {
  albumScope?: string
  artistScope?: string
}

export type AutoQueueFilters = AutoQueueFilterFields & AutoQueueScope

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

const AUTO_QUEUE_FILTER_DEFAULTS: AutoQueueFilterFields = {
  minRating: 0,
  maxRating: 100,
  lovedOnly: false,
  fromYear: '',
  toYear: '',
  minLength: '',
  maxLength: '',
  searchQuery: '',
}

function normNumber(v: unknown): number | '' {
  if (v === 0 || v === null || v === undefined || v === '') return ''
  const num = Number(v)
  return isNaN(num) ? '' : num
}

/**
 * Coerces a saved `autoQueueFilters` row into the fields shape. Older app
 * versions stored a JSON string under the key; the persisted store now holds
 * the object itself. Returns `undefined` (keep initial) on corrupt input.
 */
export function decodeAutoQueueFilters(raw: PersistedValue | undefined): AutoQueueFilterFields | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' && typeof raw !== 'string') return undefined
  let p: Partial<AutoQueueFilterFields> | null = null
  if (typeof raw === 'string') {
    try {
      p = JSON.parse(raw) as Partial<AutoQueueFilterFields>
    } catch {
      return undefined
    }
  } else {
    p = raw as Partial<AutoQueueFilterFields>
  }
  return {
    ...AUTO_QUEUE_FILTER_DEFAULTS,
    ...p,
    minRating: typeof p.minRating === 'number' ? p.minRating : AUTO_QUEUE_FILTER_DEFAULTS.minRating,
    maxRating: typeof p.maxRating === 'number' ? p.maxRating : AUTO_QUEUE_FILTER_DEFAULTS.maxRating,
    lovedOnly: typeof p.lovedOnly === 'boolean' ? p.lovedOnly : AUTO_QUEUE_FILTER_DEFAULTS.lovedOnly,
    fromYear: normNumber(p.fromYear),
    toYear: normNumber(p.toYear),
    minLength: normNumber(p.minLength),
    maxLength: normNumber(p.maxLength),
    genre: typeof p.genre === 'string' ? p.genre : undefined,
    searchQuery: typeof p.searchQuery === 'string' ? p.searchQuery : undefined,
  }
}

const _autoQueueFilterFields = persisted<AutoQueueFilterFields>('autoQueueFilters', AUTO_QUEUE_FILTER_DEFAULTS, {
  decode: decodeAutoQueueFilters,
})

export const autoQueueFilterFields = _autoQueueFilterFields.store

/** Session-only auto-queue scoping (B5): set on play from album/artist views,
 *  cleared on shuffle toggle / plain TrackRow play. By construction the scopes
 *  live in their own writable, so they can never leak into the persisted row. */
export const autoQueueScope = writable<AutoQueueScope>({})

/** Combined view for queueManager / playbackManager (fields + session scope). */
export const autoQueueFilters = derived([autoQueueFilterFields, autoQueueScope], ([f, s]) => ({ ...f, ...s }))

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
    const recentTrackIds = q.recentTrackIds.filter((id) => ids.has(id))
    const newCombined = [...userQueue, ...autoQueue]

    let activeIndex = q.activeIndex
    if (oldActiveId === undefined || !ids.has(oldActiveId)) {
      activeIndex = -1
    } else {
      const idx = newCombined.indexOf(oldActiveId)
      activeIndex = idx >= 0 ? idx : -1
    }

    const updated = { userQueue, autoQueue, recentTrackIds, activeIndex }
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
    // `?? q.historyQueue` tolerates rows persisted by app versions that still
    // used the old field name — the first saveQueue overwrites the row.
    queue.set({
      userQueue: q.userQueue,
      autoQueue: q.autoQueue,
      recentTrackIds: sanitizeRecent(q.recentTrackIds ?? (q as { historyQueue?: string[] }).historyQueue),
      activeIndex: q.activeIndex,
    })
  }

  const map = new Map<string, LocalMetadataStore>()
  for (const m of allMeta) {
    map.set(m.trackId, m)
  }
  metadataCache.set(map)

  // Restore the engine-bound scalar settings (order-independent here — the
  // playback manager applies them to the engine in snap-before-pitch order).
  await Promise.all([
    _playbackSpeed.restore(),
    _pitchOctaves.restore(),
    _tapeMode.restore(),
    _snapTolerance.restore(),
    _masterGain.restore(),
    _shuffleEnabled.restore(),
    _loopMode.restore(),
    _autoQueueFilterFields.restore(),
  ])

  initialized = true
}

async function loadSettings(): Promise<void> {
  const keys: (keyof SettingsMap)[] = ['preloadTracks', 'crossfadeDuration', 'webdavUrl', 'webdavUser', 'webdavToken', 'navidromeUrl', 'navidromeUser', 'navidromePassword', 'replayGainMode', 'scrobbling', 'ratingSource', 'syncToNavidrome', 'writeTagsInNavidromeMode']
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

export function setActiveQueueIndex(index: number): void {
  queue.update((q) => {
    saveQueue({ ...q, activeIndex: index })
    return { ...q, activeIndex: index }
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
  autoQueueScope.set({})
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
      // The bulk replace must not drop matching intent (a seeded dismissed /
      // manually-bound row would otherwise be re-matched on the next scan, D8).
      matchSource: existing?.matchSource,
      ignored: existing?.ignored,
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

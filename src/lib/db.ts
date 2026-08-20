import Dexie, { type EntityTable } from 'dexie'
import type { FileMetadata } from './metadataReader'

export interface LocalMetadataStore {
  trackId: string
  rating: number
  loved: boolean
  fileType: "mp3" | "flac" | "m4a" | "ogg" | "opus" | "wav" | "aac" | "aiff" | "wma"
  syncStatus: "synced" | "pending_sync"
  lastModifiedLocally: number
  webdavPath?: string
  webdavLastModified?: string
  /** `baseUrl|user` the webdavPath was matched against (guards cross-server pushes). */
  webdavBase?: string
  comments?: string
  /** 'manual' = the user bound this row via the File Matching UI. The scanner
   *  must never overwrite a manual binding with its own match. */
  matchSource?: 'auto' | 'manual'
  /** User dismissed this track ("not on this server") — scans and push skip it. */
  ignored?: boolean
}

export interface WebdavFileEntry {
  path: string
  filename: string
  size: number
  lastModified?: string
  /** Identity tags harvested from a content probe (`probeFileTags`). */
  tags?: FileTags
}

/** Identity metadata read from a file's tags (not filename-derived). */
export interface FileTags {
  title?: string
  artist?: string
  album?: string
  trackNumber?: number
  /** Release year (corroboration only — never a contradiction on mismatch). */
  year?: number
  /** Duration in SECONDS (taglib `AudioProperties.duration`). Absent/null
   *  (0, `getAudioProperties()` null) = no signal — never a demotion. */
  duration?: number
}

/** Cached tag-probe result, keyed `baseKey|path` scoped by size + mtime + status. */
export interface FileTagCacheEntry {
  id: string
  /** `baseUrl|user` this probe ran against — never reused across servers. */
  baseKey: string
  path: string
  /** Size at probe time; a size change invalidates the cached result. */
  size: number
  /** WebDAV mtime at probe time; a changed mtime invalidates the cached result. */
  lastModified?: string
  /** The complete result of the one metadata read (identity + feedback). */
  metadata?: FileMetadata
  /**
   * `ok` = identity tags read; `empty` = reachable but no identity tags;
   * `unreadable` = tag parsing/read failed; `network-error` = the fetch did
   * not complete. Error statuses are retried by their TTL, not forever.
   */
  status: 'ok' | 'empty' | 'unreadable' | 'network-error'
  probedAt: number
}

export interface WebdavFileIndex {
  id: string
  entries: WebdavFileEntry[]
  buildTimestamp: number
  lastScan?: string
  /** `baseUrl|user` this index was built against — mismatches force a rebuild. */
  baseKey?: string
  /** Change-detector over the file set (path+size); lets scans skip unmatched retries when the server is unchanged. */
  fingerprint?: string
  /** Change-detector over newly harvested tag evidence. */
  tagFingerprint?: string
  /** False when the Depth:1 fallback skipped one or more directories. */
  complete?: boolean
}

export interface SongLibraryCache {
  id: string
  tracks: import('./navidromeApi').NavidromeSong[]
  lastScan: string
  /** `baseUrl|username` this cache belongs to — prevents cross-server reuse. */
  baseKey?: string
}

export interface UserSettings {
  key: string
  value: string | number | boolean | object
}

export interface PlayQueueState {
  id: string
  userQueue: string[]
  autoQueue: string[]
  /** Bounded LRU anti-repeat window (played/skipped/removed tracks), newest last. */
  recentTrackIds: string[]
  activeIndex: number
}

const db = new Dexie('mmdrome') as Dexie & {
  localMetadata: EntityTable<LocalMetadataStore, 'trackId'>
  userSettings: EntityTable<UserSettings, 'key'>
  playQueue: EntityTable<PlayQueueState, 'id'>
  webdavFileIndex: EntityTable<WebdavFileIndex, 'id'>
  songLibraryCache: EntityTable<SongLibraryCache, 'id'>
  webdavFileTags: EntityTable<FileTagCacheEntry, 'id'>
}

db.version(1).stores({
  localMetadata: 'trackId, syncStatus, rating, loved',
  userSettings: 'key',
  playQueue: 'id',
})

db.version(2).stores({
  localMetadata: 'trackId, syncStatus, rating, loved',
  userSettings: 'key',
  playQueue: 'id',
  webdavFileIndex: 'id',
})

db.version(3).stores({
  localMetadata: 'trackId, syncStatus, rating, loved',
  userSettings: 'key',
  playQueue: 'id',
  webdavFileIndex: 'id',
  songLibraryCache: 'id',
})

db.version(4).stores({
  localMetadata: 'trackId, syncStatus, rating, loved',
  userSettings: 'key',
  playQueue: 'id',
  webdavFileIndex: 'id',
  songLibraryCache: 'id',
  webdavFileTags: 'id, baseKey',
})

// The tag cache payload changed from identity-only tags to the complete result
// of one metadata read. Local cache data is disposable, so clear it once at
// the schema boundary instead of carrying probe-version branches forever.
db.version(5).stores({
  localMetadata: 'trackId, syncStatus, rating, loved',
  userSettings: 'key',
  playQueue: 'id',
  webdavFileIndex: 'id',
  songLibraryCache: 'id',
  webdavFileTags: 'id, baseKey',
}).upgrade((tx) => tx.table('webdavFileTags').clear())

export { db }

export async function getAllMetadata(): Promise<LocalMetadataStore[]> {
  return db.localMetadata.toArray()
}

export async function upsertMetadata(meta: LocalMetadataStore): Promise<void> {
  await db.localMetadata.put(meta)
}

/** Rows per IndexedDB bulk transaction. A first connect of a large library
 *  builds tens of thousands of metadata rows; sending them in one transaction
 *  spikes memory and can time out/abort in iOS WebKit. Chunking keeps each
 *  transaction small enough to commit reliably. */
const BULK_CHUNK = 2000

export async function bulkUpsertMetadata(items: LocalMetadataStore[]): Promise<void> {
  for (let i = 0; i < items.length; i += BULK_CHUNK) {
    await db.localMetadata.bulkPut(items.slice(i, i + BULK_CHUNK))
  }
}

export async function bulkDeleteMetadata(ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += BULK_CHUNK) {
    await db.localMetadata.bulkDelete(ids.slice(i, i + BULK_CHUNK))
  }
}

export async function getPendingSyncMetadata(): Promise<LocalMetadataStore[]> {
  return db.localMetadata.where('syncStatus').equals('pending_sync').toArray()
}

export async function getSetting<T = string>(key: string): Promise<T | undefined> {
  const entry = await db.userSettings.get(key)
  return entry?.value as T | undefined
}

export async function setSetting(key: string, value: string | number | boolean | object): Promise<void> {
  await db.userSettings.put({ key, value })
}

export async function getQueue(): Promise<PlayQueueState | undefined> {
  return db.playQueue.get('main')
}

export async function saveQueue(queue: Omit<PlayQueueState, 'id'>): Promise<void> {
  await db.playQueue.put({ id: 'main', ...queue })
}

export async function getWebdavFileIndex(): Promise<WebdavFileIndex | undefined> {
  return db.webdavFileIndex.get('main')
}

export async function saveWebdavFileIndex(index: Omit<WebdavFileIndex, 'id'>): Promise<void> {
  await db.webdavFileIndex.put({ id: 'main', ...index })
}

export async function clearWebdavFileIndex(): Promise<void> {
  await db.webdavFileIndex.delete('main')
}

export async function getSongLibraryCache(): Promise<SongLibraryCache | undefined> {
  return db.songLibraryCache.get('main')
}

export async function saveSongLibraryCache(cache: Omit<SongLibraryCache, 'id'>): Promise<void> {
  await db.songLibraryCache.put({ id: 'main', ...cache })
}

export async function getFileTagsForBase(
  baseKey: string,
): Promise<FileTagCacheEntry[]> {
  return db.webdavFileTags.where('baseKey').equals(baseKey).toArray()
}

export async function putFileTag(entry: FileTagCacheEntry): Promise<void> {
  await db.webdavFileTags.put(entry)
}

/** Drop probe results for a server identity when credentials move away from it. */
export async function deleteFileTagsForBase(baseKey: string): Promise<void> {
  await db.webdavFileTags.where('baseKey').equals(baseKey).delete()
}

/** Delete a bounded set of probe rows after a complete fresh index proves the
 *  paths no longer exist on the server. */
export async function deleteFileTagsByIds(ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += BULK_CHUNK) {
    await db.webdavFileTags.bulkDelete(ids.slice(i, i + BULK_CHUNK))
  }
}

/** Update only the tag-evidence marker on the current index snapshot. */
export async function updateWebdavFileTagFingerprint(
  baseKey: string,
  tagFingerprint: string,
): Promise<void> {
  const current = await db.webdavFileIndex.get('main')
  if (!current || current.baseKey !== baseKey) return
  await db.webdavFileIndex.put({ ...current, tagFingerprint })
}

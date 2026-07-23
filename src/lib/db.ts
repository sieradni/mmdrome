import Dexie, { type EntityTable } from 'dexie'

export interface LocalMetadataStore {
  trackId: string
  rating: number
  loved: boolean
  filePath: string
  fileType: "mp3" | "flac" | "m4a" | "ogg" | "opus"
  syncStatus: "synced" | "pending_sync"
  lastModifiedLocally: number
  webdavPath?: string
  webdavLastModified?: string
}

export interface WebdavFileEntry {
  path: string
  filename: string
  size: number
  lastModified?: string
}

export interface WebdavFileIndex {
  id: string
  entries: WebdavFileEntry[]
  buildTimestamp: number
  lastScan?: string
}

export interface SongLibraryCache {
  id: string
  tracks: import('./navidromeApi').NavidromeSong[]
  lastScan: string
}

export interface UserSettings {
  key: string
  value: string | number | boolean | object
}

export interface PlayQueueState {
  id: string
  userQueue: string[]
  autoQueue: string[]
  historyQueue: string[]
  activeIndex: number
}

const db = new Dexie('mmdrome') as Dexie & {
  localMetadata: EntityTable<LocalMetadataStore, 'trackId'>
  userSettings: EntityTable<UserSettings, 'key'>
  playQueue: EntityTable<PlayQueueState, 'id'>
  webdavFileIndex: EntityTable<WebdavFileIndex, 'id'>
  songLibraryCache: EntityTable<SongLibraryCache, 'id'>
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

export { db }

export async function getMetadata(trackId: string): Promise<LocalMetadataStore | undefined> {
  return db.localMetadata.get(trackId)
}

export async function getAllMetadata(): Promise<LocalMetadataStore[]> {
  return db.localMetadata.toArray()
}

export async function upsertMetadata(meta: LocalMetadataStore): Promise<void> {
  await db.localMetadata.put(meta)
}

export async function bulkUpsertMetadata(items: LocalMetadataStore[]): Promise<void> {
  await db.localMetadata.bulkPut(items)
}

export async function deleteMetadata(trackId: string): Promise<void> {
  await db.localMetadata.delete(trackId)
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

export async function clearSongLibraryCache(): Promise<void> {
  await db.songLibraryCache.delete('main')
}

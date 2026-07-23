import { get } from "svelte/store"
import { library, metadataCache, metadataScanState, updateMetadata } from "../stores/appState"
import type { Track } from "../stores/appState"
import { getWebdavFileIndex, saveWebdavFileIndex } from "./db"
import type { LocalMetadataStore } from "./db"
import {
  buildWebdavFileIndex,
  matchTrackToWebdav,
  readFileMetadata,
  buildPathTimestamps,
  findChangedTracks,
} from "./metadataReader"
import type { WebdavFileEntry } from "./db"

const CONCURRENCY = 6

interface QueueItem {
  trackId: string
}

let queue: QueueItem[] = []
let activeCount = 0
let cancelled = false
let index: WebdavFileEntry[] = []
let indexBuilt = false

let webdavUrl = ""
let webdavUser = ""
let webdavToken = ""

export function setWebdavCredentials(url: string, user: string, token: string): void {
  webdavUrl = url
  webdavUser = user
  webdavToken = token
}

export function getWebdavConfigured(): boolean {
  return !!(webdavUrl && webdavUser && webdavToken)
}

export async function ensureIndex(): Promise<void> {
  if (indexBuilt && index.length > 0) return

  const cached = await getWebdavFileIndex()
  if (cached && cached.entries.length > 0) {
    index = cached.entries
    indexBuilt = true
    return
  }

  await rebuildIndex()
}

export async function rebuildIndex(): Promise<void> {
  if (!webdavUrl || !webdavUser || !webdavToken) return

  index = await buildWebdavFileIndex(webdavUrl, webdavUser, webdavToken)
  indexBuilt = true
  await saveWebdavFileIndex({ entries: index, buildTimestamp: Date.now() })
}

export function prioritizeTrack(trackId: string): void {
  if (!queue.some((qi) => qi.trackId === trackId)) {
    queue.unshift({ trackId })
    drain()
  }
}

let scannedCount = 0
let failedCount = 0
let totalTracks = 0

export async function scanAllNow(): Promise<void> {
  cancelled = false
  queue = []
  scannedCount = 0
  failedCount = 0
  totalTracks = 0

  if (!webdavUrl || !webdavUser || !webdavToken) return

  metadataScanState.set({ status: "scanning", progress: { scanned: 0, total: 0, failed: 0 } })

  const tracks = get(library)
  const cache = get(metadataCache)

  const freshIndex = await buildWebdavFileIndex(webdavUrl, webdavUser, webdavToken)
  index = freshIndex
  indexBuilt = true
  await saveWebdavFileIndex({ entries: freshIndex, buildTimestamp: Date.now() })

  const timestamps = buildPathTimestamps(freshIndex)
  const { changed, unmatched } = findChangedTracks(tracks, cache, freshIndex, timestamps)
  const alreadySeen = new Set(cache.keys())

  for (const t of changed) queue.push({ trackId: t.trackId })
  for (const t of unmatched) queue.push({ trackId: t.trackId })

  const skipCount = Array.from(alreadySeen).filter((id) => {
    const meta = cache.get(id)
    return meta?.webdavPath && !changed.some((c) => c.trackId === id) && !unmatched.some((u) => u.trackId === id)
  }).length

  totalTracks = queue.length + skipCount
  metadataScanState.set({
    status: "scanning",
    progress: { scanned: skipCount, total: totalTracks, failed: 0 },
  })

  drain()
}

async function drain(): Promise<void> {
  if (cancelled) return

  while (activeCount < CONCURRENCY && queue.length > 0) {
    const item = queue.shift()
    if (!item) break
    activeCount++
    processItem(item).finally(() => {
      activeCount--
      drain()
    })
  }
}

async function processItem(item: QueueItem): Promise<void> {
  const tracks = get(library)
  const track = tracks.find((t) => t.trackId === item.trackId)
  if (!track) return

  const match = matchTrackToWebdav(track, index)
  if (!match) {
    scannedCount++
    updateScanProgress()
    return
  }

  try {
    const meta = await readFileMetadata(webdavUrl, match.path, webdavUser, webdavToken, track.fileType)
    updateMetadata({
      trackId: track.trackId,
      rating: meta.rating,
      loved: meta.loved,
      filePath: track.filePath,
      fileType: track.fileType,
      syncStatus: "synced",
      lastModifiedLocally: Date.now(),
      webdavPath: match.path,
      webdavLastModified: match.lastModified,
    })
    scannedCount++
  } catch {
    failedCount++
  }
  updateScanProgress()
}

function updateScanProgress(): void {
  const done = scannedCount + failedCount
  if (done >= totalTracks) {
    metadataScanState.set({
      status: "complete",
      progress: { scanned: scannedCount, total: totalTracks, failed: failedCount },
    })
  } else {
    metadataScanState.set({
      status: "scanning",
      progress: { scanned: done, total: totalTracks, failed: failedCount },
    })
  }
}

export function resetScan(): void {
  cancelled = true
  queue = []
  activeCount = 0
  scannedCount = 0
  failedCount = 0
  totalTracks = 0
  indexBuilt = false
  index = []
  metadataScanState.set({ status: "idle", progress: { scanned: 0, total: 0, failed: 0 } })
}

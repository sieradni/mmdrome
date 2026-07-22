import { get } from "svelte/store"
import { library, metadataCache, metadataScanState, updateMetadata } from "../stores/appState"
import type { Track } from "../stores/appState"
import { getWebdavFileIndex, saveWebdavFileIndex } from "./db"
import type { LocalMetadataStore } from "./db"
import {
  buildWebdavFileIndex,
  matchTrackToWebdav,
  readFileMetadata,
} from "./metadataReader"
import type { WebdavFileEntry } from "./db"

const CONCURRENCY = 6

interface QueueItem {
  trackId: string
  priority: number
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
  const existingIdx = queue.findIndex((qi) => qi.trackId === trackId)
  if (existingIdx >= 0) {
    queue[existingIdx].priority = queue[existingIdx].priority + 1
  } else {
    queue.push({ trackId, priority: 10 })
  }
  queue.sort((a, b) => b.priority - a.priority)
  drain()
}

export function deprioritizeTrack(trackId: string): void {
  const existingIdx = queue.findIndex((qi) => qi.trackId === trackId)
  if (existingIdx >= 0) {
    queue[existingIdx].priority = Math.max(0, queue[existingIdx].priority - 1)
  }
}

export function enqueueAll(rescanAll?: boolean): void {
  const cache = get(metadataCache)
  const tracks = get(library)
  const existing: Set<string> = new Set(queue.map((qi) => qi.trackId))

  for (const t of tracks) {
    if (existing.has(t.trackId)) continue
    const meta = cache.get(t.trackId)
    const needsMetadata = rescanAll || (!meta || (meta.rating === 0 && !meta.loved))
    queue.push({
      trackId: t.trackId,
      priority: needsMetadata ? 1 : 0,
    })
  }
  queue.sort((a, b) => b.priority - a.priority)
  drain()
}

export function scanAllNow(): void {
  cancelled = false
  queue = []
  scannedCount = 0
  failedCount = 0
  const total = get(library).length
  metadataScanState.set({
    status: "scanning",
    progress: { scanned: 0, total, failed: 0 },
  })
  enqueueAll(true)
}

let totalQueued = 0
let scannedCount = 0
let failedCount = 0

async function drain(): Promise<void> {
  if (cancelled) return
  if (!indexBuilt) return
  if (!getWebdavConfigured()) return

  while (activeCount < CONCURRENCY && queue.length > 0) {
    const item = queue.shift()
    if (!item) break
    activeCount++
    totalQueued++
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
    })
    scannedCount++
  } catch {
    failedCount++
  }
  updateScanProgress()
}

function updateScanProgress(): void {
  const total = get(library).length
  const done = scannedCount + failedCount
  if (done >= total) {
    metadataScanState.set({
      status: "complete",
      progress: { scanned: scannedCount, total, failed: failedCount },
    })
  } else {
    metadataScanState.set({
      status: "scanning",
      progress: { scanned: done, total, failed: failedCount },
    })
  }
}

export function resetScan(): void {
  cancelled = true
  queue = []
  activeCount = 0
  scannedCount = 0
  failedCount = 0
  totalQueued = 0
  indexBuilt = false
  index = []
  metadataScanState.set({ status: "idle", progress: { scanned: 0, total: 0, failed: 0 } })
}

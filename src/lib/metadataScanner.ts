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
let scanGen = 0
let index: WebdavFileEntry[] = []
let indexBuilt = false
let serverLastScan = ""

let webdavUrl = ""
let webdavUser = ""
let webdavToken = ""
let indexBaseKey = ""

function currentIndexKey(): string {
  return `${webdavUrl}|${webdavUser}`
}

export function setWebdavCredentials(url: string, user: string, token: string): void {
  if (`${url}|${user}` !== indexBaseKey) {
    // The index (in-memory or cached) belongs to a different server/user —
    // never reuse it against the new credentials.
    index = []
    indexBuilt = false
    indexBaseKey = ""
  }
  webdavUrl = url
  webdavUser = user
  webdavToken = token
}

export function setServerLastScan(scan: string): void {
  serverLastScan = scan
}

export async function ensureIndex(): Promise<void> {
  const key = currentIndexKey()
  if (indexBuilt && index.length > 0 && indexBaseKey === key) return

  const cached = await getWebdavFileIndex()
  if (cached && cached.entries.length > 0 && cached.baseKey === key) {
    index = cached.entries
    indexBaseKey = key
    indexBuilt = true
    return
  }

  await rebuildIndex()
}

export async function rebuildIndex(): Promise<void> {
  if (!webdavUrl || !webdavUser || !webdavToken) return

  index = await buildWebdavFileIndex(webdavUrl, webdavUser, webdavToken)
  indexBaseKey = currentIndexKey()
  indexBuilt = true
  await saveWebdavFileIndex({ entries: index, buildTimestamp: Date.now(), lastScan: serverLastScan, baseKey: indexBaseKey })
}

let scannedCount = 0
let failedCount = 0
let totalTracks = 0

export async function scanAllNow(forceRescan = false): Promise<void> {
  cancelled = true
  const myGen = ++scanGen
  queue = []
  scannedCount = 0
  failedCount = 0
  totalTracks = 0

  if (!webdavUrl || !webdavUser || !webdavToken) return
  if (scanGen !== myGen) return

  metadataScanState.set({ status: "scanning", progress: { scanned: 0, total: 0, failed: 0 } })

  if (forceRescan) {
    await rebuildIndex()
  } else {
    await ensureIndex()
    if (index.length === 0) {
      metadataScanState.set({ status: "complete", progress: { scanned: 0, total: 0, failed: 0 } })
      return
    }
  }

  const tracks = get(library)
  const cache = get(metadataCache)

  const timestamps = buildPathTimestamps(index)
  const { changed, unmatched } = findChangedTracks(tracks, cache, index, timestamps)
  const alreadySeen = new Set(cache.keys())

  for (const t of changed) queue.push({ trackId: t.trackId })
  for (const t of unmatched) queue.push({ trackId: t.trackId })

  const skipCount = Array.from(alreadySeen).filter((id) => {
    const meta = cache.get(id)
    return meta?.webdavPath && !changed.some((c) => c.trackId === id) && !unmatched.some((u) => u.trackId === id)
  }).length

  totalTracks = queue.length
  if (scanGen !== myGen) return
  cancelled = false

  if (totalTracks === 0) {
    // Nothing to read. Without this short-circuit the drain loop never runs
    // updateScanProgress, leaving the UI stuck at 0/0 "scanning" forever.
    metadataScanState.set({
      status: "complete",
      progress: { scanned: 0, total: 0, failed: 0 },
      error: tracks.length === 0 ? "No library loaded — connect Navidrome first" : undefined,
    })
    return
  }

  metadataScanState.set({
    status: "scanning",
    progress: { scanned: 0, total: totalTracks, failed: 0 },
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
  const startedGen = scanGen
  const tracks = get(library)
  const track = tracks.find((t) => t.trackId === item.trackId)
  if (!track || scanGen !== startedGen) return

  const existing = get(metadataCache).get(track.trackId)
  if (existing && existing.syncStatus === 'pending_sync') {
    scannedCount++
    updateScanProgress()
    return
  }

  const match = matchTrackToWebdav(track, index)
  if (scanGen !== startedGen) return
  if (!match) {
    scannedCount++
    updateScanProgress()
    return
  }

  try {
    const meta = await readFileMetadata(webdavUrl, match.path, webdavUser, webdavToken, track.fileType)
    if (scanGen !== startedGen) return

    // The user may have edited rating/loved while the fetch was in flight —
    // don't clobber the pending edit with stale file tags.
    const current = get(metadataCache).get(track.trackId)
    if (current && current.syncStatus === 'pending_sync') {
      scannedCount++
      updateScanProgress()
      return
    }

    updateMetadata({
      trackId: track.trackId,
      rating: meta.rating,
      loved: meta.loved,
      fileType: track.fileType,
      syncStatus: "synced",
      lastModifiedLocally: Date.now(),
      webdavPath: match.path,
      webdavLastModified: match.lastModified,
      webdavBase: currentIndexKey(),
      comments: meta.comments,
    })
    scannedCount++
  } catch {
    if (scanGen === startedGen) failedCount++
  }
  if (scanGen === startedGen) updateScanProgress()
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

export async function scanAllForceRescan(): Promise<void> {
  cancelled = true
  const myGen = ++scanGen
  queue = []
  scannedCount = 0
  failedCount = 0
  totalTracks = 0

  if (!webdavUrl || !webdavUser || !webdavToken) return
  if (scanGen !== myGen) return

  metadataScanState.set({ status: "scanning", progress: { scanned: 0, total: 0, failed: 0 } })

  await rebuildIndex()

  const tracks = get(library)
  for (const t of tracks) queue.push({ trackId: t.trackId })

  totalTracks = queue.length
  if (scanGen !== myGen) return
  cancelled = false

  if (totalTracks === 0) {
    metadataScanState.set({
      status: "complete",
      progress: { scanned: 0, total: 0, failed: 0 },
      error: tracks.length === 0 ? "No library loaded — connect Navidrome first" : undefined,
    })
    return
  }

  metadataScanState.set({
    status: "scanning",
    progress: { scanned: 0, total: totalTracks, failed: 0 },
  })

  drain()
}

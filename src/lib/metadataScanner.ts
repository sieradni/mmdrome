import { get } from "svelte/store"
import { library, metadataCache, metadataScanState, updateMetadata } from "../stores/appState"
import type { Track } from "../stores/appState"
import { saveWebdavFileIndex } from "./db"
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

/**
 * Fresh PROPFIND against the server — the ONLY freshness source for scans.
 * The Dexie-persisted index is a startup fallback path handled by callers who
 * need a snapshot without probing (debug tooling), it is never a valid basis
 * for a scan diff. Returns false when the probe fails (server unreachable,
 * auth error) so the caller can abort instead of scanning a stale snapshot.
 */
export async function refreshIndex(): Promise<boolean> {
  if (!webdavUrl || !webdavUser || !webdavToken) return false
  try {
    index = await buildWebdavFileIndex(webdavUrl, webdavUser, webdavToken)
    indexBaseKey = currentIndexKey()
    indexBuilt = true
    await saveWebdavFileIndex({ entries: index, buildTimestamp: Date.now(), lastScan: serverLastScan, baseKey: indexBaseKey })
    return true
  } catch {
    return false
  }
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
let missingCount = 0
let ambiguousCount = 0
let totalTracks = 0

export async function scanAllNow(forceRescan = false): Promise<void> {
  cancelled = true
  const myGen = ++scanGen
  queue = []
  scannedCount = 0
  failedCount = 0
  missingCount = 0
  ambiguousCount = 0
  totalTracks = 0

  if (!webdavUrl || !webdavUser || !webdavToken) return
  if (scanGen !== myGen) return

  metadataScanState.set({ status: "scanning", progress: { scanned: 0, total: 0, failed: 0, missing: 0, duplicateMatches: 0 } })

  if (forceRescan) {
    try {
      await rebuildIndex()
    } catch {
      if (scanGen !== myGen) return
      metadataScanState.set({
        status: "error",
        progress: { scanned: 0, total: 0, failed: 0, missing: 0, duplicateMatches: 0 },
        error: "Index refresh failed — is the WebDAV server reachable?",
      })
      return
    }
  } else {
    // Always probe the server: the whole point of "Check Modified Ratings" is
    // freshness. A stale snapshot can never detect remote edits; abort loudly
    // on probe failure instead of scanning against one.
    const ok = await refreshIndex()
    if (!ok) {
      if (scanGen !== myGen) return
      metadataScanState.set({
        status: "error",
        progress: { scanned: 0, total: 0, failed: 0, missing: 0, duplicateMatches: 0 },
        error: "Index refresh failed — is the WebDAV server reachable?",
      })
      return
    }
    if (index.length === 0) {
      metadataScanState.set({ status: "complete", progress: { scanned: 0, total: 0, failed: 0, missing: 0, duplicateMatches: 0 } })
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
      progress: { scanned: 0, total: 0, failed: 0, missing: 0, duplicateMatches: 0 },
      error: tracks.length === 0 ? "No library loaded — connect Navidrome first" : undefined,
    })
    return
  }

  metadataScanState.set({
    status: "scanning",
    progress: { scanned: 0, total: totalTracks, failed: 0, missing: 0, duplicateMatches: 0 },
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
  if (!match.entry) {
    if (match.ambiguous) {
      // Two files tied for the top score — never guess. The row keeps its
      // previous mapping (if any) and is not re-fetched; Push skips rows it
      // cannot confidently target.
      ambiguousCount++
    } else if (existing && existing.webdavPath && !index.some((i) => i.path === existing.webdavPath)) {
      // The file it was previously matched to no longer exists in a FRESH
      // index (deleted/renamed). Clear the stale path so the row re-matches
      // on a later PROPFIND (renames) and Push skips it cleanly instead of
      // 404 failing forever. Rating/loved are preserved — data loss-free.
      missingCount++
      updateMetadata({
        trackId: track.trackId,
        rating: existing.rating,
        loved: existing.loved,
        fileType: existing.fileType || track.fileType,
        syncStatus: existing.syncStatus,
        lastModifiedLocally: existing.lastModifiedLocally,
        comments: existing.comments,
      })
    } else {
      scannedCount++
    }
    updateScanProgress()
    return
  }

  try {
    const meta = await readFileMetadata(webdavUrl, match.entry.path, webdavUser, webdavToken, track.fileType)
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
      webdavPath: match.entry.path,
      webdavLastModified: match.entry.lastModified,
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
  const done = scannedCount + failedCount + missingCount + ambiguousCount
  if (done >= totalTracks) {
    metadataScanState.set({
      status: "complete",
      progress: { scanned: scannedCount, total: totalTracks, failed: failedCount, missing: missingCount, duplicateMatches: ambiguousCount },
    })
  } else {
    metadataScanState.set({
      status: "scanning",
      progress: { scanned: done, total: totalTracks, failed: failedCount, missing: missingCount, duplicateMatches: ambiguousCount },
    })
  }
}

export async function scanAllForceRescan(): Promise<void> {
  cancelled = true
  const myGen = ++scanGen
  queue = []
  scannedCount = 0
  failedCount = 0
  missingCount = 0
  ambiguousCount = 0
  totalTracks = 0

  if (!webdavUrl || !webdavUser || !webdavToken) return
  if (scanGen !== myGen) return

  metadataScanState.set({ status: "scanning", progress: { scanned: 0, total: 0, failed: 0, missing: 0, duplicateMatches: 0 } })

  try {
    await rebuildIndex()
  } catch {
    if (scanGen !== myGen) return
    metadataScanState.set({
      status: "error",
      progress: { scanned: 0, total: 0, failed: 0, missing: 0, duplicateMatches: 0 },
      error: "Index refresh failed — is the WebDAV server reachable?",
    })
    return
  }

  const tracks = get(library)
  for (const t of tracks) queue.push({ trackId: t.trackId })

  totalTracks = queue.length
  if (scanGen !== myGen) return
  cancelled = false

  if (totalTracks === 0) {
    metadataScanState.set({
      status: "complete",
      progress: { scanned: 0, total: 0, failed: 0, missing: 0, duplicateMatches: 0 },
      error: tracks.length === 0 ? "No library loaded — connect Navidrome first" : undefined,
    })
    return
  }

  metadataScanState.set({
    status: "scanning",
    progress: { scanned: 0, total: totalTracks, failed: 0, missing: 0, duplicateMatches: 0 },
  })

  drain()
}

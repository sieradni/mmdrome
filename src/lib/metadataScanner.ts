import { get } from "svelte/store"
import { library, metadataCache, metadataScanState, settings, updateMetadata } from "../stores/appState"
import type { Track } from "../stores/appState"
import { saveWebdavFileIndex, getWebdavFileIndex } from "./db"
import type { LocalMetadataStore } from "./db"
import {
  buildWebdavFileIndex,
  matchTrackToWebdav,
  readFileMetadata,
  buildPathTimestamps,
  findChangedTracks,
  computeIndexFingerprint,
} from "./metadataReader"
import type { WebdavFileEntry } from "./db"

const CONCURRENCY = 6

/** Which rows a scan run processes — 'modified' diffs on mtime/fingerprint,
 *  'force' re-reads every library track against a fresh index. */
export type ScanShape = "modified" | "force"

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

let scannedCount = 0
let failedCount = 0
let missingCount = 0
let ambiguousCount = 0
let totalTracks = 0
let shape: ScanShape = "modified"
let activeAnnotation = ""

function annotationFor(s: ScanShape): string {
  return s === "force" ? "Scanning all files..." : "Scanning changed files..."
}

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
    await saveWebdavFileIndex({ entries: index, buildTimestamp: Date.now(), lastScan: serverLastScan, baseKey: indexBaseKey, fingerprint: computeIndexFingerprint(index) })
    return true
  } catch {
    return false
  }
}

export async function rebuildIndex(): Promise<void> {
  if (!webdavUrl || !webdavUser || !webdavToken) {
    throw new Error("WebDAV credentials not configured")
  }

  index = await buildWebdavFileIndex(webdavUrl, webdavUser, webdavToken)
  indexBaseKey = currentIndexKey()
  indexBuilt = true
  await saveWebdavFileIndex({ entries: index, buildTimestamp: Date.now(), lastScan: serverLastScan, baseKey: indexBaseKey, fingerprint: computeIndexFingerprint(index) })
}

/**
 * Runs a WebDAV metadata scan against the currently-configured credentials.
 *
 * 'modified' — the incremental path ("Check Modified Ratings" / post-connect
 * auto-scan): always probes the server (a stale snapshot can never detect
 * remote edits), diffs rows by mtime, and only re-fetches changed files; rows
 * that never matched are only retried when the server file set changed
 * (fingerprint). 'force' — "Rescan All Metadata": rebuilds the index and
 * re-reads every library track regardless of mtime.
 *
 * Both abort into status 'error' when the probe fails and share the same
 * drain/process pipeline; the progress record carries `annotation` describing
 * which shape is running for the status line.
 */
export async function scanAll(shape_: ScanShape = "modified"): Promise<void> {
  cancelled = true
  const myGen = ++scanGen
  queue = []
  scannedCount = 0
  failedCount = 0
  missingCount = 0
  ambiguousCount = 0
  totalTracks = 0
  shape = shape_
  activeAnnotation = annotationFor(shape)

  // Creds check AFTER the gen guard: a creds-less second call must not stomp
  // the scanning state of a newer in-flight scan. With no await between the
  // guard and the state set below, this error write is gen-safe by ordering.
  if (scanGen !== myGen) return
  if (!webdavUrl || !webdavUser || !webdavToken) {
    metadataScanState.set({
      status: "error",
      progress: { scanned: 0, total: 0, failed: 0, missing: 0, duplicateMatches: 0, annotation: activeAnnotation },
      error: "WebDAV credentials not configured",
    })
    return
  }

  metadataScanState.set({ status: "scanning", progress: { scanned: 0, total: 0, failed: 0, missing: 0, duplicateMatches: 0, annotation: activeAnnotation } })

  if (shape === "force") {
    try {
      await rebuildIndex()
    } catch {
      if (scanGen !== myGen) return
      metadataScanState.set({
        status: "error",
        progress: { scanned: 0, total: 0, failed: 0, missing: 0, duplicateMatches: 0, annotation: activeAnnotation },
        error: "Index refresh failed — is the WebDAV server reachable?",
      })
      return
    }
  } else {
    // Fingerprint of the index stored by the LAST probe. Read before the probe
    // below — refreshIndex overwrites the stored snapshot with the fresh one.
    const priorSnapshot = await getWebdavFileIndex()

    // Always probe the server: the whole point of "Check Modified Ratings" is
    // freshness. A stale snapshot can never detect remote edits; abort loudly
    // on probe failure instead of scanning against one.
    const ok = await refreshIndex()
    if (!ok) {
      if (scanGen !== myGen) return
      metadataScanState.set({
        status: "error",
        progress: { scanned: 0, total: 0, failed: 0, missing: 0, duplicateMatches: 0, annotation: activeAnnotation },
        error: "Index refresh failed — is the WebDAV server reachable?",
      })
      return
    }
    if (index.length === 0) {
      metadataScanState.set({ status: "complete", progress: { scanned: 0, total: 0, failed: 0, missing: 0, duplicateMatches: 0, annotation: activeAnnotation } })
      return
    }

    const tracks = get(library)
    const cache = get(metadataCache)

    const timestamps = buildPathTimestamps(index)
    const { changed, unmatched } = findChangedTracks(tracks, cache, index, timestamps)

    for (const t of changed) queue.push({ trackId: t.trackId })

    // The server file set is identical to the last probe (fingerprint match):
    // rows that were never matched cannot have become matchable (no added/
    // renamed/resized file to match against), so retrying them would only burn
    // CPU. Matched rows still re-diff on their mtime above. A missing stored
    // fingerprint (first scan after the upgrade) treats the set as changed.
    const setUnchanged = priorSnapshot?.fingerprint !== undefined
      && computeIndexFingerprint(index) === priorSnapshot.fingerprint
    if (!setUnchanged) {
      for (const t of unmatched) queue.push({ trackId: t.trackId })
    }
  }

  const tracks = get(library)
  if (shape === "force") {
    for (const t of tracks) queue.push({ trackId: t.trackId })
  }

  totalTracks = queue.length
  if (scanGen !== myGen) return
  cancelled = false

  if (totalTracks === 0) {
    // Nothing to read. Without this short-circuit the drain loop never runs
    // updateScanProgress, leaving the UI stuck at 0/0 "scanning" forever.
    metadataScanState.set({
      status: "complete",
      progress: { scanned: 0, total: 0, failed: 0, missing: 0, duplicateMatches: 0, annotation: activeAnnotation },
      error: tracks.length === 0 ? "No library loaded — connect Navidrome first" : undefined,
    })
    return
  }

  metadataScanState.set({
    status: "scanning",
    progress: { scanned: 0, total: totalTracks, failed: 0, missing: 0, duplicateMatches: 0, annotation: activeAnnotation },
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

    // Navidrome mode: the server is authoritative for rating/loved, and the
    // file tag may be stale (or edited server-side since it was last read) —
    // never clobber the cached values with tag values. Keep refreshing the
    // path/stamps so Push targeting stays accurate.
    const navidromeAuthoritative = existing && get(settings).ratingSource === 'navidrome'
    updateMetadata({
      trackId: track.trackId,
      rating: navidromeAuthoritative ? existing.rating : meta.rating,
      loved: navidromeAuthoritative ? existing.loved : meta.loved,
      fileType: track.fileType,
      syncStatus: "synced",
      lastModifiedLocally: Date.now(),
      webdavPath: match.entry.path,
      webdavLastModified: match.entry.lastModified,
      webdavBase: currentIndexKey(),
      comments: navidromeAuthoritative ? existing.comments : meta.comments,
    })
    scannedCount++
  } catch {
    if (scanGen === startedGen) failedCount++
  }
  if (scanGen === startedGen) updateScanProgress()
}

function updateScanProgress(): void {
  const done = scannedCount + failedCount + missingCount + ambiguousCount
  const progress = {
    scanned: scannedCount,
    total: totalTracks,
    failed: failedCount,
    missing: missingCount,
    duplicateMatches: ambiguousCount,
    annotation: activeAnnotation,
  }
  if (done >= totalTracks) {
    metadataScanState.set({ status: "complete", progress })
  } else {
    metadataScanState.set({ status: "scanning", progress })
  }
}
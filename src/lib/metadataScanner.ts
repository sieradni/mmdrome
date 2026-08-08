import { get } from "svelte/store"
import { library, metadataCache, metadataScanState, settings, updateMetadata } from "../stores/appState"
import type { Track } from "../stores/appState"
import { saveWebdavFileIndex, getWebdavFileIndex } from "./db"
import type { LocalMetadataStore } from "./db"
import {
  buildWebdavFileIndex,
  matchTrackToWebdav,
  matchTrackToWebdavCandidates,
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
  if (existing && (existing.syncStatus === 'pending_sync' || existing.ignored)) {
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
        webdavPath: undefined,
        webdavLastModified: undefined,
        webdavBase: undefined,
        matchSource: undefined,
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
    if (current && (current.syncStatus === 'pending_sync' || current.ignored)) {
      scannedCount++
      updateScanProgress()
      return
    }

    // Issue-1 guard: a manual binding (File Matching UI) is authoritative —
    // the user may have picked a file the auto-matcher would NOT have chosen
    // (WebDAV layout can differ entirely from Navidrome's). Never overwrite
    // that path with the auto-match; refresh the stamps of the BOUND file so
    // mtime detection keeps working.
    const manualBind = current?.matchSource === 'manual'
      && current?.webdavPath != null
      && index.some((i) => i.path === current?.webdavPath)
    const boundEntry = manualBind ? index.find((i) => i.path === current?.webdavPath) : undefined

    // Navidrome mode: the server is authoritative for rating/loved, and the
    // file tag may be stale (or edited server-side since it was last read) —
    // never clobber the cached values with tag values. Keep refreshing the
    // path/stamps so Push targeting stays accurate.
    const navidromeAuthoritative = current != null
      && get(settings).ratingSource === 'navidrome'
      && !manualBind
    updateMetadata({
      trackId: track.trackId,
      rating: navidromeAuthoritative ? current.rating : meta.rating,
      loved: navidromeAuthoritative ? current.loved : meta.loved,
      fileType: track.fileType,
      syncStatus: "synced",
      lastModifiedLocally: Date.now(),
      webdavPath: manualBind ? current.webdavPath : match.entry.path,
      webdavLastModified: manualBind
        ? (boundEntry?.lastModified ?? current?.webdavLastModified)
        : match.entry.lastModified,
      webdavBase: currentIndexKey(),
      comments: navidromeAuthoritative ? current?.comments : meta.comments,
      matchSource: manualBind ? current?.matchSource : undefined,
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

// ── File Matching (manual binding UI) ────────────────────────────────────

export type UnresolvedKind = 'no-match' | 'ambiguous' | 'vanished' | 'stale-base' | 'ignored' | 'matched'

export interface UnresolvedTrack {
  trackId: string
  kind: UnresolvedKind
  title: string
  artist: string
  album: string
  fileType: Track['fileType']
  size?: number
  webdavPath?: string
  matchSource?: 'auto' | 'manual'
  pendingPush: boolean
  candidates: WebdavFileEntry[]
}

/**
 * Result of listing unresolved matches. Rows are capped at DISPLAY_CAP
 * (pending-push first); `counts`/`pendingBlocked` cover the whole library.
 */
export interface UnresolvedMatch {
  /** At most DISPLAY_CAP rows (pending-push first) — counts are exact. */
  rows: UnresolvedTrack[]
  /** Exact per-kind counts over the whole library (cheap — no scoring). */
  counts: Record<UnresolvedKind, number>
  /** Exact count of unresolved rows carrying a pending edit (blocks Push). */
  pendingBlocked: number
}

const DISPLAY_CAP = 100

/**
 * All library tracks the scanner cannot confidently target (and rows whose
 * push would be skipped): no match found, ambiguous tie, previously-matched
 * file vanished from a fresh index, or a stale `webdavBase` (server switched)
 * plus the audit buckets: manual/auto `matched` rows and user-dismissed
 * `ignored` rows (their pending-ness is reported truthfully). Unresolved
 * counts are exact over the whole library; candidate computation is only
 * done for the rows actually displayed.
 *
 * Pending-push rows sort first: those block Push Changes, which is the point.
 * Uses the in-memory index when built this session (no extra PROPFIND);
 * otherwise probes the server once.
 */
export async function listUnresolvedMatches(): Promise<UnresolvedMatch> {
  if (!webdavUrl || !webdavUser || !webdavToken) return {
    rows: [],
    counts: { 'no-match': 0, ambiguous: 0, vanished: 0, 'stale-base': 0, ignored: 0, matched: 0 },
    pendingBlocked: 0,
  }
  if (!indexBuilt) {
    const ok = await refreshIndex()
    if (!ok) throw new Error("Index refresh failed — is the WebDAV server reachable?")
  }

  const baseKey = currentIndexKey()
  const indexPaths = new Set(index.map((i) => i.path))
  const tracks = get(library)
  const cache = get(metadataCache)
  const rows: UnresolvedTrack[] = []
  const counts: Record<UnresolvedKind, number> = {
    'no-match': 0, ambiguous: 0, 'vanished': 0, 'stale-base': 0, ignored: 0, matched: 0,
  }
  let pendingBlocked = 0

  for (const t of tracks) {
    const meta = cache.get(t.trackId)
    const base = {
      trackId: t.trackId,
      title: t.title,
      artist: t.artist,
      album: t.album,
      fileType: t.fileType,
      size: t.size,
      pendingPush: meta?.syncStatus === 'pending_sync',
    }

    let row: UnresolvedTrack
    if (meta?.ignored) {
      // Deliberately dismissed — no re-matching, but pending-ness must be
      // truthful so the UI can say "edit exists, can't be pushed".
      counts.ignored++
      if (base.pendingPush) pendingBlocked++
      row = { ...base, kind: 'ignored', candidates: [] }
    } else if (meta?.webdavPath) {
      if (!indexPaths.has(meta.webdavPath)) {
        counts.vanished++
        row = { ...base, kind: 'vanished', webdavPath: meta.webdavPath, candidates: [] }
      } else if (meta.webdavBase !== baseKey) {
        counts['stale-base']++
        if (base.pendingPush) pendingBlocked++
        row = { ...base, kind: 'stale-base', webdavPath: meta.webdavPath, candidates: [] }
      } else {
        // Correctly bound (auto or manual) — the "resolved" bucket. Listed
        // so the user can audit a match and Clear it when it picked wrong.
        counts.matched++
        row = {
          ...base,
          kind: 'matched',
          webdavPath: meta.webdavPath,
          matchSource: meta.matchSource ?? 'auto',
          candidates: [],
        }
      }
    } else {
      const match = matchTrackToWebdavCandidates(t, index)
      counts[match.status === 'ambiguous' ? 'ambiguous' : 'no-match']++
      if (base.pendingPush) pendingBlocked++
      row = {
        ...base,
        kind: match.status === 'ambiguous' ? 'ambiguous' : 'no-match',
        candidates: match.promptCandidates,
      }
    }
    if (rows.length < DISPLAY_CAP) rows.push(row)
  }

  rows.sort((a, b) => {
    if (a.pendingPush !== b.pendingPush) return a.pendingPush ? -1 : 1
    return a.title.localeCompare(b.title)
  })
  return { rows, counts, pendingBlocked }
}

/** Path/filename substring search over the in-memory index (extension-filtered). */
export function searchWebdavFiles(query: string, fileType: string): WebdavFileEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const matches = index.filter(
    (e) => e.filename.toLowerCase().endsWith(`.${fileType}`)
      && (e.path.toLowerCase().includes(q) || e.filename.toLowerCase().includes(q)),
  )
  matches.sort((a, b) => a.path.localeCompare(b.path))
  return matches.slice(0, 50)
}

export type BindResult =
  | { ok: true }
  | { ok: false; reason: 'not-in-index' | 'no-row' | 'conflict' | 'conflict-pending'; conflictTrackId?: string; conflictTitle?: string }

/**
 * Binds a track to a WebDAV file (manual resolution). Validates the path
 * against the current in-memory index (stale picks rejected), guards against
 * double-bindings, and stamps `webdavBase` so Push can target the row. The
 * row's `syncStatus` is preserved: a pending edit becomes pushable.
 *
 * `force` (the "Bind anyway" path) is not a blind override: it only succeeds
 * when it can LEAVE that promise true — "the other track becomes unmatched".
 * Rows already targeted the same file are unbound (`conflict` when any of
 * them has a pending edit — unbinding would strand that edit in limbo).
 */
export async function bindTrackToFile(
  trackId: string,
  path: string,
  force = false,
): Promise<BindResult> {
  if (!webdavUrl || !webdavUser || !webdavToken) return { ok: false, reason: 'no-row' }
  if (!indexBuilt) {
    const ok = await refreshIndex()
    if (!ok) return { ok: false, reason: 'not-in-index' }
  }

  const entry = index.find((e) => e.path === path)
  if (!entry) return { ok: false, reason: 'not-in-index' }

  const cache = get(metadataCache)
  const existing = cache.get(trackId)
  if (!existing) {
    // Never scanned yet — create the row so the binding is durable.
    const t = get(library).find((x) => x.trackId === trackId)
    if (!t) return { ok: false, reason: 'no-row' }
    updateMetadata({
      trackId,
      rating: 0,
      loved: false,
      fileType: t.fileType,
      syncStatus: 'synced',
      lastModifiedLocally: Date.now(),
      webdavPath: entry.path,
      webdavLastModified: entry.lastModified,
      webdavBase: currentIndexKey(),
      matchSource: 'manual',
    })
    return { ok: true }
  }

  const hostile = Array.from(cache.entries()).filter(
    ([id, row]) => id !== trackId && row.webdavPath === path,
  )
  if (hostile.length > 0) {
    const [firstId] = hostile[0]
    const other = get(library).find((t) => t.trackId === firstId)
    const conflictTitle = other ? `${other.title} — ${other.artist}` : firstId

    if (!force) {
      return { ok: false, reason: 'conflict', conflictTrackId: firstId, conflictTitle }
    }

    // Force only promises to un-bind the OTHER row if that's safe: a pending
    // edit on it would sit orphaned (no path, Push skips it, scans skip it)
    // — refuse instead of lying in the modal.
    const pendingH = hostile.find(([, row]) => row.syncStatus === 'pending_sync')
    if (pendingH) {
      const [pid] = pendingH
      const pOther = get(library).find((t) => t.trackId === pid)
      return {
        ok: false,
        reason: 'conflict-pending',
        conflictTrackId: pid,
        conflictTitle: pOther ? `${pOther.title} — ${pOther.artist}` : pid,
      }
    }
    for (const [id, row] of hostile) {
      updateMetadata({
        ...row,
        webdavPath: undefined,
        webdavLastModified: undefined,
        webdavBase: undefined,
        matchSource: undefined,
      })
    }
  }

  updateMetadata({
    ...existing,
    webdavPath: entry.path,
    webdavLastModified: entry.lastModified,
    webdavBase: currentIndexKey(),
    matchSource: 'manual',
  })
  return { ok: true }
}

/** Reverts a manual binding (or any path) to an unmatched row. */
export async function unbindTrack(trackId: string): Promise<void> {
  const existing = get(metadataCache).get(trackId)
  if (!existing) return
  updateMetadata({
    ...existing,
    webdavPath: undefined,
    webdavLastModified: undefined,
    webdavBase: undefined,
    matchSource: undefined,
  })
}

export async function ignoreTrack(trackId: string): Promise<void> {
  const existing = get(metadataCache).get(trackId)
  if (!existing) return
  updateMetadata({ ...existing, ignored: true })
}

export async function unignoreTrack(trackId: string): Promise<void> {
  const existing = get(metadataCache).get(trackId)
  if (!existing) return
  updateMetadata({ ...existing, ignored: false })
}
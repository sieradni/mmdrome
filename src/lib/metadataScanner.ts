import { get } from "svelte/store"
import { writable } from "svelte/store"
import { library, metadataCache, metadataScanState, settings, updateMetadata } from "../stores/appState"
import type { Track } from "../stores/appState"
import { saveWebdavFileIndex, getWebdavFileIndex, getFileTagsForBase, putFileTag } from "./db"
import type { LocalMetadataStore, FileTagCacheEntry, FileTags } from "./db"
import {
  buildWebdavFileIndex,
  matchTrackToWebdav,
  matchTrackToWebdavCandidates,
  readFileMetadata,
  buildPathTimestamps,
  findChangedTracks,
  computeIndexFingerprint,
  isAudioFilePath,
  verifyEntryAgainstTrack,
} from "./metadataReader"
import { filenameHintsTitle, normalizeForHint } from "./matchNormalize"
import type { FileMetadata } from "./metadataReader"
import type { WebdavFileEntry } from "./db"

const CONCURRENCY = 6

/** Failure strings lead with the source so a post-connect WebDAV scan error
 *  can never be misread as the Navidrome connection failing. */
const INDEX_REFRESH_FAILED = "WebDAV index refresh failed — is the WebDAV server reachable?"
const CREDENTIALS_MISSING = "WebDAV credentials not configured"

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
/** Paths claimed by in-flight items of the CURRENT scan run. JS runs to
 *  completion between awaits, so check-then-add here is atomic w.r.t. other
 *  concurrent items — the guard a cache snapshot alone can't provide: two
 *  duplicate tracks processed concurrently both read the cache before either
 *  bind lands and would double-bind the same file. */
let claimedInScan = new Set<string>()
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
  // Trim the URL/user so the baseKey and every derived URL stay stable even if
  // legacy persisted settings carry stray whitespace (the Settings form writes
  // through on every keystroke, but old rows may not have been normalized).
  const davUrl = url.trim()
  const davUser = user.trim()
  if (`${davUrl}|${davUser}` !== indexBaseKey) {
    // The index (in-memory or cached) belongs to a different server/user —
    // never reuse it against the new credentials.
    index = []
    indexBuilt = false
    indexBaseKey = ""
  }
  if (`${davUrl}|${davUser}` !== tagCacheBaseKey) {
    tagCache = new Map()
    tagCacheLoaded = false
    tagCacheBaseKey = ""
  }
  // Credentials changed mid-scan: in-flight processItems must abort at their
  // next `scanGen` guard, or the cleared (empty) index above would send them
  // down the vanished-clear branch against an EMPTY index and mass-clear
  // every binding. The `cancelled` flag stops the drain loop from
  // re-dispatching the rest of the old run's queue. The aborted items never
  // increment counters — surface the cancellation as an error state so the
  // status line can't sit at "Scanning X/Y" forever (only when a scan is
  // actually badged as running; idle/complete/error are left alone).
  cancelled = true
  scanGen++
  if (get(metadataScanState).status === 'scanning') {
    metadataScanState.set({
      status: 'error',
      progress: { scanned: 0, total: 0, failed: 0, missing: 0, duplicateMatches: 0, annotation: activeAnnotation },
      error: 'WebDAV credentials changed — scan cancelled',
    })
  }
  // Cancel any running tag probe too — results must never be fetched under
  // one server and cached under another.
  tagProbeGen++
  webdavUrl = davUrl
  webdavUser = davUser
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
    // Capture the base key BEFORE the probe: a mid-probe credential swap must
    // not stamp an index built under the OLD server with the NEW baseKey (the
    // stamped key lands both in-memory AND in the persisted Dexie snapshot).
    const baseKey = currentIndexKey()
    index = await buildWebdavFileIndex(webdavUrl, webdavUser, webdavToken)
    indexBaseKey = baseKey
    indexBuilt = true
    await applyCachedTags()
    await saveWebdavFileIndex({ entries: index, buildTimestamp: Date.now(), lastScan: serverLastScan, baseKey, fingerprint: computeIndexFingerprint(index) })
    return true
  } catch {
    return false
  }
}

export async function rebuildIndex(): Promise<void> {
  if (!webdavUrl || !webdavUser || !webdavToken) {
    throw new Error(CREDENTIALS_MISSING)
  }

  // Capture the base key BEFORE the probe — see refreshIndex.
  const baseKey = currentIndexKey()
  index = await buildWebdavFileIndex(webdavUrl, webdavUser, webdavToken)
  indexBaseKey = baseKey
  indexBuilt = true
  await applyCachedTags()
  await saveWebdavFileIndex({ entries: index, buildTimestamp: Date.now(), lastScan: serverLastScan, baseKey, fingerprint: computeIndexFingerprint(index) })
}

// ── In-file identity tags (content probing) ─────────────────────────────

export interface TagProbeState {
  active: boolean
  done: number
  /** Files in the current candidate pool not yet probed. */
  remaining: number
}

export const tagProbeState = writable<TagProbeState>({ active: false, done: 0, remaining: 0 })

const TAG_PROBE_CONCURRENCY = 4
const TAG_PROBE_RETRY_MS = 800

/** `baseUrl|user` the in-memory tag cache belongs to. */
let tagCacheBaseKey = ""
let tagCache = new Map<string, FileTagCacheEntry>()
let tagCacheLoaded = false
let tagProbeActive = false
let tagProbeGen = 0

function fileTagId(baseKey: string, path: string): string {
  return `${baseKey}\u0000${path}`
}

function fileTypeOf(filename: string): string {
  const dot = filename.lastIndexOf(".")
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : "mp3"
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Load cached probe results for the current server into a path-keyed map. */
async function loadTagCache(): Promise<void> {
  const key = currentIndexKey()
  if (tagCacheBaseKey === key && tagCacheLoaded) return
  const entries = await getFileTagsForBase(key)
  tagCache = new Map(entries.map((e) => [e.path, e]))
  tagCacheBaseKey = key
  tagCacheLoaded = true
}

/** Stamp `entry.tags` from the cache when size matches (a size change means
 *  the file was rewritten — the cached identity is stale). Unknown/poisoned
 *  entries keep their index entry tag-less so scoring falls back to names. */
async function applyCachedTags(): Promise<void> {
  await loadTagCache()
  for (const e of index) {
    const cached = tagCache.get(e.path)
    if (cached && cached.size === e.size && cached.status === 'ok' && cached.tags) {
      e.tags = cached.tags
    }
  }
}

/**
 * Content-probes UNCLAIMED audio files so matching can use real in-file
 * identity (title/artist/album) instead of only filenames.
 *
 * Selection: only files that plausibly resolve some unclaimed track — a size
 * hint (same byte size as an unclaimed track) or a filename/title hint. This
 * deliberately never sweeps the entire server: orphan file forests without
 * any hinted candidate are left alone (they cost probe bytes but match
 * nothing). Probed results are cached per `baseKey|path` + size in Dexie and
 * attached to the in-memory index for scoring; failures are cached as
 * poisoned so they are never retried until the file's size changes.
 *
 * Pauses (waits) while a scan is draining so the two never compete for the
 * connection; a new call (gen bump) cancels a running pass.
 */
export async function ensureTagProbe(): Promise<void> {
  if (!webdavUrl || !webdavUser || !webdavToken) return
  if (tagProbeActive) return
  if (!indexBuilt) {
    const ok = await refreshIndex()
    if (!ok) return
  }
  const mutex = ++tagProbeGen
  tagProbeActive = true
  tagProbeState.set({ active: true, done: 0, remaining: 0 })
  try {
    await runTagProbe(mutex)
  } finally {
    // Unconditional: a credential swap bumps tagProbeGen mid-pass to cancel
    // the run — the busy flag must still clear or every future probe no-ops.
    tagProbeActive = false
    tagProbeState.set({ active: false, done: 0, remaining: 0 })
  }
}

async function runTagProbe(gen: number): Promise<void> {
  await loadTagCache()
  const cache = get(metadataCache)

  // Unclaimed tracks (no staged auto target) give the hint sets.
  const unclaimedSizes = new Set<number>()
  const unclaimedTitles = new Set<string>()
  const tracks = get(library)
  for (const t of tracks) {
    const row = cache.get(t.trackId)
    if (row?.webdavPath || row?.ignored) continue
    if (t.size) unclaimedSizes.add(t.size)
    if (t.title) unclaimedTitles.add(normalizeForHint(t.title))
  }

  const pool: WebdavFileEntry[] = []
  const claimedPaths = new Set<string>()
  for (const row of cache.values()) {
    if (row.webdavPath) claimedPaths.add(row.webdavPath)
  }
  for (const entry of index) {
    if (claimedPaths.has(entry.path)) continue
    if (!isAudioFilePath(entry.filename)) continue
    const cached = tagCache.get(entry.path)
    if (cached && cached.size === entry.size) continue // fresh: ok/empty/unreadable
    pool.push(entry)
  }

  if (pool.length === 0) return

  // Hint ordering: byte-size suggestions first (strong), then filename hints,
  // then the rest. This is the "never sweep the server" guard — files with no
  // hint at all are skipped entirely.
  const rank = new Map<string, number>()
  for (const e of pool) {
    let r = 0
    if (e.size && unclaimedSizes.has(e.size)) r = 2
    else if (filenameHintsTitle(e.filename, unclaimedTitles)) r = 1
    if (r === 0) continue
    rank.set(e.path, r)
  }
  const hinted = pool.filter((e) => rank.has(e.path))
  hinted.sort((a, b) => (rank.get(b.path) ?? 0) - (rank.get(a.path) ?? 0) || a.path.localeCompare(b.path))

  const baseKey = currentIndexKey()
  let done = 0

  for (let i = 0; i < hinted.length; i += TAG_PROBE_CONCURRENCY) {
    // Coalesce behind any running scan: probe batches wait for the scan
    // queue to drain instead of competing for the same connection.
    if (tagProbeGen !== gen) return
    while (queue.length > 0 || activeCount > 0) {
      await sleep(TAG_PROBE_RETRY_MS)
      if (tagProbeGen !== gen) return
    }
    const batch = hinted.slice(i, i + TAG_PROBE_CONCURRENCY)
    await Promise.all(batch.map(async (entry) => {
      if (tagProbeGen !== gen) return
      const id = fileTagId(baseKey, entry.path)
      try {
        const meta = await readFileMetadata(
          webdavUrl, entry.path, webdavUser, webdavToken, fileTypeOf(entry.filename),
        )
        if (tagProbeGen !== gen) return
        const hasIdentity = !!(meta.title || meta.artist || meta.album)
        const next: FileTagCacheEntry = {
          id,
          baseKey,
          path: entry.path,
          size: entry.size,
          tags: hasIdentity ? { title: meta.title, artist: meta.artist, album: meta.album, trackNumber: meta.trackNumber } : undefined,
          status: hasIdentity ? 'ok' : 'empty',
          probedAt: Date.now(),
        }
        await putFileTag(next)
        tagCache.set(entry.path, next)
        if (hasIdentity) entry.tags = next.tags
      } catch {
        if (tagProbeGen !== gen) return
        const next: FileTagCacheEntry = {
          id, baseKey, path: entry.path, size: entry.size,
          status: 'unreadable', probedAt: Date.now(),
        }
        await putFileTag(next)
        tagCache.set(entry.path, next)
      }
      done++
      const remaining = Math.max(0, hinted.length - (i + batch.length))
      tagProbeState.set({ active: true, done, remaining })
    }))
  }

  if (tagProbeGen === gen) {
    tagProbeState.set({ active: false, done, remaining: 0 })
  }
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
/** Public entry: runs the scan, then auto-content-probes so that as long as
 *  tracks remain unclaimed, in-file tag identity is harvested in the
 *  background (guarded internally — a no-op while a probe is already active). */
export async function scanAll(shape_: ScanShape = "modified"): Promise<void> {
  await scanAllInternal(shape_)
  void ensureTagProbe()
}

async function scanAllInternal(shape_: ScanShape = "modified"): Promise<void> {
  cancelled = true
  const myGen = ++scanGen
  claimedInScan = new Set<string>()
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
      error: CREDENTIALS_MISSING,
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
        error: INDEX_REFRESH_FAILED,
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
        error: INDEX_REFRESH_FAILED,
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

  // Unverified-binding guard: a row whose `webdavBase` doesn't match the
  // current server (never stamped legacy, or stamped under an older server
  // URL) carries a path that was never proven HERE. Scans must not read the
  // file (the file at that path may be a different file — wrong-file tag
  // propagation), re-stamp it, or re-match it; File Matching flags the row
  // and the user re-verifies (bulk or per-row) or re-links manually. Rows
  // whose path VANISHED are exempt: the vanish-clear below only drops stale
  // stamps while preserving values — legit cleanup, not a write.
  if ((!existing?.webdavBase || existing.webdavBase !== currentIndexKey())
      && existing?.webdavPath != null
      && index.some((i) => i.path === existing.webdavPath)) {
    scannedCount++
    updateScanProgress()
    return
  }

  // Issue-1 guard, checked BEFORE the matcher: a valid manual binding is the
  // user's verdict — never re-match it, and never count it as ambiguous again
  // (a later scan used to re-enter this state machine and bump
  // ambiguousCount forever even though the track was already resolved). But
  // the verdict is about WHICH file backs the track, not about its contents:
  // re-read THE BOUND FILE so MusicBee edits keep flowing into webdav mode
  // and the stamps stay fresh for mtime diffing.
  const manualBind = existing?.matchSource === 'manual'
    && existing?.webdavPath != null
    && index.some((i) => i.path === existing?.webdavPath)
  if (manualBind && existing.webdavPath) {
    const boundPath = existing.webdavPath
    // Reserve the user's pick before the fetch: a concurrent auto item must
    // not grab a path this row already owns (the cache guard sees other rows'
    // paths, but only once the binding exists — during re-reads it does).
    claimedInScan.add(boundPath)
    const myGen = scanGen
    try {
      const boundEntry = index.find((i) => i.path === boundPath)
      const meta = await readFileMetadata(
        webdavUrl, boundPath, webdavUser, webdavToken, track.fileType,
      )
      if (scanGen !== myGen) return

      // The user may have edited rating/loved while the fetch was in flight —
      // don't clobber the newer pending edit with stale file tags.
      const current = get(metadataCache).get(track.trackId)
      if (current && current.syncStatus === 'pending_sync') {
        scannedCount++
        updateScanProgress()
        return
      }

      // Navidrome mode: the server is authoritative — keep cached values,
      // only refresh the path stamps. Webdav mode: propagate the file's tags.
      const navidrome = current != null && get(settings).ratingSource === 'navidrome'
      updateMetadata({
        trackId: track.trackId,
        rating: navidrome ? current.rating : meta.rating,
        loved: navidrome ? current.loved : meta.loved,
        fileType: track.fileType,
        syncStatus: 'synced',
        lastModifiedLocally: Date.now(),
        webdavPath: boundPath,
        webdavLastModified: boundEntry?.lastModified ?? existing.webdavLastModified,
        webdavBase: currentIndexKey(),
        comments: navidrome ? current?.comments : meta.comments,
        matchSource: 'manual',
      })
      scannedCount++
    } catch {
      if (scanGen === myGen) failedCount++
    }
    if (scanGen === myGen) updateScanProgress()
    return
  }

  // Claim guard: one file backs one track. Files already bound to a DIFFERENT
  // row are excluded from this track's scoring so an auto-match can never
  // steal a file (e.g. the same song tagged in two Navidrome entries).
  const excludePaths = new Set<string>()
  for (const [, row] of get(metadataCache)) {
    if (row.webdavPath && row.webdavPath !== existing?.webdavPath) {
      excludePaths.add(row.webdavPath)
    }
  }

  const match = matchTrackToWebdav(track, index, excludePaths)
  if (scanGen !== startedGen) return
  if (match.entry) {
    if (claimedInScan.has(match.entry.path)) {
      // A concurrent sibling item claimed this file first — never double-bind.
      // Count the row scanned (it stays unbound and re-queues on a later run
      // once the claim is gone and the sibling's bind is in the cache).
      scannedCount++
      updateScanProgress()
      return
    }
    claimedInScan.add(match.entry.path)
  }
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
        fileType: track.fileType,
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
      // Not binding after all — release the claim so a sibling (or the next
      // run) can still take the file.
      claimedInScan.delete(match.entry.path)
      scannedCount++
      updateScanProgress()
      return
    }

    // Issue-1 guard: valid manual bindings never reach this point — they are
    // counted as scanned at the top of processItem. Rows here are either
    // unbound or their manual path ISN'T in the index (vanished manual bind),
    // so the auto-match result is authoritative.
    //
    // Navidrome mode: the server is authoritative for rating/loved, and the
    // file tag may be stale (or edited server-side since it was last read) —
    // never clobber the cached values with tag values. Keep refreshing the
    // path/stamps so Push targeting stays accurate.
    const navidromeAuthoritative = current != null
      && get(settings).ratingSource === 'navidrome'
    updateMetadata({
      trackId: track.trackId,
      rating: navidromeAuthoritative ? current.rating : meta.rating,
      loved: navidromeAuthoritative ? current.loved : meta.loved,
      fileType: track.fileType,
      syncStatus: "synced",
      lastModifiedLocally: Date.now(),
      webdavPath: match.entry.path,
      webdavLastModified: match.entry.lastModified,
      webdavBase: currentIndexKey(),
      comments: navidromeAuthoritative ? current?.comments : meta.comments,
      matchSource: undefined,
    })
    scannedCount++
  } catch {
    // The read failed — nothing was bound, so release the claim (a later
    // item in this run, or the next run, may still bind the file).
    if (scanGen === startedGen) {
      claimedInScan.delete(match.entry.path)
      failedCount++
    }
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
 * Result of listing unresolved matches. `rows` carries the full classified
 * list (uncommitted here — the UI applies any display cap it wants); the
 * `counts`/`pendingBlocked` are exact over the whole library.
 */
export interface UnresolvedMatch {
  /** Every classified track (uncommitted — capped client-side). */
  rows: UnresolvedTrack[]
  /** Exact per-kind counts over the whole library (cheap — no scoring). */
  counts: Record<UnresolvedKind, number>


  /** Exact count of unresolved rows carrying a pending edit (blocks Push). */
  pendingBlocked: number
}

export const DISPLAY_CAP = 100

/**
 * All library tracks the scanner cannot confidently target (and rows whose
 * push would be skipped): no match found, ambiguous tie, previously-matched
 * file vanished from a fresh index, or a stale `webdavBase` (server switched)
 * plus the audit buckets: manual/auto `matched` rows and user-dismissed
 * `ignored` rows (their pending-ness is reported truthfully). Counts are
 * exact over the whole library (unbound rows are scored once for the
 * no-match/ambiguous split); the row list is returned in full ranked order —
 * unresolved-with-pending-edit first, then unresolved, then matched/ignored —
 * and is truncated client-side only (DISPLAY_CAP is the UI default).
 * Prompt candidates are computed and retained on every unbound row, never
 * trimmed server-side — the caller decides how many to render.
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
  // Re-stamp cached probe results onto the in-memory index so candidate
  // pickers show file identity (and scoring sees tags) even when this view
  // opened after the index was built.
  await applyCachedTags()

  const baseKey = currentIndexKey()
  const indexPaths = new Set(index.map((i) => i.path))
  // Every bound path across the library — candidates must never include a
  // file another row already targets (an unclaimed file scores once).
  const allBoundPaths = new Set<string>()
  for (const row of get(metadataCache).values()) {
    if (row.webdavPath) allBoundPaths.add(row.webdavPath)
  }
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
        // Vanished + pending is equally un-pushable (GET 404s -> skipped).
        if (base.pendingPush) pendingBlocked++
        row = { ...base, kind: 'vanished', webdavPath: meta.webdavPath, candidates: [] }
      } else if (meta.webdavBase !== baseKey) {
        counts['stale-base']++
        if (base.pendingPush) pendingBlocked++
        // Suggest candidates for the row's own prompts: the current stamp is
        // unverified (it may target a wrong file), so the user should be able
        // to immediately re-pick. ALL bound paths are excluded — including the
        // row's own — so a sibling-shared wrong file is never suggested.
        const match = matchTrackToWebdavCandidates(t, index, allBoundPaths)
        row = {
          ...base,
          kind: 'stale-base',
          webdavPath: meta.webdavPath,
          candidates: match.promptCandidates.slice(0, 3),
        }
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
      // Exact no-match/ambiguous split requires scoring every unbound track —
      // there is no cheap classification for "would this tie". The scoring
      // pass is the same work an incremental scan does, and only runs when
      // this view is open/refreshed. Prompt candidates are computed for
      // every unbound row (rows bound to other tracks are excluded so an
      // unclaimed file never scores twice).
      const match = matchTrackToWebdavCandidates(t, index, allBoundPaths)
      counts[match.status === 'ambiguous' ? 'ambiguous' : 'no-match']++
      if (base.pendingPush) pendingBlocked++
      row = {
        ...base,
        kind: match.status === 'ambiguous' ? 'ambiguous' : 'no-match',
        candidates: match.promptCandidates,
      }
    }
    rows.push(row)
  }

  // Rank first so the CAP picks the rows that matter: unresolved with a
  // pending edit (blocked), then unresolved, then resolved audit buckets.
  rows.sort((a, b) => {
    const rankOf = (r: UnresolvedTrack): number =>
      r.kind === 'matched' || r.kind === 'ignored' ? 2 : (r.pendingPush ? 0 : 1)
    const d = rankOf(a) - rankOf(b)
    if (d !== 0) return d
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
  | { ok: false; reason: 'not-in-index' | 'no-row' | 'no-creds' | 'conflict' | 'conflict-pending'; conflictTrackId?: string; conflictTitle?: string }

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
  if (!webdavUrl || !webdavUser || !webdavToken) return { ok: false, reason: 'no-creds' }
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

// ── Re-verify (existing binding audit after a server switch) ─────────────

export type ReverifyVerdict = 'verified' | 'conflict' | 'unknown'

interface ReverifyRowResult {
  verdict: ReverifyVerdict
  /** The file's tag title (for the conflict refusal message). */
  fileTitle: string | undefined
  /** Everything read from the file — the verified branch re-uses the fetch
   *  to also pull the file's rating/loved/comments (see the import below). */
  meta: FileMetadata | undefined
}

/** One verdict read per bound file: fetch its tags and judge them against
 *  the track with `verifyEntryAgainstTrack` (the single comparison source).
 *  Read failures and untagged files both land on 'unknown'. */
async function reverifyRow(track: Track, entry: WebdavFileEntry): Promise<ReverifyRowResult> {
  try {
    const meta = await readFileMetadata(webdavUrl, entry.path, webdavUser, webdavToken, track.fileType)
    if (!meta.title) return { verdict: 'unknown', fileTitle: undefined, meta }
    return {
      verdict: verifyEntryAgainstTrack(track, { ...entry, tags: {
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        trackNumber: meta.trackNumber,
      } }),
      fileTitle: meta.title,
      meta,
    }
  } catch {
    return { verdict: 'unknown', fileTitle: undefined, meta: undefined }
  }
}

/** The verified branch of both re-verify flows: write the stamps, and — in
 *  webdav rating mode, when the row is not mid-edit — ALSO import the file's
 *  rating/loved/comments, exactly like the scanner's re-read path. Without
 *  this, rows bound (and polluted) under an old server keep the WRONG file's
 *  rating forever: the stamps become current, the mtime diff then says
 *  "unchanged", and incremental scans never re-read the now-verified file. */
function writeReverified(current: LocalMetadataStore, meta: FileMetadata | undefined, entry: WebdavFileEntry, baseKey: string): void {
  if (meta && current.syncStatus !== 'pending_sync' && get(settings).ratingSource === 'webdav') {
    updateMetadata({
      ...current,
      rating: meta.rating,
      loved: meta.loved,
      comments: meta.comments,
      webdavPath: entry.path,
      webdavLastModified: entry.lastModified ?? current.webdavLastModified,
      webdavBase: baseKey,
    })
    return
  }
  updateMetadata({
    ...current,
    webdavPath: entry.path,
    webdavLastModified: entry.lastModified ?? current.webdavLastModified,
    webdavBase: baseKey,
  })
}

export interface ReverifyResult {
  verified: number
  conflict: number
  unknown: number
}

/** Bulk, user-triggered audit of every stale-base row ("Re-verify file
 *  links"): re-judges each existing binding against its bound file on the
 *  CURRENT server. Verified rows are re-stamped (rating/loved/syncStatus/
 *  matchSource preserved — pending edits become pushable) and pull the
 *  file's tags when a row is present; conflict/unknown rows are left
 *  flagged and counted for the result line. Never clears a binding. This is
 *  the ONLY path that touches stale rows — scans skip them (see
 *  processItem) — and it is strictly user-initiated: automatic paths never
 *  write unverified bindings. */
export async function reverifyStaleLinks(): Promise<ReverifyResult> {
  const result: ReverifyResult = { verified: 0, conflict: 0, unknown: 0 }
  if (!webdavUrl || !webdavUser || !webdavToken) {
    throw new Error("WebDAV credentials not configured")
  }
  if (!indexBuilt) {
    const ok = await refreshIndex()
    if (!ok) throw new Error("Index refresh failed — is the WebDAV server reachable?")
  }

  const baseKey = currentIndexKey()
  const cache = get(metadataCache)
  const rows: { track: Track; existing: LocalMetadataStore; entry: WebdavFileEntry }[] = []
  for (const t of get(library)) {
    const existing = cache.get(t.trackId)
    if (!existing?.webdavPath || !existing.webdavBase || existing.webdavBase === baseKey) continue
    if (existing.ignored) continue
    const entry = index.find((i) => i.path === existing.webdavPath)
    if (!entry) continue // vanished — flagged separately, not this tool's job
    rows.push({ track: t, existing, entry })
  }

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map(async ({ track, existing, entry }) => {
      const { verdict, meta } = await reverifyRow(track, entry)
      if (verdict !== 'verified') {
        result[verdict]++
        return
      }
      // Re-check the live row: the user may have cleared/re-bound mid-run —
      // only re-stamp when it is still the same stale binding.
      const current = get(metadataCache).get(track.trackId)
      if (current?.webdavBase && current.webdavBase !== baseKey
          && current.webdavPath === existing.webdavPath) {
        writeReverified(current, meta, entry, baseKey)
        result.verified++
      }
      // Otherwise the row already moved — it no longer exists as counted work.
    }))
  }
  return result
}

export type ReverifyTrackResult =
  | { ok: true }
  | { ok: false; reason: 'no-creds' | 'index-failure' | 'not-in-index' | 'no-row' | 'not-stale' | 'conflict'; fileTitle?: string }

/** Per-row form of the audit — backs the stale row's "Update file link"
 *  button. 'conflict' refuses the re-stamp (the file's tags contradict the
 *  track — re-stamping would canonize a wrong binding); untagged files are
 *  allowed through: the user clicked deliberately, and that click is the
 *  verdict for files the machine can't read. */
export async function reverifyTrack(trackId: string): Promise<ReverifyTrackResult> {
  if (!webdavUrl || !webdavUser || !webdavToken) return { ok: false, reason: 'no-creds' }
  if (!indexBuilt) {
    const ok = await refreshIndex()
    if (!ok) return { ok: false, reason: 'index-failure' }
  }
  const existing = get(metadataCache).get(trackId)
  if (!existing?.webdavPath) return { ok: false, reason: 'no-row' }
  const baseKey = currentIndexKey()
  if (existing.webdavBase === baseKey) return { ok: false, reason: 'not-stale' }
  const entry = index.find((i) => i.path === existing.webdavPath)
  if (!entry) return { ok: false, reason: 'not-in-index' }
  const track = get(library).find((t) => t.trackId === trackId)
  if (!track) return { ok: false, reason: 'no-row' }

  const { verdict, fileTitle, meta } = await reverifyRow(track, entry)
  if (verdict === 'conflict') return { ok: false, reason: 'conflict', fileTitle }
  // The row may have moved during the fetch — re-resolve against the live
  // state (a stale snapshot write here could clobber a concurrent edit).
  const current = get(metadataCache).get(trackId)
  if (!current?.webdavPath || current.webdavPath !== entry.path) return { ok: false, reason: 'no-row' }
  if (current.webdavBase === baseKey) return { ok: false, reason: 'not-stale' }
  writeReverified(current, meta, entry, baseKey)
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

/** Discards a pending local rating/loved edit — resets the row to 'synced'
 *  *without* pushing (the pending change is abandoned), keeping any existing
 *  file/provenance fields. The local app cache values stay until the next
 *  scan or reload — this only clears the queued server/file write. */
export async function discardLocalEdit(trackId: string): Promise<void> {
  const existing = get(metadataCache).get(trackId)
  if (!existing) return
  updateMetadata({
    ...existing,
    syncStatus: 'synced',
    lastModifiedLocally: Date.now(),
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
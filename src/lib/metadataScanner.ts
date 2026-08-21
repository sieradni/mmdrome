import { get } from "svelte/store"
import { writable } from "svelte/store"
import { Capacitor } from "@capacitor/core"
import { library, metadataCache, metadataScanState, settings, updateMetadata } from "../stores/appState"
import type { Track } from "../stores/appState"
import { saveWebdavFileIndex, clearWebdavFileIndex, getWebdavFileIndex, getFileTagsForBase, putFileTag, deleteFileTagsForBase, deleteFileTagsByIds, updateWebdavFileTagFingerprint } from "./db"
import type { LocalMetadataStore, FileTagCacheEntry } from "./db"
import { buildWebdavFileIndexDetailed, readFileMetadata } from "./metadataReader"
import {
  matchTrackToWebdav,
  matchTrackToWebdavCandidates,
  buildPathTimestamps,
  findChangedTracks,
  computeIndexFingerprint,
  computeTagCacheFingerprint,
  slimIndexForPersistence,
  isAudioFilePath,
  verifyEntryAgainstTrack,
  mergeFileComments,
  tagCacheEntryIsFresh,
  type NoMatchReason,
  planProbeSweep,
  buildTrackTitleIndex,
  matchFileToTracks,
  canAutoBind,
  pruneTagCacheEntries,
} from "./metadataCore"
import { filenameHintsTitle, normalizeForHint } from "./matchNormalize"
import { webdavBaseKey, webdavFetch, authHeaders, buildWebdavUrl, isTempFile } from "./webdavUtils"
import { normalizeWebdavCredentials, sameWebdavCredentials, isCurrentWebdavSession } from "./webdavSession"
import type { WebdavCredentials, WebdavSession } from "./webdavSession"
import { FileMetadataError, type FileMetadata } from "./metadataReader"
import type { FileTags, WebdavFileEntry } from "./db"

// ── Injectable dependencies ─────────────────────────────────────────────────
// The scanner reads from Dexie and calls the WebDAV layer; these are the two
// functions that cross the I/O boundary. Tests inject mocks via the setters
// below; production code uses the real implementations.
interface ScannerDeps {
  buildIndex: typeof buildWebdavFileIndexDetailed
  readFile: typeof readFileMetadata
}

const defaultDeps: ScannerDeps = {
  buildIndex: buildWebdavFileIndexDetailed,
  readFile: readFileMetadata,
}

let _deps: ScannerDeps = { ...defaultDeps }

/** Override injectable dependencies for testing. Pass partial overrides;
 *  unspecified deps use real implementations. */
export function __setScannerDeps(overrides: Partial<ScannerDeps>): void {
  _deps = { ...defaultDeps, ...overrides }
}

/** Reset to real implementations. Call in test teardown. */
export function __resetScannerDeps(): void {
  _deps = { ...defaultDeps }
}

/** Reset ALL module-level mutable state (queue, index, tag cache, generations,
 *  credentials, counters) so a test file that shares one Node process gets a
 *  clean scanner per test. Without this, `indexBuilt`/`scanGen`/`tagCache`
 *  leak across tests and tests can pass for the wrong reason (e.g. a
 *  deadlock-regression test that never actually hits the `!indexBuilt` path).
 *  Test-only. */
export function __resetScannerState(): void {
  queue = []
  activeCount = 0
  activeDrain = null
  activeScanPromise = null
  indexPersistence = Promise.resolve()
  tagCachePersistence = Promise.resolve()
  cancelled = false
  scanGen = 0
  claimedInScan = new Set<string>()
  index = []
  indexBuilt = false
  indexComplete = false
  indexRefreshPromise = null
  indexRefreshSession = null
  serverLastScan = ""
  webdavUrl = ""
  webdavUser = ""
  webdavToken = ""
  indexBaseKey = ""
  scannedCount = 0
  failedCount = 0
  missingCount = 0
  notFoundCount = 0
  ambiguousCount = 0
  totalTracks = 0
  tagCacheBaseKey = ""
  tagCacheLastKnownBaseKey = ""
  tagCache = new Map()
  tagCacheLoaded = false
  tagProbeGen = 0
  tagProbePromise = null
  tagProbePromiseGeneration = null
  tagProbeState.set({ active: false, done: 0, remaining: 0, revision: 0, resolved: 0 })
}

const CONCURRENCY = 6

const ORPHAN_DELETE_TIMEOUT = 30000

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
let activeDrain: Promise<void> | null = null
/** Covers the pre-drain scan phase too, so restore probing cannot race a
 * scan that has been scheduled but has not reached its tag phase yet. */
let activeScanPromise: Promise<void> | null = null
/** Serializes index persistence and credential-change invalidation. A stale
 * request that was already writing must finish before the invalidation delete,
 * so it cannot resurrect an old server snapshot after a credential swap. */
let indexPersistence: Promise<void> = Promise.resolve()
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
/** A partial Depth:1 fallback is useful for candidate display but is never a
 *  safe basis for automatic binding or for declaring an existing path gone. */
let indexComplete = false
let indexRefreshPromise: Promise<boolean> | null = null
let indexRefreshSession: WebdavSession | null = null
let serverLastScan = ""

let webdavUrl = ""
let webdavUser = ""
let webdavToken = ""
let indexBaseKey = ""

let scannedCount = 0
let failedCount = 0
let missingCount = 0
let notFoundCount = 0
let ambiguousCount = 0
let totalTracks = 0
let shape: ScanShape = "modified"
let activeAnnotation = ""

function annotationFor(s: ScanShape): string {
  return s === "force" ? "Scanning all files..." : "Scanning changed files..."
}

function currentIndexKey(): string {
  // The shared derivation (webdavUtils.webdavBaseKey) — Push's current-server
  // check uses the same function, so the stamp and the check can never drift
  // (TODO 3.5).
  return webdavBaseKey(webdavUrl, webdavUser)
}

function captureSession(): WebdavSession | null {
  if (!webdavUrl || !webdavUser || !webdavToken) return null
  return {
    url: webdavUrl,
    user: webdavUser,
    token: webdavToken,
    baseKey: currentIndexKey(),
    generation: scanGen,
  }
}

function currentCredentials(): WebdavCredentials {
  return { url: webdavUrl, user: webdavUser, token: webdavToken }
}

function isCurrentSession(session: WebdavSession): boolean {
  return isCurrentWebdavSession(session, currentCredentials(), scanGen)
}

function queueIndexWrite(
  session: WebdavSession,
  entries: WebdavFileEntry[],
  lastScan: string,
  tagFingerprint: string,
  complete: boolean,
): Promise<boolean> {
  const slim = slimIndexForPersistence(entries)
  const fingerprint = computeIndexFingerprint(entries)
  let result = false
  const write = indexPersistence.then(async () => {
    if (!isCurrentSession(session)) return
    await saveWebdavFileIndex({
      entries: slim,
      buildTimestamp: Date.now(),
      lastScan,
      baseKey: session.baseKey,
      fingerprint,
      tagFingerprint,
      complete,
    })
    result = isCurrentSession(session)
  })
  indexPersistence = write.catch(() => {})
  return write.then(() => result)
}

function queueTagFingerprintWrite(session: WebdavSession): Promise<void> {
  const tagFingerprint = computeTagCacheFingerprint([...tagCache.values()])
  const write = indexPersistence.then(async () => {
    if (!isCurrentSession(session) || !indexBuilt || indexBaseKey !== session.baseKey) return
    await updateWebdavFileTagFingerprint(session.baseKey, tagFingerprint)
  })
  indexPersistence = write.catch(() => {})
  return write.catch((err) => {
    console.warn('[metadata] failed to persist tag fingerprint:', err)
  })
}

/**
 * The live in-memory PROPFIND index (with content-probe tags applied), for
 * callers that need full-fidelity matching after a fresh `refreshIndex()`. The
 * Dexie-persisted snapshot is SLIMMED (tags dropped, TODO 3.6a) — the debug
 * track view must not match against it, or tag-only matches lose their
 * evidence. Read-only consumers only: the returned array is the live one.
 */
export function getCurrentIndex(): WebdavFileEntry[] {
  return index
}

export function setWebdavCredentials(url: string, user: string, token: string): void {
  // Normalize through the SAME derivation currentIndexKey() uses (TODO 3.5).
  // Credential configuration is idempotent: reopening File Matching or
  // starting a read-only operation with the same session must never cancel a
  // scan that is already in flight.
  const next = normalizeWebdavCredentials(url, user, token)
  if (sameWebdavCredentials(next, currentCredentials())) return

  const davKey = webdavBaseKey(next.url, next.user)
  const credentialsChanged = !sameWebdavCredentials(next, currentCredentials())
  const previousIndexBaseKey = indexBaseKey
  const previousTagBaseKey = tagCacheBaseKey || tagCacheLastKnownBaseKey || previousIndexBaseKey
  const baseChanged = davKey !== indexBaseKey
  if (baseChanged || credentialsChanged) {
    // Any credential change can change the visible file set (including a
    // token/account change on the same URL), so never reuse the old live
    // index while the new session is being established.
    index = []
    indexBuilt = false
    indexComplete = false
    indexBaseKey = ""
  }
  if (davKey !== tagCacheBaseKey) {
    tagCache = new Map()
    tagCacheLoaded = false
    tagCacheBaseKey = ""
  }
  if (previousTagBaseKey && previousTagBaseKey !== davKey) {
    // Keep the active credential swap serialized behind any probe writes. This
    // prevents an old in-flight write from resurrecting rows after cleanup.
    tagCachePersistence = tagCachePersistence
      .then(() => {
        // A rapid A→B→A swap must not let the delayed A cleanup delete the
        // cache for the server we have already returned to.
        if (webdavBaseKey(webdavUrl, webdavUser) === previousTagBaseKey) return
        return deleteFileTagsForBase(previousTagBaseKey)
      })
      .catch(() => {})
  }

  // Credentials changed mid-scan: in-flight work must abort at its next
  // generation guard. The invalidation is queued behind any index write that
  // is already in progress, so a stale write cannot resurrect old state after
  // this delete runs.
  cancelled = true
  scanGen++
  tagProbeGen++
  tagProbeState.update((state) => ({ ...state, active: false, done: 0, remaining: 0 }))
  indexPersistence = indexPersistence
    .then(() => clearWebdavFileIndex())
    .catch(() => {})

  if (get(metadataScanState).status === 'scanning') {
    metadataScanState.set({
      status: 'error',
      progress: { scanned: 0, total: 0, failed: 0, notFound: 0, missing: 0, duplicateMatches: 0, annotation: activeAnnotation },
      error: 'WebDAV credentials changed — scan cancelled',
    })
  }

  webdavUrl = next.url
  webdavUser = next.user
  webdavToken = next.token
  tagCacheLastKnownBaseKey = davKey
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
async function refreshIndexForSession(session: WebdavSession): Promise<boolean> {
  try {
    // Keep the fetched index local until every asynchronous enrichment step
    // has completed and the session is still current. A stale probe must never
    // publish old rows into the new server's live index.
    const built = await _deps.buildIndex(session.url, session.user, session.token)
    const freshIndex = built.entries
    if (!isCurrentSession(session)) return false

    let cached = await loadTagCacheFor(session.baseKey)
    cached = await pruneTagCacheForIndex(session, cached, freshIndex, built.complete)
    if (!isCurrentSession(session)) return false

    const tagFingerprint = computeTagCacheFingerprint([...cached.values()])
    for (const entry of freshIndex) {
      const tag = cached.get(entry.path)
      if (tag && tagCacheEntryIsFresh(tag, entry.size, entry.lastModified) && tag.status === 'ok' && tag.metadata) {
        entry.tags = metadataToTags(tag.metadata)
      }
    }
    if (!isCurrentSession(session)) return false

    const committed = await queueIndexWrite(session, freshIndex, serverLastScan, tagFingerprint, built.complete)
    if (!committed || !isCurrentSession(session)) return false

    await cleanupOrphanTempFiles(session, freshIndex)
    if (!isCurrentSession(session)) return false

    index = freshIndex
    indexBaseKey = session.baseKey
    indexBuilt = true
    indexComplete = built.complete
    tagCache = cached
    tagCacheBaseKey = session.baseKey
    tagCacheLastKnownBaseKey = session.baseKey
    tagCacheLoaded = true
    return true
  } catch {
    // A failed fresh probe must not leave an older live index eligible for a
    // later restore/tag pass. Clearing it is safer than silently matching
    // against a stale server snapshot.
    if (isCurrentSession(session)) {
      index = []
      indexBuilt = false
      indexComplete = false
      indexBaseKey = ""
    }
    return false
  }
}

/** Serialize all fresh index requests. This prevents boot/File-Matching
 *  startup races from issuing two PROPFINDs and publishing whichever result
 *  happens to settle last. A request from an obsolete credential generation is
 *  awaited and then retried for the current session by its caller. */
export async function refreshIndex(): Promise<boolean> {
  // Direct diagnostic/manual callers also obey the probe boundary; the one
  // exception is the initial refresh performed inside ensureTagProbe before
  // that operation has published its shared promise.
  await waitForCurrentTagProbe()
  const session = captureSession()
  if (!session) return false
  const active = indexRefreshPromise
  if (active) {
    const activeSession = indexRefreshSession
    if (activeSession?.generation === session.generation && activeSession.baseKey === session.baseKey) {
      return active
    }
    await active
    return refreshIndex()
  }

  const operation = refreshIndexForSession(session)
  indexRefreshPromise = operation
  indexRefreshSession = session
  try {
    return await operation
  } finally {
    if (indexRefreshPromise === operation) {
      indexRefreshPromise = null
      indexRefreshSession = null
    }
  }
}

/** Deletes `.mmdrome-tmp` files left on the server by a crashed prior write
 *  (PUT completed, MOVE never ran — `webdavPutAtomic`'s DELETE only fires on
 *  failure paths; TODO 3.8a). Runs after every FRESH probe
 *  (`refreshIndex`/`rebuildIndex`): the index IS the live server state, so any
 *  temp-named entry is an orphan — no write can be in flight between this
 *  session's probe and the cleanup (scans never write; push is a separate user
 *  action). Best-effort per file: a failing DELETE must never fail the probe. */
async function cleanupOrphanTempFiles(session: WebdavSession, entries: WebdavFileEntry[]): Promise<void> {
  const headers = authHeaders(session.user, session.token)
  for (const e of entries) {
    if (!isCurrentSession(session)) return
    if (!isTempFile(e.filename)) continue
    await webdavFetch(buildWebdavUrl(session.url, e.path), {
      method: "DELETE",
      headers,
    }, ORPHAN_DELETE_TIMEOUT).catch(() => {})
  }
}

export async function rebuildIndex(): Promise<boolean> {
  if (!captureSession()) throw new Error(CREDENTIALS_MISSING)
  // Force scans and the explicit index button both require a fresh PROPFIND;
  // the shared request path already serializes it and applies safe cache
  // pruning, so there is no second implementation to drift.
  return refreshIndex()
}

// ── In-file identity tags (content probing) ─────────────────────────────

export interface TagProbeState {
  active: boolean
  done: number
  /** Files in the current candidate pool not yet probed. */
  remaining: number
  /** Increments once per current-session probe completion. */
  revision: number
  /** Tracks auto-bound by THIS probe run, so the scan result line can
   *  reconcile "no safe match" rows that the post-scan probe resolved. */
  resolved: number
}

export const tagProbeState = writable<TagProbeState>({ active: false, done: 0, remaining: 0, revision: 0, resolved: 0 })

// Native pays per-request TLS/radio latency that the browser hides with
// keep-alive, so it needs more in-flight reads to reach the same throughput;
// the desktop value is the measured-stable one (50 files / 6 s).
const TAG_PROBE_CONCURRENCY = Capacitor.isNativePlatform() ? 8 : 4
const TAG_PROBE_RETRY_MS = 800

/** `baseUrl|user` the in-memory tag cache belongs to. */
let tagCacheBaseKey = ""
/** Last selected server identity, retained across rapid credential swaps so
 * old-base cleanup cannot lose the intermediate key before its cache loads. */
let tagCacheLastKnownBaseKey = ""
let tagCache = new Map<string, FileTagCacheEntry>()
let tagCacheLoaded = false
let tagProbeGen = 0
/** The one current probe operation. Every caller awaits this same promise. */
let tagProbePromise: Promise<Set<string>> | null = null
let tagProbePromiseGeneration: number | null = null
/** Serializes cache writes and credential-swap cleanup. */
let tagCachePersistence: Promise<void> = Promise.resolve()

function fileTagId(baseKey: string, path: string): string {
  return `${baseKey}\u0000${path}`
}

function metadataToTags(meta: FileMetadata): FileTags {
  return {
    title: meta.title,
    artist: meta.artist,
    album: meta.album,
    trackNumber: meta.trackNumber,
    year: meta.year,
    duration: meta.duration,
  }
}

function persistTagEntry(entry: FileTagCacheEntry): Promise<void> {
  const write = tagCachePersistence.then(() => putFileTag(entry))
  tagCachePersistence = write.catch(() => {})
  return write
}

/** Prune only after a complete index. Partial crawls deliberately retain
 *  unseen cache rows because an unreadable directory may still contain them. */
async function pruneTagCacheForIndex(
  session: WebdavSession,
  cached: Map<string, FileTagCacheEntry>,
  entries: WebdavFileEntry[],
  complete: boolean,
): Promise<Map<string, FileTagCacheEntry>> {
  const activePaths = new Set(entries.map((entry) => entry.path))
  const pruned = pruneTagCacheEntries([...cached.values()], activePaths, complete)
  if (pruned.removed.length === 0) return new Map(pruned.kept.map((entry) => [entry.path, entry]))
  if (!isCurrentSession(session)) return cached

  const write = tagCachePersistence.then(() => deleteFileTagsByIds(pruned.removed.map((entry) => entry.id)))
  tagCachePersistence = write.catch(() => {})
  await write
  if (!isCurrentSession(session)) return cached
  return new Map(pruned.kept.map((entry) => [entry.path, entry]))
}

/** Apply a confident reverse match from the probe without doing another file
 * read. The live eligibility check is deliberately repeated here rather than
 * trusting the probe's initial snapshot: a user edit, bind, dismissal, or
 * Navidrome reconnect may have happened while a concurrent batch was reading.
 */
function maybeAutoBindFromProbe(
  entry: WebdavFileEntry,
  meta: FileMetadata,
  titleIndex: ReturnType<typeof buildTrackTitleIndex>,
  excludedTrackIds: Set<string>,
  claimedPaths: Set<string>,
  session: WebdavSession,
): string | null {
  if (!isCurrentSession(session) || claimedPaths.has(entry.path)) return null

  // A manual bind or another UI edit may have landed after this probe batch
  // built its initial claim set. Never let the probe steal a path that is now
  // live-owned by a different row.
  for (const row of get(metadataCache).values()) {
    if (row.webdavPath === entry.path) return null
  }

  const match = matchFileToTracks(
    { ...entry, tags: metadataToTags(meta) },
    titleIndex,
    excludedTrackIds,
  )
  if (match.verdict !== 'certain' && match.verdict !== 'unique-title' || !match.trackId) return null

  // Re-read the track and row from live stores after the probe await.
  const track = get(library).find((t) => t.trackId === match.trackId)
  const current = get(metadataCache).get(match.trackId)
  if (!track || !isCurrentSession(session) || !canAutoBind(track, current).bindable) return null
  if (excludedTrackIds.has(track.trackId) || claimedPaths.has(entry.path)) return null

  // This check/add is synchronous, so two concurrent probe completions cannot
  // claim the same track or file between their verdict and store write.
  excludedTrackIds.add(track.trackId)
  claimedPaths.add(entry.path)
  const navidromeAuthoritative = current != null && get(settings).ratingSource === 'navidrome'
  updateMetadata({
    trackId: track.trackId,
    rating: navidromeAuthoritative ? current.rating : meta.rating,
    loved: navidromeAuthoritative ? current.loved : meta.loved,
    fileType: track.fileType,
    syncStatus: 'synced',
    lastModifiedLocally: Date.now(),
    webdavPath: entry.path,
    webdavLastModified: entry.lastModified,
    webdavBase: session.baseKey,
    comments: navidromeAuthoritative ? current?.comments : mergeFileComments(current?.comments, meta.comments),
    matchSource: undefined,
    ignored: current?.ignored,
  })
  return track.trackId
}

function fileTypeOf(filename: string): string {
  const dot = filename.lastIndexOf(".")
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : "mp3"
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Load cached probe results for a server identity into a path-keyed map. */
async function loadTagCacheFor(key: string): Promise<Map<string, FileTagCacheEntry>> {
  const entries = await getFileTagsForBase(key)
  return new Map(entries.map((e) => [e.path, e]))
}

/** Load cached probe results for the current server into the shared probe cache. */
async function loadTagCache(): Promise<boolean> {
  const session = captureSession()
  if (!session) return false
  if (tagCacheBaseKey === session.baseKey && tagCacheLoaded) return isCurrentSession(session)
  const loaded = await loadTagCacheFor(session.baseKey)
  if (!isCurrentSession(session)) return false
  tagCache = loaded
  tagCacheBaseKey = session.baseKey
  tagCacheLastKnownBaseKey = session.baseKey
  tagCacheLoaded = true
  return true
}

/** Stamp `entry.tags` from the cache when a size/mtime-matching probe exists. */
async function applyCachedTags(): Promise<boolean> {
  if (!await loadTagCache()) return false
  const session = captureSession()
  if (!session) return false
  for (const e of index) {
    // Do not let an expired in-memory annotation survive while the cache entry
    // is being re-probed; stale identity can produce a false candidate.
    e.tags = undefined
    const cached = tagCache.get(e.path)
    if (cached && tagCacheEntryIsFresh(cached, e.size, e.lastModified) && cached.status === 'ok' && cached.metadata) {
      e.tags = metadataToTags(cached.metadata)
    }
  }
  return isCurrentSession(session)
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
 * attached to the in-memory index for scoring; successful/empty results are
 * cached until the file size or WebDAV mtime changes, while network and parse
 * failures use separate retry TTLs so a transient outage cannot poison the
 * library forever.
 *
 * Pauses (waits) while a scan is draining so the two never compete for the
 * connection; a new call (gen bump) cancels a running pass.
 */
function launchTagProbe(): Promise<Set<string>> {
  const promise = ensureTagProbe()
  // A probe is evidence enrichment. A failed probe must never turn a valid
  // fresh PROPFIND/filename scan into a failed scan or leave the UI in
  // `scanning` forever; callers receive an empty bind set and the next TTL
  // probe can retry the failed files.
  return promise.catch((err) => {
    console.warn('[metadata] tag probe failed:', err)
    return new Set<string>()
  })
}

/** Wait without starting a new probe. Used by readers that must not race an
 *  already-running operation, while `ensureTagProbe()` remains the sole
 *  start-or-join entry point. Re-check after each await: a cancelled probe can
 *  be replaced by a new-generation probe before this continuation resumes. */
async function waitForCurrentTagProbe(): Promise<void> {
  while (true) {
    const current = tagProbePromise
    if (!current) return
    try {
      await current
    } catch (err) {
      // Probe failures are evidence misses, not index failures. The current
      // operation has already recorded its failed files where possible; a
      // reader can safely continue with filename/index evidence.
      console.warn('[metadata] waiting for tag probe failed:', err)
    }
    if (tagProbePromise === current) return
  }
}

/** A public reader/action must not replace the live index while the scan
 *  drain is still consuming it. `runScan` itself does not call this helper;
 *  its internal refresh is the owner of the active scan promise. */
async function waitForCurrentScan(): Promise<void> {
  while (true) {
    const current = activeScanPromise
    if (!current) return
    await current
    if (activeScanPromise === current) return
  }
}

/** The index refresh has its own mutex because explicit File Matching refresh
 *  is not itself a tag-probe operation. Tag probing and classification must
 *  wait for it, or they can read the old live index while a new PROPFIND is
 *  about to publish. */
async function waitForCurrentIndexRefresh(): Promise<boolean> {
  let result = true
  while (true) {
    const current = indexRefreshPromise
    if (!current) return result
    result = await current
    if (indexRefreshPromise === current) return result
  }
}

export function ensureTagProbe(): Promise<Set<string>> {
  if (!webdavUrl || !webdavUser || !webdavToken) return Promise.resolve(new Set<string>())
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(new Set<string>())

  const current = tagProbePromise
  if (current) {
    // A credential change increments scanGen. Let the stale operation settle,
    // then recursively start the operation for the current session instead of
    // returning its empty/cancelled result.
    if (tagProbePromiseGeneration !== scanGen) {
      // A cancelled old probe may reject (for example if its cache read
      // failed). Rejection must not prevent the new credential generation
      // from starting its own probe.
      return current.then(() => ensureTagProbe(), () => ensureTagProbe())
    }
    // Recover from an unexpected same-generation rejection as well. The
    // cleanup handler installed below was registered first, so it clears the
    // shared slot before this recovery callback starts a replacement.
    return current.catch(() => ensureTagProbe())
  }

  let operation: Promise<Set<string>> | null = null
  let operationSession: WebdavSession | null = null
  operation = (async () => {
    // A direct index refresh (for example the File Matching button) is not
    // represented by tagProbePromise, so join it explicitly before reading
    // the live index. If it failed, the current index is invalid and the
    // normal !indexBuilt path below may retry for the current session.
    const refreshResult = await waitForCurrentIndexRefresh()
    if (!refreshResult && !indexBuilt) return new Set<string>()

    operationSession = captureSession()
    if (!operationSession) return new Set<string>()

    if (!indexBuilt) {
      // Direct call to refreshIndexForSession — NOT refreshIndex() which
      // calls waitForCurrentTagProbe() and would deadlock on this promise.
      // The waitForCurrentIndexRefresh() above already guarantees no
      // concurrent index refresh, so we own the serialization slot here.
      const op = refreshIndexForSession(operationSession)
      indexRefreshPromise = op
      indexRefreshSession = operationSession
      try {
        const ok = await op
        if (!ok) return new Set<string>()
      } finally {
        if (indexRefreshPromise === op) {
          indexRefreshPromise = null
          indexRefreshSession = null
        }
      }
    }
    const mutex = ++tagProbeGen
    tagProbeState.update((state) => ({ ...state, active: true, done: 0, remaining: 0, resolved: 0 }))
    try {
      const autoBoundTrackIds = await runTagProbe(mutex)
      if (tagProbeGen === mutex && isCurrentSession(operationSession) && indexBuilt) {
        // The probe has consumed all cache writes for this run. Keep the
        // persisted snapshot's evidence marker in sync with the actual cache.
        await queueTagFingerprintWrite(operationSession)
      }
      return autoBoundTrackIds
    } catch (err) {
      // A tag read/cache failure is non-fatal enrichment loss. Do not reject
      // the scan or strand direct readers behind a permanently failed promise.
      console.warn('[metadata] tag probe failed:', err)
      return new Set<string>()
    } finally {
      // Only the operation that still owns the shared promise may publish its
      // terminal state. A cancelled old operation must not hide a new probe.
      if (tagProbePromise === operation) {
        if (operationSession && isCurrentSession(operationSession)) {
          tagProbeState.update((state) => ({
            ...state,
            active: false,
            done: state.done,
            remaining: 0,
            revision: state.revision + 1,
          }))
        } else {
          tagProbeState.update((state) => ({ ...state, active: false, remaining: 0, resolved: 0 }))
        }
      }
    }
  })()

  tagProbePromise = operation
  tagProbePromiseGeneration = scanGen
  void operation.then(() => {
    if (tagProbePromise === operation) {
      tagProbePromise = null
      tagProbePromiseGeneration = null
    }
  }, () => {
    if (tagProbePromise === operation) {
      tagProbePromise = null
      tagProbePromiseGeneration = null
    }
  })
  return operation
}

async function runTagProbe(gen: number): Promise<Set<string>> {
  const autoBoundTrackIds = new Set<string>()
  const session = captureSession()
  if (!session || !isCurrentWebdavSession(session, currentCredentials(), scanGen)) return autoBoundTrackIds
  const loadedCache = await loadTagCacheFor(session.baseKey)
  if (tagProbeGen !== gen || !isCurrentSession(session)) return autoBoundTrackIds
  tagCache = loadedCache
  tagCacheBaseKey = session.baseKey
  tagCacheLastKnownBaseKey = session.baseKey
  tagCacheLoaded = true
  const cache = get(metadataCache)
  const tracks = get(library)
  const titleIndex = buildTrackTitleIndex(tracks)
  // The reverse binder must judge only bindable rows before it decides whether
  // a title is unique. Otherwise an ignored/manual/pending sibling creates a
  // false ambiguity for the clean row.
  const excludedTrackIds = new Set<string>()
  for (const track of tracks) {
    if (!canAutoBind(track, cache.get(track.trackId)).bindable) excludedTrackIds.add(track.trackId)
  }
  // The probe runs before the scan drain, so its synchronous claim/update path
  // is safe even while the scan status is `scanning`: no queue worker is active
  // yet. Returning the claimed track ids lets the drain omit those rows rather
  // than matching them a second time.

  // Unclaimed tracks (no staged auto target) give the hint sets.
  const unclaimedSizes = new Set<number>()
  const unclaimedTitles = new Set<string>()
  let unclaimedTrackCount = 0
  for (const t of tracks) {
    const row = cache.get(t.trackId)
    if (row?.webdavPath || row?.ignored) continue
    unclaimedTrackCount++
    if (t.size) unclaimedSizes.add(t.size)
    if (t.title) unclaimedTitles.add(normalizeForHint(t.title))
  }

  if (unclaimedTrackCount === 0) return autoBoundTrackIds

  const pool: WebdavFileEntry[] = []
  const claimedPaths = new Set<string>()
  let unclaimedAudioFileCount = 0
  for (const row of cache.values()) {
    if (row.webdavPath) claimedPaths.add(row.webdavPath)
  }

  // Revisit fresh cached metadata before selecting new network reads. This is
  // essential after a scan harvested tags while reverse binding was disabled,
  // and it also makes a restored cache converge without requiring another
  // GET. The same live guards and synchronous claims apply.
  for (const entry of index) {
    if (claimedPaths.has(entry.path) || !isAudioFilePath(entry.filename)) continue
    const cached = tagCache.get(entry.path)
    if (!cached || !tagCacheEntryIsFresh(cached, entry.size, entry.lastModified)
        || cached.status !== 'ok' || !cached.metadata) continue
    entry.tags = metadataToTags(cached.metadata)
    const boundTrackId = maybeAutoBindFromProbe(
      entry,
      cached.metadata,
      titleIndex,
      excludedTrackIds,
      claimedPaths,
      session,
    )
    if (boundTrackId) autoBoundTrackIds.add(boundTrackId)
  }

  for (const entry of index) {
    if (claimedPaths.has(entry.path)) continue
    if (!isAudioFilePath(entry.filename)) continue
    unclaimedAudioFileCount++
    const cached = tagCache.get(entry.path)
    if (cached && tagCacheEntryIsFresh(cached, entry.size, entry.lastModified)) continue // fresh result, including TTL-governed failures
    pool.push(entry)
  }

  if (pool.length === 0) {
    // Cached-revisit binds (no network reads needed) must still be visible in
    // the store, or a converge-only probe reports resolved 0 forever.
    tagProbeState.update((state) => ({ ...state, resolved: autoBoundTrackIds.size }))
    return autoBoundTrackIds
  }

  // Hint ordering: byte-size suggestions first (strong), then filename hints,
  // then the rest. When the server is close to the library size, sweep all
  // remaining unclaimed audio files so arbitrary filenames cannot starve tag
  // matching; otherwise keep the orphan-forest guard.
  const sweep = planProbeSweep(unclaimedAudioFileCount, unclaimedTrackCount)
  const rank = new Map<string, number>()
  for (const e of pool) {
    let r = 0
    if (e.size && unclaimedSizes.has(e.size)) r = 2
    else if (filenameHintsTitle(e.filename, unclaimedTitles)) r = 1
    if (sweep === 'sweep-all' || r > 0) rank.set(e.path, r)
  }
  const hinted = sweep === 'sweep-all' ? pool : pool.filter((e) => rank.has(e.path))
  hinted.sort((a, b) => (rank.get(b.path) ?? 0) - (rank.get(a.path) ?? 0) || a.path.localeCompare(b.path))

  const baseKey = session.baseKey
  let done = 0

  for (let i = 0; i < hinted.length; i += TAG_PROBE_CONCURRENCY) {
    // Coalesce behind any running scan: probe batches wait for the scan
    // queue to drain instead of competing for the same connection.
    if (tagProbeGen !== gen || !isCurrentSession(session)) return autoBoundTrackIds
    while (queue.length > 0 || activeCount > 0) {
      await sleep(TAG_PROBE_RETRY_MS)
      if (tagProbeGen !== gen || !isCurrentSession(session)) return autoBoundTrackIds
    }
    const batch = hinted.slice(i, i + TAG_PROBE_CONCURRENCY)
    await Promise.all(batch.map(async (entry) => {
      if (tagProbeGen !== gen || !isCurrentSession(session)) return
      const id = fileTagId(baseKey, entry.path)
      try {
        // Route through the injectable seam like every other read path so the
        // lifecycle tests can mock the probe's network reads.
        const meta = await _deps.readFile(
          session.url, entry.path, session.user, session.token, fileTypeOf(entry.filename),
        )
        if (tagProbeGen !== gen || !isCurrentSession(session)) return
        const hasIdentity = !!(meta.title || meta.artist || meta.album)
        const next: FileTagCacheEntry = {
          id,
          baseKey,
          path: entry.path,
          size: entry.size,
          lastModified: entry.lastModified,
          metadata: meta,
          status: hasIdentity ? 'ok' : 'empty',
          probedAt: Date.now(),
        }
        await persistTagEntry(next)
        if (tagProbeGen !== gen || !isCurrentSession(session)) return
        tagCache.set(entry.path, next)
        if (hasIdentity && next.metadata) {
          entry.tags = metadataToTags(next.metadata)
          const boundTrackId = maybeAutoBindFromProbe(
            entry,
            next.metadata,
            titleIndex,
            excludedTrackIds,
            claimedPaths,
            session,
          )
          if (boundTrackId) autoBoundTrackIds.add(boundTrackId)
        }
      } catch (err) {
        if (tagProbeGen !== gen || !isCurrentSession(session)) return
        const next: FileTagCacheEntry = {
          id,
          baseKey,
          path: entry.path,
          size: entry.size,
          lastModified: entry.lastModified,
          status: err instanceof FileMetadataError && err.kind === 'network'
            ? 'network-error'
            : 'unreadable',
          probedAt: Date.now(),
        }
        await persistTagEntry(next)
        if (tagProbeGen !== gen || !isCurrentSession(session)) return
        tagCache.set(entry.path, next)
      }
      if (tagProbeGen !== gen || !isCurrentSession(session)) return
      done++
      const remaining = Math.max(0, hinted.length - (i + batch.length))
      // resolved mirrors autoBoundTrackIds.size — the batch loop is the only
      // place binds land, so this is always current for a live run.
      tagProbeState.update((state) => ({ ...state, active: true, done, remaining, resolved: autoBoundTrackIds.size }))
    }))
  }

  return autoBoundTrackIds
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
 *  background (guarded internally — a no-op while a probe is already active).
 *  The wrapper records the whole pre-drain operation so restore probing cannot
 *  start a competing PROPFIND/tag pass in the small scheduling window before
 *  metadataScanState becomes `scanning`.
 */
export function scanAll(shape_: ScanShape = "modified"): Promise<void> {
  const operation = (async () => {
    const completed = await runScan(shape_)
    if (!completed) return
    // Keep the post-scan tail for callers that do not need to wait for probe
    // enrichment. A later scan will await this promise before starting.
    void launchTagProbe()
  })()
  activeScanPromise = operation
  void operation.then(() => {
    if (activeScanPromise === operation) activeScanPromise = null
  })
  return operation
}

/** Online-gated restore/boot trigger. It waits for an already-scheduled scan
 * and its post-scan probe, then performs a no-op-or-start probe against the
 * restored library. The shared probe promise makes this safe for cached
 * reconnects and cold File Matching opens alike. */
export async function ensureTagProbeAfterRestore(): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return
  const scan = activeScanPromise
  if (scan) await scan
  await ensureTagProbe()
}

/** Explicit File Matching refresh boundary: never replace the live index while
 * a probe is reading it, then refresh PROPFIND mtimes before harvesting tags.
 * This keeps the one-pass cache and the view's freshness action serialized. */
export async function refreshIndexAndProbe(): Promise<boolean> {
  await waitForCurrentScan()
  await waitForCurrentTagProbe()
  const refreshed = await refreshIndex()
  if (!refreshed) return false
  await ensureTagProbe()
  return true
}

async function runScan(shape_: ScanShape = "modified"): Promise<boolean> {
  const previousDrain = activeDrain
  const previousProbe = tagProbePromise
  cancelled = true
  const myGen = ++scanGen
  tagProbeGen++
  claimedInScan = new Set<string>()
  queue = []
  scannedCount = 0
  failedCount = 0
  missingCount = 0
  notFoundCount = 0
  ambiguousCount = 0
  totalTracks = 0
  shape = shape_
  activeAnnotation = annotationFor(shape)
  let pendingTracks: Track[] = []

  // A cancelled scan may still have in-flight metadata reads. Wait for those
  // workers to release their ownership before starting a replacement run; the
  // reads themselves cannot be aborted by every WebDAV adapter, but their
  // completions are generation-guarded and must not overlap a new worker pool.
  if (previousDrain || previousProbe) {
    await Promise.all([
      previousDrain ?? Promise.resolve(),
      previousProbe ?? Promise.resolve(),
    ])
  }
  if (scanGen !== myGen) return false

  // Creds check AFTER the gen guard: a creds-less second call must not stomp
  // the scanning state of a newer in-flight scan. With no await between the
  // guard and the state set below, this error write is gen-safe by ordering.
  if (scanGen !== myGen) return false
  if (!webdavUrl || !webdavUser || !webdavToken) {
    metadataScanState.set({
      status: "error",
      progress: { scanned: 0, total: 0, failed: 0, notFound: 0, missing: 0, duplicateMatches: 0, annotation: activeAnnotation },
      error: CREDENTIALS_MISSING,
    })
    return false
  }

  metadataScanState.set({ status: "scanning", progress: { scanned: 0, total: 0, failed: 0, notFound: 0, missing: 0, duplicateMatches: 0, annotation: activeAnnotation } })

  if (shape === "force") {
    try {
      const rebuilt = await rebuildIndex()
      if (!rebuilt || scanGen !== myGen) return false
    } catch {
      if (scanGen !== myGen) return false
      metadataScanState.set({
        status: "error",
        progress: { scanned: 0, total: 0, failed: 0, notFound: 0, missing: 0, duplicateMatches: 0, annotation: activeAnnotation },
        error: INDEX_REFRESH_FAILED,
      })
      return false
    }
  } else {
    // Fingerprint of the index stored by the LAST probe. Read before the probe
    // below — refreshIndex overwrites the stored snapshot with the fresh one.
    let priorSnapshot: Awaited<ReturnType<typeof getWebdavFileIndex>>
    try {
      priorSnapshot = await getWebdavFileIndex()
    } catch {
      // A missing/corrupt local snapshot must not prevent a fresh PROPFIND.
      priorSnapshot = undefined
    }
    if (scanGen !== myGen) return false
    const sessionBaseKey = currentIndexKey()

    // A persisted index from another WebDAV server cannot participate in the
    // current server's fingerprint decision, even if both servers happen to
    // contain the same path/size set.
    const priorForThisSession = priorSnapshot?.baseKey === sessionBaseKey ? priorSnapshot : undefined

    // Always probe the server: the whole point of "Check Modified Ratings" is
    // freshness. A stale snapshot can never detect remote edits; abort loudly
    // on probe failure instead of scanning against one.
    const ok = await refreshIndex()
    if (!ok || scanGen !== myGen) {
      if (scanGen !== myGen) return false
      metadataScanState.set({
        status: "error",
        progress: { scanned: 0, total: 0, failed: 0, notFound: 0, missing: 0, duplicateMatches: 0, annotation: activeAnnotation },
        error: INDEX_REFRESH_FAILED,
      })
      return false
    }
    // Do not short-circuit an empty COMPLETE index: bound rows must still
    // pass through the drain so a server-side deletion clears their stale
    // paths (while preserving rating/loved) and reports `missing`. An empty
    // index is a valid fresh server state, not proof that there is no work.
    const tracks = get(library)
    const cache = get(metadataCache)

    const timestamps = buildPathTimestamps(index)
    const { changed, unmatched } = findChangedTracks(tracks, cache, timestamps)

    pendingTracks.push(...changed)

    // The server file set is identical to the last probe (fingerprint match):
    // rows that were never matched cannot have become matchable (no added/
    // renamed/resized file to match against), so retrying them would only burn
    // CPU. Matched rows still re-diff on their mtime above. A missing stored
    // fingerprint (first scan after the upgrade) treats the set as changed.
    const setUnchanged = priorForThisSession?.fingerprint !== undefined
      && computeIndexFingerprint(index) === priorForThisSession.fingerprint
    const tagEvidenceUnchanged = priorForThisSession?.tagFingerprint !== undefined
      && computeTagCacheFingerprint([...tagCache.values()]) === priorForThisSession.tagFingerprint
    if (!setUnchanged || !tagEvidenceUnchanged) {
      pendingTracks.push(...unmatched)
    }
  }

  // Probe before queueing the drain. The probe's own wait-for-drain guard
  // would deadlock if queue were already populated; at this point the index is
  // fresh, the prior drain is finished, and the cache can be used by every
  // matching decision in the upcoming run.
  activeAnnotation = "Reading file tags…"
  metadataScanState.set({
    status: "scanning",
    progress: { scanned: 0, total: 0, failed: 0, notFound: 0, missing: 0, duplicateMatches: 0, annotation: activeAnnotation },
  })
  const autoBoundTrackIds = await launchTagProbe()
  if (scanGen !== myGen) return false
  // The inline probe's binds are already excluded from the drain queue (and
  // thus from notFoundCount) — reset the counter so the UI never attributes
  // them to the post-scan background probe, which starts after 'complete' is
  // published and re-counts from zero.
  tagProbeState.update((state) => ({ ...state, resolved: 0 }))
  activeAnnotation = annotationFor(shape)

  const tracks = get(library)
  pendingTracks = pendingTracks.filter((t) => !autoBoundTrackIds.has(t.trackId))
  for (const t of pendingTracks) queue.push({ trackId: t.trackId })
  if (shape === "force") {
    for (const t of tracks) {
      if (!autoBoundTrackIds.has(t.trackId)) queue.push({ trackId: t.trackId })
    }
  }

  totalTracks = queue.length
  if (scanGen !== myGen) return false
  cancelled = false

  if (totalTracks === 0) {
    // Nothing to read. Without this short-circuit the drain loop never runs
    // updateScanProgress, leaving the UI stuck at 0/0 "scanning" forever.
    metadataScanState.set({
      status: "complete",
      progress: { scanned: 0, total: 0, failed: 0, notFound: 0, missing: 0, duplicateMatches: 0, annotation: activeAnnotation },
      error: tracks.length === 0 ? "No library loaded — connect Navidrome first" : undefined,
    })
    return true
  }

  metadataScanState.set({
    status: "scanning",
    progress: { scanned: 0, total: totalTracks, failed: 0, notFound: 0, missing: 0, duplicateMatches: 0, annotation: activeAnnotation },
  })

  const drainPromise = drain(myGen)
  activeDrain = drainPromise
  try {
    await drainPromise
  } finally {
    if (activeDrain === drainPromise) activeDrain = null
  }
  return scanGen === myGen && !cancelled
}

async function drain(runGen: number): Promise<void> {
  const worker = async (): Promise<void> => {
    while (!cancelled && scanGen === runGen) {
      const item = queue.shift()
      if (!item) return
      activeCount++
      try {
        await processItem(item, runGen)
      } catch {
        // processItem handles expected read failures. An unexpected adapter
        // failure still must consume this row and let the scan finish.
        if (scanGen === runGen) {
          failedCount++
          updateScanProgress()
        }
      } finally {
        activeCount--
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
}

async function processItem(item: QueueItem, runGen: number): Promise<void> {
  const startedGen = runGen
  const tracks = get(library)
  const track = tracks.find((t) => t.trackId === item.trackId)
  if (scanGen !== startedGen) return
  if (!track) {
    // Mid-scan library replacement: the queued track no longer exists in the
    // new library. Count it scanned so the drain loop can still reach
    // done === total and complete — otherwise the progress bar stalls at
    // "Scanning X/Y" forever (TODO 3.6c).
    scannedCount++
    updateScanProgress()
    return
  }

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
      const meta = await _deps.readFile(
        webdavUrl, boundPath, webdavUser, webdavToken, track.fileType,
      )
      if (scanGen !== myGen) return

      // The user may have edited rating/loved (or dismissed the row) while the
      // fetch was in flight — don't clobber the newer pending edit or a
      // dismissal with stale file tags.
      const current = get(metadataCache).get(track.trackId)
      if (current && (current.syncStatus === 'pending_sync' || current.ignored)) {
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
        comments: navidrome ? current?.comments : mergeFileComments(current?.comments, meta.comments),
        matchSource: 'manual',
        // The full-row replace must not drop a dismissal made before/during
        // the re-read (aligns with the auto-match branch, TODO 3.6b).
        ignored: current?.ignored,
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
    } else if (existing && existing.webdavPath && indexComplete && !index.some((i) => i.path === existing.webdavPath)) {
      // The file it was previously matched to no longer exists in a COMPLETE
      // fresh index (deleted/renamed). Clear the stale path so the row
      // re-matches on a later PROPFIND (renames) and Push skips it cleanly
      // instead of 404 failing forever. Rating/loved are preserved — data
      // loss-free. Guard on indexComplete: a partial crawl cannot prove a
      // bound path vanished — it may exist in an unreadable directory.
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
      notFoundCount++
    }
    updateScanProgress()
    return
  }

  try {
    // A fresh probe already fetched this file's complete metadata. Reuse that
    // payload for the bind so identity/rating/loved/comments are all sourced
    // from one read. Filename-only matches without a cache entry retain the
    // fallback GET path.
    const cached = tagCache.get(match.entry.path)
    const cachedFresh = cached != null
      && tagCacheEntryIsFresh(cached, match.entry.size, match.entry.lastModified)
    // The probe is the single read boundary. A fresh failure entry is still
    // evidence that the file was attempted; retrying it immediately here would
    // turn one failed probe into a second GET and inflate the scan's `failed`
    // count. Filename evidence can still bind without file metadata, while a
    // later probe retries the failure after its TTL.
    const meta = cachedFresh
      ? cached?.metadata ?? {
          rating: existing?.rating ?? 0,
          loved: existing?.loved ?? false,
          comments: existing?.comments,
        }
      : await _deps.readFile(webdavUrl, match.entry.path, webdavUser, webdavToken, track.fileType)
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
      comments: navidromeAuthoritative ? current?.comments : mergeFileComments(current?.comments, meta.comments),
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
  const done = scannedCount + failedCount + notFoundCount + missingCount + ambiguousCount
  const progress = {
    scanned: scannedCount,
    total: totalTracks,
    failed: failedCount,
    notFound: notFoundCount,
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
  /** Why an unmatched row missed, derived from the probe cache + index. */
  reason?: NoMatchReason
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
  /** Whether the live WebDAV file set is complete enough for safe conclusions. */
  indexComplete: boolean
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
    indexComplete: false,
    pendingBlocked: 0,
  }
  // Do not classify against an index while a scan, boot, scan-tail, or
  // explicit probe is still enriching it. This is the non-UI half of the
  // refresh race fix; callers that list after a probe always observe its
  // cache writes.
  await waitForCurrentScan()
  await waitForCurrentTagProbe()
  await waitForCurrentIndexRefresh()
  if (!indexBuilt) {
    const ok = await refreshIndex()
    if (!ok) throw new Error("Index refresh failed — is the WebDAV server reachable?")
  }
  // Re-stamp cached probe results onto the in-memory index so candidate
  // pickers show file identity (and scoring sees tags) even when this view
  // opened after the index was built.
  if (!await applyCachedTags()) throw new Error("WebDAV session changed while loading the index")
  const session = captureSession()
  if (!session) throw new Error(CREDENTIALS_MISSING)

  const baseKey = session.baseKey
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
      if (meta.webdavBase !== baseKey) {
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
      } else if (!indexComplete || indexPaths.has(meta.webdavPath)) {
        // A complete index is required before calling a path vanished. During
        // a partial crawl the old current-server binding remains the safest
        // known target and must not be cleared or mislabeled.
        counts.matched++
        row = {
          ...base,
          kind: 'matched',
          webdavPath: meta.webdavPath,
          matchSource: meta.matchSource ?? 'auto',
          candidates: [],
        }
      } else {
        counts.vanished++
        // Vanished + pending is equally un-pushable (GET 404s -> skipped).
        if (base.pendingPush) pendingBlocked++
        row = { ...base, kind: 'vanished', webdavPath: meta.webdavPath, candidates: [] }
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
        reason: match.reason ?? undefined,
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
  return { rows, counts, indexComplete, pendingBlocked }
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
  await waitForCurrentScan()
  await waitForCurrentTagProbe()

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
    for (const [, row] of hostile) {
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
    const meta = await _deps.readFile(webdavUrl, entry.path, webdavUser, webdavToken, track.fileType)
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
      comments: mergeFileComments(current.comments, meta.comments),
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
  await waitForCurrentScan()
  await waitForCurrentTagProbe()
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
  await waitForCurrentScan()
  await waitForCurrentTagProbe()
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
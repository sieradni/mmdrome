import { get } from "svelte/store"
import { Capacitor } from "@capacitor/core"
import {
  webdavFetch,
  authHeaders,
  buildWebdavUrl,
  webdavBaseKey,
  extractAllowlistedRequestId,
  WebdavTransportError,
  type WebdavResponse,
} from "./webdavUtils"
import {
  webdavPutAtomic,
  ConflictError,
  AbortedBeforeMoveError,
  AtomicWriteError,
  type AtomicWriteOptions,
  type PreconditionKind,
  type TempCleanupStatus,
} from "./webdavAtomicWrite"
import {
  getPendingSyncMetadata,
  upsertMetadata,
  getSetting,
  setSetting,
  getSongLibraryCache,
  saveSongLibraryCache,
  type LocalMetadataStore,
} from "$lib/db"
import { modifyMetadataBuffer } from "$lib/tagWriter"
import {
  metadataCache,
  settings,
  library,
  setLibrary,
  initMetadataForTracks,
  seedNavidromeFeedback,
  relinkPendingMetadata,
  lastPushReport,
  type Track,
} from "../stores/appState"
import { setWebdavCredentials, scanAll, setServerLastScan, cancelScan } from "./metadataScanner"
import { shouldKeepPushPending, shouldSkipBeforePut, classifyRowForPush } from "./pushReconcile"
import {
  summarizePushOutcomes,
  buildPushFailureGroups,
  outcomeForInitialSkip,
  MAX_RETAINED_REPORT_ROWS,
  type PushErrorCategory,
  type PushErrorDetail,
  type PushRowDisposition,
  type PushRowOutcome,
  type PushRunReport,
  type PushStage,
  type CatalogRefreshStatus,
} from "./pushOutcome"
import { cachedLibraryUsable } from "./syncCachePolicy"
import { planNavidromeLoad } from "./navidromeLoadPlan"
import { effectiveLowData } from "./networkMode"
import { dbgAlways, dbgDanger } from "./debugLog"
import { markAuthSuccess, authBaseKey } from "./authHealth"
import { md5 } from "./md5"
import {
  testNavidromeConnection as navidromeTestConnection,
  loadNavidromeSongs as navidromeLoadSongs,
  triggerNavidromeScan as navidromeTriggerScan,
  testWebdavConnection as webdavTestConnection,
  getScanStatus as navidromeGetScanStatus,
  getCachedConfig as navidromeGetCachedConfig,
  setCachedConfig as navidromeSetCachedConfig,
  cachedConfigMatches,
  navidromeSongToTrack,
  type NavidromeConfig,
  type NavidromeConnectionStatus,
  type NavidromeConnectResult,
} from "$lib/navidromeApi"

const WEBDAV_TIMEOUT = 60000

export class NotFoundError extends Error {
  readonly status: number
  constructor(message: string, status = 404) {
    super(message)
    this.name = "NotFoundError"
    this.status = status
  }
}

class GetHttpError extends Error {
  readonly status: number
  readonly retryAfter?: string
  readonly requestId?: string
  readonly davError?: string
  constructor(
    message: string,
    opts: { status: number; retryAfter?: string; requestId?: string; davError?: string },
  ) {
    super(message)
    this.name = "GetHttpError"
    this.status = opts.status
    this.retryAfter = opts.retryAfter
    this.requestId = opts.requestId
    this.davError = opts.davError
  }
}

/**
 * Cancellation token for the long orchestrations (Push, Navidrome load).
 * Each run gets an INDEPENDENT token: loads legitimately run concurrently
 * (the user's Connect & Load click races the online-gated background
 * restore), so a newer run must NOT silently invalidate an older one — that
 * design poisoned the user's run with 'Load cancelled' the moment a
 * background load started. `activeCancel` holds the LATEST handle, so
 * `cancelLongOperation` targets the newest run.
 */
interface CancelHandle {
  cancel(): void
}
function newCancelHandle(): { handle: CancelHandle; isCancelled: () => boolean } {
  let cancelled = false
  return {
    handle: {
      cancel: () => {
        cancelled = true
      },
    },
    isCancelled: () => cancelled,
  }
}
let activeCancel: CancelHandle | null = null

/** Cancel the running long operation (Push, Navidrome load) or the WebDAV
 *  metadata scan. The operation lands on its own honest terminal: pushed rows
 *  stay pushed, scanned rows stay scanned, a partial load applies nothing. */
export function cancelLongOperation(): void {
  activeCancel?.cancel()
  cancelScan()
}

// ── Injectable seams for unit-testing the production Push orchestration ─────

export interface PushSyncDeps {
  getSetting: <T = string>(key: string) => Promise<T | undefined>
  getPendingSyncMetadata: () => Promise<LocalMetadataStore[]>
  getLiveMetadata: (trackId: string) => LocalMetadataStore | undefined
  setInMemoryMetadata: (row: LocalMetadataStore) => void
  upsertMetadata: (row: LocalMetadataStore) => Promise<void>
  getLibraryTracks: () => Track[]
  webdavFetch: (url: string, options: RequestInit, timeoutMs: number) => Promise<WebdavResponse>
  modifyMetadataBuffer: (
    buf: ArrayBuffer,
    rating: number,
    loved: boolean,
    fileType: string,
  ) => Promise<ArrayBuffer>
  triggerNavidromeScan: () => Promise<void>
  persistPushReport: (report: PushRunReport) => Promise<void>
  now: () => number
  isNative: () => boolean
  /** Optional unique run token suffix for temp files (defaults to legacy `.mmdrome-tmp` unless opted in). */
  useUniqueTempToken?: boolean
}

const defaultPushDeps: PushSyncDeps = {
  getSetting,
  getPendingSyncMetadata,
  getLiveMetadata: (trackId) => get(metadataCache).get(trackId),
  setInMemoryMetadata: (row) => {
    metadataCache.update((map) => {
      const next = new Map(map)
      next.set(row.trackId, row)
      return next
    })
  },
  upsertMetadata,
  getLibraryTracks: () => get(library),
  webdavFetch,
  modifyMetadataBuffer,
  triggerNavidromeScan: () => triggerNavidromeScan(),
  persistPushReport: async (report) => {
    lastPushReport.set(report)
    try {
      await setSetting("lastPushReport", report)
    } catch {
      // Diagnostic persistence failure must never alter the file-write verdict
      // or create an unhandled rejection (W-09).
    }
  },
  now: () => Date.now(),
  isNative: () => Capacitor.isNativePlatform(),
}

let _pushDeps: PushSyncDeps = { ...defaultPushDeps }

export function __setPushSyncDeps(overrides: Partial<PushSyncDeps>): void {
  _pushDeps = { ...defaultPushDeps, ...overrides }
}

export function __resetPushSyncDeps(): void {
  _pushDeps = { ...defaultPushDeps }
}

function sanitizeDavErrorBody(text: string): string | undefined {
  const cleaned = text.replace(/\s+/g, " ").trim()
  if (!cleaned) return undefined
  // Strip any Basic/Bearer tokens or URLs with credentials if present
  const redacted = cleaned
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [redacted]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
  return redacted.slice(0, 180)
}

async function webdavGet(
  baseUrl: string,
  filePath: string,
  user: string,
  token: string,
  fetchImpl: PushSyncDeps["webdavFetch"] = _pushDeps.webdavFetch,
): Promise<{ data: ArrayBuffer; etag?: string }> {
  const url = buildWebdavUrl(baseUrl, filePath)
  const res = await fetchImpl(
    url,
    {
      method: "GET",
      headers: authHeaders(user, token),
    },
    WEBDAV_TIMEOUT,
  )
  if (!res.ok) {
    if (res.status === 404 || res.status === 410) {
      throw new NotFoundError(`File gone (${res.status}) for ${filePath}`, res.status)
    }
    const retryAfter = res.headers.get("Retry-After") ?? undefined
    const requestId = extractAllowlistedRequestId(res.headers)
    let davError: string | undefined
    try {
      davError = sanitizeDavErrorBody(await res.text())
    } catch {}
    throw new GetHttpError(`WebDAV GET failed (${res.status}) for ${filePath}`, {
      status: res.status,
      retryAfter,
      requestId,
      davError,
    })
  }
  return {
    data: await res.arrayBuffer(),
    etag: res.headers.get("ETag") ?? undefined,
  }
}

/**
 * Thin adapter: binds the pure `webdavPutAtomic` (`webdavAtomicWrite.ts`) to
 * the configured `webdavFetch` transport (native → CapacitorHttp, web →
 * fetch, §3.3). All policy — the exactly-once temp cleanup, the
 * destination-scoped `If` precondition forwarding, ConflictError-on-412/404,
 * and pre-MOVE live validation — lives in the pure module and is pinned by
 * tests/webdavAtomicWrite.test.ts.
 */
function webdavPutAtomicViaAppFetch(
  baseUrl: string,
  filePath: string,
  data: ArrayBuffer,
  user: string,
  token: string,
  etag?: string,
  opts?: AtomicWriteOptions,
  fetchImpl: PushSyncDeps["webdavFetch"] = _pushDeps.webdavFetch,
) {
  return webdavPutAtomic(baseUrl, filePath, data, user, token, etag, fetchImpl, WEBDAV_TIMEOUT, opts)
}

async function getNavidromeConfig(): Promise<NavidromeConfig | null> {
  const navidromeUrl = (await getSetting<string>("navidromeUrl"))?.trim()
  const navidromeUser = await getSetting<string>("navidromeUser")
  const navidromePassword = await getSetting<string>("navidromePassword")

  if (!navidromeUrl || !navidromeUser || !navidromePassword) return null

  return {
    baseUrl: navidromeUrl,
    username: navidromeUser,
    password: navidromePassword,
  }
}

export async function testNavidromeConn(): Promise<NavidromeConnectionStatus> {
  const config = await getNavidromeConfig()
  if (!config) {
    return { connected: false, error: "Navidrome credentials not configured" }
  }
  const result = await navidromeTestConnection(config)
  // A successful authenticated ping is evidence the credentials work — clear
  // any auth-health park so the "fix the password, hit Test Connection" flow
  // un-gates immediately instead of waiting for the next full connect. This
  // also self-heals the park if the 0.64.1 login rate limiter ever surfaces
  // as a Subsonic code 40 (a throttled user must not stay parked forever).
  if (result.connected) markAuthSuccess(authBaseKey(config.baseUrl, config.username))
  return result
}

export async function testWebdavConn(): Promise<{ connected: boolean; error?: string }> {
  const webdavUrl = await getSetting<string>("webdavUrl")
  const webdavUser = await getSetting<string>("webdavUser")
  const webdavToken = await getSetting<string>("webdavToken")

  if (!webdavUrl || !webdavUser || !webdavToken) {
    return { connected: false, error: "WebDAV credentials not configured" }
  }

  return webdavTestConnection(webdavUrl, webdavUser, webdavToken)
}

export async function triggerNavidromeScan(): Promise<void> {
  const config = await getNavidromeConfig()
  if (!config) {
    throw new Error("Navidrome credentials not configured")
  }
  await navidromeTriggerScan(config)
}

export async function connectNavidrome(
  forceRefresh = false,
  opts: { isCancelled?: () => boolean } = {},
): Promise<NavidromeConnectResult> {
  const config = await getNavidromeConfig()
  if (!config) {
    // Disconnected (empty fields committed): drop the stale config so stream/
    // cover URLs stop pointing at the old server mid-session (TODO 3.4).
    navidromeSetCachedConfig(null)
    return {
      connection: { connected: false, error: "Navidrome credentials not configured" },
      songs: [],
      loadResult: { loaded: 0, failed: 0, error: "Navidrome credentials not configured" },
    }
  }

  // The cached config is keyed by server identity (baseUrl + username); a
  // server swap or username change makes the old config's URLs dead, so drop
  // it before any connect attempt (success re-sets it via loadNavidromeSongs;
  // the offline fallback below re-sets it from this fresh config).
  if (!cachedConfigMatches(navidromeGetCachedConfig(), config.baseUrl, config.username)) {
    navidromeSetCachedConfig(null)
  }

  // Trim the username for the cache identity: commitCredentials persists the
  // trimmed value, so a legacy row with stray whitespace must not silently
  // change the cache key (baseUrl is already trimmed by getNavidromeConfig).
  const baseKey = authBaseKey(config.baseUrl, config.username)

  const connection = await navidromeTestConnection(config)
  if (!connection.connected) {
    // Server unreachable / auth failed — serve the cached library for this
    // server so an offline startup or transient outage keeps the catalog
    // browsable (the library + metadata seeding are local-only). The error
    // stays on both the connection and loadResult so the UI reports the
    // stale-but-present source instead of silently passing off cache as live.
    dbgAlways("sync", `connect FAILED (${connection.error ?? "unknown"}) — trying cached-library fallback`)
    const cached = await getSongLibraryCache()
    if (cached && cachedLibraryUsable(cached, baseKey)) {
      navidromeSetCachedConfig(config)
      return {
        connection,
        songs: cached.tracks,
        loadResult: {
          loaded: cached.tracks.length,
          failed: 0,
          cached: true,
          cacheReason: "connection-fallback",
          error: connection.error,
        },
        lastScan: cached.lastScan,
      }
    }
    dbgDanger(
      "sync",
      `fallback REJECTED — no usable cached snapshot for this server (library will be empty: ${connection.error ?? "unknown"})`,
    )
    return { connection, songs: [], loadResult: { loaded: 0, failed: 0, error: connection.error } }
  }

  // A successful ping proves the credentials work — clear any unhealthy
  // mark so gated legs (scrobbles, feedback pushes, lyrics) resume.
  markAuthSuccess(baseKey)

  let lastScan = ""
  try {
    const scanStatus = await navidromeGetScanStatus(config)
    lastScan = scanStatus.lastScan
  } catch {
    // if scan status fails, proceed without caching
  }

  // The cache is valid when it belongs to this server and either carries the
  // matching scan timestamp OR the server exposes no timestamp at all (in the
  // latter case any cached snapshot is the best we can offer — the Settings
  // "Connect & Load Songs" button forces a refresh). Previously a truthy
  // lastScan was required for BOTH checking and saving the cache, so servers
  // whose getScanStatus is empty/failing re-paginated the whole catalog on
  // every launch.
  const cached = await getSongLibraryCache()
  if (
    cached &&
    cachedLibraryUsable(cached, baseKey, {
      forceRefresh,
      lastScan,
      serverVersion: connection.serverVersion,
      requireFreshScan: true,
    })
  ) {
    navidromeSetCachedConfig(config)
    return {
      connection,
      songs: cached.tracks,
      loadResult: { loaded: cached.tracks.length, failed: 0, cached: true, cacheReason: "cache-reuse" },
      lastScan,
    }
  }

  const { songs, result } = await navidromeLoadSongs(config, opts)

  // The load failed (mid-pagination, auth, transient) and returned nothing
  // usable — fall back to a valid cached snapshot for this server so startup
  // and re-connects keep a working library + queue instead of going empty.
  // The error stays on loadResult so the UI can report it.
  if (result.error && songs.length === 0) {
    const cached = await getSongLibraryCache()
    if (cached && cachedLibraryUsable(cached, baseKey)) {
      navidromeSetCachedConfig(config)
      return {
        connection,
        songs: cached.tracks,
        loadResult: {
          loaded: cached.tracks.length,
          failed: 0,
          cached: true,
          cacheReason: "load-fallback",
          error: result.error,
        },
        lastScan,
      }
    }
  }

  if (songs.length > 0) {
    await saveSongLibraryCache({ tracks: songs, lastScan, baseKey, serverVersion: connection.serverVersion })
    dbgAlways("sync", `library cache persisted: ${songs.length} songs @ server ${connection.serverVersion ?? "unknown"}`)
  }

  return { connection, songs, loadResult: result, lastScan }
}

/**
 * Single pipeline for applying a Navidrome connect to the app state, used by
 * both App startup and the Settings "Connect & Load" button so the two paths
 * can never diverge: library + metadata seeding + server lastScan, then an
 * automatic incremental WebDAV metadata scan when WebDAV is configured.
 */
export async function loadLibraryFromNavidrome(forceRefresh = false): Promise<NavidromeConnectResult> {
  // Register as THE cancellable operation; the token goes stale if another
  // long operation starts, so cancel always targets the newest run.
  const { handle, isCancelled } = newCancelHandle()
  activeCancel = handle
  let result: NavidromeConnectResult
  try {
    result = await connectNavidrome(forceRefresh, { isCancelled })
  } finally {
    if (activeCancel === handle) activeCancel = null
  }

  const s = get(settings)
  const plan = planNavidromeLoad(result, {
    mapSong: navidromeSongToTrack,
    webdavConfigured: !!(s.webdavUrl && s.webdavUser && s.webdavToken),
    online: typeof navigator === "undefined" || navigator.onLine !== false,
    // The effective low-data gate (manual toggle OR cellular OR OS Low Data
    // Mode) suppresses the automatic incremental scan — never the load itself.
    lowData: get(effectiveLowData),
  })

  // The planner encodes the bail rule: a disconnected/failed load with no
  // usable songs must NOT replace the in-memory library (setLibrary would
  // reconcile the queue against the empty set and wipe it). A genuinely empty
  // server (connected, clean) still applies — that's the truth.
  // Cancel extension of the same rule, checked FIRST: a partial page-set
  // (cancel fired mid-pagination) can have songs.length > 0 and would PASS
  // the plan's bail rule — it must still never be applied. The existing
  // library and its metadata stay untouched; the UI learns why via
  // loadResult.error.
  if (isCancelled()) {
    dbgAlways("sync", "load CANCELLED mid-pagination — library untouched")
    return { ...result, loadResult: { ...result.loadResult, error: "Load cancelled", cancelled: true } }
  }
  if (!plan.applyLibrary) return result

  // D-04: Explicit cache source (`cache-reuse` vs `connection-fallback` vs `load-fallback`)
  // and explicit scan suppression reason (`low-data`, `offline`, `not-configured`) so a
  // dump never mislabels ordinary cache reuse as a connection fallback.
  const cacheLabel = result.loadResult.cached
    ? ` (${result.loadResult.cacheReason ?? (result.loadResult.error ? "connection-fallback" : "cache-reuse")})`
    : ""
  const scanLabel = plan.scanWebdav ? "yes" : `no(${plan.scanSuppressedReason})`
  dbgAlways(
    "sync",
    `plan: apply=${plan.tracks.length} tracks scanWebdav=${scanLabel} seedFeedback=${plan.seedFeedback ? "yes" : "no"}${cacheLabel}${result.loadResult.error ? ` error=${result.loadResult.error}` : ""}`,
  )

  setLibrary(plan.tracks)
  initMetadataForTracks(plan.tracks)
  if (plan.seedFeedback) seedNavidromeFeedback(plan.tracks)
  // A full load may have orphaned pending edits (an id migration re-encodes
  // ids while edits sit keyed by the OLD id). The keep-rule in pruneStaleMetadata
  // preserved them; re-link them onto the surviving song ids BEFORE anything
  // can display them as raw-id rows (Push dialog, File Matching).
  const relink = await relinkPendingMetadata(plan.tracks, webdavBaseKey(s.webdavUrl ?? "", s.webdavUser ?? ""))
  if (relink.moved > 0 || relink.unmatched > 0) {
    dbgAlways(
      "sync",
      `stale-id relink after load: ${relink.moved} edit(s) re-linked, ${relink.unmatched} left as Push-dialog discard candidates`,
    )
  }
  if (plan.lastScan) setServerLastScan(plan.lastScan)

  // A successful connect rotates the Subsonic auth params (fresh salt+token
  // per process — buildAuthParams). The native engine's queue snapshot baked
  // the PREVIOUS process's token into every cover URL, so lock-screen art and
  // every <img> re-request died after a resume/reconnect (the "expanded view
  // shows the default app cover" report). The rebuilt snapshot carries fresh
  // URLs; the current track is untouched. No-op on web (not engaged, not
  // native) and inside the try so a bridge failure can never fail the load.
  try {
    const { playbackManager } = await import("./playbackManager")
    playbackManager.resyncNativeSnapshotAfterReconnect()
  } catch {
    /* native bridge unavailable — nothing to resync */
  }

  if (plan.configureWebdav) {
    setWebdavCredentials(s.webdavUrl!, s.webdavUser!, s.webdavToken!)
    // Skip the automatic scan when the device is offline (navigator.onLine is
    // reliable on web; the scan already degrades safely if it ever lies) so an
    // offline startup doesn't fire a doomed PROPFIND and paint a scan error.
    if (plan.scanWebdav) {
      // scanAll probes the server itself (refreshIndex) — no ensureIndex
      // pre-call, or the connect would issue two PROPFINDs.
      void scanAll("modified").catch(() => {})
    }
  }

  return result
}

export interface WebdavSyncResult {
  synced: number
  failed: number
  skipped: number
  wrongServer: number
  blindOverwrite: number
  /** Rows written remotely AND kept `pending_sync` because a newer live edit landed during the push (W-02/W9). */
  repended?: number
  /** Rows written remotely whose local DB/cache update failed (W-02/W2). */
  localFailed?: number
  /** Rows whose MOVE response was lost/aborted, leaving remote state uncertain (W-02/W6). */
  unknownOutcomes?: number
  /** Rows not processed because the user cancelled between rows (W-02/W10). */
  unprocessedCancelled?: number
  /** Catalog refresh outcome (`not-needed` | `triggered` | `failed`) (W-10). */
  catalogRefresh?: CatalogRefreshStatus
  /** Structured durable report with per-row stages, dispositions, and failure groups (W-01/W-09). */
  report?: PushRunReport
  /** The FIRST per-row failure's message (absent when nothing failed). Without
   *  it the pane reported a bare "N failed" with no cause — a wrong base URL,
   *  a MOVE rejection and a tag-write error all read identically. */
  failureReason?: string
  /** True when the run ended because the user cancelled it (not an error).
   *  Row-atomic by construction: rows pushed before the cancel stay pushed
   *  and synced; the rest stay pending_sync for the next Push. */
  cancelled: boolean
}

let pushRunCounter = 0

function classifyPushError(err: unknown, defaultStage: PushStage): PushErrorDetail {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof GetHttpError) {
    const category: PushErrorCategory = err.status === 401 || err.status === 403 ? "auth" : "http"
    return {
      category,
      stage: "get-headers",
      status: err.status,
      ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}),
      ...(err.requestId ? { requestId: err.requestId } : {}),
      ...(err.davError ? { davError: err.davError } : {}),
      message,
    }
  }
  if (err instanceof AtomicWriteError) {
    const category: PushErrorCategory = err.status === 401 || err.status === 403 ? "auth" : "http"
    return {
      category,
      stage: err.stage,
      ...(err.status !== undefined ? { status: err.status } : {}),
      message,
    }
  }
  if (err instanceof ConflictError) {
    return {
      category: "conflict",
      stage: "move",
      ...(err.status !== undefined ? { status: err.status } : {}),
      message,
    }
  }
  if (err instanceof WebdavTransportError) {
    const stage: PushStage =
      defaultStage === "get-headers" || defaultStage === "get-body"
        ? err.phase === "headers"
          ? "get-headers"
          : "get-body"
        : defaultStage
    const category: PushErrorCategory = err.timedOut
      ? "timeout"
      : err.phase === "decode"
        ? "body-decode"
        : /abort/i.test(message)
          ? "abort"
          : "network"
    return {
      category,
      stage,
      ...(err.code !== undefined ? { code: err.code } : {}),
      ...(err.domain !== undefined ? { domain: err.domain } : {}),
      message,
    }
  }
  if (defaultStage === "taglib-edit") {
    return { category: "tag-format", stage: "taglib-edit", message }
  }
  if (defaultStage === "local-reconcile") {
    return { category: "local-db", stage: "local-reconcile", message }
  }
  const anyErr = err as { stage?: PushStage; status?: number; code?: string | number; domain?: string }
  const stage = anyErr?.stage ?? defaultStage
  const status = typeof anyErr?.status === "number" ? anyErr.status : undefined
  const category: PushErrorCategory =
    status === 401 || status === 403
      ? "auth"
      : status !== undefined
        ? "http"
        : /timed?\s*out/i.test(message)
          ? "timeout"
          : /abort/i.test(message)
            ? "abort"
            : "network"
  return {
    category,
    stage,
    ...(status !== undefined ? { status } : {}),
    ...(anyErr?.code !== undefined ? { code: anyErr.code } : {}),
    ...(anyErr?.domain !== undefined ? { domain: anyErr.domain } : {}),
    message,
  }
}

export async function runManualWebDAVSync(
  opts: {
    /** Called after each row settles (success, skip, or failure) with the
     *  1-based index and the track title — the dialog's progress line. */
    onProgress?: (done: number, total: number, title: string) => void
    isCancelled?: () => boolean
  } = {},
): Promise<WebdavSyncResult> {
  const deps = _pushDeps
  const webdavUrl = await deps.getSetting<string>("webdavUrl")
  const webdavUser = await deps.getSetting<string>("webdavUser")
  const webdavToken = await deps.getSetting<string>("webdavToken")

  if (!webdavUrl || !webdavUser || !webdavToken) {
    throw new Error("WebDAV credentials not configured")
  }

  const runStartedMs = deps.now()
  const runId = `push-${runStartedMs}-${++pushRunCounter}`
  const currentBaseKey = webdavBaseKey(webdavUrl, webdavUser)
  const baseKeyHashed = md5(currentBaseKey).slice(0, 12)
  const transport: "web" | "native" = deps.isNative() ? "native" : "web"

  const pending = await deps.getPendingSyncMetadata()
  if (pending.length === 0) {
    const emptyCounts = summarizePushOutcomes([])
    const emptyReport: PushRunReport = {
      runId,
      startedAt: new Date(runStartedMs).toISOString(),
      completedAt: new Date(deps.now()).toISOString(),
      durationMs: Math.max(0, deps.now() - runStartedMs),
      status: "completed",
      transport,
      baseKeyHashed,
      cancelled: false,
      catalogRefresh: "not-needed",
      counts: emptyCounts,
      failureGroups: [],
      rows: [],
      rowsTruncated: 0,
    }
    await deps.persistPushReport(emptyReport)
    return {
      synced: 0,
      failed: 0,
      skipped: 0,
      wrongServer: 0,
      blindOverwrite: 0,
      repended: 0,
      localFailed: 0,
      unknownOutcomes: 0,
      unprocessedCancelled: 0,
      catalogRefresh: "not-needed",
      report: emptyReport,
      cancelled: false,
    }
  }

  const total = pending.length
  let settled = 0
  let cancelledRun = false

  // The cache row's fileType can be stale (coerced to 'mp3' by older mappers);
  // the library Track is authoritative for the tag-write format branch.
  const libTracks = new Map(deps.getLibraryTracks().map((t) => [t.trackId, t]))
  const fileTypeOf = (trackId: string, fallback: string): string =>
    libTracks.get(trackId)?.fileType ?? fallback
  // Metadata rows carry an optional snapshot title; the library Track is primary.
  const titleOf = (track: LocalMetadataStore): string =>
    libTracks.get(track.trackId)?.title ?? track.title ?? track.trackId

  // W4: Track paths where a write COMMITTED (`committedPaths`) separately from
  // paths currently in-flight (`activePaths`). If a writer fails before
  // committing (e.g. GET/TagLib/PUT fails), the path is released so a valid
  // sibling row targeting the same file is not falsely skipped; once committed
  // (or unknown MOVE outcome), later rows targeting that path in the same batch
  // are skipped as `skipped-duplicate-target` so competing edits never clobber
  // each other silently.
  const committedPaths = new Set<string>()
  const rowOutcomes: PushRowOutcome[] = []

  // Save a running checkpoint so an interrupted app restart knows a push was in flight (W-09).
  await deps.persistPushReport({
    runId,
    startedAt: new Date(runStartedMs).toISOString(),
    durationMs: 0,
    status: "running",
    transport,
    baseKeyHashed,
    cancelled: false,
    catalogRefresh: "not-needed",
    counts: summarizePushOutcomes([]),
    failureGroups: [],
    rows: [],
    rowsTruncated: 0,
  })

  for (let idx = 0; idx < pending.length; idx++) {
    const track = pending[idx]
    const rowTitle = titleOf(track)
    const rowStartMs = deps.now()

    // Cancel between rows only: a row in flight always completes (its write
    // is atomic — temp PUT + MOVE), so a cancel never leaves a half-written
    // file; rows pushed before the cancel stay pushed, the rest stay pending.
    if (!cancelledRun && opts.isCancelled?.()) {
      cancelledRun = true
      opts.onProgress?.(settled, total, `Cancelled — stopped before "${rowTitle}"`)
    }
    if (cancelledRun) {
      rowOutcomes.push({
        trackId: track.trackId,
        title: rowTitle,
        ...(track.webdavPath ? { targetPath: track.webdavPath } : {}),
        initialBucket: classifyRowForPush(track, currentBaseKey),
        disposition: "unprocessed-cancelled",
        stage: "classify",
        attempts: 0,
        recoveredConflict: false,
        remoteState: "not-attempted",
        localReconciliation: "not-needed",
        remainsPending: true,
        startedAtMs: rowStartMs,
        durationMs: 0,
      })
      continue
    }

    // The ONE classification, shared with the Push confirmation dialog's safe
    // count (pushReconcile.classifyRowForPush).
    const bucket = classifyRowForPush(track, currentBaseKey)
    if (bucket !== "pushable") {
      rowOutcomes.push(outcomeForInitialSkip(track.trackId, rowTitle, track.webdavPath, bucket, rowStartMs))
      settled++
      opts.onProgress?.(settled, total, rowTitle)
      continue
    }

    const davPath = track.webdavPath!
    if (committedPaths.has(davPath)) {
      rowOutcomes.push({
        trackId: track.trackId,
        title: rowTitle,
        targetPath: davPath,
        initialBucket: "pushable",
        disposition: "skipped-duplicate-target",
        stage: "classify",
        attempts: 0,
        recoveredConflict: false,
        remoteState: "not-attempted",
        localReconciliation: "not-needed",
        remainsPending: true,
        startedAtMs: rowStartMs,
        durationMs: Math.max(0, deps.now() - rowStartMs),
      })
      settled++
      opts.onProgress?.(settled, total, rowTitle)
      continue
    }

    let currentStage: PushStage = "live-validation"
    let attempts = 0
    let recoveredConflict = false
    let precondition: PreconditionKind | undefined
    let tempCleanup: TempCleanupStatus | undefined
    let remoteState: "not-attempted" | "not-committed" | "committed" | "unknown" = "not-attempted"

    try {
      // W-04: Pre-GET live validation
      const liveBeforeGet = deps.getLiveMetadata(track.trackId)
      if (shouldSkipBeforePut(track, liveBeforeGet, currentBaseKey)) {
        rowOutcomes.push({
          trackId: track.trackId,
          title: rowTitle,
          targetPath: davPath,
          initialBucket: "pushable",
          disposition: "skipped-live-invalidated",
          stage: "live-validation",
          attempts: 0,
          recoveredConflict: false,
          remoteState: "not-attempted",
          localReconciliation: "not-needed",
          remainsPending: liveBeforeGet?.syncStatus === "pending_sync",
          startedAtMs: rowStartMs,
          durationMs: Math.max(0, deps.now() - rowStartMs),
        })
        continue
      }

      attempts = 1
      currentStage = "get-headers"
      const { data: raw, etag } = await webdavGet(
        webdavUrl,
        davPath,
        webdavUser,
        webdavToken,
        deps.webdavFetch,
      )

      // Progress notification for work in flight (monotonic `settled` count is not incremented until finally)
      opts.onProgress?.(settled + 1, total, rowTitle)

      currentStage = "taglib-edit"
      const modified = await deps.modifyMetadataBuffer(
        raw,
        track.rating,
        track.loved,
        fileTypeOf(track.trackId, track.fileType),
      )

      // W-04: Re-validate live row AFTER async GET + TagLib edit and BEFORE PUT!
      currentStage = "live-validation"
      const liveBeforePut = deps.getLiveMetadata(track.trackId)
      if (shouldSkipBeforePut(track, liveBeforePut, currentBaseKey)) {
        rowOutcomes.push({
          trackId: track.trackId,
          title: rowTitle,
          targetPath: davPath,
          initialBucket: "pushable",
          disposition: "skipped-live-invalidated",
          stage: "live-validation",
          attempts,
          recoveredConflict: false,
          remoteState: "not-attempted",
          localReconciliation: "not-needed",
          remainsPending: liveBeforePut?.syncStatus === "pending_sync",
          startedAtMs: rowStartMs,
          durationMs: Math.max(0, deps.now() - rowStartMs),
        })
        continue
      }

      // W-04: Also re-validate right after temp PUT and before MOVE is sent!
      const checkBeforeMove = () => {
        const liveBeforeMove = deps.getLiveMetadata(track.trackId)
        return !shouldSkipBeforePut(track, liveBeforeMove, currentBaseKey)
      }

      currentStage = "put-temp"
      remoteState = "not-committed"
      let writeOutcome: { guarded: boolean; precondition?: PreconditionKind }
      try {
        writeOutcome = await webdavPutAtomicViaAppFetch(
          webdavUrl,
          davPath,
          modified,
          webdavUser,
          webdavToken,
          etag,
          {
            ...(deps.useUniqueTempToken ? { runToken: `${runId}-a1` } : {}),
            beforeMove: checkBeforeMove,
          },
          deps.webdavFetch,
        )
      } catch (err) {
        if (err instanceof AbortedBeforeMoveError) {
          tempCleanup = err.cleanup
          const liveNow = deps.getLiveMetadata(track.trackId)
          rowOutcomes.push({
            trackId: track.trackId,
            title: rowTitle,
            targetPath: davPath,
            initialBucket: "pushable",
            disposition: "skipped-live-invalidated",
            stage: "pre-move-validation",
            attempts,
            recoveredConflict: false,
            remoteState: "not-committed",
            localReconciliation: "not-needed",
            remainsPending: liveNow?.syncStatus === "pending_sync",
            tempCleanup,
            startedAtMs: rowStartMs,
            durationMs: Math.max(0, deps.now() - rowStartMs),
          })
          continue
        }
        if (err instanceof ConflictError) {
          // Conflict (412 or 404 on MOVE): re-validate live row before retry GET
          const liveRetryBeforeGet = deps.getLiveMetadata(track.trackId)
          if (shouldSkipBeforePut(track, liveRetryBeforeGet, currentBaseKey)) {
            rowOutcomes.push({
              trackId: track.trackId,
              title: rowTitle,
              targetPath: davPath,
              initialBucket: "pushable",
              disposition: "skipped-live-invalidated",
              stage: "live-validation",
              attempts,
              recoveredConflict: false,
              remoteState: "not-committed",
              localReconciliation: "not-needed",
              remainsPending: liveRetryBeforeGet?.syncStatus === "pending_sync",
              startedAtMs: rowStartMs,
              durationMs: Math.max(0, deps.now() - rowStartMs),
            })
            continue
          }

          attempts = 2
          currentStage = "get-headers"
          const { data: refreshed, etag: newEtag } = await webdavGet(
            webdavUrl,
            davPath,
            webdavUser,
            webdavToken,
            deps.webdavFetch,
          )

          currentStage = "taglib-edit"
          const reModified = await deps.modifyMetadataBuffer(
            refreshed,
            track.rating,
            track.loved,
            fileTypeOf(track.trackId, track.fileType),
          )

          // W-04: Re-validate live row after retry GET + TagLib edit and before retry PUT
          currentStage = "live-validation"
          const liveRetryBeforePut = deps.getLiveMetadata(track.trackId)
          if (shouldSkipBeforePut(track, liveRetryBeforePut, currentBaseKey)) {
            rowOutcomes.push({
              trackId: track.trackId,
              title: rowTitle,
              targetPath: davPath,
              initialBucket: "pushable",
              disposition: "skipped-live-invalidated",
              stage: "live-validation",
              attempts,
              recoveredConflict: false,
              remoteState: "not-committed",
              localReconciliation: "not-needed",
              remainsPending: liveRetryBeforePut?.syncStatus === "pending_sync",
              startedAtMs: rowStartMs,
              durationMs: Math.max(0, deps.now() - rowStartMs),
            })
            continue
          }

          currentStage = "put-temp"
          try {
            writeOutcome = await webdavPutAtomicViaAppFetch(
              webdavUrl,
              davPath,
              reModified,
              webdavUser,
              webdavToken,
              newEtag,
              {
                ...(deps.useUniqueTempToken ? { runToken: `${runId}-a2` } : {}),
                beforeMove: checkBeforeMove,
              },
              deps.webdavFetch,
            )
            recoveredConflict = true
          } catch (retryErr) {
            if (retryErr instanceof AbortedBeforeMoveError) {
              tempCleanup = retryErr.cleanup
              const liveNow = deps.getLiveMetadata(track.trackId)
              rowOutcomes.push({
                trackId: track.trackId,
                title: rowTitle,
                targetPath: davPath,
                initialBucket: "pushable",
                disposition: "skipped-live-invalidated",
                stage: "pre-move-validation",
                attempts,
                recoveredConflict: false,
                remoteState: "not-committed",
                localReconciliation: "not-needed",
                remainsPending: liveNow?.syncStatus === "pending_sync",
                tempCleanup,
                startedAtMs: rowStartMs,
                durationMs: Math.max(0, deps.now() - rowStartMs),
              })
              continue
            }
            throw retryErr
          }
        } else {
          throw err
        }
      }

      // Remote MOVE succeeded!
      remoteState = "committed"
      committedPaths.add(davPath)
      precondition =
        writeOutcome.precondition ?? (writeOutcome.guarded ? "guarded" : etag ? "unsafe-etag" : "absent-etag")

      // W-02 / W2 / W9: Reconcile local DB and in-memory metadataCache independently
      // of remote commit so a DB failure never masks the committed remote write.
      currentStage = "local-reconcile"
      const latest = deps.getLiveMetadata(track.trackId)
      const keepPending = !!(latest && shouldKeepPushPending(track, latest))
      const rowToSave: LocalMetadataStore = keepPending
        ? latest!
        : { ...track, syncStatus: "synced" as const }

      try {
        await deps.upsertMetadata(rowToSave)
        deps.setInMemoryMetadata(rowToSave)
        rowOutcomes.push({
          trackId: track.trackId,
          title: rowTitle,
          targetPath: davPath,
          initialBucket: "pushable",
          disposition: keepPending ? "written-repended" : "written-synced",
          stage: "local-reconcile",
          attempts,
          recoveredConflict,
          precondition,
          remoteState: "committed",
          localReconciliation: "complete",
          remainsPending: keepPending,
          startedAtMs: rowStartMs,
          durationMs: Math.max(0, deps.now() - rowStartMs),
        })
      } catch (dbErr) {
        const errDetail = classifyPushError(dbErr, "local-reconcile")
        rowOutcomes.push({
          trackId: track.trackId,
          title: rowTitle,
          targetPath: davPath,
          initialBucket: "pushable",
          disposition: "written-local-failed",
          stage: "local-reconcile",
          attempts,
          recoveredConflict,
          precondition,
          remoteState: "committed",
          localReconciliation: "failed",
          remainsPending: true,
          startedAtMs: rowStartMs,
          durationMs: Math.max(0, deps.now() - rowStartMs),
          error: errDetail,
        })
      }
    } catch (err) {
      if (err instanceof NotFoundError) {
        rowOutcomes.push({
          trackId: track.trackId,
          title: rowTitle,
          targetPath: davPath,
          initialBucket: "pushable",
          disposition: "skipped-file-gone",
          stage: "get-headers",
          attempts,
          recoveredConflict: false,
          remoteState: "not-committed",
          localReconciliation: "not-needed",
          remainsPending: true,
          startedAtMs: rowStartMs,
          durationMs: Math.max(0, deps.now() - rowStartMs),
        })
      } else {
        const anyErr = err as {
          remoteState?: "not-committed" | "unknown"
          cleanup?: TempCleanupStatus
          precondition?: PreconditionKind
          stage?: PushStage
        }
        const errDetail = classifyPushError(err, currentStage)
        const isUnknownMove = anyErr?.remoteState === "unknown"
        if (isUnknownMove) {
          // Reserve the path in this batch so a duplicate row does not blindly overwrite an uncertain MOVE
          committedPaths.add(davPath)
        }
        const disposition: PushRowDisposition = isUnknownMove
          ? "unknown-outcome"
          : err instanceof ConflictError
            ? "conflict-exhausted"
            : errDetail.stage === "get-headers" || errDetail.stage === "get-body"
              ? "failed-get"
              : errDetail.stage === "taglib-edit"
                ? "failed-taglib"
                : errDetail.stage === "put-temp"
                  ? "failed-put"
                  : "failed-move"

        rowOutcomes.push({
          trackId: track.trackId,
          title: rowTitle,
          targetPath: davPath,
          initialBucket: "pushable",
          disposition,
          stage: errDetail.stage,
          attempts,
          recoveredConflict: false,
          ...(anyErr?.precondition ? { precondition: anyErr.precondition } : {}),
          remoteState: isUnknownMove ? "unknown" : remoteState,
          localReconciliation: "not-needed",
          remainsPending: true,
          ...(anyErr?.cleanup ? { tempCleanup: anyErr.cleanup } : {}),
          startedAtMs: rowStartMs,
          durationMs: Math.max(0, deps.now() - rowStartMs),
          error: errDetail,
        })
      }
    } finally {
      settled++
      opts.onProgress?.(settled, total, rowTitle)
    }
  }

  // A cancel landing during the LAST row's flight never sees a top-of-loop
  // check — observe it here so the result still reports the user's intent.
  if (!cancelledRun && opts.isCancelled?.()) cancelledRun = true

  const counts = summarizePushOutcomes(rowOutcomes)
  const failureGroups = buildPushFailureGroups(rowOutcomes)
  const firstFailureReason = failureGroups[0]?.headline

  // W-10: Trigger Navidrome scan whenever ANY remote write committed (even if
  // local DB reconciliation failed for one of them), and record refresh status
  // separately without turning a scan error into a file-write failure.
  let catalogRefresh: CatalogRefreshStatus = "not-needed"
  let catalogRefreshError: string | undefined
  if (counts.remoteCommitted > 0) {
    try {
      await deps.triggerNavidromeScan()
      catalogRefresh = "triggered"
    } catch (scanErr) {
      catalogRefresh = "failed"
      catalogRefreshError = scanErr instanceof Error ? scanErr.message : String(scanErr)
    }
  }

  const completedMs = deps.now()
  const retainedRows = rowOutcomes.slice(0, MAX_RETAINED_REPORT_ROWS)
  const report: PushRunReport = {
    runId,
    startedAt: new Date(runStartedMs).toISOString(),
    completedAt: new Date(completedMs).toISOString(),
    durationMs: Math.max(0, completedMs - runStartedMs),
    status: cancelledRun ? "cancelled" : "completed",
    transport,
    baseKeyHashed,
    cancelled: cancelledRun,
    catalogRefresh,
    ...(catalogRefreshError ? { catalogRefreshError } : {}),
    counts,
    failureGroups,
    rows: retainedRows,
    rowsTruncated: Math.max(0, rowOutcomes.length - retainedRows.length),
    ...(firstFailureReason ? { firstFailureReason } : {}),
  }

  await deps.persistPushReport(report)
  dbgAlways(
    "sync",
    `push ${runId}: committed=${counts.remoteCommitted} (synced=${counts.writtenSynced} repended=${counts.writtenRepended} localFailed=${counts.writtenLocalFailed}) failed=${counts.failed} skipped=${counts.skipped} wrongServer=${counts.skippedWrongServer} unknown=${counts.unknownOutcomes} refresh=${catalogRefresh}`,
  )

  return {
    synced: counts.remoteCommitted,
    failed: counts.failed,
    skipped: counts.skipped,
    wrongServer: counts.skippedWrongServer,
    blindOverwrite: counts.blindOverwrite,
    repended: counts.writtenRepended,
    localFailed: counts.writtenLocalFailed,
    unknownOutcomes: counts.unknownOutcomes,
    unprocessedCancelled: counts.unprocessedCancelled,
    catalogRefresh,
    report,
    cancelled: cancelledRun,
    failureReason: firstFailureReason || undefined,
  }
}

import { get } from "svelte/store"
import { webdavFetch, authHeaders, buildWebdavUrl, webdavBaseKey } from "./webdavUtils"
import { webdavPutAtomic, ConflictError } from "./webdavAtomicWrite"
import { getPendingSyncMetadata, upsertMetadata, getSetting, getSongLibraryCache, saveSongLibraryCache } from "$lib/db"
import { modifyMetadataBuffer } from "$lib/tagWriter"
import { metadataCache, settings, library, setLibrary, initMetadataForTracks, seedNavidromeFeedback } from "../stores/appState"
import { setWebdavCredentials, scanAll, setServerLastScan, cancelScan } from "./metadataScanner"
import { shouldKeepPushPending, shouldSkipBeforePut, classifyRowForPush } from "./pushReconcile"
import { cachedLibraryUsable } from "./syncCachePolicy"
import { planNavidromeLoad } from "./navidromeLoadPlan"
import { effectiveLowData } from "./networkMode"
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

class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NotFoundError"
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

async function webdavGet(
  baseUrl: string,
  filePath: string,
  user: string,
  token: string,
): Promise<{ data: ArrayBuffer; etag?: string }> {
  const url = buildWebdavUrl(baseUrl, filePath)
  const res = await webdavFetch(url, {
    method: "GET",
    headers: authHeaders(user, token),
  }, WEBDAV_TIMEOUT)
  if (!res.ok) {
    if (res.status === 404 || res.status === 410) throw new NotFoundError(`File gone (${res.status}) for ${filePath}`)
    throw new Error(`WebDAV GET failed (${res.status}) for ${filePath}`)
  }
  return {
    data: await res.arrayBuffer(),
    etag: res.headers.get("ETag") ?? undefined,
  }
}

/**
 * Thin adapter: binds the pure `webdavPutAtomic` (`webdavAtomicWrite.ts`) to
 * the app's real `webdavFetch` transport (native → CapacitorHttp, web →
 * fetch, §3.3). All policy — the exactly-once temp cleanup, If-Match
 * forwarding, ConflictError-on-412 — lives in the pure module and is pinned
 * by tests/webdavAtomicWrite.test.ts; this wrapper carries no logic of its
 * own beyond argument order.
 */
function webdavPutAtomicViaAppFetch(
  baseUrl: string,
  filePath: string,
  data: ArrayBuffer,
  user: string,
  token: string,
  etag?: string,
): Promise<void> {
  return webdavPutAtomic(baseUrl, filePath, data, user, token, etag, webdavFetch, WEBDAV_TIMEOUT)
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
  return navidromeTestConnection(config)
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
  const baseKey = `${config.baseUrl.trim()}|${config.username.trim()}`

  const connection = await navidromeTestConnection(config)
  if (!connection.connected) {
    // Server unreachable / auth failed — serve the cached library for this
    // server so an offline startup or transient outage keeps the catalog
    // browsable (the library + metadata seeding are local-only). The error
    // stays on both the connection and loadResult so the UI reports the
    // stale-but-present source instead of silently passing off cache as live.
    const cached = await getSongLibraryCache()
    if (cached && cachedLibraryUsable(cached, baseKey)) {
      navidromeSetCachedConfig(config)
      return {
        connection,
        songs: cached.tracks,
        loadResult: { loaded: cached.tracks.length, failed: 0, cached: true, error: connection.error },
        lastScan: cached.lastScan,
      }
    }
    return { connection, songs: [], loadResult: { loaded: 0, failed: 0, error: connection.error } }
  }

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
  if (cached && cachedLibraryUsable(cached, baseKey, { forceRefresh, lastScan, requireFreshScan: true })) {
    navidromeSetCachedConfig(config)
    return {
      connection,
      songs: cached.tracks,
      loadResult: { loaded: cached.tracks.length, failed: 0, cached: true },
      lastScan,
    }
  }

  const { songs, result } = await navidromeLoadSongs(config, { isCancelled: opts.isCancelled })

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
        loadResult: { loaded: cached.tracks.length, failed: 0, cached: true, error: result.error },
        lastScan,
      }
    }
  }

  if (songs.length > 0) {
    await saveSongLibraryCache({ tracks: songs, lastScan, baseKey })
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
    online: typeof navigator === 'undefined' || navigator.onLine !== false,
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
    return { ...result, loadResult: { ...result.loadResult, error: 'Load cancelled', cancelled: true } }
  }
  if (!plan.applyLibrary) return result

  setLibrary(plan.tracks)
  initMetadataForTracks(plan.tracks)
  if (plan.seedFeedback) seedNavidromeFeedback(plan.tracks)
  if (plan.lastScan) setServerLastScan(plan.lastScan)

  if (plan.configureWebdav) {
    setWebdavCredentials(s.webdavUrl!, s.webdavUser!, s.webdavToken!)
    // Skip the automatic scan when the device is offline (navigator.onLine is
    // reliable on web; the scan already degrades safely if it ever lies) so an
    // offline startup doesn't fire a doomed PROPFIND and paint a scan error.
    if (plan.scanWebdav) {
      // scanAll probes the server itself (refreshIndex) — no ensureIndex
      // pre-call, or the connect would issue two PROPFINDs.
      void scanAll('modified').catch(() => {})
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
  /** True when the run ended because the user cancelled it (not an error).
   *  Row-atomic by construction: rows pushed before the cancel stay pushed
   *  and synced; the rest stay pending_sync for the next Push. */
  cancelled: boolean
}

export async function runManualWebDAVSync(
  opts: {
    /** Called after each row settles (success, skip, or failure) with the
     *  1-based index and the track title — the dialog's progress line. */
    onProgress?: (done: number, total: number, title: string) => void
    isCancelled?: () => boolean
  } = {},
): Promise<WebdavSyncResult> {
  const webdavUrl = await getSetting<string>("webdavUrl")
  const webdavUser = await getSetting<string>("webdavUser")
  const webdavToken = await getSetting<string>("webdavToken")

  if (!webdavUrl || !webdavUser || !webdavToken) {
    throw new Error("WebDAV credentials not configured")
  }

  const pending = await getPendingSyncMetadata()
  if (pending.length === 0) return { synced: 0, failed: 0, skipped: 0, wrongServer: 0, blindOverwrite: 0, cancelled: false }
  const total = pending.length
  let settled = 0
  let cancelledRun = false

  // Same derivation as the scan's stamp (webdavUtils.webdavBaseKey) — a raw
  // template here used to diverge on stray whitespace and flag every row
  // "Server URL updated" (TODO 3.5).
  const currentBaseKey = webdavBaseKey(webdavUrl, webdavUser)
  // The cache row's fileType can be stale (coerced to 'mp3' by older mappers);
  // the library Track is authoritative for the tag-write format branch.
  const libTracks = new Map(get(library).map((t) => [t.trackId, t]))
  const fileTypeOf = (trackId: string, fallback: string): string =>
    libTracks.get(trackId)?.fileType ?? fallback
  // Metadata rows carry no title; the library Track does.
  const titleOf = (trackId: string): string => libTracks.get(trackId)?.title ?? trackId
  let synced = 0
  let failed = 0
  let skipped = 0
  let wrongServer = 0
  let blindOverwrite = 0
  const pushedPaths = new Set<string>()

  for (const track of pending) {
    // Cancel between rows only: a row in flight always completes (its write
    // is atomic — temp PUT + MOVE), so a cancel never leaves a half-written
    // file; rows pushed before the cancel stay pushed, the rest stay pending.
    if (!cancelledRun && opts.isCancelled?.()) {
      cancelledRun = true
      opts.onProgress?.(settled, total, `Cancelled — stopped before "${titleOf(track.trackId)}"`)
    }
    if (cancelledRun) break

    // The ONE classification, shared with the Push confirmation dialog's safe
    // count (pushReconcile.classifyRowForPush) — buckets and precedence
    // documented there. no-path / ignored / no-base → skipped; wrong-server
    // → its own count so the UI can say which case happened.
    const bucket = classifyRowForPush(track, currentBaseKey)
    if (bucket !== 'pushable') {
      // wrong-server gets its own count so the UI can say which case
      // happened; no-path / ignored / no-base all surface as skipped.
      if (bucket === 'wrong-server') wrongServer++
      else skipped++
      settled++
      opts.onProgress?.(settled, total, titleOf(track.trackId))
      continue
    }

    // The classifier guarantees a pushable row has a stamped path.
    const davPath = track.webdavPath!
    // Two rows can still legally target one file (legacy force-binds, or two
    // auto rows resolving to the same path). Once a path was written this
    // run, later rows for it are skipped — otherwise the second PUT would
    // clobber the first's tags and both would end "synced". First writer
    // wins; the row stays pending and surfaces again on the next Push.
    if (pushedPaths.has(davPath)) {
      skipped++
      settled++
      opts.onProgress?.(settled, total, titleOf(track.trackId))
      continue
    }
    pushedPaths.add(davPath)

    try {
      // The loop-start snapshot may be stale: a mid-push re-bind (new path),
      // dismissal, path clear, or credential swap must not write tags to the
      // OLD file — the POST-PUT re-pend cannot undo the write (3.9). Re-check
      // the LIVE row before the PUT and skip (un-marking the path) instead.
      const liveBefore = get(metadataCache).get(track.trackId)
      if (shouldSkipBeforePut(track, liveBefore, currentBaseKey)) {
        pushedPaths.delete(davPath)
        skipped++
        continue
      }
      // GET with ETag for concurrency detection. A server that sends no ETag
      // leaves the MOVE a blind overwrite (no If-Match) — count it so the
      // result line surfaces the loss of concurrency protection (TODO 3.8b).
      const { data: raw, etag } = await webdavGet(webdavUrl, davPath, webdavUser, webdavToken)
      // In-flight event: position = this row's queue slot (settled + 1).
      opts.onProgress?.(settled + 1, total, titleOf(track.trackId))
      const modified = await modifyMetadataBuffer(raw, track.rating, track.loved, fileTypeOf(track.trackId, track.fileType))
      let blind = !etag

      try {
        await webdavPutAtomicViaAppFetch(webdavUrl, davPath, modified, webdavUser, webdavToken, etag)
      } catch (err) {
        if (err instanceof ConflictError) {
          // Re-check the live row once more — the retry's re-PUT has the same
          // stale-snapshot hazard as the first attempt.
          const liveRetry = get(metadataCache).get(track.trackId)
          if (shouldSkipBeforePut(track, liveRetry, currentBaseKey)) {
            pushedPaths.delete(davPath)
            skipped++
            continue
          }
          // File changed since we read it — re-read, re-apply, retry once
          const { data: refreshed, etag: newEtag } = await webdavGet(
            webdavUrl, davPath, webdavUser, webdavToken,
          )
          const reModified = await modifyMetadataBuffer(
            refreshed, track.rating, track.loved, fileTypeOf(track.trackId, track.fileType),
          )
          blind = !newEtag
          await webdavPutAtomicViaAppFetch(webdavUrl, davPath, reModified, webdavUser, webdavToken, newEtag)
        } else {
          throw err
        }
      }
      if (blind) blindOverwrite++

      // The user may have re-edited rating/loved (or re-bound the row / had a
      // comment land) while the GET→PUT was in flight: the pushed snapshot is
      // stale by now. Keep the newer pending edit pending (it surfaces in the
      // next Push) instead of flattening it to 'synced' with the stale values
      // — flattening writes the whole snapshot back and would lose the live
      // edit (3.1).
      const latest = get(metadataCache).get(track.trackId)
      if (latest && shouldKeepPushPending(track, latest)) {
        await upsertMetadata(latest)
        metadataCache.update((map) => {
          const next = new Map(map)
          next.set(track.trackId, latest)
          return next
        })
      } else {
        const syncedRow = { ...track, syncStatus: "synced" as const }
        await upsertMetadata(syncedRow)
        // Keep the in-memory cache in step, or the row stays pending_sync until
        // the next scan/reload.
        metadataCache.update((map) => {
          const next = new Map(map)
          next.set(track.trackId, syncedRow)
          return next
        })
      }
      synced++
    } catch (err) {
      // The file vanished between scan and push — not a failure of the push
      // itself; the next scan will clear the stale path (missing count).
      if (err instanceof NotFoundError) skipped++
      else failed++
    } finally {
      // Exactly one settle event per row, whichever way it ended (synced,
      // skipped, or failed).
      settled++
      opts.onProgress?.(settled, total, titleOf(track.trackId))
    }
  }

  // A cancel landing during the LAST row's flight never sees a top-of-loop
  // check — observe it here so the result still reports the user's intent.
  if (!cancelledRun && opts.isCancelled?.()) cancelledRun = true

  if (synced > 0) {
    try {
      await triggerNavidromeScan()
    } catch {
    }
  }

  return { synced, failed, skipped, wrongServer, blindOverwrite, cancelled: cancelledRun }
}

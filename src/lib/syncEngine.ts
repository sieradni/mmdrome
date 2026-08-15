import { get } from "svelte/store"
import { webdavFetch, authHeaders, buildWebdavUrl } from "./webdavUtils"
import { getPendingSyncMetadata, upsertMetadata, getSetting, getSongLibraryCache, saveSongLibraryCache } from "$lib/db"
import { modifyMetadataBuffer } from "$lib/tagWriter"
import { metadataCache, settings, library, setLibrary, initMetadataForTracks, seedNavidromeFeedback } from "../stores/appState"
import { setWebdavCredentials, scanAll, setServerLastScan } from "./metadataScanner"
import { shouldKeepPushPending, shouldSkipBeforePut } from "./pushReconcile"
import { cachedLibraryUsable } from "./syncCachePolicy"
import {
  testNavidromeConnection as navidromeTestConnection,
  loadNavidromeSongs as navidromeLoadSongs,
  triggerNavidromeScan as navidromeTriggerScan,
  testWebdavConnection as webdavTestConnection,
  getScanStatus as navidromeGetScanStatus,
  setCachedConfig as navidromeSetCachedConfig,
  navidromeSongToTrack,
  type NavidromeConfig,
  type NavidromeConnectionStatus,
  type NavidromeConnectResult,
} from "$lib/navidromeApi"

const WEBDAV_TIMEOUT = 60000

class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConflictError"
  }
}

class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NotFoundError"
  }
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

async function webdavPutAtomic(
  baseUrl: string,
  filePath: string,
  data: ArrayBuffer,
  user: string,
  token: string,
  etag?: string,
): Promise<void> {
  const tempPath = `${filePath}.mmdrome-tmp`
  const headers = authHeaders(user, token)

  // Write to temp file first — original untouched if this fails
  const putRes = await webdavFetch(buildWebdavUrl(baseUrl, tempPath), {
    method: "PUT",
    headers: {
      ...headers,
      "Content-Type": "application/octet-stream",
    },
    body: data,
  }, WEBDAV_TIMEOUT)
  if (!putRes.ok) throw new Error(`WebDAV PUT to temp failed (${putRes.status}) for ${filePath}`)

  // Atomically replace via MOVE with optional concurrency check
  const destUrl = buildWebdavUrl(baseUrl, filePath)
  const moveHeaders: Record<string, string> = {
    ...headers,
    Destination: destUrl,
    Overwrite: "T",
  }
  if (etag) moveHeaders["If-Match"] = etag

  try {
    const moveRes = await webdavFetch(buildWebdavUrl(baseUrl, tempPath), {
      method: "MOVE",
      headers: moveHeaders,
    }, WEBDAV_TIMEOUT)

    if (!moveRes.ok) {
      // Clean up temp file on MOVE failure
      await webdavFetch(buildWebdavUrl(baseUrl, tempPath), {
        method: "DELETE",
        headers,
      }, WEBDAV_TIMEOUT).catch(() => {})
      if (moveRes.status === 412) throw new ConflictError(`File changed since GET for ${filePath}`)
      throw new Error(`WebDAV MOVE failed (${moveRes.status}) for ${filePath}`)
    }
  } catch (err) {
    // Attempt cleanup on any error (CORS failure, network error, etc.)
    await webdavFetch(buildWebdavUrl(baseUrl, tempPath), {
      method: "DELETE",
      headers,
    }, WEBDAV_TIMEOUT).catch(() => {})
    throw err
  }
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

export async function connectNavidrome(forceRefresh = false): Promise<NavidromeConnectResult> {
  const config = await getNavidromeConfig()
  if (!config) {
    return {
      connection: { connected: false, error: "Navidrome credentials not configured" },
      songs: [],
      loadResult: { loaded: 0, failed: 0, error: "Navidrome credentials not configured" },
    }
  }

  const baseKey = `${config.baseUrl}|${config.username}`

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

  const { songs, result } = await navidromeLoadSongs(config)

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
  const result = await connectNavidrome(forceRefresh)

  // Both an offline/cached fallback AND a live failure with no usable songs
  // return without songs; only the former may proceed below (songs present).
  if (!result.connection.connected && result.songs.length === 0) return result

  // A failed load with nothing usable must NOT replace the in-memory library:
  // setLibrary would reconcile the queue against the empty/partial set and
  // wipe it. (A failed load that fell back to the cached snapshot carries
  // songs and IS applied — they're valid.) A genuinely empty server (success,
  // zero songs) still replaces — that's the truth.
  if (result.loadResult.error && result.songs.length === 0) return result

  const tracks = result.songs.map(navidromeSongToTrack)
  setLibrary(tracks)
  initMetadataForTracks(tracks)
  seedNavidromeFeedback(tracks)
  if (result.lastScan) setServerLastScan(result.lastScan)

  const s = get(settings)
  if (s.webdavUrl && s.webdavUser && s.webdavToken) {
    setWebdavCredentials(s.webdavUrl, s.webdavUser, s.webdavToken)
    // Skip the automatic scan when the device is offline (navigator.onLine is
    // reliable on web; the scan already degrades safely if it ever lies) so an
    // offline startup doesn't fire a doomed PROPFIND and paint a scan error.
    if (typeof navigator === 'undefined' || navigator.onLine !== false) {
      // scanAll probes the server itself (refreshIndex) — no ensureIndex
      // pre-call, or the connect would issue two PROPFINDs.
      void scanAll('modified').catch(() => {})
    }
  }

  return result
}

export async function runManualWebDAVSync(): Promise<{ synced: number; failed: number; skipped: number; wrongServer: number }> {
  const webdavUrl = await getSetting<string>("webdavUrl")
  const webdavUser = await getSetting<string>("webdavUser")
  const webdavToken = await getSetting<string>("webdavToken")

  if (!webdavUrl || !webdavUser || !webdavToken) {
    throw new Error("WebDAV credentials not configured")
  }

  const pending = await getPendingSyncMetadata()
  if (pending.length === 0) return { synced: 0, failed: 0, skipped: 0, wrongServer: 0 }

  const currentBaseKey = `${webdavUrl}|${webdavUser}`
  // The cache row's fileType can be stale (coerced to 'mp3' by older mappers);
  // the library Track is authoritative for the tag-write format branch.
  const libTracks = new Map(get(library).map((t) => [t.trackId, t]))
  const fileTypeOf = (trackId: string, fallback: string): string =>
    libTracks.get(trackId)?.fileType ?? fallback
  let synced = 0
  let failed = 0
  let skipped = 0
  let wrongServer = 0
  const pushedPaths = new Set<string>()

  for (const track of pending) {
    // Never fabricate a WebDAV path from the Navidrome id: without a matched
    // file there is nothing to write to — report it as skipped instead of
    // failing loudly. Rows without a webdavBase were matched before base
    // stamping existed — their path's provenance is unknown, so they are
    // skipped (unverified), while a base that differs from the current server
    // is counted separately so the UI can say which case happened.
    if (!track.webdavPath) {
      skipped++
      continue
    }
    if (track.ignored) {
      // User dismissed this track via File Matching ("not on this server") —
      // never push it, even if a path is still stamped.
      skipped++
      continue
    }
    if (track.webdavBase !== currentBaseKey) {
      if (!track.webdavBase) {
        skipped++
      } else {
        wrongServer++
      }
      continue
    }

    const davPath = track.webdavPath
    // Two rows can still legally target one file (legacy force-binds, or two
    // auto rows resolving to the same path). Once a path was written this
    // run, later rows for it are skipped — otherwise the second PUT would
    // clobber the first's tags and both would end "synced". First writer
    // wins; the row stays pending and surfaces again on the next Push.
    if (pushedPaths.has(davPath)) {
      skipped++
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
      // GET with ETag for concurrency detection
      const { data: raw, etag } = await webdavGet(webdavUrl, davPath, webdavUser, webdavToken)
      const modified = await modifyMetadataBuffer(raw, track.rating, track.loved, fileTypeOf(track.trackId, track.fileType))

      try {
        await webdavPutAtomic(webdavUrl, davPath, modified, webdavUser, webdavToken, etag)
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
          await webdavPutAtomic(webdavUrl, davPath, reModified, webdavUser, webdavToken, newEtag)
        } else {
          throw err
        }
      }

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
    }
  }

  if (synced > 0) {
    try {
      await triggerNavidromeScan()
    } catch {
    }
  }

  return { synced, failed, skipped, wrongServer }
}

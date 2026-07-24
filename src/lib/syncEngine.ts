import { getPendingSyncMetadata, upsertMetadata, getSetting, getSongLibraryCache, saveSongLibraryCache } from "$lib/db"
import { modifyMetadataBuffer } from "$lib/tagWriter"
import {
  testNavidromeConnection as navidromeTestConnection,
  loadNavidromeSongs as navidromeLoadSongs,
  triggerNavidromeScan as navidromeTriggerScan,
  testWebdavConnection as webdavTestConnection,
  connectNavidrome as navidromeConnect,
  getScanStatus as navidromeGetScanStatus,
  setCachedConfig as navidromeSetCachedConfig,
  type NavidromeConfig,
  type NavidromeConnectionStatus,
  type NavidromeLoadResult,
  type NavidromeSong,
  type NavidromeConnectResult,
} from "$lib/navidromeApi"

function webdavAuthHeaders(user: string, token: string): Record<string, string> {
  return {
    Authorization: `Basic ${btoa(`${user}:${token}`)}`,
  }
}

function buildWebdavUrl(baseUrl: string, filePath: string): string {
  const encodedPath = filePath.split("/").map((s) => encodeURIComponent(s)).join("/")
  return `${baseUrl.replace(/\/+$/, "")}/${encodedPath.replace(/^\/+/, "")}`
}

class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConflictError"
  }
}

async function webdavGet(
  baseUrl: string,
  filePath: string,
  user: string,
  token: string,
): Promise<{ data: ArrayBuffer; etag?: string }> {
  const url = buildWebdavUrl(baseUrl, filePath)
  const res = await fetch(url, {
    method: "GET",
    headers: webdavAuthHeaders(user, token),
  })
  if (!res.ok) throw new Error(`WebDAV GET failed (${res.status}) for ${filePath}`)
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
  const authHeaders = webdavAuthHeaders(user, token)

  // Write to temp file first — original untouched if this fails
  const putRes = await fetch(buildWebdavUrl(baseUrl, tempPath), {
    method: "PUT",
    headers: {
      ...authHeaders,
      "Content-Type": "application/octet-stream",
    },
    body: data,
  })
  if (!putRes.ok) throw new Error(`WebDAV PUT to temp failed (${putRes.status}) for ${filePath}`)

  // Atomically replace via MOVE with optional concurrency check
  const destUrl = buildWebdavUrl(baseUrl, filePath)
  const moveHeaders: Record<string, string> = {
    ...authHeaders,
    Destination: destUrl,
    Overwrite: "T",
  }
  if (etag) moveHeaders["If-Match"] = etag

  const moveRes = await fetch(buildWebdavUrl(baseUrl, tempPath), {
    method: "MOVE",
    headers: moveHeaders,
  })

  // Clean up temp file on MOVE failure
  if (!moveRes.ok) {
    await fetch(buildWebdavUrl(baseUrl, tempPath), {
      method: "DELETE",
      headers: authHeaders,
    }).catch(() => {})
    if (moveRes.status === 412) throw new ConflictError(`File changed since GET for ${filePath}`)
    throw new Error(`WebDAV MOVE failed (${moveRes.status}) for ${filePath}`)
  }
}

async function getNavidromeConfig(): Promise<NavidromeConfig | null> {
  const navidromeUrl = await getSetting<string>("navidromeUrl")
  const navidromeUser = await getSetting<string>("navidromeUser")
  const navidromePassword = await getSetting<string>("navidromePassword")

  if (!navidromeUrl || !navidromeUser || !navidromePassword) return null

  return {
    baseUrl: navidromeUrl,
    username: navidromeUser,
    password: navidromePassword,
  }
}

export async function testNavidromeConnection(): Promise<NavidromeConnectionStatus> {
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

export async function loadNavidromeSongs(): Promise<{ songs: NavidromeSong[]; result: NavidromeLoadResult }> {
  const config = await getNavidromeConfig()
  if (!config) {
    return { songs: [], result: { loaded: 0, failed: 0, error: "Navidrome credentials not configured" } }
  }
  return navidromeLoadSongs(config)
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

  const connection = await navidromeTestConnection(config)
  if (!connection.connected) {
    return { connection, songs: [], loadResult: { loaded: 0, failed: 0, error: connection.error } }
  }

  let lastScan = ""
  try {
    const scanStatus = await navidromeGetScanStatus(config)
    lastScan = scanStatus.lastScan
  } catch {
    // if scan status fails, proceed without caching
  }

  if (!forceRefresh && lastScan) {
    const cached = await getSongLibraryCache()
    if (cached && cached.lastScan === lastScan && cached.tracks.length > 0) {
      navidromeSetCachedConfig(config)
      return {
        connection,
        songs: cached.tracks,
        loadResult: { loaded: cached.tracks.length, failed: 0, cached: true },
        lastScan,
      }
    }
  }

  const { songs, result } = await navidromeLoadSongs(config)

  if (songs.length > 0 && lastScan) {
    await saveSongLibraryCache({ tracks: songs, lastScan })
  }

  return { connection, songs, loadResult: result, lastScan }
}

export async function runManualWebDAVSync(): Promise<{ synced: number; failed: number }> {
  const webdavUrl = await getSetting<string>("webdavUrl")
  const webdavUser = await getSetting<string>("webdavUser")
  const webdavToken = await getSetting<string>("webdavToken")

  if (!webdavUrl || !webdavUser || !webdavToken) {
    throw new Error("WebDAV credentials not configured")
  }

  const pending = await getPendingSyncMetadata()
  if (pending.length === 0) return { synced: 0, failed: 0 }

  let synced = 0
  let failed = 0

  for (const track of pending) {
    try {
      const davPath = track.webdavPath || track.filePath

      // GET with ETag for concurrency detection
      const { data: raw, etag } = await webdavGet(webdavUrl, davPath, webdavUser, webdavToken)
      const modified = await modifyMetadataBuffer(raw, track.rating, track.loved, track.fileType)

      try {
        await webdavPutAtomic(webdavUrl, davPath, modified, webdavUser, webdavToken, etag)
      } catch (err) {
        if (err instanceof ConflictError) {
          // File changed since we read it — re-read, re-apply, retry once
          const { data: refreshed, etag: newEtag } = await webdavGet(
            webdavUrl, davPath, webdavUser, webdavToken,
          )
          const reModified = await modifyMetadataBuffer(
            refreshed, track.rating, track.loved, track.fileType,
          )
          await webdavPutAtomic(webdavUrl, davPath, reModified, webdavUser, webdavToken, newEtag)
        } else {
          throw err
        }
      }

      await upsertMetadata({ ...track, syncStatus: "synced" })
      synced++
    } catch {
      failed++
    }
  }

  if (synced > 0) {
    try {
      await triggerNavidromeScan()
    } catch {
    }
  }

  return { synced, failed }
}

import { getPendingSyncMetadata, upsertMetadata, getSetting } from "$lib/db"
import { modifyMetadataBuffer } from "$lib/tagWriter"
import {
  testNavidromeConnection as navidromeTestConnection,
  loadNavidromeSongs as navidromeLoadSongs,
  triggerNavidromeScan as navidromeTriggerScan,
  testWebdavConnection as webdavTestConnection,
  connectNavidrome as navidromeConnect,
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

async function webdavGet(
  baseUrl: string,
  filePath: string,
  user: string,
  token: string,
): Promise<ArrayBuffer> {
  const url = `${baseUrl.replace(/\/+$/, "")}/${filePath.replace(/^\/+/, "")}`
  const res = await fetch(url, {
    method: "GET",
    headers: webdavAuthHeaders(user, token),
  })
  if (!res.ok) throw new Error(`WebDAV GET failed (${res.status}) for ${filePath}`)
  return res.arrayBuffer()
}

async function webdavPut(
  baseUrl: string,
  filePath: string,
  data: ArrayBuffer,
  user: string,
  token: string,
): Promise<void> {
  const url = `${baseUrl.replace(/\/+$/, "")}/${filePath.replace(/^\/+/, "")}`
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      ...webdavAuthHeaders(user, token),
      "Content-Type": "application/octet-stream",
    },
    body: data,
  })
  if (!res.ok) throw new Error(`WebDAV PUT failed (${res.status}) for ${filePath}`)
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

export async function connectNavidrome(): Promise<NavidromeConnectResult> {
  const config = await getNavidromeConfig()
  if (!config) {
    return {
      connection: { connected: false, error: "Navidrome credentials not configured" },
      songs: [],
      loadResult: { loaded: 0, failed: 0, error: "Navidrome credentials not configured" },
    }
  }
  return navidromeConnect(config)
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
      const raw = await webdavGet(webdavUrl, davPath, webdavUser, webdavToken)
      const modified = await modifyMetadataBuffer(raw, track.rating, track.loved, track.fileType)
      await webdavPut(webdavUrl, track.filePath, modified, webdavUser, webdavToken)
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

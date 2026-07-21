import { getPendingSyncMetadata, upsertMetadata, getSetting } from "$lib/db"
import { modifyMetadataBuffer } from "$lib/tagWriter"

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

async function triggerNavidromeScan(
  navidromeUrl: string,
  navidromeToken: string,
): Promise<void> {
  const url = `${navidromeUrl.replace(/\/+$/, "")}/api/force-scan`
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${navidromeToken}`,
    },
  })
  if (!res.ok) throw new Error(`Navidrome forceScan failed (${res.status})`)
}

export async function runManualWebDAVSync(): Promise<{ synced: number; failed: number }> {
  const webdavUrl = await getSetting<string>("webdavUrl")
  const webdavUser = await getSetting<string>("webdavUser")
  const webdavToken = await getSetting<string>("webdavToken")
  const navidromeUrl = await getSetting<string>("navidromeUrl")
  const navidromeToken = await getSetting<string>("navidromeToken")

  if (!webdavUrl || !webdavUser || !webdavToken) {
    throw new Error("WebDAV credentials not configured")
  }

  const pending = await getPendingSyncMetadata()
  if (pending.length === 0) return { synced: 0, failed: 0 }

  let synced = 0
  let failed = 0

  for (const track of pending) {
    try {
      const raw = await webdavGet(webdavUrl, track.filePath, webdavUser, webdavToken)
      const modified = await modifyMetadataBuffer(raw, track.rating, track.loved, track.fileType)
      await webdavPut(webdavUrl, track.filePath, modified, webdavUser, webdavToken)
      await upsertMetadata({ ...track, syncStatus: "synced" })
      synced++
    } catch (err) {
      failed++
    }
  }

  if (synced > 0 && navidromeUrl && navidromeToken) {
    await triggerNavidromeScan(navidromeUrl, navidromeToken)
  }

  return { synced, failed }
}

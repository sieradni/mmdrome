import { get } from 'svelte/store'
import { library, metadataCache, settings } from '../stores/appState'
import type { Track } from '../stores/appState'
import type { LocalMetadataStore } from './db'
import { getNavidromeSong, type NavidromeConfig, type NavidromeSong } from './navidromeApi'
import { refreshIndex } from './metadataScanner'
import { matchTrackToWebdav, readMetadataChunk, extractRawTagProperties } from './metadataReader'
import { getWebdavFileIndex } from './db'

export interface DebugTrackData {
  track: Track
  cachedMeta: LocalMetadataStore | undefined
  navidromeSong: NavidromeSong | null
  navidromeError: string | null
  webdavMatch: { path: string; filename: string; size: number } | null
  webdavMatchError: string | null
  webdavRawMetadata: Record<string, unknown> | null
  webdavMetadataError: string | null
}

export async function debugFetchTrackData(trackId: string): Promise<DebugTrackData> {
  const tracks = get(library)
  const track = tracks.find((t) => t.trackId === trackId)
  if (!track) {
    throw new Error(`Track not found: ${trackId}`)
  }

  const cache = get(metadataCache)
  const cachedMeta = cache.get(trackId)

  const s = get(settings)
  const navidromeUrl = s.navidromeUrl
  const navidromeUser = s.navidromeUser
  const navidromePassword = s.navidromePassword

  let navidromeSong: NavidromeSong | null = null
  let navidromeError: string | null = null

  if (navidromeUrl && navidromeUser && navidromePassword) {
    try {
      navidromeSong = await getNavidromeSong(
        { baseUrl: navidromeUrl, username: navidromeUser, password: navidromePassword },
        track.trackId.replace(/^navidrome-/, ''),
      )
    } catch (err) {
      navidromeError = (err as Error).message
    }
  } else {
    navidromeError = 'Navidrome credentials not configured'
  }

  let webdavMatch: { path: string; filename: string; size: number } | null = null
  let webdavMatchError: string | null = null
  let webdavRawMetadata: Record<string, unknown> | null = null
  let webdavMetadataError: string | null = null

  const webdavUrl = s.webdavUrl
  const webdavUser = s.webdavUser
  const webdavToken = s.webdavToken

  if (webdavUrl && webdavUser && webdavToken) {
    try {
      const refreshed = await refreshIndex()
      const index = refreshed ? await getWebdavFileIndex() : undefined
      const entries = index?.entries ?? []

      const match = matchTrackToWebdav(track, entries)
      if (match.entry && !match.ambiguous) {
        webdavMatch = { path: match.entry.path, filename: match.entry.filename, size: match.entry.size }

        try {
          const maxChunkSize = 8388608
          let chunkSize = 262144
          while (true) {
            const buffer = await readMetadataChunk(webdavUrl, match.entry.path, webdavUser, webdavToken, track.fileType, chunkSize)
            const gotFullFile = buffer.byteLength < chunkSize
            try {
              webdavRawMetadata = await extractRawTagProperties(buffer)
              break
            } catch (err) {
              if (chunkSize >= maxChunkSize || gotFullFile) throw err
              chunkSize *= 2
            }
          }
        } catch (err) {
          webdavMetadataError = (err as Error).message
        }
      } else {
        webdavMatchError = 'No matching WebDAV file found'
      }
    } catch (err) {
      webdavMatchError = (err as Error).message
    }
  } else {
    webdavMatchError = 'WebDAV credentials not configured'
  }

  return {
    track,
    cachedMeta,
    navidromeSong,
    navidromeError,
    webdavMatch,
    webdavMatchError,
    webdavRawMetadata,
    webdavMetadataError,
  }
}

import type { Track } from '../stores/appState'

const API_VERSION = '1.16.1'
const CLIENT_NAME = 'mmdrome'

export interface SubsonicResponseData {
  'status': 'ok' | 'failed'
  'version': string
  'serverVersion'?: string
  'musicFolderCount'?: number
  error?: {
    'code': number
    'message': string
  }
  [key: string]: any
}

export interface SubsonicError extends Error {
  code: number
  subsonicCode: number
}

export interface NavidromeSong {
  id: string
  title: string
  artist: string
  album: string
  year?: number
  duration: number
  track?: number
  discNumber?: number
  genre?: string
  bitRate?: number
  size?: number
  suffix?: string
  contentType?: string
  artistId?: string
  albumId?: string
  created?: string
  albumArtist?: string
  composer?: string
  performer?: string
  lyricist?: string
  writer?: string
  producer?: string
  conductor?: string
  orchestra?: string
  arranger?: string
  disc?: number
  totalDiscs?: number
  explicit?: boolean
  streamId?: string
  path?: string
}

export interface NavidromeArtist {
  id: string
  name: string
  albumCount?: number
}

export interface NavidromeAlbum {
  id: string
  name: string
  artist: string
  artistId?: string
  year?: number
  genre?: string
  songCount?: number
  duration?: number
  created?: string
}

export interface NavidromeConnectionStatus {
  connected: boolean
  serverVersion?: string
  username?: string
  error?: string
}

export interface NavidromeLoadResult {
  loaded: number
  failed: number
  error?: string
}

export interface NavidromeConfig {
  baseUrl: string
  username: string
  password: string
}

function generateSalt(length: number = 16): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let result = ''
  const cryptoObj = globalThis.crypto
  if (cryptoObj && cryptoObj.getRandomValues) {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(length))
    for (let i = 0; i < length; i++) {
      result += chars[bytes[i] % chars.length]
    }
  } else {
    for (let i = 0; i < length; i++) {
      result += chars[Math.floor(Math.random() * chars.length)]
    }
  }
  return result
}

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]

const MD5_K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]

function md5(input: string): string {
  const data = new TextEncoder().encode(input)
  const len = data.length

  const paddedLen = Math.ceil((len + 9) / 64) * 64
  const bytes = new Uint8Array(paddedLen)
  bytes.set(data)
  bytes[len] = 0x80

  const bitLen = len * 8
  bytes[paddedLen - 8] = bitLen & 0xff
  bytes[paddedLen - 7] = (bitLen >>> 8) & 0xff
  bytes[paddedLen - 6] = (bitLen >>> 16) & 0xff
  bytes[paddedLen - 5] = (bitLen >>> 24) & 0xff

  const blocks = paddedLen / 64

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476

  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n))

  for (let blk = 0; blk < blocks; blk++) {
    const off = blk * 64
    const M = new Uint32Array(16)
    for (let i = 0; i < 16; i++) {
      M[i] = bytes[off + i * 4] | (bytes[off + i * 4 + 1] << 8) | (bytes[off + i * 4 + 2] << 16) | (bytes[off + i * 4 + 3] << 24)
    }

    let AA = a, BB = b, CC = c, DD = d

    for (let i = 0; i < 64; i++) {
      let f: number, g: number
      if (i < 16) { f = (b & c) | (~b & d); g = i }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16 }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16 }
      else { f = c ^ (b | ~d); g = (7 * i) % 16 }
      f = (f + a + MD5_K[i] + M[g]) >>> 0
      a = d; d = c; c = b; b = (b + rotl(f, MD5_S[i])) >>> 0
    }
    a = (a + AA) >>> 0; b = (b + BB) >>> 0; c = (c + CC) >>> 0; d = (d + DD) >>> 0
  }

  return [a, b, c, d].map(n => {
    const b0 = n & 0xff
    const b1 = (n >>> 8) & 0xff
    const b2 = (n >>> 16) & 0xff
    const b3 = (n >>> 24) & 0xff
    return b0.toString(16).padStart(2, '0') + b1.toString(16).padStart(2, '0') + b2.toString(16).padStart(2, '0') + b3.toString(16).padStart(2, '0')
  }).join('')
}

function buildAuthParams(username: string, password: string): Record<string, string> {
  const salt = generateSalt(16)
  const token = md5(password + salt)
  return {
    u: username,
    t: token,
    s: salt,
    v: API_VERSION,
    c: CLIENT_NAME,
    f: 'json',
  }
}

function normalizeUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function buildUrl(baseUrl: string, endpoint: string, params: Record<string, string | number>): string {
  const url = new URL(`${normalizeUrl(baseUrl)}/rest/${endpoint}`)
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, String(value))
  })
  return url.toString()
}

async function callSubsonic(
  config: NavidromeConfig,
  endpoint: string,
  extraParams: Record<string, string | number> = {},
): Promise<SubsonicResponseData> {
  const params = { ...buildAuthParams(config.username, config.password), ...extraParams }
  const url = buildUrl(config.baseUrl, endpoint, params)

  const res = await fetch(url, { method: 'GET' })

  if (!res.ok) {
    throw createSubsonicError(0, `HTTP ${res.status}: ${res.statusText}`)
  }

  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('text/xml') || contentType.includes('application/xml')) {
    throw createSubsonicError(0, 'Server returned XML instead of JSON. Check if the API endpoint is correct.')
  }

  let data: any
  try {
    data = await res.json()
  } catch {
    throw createSubsonicError(0, 'Failed to parse server response as JSON')
  }

  const response = data['subsonic-response']
  if (!response) {
    throw createSubsonicError(0, 'Invalid response: missing subsonic-response element')
  }

  if (response['status'] === 'failed') {
    const code = response.error?.['code'] ?? 0
    const message = response.error?.['message'] ?? 'Unknown error'
    throw createSubsonicError(code, message)
  }
  return response
}

function createSubsonicError(code: number, message: string): SubsonicError {
  const err = new Error(message) as SubsonicError
  err.code = code
  err.subsonicCode = code
  return err
}

export async function testNavidromeConnection(config: NavidromeConfig): Promise<NavidromeConnectionStatus> {
  try {
    const response = await callSubsonic(config, 'ping.view')
    return {
      connected: true,
      serverVersion: response['serverVersion'],
      username: config.username,
    }
  } catch (err) {
    const error = err as SubsonicError
    return {
      connected: false,
      error: error.message,
    }
  }
}

export interface NavidromeConnectResult {
  connection: NavidromeConnectionStatus
  songs: NavidromeSong[]
  loadResult: NavidromeLoadResult
}

export async function connectNavidrome(config: NavidromeConfig): Promise<NavidromeConnectResult> {
  const connection = await testNavidromeConnection(config)
  if (!connection.connected) {
    return {
      connection,
      songs: [],
      loadResult: { loaded: 0, failed: 0, error: connection.error },
    }
  }

  const { songs, result } = await loadNavidromeSongs(config)
  return { connection, songs, loadResult: result }
}

// ── In-memory config cache ──────────────────────────────────────────
let _cachedConfig: NavidromeConfig | null = null

export function getCachedConfig(): NavidromeConfig | null {
  return _cachedConfig
}

export function setCachedConfig(config: NavidromeConfig | null): void {
  _cachedConfig = config
}

export async function loadNavidromeSongs(config: NavidromeConfig): Promise<{ songs: NavidromeSong[]; result: NavidromeLoadResult }> {
  const songs: NavidromeSong[] = []
  let failed = 0

  try {
    _cachedConfig = config

    // Fetch all songs via search3 pagination (standard Subsonic endpoint)
    const PAGE_SIZE = 500
    let offset = 0
    while (true) {
      const resp = await callSubsonic(config, 'search3.view', {
        query: '',
        songCount: PAGE_SIZE,
        songOffset: offset,
        artistCount: 0,
        albumCount: 0,
      })
      const page: NavidromeSong[] = resp.searchResult3?.song ?? []
      if (!Array.isArray(page) || page.length === 0) break
      songs.push(...page)
      offset += page.length
      if (page.length < PAGE_SIZE) break
    }

    return { songs, result: { loaded: songs.length, failed } }
  } catch (err) {
    const error = err as SubsonicError
    return { songs: [], result: { loaded: 0, failed, error: error.message } }
  }
}

export function buildStreamUrl(config: NavidromeConfig, songId: string): string {
  const params = buildAuthParams(config.username, config.password)
  params.id = songId

  const url = new URL(`${normalizeUrl(config.baseUrl)}/rest/stream.view`)
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, String(value))
  })
  return url.toString()
}

export async function getNavidromeSongStreamUrl(config: NavidromeConfig, songId: string): Promise<string> {
  return buildStreamUrl(config, songId)
}

export function buildCoverArtUrl(config: NavidromeConfig, id: string, size?: number): string {
  const params = buildAuthParams(config.username, config.password)
  params.id = id
  if (size) params.size = String(size)

  const url = new URL(`${normalizeUrl(config.baseUrl)}/rest/getCoverArt.view`)
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, String(value))
  })
  return url.toString()
}

export function resolveCoverArtId(track: Track): string {
  return track.albumId || track.trackId.replace(/^navidrome-/, '')
}

export async function triggerNavidromeScan(config: NavidromeConfig): Promise<void> {
  await callSubsonic(config, 'startScan.view', { scanType: 'fast' })
}

export function navidromeSongToTrack(song: NavidromeSong): Track {
  const fileType = (song.suffix || song.contentType || 'mp3').toLowerCase().replace('.', '') as Track['fileType']
  const validTypes: Track['fileType'][] = ['mp3', 'flac', 'm4a', 'ogg', 'opus']
  const normalizedType = validTypes.includes(fileType as Track['fileType']) ? fileType as Track['fileType'] : 'mp3'

  return {
    trackId: `navidrome-${song.id}`,
    title: song.title || 'Unknown Title',
    artist: song.artist || song.albumArtist || 'Unknown Artist',
    album: song.album || 'Unknown Album',
    albumId: song.albumId,
    year: song.year,
    duration: song.duration || 0,
    filePath: song.id,
    fileType: normalizedType,
    composer: song.composer,
    bitrate: song.bitRate,
    size: song.size,
    createdAt: song.created ? new Date(song.created).getTime() : undefined,
    navidromePath: song.path,
  }
}

export async function testWebdavConnection(
  baseUrl: string,
  user: string,
  token: string,
): Promise<{ connected: boolean; error?: string }> {
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/`
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${btoa(`${user}:${token}`)}`,
      },
    })
    if (res.ok) {
      return { connected: true }
    }
    return { connected: false, error: `HTTP ${res.status}: ${res.statusText}` }
  } catch (err) {
    const error = err as Error
    return { connected: false, error: error.message }
  }
}

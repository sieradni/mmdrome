import type { Track } from '../stores/appState'
import { writable } from 'svelte/store'
import { webdavFetch } from './webdavUtils'

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

export interface ReplayGainValues {
  trackGain: number
  albumGain: number
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
  replayGain?: ReplayGainValues
  starred?: boolean | string
  userRating?: number
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
  cached?: boolean
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

let _cachedAuthUsername: string | null = null
let _cachedAuthPassword: string | null = null
let _cachedAuthSalt: string | null = null
let _cachedAuthToken: string | null = null

function buildAuthParams(username: string, password: string, jsonFormat = true): Record<string, string> {
  if (username !== _cachedAuthUsername || password !== _cachedAuthPassword) {
    _cachedAuthSalt = generateSalt(16)
    _cachedAuthToken = md5(password + _cachedAuthSalt)
    _cachedAuthUsername = username
    _cachedAuthPassword = password
  }
  const params: Record<string, string> = {
    u: username,
    t: _cachedAuthToken!,
    s: _cachedAuthSalt!,
    v: API_VERSION,
    c: CLIENT_NAME,
  }
  if (jsonFormat) params.f = 'json'
  return params
}

function normalizeUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

function buildUrl(baseUrl: string, endpoint: string, params: Record<string, string | number>): string {
  const url = new URL(`${normalizeUrl(baseUrl)}/rest/${endpoint}`)
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, String(value))
  })
  return url.toString()
}

/**
 * Builds a /rest URL that appends `pairs` after the single-valued `params`, so
 * repeated query keys (e.g. `id=` for Subsonic `star`/`unstar`) survive.
 */
function buildRepeatedUrl(baseUrl: string, endpoint: string, params: Record<string, string | number>, pairs: [string, string][]): string {
  const url = new URL(`${normalizeUrl(baseUrl)}/rest/${endpoint}`)
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, String(value))
  })
  pairs.forEach(([key, value]) => url.searchParams.append(key, value))
  return url.toString()
}

const FETCH_TIMEOUT = 30000

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer))
}

async function callSubsonic(
  config: NavidromeConfig,
  endpoint: string,
  extraParams: Record<string, string | number> = {},
): Promise<SubsonicResponseData> {
  return callSubsonicWithPairs(config, endpoint, extraParams, [])
}

/** Like {@link callSubsonic} but accepts repeated query keys for batch endpoints. */
async function callSubsonicWithPairs(
  config: NavidromeConfig,
  endpoint: string,
  extraParams: Record<string, string | number> = {},
  pairs: [string, string][] = [],
): Promise<SubsonicResponseData> {
  const params = { ...buildAuthParams(config.username, config.password), ...extraParams }
  const url = pairs.length > 0
    ? buildRepeatedUrl(config.baseUrl, endpoint, params, pairs)
    : buildUrl(config.baseUrl, endpoint, params)

  const res = await fetchWithTimeout(url, { method: 'GET' }, FETCH_TIMEOUT)

  if (!res.ok) {
    if (res.status === 0) throw createSubsonicError(0, 'Network request failed or timed out')
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
  lastScan?: string
}

// ── In-memory config cache ──────────────────────────────────────────
let _cachedConfig: NavidromeConfig | null = null
export const coverConfig = writable<NavidromeConfig | null>(null)

export function getCachedConfig(): NavidromeConfig | null {
  return _cachedConfig
}

export function setCachedConfig(config: NavidromeConfig | null): void {
  _cachedConfig = config
  coverConfig.set(config)
}

export async function loadNavidromeSongs(config: NavidromeConfig): Promise<{ songs: NavidromeSong[]; result: NavidromeLoadResult }> {
  const songs: NavidromeSong[] = []
  let failed = 0

  try {
    // Sets both _cachedConfig and coverConfig (the store LazyThumb gates on).
    // Without the store update, thumbnails stay blank after a first-ever connect
    // (empty library → fresh-load path never called setCachedConfig before).
    setCachedConfig(config)

    // Fetch all songs via search3 pagination (standard Subsonic endpoint).
    // The pure driver caps pages AND stops on a repeated first id, so a server
    // that ignores songOffset terminates instead of accumulating forever (3.3).
    songs.push(
      ...(await paginateSearch3(async (offset, count) => {
        const resp = await callSubsonic(config, 'search3.view', {
          query: '',
          songCount: count,
          songOffset: offset,
          artistCount: 0,
          albumCount: 0,
        })
        return resp.searchResult3?.song ?? []
      })),
    )

    return { songs, result: { loaded: songs.length, failed } }
  } catch (err) {
    const error = err as SubsonicError
    return { songs: [], result: { loaded: 0, failed, error: error.message } }
  }
}

/**
 * Pure pagination driver for `search3.view` (TODO 3.3). Fetches pages until a
 * short/empty tail, the page cap, or a repeated first id — an offset-ignoring
 * server returns the same page forever, so the first-id dedupe stops it after
 * one repeat instead of accumulating duplicate pages up to the cap.
 */
export async function paginateSearch3(
  fetchPage: (offset: number, count: number) => Promise<NavidromeSong[]>,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<NavidromeSong[]> {
  const pageSize = opts.pageSize ?? 500
  const maxPages = opts.maxPages ?? 200 // 100k songs at 500/page — a sane ceiling
  const songs: NavidromeSong[] = []
  const firstIds = new Set<string>()
  let offset = 0
  let pages = 0
  while (pages < maxPages) {
    const page = await fetchPage(offset, pageSize)
    if (!Array.isArray(page) || page.length === 0) break
    const firstId = page[0]?.id
    if (firstId !== undefined) {
      if (firstIds.has(firstId)) break
      firstIds.add(firstId)
    }
    songs.push(...page)
    offset += page.length
    pages++
    if (page.length < pageSize) break
  }
  return songs
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

export function buildCoverArtUrl(config: NavidromeConfig, id: string, size?: number): string {
  const params = buildAuthParams(config.username, config.password, false)
  params.id = id
  if (size) params.size = String(size)

  const url = new URL(`${normalizeUrl(config.baseUrl)}/rest/getCoverArt.view`)
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, String(value))
  })
  return url.toString()
}

export function resolveCoverArtId(track: Track): string {
  return track.trackId.replace(/^navidrome-/, '')
}

export async function triggerNavidromeScan(config: NavidromeConfig): Promise<void> {
  await callSubsonic(config, 'startScan.view', { scanType: 'fast' })
}

export interface ScanStatus {
  lastScan: string
}

export async function getScanStatus(config: NavidromeConfig): Promise<ScanStatus> {
  const resp = await callSubsonic(config, 'getScanStatus.view')
  return { lastScan: resp.scanStatus?.lastScan ?? '' }
}

/**
 * Normalizes Subsonic's `starred` field to a boolean. The REST API sends an
 * ISO-8601 timestamp string when a song is starred (absent otherwise), but some
 * servers/clients serialize a literal boolean — accept both, plus explicit
 * string booleans.
 */
export function isStarred(starred: boolean | string | undefined): boolean {
  if (typeof starred === 'boolean') return starred
  if (starred === undefined) return false
  const s = starred.trim().toLowerCase()
  if (s === '' || s === 'false' || s === '0') return false
  return true
}

/** Coercing unknown-but-real formats (wav, aiff, wma…) to 'mp3' would break
 *  WebDAV file matching and the search picker: both filter by `.<fileType>`
 *  extension, so a `.wav` file can never match a track stamped 'mp3'. The
 *  suffix is the most reliable signal (actual file extension); the content-type
 *  last segment (audio/x-wav → 'wav') is only a fallback when the suffix is
 *  missing. Keep real values as-is — fileType is just a matching hint. */
const CT_SUBTYPE_ALIASES: Record<string, string> = {
  'x-wav': 'wav',
  wave: 'wav',
  mpeg: 'mp3',
  mp3: 'mp3',
  'x-m4a': 'm4a',
  mp4: 'm4a',
  'x-aiff': 'aiff',
  'x-ms-wma': 'wma',
}

function deriveFileType(song: NavidromeSong): Track['fileType'] {
  const suffix = (song.suffix ?? '').toLowerCase().replace(/^\./, '')
  if (suffix) return suffix as Track['fileType']
  const ct = (song.contentType ?? '').toLowerCase()
  const last = ct.split('/').pop() ?? ''
  const aliased = CT_SUBTYPE_ALIASES[last] ?? last
  if (aliased && aliased !== 'octet-stream' && aliased !== 'mpegurl') return aliased as Track['fileType']
  return 'mp3'
}

export function navidromeSongToTrack(song: NavidromeSong): Track {
  const fileType = deriveFileType(song)

  return {
    trackId: `navidrome-${song.id}`,
    title: song.title || 'Unknown Title',
    artist: song.artist || song.albumArtist || 'Unknown Artist',
    album: song.album || 'Unknown Album',
    albumId: song.albumId,
    year: song.year,
    duration: song.duration || 0,
    fileType,
    composer: song.composer,
    bitrate: song.bitRate,
    size: song.size,
    createdAt: song.created ? new Date(song.created).getTime() : undefined,
    navidromePath: song.path,
    replayGain: song.replayGain?.trackGain,
    albumReplayGain: song.replayGain?.albumGain,
    albumArtist: song.albumArtist,
    trackNumber: song.track,
    genre: song.genre,
    starred: isStarred(song.starred),
    userRating: song.userRating,
  }
}

export async function getNavidromeSong(config: NavidromeConfig, songId: string): Promise<NavidromeSong> {
  const resp = await callSubsonic(config, 'getSong.view', { id: songId })
  return resp.song
}

// ── Scrobbling & now-playing ───────────────────────────────────────────

/**
 * Reports a track as "now playing". The Subsonic/OpenSubsonic API has no
 * dedicated `nowPlaying` endpoint — this is the `scrobble` endpoint with
 * `submission=false` (a "now playing" notification, not a completed listen).
 * Navidrome feeds it into its own listen tracking and forwards it to any
 * configured external scrobblers (Last.fm, ListenBrainz).
 */
export async function submitNowPlaying(config: NavidromeConfig, songId: string): Promise<void> {
  await callSubsonic(config, 'scrobble', { id: songId, submission: 'false' })
}

/**
 * Submits a completed listen (scrobble) at the given `timeMs` (milliseconds
 * since 1 Jan 1970 — the Subsonic `time` unit; Navidrome parses it with
 * `time.UnixMilli`). `submission=true` is an actual scrobble (counts as a
 * play and bumps play counts).
 */
export async function submitScrobble(config: NavidromeConfig, songId: string, timeMs: number): Promise<void> {
  await callSubsonic(config, 'scrobble', { id: songId, time: timeMs, submission: 'true' })
}

/**
 * Sets the starred (loved/heart) state for one or more songs. Subsonic accepts
 * repeated `id` parameters, so a whole batch is one request per endpoint.
 */
export async function setNavidromeStarred(config: NavidromeConfig, songIds: string[], starred: boolean): Promise<void> {
  // Repeated `id` query params ride in a GET URL — 30×37-char UUIDs plus auth
  // params stays under 2 KB, inside every proxy/CDN URL limit. (100 ids once
  // exceeded some 4 KB limits and 414'd.)
  const batchSize = 30
  const endpoint = starred ? 'star.view' : 'unstar.view'
  for (let i = 0; i < songIds.length; i += batchSize) {
    const batch = songIds.slice(i, i + batchSize)
    await callSubsonicWithPairs(config, endpoint, {}, batch.map((id) => ['id', id] as [string, string]))
  }
}

/** Sets a single song's Navidrome rating. `rating` is 1–5 (Subsonic scale). */
export async function setNavidromeRating(config: NavidromeConfig, songId: string, rating: number): Promise<void> {
  await callSubsonic(config, 'setRating.view', { id: songId, rating })
}

// ── Lyrics ────────────────────────────────────────────────────────────

export interface NavidromeLyrics {
  artist?: string
  title?: string
  value: string
  synced?: boolean
}

export async function getNavidromeLyrics(
  config: NavidromeConfig,
  artist: string,
  title: string,
): Promise<NavidromeLyrics | null> {
  try {
    const resp = await callSubsonic(config, 'getLyrics.view', { artist, title })
    const lyricsList = resp.lyricsList?.lyrics
    const found = Array.isArray(lyricsList) ? lyricsList.find((l: Record<string, unknown>) => l && typeof l['value'] === 'string' && (l['value'] as string).length > 0) : undefined
    if (!found) return null
    return {
      artist: found['artist'] as string | undefined,
      title: found['title'] as string | undefined,
      value: found['value'] as string,
    }
  } catch {
    return null
  }
}

export async function testWebdavConnection(
  baseUrl: string,
  user: string,
  token: string,
): Promise<{ connected: boolean; error?: string }> {
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/`
    // Routes through webdavFetch so the test exercises the exact same code
    // path (native CapacitorHttp / web fetch) as real sync operations.
    const res = await webdavFetch(url, {
      method: 'PROPFIND',
      headers: {
        Authorization: `Basic ${btoa(`${user}:${token}`)}`,
        Depth: '0',
      },
    }, 15000)
    if (res.ok) {
      return { connected: true }
    }
    return { connected: false, error: `HTTP ${res.status}: ${res.statusText || res.status}` }
  } catch (err) {
    const error = err as Error
    return { connected: false, error: error.message }
  }
}

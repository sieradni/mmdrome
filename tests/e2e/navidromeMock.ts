import type { Page } from '@playwright/test'

/**
 * A minimal in-browser Navidrome (Subsonic) mock: route-intercepts the
 * endpoints the boot pipeline needs (`ping.view`, `getScanStatus.view`,
 * `search3.view`) and answers with a small static catalog. Used by the specs
 * that need an ACTIVE track (the Now Playing detail controls are guarded
 * behind `$currentTrack`), which an empty library can never provide.
 *
 * Seeding IndexedDB directly is not enough for that: the boot pipeline maps
 * songs through `navidromeSongToTrack`, whose `isStarred` normalization
 * rejects malformed rows — the mock's payloads are the real shapes.
 */

const SONGS = [
  { id: 'mock-1', title: 'Midnight Drive', artist: 'The Orbitals', album: 'Nightdrive', duration: 201, track: 1, year: 2021, genre: 'Electronic', suffix: 'flac', bitRate: 320, size: 32000000, starred: 'false', created: '2024-01-01T00:00:00Z', albumId: 'al-1', path: 'Music/Midnight Drive.flac' },
  { id: 'mock-2', title: 'Golden Hour', artist: 'Mara Voss', album: 'Nightdrive', duration: 187, track: 2, year: 2021, genre: 'Electronic', suffix: 'flac', bitRate: 320, size: 29000000, starred: 'false', created: '2024-01-01T00:00:00Z', albumId: 'al-1', path: 'Music/Golden Hour.flac' },
  { id: 'mock-3', title: 'Paper Planes', artist: 'Cassette Club', album: 'Daytrips', duration: 214, track: 3, year: 2022, genre: 'Indie', suffix: 'mp3', bitRate: 320, size: 8200000, starred: 'false', created: '2024-01-01T00:00:00Z', albumId: 'al-2', path: 'Music/Paper Planes.mp3' },
]

export const MOCK_SERVER = 'http://mock-navidrome.test'

// Cross-origin mock: the app runs on localhost while the fake server has its
// own origin, so EVERY response needs ACAO or the browser blocks it and the
// boot pipeline reads a dead server (the same lesson the webdavMock pins).
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' }

function subsonicOk(payload: Record<string, unknown>): {
  status: number
  contentType: string
  headers: Record<string, string>
  body: string
} {
  return {
    status: 200,
    contentType: 'application/json',
    headers: CORS_HEADERS,
    body: JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...payload } }),
  }
}

/** A valid PCM WAV whose header declares a multi-hour data chunk while the
 *  body carries only `seconds` of 8-bit silence. Chromium derives
 *  `HTMLAudioElement.duration` from the header, so playback never reaches EOF
 *  during a spec — no 'ended', no advance cascade. Without this the catch-all
 *  JSON answer made every play() error and the A5 retry chain churned through
 *  the queue, dropping the active track mid-spec.
 */
function mockWav(seconds = 60): Buffer {
  const sampleRate = 8000
  const channels = 1
  const bits = 8
  const byteRate = sampleRate * channels * (bits / 8)
  const declaredData = 0x7ffff000 // ≈74 h at 8 kB/s — header-only duration
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + declaredData, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE((channels * bits) / 8, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36)
  header.writeUInt32LE(declaredData, 40)
  return Buffer.concat([header, Buffer.alloc(byteRate * seconds, 0x80)])
}

/** Installs the route intercepts. Call BEFORE `bootApp`.
 *  ORDER MATTERS: Playwright route handlers are last-registered-first-matched,
 *  so the specific endpoint routes must be registered AFTER the catch-all or
 *  the catch-all (registered later ⇒ higher precedence) swallows them and the
 *  app sees an empty catalog behind a "Connected" status.
 */
export async function installNavidromeMock(page: Page): Promise<void> {
  // Catch-all FIRST (lowest precedence): streams/covers/anything unlisted —
  // keeps a stray thumbnail request from erroring the boot race.
  await page.route('**/mock-navidrome.test/**', (route) => {
    if (route.request().url().includes('getCoverArt')) {
      // 1×1 transparent PNG
      const png =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
      return route.fulfill({ status: 200, contentType: 'image/png', headers: CORS_HEADERS, body: Buffer.from(png, 'base64') })
    }
    return route.fulfill(subsonicOk({}))
  })
  await page.route('**/ping.view*', (route) => route.fulfill(subsonicOk({})))
  await page.route('**/getScanStatus.view*', (route) => route.fulfill(subsonicOk({ scanStatus: { lastScan: '2024-01-02T00:00:00Z' } })))
  await page.route('**/search3.view*', (route) =>
    route.fulfill(subsonicOk({ searchResult3: { song: SONGS } })),
  )
  // Real decodable audio for stream requests: a track must be able to go
  // ACTIVE (and stay active) for specs that drive the detail controls.
  await page.route('**/stream.view*', (route) =>
    route.fulfill({ status: 200, contentType: 'audio/wav', headers: CORS_HEADERS, body: mockWav() }),
  )
}

/**
 * Seeds the persisted settings with the mock server's credentials so the boot
 * pipeline connects against it. REQUIRES an existing Dexie schema: run the
 * app once (`bootApp`), then seed, then reload — on a fresh profile the
 * object stores do not exist until the app's first boot has created them, and
 * an init script would race (or break) Dexie's own schema creation.
 */
export async function seedMockCredentials(page: Page): Promise<void> {
  await page.evaluate(async (base) => {
    const req = indexedDB.open('mmdrome')
    await new Promise<void>((resolve, reject) => {
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
    const db = req.result
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('userSettings', 'readwrite')
      const st = tx.objectStore('userSettings')
      st.put({ key: 'navidromeUrl', value: base })
      st.put({ key: 'navidromeUser', value: 'tester' })
      st.put({ key: 'navidromePassword', value: 'testpass' })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  }, MOCK_SERVER)
}

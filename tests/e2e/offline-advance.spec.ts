import { test, expect, type Page } from '@playwright/test'
import { bootApp } from './boot'
import { openSettingsSection } from './libraryHarness'

/**
 * The browser-level pin of the preload offline-buffer contract (AGENTS §4.A14)
 * and its neighboring edges (A13 sweep, bg handoff §3.1). The Node suites pin
 * the pure machinery (serialized fill, dead-row skip, resolveSrc hit/miss);
 * only a real Chromium can prove the END-TO-END promise the user actually
 * feels: with the connection dead mid-track, advancing still plays the
 * preloaded next track — because the advance resolved through the Cache
 * Storage hit (a `blob:` src), not the (now dead) raw stream URL.
 *
 * Why the raw URL would NOT play here: the stream route is aborted
 * (`connectionrefused`), so any miss-path element load fires the transport's
 * error/retry chain instead of playing. A blob src that advances currentTime is
 * therefore only reachable through the preload cache — the assertion is
 * self-validating, no mock-of-the-mock.
 *
 * Track duration is 25 s of metadata so the fill-start gate (`remaining <= 30`)
 * is satisfied immediately at play start — the spec doesn't depend on the
 * browser's buffer-ahead behavior. The audio bytes are a trivially decodable
 * PCM WAV (the hand-built MP3 fixtures exist for taglib parsing, not for
 * playback); Chromium decodes and clocks silence without an output device.
 *
 * Note on the transport click: the app renders a SECOND "Next track" button
 * inside the (closed, off-screen) NowPlaying overlay BEFORE the mini bar in
 * the DOM, so the mini-bar button is scoped via its `div[role=button]`
 * ancestor (a naive `.first()` clicks into the overlay's backdrop instead).
 */

const NAV_BASE = 'https://navidrome.test'

const SONGS = Array.from({ length: 6 }, (_, i) => ({
  id: `s${i + 1}`,
  title: `Song ${['One', 'Two', 'Three', 'Four', 'Five', 'Six'][i]}`,
  artist: `Artist ${String.fromCharCode(65 + i)}`,
  album: `Album ${String.fromCharCode(88 + i)}`,
  duration: 25,
  suffix: 'mp3',
  starred: false,
  userRating: 0,
}))

/** 8 kHz 16-bit mono PCM silence — small, and unconditionally decodable. */
function makeWav(seconds: number): Buffer {
  const sampleRate = 8000
  const data = Buffer.alloc(seconds * sampleRate * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

const WAV = makeWav(25)

function subsonic(extra: Record<string, unknown>): Record<string, unknown> {
  return { 'subsonic-response': { status: 'ok', version: '1.16.1', ...extra } }
}

async function mockOnline(page: Page): Promise<void> {
  await page.route('**/rest/**', async (route) => {
    const endpoint = new URL(route.request().url()).pathname.split('/').pop()
    let extra: Record<string, unknown> = {}
    if (endpoint === 'ping.view') extra = { serverVersion: '0.50.0' }
    else if (endpoint === 'getScanStatus.view') extra = { scanStatus: { lastScan: '2026-01-01T00:00:00Z' } }
    else if (endpoint === 'search3.view') extra = { searchResult3: { song: SONGS } }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(subsonic(extra)) })
  })
  // The stream endpoint serves the decodable WAV (transcodeMode is off by
  // default, so the URL carries no format param — plain stream.view).
  await page.route('**/rest/stream.view*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: WAV })
  })
}

/**
 * Instrument EVERY media src assignment before any app code runs: the engine's
 * a/b elements are `new Audio()` — never attached to the DOM, so
 * `document.querySelector('audio')` finds nothing. The recorded log is the
 * only way to observe what the element was told to play.
 */
async function instrumentMediaSrc(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __mediaSrcs: string[]
      __mediaEls: HTMLMediaElement[]
      __lastMedia?: HTMLMediaElement
    }
    w.__mediaSrcs = []
    w.__mediaEls = []
    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')!
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      set(v: string) {
        w.__mediaSrcs.push(String(v))
        w.__lastMedia = this
        // Track EVERY element (deduped): the playhead probe must watch the
        // PLAYING element, not the last-assigned one — with crossfade armed
        // (default 6 s), legitimate paths (bg-swap mirror, a fade execution)
        // assign a src to the OTHER, paused element AFTER the playing one,
        // and a last-assigned probe then times out on a frozen standby.
        if (!w.__mediaEls.includes(this)) w.__mediaEls.push(this)
        desc.set!.call(this, v)
      },
      get() {
        return desc.get!.call(this)
      },
    })
  })
}

/** True once ANY Cache Storage entry's URL contains `fragment`. */
function preloadCacheHas(page: Page, fragment: string): Promise<boolean> {
  return page.evaluate(async (frag) => {
    for (const name of await caches.keys()) {
      const cache = await caches.open(name)
      for (const req of await cache.keys()) {
        if (req.url.includes(frag)) return true
      }
    }
    return false
  }, fragment)
}

/** All Cache Storage entry URLs matching `fragment` (order = insertion). */
function preloadCacheUrls(page: Page, fragment: string): Promise<string[]> {
  return page.evaluate(async (frag) => {
    const urls: string[] = []
    for (const name of await caches.keys()) {
      const cache = await caches.open(name)
      for (const req of await cache.keys()) {
        if (req.url.includes(frag)) urls.push(req.url)
      }
    }
    return urls
  }, fragment)
}

/** Every media src assigned so far (the instrumented log). */
function mediaSrcs(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __mediaSrcs: string[] }).__mediaSrcs)
}

/**
 * The playhead of the PLAYING element (the max currentTime across every
 * media element that is not paused). Polling a last-assigned element instead
 * is the flake this spec kept hitting: after an advance the crossfade/bg
 * machinery can assign a src to the other (paused) element, and the old
 * `__lastMedia` probe then waited 15 s on a frozen standby while the real
 * element played. A REAL pause (the app stopped) still fails the predicate —
 * every element is paused — so the assertion keeps its teeth.
 */
function playingMediaTime(page: Page): Promise<number> {
  return page.evaluate(() => {
    const els = (window as unknown as { __mediaEls?: HTMLMediaElement[] }).__mediaEls ?? []
    let t = 0
    for (const el of els) {
      if (!el.paused && el.currentTime > t) t = el.currentTime
    }
    return t
  })
}

/** Max playhead across ALL media elements (paused included). Failure
 *  diagnostics only — a paused standby's frozen time must never feed a
 *  pass, but seeing a nonzero FROZEN time distinguishes "audio decoded,
 *  output stuck" (engine/worklet problem) from "time never left 0"
 *  (decode/load never succeeded) when this spec fails. */
async function anyMediaTime(page: Page): Promise<number> {
  return page.evaluate(() => {
    const els = (window as unknown as { __mediaEls?: HTMLMediaElement[] }).__mediaEls ?? []
    let t = 0
    for (const el of els) if (el.currentTime > t) t = el.currentTime
    return t
  })
}

/** A capped tail of the media-src instrument log (newest last). */
async function lastMediaSrcs(page: Page, n = 4): Promise<string[]> {
  const s = await mediaSrcs(page)
  return s.slice(-n)
}

/**
 * Shared boot for every scenario: load the 6-song mocked library, set the
 * preload window, play Song One, and wait for the fill-start gate. Returns
 * with track 1 streaming (raw URL) and its playhead moving.
 */
async function bootAndPlay(page: Page, preloadCount: number): Promise<void> {
  await openSettingsSection(page, 'sources')
  await page.getByTestId('navidrome-url').fill(NAV_BASE)
  await page.getByTestId('navidrome-user').fill('user')
  await page.getByTestId('navidrome-password').fill('pass')
  await mockOnline(page)
  await page.getByRole('button', { name: 'Connect & Load Songs' }).click()
  await expect(page.getByText('Loaded 6 song(s), 0 failed')).toBeVisible({ timeout: 30_000 })

  await openSettingsSection(page, 'playback')
  await page.getByRole('button', { name: String(preloadCount), exact: true }).click()

  await page.getByRole('button', { name: 'Songs', exact: true }).click()
  await page.getByRole('button', { name: /Song One/ }).first().click()

  await expect.poll(async () => (await mediaSrcs(page)).length).toBeGreaterThan(0)
  const srcs1 = await mediaSrcs(page)
  expect(srcs1[srcs1.length - 1], 'track 1 starts on the raw stream URL (cache miss)').toContain('stream.view')
  expect(srcs1[srcs1.length - 1]).toContain('id=s1')
  await expect.poll(() => playingMediaTime(page), { timeout: 10_000 }).toBeGreaterThan(0)
}

/** The mini-bar Next button, scoped past the hidden overlay's duplicate
 *  (which renders earlier in the DOM and swallows plain `.first()` clicks). */
function miniNext(page: Page) {
  return page
    .locator('div[role="button"]', { has: page.getByRole('button', { name: 'Next track' }) })
    .getByRole('button', { name: 'Next track' })
}

/** Abort every stream request — the connection is dead from here on. */
async function dropConnection(page: Page): Promise<void> {
  await page.route('**/rest/stream.view*', (route) => route.abort('connectionrefused'))
}

// ── 1. The original pin: single advance off a dead connection ──────────

test('a mid-track connection drop still plays the preloaded next track from the cache', async ({ page }) => {
  test.setTimeout(90_000)
  await instrumentMediaSrc(page)
  await bootApp(page)
  await bootAndPlay(page, 5)

  // The preloader window fills in queue order — Song Two (the next track) is
  // the FIRST fill and must land in Cache Storage. s3 is also awaited: under
  // CI load a blob decode can transiently fail (NotSupportedError — the
  // documented 2026-09-10 smoke-flake episode), and the fromError rescue
  // advances to the NEXT track, which needs its cache entry to play offline.
  // Without it the rescue honestly stops at a dead raw URL and the playhead
  // freezes — a flake with no product bug behind it. s2+s3 cached gives the
  // rescue a deterministic landing spot.
  await expect.poll(() => preloadCacheHas(page, 'id=s2'), { timeout: 20_000, intervals: [500, 1_000] }).toBe(true)
  await expect.poll(() => preloadCacheHas(page, 'id=s3'), { timeout: 30_000, intervals: [500, 1_000] }).toBe(true)

  await dropConnection(page)
  await miniNext(page).click()

  // The advance loaded a blob: URL — minted exclusively by resolveSrc on a
  // Cache Storage hit (a miss would have fallen back to the raw URL).
  await expect
    .poll(async () => (await mediaSrcs(page)).filter((s) => s.startsWith('blob:')).length, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1)
  const srcs2 = await mediaSrcs(page)
  expect(srcs2[srcs2.length - 1], 'the advance ended on a cached blob src').toMatch(/^blob:/)
  expect(srcs2.filter((s) => s.includes('id=s2')), 'track 2 is never loaded from the dead raw URL').toEqual([])

  // …and it actually PLAYS (not just loaded): the playhead advances with the
  // network dead — measured on the PLAYING element, never the last-assigned
  // one (the crossfade standby is legitimately paused after an advance).
  await expect.poll(() => playingMediaTime(page), { timeout: 15_000 }).toBeGreaterThan(0.5)
})

// ── 2. Multiple preloads: the whole window fills, in QUEUE order ───────

test('the full preload window fills in queue order and survives two offline advances', async ({ page }) => {
  test.setTimeout(120_000)
  await instrumentMediaSrc(page)
  await bootApp(page)
  await bootAndPlay(page, 5)

  // Serialized fill: ONE fetch per 1 s tick, so the window lands in queue
  // order — s2 first, then s3, s4, s5, s6. The NEXT track must never wait
  // behind a later one (A14's priority contract).
  await expect.poll(() => preloadCacheHas(page, 'id=s2'), { timeout: 20_000, intervals: [500, 1_000] }).toBe(true)
  for (const id of ['s3', 's4', 's5', 's6']) {
    await expect.poll(() => preloadCacheHas(page, `id=${id}`), { timeout: 30_000, intervals: [500, 1_000] }).toBe(true)
  }
  const urls = await preloadCacheUrls(page, 'stream.view')
  const order = ['s2', 's3', 's4', 's5', 's6'].map((id) => urls.findIndex((u) => u.includes(`id=${id}`)))
  expect(order, 'cache insertion order IS queue order (serialized fill)').toEqual([...order].sort((a, b) => a - b))
  expect(new Set(order).has(-1), 'all five window rows are cached').toBe(false)

  // ── Dead connection: advance TWICE through the preloaded window. ──
  await dropConnection(page)
  await miniNext(page).click()
  await expect.poll(async () => (await mediaSrcs(page)).filter((s) => s.startsWith('blob:')).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
  await expect.poll(() => playingMediaTime(page), { timeout: 15_000 }).toBeGreaterThan(0.5)

  await miniNext(page).click()
  // Track 3 also plays offline from its cached blob. Poll the BLOB COUNT
  // first — the only signal the async advance landed — then the playhead:
  // the reverse order is the documented vacuous-poll race (a passing time
  // poll can ride the previous track's element while the read races the
  // load; DEVLOG 2026-09-10 "smoke flake part 3").
  await expect
    .poll(async () => (await mediaSrcs(page)).filter((s) => s.startsWith('blob:')).length, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(2)
  await expect.poll(() => playingMediaTime(page), { timeout: 15_000 }).toBeGreaterThan(0.5)
  const srcs3 = await mediaSrcs(page)
  expect(srcs3[srcs3.length - 1]).toMatch(/^blob:/)
  expect(srcs3.filter((s) => s.includes('id=s3')), 'track 3 never touches the dead raw URL').toEqual([])
})

// ── 3. iOS background handoff: the swap happens OFFLINE and survives ───

test('the bg handoff mid-track with a dead connection still plays the preloaded next track', async ({ page }) => {
  test.setTimeout(120_000)
  await instrumentMediaSrc(page)
  await bootApp(page)
  await bootAndPlay(page, 5)
  // Same decode-rescue runway as scenario 1: s2 AND s3 cached (see the
  // comment there — CI-load NotSupportedError rescue needs s3 to land on).
  await expect.poll(() => preloadCacheHas(page, 'id=s2'), { timeout: 20_000, intervals: [500, 1_000] }).toBe(true)
  await expect.poll(() => preloadCacheHas(page, 'id=s3'), { timeout: 30_000, intervals: [500, 1_000] }).toBe(true)

  await dropConnection(page)

  // Simulate the iOS background transition: the WebBgTransport's
  // visibilitychange handler swaps to the warm bg element (§3.1). Chromium
  // fires the same event the iOS webview fires on backgrounding.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })

  // The enter-bg swap must not pause playback: the bg element keeps the
  // playhead moving with the network dead.
  await expect.poll(() => playingMediaTime(page), { timeout: 15_000 }).toBeGreaterThan(0.5)

  // Advance WHILE bg-engaged (the lock-screen Next path routes through the
  // same manager) — the bg load must resolve through the preload cache.
  await miniNext(page).click()

  await expect
    .poll(async () => (await mediaSrcs(page)).filter((s) => s.startsWith('blob:')).length, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1)
  const srcs = await mediaSrcs(page)
  expect(srcs[srcs.length - 1], 'the bg advance ended on a cached blob src').toMatch(/^blob:/)
  expect(srcs.filter((s) => s.includes('id=s2')), 'track 2 is never loaded from the dead raw URL').toEqual([])
  await expect.poll(() => playingMediaTime(page), { timeout: 15_000 }).toBeGreaterThan(0.5)

  // Returning to the foreground carries the bg position back — still the
  // same (cached) track, still playing.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => playingMediaTime(page), { timeout: 15_000 }).toBeGreaterThan(0.5)
})

// ── 4. A13 transcode sweep: format-bearing entries die, raw survive ────

test('a transcode-mode change sweeps format-bearing cache entries and raw URLs survive', async ({ page }) => {
  test.setTimeout(120_000)
  await instrumentMediaSrc(page)
  await bootApp(page)
  await bootAndPlay(page, 5)
  await expect.poll(() => preloadCacheHas(page, 'id=s2'), { timeout: 20_000, intervals: [500, 1_000] }).toBe(true)

  // Seed a STALE format-bearing entry the way a previous transcode-era
  // session would have left it: same song, old format param. This is the
  // exact shape sweepStaleTranscodeEntries must delete (A13).
  await page.evaluate(async () => {
    const staleUrl = 'https://navidrome.test/rest/stream.view?u=user&p=pass&v=1.16.1&c=mmdrome&id=s2&format=opus&maxBitRate=128'
    const body = await (await fetch('https://navidrome.test/rest/stream.view?u=user&p=pass&v=1.16.1&c=mmdrome&id=s2')).blob()
    await caches.open('mmdrome-preload-cache').then((c) => c.put(staleUrl, new Response(body)))
  })

  // Flip transcode mode ON (Settings → Streaming Quality → Always) — the
  // manager's transcode-change edge fires the sweep.
  await openSettingsSection(page, 'playback')
  await page.getByRole('button', { name: 'Always', exact: true }).click()

  // The format-bearing entry is GONE; the raw entries (no format param) are
  // UNTOUCHED — the current track and the offline buffer survive the sweep.
  await expect.poll(async () => (await preloadCacheUrls(page, 'format=')).length, { timeout: 15_000 }).toBe(0)
  const rawUrls = await preloadCacheUrls(page, 'stream.view')
  expect(rawUrls.length, 'raw preloaded entries survive the sweep').toBeGreaterThanOrEqual(1)
  expect(rawUrls.some((u) => u.includes('id=s2')), 'the offline buffer for track 2 survives').toBe(true)

  // The CURRENT track is never re-fetched with NEW params mid-play (A13):
  // every s1 src assignment stays the raw URL — none ever gains a format=
  // param (a bitrate change applies from the next track, not by restarting
  // the playing one).
  const srcs = await mediaSrcs(page)
  expect(srcs.filter((s) => s.includes('id=s1') && s.includes('format=')), 'the playing track never switches to a transcode URL mid-play').toEqual([])
})

// ── 5. Dead-URL resilience: a vanished file cannot block the window ────

test('a vanished file goes dead after two non-ok responses and the window keeps filling', async ({ page }) => {
  test.setTimeout(120_000)
  await instrumentMediaSrc(page)
  await bootApp(page)

  await bootAndPlay(page, 5)

  // Song Two's stream 404s FOREVER (a vanished file); every other song keeps
  // the WAV. Registered AFTER bootAndPlay because page.route is LIFO — the
  // LAST matching handler wins, and mockOnline's stream route (registered
  // inside bootAndPlay) must sit UNDER this one.
  await page.route('**/rest/stream.view*', async (route) => {
    const url = route.request().url()
    if (url.includes('id=s2')) {
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' })
      return
    }
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: WAV })
  })

  // Setup-race drain: track duration is 25 s so the fill gate passes at play
  // start, and bootAndPlay returns as soon as track 1's playhead moves — the
  // preloader's 1 s tick can therefore fill s2 with a 200 BEFORE this override
  // existed. No product path caches a non-ok response (the Node suite pins the
  // strike/dead books), so a pre-override s2 entry is setup contamination, not
  // behavior. Drain in-flight puts, then delete it: everything after this line
  // 404s, so s2's absence at the end deterministically means "went dead".
  await new Promise((r) => setTimeout(r, 500))
  await page.evaluate(async () => {
    for (const name of await caches.keys()) {
      const cache = await caches.open(name)
      for (const req of await cache.keys()) {
        if (req.url.includes('id=s2')) await cache.delete(req)
      }
    }
  })

  // The first fill targets s2 and gets a non-ok response. After the SECOND
  // non-ok (next tick), the URL is dead for the session — and s3..s6 fill
  // behind it instead of head-of-line blocking forever.
  for (const id of ['s3', 's4', 's5', 's6']) {
    await expect.poll(() => preloadCacheHas(page, `id=${id}`), { timeout: 45_000, intervals: [500, 1_000] }).toBe(true)
  }
  // s2 never lands (it 404s) — the dead mark is observable as its absence
  // while every later row is present.
  expect(await preloadCacheUrls(page, 'id=s2')).toEqual([])

  // The dead URL also never re-fires: count s2 stream requests — exactly the
  // two strikes that killed it (one per tick), never a third.
  const s2Requests = await page.evaluate(() => (window as unknown as { __mediaSrcs: string[] }).__mediaSrcs.filter((s) => s.includes('id=s2')).length)
  // (src assignments, not fetches — s2 was never assigned to an element; the
  // request-count pin lives in the Node suite. Here we pin the user-visible
  // outcome: the window behind the dead row is full and playable.)
  expect(s2Requests).toBe(0)
})

// ── 6. LDM does NOT gate the preloader (the plan's Principle) ──────────

// The 2026-09-06 commit shipped a poll bail + native count→0 against the LDM
// plan's own §2 Principle ("auto-preload stays ON in LDM — it's bounded to
// the next few tracks and is what makes LDM streaming viable on a marginal
// connection"); corrected 2026-09-07. This scenario pins the corrected
// behavior in the real browser: engaging low data mode mid-fill must NOT
// stop the window from filling — preload is the counter to intermittent
// connections, the exact condition LDM describes. The Node suite pins the
// mechanism (poll keeps fetching, cadence unchanged); only a real browser
// proves the STORE WIRING: the Settings toggle → effectiveLowData → (no)
// preloader effect, end to end.
test('engaging low data mode mid-fill does not stop the preload window from filling', async ({ page }) => {
  test.setTimeout(120_000)
  await instrumentMediaSrc(page)
  await bootApp(page)
  await bootAndPlay(page, 5)

  // Wait for the FIRST fill to land (s2), then engage LDM through the real
  // Settings toggle while the window is still filling (s3..s6 pending).
  // s3 is awaited too — the decode-rescue runway (see scenario 1).
  await expect.poll(() => preloadCacheHas(page, 'id=s2'), { timeout: 20_000, intervals: [500, 1_000] }).toBe(true)
  await expect.poll(() => preloadCacheHas(page, 'id=s3'), { timeout: 30_000, intervals: [500, 1_000] }).toBe(true)
  await openSettingsSection(page, 'playback')
  await page.getByTestId('low-data-mode').click()
  await expect(page.getByTestId('low-data-mode')).toBeChecked()

  // The window KEEPS filling under LDM (serialized cadence unchanged).
  for (const id of ['s3', 's4', 's5', 's6']) {
    await expect.poll(() => preloadCacheHas(page, `id=${id}`), { timeout: 45_000, intervals: [500, 1_000] }).toBe(true)
  }

  // Playback is untouched by the toggle (LDM gates background traffic, never
  // the playing track): the playhead is still moving.
  await expect.poll(() => playingMediaTime(page), { timeout: 10_000 }).toBeGreaterThan(0.5)

  // And the offline promise still holds under LDM: dead connection, advance,
  // the cached next track plays.
  await dropConnection(page)
  await miniNext(page).click()
  await expect
    .poll(async () => (await mediaSrcs(page)).filter((s) => s.startsWith('blob:')).length, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1)
  await expect.poll(() => playingMediaTime(page), { timeout: 15_000 }).toBeGreaterThan(0.5)
  const srcs = await mediaSrcs(page)
  expect(srcs.filter((s) => s.includes('id=s2')), 'no dead raw-URL load even under LDM').toEqual([])
})

// ── 7. Undecodable cached bytes: skip via the fromError chain, never freeze ──

// Probe evidence (smoke flake): a blob whose bytes Chromium can't decode
// rejects play() with NotSupportedError while user activation is VALID (not
// an autoplay block) — under load this hits even the mock WAV. playLoaded
// exhausts its 3 attempts; the old code then stopped the queue forever over
// one bad file (blob src present, playhead frozen — the exact flake
// signature). The rescue routes through the fromError A4 chain instead, so
// the advance lands on the next playable cached track. Garbage bytes fail
// decode deterministically, which is what makes this a pin rather than a
// flake-chase: s2's cache entry holds text, s3's holds the WAV.
test('an undecodable cached track is skipped instead of freezing playback', async ({ page }) => {
  test.setTimeout(120_000)
  await instrumentMediaSrc(page)
  await bootApp(page)
  await bootAndPlay(page, 5)

  // Poison s2's cache entry BEFORE its fill lands: every later s2 fetch gets
  // text bytes (LIFO route: registered after mockOnline, so it wins).
  await page.route('**/rest/stream.view*', async (route) => {
    const url = route.request().url()
    if (url.includes('id=s2')) {
      await route.fulfill({ status: 200, contentType: 'text/plain', body: 'this is not audio' })
      return
    }
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: WAV })
  })
  await expect.poll(() => preloadCacheHas(page, 'id=s2'), { timeout: 20_000, intervals: [500, 1_000] }).toBe(true)
  await expect.poll(() => preloadCacheHas(page, 'id=s3'), { timeout: 30_000, intervals: [500, 1_000] }).toBe(true)

  await dropConnection(page)
  await miniNext(page).click()

  // s2's blob can't decode (3 play() rejections ≈ 3.5 s) → the rescue
  // advances to s3's valid cached blob, which plays — the playhead moves
  // instead of freezing at 0 over the dead file. Poll the BLOB count first:
  // it is the only signal the async advance landed (a time poll would pass
  // vacuously off track 1's still-playing element, and a one-shot src read
  // would race the load — that exact race failed this spec under load).
  await expect
    .poll(async () => (await mediaSrcs(page)).filter((s) => s.startsWith('blob:')).length, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(1)
  // Window (2026-09-15, CI run 35035794940): ≥20 s failed with the playhead
  // still at 0. Worst-case wait ≈ s2's full 3-attempt chain (≈7 s: decode
  // + 1 s/2 s backoffs) + the SAME for s3 when the mock WAV transiently
  // surfaces NotSupportedError under load (probe evidence in the comment
  // above) + the final load/decode stretch. Widen to 45 s — the blob poll
  // above and the raw-URL checks below keep the assertion's teeth.
  try {
    await expect
      .poll(() => playingMediaTime(page), { timeout: 45_000, intervals: [500, 1_000, 2_000] })
      .toBeGreaterThan(0.5)
  } catch (e) {
    throw new Error(
      `playhead never moved after the skip chain: playing=${await playingMediaTime(page)} anyTime=${await anyMediaTime(page)} srcs=${(await lastMediaSrcs(page, 4)).join(' | ').slice(0, 400)}`,
      { cause: e instanceof Error ? e : undefined },
    )
  }
  const srcs = await mediaSrcs(page)
  expect(srcs.filter((s) => s.includes('id=s2') || s.includes('id=s3')), 'neither track touches a raw URL').toEqual([])
})

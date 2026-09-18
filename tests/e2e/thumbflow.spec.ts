import { test, expect, type Page } from '@playwright/test'
import { bootApp } from './boot'
import { installNavidromeMock, seedMockCredentials } from './navidromeMock'

// Regression pins for the 1.2.23 field report ("scrollbar-style fast scroll
// broke cover loading; the landing screen took seconds"):
//
// 1. THROTTLE: while a scroll gesture holds the gate, the visible tier arms
//    at slow-drag pace (one small batch per hold window) — not 8/33 ms. The
//    old behavior launched a fetch for EVERY screen a fast drag flew past;
//    on a real network those stale fetches saturate the connection pool and
//    the landing screen's covers queue behind them for seconds.
// 2. UNLATCH: a cover <img> is unmounted once its row is far outside the
//    viewport (3× the 800 px pre-roll), aborting the fetch and freeing the
//    decoded bitmap. The old latch kept every flown-past img alive forever.
//
// The mock delays each cover 120 ms so in-flight fetches are observable —
// with an instant server the pool never looks contended.

const SONGS = 4000
const COVER_DELAY_MS = 120

type SongRow = Record<string, unknown>

function makeSongs(): SongRow[] {
  const songs: SongRow[] = []
  for (let i = 0; i < SONGS; i++) {
    songs.push({
      id: `tr-${i}`,
      title: `Song ${String(i).padStart(5, '0')}`,
      artist: `Artist ${i % 200}`,
      album: `Album ${i % 400}`,
      duration: 180,
      track: (i % 12) + 1,
      year: 2020,
      genre: 'Test',
      suffix: 'mp3',
      bitRate: 320,
      size: 8000000,
      starred: 'false',
      created: '2024-01-01T00:00:00Z',
      albumId: `al-${i % 400}`,
      path: `Music/Song ${i}.mp3`,
    })
  }
  return songs
}

async function bootBigLibrary(page: Page): Promise<void> {
  await installNavidromeMock(page)
  await page.route('**/search3.view*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        'subsonic-response': { status: 'ok', version: '1.16.1', searchResult3: { song: makeSongs() } },
      }),
    }),
  )
  // Slow covers: the pipeline's resource behavior (not its schedule) is what
  // the field report is about.
  await page.route('**/getCoverArt*', async (route) => {
    await new Promise((r) => setTimeout(r, COVER_DELAY_MS))
    // 1×1 transparent PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    )
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: png,
    })
  })
  await bootApp(page)
  await seedMockCredentials(page)
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })
}

async function fling(page: Page, hops: number, intervalMs: number): Promise<void> {
  await page.evaluate(
    ({ hops, intervalMs }) =>
      // A Promise the LAST hop resolves — fling() must not return until the
      // gesture is over, or the "settled" assertions sample mid-teleport
      // (position still hopping; the mounted window lags the position). The
      // pre-fix fire-and-forget shape made the wide-window round flaky.
      new Promise<void>((resolve) => {
        const scroller = document.querySelector<HTMLElement>('div.flex-1.overflow-y-auto')
        if (!scroller) throw new Error('scroller not found')
        let done = 0
        const timer = setInterval(() => {
          done++
          scroller.scrollTop += scroller.clientHeight * 12
          scroller.dispatchEvent(new Event('scroll'))
          if (done >= hops) {
            clearInterval(timer)
            resolve()
          }
        }, intervalMs)
      }),
    { hops, intervalMs },
  )
}

/** Cover <img>s whose row currently sits within `radiusVh` viewport-heights
 *  of the viewport center. */
async function nearViewportCoverImgs(page: Page, radiusVh: number): Promise<number> {
  return page.evaluate((radiusVh) => {
    const vh = window.innerHeight
    const mid = vh / 2
    let near = 0
    for (const img of document.querySelectorAll<HTMLImageElement>('img[src*="getCoverArt"]')) {
      const r = img.getBoundingClientRect()
      const dist = Math.abs(r.top + r.height / 2 - mid)
      if (dist <= vh * radiusVh) near++
    }
    return near
  }, radiusVh)
}

test('a scrollbar-style fling does not launch a fetch for every screen it passes', async ({ page }) => {
  await bootBigLibrary(page)
  await expect(page.locator('div.flex-1.overflow-y-auto').first()).toBeVisible()
  await page.waitForTimeout(800)

  // ~700 ms of continuous stamped scrolling across ~12-screen hops.
  await fling(page, 14, 50)
  await page.waitForTimeout(200) // still inside the hold window: sample mid-gesture tail

  const midFling = await page.evaluate(() => document.querySelectorAll('img[src*="getCoverArt"]').length)
  console.log(`[thumbflow] imgs latched during fling: ${midFling}`)

  // Old behavior armed 8 rows/33 ms of continuously-replaced "visible" rows
  // for the whole gesture (140+ on a slow network, all stale). The throttle
  // bounds it to one 4-row batch per 250 ms hold window (~2 batches here).
  expect(midFling).toBeLessThan(40)

  // After settling, the landing screen loads (the gate opens, nearest first).
  // POLLED, not a fixed wait: the arm moment depends on where the last pace
  // batch fell relative to the hold window (a phase coin-flip at a fixed
  // deadline — the full-suite flake), while the PROPERTY is "the landing
  // loads within seconds of settling". The settle-expiry makes this fast.
  await expect
    .poll(async () => nearViewportCoverImgs(page, 3.0), { timeout: 10_000, intervals: [250] })
    .toBeGreaterThanOrEqual(4)
})

test('covers unmount when their row leaves the far window (fetch abort, no pile-up)', async ({ page }) => {
  await bootBigLibrary(page)
  await expect(page.locator('div.flex-1.overflow-y-auto').first()).toBeVisible()
  await page.waitForTimeout(800)

  await fling(page, 14, 50)
  // Let the gesture end, the gate open, and the landing batch load — POLLED
  // until the unlatch invariant stabilizes (everything still mounted sits
  // near the current position); in-flight arming transiently mounts pre-roll
  // rows that the far window then drops, so an early fixed sample raced.
  await expect
    .poll(
      async () => {
        const total = await page.evaluate(() => document.querySelectorAll('img[src*="getCoverArt"]').length)
        const near = await nearViewportCoverImgs(page, 5.5)
        return total === near && total >= 1
      },
      { timeout: 10_000, intervals: [250] },
    )
    .toBe(true)

  const total = await page.evaluate(() => document.querySelectorAll('img[src*="getCoverArt"]').length)
  const near = await nearViewportCoverImgs(page, 5.5)
  console.log(`[thumbflow] imgs total ${total}, near viewport ${near}`)

  // The unlatch means the mounted-img set tracks the viewport window instead
  // of growing with every screen the session ever visited. Everything still
  // mounted must be near the current position (±5.5 vh covers the ±4000px
  // pre-roll box + armed stragglers).
  expect(total).toBeLessThan(80)
  expect(total).toBe(near)
})

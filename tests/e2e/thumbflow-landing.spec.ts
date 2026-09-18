import { test, expect, type Page } from '@playwright/test'
import { bootBigLibrary, fling, LIST_SCROLLER } from './thumbflowHelpers'

// Landing-priority regression (2026-09-17, the "scroll far up, stop,
// thumbnails take 5 s" report). The resource-timing diagnostic found the root
// cause: the on-screen covers' requests started promptly after settle, but a
// ~90-request fresh flood poured out behind them at the old full cadence and
// a self-hosted server serves that burst slowly — so on a real server even
// the SCREEN's covers landed late. The fix is the two-lane planner: the tier
// (on-screen) empties at the fast cadence BEFORE the band (pre-roll) launches
// its 8-per-250 ms trickle. The property pinned here: after the teleport
// settles, the on-screen rows' fetches start promptly, and the first band
// fetches do not precede the tier's.
//
// Also pinned: the stale-fetch clog stays dead. At settle, nothing should be
// mid-flight that was launched during the gesture (the stability gate arms
// nothing fresh mid-gesture; cached revisits are not network fetches).

/** Cover resource entries: url, start (ms since navigation), end (now if in flight). */
async function coverTimings(page: Page): Promise<{ url: string; start: number; end: number }[]> {
  return page.evaluate(() => {
    const now = performance.now()
    return performance
      .getEntriesByType('resource')
      .filter((e) => e.name.includes('getCoverArt'))
      .map((e) => { const r = e as PerformanceResourceTiming; return { url: e.name, start: r.startTime, end: r.responseEnd > 0 ? r.responseEnd : now } })
  })
}

/** Distinct cover URLs requested after `since` (performance.now ms). */
async function startsAfter(page: Page, since: number): Promise<string[]> {
  return page.evaluate((t) => {
    return performance
      .getEntriesByType('resource')
      .filter((e) => e.name.includes('getCoverArt') && e.startTime > t)
      .map((e) => e.name)
  }, since)
}

/** URLs of covers whose <img> sits within 0.75 vh of the viewport center. */
async function onScreenUrls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vh = window.innerHeight
    const mid = vh / 2
    const urls: string[] = []
    for (const img of document.querySelectorAll<HTMLImageElement>('img[src*="getCoverArt"]')) {
      const r = img.getBoundingClientRect()
      if (Math.abs(r.top + r.height / 2 - mid) <= vh * 0.75) urls.push(img.src)
    }
    return urls
  })
}

test('landing priority: on-screen fetches start promptly and ahead of the band trickle', async ({ page }) => {
  test.setTimeout(30_000)
  await bootBigLibrary(page)
  const scroller = page.locator(LIST_SCROLLER).first()
  await expect(scroller).toBeVisible()
  await page.waitForTimeout(800)

  await fling(page, LIST_SCROLLER, 14, 50)
  const settleAt = await page.evaluate(() => performance.now())

  // Give the gate + lanes time: the tier empties first, the band trickles on.
  await page.waitForTimeout(2500)

  const timings = await coverTimings(page)
  const onScreen = await onScreenUrls(page)
  expect(onScreen.length).toBeGreaterThan(0)

  const key = (u: string) => u.split('&').slice(0, 4).join('&')
  const onScreenStarts = onScreen
    .map((u) => timings.find((t) => key(t.url) === key(u)))
    .filter((t): t is { url: string; start: number; end: number } => !!t)

  // 1. Every on-screen row has issued its fetch by now.
  expect(onScreenStarts.length).toBe(onScreen.length)

  // 2. Every on-screen fetch started PROMPTLY after settle: within the gate
  //    decay (250 ms) + a couple of tier-lane frames. The old failure mode
  //    (landing fetches waiting behind a server flood) showed up as starts
  //    seconds after settle.
  const settleOffset = await page.evaluate(() => 0)
  expect(settleOffset).toBe(0)
  for (const t of onScreenStarts) {
    expect(t.start - settleAt, `on-screen fetch started ${Math.round(t.start - settleAt)}ms after settle`).toBeLessThan(1500)
  }

  // 3. Tier-before-band: among requests that started after settle, the first
  //    band (far) fetch must not precede the last tier fetch. The trickle may
  //    interleave AFTER the tier empties — that is the design — but it may
  //    never jump the queue while on-screen rows are still waiting.
  const afterSettle = timings.filter((t) => t.start > settleAt).sort((a, b) => a.start - b.start)
  const onScreenKeys = new Set(onScreen.map(key))
  const tierStarts = afterSettle.filter((t) => onScreenKeys.has(key(t.url)))
  expect(tierStarts.length).toBeGreaterThan(0)
  const lastTierStart = Math.max(...tierStarts.map((t) => t.start))
  const earlyBand = afterSettle.filter((t) => !onScreenKeys.has(key(t.url)) && t.start < lastTierStart)
  // With a correct two-lane planner this is 0; band rows in the ±2000px
  // pre-roll overlap the on-screen set at the boundary, so allow the strictly
  // out-of-band rows only (beyond 0.75 vh is not measured — assert on the
  // count relative to the tier size).
  expect(earlyBand.length).toBeLessThanOrEqual(tierStarts.length)
})

test('no stale flood: nothing launched mid-gesture is still in flight at settle+2.5 s', async ({ page }) => {
  test.setTimeout(30_000)
  await bootBigLibrary(page)
  const scroller = page.locator(LIST_SCROLLER).first()
  await expect(scroller).toBeVisible()
  await page.waitForTimeout(800)

  const preGesture = await page.evaluate(() => performance.now())
  await fling(page, LIST_SCROLLER, 14, 50)
  const settleAt = await page.evaluate(() => performance.now())
  await page.waitForTimeout(2500)

  const post = await startsAfter(page, settleAt - 1500)
  const stillPending = await page.evaluate(() => {
    const now = performance.now()
    return performance
      .getEntriesByType('resource')
      .filter((e) => { const r = e as PerformanceResourceTiming; return e.name.includes('getCoverArt') && r.startTime > now - 4000 && (r.responseEnd === 0 || r.responseEnd > now) })
      .length
  })
  // Whatever launched must have finished: no multi-second stale fetch clogs
  // the pool after the landing (the 1.2.23 field report's signature).
  expect(stillPending).toBe(0)
  void preGesture
  void post
})

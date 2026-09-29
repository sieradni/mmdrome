import { test, expect, type Page } from '@playwright/test'
import { bootBigLibrary, fling, LIST_SCROLLER } from './thumbflowHelpers'

// Landing-priority regression (2026-09-17, the "scroll far up, stop,
// thumbnails take 5 s" report) — REWRITTEN 2026-09-28 for the virtual-window
// model. The original pin asserted tier-vs-band ordering among MOUNTED far
// rows; under windowed rendering there IS no mounted far band — unmounted
// rows cannot fetch, and the loader's nearest-first distance sort (pinned in
// tests/thumbLoader.test.ts) already enforces the ordering intent. The
// user-facing property survives unchanged:
//   1. after a teleport settles, every on-screen row's cover is COMPLETE or
//      its fetch started PROMPTLY (within the gate decay + lane cadence);
//   2. nothing launched mid-gesture is still in flight seconds later (the
//      stale-fetch clog stays dead — windowed or not, the fetch policy is
//      shared).

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

test('landing priority: on-screen covers load promptly after a teleport', async ({ page }) => {
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
  const missing: string[] = []
  for (const u of onScreen) {
    const t = timings.find((e) => key(e.url) === key(u))
    // Every on-screen row must have issued its fetch AT ALL.
    if (!t) missing.push(u)
    // …and it must not have started absurdly late after settle (the old
    // "5 s to load the landing" symptom; windowed rows fetch at mount, so
    // the start should be near settle — the bound absorbs gate decay).
    else expect(t.start - settleAt, `on-screen fetch started ${Math.round(t.start - settleAt)}ms after settle`).toBeLessThan(2500)
  }
  expect(missing, 'on-screen rows without any cover fetch').toEqual([])

  // The landing is not just fetched — it is LOADED (complete images).
  const band = await page.evaluate(() => {
    const vh = window.innerHeight
    const mid = vh / 2
    let near = 0
    let loaded = 0
    for (const img of document.querySelectorAll<HTMLImageElement>('img[src*="getCoverArt"]')) {
      const r = img.getBoundingClientRect()
      if (Math.abs(r.top + r.height / 2 - mid) <= vh) {
        near++
        if (img.complete && img.naturalWidth > 0) loaded++
      }
    }
    return { near, loaded }
  })
  expect(band.near).toBeGreaterThanOrEqual(4)
  expect(band.loaded / band.near).toBeGreaterThanOrEqual(0.8)
})

test('no stale flood: nothing launched mid-gesture is still in flight at settle+2.5 s', async ({ page }) => {
  test.setTimeout(30_000)
  await bootBigLibrary(page)
  const scroller = page.locator(LIST_SCROLLER).first()
  await expect(scroller).toBeVisible()
  await page.waitForTimeout(800)

  await fling(page, LIST_SCROLLER, 14, 50)
  const settleAt = await page.evaluate(() => performance.now())
  await page.waitForTimeout(2500)

  const stillPending = await page.evaluate(() => {
    const now = performance.now()
    return performance
      .getEntriesByType('resource')
      .filter((e) => { const r = e as PerformanceResourceTiming; return e.name.includes('getCoverArt') && r.startTime > now - 4000 && (r.responseEnd === 0 || r.responseEnd > now) })
      .length
  })
  expect(stillPending).toBe(0)
  void settleAt
})

import { test, expect, type Page } from '@playwright/test'
import {
  bootBigLibrary, fling, coverImgsIn, nearBandLoad,
  LIST_SCROLLER, QUEUE_SCROLLER,
} from './thumbflowHelpers'

// Per-view matrix for the thumbnail pipeline (thumbflowHelpers owns the
// mock/counting rules; thumbflow-stress.spec owns the compounding/race
// cases): proves the SAME contract on every long-list surface — the chunked
// Albums/Artists grids, the deliberately UNCHUNKED Queue view (its drag
// reactivity needs the full list), and across view switches, whose
// conditional mounts destroy and rebuild the whole surface mid-session.

/** Shared per-view stress body: fling the view hard, prove mid-gesture arming
 *  stayed bounded, then prove the landing screen LOADED (ratio, not count)
 *  and the mounted-img set stayed viewport-sized (the unlatch). */
async function runGridViewStress(page: Page, open: (page: Page) => Promise<void>): Promise<void> {
  await bootBigLibrary(page)
  await open(page)
  await expect(page.locator(`${LIST_SCROLLER}`).first()).toBeVisible()
  await page.waitForTimeout(900) // first chunk arms + settles

  await fling(page, LIST_SCROLLER, 8, 50)
  await page.waitForTimeout(250) // sample the mid-gesture tail
  const midFling = await coverImgsIn(page, LIST_SCROLLER)
  console.log(`[thumbflow-views] mid-fling imgs: ${midFling}`)
  // Gesture-paced: one 4-row batch per 250 ms hold window (~2 batches here),
  // even though the chunked grid kept GROWING under the fling.
  expect(midFling).toBeLessThan(40)

  await page.waitForTimeout(2500) // gate opens; landing screen loads
  const band = await nearBandLoad(page, LIST_SCROLLER, 1.0)
  const total = await coverImgsIn(page, LIST_SCROLLER)
  console.log(`[thumbflow-views] landed band: ${JSON.stringify(band)}, total: ${total}`)
  // The landing screen actually loaded (an 8vh hop clamps at the list END,
  // where the near band is small — assert it LOADED, not its size).
  expect(band.near).toBeGreaterThanOrEqual(4)
  expect(band.ratio).toBeGreaterThanOrEqual(0.8)
  // The mounted set stayed viewport-sized even though the fling mounted the
  // whole 220-group library (chunk sentinel runs to terminal under the fling).
  expect(total).toBeLessThan(200)
}

test('Albums grid: a scrollbar fling stays bounded and the landing screen loads', async ({ page }) => {
  await runGridViewStress(page, async (p) => {
    await p.getByRole('button', { name: 'Albums', exact: true }).click()
  })
})

test('Artists grid: a scrollbar fling stays bounded and the landing screen loads', async ({ page }) => {
  await runGridViewStress(page, async (p) => {
    await p.getByRole('button', { name: 'Artists', exact: true }).click()
  })
})

test('grids: scrolled-past covers unlatch and re-arm on the way back', async ({ page }) => {
  await bootBigLibrary(page)
  await page.getByRole('button', { name: 'Albums', exact: true }).click()
  await page.waitForTimeout(900)

  // Jump to the bottom of the library, let it load, jump back to the top.
  await fling(page, LIST_SCROLLER, 6, 50)
  await page.waitForTimeout(2200)
  await page.evaluate((sel) => {
    const scroller = document.querySelector<HTMLElement>(sel)
    if (!scroller) throw new Error('scroller not found')
    scroller.scrollTop = 0
    scroller.dispatchEvent(new Event('scroll'))
  }, LIST_SCROLLER)
  await page.waitForTimeout(2200)

  const band = await nearBandLoad(page, LIST_SCROLLER, 1.0)
  const total = await coverImgsIn(page, LIST_SCROLLER)
  console.log(`[thumbflow-views] back-at-top band: ${JSON.stringify(band)}, total: ${total}`)
  // Re-entry re-armed the top of the grid (the unlatch must never strand a
  // row: the request observer re-fires on every crossing, and the stable
  // salt makes the re-request an HTTP-cache hit).
  expect(band.near).toBeGreaterThanOrEqual(4)
  expect(band.ratio).toBeGreaterThanOrEqual(0.8)
  expect(total).toBeLessThan(200)
})

test('Queue view: a long queue scrolls with bounded arming and loads where it lands', async ({ page }) => {
  await bootBigLibrary(page)
  await page.waitForTimeout(900)

  // Enqueue 50 rows — no playback, no audio machinery; the queue LIST is the
  // surface under test. handleAdd stops propagation, so these clicks do not
  // also trigger the rows' own play action.
  const addButtons = page.getByRole('button', { name: 'Add to queue' })
  const n = Math.min(await addButtons.count(), 50)
  expect(n).toBeGreaterThanOrEqual(40)
  for (let i = 0; i < n; i++) await addButtons.nth(i).click()

  // 'Open queue' lives in the Now Playing overlay — the path is mini player
  // (div[role=button].ui-island) → Now Playing → Open queue.
  await page.locator('div.ui-island[role="button"]').first().click()
  await page.getByRole('button', { name: 'Open queue' }).click()
  await page.getByRole('button', { name: 'Close queue' }).waitFor({ state: 'visible' })
  await page.waitForTimeout(600)

  // All queue counters are scoped to the overlay's scroller: the library
  // stays mounted underneath and would pollute document-wide counts.
  await fling(page, QUEUE_SCROLLER, 5, 50)
  await page.waitForTimeout(250)
  const midFling = await coverImgsIn(page, QUEUE_SCROLLER)
  console.log(`[thumbflow-views] queue mid-fling imgs: ${midFling}`)
  expect(midFling).toBeLessThan(40)

  await page.waitForTimeout(2200)
  const band = await nearBandLoad(page, QUEUE_SCROLLER, 1.0)
  const total = await coverImgsIn(page, QUEUE_SCROLLER)
  console.log(`[thumbflow-views] queue band: ${JSON.stringify(band)}, total: ${total}`)
  expect(band.near).toBeGreaterThanOrEqual(4)
  expect(band.ratio).toBeGreaterThanOrEqual(0.8)
  // The queue renders its full list (no chunking), so this bounds the latch
  // to the unlatch window rather than an exact count.
  expect(total).toBeLessThan(120)
})

test('switching views after flings leaves no pile-up behind', async ({ page }) => {
  await bootBigLibrary(page)
  await page.waitForTimeout(900)

  await fling(page, LIST_SCROLLER, 6, 50)
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: 'Albums', exact: true }).click()
  await page.waitForTimeout(600)
  await fling(page, LIST_SCROLLER, 6, 50)
  await page.waitForTimeout(1200)
  // Back to Songs: the conditional mount destroyed the Albums DOM, and the
  // Songs remount must rebuild a bounded, loading landing screen.
  await page.getByRole('button', { name: 'Songs', exact: true }).click()
  await page.waitForTimeout(2200)

  const total = await coverImgsIn(page, LIST_SCROLLER)
  const band = await nearBandLoad(page, LIST_SCROLLER, 1.0)
  console.log(`[thumbflow-views] after view-switching: total ${total}, band ${JSON.stringify(band)}`)
  // The remount restored the mid-list scroll position, so the ~3vh far
  // window legitimately re-arms on mount (IO reports its initial state) —
  // the bound is the unlatch window (~55 rows) plus the landing, not the
  // whole 440-row list.
  expect(total).toBeLessThan(120)
  expect(band.near).toBeGreaterThanOrEqual(4)
  expect(band.ratio).toBeGreaterThanOrEqual(0.8)
})

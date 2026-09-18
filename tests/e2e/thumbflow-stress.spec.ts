import { test, expect, type Page } from '@playwright/test'
import {
  bootBigLibrary, fling, coverImgsIn, nearBandLoad,
  LIST_SCROLLER, QUEUE_SCROLLER,
} from './thumbflowHelpers'

// Dedicated stress cases beyond thumbflow-views.spec.ts: the *compounding*
// and *race* profiles. views.spec proves one fling per view; this file proves
// the policies hold when gestures stack, when the gesture reverses mid-hold,
// and when a slow drag crosses a chunked grid — the cases where a leaky
// unlatch or an unbounded pace would only show up as accumulation.

test.describe.configure({ mode: 'serial' })

async function openAlbums(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Albums', exact: true }).click()
  await expect(page.locator(LIST_SCROLLER).first()).toBeVisible()
}

test('compounding: four fling-and-settle rounds never accumulate mounted covers', async ({ page }) => {
  await bootBigLibrary(page)
  await openAlbums(page)
  await page.waitForTimeout(900)

  for (let round = 1; round <= 4; round++) {
    await fling(page, LIST_SCROLLER, 3, 60)
    await page.waitForTimeout(2000)
    const total = await coverImgsIn(page, LIST_SCROLLER)
    const band = await nearBandLoad(page, LIST_SCROLLER, 1.0)
    console.log(`[thumbflow-stress] round ${round}: total ${total}, band ${JSON.stringify(band)}`)
    // Each round's landing must actually load, and the mounted set must stay
    // round-bounded — a leaking unlatch would grow the total every round.
    expect(band.near).toBeGreaterThanOrEqual(4)
    expect(band.ratio).toBeGreaterThanOrEqual(0.8)
    expect(total).toBeLessThan(120)
  }
})

test('grid slow drag: the visible tier loads the reading position mid-gesture', async ({ page }) => {
  await bootBigLibrary(page)
  await openAlbums(page)
  await page.waitForTimeout(900)

  // The drag and the mid-gesture sample happen INSIDE one page evaluate:
  // sampling at step 15 while scroll events still fire every 33 ms is the
  // only honest way to observe the visible tier — after the drag ends the
  // gate fully re-opens and the sample would prove nothing.
  const midSample = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('div.flex-1.overflow-y-auto')
    if (!scroller) throw new Error('scroller not found')
    const vh = window.innerHeight
    const mid = vh / 2
    const bandLoad = () => {
      let near = 0
      let loaded = 0
      for (const img of scroller.querySelectorAll<HTMLImageElement>('img[src*="getCoverArt"]')) {
        const r = img.getBoundingClientRect()
        if (Math.abs(r.top + r.height / 2 - mid) <= vh) {
          near++
          if (img.complete && img.naturalWidth > 0) loaded++
        }
      }
      return { near, loaded }
    }
    return new Promise<{ atStep15: { near: number; loaded: number } }>((resolve) => {
      let step = 0
      const timer = setInterval(() => {
        step++
        scroller.scrollTop += 60
        scroller.dispatchEvent(new Event('scroll'))
        if (step === 15) {
          // Mid-gesture: the far pre-roll is HELD, so any newly-loaded band
          // row got there through the visible tier.
          resolve({ atStep15: bandLoad() })
          clearInterval(timer)
        }
      }, 33)
    })
  })
  console.log(`[thumbflow-stress] grid mid-drag band: ${JSON.stringify(midSample.atStep15)}`)
  // Rows that entered the band during THIS drag are loaded while the gesture
  // is still live (the original binary hold left them as placeholders).
  expect(midSample.atStep15.near).toBeGreaterThanOrEqual(4)
  expect(midSample.atStep15.loaded).toBeGreaterThanOrEqual(2)

  // And the settled drag-end state is complete.
  await page.waitForTimeout(1200)
  const band = await nearBandLoad(page, LIST_SCROLLER, 1.0)
  expect(band.ratio).toBeGreaterThanOrEqual(0.8)
})

test('mid-gesture reversal: reversing a fling loads where you land', async ({ page }) => {
  await bootBigLibrary(page)
  await openAlbums(page)
  await page.waitForTimeout(900)

  // One 12vh hop down, then back to the top while the hold from the first
  // hop is still fresh — the reversal lands among rows that unlatched on
  // departure and must re-arm through the re-opened gate.
  await fling(page, LIST_SCROLLER, 1, 60)
  await page.waitForTimeout(120)
  await page.evaluate((sel) => {
    const scroller = document.querySelector<HTMLElement>(sel)
    if (!scroller) throw new Error('scroller not found')
    scroller.scrollTop = 0
    scroller.dispatchEvent(new Event('scroll'))
  }, LIST_SCROLLER)
  await page.waitForTimeout(2000)

  const band = await nearBandLoad(page, LIST_SCROLLER, 1.0)
  const total = await coverImgsIn(page, LIST_SCROLLER)
  console.log(`[thumbflow-stress] reversal band: ${JSON.stringify(band)}, total: ${total}`)
  expect(band.near).toBeGreaterThanOrEqual(4)
  expect(band.ratio).toBeGreaterThanOrEqual(0.8)
  expect(total).toBeLessThan(120)
})

test('queue: a fling followed by immediate close-and-reopen stays clean', async ({ page }) => {
  await bootBigLibrary(page)
  await page.waitForTimeout(900)

  const addButtons = page.getByRole('button', { name: 'Add to queue' })
  const n = Math.min(await addButtons.count(), 50)
  for (let i = 0; i < n; i++) await addButtons.nth(i).click()

  await page.locator('div.ui-island[role="button"]').first().click()
  await page.getByRole('button', { name: 'Open queue' }).click()
  await page.getByRole('button', { name: 'Close queue' }).waitFor({ state: 'visible' })
  await page.waitForTimeout(600)

  // Fling, then close the overlay immediately — unmounting mid-flight must
  // abandon the queue's in-flight arming without stranding anything.
  // closeQueue() reopens Now Playing when a current track exists (the first
  // enqueue made one), so the reopen path is queue → Now Playing → queue.
  await fling(page, QUEUE_SCROLLER, 3, 60)
  await page.getByRole('button', { name: 'Close queue' }).click()
  await page.getByRole('button', { name: 'Open queue' }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Open queue' }).click()
  await page.getByRole('button', { name: 'Close queue' }).waitFor({ state: 'visible' })
  await page.waitForTimeout(2200)

  const band = await nearBandLoad(page, QUEUE_SCROLLER, 1.0)
  const total = await coverImgsIn(page, QUEUE_SCROLLER)
  console.log(`[thumbflow-stress] queue reopen band: ${JSON.stringify(band)}, total: ${total}`)
  expect(band.near).toBeGreaterThanOrEqual(4)
  expect(band.ratio).toBeGreaterThanOrEqual(0.8)
  expect(total).toBeLessThan(120)
})

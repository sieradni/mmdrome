import { test, expect, type Page } from '@playwright/test'
import {
  bootSongLibrary, fling, coverImgsIn, nearBandLoad,
  QUEUE_SCROLLER,
} from './thumbflowHelpers'

// The REAL long-queue accumulation path, as the user described it: playing
// through auto-queue rows grows the USER queue (each advance promotes the
// played track above the fold) while replenish keeps the auto side full —
// the queue's history lives ABOVE current, so the scroll position rides near
// the bottom of a list that only grows upward. Stress cases:
//
//  1. Album play-through — 40 Next presses (the user's "played many songs"
//     session), via the mini-bar Next control scoped exactly as
//     offline-advance.spec does (the Now Playing overlay renders a duplicate
//     earlier in the DOM and swallows naive .first() clicks).
//  2. Mega-album flood — a single 500-song album played in full puts ALL 500
//     in the user queue, the worst case for the deliberately UNCHUNKED
//     QueueView (its drag/reorder reactivity needs the full list).
//
// Both assert the thumbnail contract: bounded arming, a loading landing
// screen (load RATIO — thumbflowHelpers' counting rules), and a
// viewport-sized mounted set (the unlatch). The stream mock answers the
// decodable 74-hour WAV, so nothing ends on its own; every advance is
// explicit and deterministic.

function megaAlbum(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `q-${i}`,
    title: `Song ${i}`,
    artist: 'Flood Artist',
    album: 'Flood Album',
    duration: 180,
    track: i + 1,
    year: 2024,
    genre: 'Test',
    suffix: 'mp3',
    bitRate: 320,
    size: 8000000,
    starred: 'false',
    created: '2024-01-01T00:00:00Z',
    albumId: 'al-flood',
    path: `Music/Flood/Track ${i}.mp3`,
  }))
}

/** The mini-bar Next button, scoped past the hidden Now Playing overlay's
 *  duplicate (which renders earlier in the DOM and swallows .first()). */
function miniNext(page: Page) {
  return page
    .locator('div[role="button"]', { has: page.getByRole('button', { name: 'Next track' }) })
    .getByRole('button', { name: 'Next track' })
}

async function openQueue(page: Page): Promise<void> {
  await page.locator('div.ui-island[role="button"]').first().click()
  await page.getByRole('button', { name: 'Open queue' }).click()
  await page.getByRole('button', { name: 'Close queue' }).waitFor({ state: 'visible' })
  await page.waitForTimeout(600)
}

/** Press Next n times, waiting for each advance to settle (the promote +
 *  replenish + crossfade machinery runs per transition). */
async function advanceN(page: Page, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await miniNext(page).click()
    await page.waitForTimeout(350)
  }
}

test('album play-through: 40 advances grow the queue and the queue view stays bounded', async ({ page }) => {
  test.setTimeout(120_000)
  const lib = Array.from({ length: 60 }, (_, i) => ({
    id: `s-${i}`,
    title: `Track ${i} of Album 0`,
    artist: 'Artist 0',
    album: 'Album 0000',
    duration: 180,
    track: i + 1,
    year: 2024,
    genre: 'Test',
    suffix: 'mp3',
    bitRate: 320,
    size: 8000000,
    starred: 'false',
    created: '2024-01-01T00:00:00Z',
    albumId: 'al-0',
    path: `Music/Album 0/Track ${i}.mp3`,
  }))
  await bootSongLibrary(page, lib)
  await page.waitForTimeout(900)

  // Start playback from the Songs list, then accumulate history the way a
  // real session does: repeated Next presses through the auto queue.
  await page.locator('[data-track-id]').first().click()
  await page.waitForTimeout(1000)
  await advanceN(page, 40)
  await openQueue(page)

  // A 60-track library supports one auto fill; after 40 played, the user
  // queue carries the promotion history (played rows stay above current).
  const userCount = await page.evaluate(() => {
    const group = document.querySelector('[aria-label="User queue"]')
    return group ? group.querySelectorAll('[data-track-id]').length : 0
  })
  console.log(`[queue-stress] user-queue rows after 40 advances: ${userCount}`)
  expect(userCount).toBeGreaterThan(20)

  // Fling DOWN through the auto side, then back UP through the history —
  // the accumulation side is above current, so the up-leg is the stress.
  await fling(page, QUEUE_SCROLLER, 3, 60)
  await page.waitForTimeout(250)
  const midFling = await coverImgsIn(page, QUEUE_SCROLLER)
  console.log(`[queue-stress] mid-fling imgs: ${midFling}`)
  expect(midFling).toBeLessThan(40)

  await page.evaluate((sel) => {
    const scroller = document.querySelector<HTMLElement>(sel)
    if (!scroller) throw new Error('scroller not found')
    scroller.scrollTop = 0
    scroller.dispatchEvent(new Event('scroll'))
  }, QUEUE_SCROLLER)
  await page.waitForTimeout(2200)

  const band = await nearBandLoad(page, QUEUE_SCROLLER, 1.0)
  const total = await coverImgsIn(page, QUEUE_SCROLLER)
  console.log(`[queue-stress] history-top band: ${JSON.stringify(band)}, total: ${total}`)
  expect(band.near).toBeGreaterThanOrEqual(4)
  expect(band.ratio).toBeGreaterThanOrEqual(0.8)
  expect(total).toBeLessThan(70)
})

test('mega-album flood: a 500-song queue scrolls bounded and its landing screen loads', async ({ page }) => {
  test.setTimeout(180_000)
  await bootSongLibrary(page, megaAlbum(500))
  await page.waitForTimeout(900)

  // Play All queues the entire album and starts row 0 itself — no overlay is
  // open after boot, so the Albums tab is directly reachable in the bottom nav.
  await page.getByRole('button', { name: 'Albums', exact: true }).click()
  await page.locator('[data-album]').first().click()
  await page.getByRole('button', { name: 'Play All' }).click()
  await page.waitForTimeout(1500)

  // Sanity: Play All replaced the queue with the whole album (scoped to the
  // queue scroller — the library below carries [data-track-id] rows too).
  await openQueue(page)
  const rows = await page.evaluate((sel) => {
    const root = document.querySelector(sel)
    return root ? root.querySelectorAll('[data-track-id]').length : 0
  }, QUEUE_SCROLLER)
  console.log(`[queue-stress] rendered queue rows: ${rows}`)
  expect(rows).toBeGreaterThanOrEqual(500)

  // Down through 500 rows, then the up-leg through the whole list.
  await fling(page, QUEUE_SCROLLER, 4, 60)
  await page.waitForTimeout(250)
  const midFling = await coverImgsIn(page, QUEUE_SCROLLER)
  console.log(`[queue-stress] flood mid-fling imgs: ${midFling}`)
  expect(midFling).toBeLessThan(40)

  await page.evaluate((sel) => {
    const scroller = document.querySelector<HTMLElement>(sel)
    if (!scroller) throw new Error('scroller not found')
    scroller.scrollTop = 0
    scroller.dispatchEvent(new Event('scroll'))
  }, QUEUE_SCROLLER)
  await page.waitForTimeout(2200)

  const band = await nearBandLoad(page, QUEUE_SCROLLER, 1.0)
  const total = await coverImgsIn(page, QUEUE_SCROLLER)
  console.log(`[queue-stress] flood band: ${JSON.stringify(band)}, total: ${total}`)
  expect(band.near).toBeGreaterThanOrEqual(4)
  expect(band.ratio).toBeGreaterThanOrEqual(0.8)
  expect(total).toBeLessThan(70)
})

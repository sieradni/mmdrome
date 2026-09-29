import { test, expect, type Page } from '@playwright/test'
import { bootSongLibrary, QUEUE_SCROLLER } from './thumbflowHelpers'

// Regression pins for the 1.2.44 queue-row field reports (2026-09-29): under
// the virtual windows the row template re-derived the combined index from the
// mount position (`userWin.start + originalCombinedIdx` — a DOUBLE count;
// originalCombinedIdx is already the true combined index, stamped on the full
// preview arrays and preserved through slice). One corrupted index fed four
// consumers at once: play taps (played the wrong row or hit playTrackAt's
// bounds guard → nothing), the now-playing indicator, the drag drop-target,
// and the drag identity. animate:flip on the windowed each made surviving
// rows slide on every window move (the "queue is slidy" report), and
// jump-to-current silently no-oped when the row was outside the window.
//
// App semantics the fixtures must respect (learned from the first run's
// snapshots): the FIRST Add-to-queue starts playback of that row (it becomes
// active, auto-queue replenishes); later Adds are NO-OPS when the track is
// already queued (the mutation layer dedupes; the replenished auto queue
// already holds most of a small library). A BIG library therefore matters:
// user rows accumulate only when the add ordering leaves them out of the
// auto fill, or through the row action buttons.

const LIB_ALBUMS = 40
const TRACKS_PER_ALBUM = 12

function bigLib(): Record<string, unknown>[] {
  const songs: Record<string, unknown>[] = []
  for (let a = 0; a < LIB_ALBUMS; a++) {
    for (let t = 0; t < TRACKS_PER_ALBUM; t++) {
      songs.push({
        id: `qr-${a}-${t}`,
        title: `Q Track ${String(a).padStart(2, '0')}.${t}`,
        artist: `Q Artist ${a}`,
        album: `Q Album ${String(a).padStart(2, '0')}`,
        duration: 180,
        track: t + 1,
        year: 2024,
        genre: 'Test',
        suffix: 'mp3',
        bitRate: 320,
        size: 8000000,
        starred: 'false',
        created: '2024-01-01T00:00:00Z',
        albumId: `qal-${a}`,
        path: `Music/Q Album ${String(a).padStart(2, '0')}/Track ${t}.mp3`,
      })
    }
  }
  return songs
}

async function bootBig(page: Page): Promise<void> {
  await bootSongLibrary(page, bigLib())
  await page.waitForTimeout(900)
}

async function openQueue(page: Page): Promise<void> {
  await page.locator('div.ui-island[role="button"]').first().click()
  await page.getByRole('button', { name: 'Open queue' }).click()
  await page.getByRole('button', { name: 'Close queue' }).waitFor({ state: 'visible' })
  await page.waitForTimeout(600)
}

/** The mini-bar island's now-playing title (first .ui-island in the home
 *  bottom bar — inside the queue overlay the same island class renders in
 *  the pinned Now Playing card, so callers scope by what they need). */
function homeMiniTitle(page: Page): Promise<string> {
  return page.evaluate(() => {
    const island = document.querySelector('main + generic, body') // fallback
    void island
    const buttons = document.querySelectorAll('div.ui-island[role="button"]')
    const el = buttons[0]
    return el ? (el.querySelector('p')?.textContent ?? '') : ''
  })
}

test('row data-combined-index equals the true combined index (no window double-count)', async ({ page }) => {
  await bootBig(page)

  // Play row 0 of the library (the first tap starts it), then enqueue three
  // MORE rows: they land in the USER section ahead of the auto tail.
  await page.locator('[data-track-id]').first().click()
  await page.waitForTimeout(1000)
  const addButtons = page.getByRole('button', { name: 'Add to queue' })
  for (const i of [5, 17, 29]) await addButtons.nth(i).click()
  await page.waitForTimeout(400)

  await openQueue(page)

  // User rows are stamped 0..n-1 with NO window offset — the double-count
  // produced userWin.start + i. The user section here is short (the adds
  // before the auto fill was seeded), so read every row.
  const stamped = await page.evaluate(() => {
    return [...document.querySelectorAll('[aria-label="User queue"] [data-combined-index]')]
      .map((el) => Number((el as HTMLElement).dataset.combinedIndex))
      .sort((a, b) => a - b)
  })
  expect(stamped.length).toBeGreaterThanOrEqual(2)
  expect(stamped[0]).toBe(0)
  for (let i = 1; i < stamped.length; i++) expect(stamped[i]).toBe(stamped[i - 1] + 1)

  // The ACTIVE row carries combined index = activeIndex (the store's
  // anchor). Read both from the same source of truth.
  const activeIdx = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[aria-label="User queue"] [data-combined-index]')]
    const cur = rows.find((el) => el.classList.contains('ui-now-playing-row') || el.querySelector('.ui-now-playing-row'))
    return cur ? Number((cur as HTMLElement).dataset.combinedIndex) : null
  })
  expect(activeIdx).toBe(0)
})

test('the playing row shows the now-playing indicator inside the queue', async ({ page }) => {
  await bootBig(page)
  await page.locator('[data-track-id]').first().click()
  await page.waitForTimeout(1000)
  await openQueue(page)
  // SCOPED to the overlay: the library stays mounted underneath and carries
  // its own .ui-now-playing-row on the Songs list.
  const inOverlay = page.locator('div.z-40 .ui-now-playing-row')
  await expect(inOverlay).toHaveCount(1)
})

test('tapping a queue row plays THAT row', async ({ page }) => {
  await bootBig(page)
  // Play row 0, enqueue three more so the user section has real targets.
  await page.locator('[data-track-id]').first().click()
  await page.waitForTimeout(1000)
  const addButtons = page.getByRole('button', { name: 'Add to queue' })
  for (const i of [5, 17, 29]) await addButtons.nth(i).click()
  await page.waitForTimeout(400)
  await openQueue(page)

  // Tap the LAST user row; the home mini-bar must switch to it.
  const rows = page.locator('[aria-label="User queue"] .queue-track-item')
  const count = await rows.count()
  expect(count).toBeGreaterThanOrEqual(2)
  const target = rows.nth(count - 1)
  const title = ((await target.locator('p').first().textContent()) ?? '').trim()
  await target.click()
  await page.waitForTimeout(900)
  expect(await homeMiniTitle(page)).toBe(title)
})

test('drag to reorder: the drop reorders the store', async ({ page }) => {
  await bootBig(page)
  await page.locator('[data-track-id]').first().click()
  await page.waitForTimeout(1000)
  const addButtons = page.getByRole('button', { name: 'Add to queue' })
  for (const i of [5, 17, 29]) await addButtons.nth(i).click()
  await page.waitForTimeout(400)
  await openQueue(page)

  const firstRow = page.locator('[aria-label="User queue"] .queue-track-item').first()
  const secondRow = page.locator('[aria-label="User queue"] .queue-track-item').nth(1)
  const firstTitle = ((await firstRow.locator('p').first().textContent()) ?? '').trim()
  const secondTitle = ((await secondRow.locator('p').first().textContent()) ?? '').trim()

  // Drag row 0's handle onto row 1 (a one-row swap).
  const handle = firstRow.locator('.drag-handle')
  const source = await handle.boundingBox()
  const target = await secondRow.boundingBox()
  if (!source || !target) throw new Error('drag geometry missing')
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(source.x + source.width / 2, target.y + target.height / 2, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(600)

  const newFirst = ((await page.locator('[aria-label="User queue"] .queue-track-item').first().locator('p').first().textContent()) ?? '').trim()
  expect(newFirst).toBe(secondTitle)
  expect(newFirst).not.toBe(firstTitle)
})

test('drag preview appears over the dragged row', async ({ page }) => {
  await bootBig(page)
  await page.locator('[data-track-id]').first().click()
  await page.waitForTimeout(1000)
  const addButtons = page.getByRole('button', { name: 'Add to queue' })
  for (const i of [5, 17]) await addButtons.nth(i).click()
  await page.waitForTimeout(400)
  await openQueue(page)
  const handle = page.locator('[aria-label="User queue"] .queue-track-item').first().locator('.drag-handle')
  const source = await handle.boundingBox()
  if (!source) throw new Error('handle missing')
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(source.x + source.width / 2, source.y - 40, { steps: 4 })
  await expect(page.locator('div.pointer-events-none.fixed.z-50')).toBeVisible()
  await page.mouse.up()
})

test('window scrolling does not slide surviving rows (no flip on window moves)', async ({ page }) => {
  await bootBig(page)
  // A long AUTO section gives the window room to move.
  await page.locator('[data-track-id]').first().click()
  await page.waitForTimeout(1500)
  await openQueue(page)
  const y1 = await page.evaluate(() => {
    const row = document.querySelector('[aria-label="Auto queue"] .queue-track-item')
    return row ? Math.round(row.getBoundingClientRect().top) : -1
  })
  await page.evaluate((sel) => {
    const sc = document.querySelector<HTMLElement>(sel)
    if (sc) { sc.scrollTop += 56 * 3; sc.dispatchEvent(new Event('scroll')) }
  }, QUEUE_SCROLLER)
  await page.waitForTimeout(400)
  const y2 = await page.evaluate(() => {
    const row = document.querySelector('[aria-label="Auto queue"] .queue-track-item')
    return row ? Math.round(row.getBoundingClientRect().top) : -1
  })
  // No flip residue: the row's offset from its grid point must be 0 — a
  // flip-in-flight row sits BETWEEN row positions. (Both same-row and
  // different-row cases satisfy this; the double-count + flip combination
  // did not.)
  const delta = Math.abs(y2 - y1) % 56
  expect(delta).toBeLessThan(2)
})

test('jump to current works when the row is outside the window', async ({ page }) => {
  await bootBig(page)
  await page.locator('[data-track-id]').first().click()
  await page.waitForTimeout(1000)
  // Enqueue a few so the user section exists, then scroll the queue far
  // down into the auto section.
  const addButtons = page.getByRole('button', { name: 'Add to queue' })
  for (const i of [5, 17]) await addButtons.nth(i).click()
  await openQueue(page)
  await page.evaluate((sel) => {
    const sc = document.querySelector<HTMLElement>(sel)
    if (sc) { sc.scrollTop = sc.scrollHeight; sc.dispatchEvent(new Event('scroll')) }
  }, QUEUE_SCROLLER)
  await page.waitForTimeout(500)
  // Scoped to the overlay: the library's own jump button (behind the queue)
  // carries the same aria-label and would trip strict mode.
  await page.locator('div.z-40').getByRole('button', { name: 'Jump to currently playing track' }).click()
  // The current row must become visible (smooth scroll lands near center).
  await expect(page.locator('div.z-40 .ui-now-playing-row')).toBeVisible({ timeout: 5000 })
})

test('the empty island navigates to Now Playing', async ({ page }) => {
  await bootBig(page)
  // No playback: open the queue via the empty-state guard (the idle mini
  // tap opens the queue), then tap the pinned EMPTY island at the top of
  // the queue overlay ("Not playing").
  await page.locator('div.ui-island[role="button"]').first().click()
  await page.getByRole('button', { name: 'Open queue' }).click()
  await page.getByRole('button', { name: 'Close queue' }).waitFor({ state: 'visible' })
  await page.waitForTimeout(400)
  const island = page.locator('div.z-40 div.ui-island').first()
  await expect(island).toContainText('Not playing')
  await island.click()
  // The queue overlay closes; the expanded Now Playing (or library) shows.
  await expect(page.getByRole('button', { name: 'Close queue' })).toHaveCount(0)
})

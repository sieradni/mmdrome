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
// App semantics the fixtures must respect: the FIRST Add-to-queue starts
// playback of that row (it becomes active, auto-queue replenishes); every
// later Add APPENDS a new occurrence, duplicates included (queue redesign
// step 1 / D2 — the old dedupe no-op is gone). A BIG library still matters:
// it keeps the auto fill from mirroring the user rows, so the user section has
// enough independent rows for the reorder/scroll assertions.

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

test('duplicate songs render as independent occurrence rows (distinct keys, row-scoped remove)', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))
  await bootBig(page)

  // Play row 0, then press + on that same row twice: three copies of one
  // track in the user section (the append semantics are real end-to-end).
  await page.locator('[data-track-id]').first().click()
  await page.waitForTimeout(1000)
  const addButton = page.getByRole('button', { name: 'Add to queue', exact: true }).first()
  await addButton.click()
  await addButton.click()
  await page.waitForTimeout(400)
  await openQueue(page)

  const readRows = () => page.evaluate(() => {
    return [...document.querySelectorAll('[aria-label="User queue"] .queue-track-item')].map((el) => ({
      entry: (el as HTMLElement).dataset.entryId ?? '',
      track: (el as HTMLElement).dataset.trackId ?? '',
    }))
  })
  const before = await readRows()
  const dupId = before[0]?.track
  expect(dupId).toBeTruthy()
  const copies = before.filter((r) => r.track === dupId)
  expect(copies.length, 'three occurrences of the played song').toBe(3)

  // Occurrence keys, not ids: each copy is addressable on its own.
  const keys = before.map((r) => r.entry)
  expect(new Set(keys).size).toBe(keys.length)
  expect(keys.filter((k) => k.startsWith(`user:${dupId}`)).length).toBe(3)

  // Removing the SECOND copy removes exactly one row; both other copies of
  // the same song survive (indexOf(trackId) would have removed the first).
  const rows = page.locator('[aria-label="User queue"] .queue-track-item')
  await rows.nth(1).getByRole('button', { name: 'Remove from queue' }).click()
  await page.waitForTimeout(400)
  const after = await readRows()
  expect(after.length).toBe(before.length - 1)
  expect(after.filter((r) => r.track === dupId).length).toBe(2)
  // The removed row was a COPY, not the audible occurrence: the playing row
  // must stay the now-playing one (an id-equality skip would have advanced).
  const playing = page.locator('div.z-40 .ui-now-playing-row')
  await expect(playing).toHaveCount(1)
  await expect(playing).toHaveAttribute('data-track-id', dupId as string)
  expect(pageErrors).toEqual([])
})

test('pressing a library song queues and plays a NEW row instead of jumping to an old copy (D1)', async ({ page }) => {
  await bootBig(page)
  const rows = page.locator('[data-track-id]')
  const firstId = await rows.nth(0).getAttribute('data-track-id')
  const secondId = await rows.nth(1).getAttribute('data-track-id')
  expect(firstId).toBeTruthy()
  expect(secondId).toBeTruthy()

  // Press three songs the way a user does: play A, play B, then press A again.
  // A second press of A must QUEUE AND START a new row — the old path found A
  // in the history pile and teleported back to it without queueing anything.
  for (const id of [firstId, secondId, firstId]) {
    await page.locator(`[data-track-id="${id}"]`).first().click()
    await page.waitForTimeout(1200)
  }

  await openQueue(page)
  const readRows = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[aria-label="User queue"] .queue-track-item')].map((el) => ({
        track: (el as HTMLElement).dataset.trackId ?? '',
        index: Number((el as HTMLElement).dataset.combinedIndex),
        playing: el.classList.contains('ui-now-playing-row'),
      })),
    )

  const userRows = await readRows()
  expect(userRows.map((r) => r.track)).toEqual([firstId, secondId, firstId])
  // The press anchors its OWN new row: the third user row is playing, and the
  // history copy of the same song is still listed above it.
  const playing = userRows.filter((r) => r.playing)
  expect(playing).toHaveLength(1)
  expect(playing[0].track).toBe(firstId)
  expect(playing[0].index).toBe(2)
})

test('two Next presses skip two rows (G3: the second press is never re-targeted at the first)', async ({ page }) => {
  await bootBig(page)
  const rows = page.locator('[data-track-id]')
  // Four presses fill Up next with four user rows; the fourth is playing.
  for (let i = 0; i < 4; i++) {
    await rows.nth(i).click()
    await page.waitForTimeout(700)
  }
  await openQueue(page)

  const readRows = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('div.z-40 .queue-track-item')].map((el) => ({
        index: Number((el as HTMLElement).dataset.combinedIndex),
        track: (el as HTMLElement).dataset.trackId ?? '',
      })),
    )
  const before = await readRows()
  const start = before.find((r) => r.index >= 0 && r.index === 3)
  expect(start, 'the fourth pressed row is the audible one').toBeTruthy()
  const expected = before.filter((r) => r.index === 5)[0]
  expect(expected, 'two rows ahead are mounted').toBeTruthy()

  // TWO presses in ONE task: the second lands while the first row is still
  // loading (the D10 window). The old rule read that as "the active row was
  // removed" and re-loaded it, so the press was lost.
  await page.evaluate(() => {
    const next = document.querySelector('[aria-label="Next track"]') as HTMLButtonElement | null
    if (!next) throw new Error('Next control missing')
    next.click()
    next.click()
  })
  await page.waitForTimeout(1200)

  const playing = page.locator('div.z-40 .ui-now-playing-row')
  await expect(playing).toHaveCount(1)
  // The row TWO ahead is the one playing. (Its index becomes the user tail when
  // the post-load promotion appends it, so identity — not a fixed index — is
  // what this asserts; the row ONE ahead must not be the audible one.)
  await expect(playing).toHaveAttribute('data-track-id', expected.track)
  await expect(playing).toHaveAttribute('data-entry-id', `user:${expected.track}`)
})

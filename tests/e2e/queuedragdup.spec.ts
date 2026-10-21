import { test, expect, type Page } from '@playwright/test'
import { bootSongLibrary } from './thumbflowHelpers'

// Browser pin for the duplicate row identity (queue redesign step 1).
//
// History: the 2026-10-04 crash came from keying rows `u-${trackId}` and
// deduping cross-section duplicates in the drag planner. The redesign removes
// BOTH premises: duplicates are legal occurrences (D3) and each row is keyed
// by its occurrence (`u-<id>#<n>`, D4), so a drag must never need to collapse
// a copy. This spec drives the real view path with THREE copies of one song
// in the user section:
//   1. the rows render with distinct occurrence keys (no each-key collision);
//   2. dragging one copy reorders without losing a copy;
//   3. removing a row removes exactly that copy, not `indexOf(id)`'s first;
//   4. the overlay stays interactive throughout.
//
// A tall viewport keeps the whole short queue on screen: a scrolled-out handle
// silently no-ops the drag and the test would pass vacuously.
test.use({ viewport: { width: 1280, height: 1400 } })

const TRACKS = 10

function smallLib(): Record<string, unknown>[] {
  return Array.from({ length: TRACKS }, (_, i) => ({
    id: `dup-${i}`,
    title: `Dup Track ${i}`,
    artist: 'Dup Artist',
    album: 'Dup Album',
    duration: 180,
    track: i + 1,
    year: 2024,
    genre: 'Test',
    suffix: 'mp3',
    bitRate: 320,
    size: 8000000,
    starred: 'false',
    created: '2024-01-01T00:00:00Z',
    albumId: 'dup-al',
    path: `Music/Dup Album/Track ${i}.mp3`,
  }))
}

async function bootSmall(page: Page): Promise<void> {
  await bootSongLibrary(page, smallLib())
  await page.waitForTimeout(900)
}

async function openQueue(page: Page): Promise<void> {
  await page.locator('div.ui-island[role="button"]').first().click()
  await page.getByRole('button', { name: 'Open queue' }).click()
  await page.getByRole('button', { name: 'Close queue' }).waitFor({ state: 'visible' })
  await page.waitForTimeout(600)
}

function userRows(page: Page): Promise<{ entry: string; track: string }[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[aria-label="User queue"] .queue-track-item')].map((el) => ({
      entry: (el as HTMLElement).dataset.entryId ?? '',
      track: (el as HTMLElement).dataset.trackId ?? '',
    })),
  )
}

test('three copies of one song are independent rows; dragging one keeps all three', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  await bootSmall(page)
  // Play row 0 (the first tap starts playback), then queue TWO more copies of
  // that same song. Occurrence identity is the only thing that can represent
  // this without a key collision.
  await page.locator('[data-track-id]').first().click()
  await page.waitForTimeout(1200)
  const addButton = page.getByRole('button', { name: 'Add to queue', exact: true }).first()
  await addButton.click()
  await addButton.click()
  // One independent track after the copies, so the drop has an observable
  // neighbour and the section is not three identical rows.
  await page.getByRole('button', { name: 'Add to queue', exact: true }).nth(1).click()
  await page.waitForTimeout(500)
  await openQueue(page)

  expect(pageErrors).toEqual([])
  const before = await userRows(page)
  const dupId = before[0]?.track
  expect(dupId).toBeTruthy()
  expect(before.filter((r) => r.track === dupId).length).toBe(3)
  expect(new Set(before.map((r) => r.entry)).size).toBe(before.length)
  expect(before.some((r) => r.track !== dupId)).toBe(true)

  // Drag the SECOND duplicate's handle down past the independent track. The
  // old id-based planner either no-oped or moved the wrong copy; the point
  // here is that every copy survives and no key collides.
  const rows = page.locator('[aria-label="User queue"] .queue-track-item')
  const count = await rows.count()
  const handle = rows.nth(1).locator('.drag-handle')
  const source = await handle.boundingBox()
  const targetRow = rows.nth(count - 1)
  const target = await targetRow.boundingBox()
  if (!source || !target) throw new Error('drag geometry missing')
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(source.x + source.width / 2, target.y + target.height + 8, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(600)

  expect(pageErrors.filter((e) => /each_key_duplicate|Duplicate key/i.test(e))).toEqual([])
  const after = await userRows(page)
  expect(after.length, 'a drag never drops or duplicates a row').toBe(before.length)
  expect(after.filter((r) => r.track === dupId).length).toBe(3)
  expect(new Set(after.map((r) => r.entry)).size).toBe(after.length)

  // Remove the SECOND copy of the song: exactly that occurrence leaves, the
  // other two survive (the old path removed the first `indexOf(trackId)`).
  const dupRows = page.locator(`[aria-label="User queue"] .queue-track-item[data-track-id="${dupId}"]`)
  await dupRows.nth(1).getByRole('button', { name: 'Remove from queue' }).click()
  await page.waitForTimeout(400)
  const removed = await userRows(page)
  expect(removed.length).toBe(before.length - 1)
  expect(removed.filter((r) => r.track === dupId).length).toBe(2)
  expect(new Set(removed.map((r) => r.entry)).size).toBe(removed.length)

  // The overlay itself must still be interactive.
  await page.getByRole('button', { name: 'Close queue' }).click()
  await expect(page.getByRole('button', { name: 'Close queue' })).toHaveCount(0)
  expect(pageErrors).toEqual([])
})

test('dragging an AUTO copy of a queued song moves THAT occurrence into Up next (G5)', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  await bootSmall(page)
  // Play row 0, then queue three more songs. The auto fill recycles queued ids
  // once its unique pool runs dry (tier 3), which is exactly how a real
  // cross-section duplicate appears.
  await page.locator('[data-track-id]').first().click()
  await page.waitForTimeout(1200)
  const addButtons = page.getByRole('button', { name: 'Add to queue', exact: true })
  for (const i of [1, 2, 3]) await addButtons.nth(i).click()
  await page.waitForTimeout(600)
  await openQueue(page)

  const userBefore = await userRows(page)
  const autoIds: string[] = await page.evaluate(() =>
    [...document.querySelectorAll('[aria-label="Auto queue"] .queue-track-item')].map(
      (el) => (el as HTMLElement).dataset.trackId ?? '',
    ),
  )
  const userIds = userBefore.map((r) => r.track)
  const shared = autoIds.find((id) => userIds.includes(id))
  expect(
    shared,
    `fixture must reach a cross-section duplicate (user=${userIds.join(',')} auto=${autoIds.slice(0, 12).join(',')})`,
  ).toBeTruthy()

  // Drag the AUTO occurrence onto the TOP of Up next. Before occurrence
  // identity this moved the USER copy (the first `indexOf(trackId)`) or no-oped.
  const autoRow = page.locator(`[aria-label="Auto queue"] .queue-track-item[data-track-id="${shared}"]`).first()
  const handle = autoRow.locator('.drag-handle')
  const source = await handle.boundingBox()
  const target = await page.locator('[aria-label="User queue"] .queue-track-item').first().boundingBox()
  if (!source || !target) throw new Error('drag geometry missing')
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, target.y + 6, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(700)

  expect(pageErrors.filter((e) => /each_key_duplicate|Duplicate key/i.test(e))).toEqual([])
  const userAfter = await userRows(page)
  // The auto occurrence MOVED into the user section; the queued copy stayed.
  expect(userAfter.length).toBe(userBefore.length + 1)
  expect(userAfter.filter((r) => r.track === shared).length).toBe(2)
  expect(new Set(userAfter.map((r) => r.entry)).size).toBe(userAfter.length)
  const autoAfter: string[] = await page.evaluate(() =>
    [...document.querySelectorAll('[aria-label="Auto queue"] .queue-track-item')].map(
      (el) => (el as HTMLElement).dataset.trackId ?? '',
    ),
  )
  expect(autoAfter.length).toBe(autoIds.length - 1)
  expect(autoAfter[0]).not.toBe(shared)
  expect(pageErrors).toEqual([])
})

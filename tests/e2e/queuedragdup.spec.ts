import { test, expect, type Page } from '@playwright/test'
import { bootSongLibrary } from './thumbflowHelpers'

// Regression pin for the production `Each_key_duplicate` crash (2026-10-04):
// after a full/looped album play-through the auto tail holds cross-section
// duplicates (tier 3 deliberately recycles user-queued tracks — B4
// anti-starvation), and dragging one of those AUTO rows into the USER section
// used to append it beside its existing user copy. The preview is keyed
// `u-${trackId}`, so the duplicate threw from Svelte's each-key check MID-DRAG,
// aborting the effect flush — the queue overlay went inert (dead nav buttons).
//
// The fix lives in `planDragDrop` (dedupe-move into user; the converted prefix
// drops the dragged id) with a normalization pass in `applyDragDrop`. This spec
// drives the real view path: it asserts the fixture actually reaches the
// duplicate precondition, performs the auto→user drag through the pointer
// handlers, and then asserts the section holds unique ids and the overlay is
// still interactive.

// A tall viewport keeps BOTH queue sections on screen: the drag coordinates
// reach the auto row's handle and the user drop target without scrolling (a
// scrolled-out handle silently no-ops the drag and the test would pass
// vacuously).
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

function sectionIds(page: Page, label: 'User queue' | 'Auto queue'): Promise<string[]> {
  return page.evaluate(
    (l) =>
      [...document.querySelectorAll(`[aria-label="${l}"] .queue-track-item`)].map(
        (el) => (el as HTMLElement).dataset.trackId ?? '',
      ),
    label,
  )
}

test('dragging a cross-section duplicate auto row into the user queue does not crash the each keys', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(String(err)))

  await bootSmall(page)
  // Play row 0 (the first tap starts playback), then enqueue several more rows
  // so the user section has real rows ahead of a replenished auto tail.
  await page.locator('[data-track-id]').first().click()
  await page.waitForTimeout(1200)
  const addButtons = page.getByRole('button', { name: 'Add to queue' })
  for (const i of [1, 2, 3, 4]) await addButtons.nth(i).click()
  await page.waitForTimeout(500)
  await openQueue(page)

  const userIds = await sectionIds(page, 'User queue')
  const autoIds = await sectionIds(page, 'Auto queue')
  expect(userIds.length).toBeGreaterThan(0)
  expect(autoIds.length).toBeGreaterThan(0)

  // Precondition: a tier-3 cross-section duplicate is exactly what the bug
  // needed. Fail loudly here rather than pass vacuously if the fixture drifts.
  const autoDuplicatingUser = autoIds.find((id) => userIds.includes(id))
  expect(
    autoDuplicatingUser,
    `fixture must reach the cross-section duplicate precondition (user=${userIds.join(',')} auto=${autoIds.join(',')})`,
  ).toBeTruthy()

  // Drag that auto row onto the TOP of the user section (the reported gesture).
  const autoRow = page.locator(`[aria-label="Auto queue"] [data-track-id="${autoDuplicatingUser}"]`).first()
  const userRow = page.locator('[aria-label="User queue"] .queue-track-item').first()
  const handle = autoRow.locator('.drag-handle')
  const source = await handle.boundingBox()
  const target = await userRow.boundingBox()
  if (!source || !target) throw new Error('drag geometry missing')
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(source.x + source.width / 2, target.y + target.height / 2, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(600)

  // The each-key collision aborted the flush: no such error, and the user
  // section holds each id at most once. (Pre-fix this run throws
  // `https://svelte.dev/e/each_key_duplicate` during the drag.)
  const dupErrors = pageErrors.filter((e) => /each_key_duplicate|Duplicate key/i.test(e))
  expect(dupErrors).toEqual([])
  const afterUserIds = await sectionIds(page, 'User queue')
  expect(new Set(afterUserIds).size).toBe(afterUserIds.length)

  // The overlay itself must still be interactive (the crash left it inert).
  await page.getByRole('button', { name: 'Close queue' }).click()
  await expect(page.getByRole('button', { name: 'Close queue' })).toHaveCount(0)
  expect(pageErrors).toEqual([])
})

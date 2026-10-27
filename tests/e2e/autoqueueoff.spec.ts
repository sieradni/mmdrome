import { test, expect, type Page } from '@playwright/test'
import { bootSongLibrary } from './thumbflowHelpers'

// D9 (queue step 5): the auto queue can be switched OFF. Off means the
// suggestion source is EMPTY — the section leaves, no fill can resurrect it,
// and the view says "Auto queue off" instead of the filter warning (which means
// "nothing matches", a different fact). The toggle is persisted, and turning it
// back on rebuilds from the live rule. The queue tail rules (D8) lean on this:
// with auto off the last user row is the true end of the queue.

const SONGS = ['song1', 'song2', 'song3', 'song4'].map((id, i) => ({
  id,
  title: `Song ${i + 1}`,
  artist: `Artist ${i + 1}`,
  album: `Album ${i + 1}`,
  duration: 180,
  track: i + 1,
  year: 2023,
  genre: 'Test',
  suffix: 'mp3',
  bitRate: 320,
  size: 8000000,
  starred: 'false',
  created: `2023-0${i + 1}-01T00:00:00Z`,
  albumId: `al-${i + 1}`,
  path: `Music/Auto/${id}.mp3`,
}))

async function openQueue(page: Page): Promise<void> {
  if (!(await page.getByRole('button', { name: 'Close queue' }).isVisible().catch(() => false))) {
    await page.locator('div.ui-island[role="button"]').first().click()
    await page.getByRole('button', { name: 'Open queue' }).click()
  }
  await page.getByRole('button', { name: 'Close queue' }).waitFor({ state: 'visible' })
  await page.waitForTimeout(400)
}

function autoRowCount(page: Page): Promise<number> {
  return page.locator('[aria-label="Auto queue"] .queue-track-item').count()
}

test('auto-off clears the suggestions, says so quietly, and persists across a reload (D9)', async ({ page }) => {
  await bootSongLibrary(page, SONGS)
  await page.locator('[data-track-id]').first().click()
  await page.waitForTimeout(1200)
  await openQueue(page)

  // ON by default: the suggestion section is present and the switch says so.
  await expect(page.getByTestId('toggle-auto-queue')).toHaveText('Turn off')
  expect(await autoRowCount(page)).toBeGreaterThan(0)

  await page.getByTestId('toggle-auto-queue').click()
  await page.waitForTimeout(400)

  // OFF: the section is gone, and the copy is the quiet off-state — never the
  // "nothing left from the filters" warning.
  await expect(page.getByTestId('toggle-auto-queue')).toHaveText('Turn on')
  await expect(page.getByText('Auto queue off')).toBeVisible()
  expect(await autoRowCount(page)).toBe(0)
  await expect(page.getByText('Auto queue is empty', { exact: false })).toHaveCount(0)
  await expect(page.getByText('nothing left to add from the current filters')).toHaveCount(0)

  // Advances do not refill it: the switch is the gate, not a one-time clear.
  await page.locator('button[aria-label="Next track"]:visible').last().click()
  await page.waitForTimeout(1200)
  await openQueue(page)
  expect(await autoRowCount(page)).toBe(0)
  await expect(page.getByTestId('toggle-auto-queue')).toHaveText('Turn on')

  // Persisted: the setting survives a reload (autoQueueEnabled is restored in
  // initStores, not re-derived).
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })
  await page.waitForTimeout(1000)
  await openQueue(page)
  await expect(page.getByTestId('toggle-auto-queue')).toHaveText('Turn on')
  expect(await autoRowCount(page)).toBe(0)

  // Turning it back ON rebuilds immediately from the live rule.
  await page.getByTestId('toggle-auto-queue').click()
  await page.waitForTimeout(500)
  await expect(page.getByTestId('toggle-auto-queue')).toHaveText('Turn off')
  expect(await autoRowCount(page)).toBeGreaterThan(0)
})

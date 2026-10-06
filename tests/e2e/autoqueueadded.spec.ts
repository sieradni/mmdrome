import { test, expect, type Page } from '@playwright/test'
import { bootSongLibrary } from './thumbflowHelpers'

// Drives the auto-queue half of the "Recently added" sort through the REAL
// bundle (the buildOrderRank `added` case and the persisted autoQueueSort
// decode were only unit-pinned before this spec). Fails if `added` is dropped
// from buildOrderRank (the fill would fall back to the library-index tie-break)
// or from decodeAutoQueueSort's validKeys (the reloaded editor loses its
// active key).
//
// The catalog's created dates are deliberately shuffled relative to library
// order so every observed order is distinct: ascending-added, descending-added,
// and the no-sort library order all differ, as does the index-tie-break
// fallback a regression would produce.

const SONGS = [
  { id: 'aq1', created: '2023-03-01T00:00:00Z' },
  { id: 'aq2', created: '2023-01-01T00:00:00Z' },
  { id: 'aq3', created: '2023-06-01T00:00:00Z' },
  { id: 'aq4', created: '2023-02-01T00:00:00Z' },
  { id: 'aq5', created: '2023-05-01T00:00:00Z' },
  { id: 'aq6', created: '2023-04-01T00:00:00Z' },
].map((s, i) => ({
  id: s.id,
  title: `AQ Track ${i + 1}`,
  artist: `AQ Artist ${i + 1}`,
  album: `AQ Album ${i + 1}`,
  duration: 180,
  track: i + 1,
  year: 2023,
  genre: 'Test',
  suffix: 'mp3',
  bitRate: 320,
  size: 8000000,
  starred: 'false',
  created: s.created,
  albumId: `aq-al-${i + 1}`,
  path: `Music/AQ/${s.id}.mp3`,
}))

// aq1 is played first (→ the user queue), so the auto queue holds aq2..aq6.
//
// The fill CONTINUES from the played aq1 in the sort order — it does NOT
// restart at the top of the sorted pool (the 2026-10-06 report). Added DESC is
// aq3,aq5,aq6,aq1,aq4,aq2; with aq1 played and excluded, the fill continues
// aq4,aq2 and wraps the earlier rows to the tail. ASC (aq2,aq4,aq1,aq6,aq5,aq3)
// continues aq6,aq5,aq3 then wraps aq2,aq4. Restarting at the top would
// produce FROM_TOP_DESC/ASC instead — the regression this pins.
const DESC = ['navidrome-aq4', 'navidrome-aq2', 'navidrome-aq3', 'navidrome-aq5', 'navidrome-aq6']
const ASC = ['navidrome-aq6', 'navidrome-aq5', 'navidrome-aq3', 'navidrome-aq2', 'navidrome-aq4']
// What a from-the-top rebuild would produce (the 2026-10-06 regression).
const FROM_TOP_DESC = ['navidrome-aq3', 'navidrome-aq5', 'navidrome-aq6', 'navidrome-aq4', 'navidrome-aq2']
// What the index tie-break would produce if buildOrderRank lost its `added` case.
const TIE_FALLBACK_DESC = ['navidrome-aq6', 'navidrome-aq5', 'navidrome-aq4', 'navidrome-aq3', 'navidrome-aq2']

function autoOrder(page: Page): Promise<(string | null)[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[aria-label="Auto queue"] .queue-track-item')].map((el) =>
      el.getAttribute('data-track-id'),
    ),
  )
}

/** Opens the queue overlay (idle or active island) and then the auto-filter modal. */
async function openAutoFilters(page: Page): Promise<void> {
  if (!(await page.getByRole('button', { name: 'Close queue' }).isVisible().catch(() => false))) {
    await page.locator('div.ui-island[role="button"]').first().click()
    await page.getByRole('button', { name: 'Open queue' }).click()
  }
  await page.getByRole('button', { name: 'Close queue' }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Auto queue filters' }).click()
  await page.getByRole('dialog', { name: 'Auto queue filters' }).waitFor({ state: 'visible' })
}

async function closeAutoFilters(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.getByRole('dialog', { name: 'Auto queue filters' }).waitFor({ state: 'hidden' })
}

function filterDialog(page: Page) {
  return page.getByRole('dialog', { name: 'Auto queue filters' })
}

async function bootLibraryAndPlayFirst(page: Page): Promise<void> {
  await bootSongLibrary(page, SONGS)
  await page.locator('[data-track-id]').first().click()
  await page.waitForTimeout(1000)
}

test('the auto-queue editor offers Added and reorders the fill; flipping reverses it', async ({ page }) => {
  await bootLibraryAndPlayFirst(page)

  await openAutoFilters(page)

  // The key is offered.
  const added = filterDialog(page).getByRole('button', { name: 'Added', exact: true })
  await expect(added).toBeVisible()

  // Selecting it defaults to descending (newest first).
  await added.click()
  await expect(filterDialog(page).getByRole('button', { name: 'Added ↓', exact: true })).toBeVisible()
  await closeAutoFilters(page)

  await expect.poll(() => autoOrder(page)).toEqual(DESC)
  expect(await autoOrder(page)).not.toEqual(TIE_FALLBACK_DESC)
  // Position-aware: the fill continues from the played aq1, never the top.
  expect(await autoOrder(page)).not.toEqual(FROM_TOP_DESC)

  // Re-picking the active key flips the direction → oldest first.
  await openAutoFilters(page)
  await filterDialog(page).getByRole('button', { name: 'Added ↓', exact: true }).click()
  await expect(filterDialog(page).getByRole('button', { name: 'Added ↑', exact: true })).toBeVisible()
  await closeAutoFilters(page)

  await expect.poll(() => autoOrder(page)).toEqual(ASC)
})

test('a persisted autoQueueSort of added survives a reload and stays active', async ({ page }) => {
  await bootLibraryAndPlayFirst(page)

  await openAutoFilters(page)
  await filterDialog(page).getByRole('button', { name: 'Added', exact: true }).click()
  await expect(filterDialog(page).getByRole('button', { name: 'Added ↓', exact: true })).toBeVisible()
  await closeAutoFilters(page)
  await expect.poll(() => autoOrder(page)).toEqual(DESC)

  // Reload: the persisted autoQueueSort row must decode back to `added` — if
  // `added` fell out of validKeys the row is rejected and the editor shows no
  // active key (the failure this assertion exists to catch).
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })
  await page.waitForTimeout(1000)

  await openAutoFilters(page)
  await expect(filterDialog(page).getByRole('button', { name: 'Added ↓', exact: true })).toBeVisible()
  await closeAutoFilters(page)

  // The restored fill still carries the Added ordering.
  await expect.poll(() => autoOrder(page)).toEqual(DESC)
})

import { test, expect, type Page } from '@playwright/test'
import { bootApp } from './boot'
import { installNavidromeMock, seedMockCredentials } from './navidromeMock'

// Pins the "Recently added" sort (2026-10-04): the shared sort key orders the
// Songs list by `Track.createdAt` (the Subsonic `created` field), newest first
// by default, and the picker offers it. The mock catalog's created dates are
// deliberately out of catalog order (mock-2 newest, then mock-1, then mock-3,
// while rows arrive mock-1, mock-2, mock-3), so a passing assertion proves the
// sort actually ran rather than defaulting to library order.

async function songRowIds(page: Page): Promise<(string | null)[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-track-id]')].map((el) => el.getAttribute('data-track-id')),
  )
}

/** Opens the library Sort dialog (its pill reads "Sort" or "Sort: <key> ↑/↓"). */
async function openSortMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Sort/ }).first().click()
}

/** The sort dialog, scoping option buttons away from the "Sort: <key> ↑/↓" pill. */
function sortDialog(page: Page) {
  return page.getByRole('dialog', { name: 'Library sort' })
}

async function bootWithMockLibrary(page: Page): Promise<void> {
  await installNavidromeMock(page)
  await bootApp(page)
  await seedMockCredentials(page)
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })
}

test('the Added sort orders Songs by createdAt, newest first, and flips', async ({ page }) => {
  await bootWithMockLibrary(page)

  // Wait for the catalog to render, then confirm the unsorted library order.
  await expect(page.locator('[data-track-id]').first()).toBeVisible({ timeout: 15_000 })
  expect(await songRowIds(page)).toEqual(['navidrome-mock-1', 'navidrome-mock-2', 'navidrome-mock-3'])

  // Pick "Added": descending (newest first) is the default direction.
  await openSortMenu(page)
  await sortDialog(page).getByRole('button', { name: 'Added', exact: true }).click()
  await expect(sortDialog(page).getByRole('button', { name: 'Added ↓', exact: true })).toBeVisible()
  await sortDialog(page).getByRole('button', { name: 'Close sort' }).click()
  expect(await songRowIds(page)).toEqual(['navidrome-mock-2', 'navidrome-mock-1', 'navidrome-mock-3'])

  // Re-picking the active key flips the arrow → oldest first.
  await openSortMenu(page)
  await sortDialog(page).getByRole('button', { name: 'Added ↓', exact: true }).click()
  await expect(sortDialog(page).getByRole('button', { name: 'Added ↑', exact: true })).toBeVisible()
  await sortDialog(page).getByRole('button', { name: 'Close sort' }).click()
  expect(await songRowIds(page)).toEqual(['navidrome-mock-3', 'navidrome-mock-1', 'navidrome-mock-2'])
})

test('the Added sort orders Albums by their newest track', async ({ page }) => {
  await bootWithMockLibrary(page)

  await page.getByRole('button', { name: 'Albums' }).click()
  await expect(page.locator('[data-album]').first()).toBeVisible({ timeout: 15_000 })
  const albumNames = () =>
    page.evaluate(() => [...document.querySelectorAll('[data-album]')].map((el) => el.getAttribute('data-album')))
  // Untouched order is alphabetical: Daytrips before Nightdrive.
  expect(await albumNames()).toEqual(['Daytrips', 'Nightdrive'])

  // Added (descending) surfaces Nightdrive — its newest track is later.
  await openSortMenu(page)
  await sortDialog(page).getByRole('button', { name: 'Added', exact: true }).click()
  await expect(sortDialog(page).getByRole('button', { name: 'Added ↓', exact: true })).toBeVisible()
  await sortDialog(page).getByRole('button', { name: 'Close sort' }).click()
  expect(await albumNames()).toEqual(['Nightdrive', 'Daytrips'])
})

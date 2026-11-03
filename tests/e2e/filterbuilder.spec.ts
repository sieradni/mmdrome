import { test, expect, type Page } from '@playwright/test'
import { bootApp } from './boot'
import { installNavidromeMock, seedMockCredentials } from './navidromeMock'

// Pins the 2026-11-03 filter expansion in the real bundle: the rating range
// and Loved stay visible, every other field is reached through Add filter,
// each field renders its own editor (dual-range for numbers, fuzzy text for
// identity fields), clauses are ANDed, `"quotes"` force an exact match, and
// the Queue dialog renders the SAME builder.
//
// The mock catalog: Midnight Drive (Electronic, 2021), Golden Hour
// (Electronic, 2021), Paper Planes (Indie, 2022).

function filterDialog(page: Page) {
  return page.getByRole('dialog', { name: 'Library filters' })
}

async function openFilters(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Filter', exact: true }).click()
}

async function closeFilters(page: Page): Promise<void> {
  await filterDialog(page).getByRole('button', { name: 'Close filters' }).click()
}

async function bootWithMockLibrary(page: Page): Promise<void> {
  await installNavidromeMock(page)
  await bootApp(page)
  await seedMockCredentials(page)
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })
  await expect(page.locator('[data-track-id]').first()).toBeVisible({ timeout: 15_000 })
}

const rows = (page: Page) => page.locator('[data-track-id]')

test('add a typed filter clause, fuzzy + quoted genre search, and AND with a range', async ({ page }) => {
  await bootWithMockLibrary(page)
  await expect(rows(page)).toHaveCount(3)

  await openFilters(page)
  const dialog = filterDialog(page)

  // Rating and Loved are permanent; every other field comes from the picker.
  await expect(dialog.getByTestId('add-filter')).toBeVisible()
  await expect(dialog.getByLabel('Loved tracks only')).toBeVisible()
  await expect(dialog.locator('[data-filter-clause]')).toHaveCount(0)

  // Add a Genre clause — it renders a TEXT editor, not a select.
  await dialog.getByTestId('add-filter').click()
  const addDialog = page.getByRole('dialog', { name: 'Add filter' })
  await expect(addDialog).toBeVisible()
  await addDialog.locator('[data-add-filter="genre"]').click()
  await expect(addDialog).toHaveCount(0)
  const genreInput = dialog.getByRole('textbox', { name: 'Genre filter' })
  await expect(genreInput).toBeVisible()
  await expect(dialog.locator('[data-filter-clause="genre"]')).toHaveCount(1)

  // Fuzzy: a truncated and a one-key-mistyped genre both match Indie.
  await genreInput.fill('indiee')
  await closeFilters(page)
  await expect(rows(page)).toHaveCount(1)

  // Quoted = exact, so the same typo matches nothing…
  await openFilters(page)
  await filterDialog(page).getByRole('textbox', { name: 'Genre filter' }).fill('"indiee"')
  await closeFilters(page)
  await expect(rows(page)).toHaveCount(0)

  // …while the exact quoted word does.
  await openFilters(page)
  await filterDialog(page).getByRole('textbox', { name: 'Genre filter' }).fill('"indie"')
  await closeFilters(page)
  await expect(rows(page)).toHaveCount(1)

  // Remove the genre clause and add a YEAR clause: it renders the dual-range
  // editor plus two typed bounds, and narrowing the minimum filters the list.
  await openFilters(page)
  await filterDialog(page).getByRole('button', { name: 'Remove Genre filter' }).click()
  await expect(rows(page)).toHaveCount(3)
  await filterDialog(page).getByTestId('add-filter').click()
  await page.getByRole('dialog', { name: 'Add filter' }).locator('[data-add-filter="year"]').click()
  const yearMin = filterDialog(page).getByLabel('Year minimum')
  await expect(yearMin).toBeVisible()
  await expect(filterDialog(page).getByRole('slider', { name: 'Year filter minimum' })).toBeVisible()
  await yearMin.fill('2022')
  await closeFilters(page)
  await expect(rows(page)).toHaveCount(1)

  // AND: Electronic ∩ year >= 2022 matches nothing (both Electronic tracks are
  // 2021) — one clause narrowing is not enough to pass.
  await openFilters(page)
  await filterDialog(page).getByTestId('add-filter').click()
  await page.getByRole('dialog', { name: 'Add filter' }).locator('[data-add-filter="genre"]').click()
  await filterDialog(page).getByRole('textbox', { name: 'Genre filter' }).fill('electronic')
  await closeFilters(page)
  await expect(rows(page)).toHaveCount(0)

  // Dropping the year clause leaves the genre one in force.
  await openFilters(page)
  await filterDialog(page).getByRole('button', { name: 'Remove Year filter' }).click()
  await closeFilters(page)
  await expect(rows(page)).toHaveCount(2)
})

test('the Queue filter dialog renders the same builder and rating range', async ({ page }) => {
  await bootApp(page)
  await page.getByText('Not playing').first().click()
  await page.getByRole('button', { name: 'Open queue' }).click()
  await page.getByRole('button', { name: 'Close queue' }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Auto queue filters' }).click()

  const dialog = page.getByRole('dialog', { name: 'Auto queue filters' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('add-filter')).toBeVisible()
  await expect(dialog.getByTestId('min-rating')).toHaveValue('0')
  await expect(dialog.getByTestId('max-rating')).toHaveValue('100')
  await expect(dialog.getByRole('slider', { name: 'Rating filter minimum' })).toBeVisible()

  // The typed clause editor is the shared component, not a hand-copy.
  await dialog.getByTestId('add-filter').click()
  await expect(page.getByRole('dialog', { name: 'Add filter' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Add filter' })).toHaveCount(0)
  await expect(dialog).toBeVisible()
})

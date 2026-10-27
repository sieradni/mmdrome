import { test, expect, type Page } from '@playwright/test'
import { bootApp } from './boot'
import { installNavidromeMock, seedMockCredentials } from './navidromeMock'

// Pins saved library views (Phase 3A) in the real bundle: the save flow in the
// Filters dialog, the one-tap chip that applies a stored view, that both the
// preset list AND the applied filter survive a reload (Dexie + localStorage),
// and that removing a view hides the strip. The mock catalog is unrated, so a
// 60 minimum rating empties the Songs list — the chip's restore is observable
// rather than merely reflected in the pill label.

function filterDialog(page: Page) {
  return page.getByRole('dialog', { name: 'Library filters' })
}

async function openFilters(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Filter', exact: true }).click()
}

async function bootWithMockLibrary(page: Page): Promise<void> {
  await installNavidromeMock(page)
  await bootApp(page)
  await seedMockCredentials(page)
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })
}

test('a saved view chips in one tap and survives a reload (3A)', async ({ page }) => {
  await bootWithMockLibrary(page)
  await expect(page.locator('[data-track-id]').first()).toBeVisible({ timeout: 15_000 })
  const rowCount = () => page.locator('[data-track-id]').count()
  expect(await rowCount()).toBe(3)

  // Save the untouched view under a name.
  await openFilters(page)
  await filterDialog(page).getByLabel('Saved view name').fill('Late night')
  await filterDialog(page).getByRole('button', { name: 'Save', exact: true }).click()
  const chip = page.locator('[data-preset-id]')
  await expect(chip).toHaveCount(1)
  await expect(chip).toHaveText('Late night')
  await expect(chip).toHaveAttribute('aria-pressed', 'true')
  await filterDialog(page).getByRole('button', { name: 'Close filters' }).click()

  // A live edit diverges from the saved view: nothing in the mock is rated, so
  // a 60 floor empties the list and the chip drops its active mark.
  await openFilters(page)
  await filterDialog(page).locator('input[type="number"]').first().fill('60')
  await filterDialog(page).getByRole('button', { name: 'Close filters' }).click()
  await expect(page.locator('[data-track-id]')).toHaveCount(0)
  await expect(chip).toHaveAttribute('aria-pressed', 'false')

  // Both the preset row (Dexie) and the applied filter (localStorage) reload.
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })
  await expect(chip).toHaveCount(1)
  await expect(page.locator('[data-track-id]')).toHaveCount(0)

  // One tap on the chip restores the saved view.
  await chip.click()
  await expect(page.locator('[data-track-id]')).toHaveCount(3)
  await expect(chip).toHaveAttribute('aria-pressed', 'true')

  // Removing the view drops the chip and the whole strip.
  await openFilters(page)
  await filterDialog(page).getByRole('button', { name: 'Remove saved view Late night' }).click()
  await filterDialog(page).getByRole('button', { name: 'Close filters' }).click()
  await expect(page.locator('[data-preset-id]')).toHaveCount(0)
})

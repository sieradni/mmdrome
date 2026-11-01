import { test, expect, type Page } from '@playwright/test'
import { bootApp } from './boot'
import { installNavidromeMock, seedMockCredentials } from './navidromeMock'

// Pins secondary RANDOM (2026-11-01b): Random is a legal SECONDARY tier, where it
// means "shuffle the songs the primary level ties on". A random PRIMARY is the
// whole order, so it still stands alone and the secondary row disappears — the
// rule the editor must show, not just the one `sortCore` enforces.

async function bootWithMockLibrary(page: Page): Promise<void> {
  await installNavidromeMock(page)
  await bootApp(page)
  await seedMockCredentials(page)
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })
  await expect(page.locator('[data-track-id]').first()).toBeVisible({ timeout: 15_000 })
}

function openSortMenu(page: Page) {
  return page.getByRole('button', { name: /^Sort/ }).first().click()
}

const sortDialog = (page: Page) => page.getByRole('dialog', { name: 'Library sort' })

test('Random is offered as a secondary tier, and a random primary still stands alone', async ({ page }) => {
  await bootWithMockLibrary(page)
  await openSortMenu(page)

  // A plain primary opens the secondary row, which offers Random.
  await sortDialog(page).getByRole('button', { name: 'Year', exact: true }).click()
  const secondaryRandom = sortDialog(page).getByRole('button', { name: 'Secondary Random', exact: true })
  await expect(secondaryRandom).toBeVisible()
  await secondaryRandom.click()

  await expect(sortDialog(page).getByTestId('sort-summary')).toHaveText('Year ↑ · Random')
  await expect(sortDialog(page).getByText('Tied songs are shuffled.')).toBeVisible()
  await expect(sortDialog(page).getByTestId('reroll-random')).toBeVisible()
  await expect(sortDialog(page).getByRole('button', { name: 'Secondary Random', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  // Promotion to primary random collapses the stack: no ties are left to break.
  await sortDialog(page).getByRole('button', { name: 'Random', exact: true }).click()
  await expect(sortDialog(page).getByTestId('sort-summary')).toHaveText('Random')
  await expect(sortDialog(page).getByRole('group', { name: 'Secondary sort' })).toHaveCount(0)
})

test('the secondary scramble survives a new primary pick and a relaunch', async ({ page }) => {
  await bootWithMockLibrary(page)
  await openSortMenu(page)

  await sortDialog(page).getByRole('button', { name: 'Year', exact: true }).click()
  await sortDialog(page).getByRole('button', { name: 'Secondary Random', exact: true }).click()

  // Replacing the key ABOVE the scramble keeps the tie-break (the user chose it).
  await sortDialog(page).getByRole('button', { name: 'Rating', exact: true }).click()
  await expect(sortDialog(page).getByTestId('sort-summary')).toHaveText('Rating ↓ · Random')
  await sortDialog(page).getByRole('button', { name: 'Close sort' }).click()

  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-track-id]').first()).toBeVisible({ timeout: 15_000 })
  await openSortMenu(page)
  await expect(sortDialog(page).getByTestId('sort-summary')).toHaveText('Rating ↓ · Random')
})

import { test, expect, type Page } from '@playwright/test'
import { bootApp } from './boot'
import { installNavidromeMock, seedMockCredentials } from './navidromeMock'

// Multi-select in the REAL bundle (2026-11-04). Pins the parts units cannot:
// the modifier path through the actual row templates, the Shift range walking
// the surface's OWN order, the host swapping to the batch menu when the
// targeted row is selected, and the batch verbs reaching the same commands the
// bar renders. The audible-row rule is pinned here too: a batch removal must
// leave the playing row in place rather than silently stop the music.

async function bootWithMockLibrary(page: Page): Promise<void> {
  await installNavidromeMock(page)
  await bootApp(page)
  await seedMockCredentials(page)
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })
  await expect(page.locator('[data-track-id]').first()).toBeVisible({ timeout: 15_000 })
}

/** Library rows only — the queue overlay renders its own [data-track-id] rows. */
const rows = (page: Page) => page.locator('main [data-track-id]')
const menu = (page: Page) => page.getByRole('menu', { name: 'Track actions' })
const batchMenu = (page: Page) => page.getByRole('menu', { name: 'Selection actions' })
const bar = (page: Page) => page.getByTestId('selection-bar')

async function openQueue(page: Page): Promise<void> {
  await page.locator('div.ui-island[role="button"]').first().click()
  await page.getByRole('button', { name: 'Open queue' }).click()
  await page.getByRole('button', { name: 'Close queue' }).waitFor({ state: 'visible' })
}

test('Shift extends a library selection and the batch menu queues the set', async ({ page }) => {
  await bootWithMockLibrary(page)
  await expect(rows(page)).toHaveCount(3)

  // Start a selection from the row menu, then grow it with a Shift press on a
  // LATER row: the range is the visible order between anchor and target.
  await rows(page).first().click({ button: 'right' })
  await menu(page).getByRole('menuitem', { name: 'Select' }).click()
  await expect(bar(page)).toBeVisible()
  await expect(bar(page)).toContainText('1 song')

  await rows(page).nth(2).click({ modifiers: ['Shift'] })
  await expect(bar(page)).toContainText('3 songs')

  // A menu opened ON a selected row is the batch menu, not the single-row one.
  await rows(page).nth(1).click({ button: 'right' })
  await expect(batchMenu(page)).toBeVisible()
  await expect(menu(page)).toHaveCount(0)
  await batchMenu(page).getByRole('menuitem', { name: 'Add to queue' }).click()
  await expect(bar(page)).toHaveCount(0)

  await openQueue(page)
  await expect(page.locator('[aria-label="User queue"] [data-entry-id]')).toHaveCount(3)
})

test('a queue selection removes its rows but never the audible one', async ({ page }) => {
  await bootWithMockLibrary(page)
  const addButtons = page.getByRole('button', { name: 'Add to queue' })
  await addButtons.nth(0).click()
  await addButtons.nth(1).click()
  await addButtons.nth(2).click()

  await openQueue(page)
  const userRows = page.locator('[aria-label="User queue"] [data-entry-id]')
  await expect(userRows).toHaveCount(3)

  // Which row is audible depends on the add/play choreography, so read it from
  // the row's own indicator instead of assuming a position: the rule under
  // test is "the audible row survives", whatever row that is.
  const audible = page.locator('[aria-label="User queue"] .ui-now-playing-row')
  await expect(audible).toHaveCount(1)
  const audibleTitle = ((await audible.locator('p').first().textContent()) ?? '').trim()
  expect(audibleTitle.length).toBeGreaterThan(0)

  // Select the whole section with one anchor + one Shift press on the last row.
  await userRows.first().click({ button: 'right' })
  await menu(page).getByRole('menuitem', { name: 'Select' }).click()
  await expect(bar(page)).toBeVisible()
  await userRows.last().click({ modifiers: ['Shift'] })
  await expect(bar(page)).toContainText(/3 (rows|songs)/)

  await bar(page).getByRole('button', { name: 'Remove selection from the queue' }).click()
  await expect(bar(page)).toHaveCount(0)
  await expect(userRows).toHaveCount(1)
  await expect(userRows.first()).toContainText(audibleTitle)
})

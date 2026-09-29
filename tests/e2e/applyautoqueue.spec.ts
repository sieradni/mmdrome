import { test, expect, type Page } from '@playwright/test'
import { bootApp } from './boot'
import { installNavidromeMock, seedMockCredentials } from './navidromeMock'

// Pins the apply-to-auto-queue affordance (2026-09-29 decoupling): the button
// appears only while the library filter/sort differs from the auto queue's
// own settings, its confirm popup explains and asks, and Apply refills the
// queue; plus the auto-queue sort editor in the queue filter panel — hidden
// while shuffle is on, persisted underneath. The shuffle half runs against
// the Navidrome mock because the toggle needs an ACTIVE track (the same
// constraint as the shuffle round-trip spec).

async function openQueueFilter(page: Page, activeTrack = false): Promise<void> {
  // Idle boot: the empty mini-bar opens Now Playing, whose button opens the
  // queue. With an ACTIVE track the mini-bar itself opens the detail view —
  // same button, different surface (see openDetailFromMiniBar in the
  // persistence spec). Either way the queue button is one click from there.
  if (activeTrack) {
    const bar = page.getByRole('button', { name: /Midnight Drive The Orbitals/ })
    await bar.last().click()
  } else {
    await page.getByText('Not playing').first().click()
  }
  await page.getByRole('button', { name: 'Open queue' }).click()
  await page.getByRole('button', { name: 'Close queue' }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Auto queue filters' }).click()
}

const applyButton = (page: Page) =>
  page.getByRole('button', { name: 'Apply the library filter and sort to the auto queue' })

test('the apply button is hidden while the settings agree and appears on drift', async ({ page }) => {
  await bootApp(page)

  // Defaults agree on both sides → no button.
  await expect(applyButton(page)).toHaveCount(0)

  // Drift the LIBRARY filter → the button appears.
  await page.getByRole('button', { name: 'Filter', exact: true }).click()
  await page.getByLabel('Loved tracks only').check()
  await page.getByRole('button', { name: 'Close filters' }).click()
  await expect(applyButton(page)).toBeVisible()
})

test('confirm popup explains, applies on confirm, and the button then hides', async ({ page }) => {
  await bootApp(page)

  await page.getByRole('button', { name: 'Filter', exact: true }).click()
  await page.getByLabel('Loved tracks only').check()
  await page.getByRole('button', { name: 'Close filters' }).click()

  await applyButton(page).click()
  const dialog = page.getByRole('dialog', { name: 'Apply to auto queue' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Filters')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Apply' })).toBeVisible()

  await dialog.getByRole('button', { name: 'Apply' }).click()
  await expect(dialog).toHaveCount(0)

  // The settings now agree → the button disappears.
  await expect(applyButton(page)).toHaveCount(0)

  // The auto queue's persisted row now carries the applied filter.
  await openQueueFilter(page)
  await expect(page.getByLabel('Loved tracks only')).toBeChecked()
})

test('the auto-queue sort editor follows the shuffle state (editor hidden, setting kept)', async ({ page }) => {
  await installNavidromeMock(page)
  await bootApp(page)
  await seedMockCredentials(page)
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })

  // Activate a track so the queue island (with its shuffle toggle) renders.
  await page.getByText('Midnight Drive').first().click()
  await expect(page.getByText('Midnight Drive')).toHaveCount(2, { timeout: 10_000 })

  // Shuffle OFF: the sort editor is visible; picking Rating arms it (the
  // arrow marks the direction). The picker's accessible name grows the
  // arrow once selected ("Rating ↑"), so the arrow is asserted via the
  // modal body, not the button name.
  await openQueueFilter(page, true)
  const filterDialog = page.getByRole('dialog', { name: 'Auto queue filters' })
  await expect(page.getByText('Sort order')).toBeVisible()
  await page.getByRole('button', { name: 'Rating', exact: true }).click()
  // Rating arms DESCENDING by default (the library sort menu's convention:
  // length/year open ascending, everything else descending) — the picker's
  // accessible name grows the arrow.
  await expect(filterDialog.getByRole('button', { name: 'Rating ↓' })).toBeVisible()
  await page.keyboard.press('Escape')

  // Shuffle ON: the editor hides (shuffle permutes the pool), but the
  // setting was already persisted — the Node persistence suite pins the row.
  await page.getByRole('button', { name: 'Toggle shuffle', exact: true }).click()
  await page.getByRole('button', { name: 'Auto queue filters' }).click()
  await expect(page.getByText('Sort order')).toHaveCount(0)
})

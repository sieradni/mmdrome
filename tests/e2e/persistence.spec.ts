import { test, expect, type Page } from '@playwright/test'
import { bootApp } from './boot'

// Exercises the persisted-store layer (AGENTS.md C6/A10) in the real
// production bundle: the stores persist to IndexedDB on change and restore
// once at boot. The smoke spec only boots the shell — these pin the
// browser-level wiring the Node suites can't see: a value set through the UI
// must take effect immediately, and a non-default value must survive a
// reload. Runs without a Navidrome server (empty library), so it targets
// state that renders regardless of the queue: the QueueView filter panel and
// the now-playing shuffle toggle (the Controls row renders with no track
// loaded — the loop toggle does not, it sits in the currentTrack-only
// Utility Row).

async function openQueueFilter(page: Page): Promise<void> {
  // The mini-player bar (empty-state text is present with no track loaded)
  // opens the now-playing overlay; its header holds the queue button. The
  // queue view's Filter button is scoped to its label group — the base
  // SongsView behind the overlay has a Filter button of its own.
  await page.getByText('Not playing').first().click()
  await page.getByRole('button', { name: 'Open queue' }).click()
  await page.getByLabel('Auto queue boundary').getByRole('button', { name: 'Filter' }).click()
}

test('queue filter rating inputs snap cleared fields to their boundary and persist', async ({ page }) => {
  await bootApp(page)
  await openQueueFilter(page)

  const min = page.getByTestId('min-rating')
  const max = page.getByTestId('max-rating')
  await expect(min).toHaveValue('0')
  await expect(max).toHaveValue('100')

  // A typed non-default value sticks...
  await min.fill('40')
  await expect(min).toHaveValue('40')

  // ...and survives a reload (restored once at boot). The store write is
  // fire-and-forget, so give the IndexedDB transaction a beat to commit
  // before tearing the page down.
  await page.waitForTimeout(250)
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })
  await openQueueFilter(page)
  await expect(page.getByTestId('min-rating')).toHaveValue('40')

  // Clearing snaps to the boundary: max → 100 (the just-fixed defect — a
  // cleared max used to snap to 0, making the filter reject every rated
  // track), min → 0.
  await page.getByTestId('max-rating').fill('80')
  await expect(page.getByTestId('max-rating')).toHaveValue('80')
  await page.getByTestId('max-rating').fill('')
  await expect(page.getByTestId('max-rating')).toHaveValue('100')
  await page.getByTestId('min-rating').fill('')
  await expect(page.getByTestId('min-rating')).toHaveValue('0')
})

test('shuffle mode round-trips through a reload', async ({ page }) => {
  await bootApp(page)

  await page.getByText('Not playing').first().click()
  const shuffle = page.getByRole('button', { name: 'Toggle shuffle' })
  // Default: shuffle off (the `text-muted` state class, distinct from the
  // always-present `hover:text-primary`).
  await expect(shuffle).toHaveClass(/(^|\s)text-muted($|\s)/)

  // One click enables shuffle — the button highlights with `text-primary`.
  await shuffle.click()
  await expect(shuffle).toHaveClass(/(^|\s)text-primary($|\s)/)

  // Persisted: survives a reload (shuffleEnabled is a persisted store).
  await page.waitForTimeout(250)
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })
  await page.getByText('Not playing').first().click()
  await expect(page.getByRole('button', { name: 'Toggle shuffle' })).toHaveClass(
    /(^|\s)text-primary($|\s)/,
  )
})

import { test, expect, type Page } from '@playwright/test'
import { bootApp } from './boot'

// Pins the Loved Tracks control (2026-10-21) in the Scrobbling settings tab:
// the four modes over the two stored signals, the threshold going inert when
// the rating signal is off, the explicit "nothing is loved" copy, and the
// choice surviving a reload (Dexie write → loadSettings restore). The scrobble
// path reading these SAME keys is pinned in Node (scrobbleManagerDestinations)
// and in scrobbleLove.test.ts — this spec owns the part only a browser can show.

const SLIDER = 'Minimum rating to scrobble as loved'

/** Reads the persisted policy rows straight out of Dexie — the same rows
 *  `loadSettings` restores from. Proves the UI wrote what the reload will read
 *  (and waits out the fire-and-forget put, which a reload can otherwise beat). */
function storedPolicy(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(
    () =>
      new Promise<Record<string, unknown>>((resolve) => {
        const req = indexedDB.open('mmdrome')
        req.onsuccess = () => {
          const db = req.result
          const all = db.transaction('userSettings', 'readonly').objectStore('userSettings').getAll()
          all.onsuccess = () => {
            const out: Record<string, unknown> = {}
            for (const row of all.result as { key: string; value: unknown }[]) {
              if (row.key.startsWith('scrobbleLove')) out[row.key] = row.value
            }
            db.close()
            resolve(out)
          }
        }
      }),
  )
}

async function openScrobblingSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  // The open section is session-restored, so a reload can land directly on it.
  const open = page.getByRole('button', { name: 'Open Scrobbling settings' })
  if ((await open.count()) > 0) await open.click()
  await expect(page.getByRole('heading', { name: 'Loved Tracks' })).toBeVisible()
}

test('all four loved modes are selectable and the threshold is inert without the rating signal', async ({ page }) => {
  await bootApp(page)
  await openScrobblingSettings(page)

  const summary = page.getByTestId('love-summary')
  const slider = page.getByRole('slider', { name: SLIDER })
  const loved = page.getByTestId('love-mode-loved')
  const rating = page.getByTestId('love-mode-rating')
  const both = page.getByTestId('love-mode-both')
  const off = page.getByTestId('love-mode-off')

  // Default: the historical ♥-flag-only behavior, threshold present but inert.
  await expect(loved).toHaveAttribute('aria-pressed', 'true')
  await expect(slider).toHaveAttribute('aria-disabled', 'true')
  await expect(summary).toHaveText('Tracks marked ♥ are scrobbled as loved.')

  await rating.click()
  await expect(rating).toHaveAttribute('aria-pressed', 'true')
  await expect(loved).toHaveAttribute('aria-pressed', 'false')
  await expect(slider).toHaveAttribute('aria-disabled', 'false')
  await expect(summary).toHaveText('Tracks rated 80 or higher are scrobbled as loved.')

  await both.click()
  await expect(both).toHaveAttribute('aria-pressed', 'true')
  await expect(rating).toHaveAttribute('aria-pressed', 'false')
  await expect(summary).toHaveText('Tracks marked ♥ or rated 80 or higher are scrobbled as loved.')

  await off.click()
  await expect(off).toHaveAttribute('aria-pressed', 'true')
  await expect(both).toHaveAttribute('aria-pressed', 'false')
  await expect(slider).toHaveAttribute('aria-disabled', 'true')
  await expect(summary).toHaveText('No track is scrobbled as loved — plays still scrobble normally.')
})

test('the chosen mode and threshold survive a reload', async ({ page }) => {
  await bootApp(page)
  await openScrobblingSettings(page)

  await page.getByTestId('love-mode-rating').click()
  const slider = page.getByRole('slider', { name: SLIDER })
  await expect(slider).toHaveAttribute('aria-valuenow', '80')
  // Keyboard steps (the slider is focusable, and a click would JUMP to the
  // pointer position instead of stepping).
  await slider.focus()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('love-summary')).toHaveText('Tracks rated 60 or higher are scrobbled as loved.')
  await expect.poll(async () => (await storedPolicy(page)).scrobbleLoveRatingThreshold).toBe(60)
  expect((await storedPolicy(page)).scrobbleLoveFromRating).toBe(true)
  expect((await storedPolicy(page)).scrobbleLoveFromLoved).toBe(false)

  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })
  await openScrobblingSettings(page)

  await expect(page.getByTestId('love-mode-rating')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('slider', { name: SLIDER })).toHaveAttribute('aria-valuenow', '60')
  await expect(page.getByTestId('love-summary')).toHaveText('Tracks rated 60 or higher are scrobbled as loved.')
})

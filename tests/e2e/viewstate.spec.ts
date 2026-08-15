import { test, expect, type Page } from '@playwright/test'
import { bootApp } from './boot'

// Pins the TODO 4.2 end-to-end contract in the real production bundle: a
// scrolled Settings position survives a reload. SettingsView restores
// sessionStorage synchronously at init and the save `$effect` is gated on a
// `restored` flag so the first save run can never write scrollTop 0 over the
// restored value. Note: on Svelte 5.56.7 the described mount-order race does
// NOT reproduce (probe-verified 2026-08-15 — the restore lands before the
// effect's first read), so this spec pins the CONTRACT, not the gate: it
// fails if the restore breaks or the save path stops persisting, and the
// gate stays as ordering-defense against a Svelte scheduler change.

const VIEWSTATE_KEY = 'mmdrome_viewstate'

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByTestId('settings-scroll')).toBeAttached()
}

test('the Settings scroll position survives a reload (4.2)', async ({ page }) => {
  await bootApp(page)
  await openSettings(page)

  // Scroll the settings container to a deterministic position and fire the
  // scroll event so the onscroll handler (and the save effect) run.
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="settings-scroll"]')
    if (!el) throw new Error('settings scroll container not found')
    el.scrollTop = 400
    el.dispatchEvent(new Event('scroll'))
  })

  // The save is effect-driven — wait until the session store actually holds
  // the scrolled value before tearing the page down.
  await page.waitForFunction((key) => {
    const raw = sessionStorage.getItem(key)
    if (!raw) return false
    try {
      const state = JSON.parse(raw) as { settings?: { scrollTops?: Record<string, number> } }
      return (state.settings?.scrollTops?.sources ?? 0) > 0
    } catch {
      return false
    }
  }, VIEWSTATE_KEY)

  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })
  await openSettings(page)

  // The saved position must come back (with the described bug it would be 0).
  await expect(page.getByTestId('settings-scroll')).toHaveJSProperty('scrollTop', 400)
})

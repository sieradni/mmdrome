import { test, expect, type Page } from '@playwright/test'
import { bootApp } from './boot'
import { installNavidromeMock, seedMockCredentials } from './navidromeMock'

// Exercises the persisted-store layer (AGENTS.md C6/A10) in the real
// production bundle: the stores persist to IndexedDB on change and restore
// once at boot. The smoke spec only boots the shell — these pin the
// browser-level wiring the Node suites can't see: a value set through the UI
// must take effect immediately, and a non-default value must survive a
// reload. The queue filter targets run with no server (empty library), so
// they exercise the IDLE flow: the mini-player tap opens the queue directly
// (the detail overlay is guarded behind an active track). The shuffle spec
// runs against the Navidrome mock, because the shuffle toggle lives in the
// Now Playing detail controls, which need an ACTIVE track.

async function openQueue(page: Page): Promise<void> {
  // The mini-player bar opens the Now Playing detail (its empty state covers
  // the idle case); the queue is reached from there via the queue button.
  // The queue view's Filter button is scoped by its aria-label — the base
  // SongsView has a plain "Filter" button of its own.
  await page.getByText('Not playing').first().click()
  await page.getByRole('button', { name: 'Open queue' }).click()
  await page.getByRole('button', { name: 'Close queue' }).waitFor({ state: 'visible' })
}

async function openQueueFilter(page: Page): Promise<void> {
  await openQueue(page)
  await page.getByRole('button', { name: 'Auto queue filters' }).click()
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

async function openDetailFromMiniBar(page: Page): Promise<void> {
  // The mini bar's role name collides with the Songs-view row (getByRole name
  // matching is substring-based). Count-wait first: 2 matches = row + bar —
  // this is the ONLY deterministic signal the bar has swapped in (a plain
  // waitFor on .last() is vacuous: it resolves to the already-visible row).
  // Then .last() is the bar, and clicking its title area opens the detail
  // overlay (the bar's center is the Play/Pause button — avoid it).
  const nameMatch = page.getByRole('button', { name: 'Midnight Drive The Orbitals' })
  await expect(nameMatch).toHaveCount(2)
  await nameMatch.last().click()
}

test('shuffle mode round-trips through a reload', async ({ page }) => {
  // The shuffle toggle sits in the Now Playing detail controls — reachable
  // only with an ACTIVE track, so this spec runs against the Navidrome mock.
  // First boot creates the Dexie schema; credentials are seeded into it, and
  // the reload re-boots the pipeline against the mock.
  await installNavidromeMock(page)
  await bootApp(page)
  await seedMockCredentials(page)
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })

  // Boot loads the library from the mock. Tap a track row to make it active
  // (the app attempts playback; on failure the track stays active+paused —
  // exactly the state the toggle needs).
  await page.getByText('Midnight Drive').first().click()
  await expect(page.getByText('Midnight Drive')).toHaveCount(2, { timeout: 10_000 })

  // The active mini-player bar opens the detail overlay.
  await openDetailFromMiniBar(page)

  const shuffle = page.getByRole('button', { name: 'Toggle shuffle' })
  // Default: shuffle off (the `text-muted` state class).
  await expect(shuffle).toHaveClass(/(^|\s)text-muted($|\s)/)

  // One click enables shuffle — the button highlights with `text-accent`
  // (the accent-marks-states system: enabled toggles are accent, not white).
  await shuffle.click()
  await expect(shuffle).toHaveClass(/(^|\s)text-accent($|\s)/)

  // Persisted: survives a reload (shuffleEnabled is a persisted store).
  await page.waitForTimeout(250)
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })
  // Boot restores the queue but deliberately does NOT auto-activate a track
  // (no autoplay), so re-activate it before re-opening the detail overlay.
  await page.getByText('Midnight Drive').first().click()
  await openDetailFromMiniBar(page)
  await expect(page.getByRole('button', { name: 'Toggle shuffle' })).toHaveClass(
    /(^|\s)text-accent($|\s)/,
  )
})

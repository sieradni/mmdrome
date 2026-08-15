import { test, expect, type Page } from '@playwright/test'
import { bootApp } from './boot'

// The Phase 3 sync pipeline (connectNavidrome → planNavidromeLoad → library +
// metadata seeding) is wired through Dexie + fetch, which the Node suites can't
// exercise. These specs run the REAL bundle against a route-mocked Subsonic
// server: Playwright fulfills at the network layer, so the cross-origin fake
// host never reaches CORS. A fresh connect seeds the library; a reconnect whose
// scan timestamp still matches serves the persisted cache (marked "(from
// cache)") instead of re-paginating — the browser-level proof that the
// cached-connect branch (which 3.2 gates seeding against) is wired.

const NAV_BASE = 'https://navidrome.test'

const SONGS = [
  { id: 's1', title: 'Song One', artist: 'Artist A', album: 'Album X', duration: 180, starred: true, userRating: 5 },
  { id: 's2', title: 'Song Two', artist: 'Artist B', album: 'Album Y', duration: 240, starred: '2026-01-01T00:00:00Z', userRating: 3 },
]

/** Minimal Subsonic envelope with the requested body fields merged in. */
function subsonic(extra: Record<string, unknown>): Record<string, unknown> {
  return { 'subsonic-response': { status: 'ok', version: '1.16.1', ...extra } }
}

async function openSources(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click()
  // The Sources tab is the default; the Navidrome fields render immediately.
  await expect(page.getByTestId('navidrome-url')).toBeAttached()
}

async function fillCredentials(page: Page): Promise<void> {
  await page.getByTestId('navidrome-url').fill(NAV_BASE)
  await page.getByTestId('navidrome-user').fill('user')
  await page.getByTestId('navidrome-password').fill('pass')
}

/** Mock the Subsonic REST surface; counts search3 (song pagination) calls. */
async function mockOnline(page: Page): Promise<{ search3Calls: () => number }> {
  let search3Calls = 0
  await page.route('**/rest/**', async (route) => {
    const endpoint = new URL(route.request().url()).pathname.split('/').pop()
    let extra: Record<string, unknown> = {}
    if (endpoint === 'ping.view') extra = { serverVersion: '0.50.0' }
    else if (endpoint === 'getScanStatus.view') extra = { scanStatus: { lastScan: '2026-01-01T00:00:00Z' } }
    else if (endpoint === 'search3.view') {
      search3Calls++
      extra = { searchResult3: { song: SONGS } }
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(subsonic(extra)),
    })
  })
  return { search3Calls: () => search3Calls }
}

test('Connect & Load seeds the library from a mocked Subsonic server', async ({ page }) => {
  await bootApp(page)
  await openSources(page)
  await fillCredentials(page)
  await mockOnline(page)

  await page.getByRole('button', { name: 'Connect & Load Songs' }).click()
  await expect(page.getByText('Connected (0.50.0)')).toBeVisible()
  await expect(page.getByText('Loaded 2 song(s), 0 failed')).toBeVisible()
})

test('a scan-timestamp-matching reconnect serves the cache without re-paginating', async ({ page }) => {
  await bootApp(page)
  await openSources(page)
  await fillCredentials(page)
  const mock = await mockOnline(page)

  await page.getByRole('button', { name: 'Connect & Load Songs' }).click()
  await expect(page.getByText('Loaded 2 song(s), 0 failed')).toBeVisible()

  // Reload with the server still reachable and the scan timestamp unchanged:
  // the boot auto-connect (forceRefresh=false) must serve the persisted cache
  // rather than re-paginate search3 — the cached-connect path that 3.2 gates
  // seeding against. The "(from cache)" marker is only rendered on that path.
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })

  await openSources(page)
  await expect(page.getByText('Loaded 2 song(s), 0 failed (from cache)')).toBeVisible()
  expect(mock.search3Calls(), 'the cached reconnect must not re-paginate search3').toBe(1)
})

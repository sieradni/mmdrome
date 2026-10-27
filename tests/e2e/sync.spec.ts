import { test, expect, type Page } from '@playwright/test'
import { bootApp } from './boot'
import { openSettingsSection } from './libraryHarness'

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
  // The landing menu lists the sections; the harness helper tolerates the
  // session-restored tab landing directly INSIDE a section after a reload.
  await openSettingsSection(page, 'sources')
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

test('a rejected credential is reported as a sign-in failure, not as being offline', async ({ page }) => {
  await bootApp(page)
  await openSources(page)
  await fillCredentials(page)
  await mockOnline(page)

  // Seed the library cache with one successful connect: the fallback needs a
  // usable snapshot for this server, which is exactly the situation the report
  // came from (a saved library plus a password that changed).
  await page.getByRole('button', { name: 'Connect & Load Songs' }).click()
  await expect(page.getByText('Loaded 2 song(s), 0 failed')).toBeVisible()

  // The server now answers the ping with the authoritative rejection (Subsonic
  // code 40) while the cached library is still on disk.
  await page.unroute('**/rest/**')
  await page.route('**/rest/**', (route) => {
    const endpoint = new URL(route.request().url()).pathname.split('/').pop()
    const body = endpoint === 'ping.view'
      ? { 'subsonic-response': { status: 'failed', version: '1.16.1', error: { code: 40, message: 'Wrong username or password' } } }
      : subsonic({})
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })

  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })

  // The boot connect fails on credentials and the cached library is served: the
  // Settings surface names the verdict in its existing error line and says the
  // library on screen is the cached one (D-04 auth case), instead of leaving
  // the user to guess at a network problem.
  await openSources(page)
  await expect(page.getByText('Sign-in failed — Wrong username or password', { exact: true })).toBeVisible()
  await expect(
    page.getByText('Showing the cached library — sign-in failed: Wrong username or password', { exact: true }),
  ).toBeVisible()

  // …and the activity strip (the same single slot that used to read
  // "Offline — browsing cached library") carries the truthful label.
  await page.getByRole('button', { name: 'Songs', exact: true }).click()
  await expect(page.getByTestId('app-activity-status')).toContainText('Sign-in failed — browsing cached library')

  // A successful Test Connection is authoritative about the credentials: the
  // stale load-status failure must not keep the strip (and its sign-in verdict)
  // on screen. The library is still the cached one until the next load, but
  // there is no failure left to report.
  await page.unroute('**/rest/**')
  await page.route('**/rest/**', (route) => {
    const endpoint = new URL(route.request().url()).pathname.split('/').pop()
    const extra = endpoint === 'ping.view' ? { serverVersion: '0.50.0' } : {}
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(subsonic(extra)) })
  })
  await openSources(page)
  // Two Test Connection buttons share the Sources tab (Navidrome first, then
  // WebDAV) — this is the Navidrome one.
  await page.getByRole('button', { name: 'Test Connection' }).first().click()
  await expect(page.getByText('Connected (0.50.0)')).toBeVisible()
  await page.getByRole('button', { name: 'Songs', exact: true }).click()
  await expect(page.getByTestId('app-activity-status')).toHaveCount(0)
})

test('a cancelled load lands as honest copy (no resume button) and Connect & Load re-runs it', async ({ page }) => {
  await bootApp(page)
  await openSources(page)
  await fillCredentials(page)

  // Same surface as mockOnline, but search3 answers after a delay so the
  // cancel can land mid-pagination.
  await page.route('**/rest/**', async (route) => {
    const endpoint = new URL(route.request().url()).pathname.split('/').pop()
    let extra: Record<string, unknown> = {}
    if (endpoint === 'ping.view') extra = { serverVersion: '0.50.0' }
    else if (endpoint === 'getScanStatus.view') extra = { scanStatus: { lastScan: '2026-01-01T00:00:00Z' } }
    else if (endpoint === 'search3.view') {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      extra = { searchResult3: { song: SONGS } }
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(subsonic(extra)) })
  })

  await page.getByRole('button', { name: 'Connect & Load Songs' }).click()
  await expect(page.getByText('Stop loading — your current library stays unchanged')).toBeVisible()
  await page.getByRole('button', { name: 'Stop loading — your current library stays unchanged' }).click()

  // The cancelled load's honest landing: the library is untouched (a partial
  // page-set is never applied) and the copy says so — deliberately styled as
  // information, not a red error, and with NO dedicated resume button: the
  // continuation-affordance rule (AGENTS §4.C) — the existing Connect & Load
  // button already calls the same handler, nothing partial survives, and
  // "Resume" would imply progress exists to continue.
  await expect(page.getByText(/Load cancelled — your current library is unchanged/)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('button', { name: 'Resume load' })).toHaveCount(0)

  // Re-run via the ordinary button: for a load, "resume" IS a fresh run.
  await page.getByRole('button', { name: 'Connect & Load Songs' }).click()
  await expect(page.getByText('Loaded 2 song(s), 0 failed')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/Load cancelled/)).toHaveCount(0)
})


import { expect, type Page } from '@playwright/test'
import { buildMp3Fixture, fixtureFilePath } from './fixture'
import type { MockedFile } from './webdavMock'

// Shared harness for the specs that drive the real production bundle through
// the Navidrome-load → WebDAV-scan journey (File Matching, Push, Reset).
// Extracted from the per-spec copies that used to each carry their own —
// identical-looking helpers that had already started to diverge in small ways.

export const NAV_BASE = 'https://navidrome.test'
export const DAV_BASE = 'https://dav.test/files/user/'

export const SONGS = [
  { id: 's1', title: 'Song One', artist: 'Artist A', album: 'Album X', duration: 180, suffix: 'mp3', starred: false, userRating: 0 },
  { id: 's2', title: 'Song Two', artist: 'Artist B', album: 'Album Y', duration: 240, suffix: 'mp3', starred: false, userRating: 0 },
]

/** Per-song fixture bytes: distinct frame counts so the files never size-tie. */
export function fixtureFiles(): MockedFile[] {
  return [
    { path: fixtureFilePath('Song One'), bytes: buildMp3Fixture({ title: 'Song One', artist: 'Artist A', album: 'Album X', track: 1, frames: 8 }) },
    { path: fixtureFilePath('Song Two'), bytes: buildMp3Fixture({ title: 'Song Two', artist: 'Artist B', album: 'Album Y', track: 2, frames: 10 }) },
  ]
}

export function subsonic(extra: Record<string, unknown>): Record<string, unknown> {
  return { 'subsonic-response': { status: 'ok', version: '1.16.1', ...extra } }
}

export async function mockSubsonic(page: Page): Promise<void> {
  await page.route('**/rest/**', async (route) => {
    const endpoint = new URL(route.request().url()).pathname.split('/').pop()
    let extra: Record<string, unknown> = {}
    if (endpoint === 'ping.view') extra = { serverVersion: '0.50.0' }
    else if (endpoint === 'getScanStatus.view') extra = { scanStatus: { lastScan: '2026-01-01T00:00:00Z' } }
    else if (endpoint === 'search3.view') extra = { searchResult3: { song: SONGS } }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(subsonic(extra)) })
  })
}

export type SettingsSection = 'sources' | 'scrobbling' | 'playback' | 'library' | 'appearance' | 'about'

/** Navigate to a Settings section from anywhere. Tolerant of the two states
 *  the landing-page redesign introduced: the session-restored tab can land
 *  the app straight INSIDE a section after a reload (no menu showing), and
 *  the app can be inside a DIFFERENT section (needs back-to-menu first).
 *  The bottom-nav 'Settings' click uses exact matching — every menu row's
 *  label contains the word 'settings' too. */
export async function openSettingsSection(page: Page, section: SettingsSection): Promise<void> {
  const label = section === 'scrobbling' ? 'Scrobbling' : section[0].toUpperCase() + section.slice(1)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const open = page.getByRole('button', { name: `Open ${label} settings` })
  // The session-restored tab can land the app directly INSIDE a section after
  // a reload (no menu showing). The back button is the only reliable signal —
  // it renders exactly when a section is open — and a double click is a no-op
  // (clicking it on the menu does nothing, there is no such button).
  const back = page.getByRole('button', { name: 'Back to settings menu' })
  if (await back.isVisible().catch(() => false)) await back.click()
  await open.click()
  // Per-section sentinel: content renders only when the section is open.
  const sentinel = {
    sources: page.getByTestId('navidrome-url'),
    scrobbling: page.getByRole('heading', { name: 'Direct Services' }),
    playback: page.getByRole('heading', { name: 'Data & Network' }),
    library: page.getByRole('heading', { name: 'Metadata Scan' }),
    appearance: page.getByRole('heading', { name: 'Appearance' }),
    about: page.getByRole('heading', { name: 'mmdrome' }),
  }[section]
  await expect(sentinel).toBeAttached()
}

export async function openSources(page: Page): Promise<void> {
  await openSettingsSection(page, 'sources')
}

export async function fillNavidrome(page: Page): Promise<void> {
  await page.getByTestId('navidrome-url').fill(NAV_BASE)
  await page.getByTestId('navidrome-user').fill('user')
  await page.getByTestId('navidrome-password').fill('pass')
}

export async function fillWebdav(page: Page): Promise<void> {
  // WebDAV fields share a "Username" placeholder with the Navidrome fields
  // above them on the Sources tab, so the WebDAV user input is the second one.
  await page.getByPlaceholder('https://example.com/remote.php/dav/files/user/').fill(DAV_BASE)
  await page.getByPlaceholder('Username').nth(1).fill('user')
  await page.getByPlaceholder('Password / Token').fill('token')
}

export async function openLibrary(page: Page): Promise<void> {
  await openSettingsSection(page, 'library')
}

export async function rescanAll(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Rescan All Metadata \(re-reads all tags\)/ }).click()
  await expect(page.getByText(/Scan complete/)).toBeVisible({ timeout: 30_000 })
}

// File Matching auditor summary locator.
export function auditSummary(page: Page) {
  return page.getByTestId('fm-audit-summary')
}

// Navidrome song ids are namespaced into track ids as `navidrome-<id>`, which
// is what File Matching rows key on (their testids are fm-row-<trackId>).
export const S1 = 'navidrome-s1'
export const S2 = 'navidrome-s2'

export function row(page: Page, trackId: string) {
  return page.getByTestId(`fm-row-${trackId}`)
}

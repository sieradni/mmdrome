import { test, expect, type Page } from '@playwright/test'
import { bootApp } from './boot'
import { installWebdavMock, type WebdavMockStats } from './webdavMock'
import {
  DAV_BASE,
  SONGS_MIGRATED,
  fixtureFiles,
  openSources,
  fillNavidrome,
  fillWebdav,
  openLibrary,
  rescanAll,
  mockSubsonic,
  subsonic,
  openSettingsSection,
} from './libraryHarness'

// The Navidrome 0.64 id-migration journey, end to end in the real bundle:
//
//   1. Two songs load and a rescan auto-binds their files (the normal
//      pre-migration state — Song Two carries a real pending rating).
//   2. The server "migrates": the SAME songs come back with re-encoded ids
//      (s1 → s1n, s2 → s2n). Connect & Load Songs (a force refresh) applies
//      the new library; the pending edit is orphaned on the dead id.
//   3. The post-migration rescan AUTO-binds the re-encoded songs to their
//      files (the zombie-claim exemption lets the scan past the dead-id
//      rows' claims) and the migrated Song One verifies; Song Two's file is
//      NOT auto-bound (its owner row must stay clean for the orphan's
//      pending edit to move onto it — the pending-sync rule).
//   4. The user pushes. pushChanges re-runs the stale-id relink; the orphan's
//      edit lands on the re-encoded id WITH its file binding (path evidence),
//      the dialog names the row "Song Two — Artist B" — never a raw id — and
//      the atomic write lands on the SAME file: exactly one MOVE, no temp
//      orphan, POPM present. The migrated Song One (untouched) stays clean.
//
// A legacy double-bind (the re-encoded song's row carries a NEWER pending
// edit before the orphan can relink) is pinned separately: the newer edit
// wins, the orphan stays residue in the dialog and is discarded with the ×
// without touching either file beyond the survivor's push.

async function prepareMigratedLibrary(page: Page, _dav: WebdavMockStats): Promise<void> {
  await openSources(page)
  await fillNavidrome(page)
  await page.getByRole('button', { name: 'Connect & Load Songs' }).click()
  await expect(page.getByText('Connected (0.50.0)')).toBeVisible()
  await expect(page.getByText('Loaded 2 song(s), 0 failed')).toBeVisible()
  await fillWebdav(page)
  await openLibrary(page)
  await rescanAll(page)
  await expect(page.getByTestId('fm-audit-summary')).toContainText('2 verified')
  // Pre-migration pending edit on Song Two through the real UI.
  await page.getByRole('button', { name: 'Songs', exact: true }).click()
  const row2 = page.locator('[data-track-id="navidrome-s2"]')
  await row2.getByRole('button', { name: 'More options' }).click()
  await row2.getByRole('button', { name: 'Details' }).click()
  await expect(page.getByRole('button', { name: 'Set rating to 60' })).toBeVisible()
  await page.getByRole('button', { name: 'Set rating to 60' }).click()
  await page.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: 'Settings' }).click()
  await openSettingsSection(page, 'library')
}

async function migrateServer(page: Page): Promise<void> {
  // Flip the Subsonic catalog to the re-encoded ids, then force a reload —
  // Connect & Load is a force refresh (bypasses the library cache), so the
  // new ids actually reach the app. The migration does NOT touch the WebDAV
  // files: same bytes, same etags, same paths — only ids change.
  const songs = SONGS_MIGRATED
  await page.route('**/rest/**', async (route): Promise<void> => {
    const endpoint = new URL(route.request().url()).pathname.split('/').pop()
    let extra: Record<string, unknown> = {}
    if (endpoint === 'ping.view') extra = { serverVersion: '0.64.0' }
    else if (endpoint === 'getScanStatus.view') extra = { scanStatus: { lastScan: '2026-01-01T00:00:00Z' } }
    else if (endpoint === 'search3.view') extra = { searchResult3: { song: songs } }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(subsonic(extra)) })
  })
  await openSources(page)
  await page.getByRole('button', { name: 'Connect & Load Songs' }).click()
  await expect(page.getByText('Connected (0.64.0)')).toBeVisible()
  await expect(page.getByText('Loaded 2 song(s), 0 failed')).toBeVisible()
  await openLibrary(page)
}

test('an id migration relinks the orphaned rating onto the re-encoded id and pushes to the same file', async ({ page }) => {
  await bootApp(page)
  await mockSubsonic(page)
  const dav = await installWebdavMock(page, { baseUrl: DAV_BASE, files: fixtureFiles() })
  await prepareMigratedLibrary(page, dav)

  await migrateServer(page)

  // The post-migration rescan proves the zombie-claim exemption: the dead-id
  // rows no longer block their files, so the scan AUTO-re-binds BOTH
  // re-encoded songs and the auditor verifies both. The orphaned rating is
  // still parked on the dead row (kept — never destroyed); the pushChanges
  // relink below moves it onto the re-encoded id with its file binding.
  await rescanAll(page)
  await expect(page.getByTestId('fm-audit-summary')).toContainText('2 verified')

  // Push: pushChanges re-runs the stale-id relink (awaited) BEFORE the dialog
  // is built, so the orphaned edit is already on its re-encoded id.
  await page.getByRole('button', { name: 'Push Changes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Write ratings to WebDAV files?' })).toBeVisible()

  // The dialog names the MIGRATED row — no raw navidrome- id anywhere.
  await expect(page.getByText('1 file will be updated:')).toBeVisible()
  const dialogRow = page.locator('[data-testid="push-discard-navidrome-s2n"]').locator('xpath=ancestor::li')
  await expect(dialogRow).toContainText('Song Two — Artist B')
  await expect(dialogRow).not.toContainText('navidrome-')
  await expect(dialogRow).toContainText('→ Song Two.mp3')
  await page.getByRole('button', { name: 'Write to files' }).click()
  await expect(page.getByText(/Pushed 1 track/)).toBeVisible({ timeout: 30_000 })

  // The SAME FILE got the tags: exactly one atomic write (GET+PUT+MOVE on
  // Song Two.mp3), no temp orphan, POPM present. The untouched migrated
  // Song One file must be byte-identical to its fixture (no rating frame).
  expect(dav.getMoveCount(), 'exactly one atomic write after the migration').toBe(1)
  expect(dav.storedPaths(), 'no .mmdrome-tmp orphan').not.toContain('Song Two.mp3.mmdrome-tmp')
  expect(dav.bytesOf('Song Two.mp3')!.indexOf(Buffer.from('POPM'))).toBeGreaterThan(-1)
  const original = fixtureFiles().find((f) => f.path === 'Song One.mp3')!.bytes
  expect(dav.bytesOf('Song One.mp3')!.equals(original)).toBe(true)
})

test('a legacy double-bind after migration keeps the newer edit; the orphan is discarded without touching files', async ({ page }) => {
  await bootApp(page)
  await mockSubsonic(page)
  const dav = await installWebdavMock(page, { baseUrl: DAV_BASE, files: fixtureFiles() })
  await prepareMigratedLibrary(page, dav)

  await migrateServer(page)

  // Give the re-encoded Song Two its OWN pending edit BEFORE pushing: the
  // live row now carries a newer rating, so the orphan's edit must NOT
  // overwrite it (the live-pending rule wins over the relink).
  await page.getByRole('button', { name: 'Songs', exact: true }).click()

  await page.getByRole('button', { name: 'Songs', exact: true }).click()
  const row2n = page.locator('[data-track-id="navidrome-s2n"]')
  await row2n.getByRole('button', { name: 'More options' }).click()
  await row2n.getByRole('button', { name: 'Details' }).click()
  await expect(page.getByRole('button', { name: 'Set rating to 100' })).toBeVisible()
  await page.getByRole('button', { name: 'Set rating to 100' }).click()
  await page.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: 'Settings' }).click()
  await openSettingsSection(page, 'library')

  await page.getByRole('button', { name: 'Push Changes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Write ratings to WebDAV files?' })).toBeVisible()

  // Both rows are pushable (the orphan could NOT relink: the owner row is
  // itself pending — its edit stays its own). The orphan is named from its
  // COMMIT-TIME identity snapshot (stamped when it was rated), with the
  // muted "no longer in the library" hint; the live row carries the real
  // name from the library.
  await expect(page.getByText('2 files will be updated:')).toBeVisible()
  const orphanRow = page.locator('[data-testid="push-discard-navidrome-s2"]').locator('xpath=ancestor::li')
  await expect(orphanRow).toContainText('Song Two — Artist B')
  await expect(orphanRow).toContainText('no longer in the library')
  const liveRow = page.locator('[data-testid="push-discard-navidrome-s2n"]').locator('xpath=ancestor::li')
  await expect(liveRow).toContainText('Song Two — Artist B')

  // Discard the orphan with the × (inline confirm): nothing is written for
  // it, and the newer edit survives for the push.
  await page.getByTestId('push-discard-navidrome-s2').click()
  const confirmStrip = page.getByTestId('push-discard-confirm-navidrome-s2')
  await expect(confirmStrip).toContainText('Discard this edit?')
  await confirmStrip.getByRole('button', { name: 'Discard' }).click()
  await expect(page.getByText('1 file will be updated:')).toBeVisible()

  await page.getByRole('button', { name: 'Write to files' }).click()
  await expect(page.getByText(/Pushed 1 track/)).toBeVisible({ timeout: 30_000 })

  // The newer edit (rating 100) won; the discarded orphan wrote nothing.
  // Both files end in a known state: Song Two carries a POPM (from the
  // newer push), Song One untouched.
  expect(dav.getMoveCount()).toBe(1)
  expect(dav.bytesOf('Song Two.mp3')!.indexOf(Buffer.from('POPM'))).toBeGreaterThan(-1)
  const original = fixtureFiles().find((f) => f.path === 'Song One.mp3')!.bytes
  expect(dav.bytesOf('Song One.mp3')!.equals(original)).toBe(true)
})

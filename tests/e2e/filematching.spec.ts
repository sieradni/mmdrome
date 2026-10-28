import { test, expect } from '@playwright/test'
import { bootApp } from './boot'
import { installWebdavMock } from './webdavMock'
import {
  DAV_BASE,
  fixtureFiles,
  openSources,
  fillNavidrome,
  fillWebdav,
  openLibrary,
  rescanAll,
  mockSubsonic,
  auditSummary,
  row,
  S1,
  S2,
} from './libraryHarness'

// The File Matching auditor + rescan recovery run against REAL browser
// taglib-wasm, so the mocked WebDAV server has to serve actual parseable audio
// bytes (tests/e2e/fixture.ts). This spec boots the production bundle, loads a
// mocked Navidrome library of two songs, then drives the whole journey:
//
//   1. a force rescan probes both fixture files through the browser taglib and
//      AUTO-binds each song to its own file → the Verified filter shows two
//      "Verified" rows (a genuine browser-level proof of the match pipeline);
//   2. the user clears Song One's auto link (it drops into Needs action),
//      then steals Song Two's file via the search picker ("Bind anyway" in
//      the file-already-bound dialog) → the row resolves into Confirmed by
//      you with honest MANUAL copy (no auto-fix button, rescan never touches
//      manual picks — D8/D17);
//   3. the user clears the wrong manual pick and rescans → both songs
//      auto-relink to the right files and the auditor is back to "2 verified".
//
// The mock also counts file GETs: after the first scan exactly two reads have
// happened, and the recovery rescan adds ZERO (the probe cache is size+mtime
// fresh, D10 single read/cache boundary) — asserted at the browser level.

test('File Matching audits real auto-binds; a manual wrong link is protected, then rescan recovery re-links', async ({ page }) => {
  await bootApp(page)
  await mockSubsonic(page)
  await openSources(page)
  await fillNavidrome(page)

  // Connect & load the (mocked) Navidrome library. WebDAV creds are NOT set
  // yet, so the connect pipeline cannot fire an auto-scan behind our back.
  await page.getByRole('button', { name: 'Connect & Load Songs' }).click()
  await expect(page.getByText('Connected (0.50.0)')).toBeVisible()
  await expect(page.getByText('Loaded 2 song(s), 0 failed')).toBeVisible()

  // Mock the WebDAV server + set creds, then take control of scanning.
  const dav = await installWebdavMock(page, { baseUrl: DAV_BASE, files: fixtureFiles() })
  await fillWebdav(page)

  await openLibrary(page)

  // ── 1. First rescan: real taglib probe → both songs auto-bind & verify ──
  await rescanAll(page)
  const s1 = row(page, S1)
  const s2 = row(page, S2)
  await expect(auditSummary(page)).toContainText('2 verified')
  // Verified links are the resolved bulk — opt into the filter to see them.
  await page.getByTestId('fm-filter-verified').click()
  await expect(s1).toContainText('Verified')
  await expect(s2).toContainText('Verified')
  expect(dav.getReadCount(), 'one Range GET per fixture file on the first scan').toBe(2)

  // ── 2. Deliberate wrong link through the picker → confirmed conflict ───
  // Clear Song One's correct auto link (it drops into Needs action), then
  // steal Song Two's file via the search picker ("Bind anyway" in the
  // file-already-bound dialog).
  await s1.getByRole('button', { name: 'Clear match' }).click()
  await expect(auditSummary(page)).toContainText('1 verified')
  await s1.getByRole('button', { name: 'Select correct file…' }).click()
  const picker = s1.getByPlaceholder('Search all files…')
  // Search-as-you-type: results appear after the 120 ms debounce — no
  // Search button anymore.
  await picker.fill('Two')
  // The search browser surfaces EXISTING bindings (suggestions exclude bound
  // paths, search results must not hide them): Song Two's file is claimed by
  // the Song Two row, and the line names it before the steal even starts.
  await expect(s1.getByTestId('picker-bound')).toContainText('Already bound to: Song Two — Artist B')
  await s1.getByRole('button', { name: /Song Two\.mp3/ }).click()
  await expect(page.getByText('File already bound')).toBeVisible()
  await page.getByRole('button', { name: 'Bind anyway' }).click()

  // The pick is the user's verdict, so the row resolves into Confirmed by
  // you — with MANUAL copy (rescan never touches it, D8) and no auto-fix
  // button (D17: the promise is only for provably-wrong AUTO links).
  await expect(auditSummary(page)).toContainText('1 tag conflict')
  await page.getByTestId('fm-filter-confirmed').click()
  await expect(s1).toContainText('Confirmed by you')
  await expect(s1.getByText(/Rescan never changes manual picks/)).toBeVisible()
  await expect(page.getByTestId('fm-fix')).toHaveCount(0)

  // ── 3. Recovery: clear the manual pick, rescan → auto re-link ───────────
  await s1.getByRole('button', { name: 'Clear match' }).click()
  await rescanAll(page)
  await expect(auditSummary(page)).toContainText('2 verified')
  await expect(s1).toContainText('Verified')
  await expect(s2).toContainText('Verified')
  expect(dav.getReadCount(), 'recovery rescan must reuse the fresh probe cache (D10)').toBe(2)
})

// 2026-10-27 field report: a song whose edit had no file could not be linked by
// a scan at all — the D4 skip ("scans must skip pending_sync rows") covered
// every pending row, including the ones that OWN NOTHING to protect, so the
// only recovery was a manual pick and every Push run reported those rows as
// skipped-no-path. This spec drives the whole journey through the real UI:
// rate a song BEFORE anything is bound (pending, no path) → Scan links it the
// way it links a clean song → rescanning is inert → a manual pick on the still-
// pending row survives another rescan → Push can finally deliver the edit.
test('a scan links a pending song that has no file, and re-scans keep the edit and a manual pick', async ({ page }) => {
  await bootApp(page)
  await mockSubsonic(page)
  await openSources(page)
  await fillNavidrome(page)
  await page.getByRole('button', { name: 'Connect & Load Songs' }).click()
  await expect(page.getByText('Connected (0.50.0)')).toBeVisible()
  await expect(page.getByText('Loaded 2 song(s), 0 failed')).toBeVisible()

  const dav = await installWebdavMock(page, { baseUrl: DAV_BASE, files: fixtureFiles() })
  await fillWebdav(page)

  // ── Rate Song One before ANY scan: no file is bound yet, so the edit lands
  // as a pending row with no path (exactly the rows Push reports as
  // skipped-no-path). Webdav is the rating source, so the edit is local.
  await page.getByRole('button', { name: 'Songs', exact: true }).click()
  const songRow = page.locator('[data-track-id="navidrome-s1"]')
  await expect(songRow).toBeVisible()
  await songRow.getByRole('button', { name: 'More options' }).click()
  await songRow.getByRole('button', { name: 'Details' }).click()
  await expect(page.getByRole('button', { name: 'Set rating to 100' })).toBeVisible()
  await page.getByRole('button', { name: 'Set rating to 100' }).click()
  await page.getByRole('button', { name: 'Close' }).click()

  // ── 1. The scan links it, exactly like a clean song: both files bound and
  // read ONCE (the pending row's own file included).
  await openLibrary(page)
  await rescanAll(page)
  await expect(auditSummary(page)).toContainText('2 verified')
  const s1 = row(page, S1)
  const s2 = row(page, S2)
  await page.getByTestId('fm-filter-verified').click()
  await expect(s1).toContainText('Verified')
  await expect(s2).toContainText('Verified')
  expect(dav.getReadCount(), 'one probe GET per fixture file, pending row included').toBe(2)

  // ── 2. Rescanning is inert: the now-linked pending row is skipped, so no
  // file is read again and nothing about the edit moves.
  await rescanAll(page)
  await expect(auditSummary(page)).toContainText('2 verified')
  expect(dav.getReadCount(), 'a linked pending row is never re-read (D4)').toBe(2)

  // ── 3. The user's OWN pick on that pending row survives a rescan: clear the
  // auto link and bind the file by hand (manual), still un-pushed.
  await s1.getByRole('button', { name: 'Clear match' }).click()
  await s1.getByRole('button', { name: 'Select correct file…' }).click()
  await s1.getByPlaceholder('Search all files…').fill('One')
  await s1.getByRole('button', { name: /Song One\.mp3/ }).click()
  // The pick is the user's verdict: the chip says so, and the evidence line
  // that describes what the file's tags claim is gone with it.
  await page.getByTestId('fm-filter-confirmed').click()
  await expect(s1).toContainText('Confirmed by you')
  await expect(s1).toContainText('Song One.mp3')

  // A rescan must neither re-match it away from the user's pick nor write the
  // file's tags over the pending edit, and it must not read the file again.
  await rescanAll(page)
  await expect(s1).toContainText('Confirmed by you')
  await expect(s1).toContainText('Song One.mp3')
  await expect(auditSummary(page)).toContainText('2 verified')
  expect(dav.getReadCount(), 'the manual pending row is not re-read either').toBe(2)

  // ── 4. The edit was preserved end to end: Push now has a target for it.
  await page.getByRole('button', { name: 'Push Changes', exact: true }).click()
  await expect(page.getByText('1 file will be updated:')).toBeVisible()
  await page.getByRole('button', { name: 'Write to files' }).click()
  await expect(page.getByText(/Pushed 1 track/)).toBeVisible({ timeout: 30_000 })
  const pushed = dav.bytesOf('Song One.mp3')
  expect(pushed, 'the rating edit reached the file').toBeTruthy()
  expect(pushed!.indexOf(Buffer.from('POPM'))).toBeGreaterThan(-1)
  expect(dav.storedPaths()).not.toContain('Song One.mp3.mmdrome-tmp')
})

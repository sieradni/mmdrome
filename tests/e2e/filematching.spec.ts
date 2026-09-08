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
//      AUTO-binds each song to its own file → File Matching shows two
//      "Verified" rows (a genuine browser-level proof of the match pipeline);
//   2. the user force-steals Song Two's file onto Song One (a deliberate wrong
//      link made through the picker) → the auditor surfaces a "Tags conflict"
//      row whose copy is honest: the binding is MANUAL, so no auto-fix button
//      appears and a rescan must never touch it (D8/D17);
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
  await expect(s1).toContainText('Verified')
  await expect(s2).toContainText('Verified')
  expect(dav.getReadCount(), 'one Range GET per fixture file on the first scan').toBe(2)

  // ── 2. Deliberate wrong link through the picker → manual conflict ──────
  // Clear Song One's correct auto link, then steal Song Two's file via the
  // search picker ("Bind anyway" in the file-already-bound dialog).
  await s1.getByRole('button', { name: 'Clear match' }).click()
  await expect(auditSummary(page)).toContainText('1 verified')
  await s1.getByRole('button', { name: 'Select correct file…' }).click()
  const picker = s1.getByPlaceholder('Search all files…')
  // Search-as-you-type: results appear after the 120 ms debounce — no
  // Search button anymore.
  await picker.fill('Two')
  await s1.getByRole('button', { name: /Song Two\.mp3/ }).click()
  await expect(page.getByText('File already bound')).toBeVisible()
  await page.getByRole('button', { name: 'Bind anyway' }).click()

  // The auditor must surface the wrong link as a conflict with MANUAL copy —
  // and no auto-fix button, because rescan never touches manual picks (D8).
  await expect(auditSummary(page)).toContainText('1 tag conflict')
  await expect(s1).toContainText('Tags conflict')
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

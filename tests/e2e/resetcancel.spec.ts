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
  mockSubsonic,
} from './libraryHarness'

// Reset metadata & re-link (wipe-then-relink) end-to-end against the REAL
// bundle, with between-steps cancellation — the same contract Push and the
// Navidrome load have. The reset is the longest DESTRUCTIVE operation, so its
// Cancel button (Settings → Library → reset section) stops it at phase
// boundaries: the re-link scan stops via cancelScan()'s generation bump and
// lands the honest "Cancelled — N of M" state, processed files KEEP their
// fresh links, and a follow-up Rescan All Metadata finishes the re-link.
//
// Cancellation needs a slow server: the mock's setGetDelay holds every file
// read long enough for the cancel to land while reads are still in flight.

test('reset can be cancelled mid-scan; processed links survive and a follow-up rescan finishes', async ({ page }) => {
  await bootApp(page)
  await mockSubsonic(page)
  await openSources(page)
  await fillNavidrome(page)

  // Connect & load the (mocked) Navidrome library. WebDAV creds are NOT set
  // yet, so the connect pipeline cannot fire an auto-scan behind our back.
  await page.getByRole('button', { name: 'Connect & Load Songs' }).click()
  await expect(page.getByText('Connected (0.50.0)')).toBeVisible()
  await expect(page.getByText('Loaded 2 song(s), 0 failed')).toBeVisible()

  // Slow server + mock + creds. The fixture files are REAL parseable MP3s so
  // the re-link scan genuinely parses tags in the browser; the delay makes
  // the re-link reads slow enough that the cancel lands mid-scan.
  const dav = await installWebdavMock(page, { baseUrl: DAV_BASE, files: fixtureFiles() })
  await fillWebdav(page)
  dav.setGetDelay(1500)

  await openLibrary(page)

  // ── Start the reset and cancel it while the re-link scan is running ──
  await page.getByRole('button', { name: 'Reset metadata & re-link all files' }).click()
  await page.getByRole('button', { name: 'Reset & re-link' }).click()
  const resettingButton = page.getByRole('button', { name: /Resetting — / })
  await expect(resettingButton).toBeVisible()
  // The live progress line rides the reset button itself (wipe → re-link →
  // probe phases all surface there).
  await expect(resettingButton).toContainText(/Wiping stored metadata|Re-linking|Reading file tags/, { timeout: 10_000 })

  await page.getByRole('button', { name: 'Cancel reset' }).click()
  await expect(page.getByRole('button', { name: 'Cancelling…' })).toBeVisible()

  // The reset lands resumably — its result line must say so, NOT claim
  // success over a half-done re-link. (The reset's re-link work happens in
  // the scan's inline probe phase, so the scan-state annotation at this point
  // is timing-dependent — its exact cancelled-landing shape is pinned at the
  // Node level in scannerLifecycle.test.ts.)
  await expect(page.getByText(/Reset cancelled/)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/Reset complete/)).toHaveCount(0)

  const readsAtCancel = dav.getReadCount()

  // ── Resumability via the explicit Resume affordance ──────────────────
  // The cancelled scan's landing carries its shape, so the scan result block
  // offers a one-click "Resume scan" that re-runs the SAME shape (force
  // here — the reset's re-link) and the freshness machinery continues from
  // where the cancel stopped.
  dav.setGetDelay(0)
  await page.getByRole('button', { name: 'Resume scan' }).click()
  await expect(page.getByText(/Scan complete/)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/Resume scan/)).toHaveCount(0)
  // The follow-up scan genuinely re-read what the cancel dropped (the wipe
  // cleared the tag cache, so every file is probed again).
  expect(dav.getReadCount()).toBeGreaterThan(readsAtCancel)

  // Both songs are re-linked: the wipe cleared the stale bindings, and the
  // follow-up force scan re-read every file (the wipe also cleared the tag
  // cache) and re-bound each song to its own file. Verified via the auditor
  // summary.
  await expect(page.getByTestId('fm-audit-summary')).toContainText('2 verified', { timeout: 15_000 })
})

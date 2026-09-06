import { test, expect, type Page } from '@playwright/test'
import { bootApp } from './boot'
import { buildMp3Fixture } from './fixture'
import { installWebdavMock, type WebdavMockStats } from './webdavMock'
import {
  DAV_BASE,
  fixtureFiles,
  openSources,
  fillNavidrome,
  fillWebdav,
  mockSubsonic,
} from './libraryHarness'

// Push Changes end-to-end against the REAL bundle: a UI rating edit marks a
// bound row pending_sync (webdav rating source), and Push writes it back
// through the atomic temp-write path — GET (etag) → PUT <file>.mmdrome-tmp →
// MOVE with If-Match. The route-mocked WebDAV server keeps mutable state and
// honors the concurrency headers, so the specs prove the browser actually
// performed the whole write sequence exactly once, left no temp orphan, and
// physically changed the stored file bytes (a POPM frame now present).
//
// The second spec arms the mock's conflict simulation: the first MOVE hits a
// replayed concurrent writer (file mutated + etag advanced BEFORE the
// precondition check → 412) and proves Push's documented single retry in the
// browser — re-GET the fresh etag, re-modify, re-PUT, MOVE succeeds. A client
// that retried with the STALE etag (or gave up) fails these assertions.

/** Boot → load 2 songs → rescan binds both files (2 probe reads) → rate Song
 *  One to 100 through the real UI → back to Settings → Library, ready for
 *  Push. Returns the number of reads the scan consumed. */
async function preparePendingRating(page: Page, dav: WebdavMockStats): Promise<number> {
  await openSources(page)
  await fillNavidrome(page)
  await page.getByRole('button', { name: 'Connect & Load Songs' }).click()
  await expect(page.getByText('Connected (0.50.0)')).toBeVisible()
  await expect(page.getByText('Loaded 2 song(s), 0 failed')).toBeVisible()

  // Bind both songs to their files with a force rescan (2 probe reads). The
  // binding stamps the row's webdav path and current-server base, which Push
  // requires.
  await fillWebdav(page)
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Metadata Scan' })).toBeVisible()
  await page.getByRole('button', { name: /Rescan All Metadata \(re-reads all tags\)/ }).click()
  await expect(page.getByText(/Scan complete/)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('fm-audit-summary')).toContainText('2 verified')
  const readsAfterScan = dav.getReadCount()
  expect(readsAfterScan, 'one probe GET per fixture file').toBe(2)

  // Rate Song One from the Songs list: row ⋮ menu → Details → 5th star (100).
  await page.getByRole('button', { name: 'Songs', exact: true }).click()
  const songRow = page.locator('[data-track-id="navidrome-s1"]')
  await expect(songRow).toBeVisible()
  await songRow.getByRole('button', { name: 'More options' }).click()
  await songRow.getByRole('button', { name: 'Details' }).click()
  // The details modal is the only surface with star buttons; commit on the
  // first click writes rating 100 through the single commit path.
  await expect(page.getByRole('button', { name: 'Set rating to 100' })).toBeVisible()
  await page.getByRole('button', { name: 'Set rating to 100' }).click()
  await expect(page.getByText('100', { exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).click()

  // Push from Settings → Library (the Settings instance keeps its last tab —
  // Library here — so click the tab explicitly rather than expecting Sources).
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  return readsAfterScan
}

test('a rating edit in the UI is pushed to the WebDAV file via PUT-temp + MOVE', async ({ page }) => {
  await bootApp(page)
  await mockSubsonic(page)
  const dav = await installWebdavMock(page, { baseUrl: DAV_BASE, files: fixtureFiles() })
  const readsAfterScan = await preparePendingRating(page, dav)

  await page.getByRole('button', { name: 'Push Changes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Write ratings to WebDAV files?' })).toBeVisible()
  await expect(page.getByText('1 file will be updated:')).toBeVisible()
  await page.getByRole('button', { name: 'Write to files' }).click()
  await expect(page.getByText(/Pushed 1 track/)).toBeVisible({ timeout: 30_000 })

  // The write path, physically: one GET (etag) + one PUT (temp) + one MOVE,
  // no temp orphan, and the stored file now differs and carries a POPM frame.
  expect(dav.getReadCount(), 'push adds exactly one pre-write GET').toBe(readsAfterScan + 1)
  expect(dav.getPutCount(), 'one atomic PUT to the temp path').toBe(1)
  expect(dav.getMoveCount(), 'one atomic MOVE over the target').toBe(1)
  expect(dav.storedPaths(), 'no .mmdrome-tmp orphan after a successful push').not.toContain('Song One.mp3.mmdrome-tmp')
  const original = fixtureFiles().find((f) => f.path === 'Song One.mp3')!.bytes
  const pushed = dav.bytesOf('Song One.mp3')
  expect(pushed, 'the pushed file exists with new bytes').toBeTruthy()
  expect(pushed!.length).not.toBe(original.length)
  expect(pushed!.indexOf(Buffer.from('POPM'))).toBeGreaterThan(-1)
})

test('a 412 on MOVE (concurrent writer) is retried once: re-GET, re-modify, succeed', async ({ page }) => {
  await bootApp(page)
  await mockSubsonic(page)
  const dav = await installWebdavMock(page, { baseUrl: DAV_BASE, files: fixtureFiles() })
  const readsAfterScan = await preparePendingRating(page, dav)

  // Arm the conflict BEFORE opening Push: the first MOVE on Song One replays
  // a concurrent writer — the stored file is replaced with OTHER VALID AUDIO
  // (a realistic writer leaves a playable file) and its etag advances — then
  // answers 412. The returned etag is what the server holds afterwards, so
  // Push can only succeed by re-GETting it (retrying the stale etag would 412
  // forever, and no retry would leave the rating unwritten).
  const concurrentBytes = buildMp3Fixture({ title: 'Song One', artist: 'Artist A', album: 'Album X', track: 1, frames: 12 })
  dav.armConflict('Song One.mp3', 1, concurrentBytes)

  await page.getByRole('button', { name: 'Push Changes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Write ratings to WebDAV files?' })).toBeVisible()
  await expect(page.getByText('1 file will be updated:')).toBeVisible()
  await page.getByRole('button', { name: 'Write to files' }).click()
  await expect(page.getByText(/Pushed 1 track/)).toBeVisible({ timeout: 30_000 })

  // Retry shape, exactly as documented (syncEngine webdavPutAtomic + the
  // ConflictError branch): attempt 1 GET(etag) + PUT + MOVE(412) + temp-DELETE
  // cleanup, then the retry re-GETs, re-modifies, PUTs, and MOVEs with the
  // FRESH etag. One retry, no more — and the mock's conflict arm fired once.
  // (The mock exposes ETag via Access-Control-Expose-Headers; without that
  // the browser hides it and Push silently degrades to a blind overwrite.)
  expect(dav.getConflictCount(), 'the armed 412 was served exactly once').toBe(1)
  expect(dav.getReadCount(), 'initial GET + conflict re-GET only').toBe(readsAfterScan + 2)
  expect(dav.getPutCount(), 'one temp PUT per attempt').toBe(2)
  expect(dav.getMoveCount(), 'one rejected MOVE + one successful retry MOVE').toBe(2)
  // Exactly one DELETE: the temp cleanup lives in webdavPutAtomic
  // (webdavAtomicWrite.ts) as a single idempotent-armed cleanup — the failed
  // attempt deletes its temp once, the catch-all is a no-op afterwards. The
  // old double-DELETE (branch + catch-all both cleaning) was extracted and
  // fixed; tests/webdavAtomicWrite.test.ts pins the exactly-once contract at
  // the Node level.
  expect(dav.getDeleteCount(), 'the failed attempt cleans its temp file exactly once').toBe(1)
  expect(dav.storedPaths(), 'no .mmdrome-tmp orphan after the retry').not.toContain('Song One.mp3.mmdrome-tmp')

  // The stored file: the retry overwrote the concurrent writer's bytes (its
  // distinct audio length is gone) and the app's tags won with a POPM frame
  // present. The retry MOVE only succeeded because it carried the FRESH etag
  // from the re-GET — the mock rejects stale If-Match with 412.
  const finalBytes = dav.bytesOf('Song One.mp3')!
  expect(finalBytes.length, 'concurrent-writer bytes replaced by the push').not.toBe(concurrentBytes.length)
  expect(finalBytes.indexOf(Buffer.from('POPM'))).toBeGreaterThan(-1)
})

test('push shows a bucket breakdown with the track list, and cancelling mid-run keeps pushed rows', async ({ page }) => {
  await bootApp(page)
  await mockSubsonic(page)
  const dav = await installWebdavMock(page, { baseUrl: DAV_BASE, files: fixtureFiles() })
  await preparePendingRating(page, dav)

  // Slow the server so Song One's row is IN FLIGHT while we click Cancel:
  // the cancel must land between rows — Song One finishes (its write is
  // atomic and already committed), Song Two never starts.
  dav.setGetDelay(1500)

  await page.getByRole('button', { name: 'Push Changes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Write ratings to WebDAV files?' })).toBeVisible()

  // The breakdown, derived through the same classifier the run uses: exactly
  // one pushable row (Song One, rated; Song Two untouched) with its title +
  // target path — and no phantom rows in the other buckets.
  await expect(page.getByText('1 file will be updated:')).toBeVisible()
  await expect(page.getByText('Song One').first()).toBeVisible()
  await expect(page.getByText('→ Song One.mp3')).toBeVisible()

  // Start the run; the modal closes and the SECTION shows live progress
  // while the slow GET keeps row 1 in flight.
  await page.getByRole('button', { name: 'Write to files' }).click()
  await expect(page.getByText('Starting…')).toBeVisible()

  // Cancel while row 1 is mid-flight.
  await page.getByRole('button', { name: 'Cancel push' }).click()
  await expect(page.getByText('Cancelling…')).toBeVisible()
  await expect(page.getByText(/Push cancelled/)).toBeVisible({ timeout: 30_000 })

  // Row 1 completed (never half-written); with only one pushable row there
  // is no row 2. The pushed file carries the POPM frame — the write really
  // landed despite the cancel.
  expect(dav.bytesOf('Song One.mp3')!.indexOf(Buffer.from('POPM'))).toBeGreaterThan(-1)
  expect(dav.getMoveCount(), 'row 1 completed atomically before the cancel stopped the loop').toBe(1)

  dav.setGetDelay(0)
})

test('a second pushable row does not start after a mid-run cancel', async ({ page }) => {
  await bootApp(page)
  await mockSubsonic(page)
  const dav = await installWebdavMock(page, { baseUrl: DAV_BASE, files: fixtureFiles() })
  const readsAfterScan = await preparePendingRating(page, dav)

  // Make Song Two pending too: rate it 60 through the UI (row ⋮ → Details).
  await page.getByRole('button', { name: 'Songs', exact: true }).click()
  const row2 = page.locator('[data-track-id="navidrome-s2"]')
  await row2.getByRole('button', { name: 'More options' }).click()
  await row2.getByRole('button', { name: 'Details' }).click()
  await expect(page.getByRole('button', { name: 'Set rating to 60' })).toBeVisible()
  await page.getByRole('button', { name: 'Set rating to 60' }).click()
  await page.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Library', exact: true }).click()

  dav.setGetDelay(1200)
  await page.getByRole('button', { name: 'Push Changes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Write ratings to WebDAV files?' })).toBeVisible()
  await expect(page.getByText('2 files will be updated:')).toBeVisible()
  await page.getByRole('button', { name: 'Write to files' }).click()
  await expect(page.getByText('Starting…')).toBeVisible()

  // Cancel during row 1's slow GET — row 2 must never start.
  await page.getByRole('button', { name: 'Cancel push' }).click()
  await expect(page.getByText('Cancelling…')).toBeVisible()
  await expect(page.getByText(/Push cancelled/)).toBeVisible({ timeout: 30_000 })

  expect(dav.getMoveCount(), 'row 1 completed; row 2 never started').toBe(1)
  expect(dav.getReadCount(), 'row 1 GET only — row 2 never GETs').toBe(readsAfterScan + 1)
  // Song Two stays untouched — still pending for the next Push.
  expect(dav.bytesOf('Song Two.mp3')!.indexOf(Buffer.from('POPM'))).toBe(-1)

  dav.setGetDelay(0)
})

import { test, expect, type Page } from '@playwright/test'
import { bootApp } from './boot'
import { buildMp3Fixture, fixtureFilePath } from './fixture'
import { installWebdavMock, type WebdavMockStats } from './webdavMock'
import {
  DAV_BASE,
  SONGS,
  fixtureFiles,
  openSources,
  fillNavidrome,
  fillWebdav,
  mockSubsonic,
} from './libraryHarness'
import { openSettingsSection } from './libraryHarness'

// Push Changes end-to-end against the REAL bundle: a UI rating edit marks a
// bound row pending_sync (webdav rating source), and Push writes it back
// through GET → PUT temp → fresh PROPFIND re-check → MOVE. Browser writes use
// essential headers only; native conditional-header behavior is unit-pinned.
// Concurrent updates during upload must be re-read and merged before MOVE.

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
  await openSettingsSection(page, 'library')
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
  await openSettingsSection(page, 'library')
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
  const pushDialog = page.getByRole('dialog', { name: 'Write ratings to WebDAV files?' })
  await expect(pushDialog).toBeFocused()
  await expect(pushDialog).toHaveAccessibleDescription(/Updates only rating and loved tags/)
  const discardButton = page.getByTestId('push-discard-navidrome-s1')
  const discardRect = await discardButton.boundingBox()
  expect(discardRect!.width).toBe(32)
  expect(discardRect!.height).toBe(32)
  await page.keyboard.press('Shift+Tab')
  await expect(pushDialog.getByRole('button', { name: 'Write to files', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(pushDialog.getByRole('button', { name: 'Show details for Song One', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(pushDialog.getByRole('button', { name: 'Song One', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(discardButton).toBeFocused()

  // Tapping the row's title or art opens the SAME details view the library
  // rows use — and it must stack ABOVE the confirm pane (native dialog top
  // layer; a z-index overlay would paint behind it and be untappable).
  await page.getByTestId('push-title-button').click()
  const details = page.getByRole('dialog', { name: 'Song One', exact: true })
  await expect(details).toBeVisible()
  await expect(details.getByRole('button', { name: 'Set rating to 100' })).toBeVisible()
  await expect(details.getByText('Album Artist', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(details).toHaveCount(0)
  await expect(pushDialog).toBeVisible()
  await page.getByTestId('push-thumbnail-button').click()
  await expect(page.getByRole('dialog', { name: 'Song One', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Song One', exact: true })).toHaveCount(0)
  await expect(pushDialog).toBeVisible()
  // Real names, not raw navidrome ids (2026-09-26 field report): the dialog
  // resolves titles from the live library via withLibraryTitles.
  const dialogRow = page.locator('[data-testid="push-discard-navidrome-s1"]').locator('xpath=ancestor::li')
  await expect(dialogRow).toContainText('Song One')
  await expect(dialogRow).toContainText('Artist A · Album X')
  await expect(dialogRow).not.toContainText('Song One — Artist A')
  const cover = dialogRow.getByTestId('push-thumbnail').locator('img').last()
  await expect(cover).toBeVisible()
  await expect.poll(() => cover.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await expect(dialogRow).not.toContainText('navidrome-')
  await expect(dialogRow).toContainText('→ Song One.mp3')
  await page.getByRole('button', { name: 'Write to files' }).click()
  await expect(page.getByText(/Pushed 1 track/)).toBeVisible({ timeout: 30_000 })

  // The write path, physically: one GET (etag) + one PUT (temp) + one MOVE,
  // no temp orphan, and the stored file now differs and carries a POPM frame.
  expect(dav.getReadCount(), 'push adds exactly one pre-write GET').toBe(readsAfterScan + 1)
  expect(dav.getPutCount(), 'one atomic PUT to the temp path').toBe(1)
  expect(dav.getMoveCount(), 'one atomic MOVE over the target').toBe(1)
  expect(dav.storedPaths(), 'no .mmdrome-tmp orphan after a successful push').not.toContain('Song One.mp3.mmdrome-tmp')

  // No optional header may silently expand the browser's CORS requirements.
  const moveHeaders = dav.lastMoveHeaders()!
  expect(moveHeaders['if-match']).toBeUndefined()
  expect(moveHeaders['if']).toBeUndefined()
  expect(moveHeaders['if-unmodified-since']).toBeUndefined()
  expect(moveHeaders['overwrite']).toBeUndefined()
  const original = fixtureFiles().find((f) => f.path === 'Song One.mp3')!.bytes
  const pushed = dav.bytesOf('Song One.mp3')
  expect(pushed, 'the pushed file exists with new bytes').toBeTruthy()
  expect(pushed!.length).not.toBe(original.length)
  expect(pushed!.indexOf(Buffer.from('POPM'))).toBeGreaterThan(-1)
})

test('a changed pre-MOVE destination is retried once: re-GET, re-modify, succeed', async ({ page }) => {
  await bootApp(page)
  await mockSubsonic(page)
  const dav = await installWebdavMock(page, { baseUrl: DAV_BASE, files: fixtureFiles() })
  const readsAfterScan = await preparePendingRating(page, dav)

  // A writer changes the destination while the temp uploads. The fresh
  // pre-MOVE check must catch it without any conditional header permission.
  const concurrentBytes = buildMp3Fixture({ title: 'Song One', artist: 'Artist A', album: 'Album X', track: 1, frames: 12 })
  dav.armConflict('Song One.mp3', 1, concurrentBytes, 'put')

  await page.getByRole('button', { name: 'Push Changes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Write ratings to WebDAV files?' })).toBeVisible()
  await expect(page.getByText('1 file will be updated:')).toBeVisible()
  await page.getByRole('button', { name: 'Write to files' }).click()
  await expect(page.getByText(/Pushed 1 track/)).toBeVisible({ timeout: 30_000 })

  // The first attempt cleans its temp without MOVE; the retry merges fresh bytes.
  expect(dav.getConflictCount(), 'the concurrent writer ran once').toBe(1)
  expect(dav.getReadCount(), 'initial GET + conflict re-GET only').toBe(readsAfterScan + 2)
  expect(dav.getPutCount(), 'one temp PUT per attempt').toBe(2)
  expect(dav.getMoveCount(), 'only the retry sends MOVE').toBe(1)
  // Exactly one DELETE: the temp cleanup lives in webdavPutAtomic
  // (webdavAtomicWrite.ts) as ONE `discardTemp()` call on the conflict
  // branch. The old double-DELETE (branch + catch-all both cleaning) was
  // extracted and fixed; tests/webdavAtomicWrite.test.ts pins the exactly-once
  // contract at the Node level.
  expect(dav.getDeleteCount(), 'the failed attempt cleans its temp file exactly once').toBe(1)
  expect(dav.storedPaths(), 'no .mmdrome-tmp orphan after the retry').not.toContain('Song One.mp3.mmdrome-tmp')

  // The rating was written into the refreshed remote file.
  const finalBytes = dav.bytesOf('Song One.mp3')!
  expect(finalBytes.length, 'concurrent-writer bytes replaced by the push').not.toBe(concurrentBytes.length)
  expect(finalBytes.indexOf(Buffer.from('POPM'))).toBeGreaterThan(-1)
})

test('a concurrent write during the upload is merged, not clobbered, on a server that honours no precondition', async ({ page }) => {
  await bootApp(page)
  await mockSubsonic(page)
  const dav = await installWebdavMock(page, { baseUrl: DAV_BASE, files: fixtureFiles() })
  const readsAfterScan = await preparePendingRating(page, dav)

  // No precondition is enforced by this server: the only thing standing between
  // the concurrent writer and a clobber is the client's own re-check, taken as
  // late as possible before the rename.
  dav.setPreconditionDialect('ignored')
  const concurrentBytes = buildMp3Fixture({ title: 'Song One', artist: 'Concurrent Writer', album: 'Album X', track: 1, frames: 14 })
  dav.armConflict('Song One.mp3', 1, concurrentBytes, 'put')

  await page.getByRole('button', { name: 'Push Changes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Write ratings to WebDAV files?' })).toBeVisible()
  await page.getByRole('button', { name: 'Write to files' }).click()
  const result = page.getByText(/Pushed 1 track/)
  await expect(result).toBeVisible({ timeout: 30_000 })
  await expect(result).not.toContainText('failed')

  // The refused attempt is visible as work, not as a clobber: the destination
  // was RE-READ (one extra GET), the merged bytes were re-uploaded (2 PUTs) and
  // the refused temp was cleaned up exactly once.
  expect(dav.getConflictCount(), 'the concurrent write fired once').toBe(1)
  expect(dav.getReadCount(), 'initial GET + the recovery re-read').toBe(readsAfterScan + 2)
  expect(dav.getPutCount(), 'the refused attempt and the merged retry').toBe(2)
  expect(dav.getDeleteCount(), 'the refused attempt cleaned its temp').toBe(1)
  expect(dav.getMoveCount(), 'one MOVE, after the merge').toBe(1)

  // The other writer's bytes are the ones our tags were written INTO: the file
  // is no longer the fixture the push started from, the concurrent writer's own
  // artist frame survives (it is UTF-8 in the fixture, so the text is in
  // there), and our POPM landed on top of it.
  const finalBytes = dav.bytesOf('Song One.mp3')!
  const original = fixtureFiles().find((f) => f.path === 'Song One.mp3')!.bytes
  expect(finalBytes.equals(original), 'the bytes we started from were not what got committed').toBe(false)
  expect(finalBytes.includes(Buffer.from('Concurrent Writer')), 'the other writer\'s bytes survived').toBe(true)
  expect(finalBytes.indexOf(Buffer.from('POPM'))).toBeGreaterThan(-1)
})

test('a refused MOVE surfaces its cause in the result line and leaves no temp behind', async ({ page }) => {
  await bootApp(page)
  await mockSubsonic(page)
  const dav = await installWebdavMock(page, { baseUrl: DAV_BASE, files: fixtureFiles() })
  await preparePendingRating(page, dav)

  // The server accepts the temp PUT and then refuses the rename (403), a
  // realistic shape: quota/permission rules apply to the final path, not the
  // temp. Before this pass the pane said only "Pushed 0 track(s), 1 failed" —
  // the cause was swallowed by the row loop.
  dav.armMoveFailure('Song One.mp3', 403, 1)

  await page.getByRole('button', { name: 'Push Changes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Write ratings to WebDAV files?' })).toBeVisible()
  await page.getByRole('button', { name: 'Write to files' }).click()
  const result = page.getByText(/Pushed 0 track\(s\), 1 failed/)
  await expect(result).toBeVisible({ timeout: 30_000 })
  await expect(result).toContainText('WebDAV MOVE failed (403)')
  await expect(result).toContainText('Song One.mp3')

  // The row stays pending for the next Push, the destination is untouched,
  // and the failed attempt cleaned its temp exactly once.
  expect(dav.getDeleteCount(), 'the failed MOVE cleaned its temp').toBe(1)
  expect(dav.storedPaths(), 'no .mmdrome-tmp orphan after a refused MOVE').not.toContain('Song One.mp3.mmdrome-tmp')
  expect(dav.bytesOf('Song One.mp3'), 'the destination was never replaced').toEqual(fixtureFiles().find((f) => f.path === 'Song One.mp3')!.bytes)
  await expect(page.getByRole('button', { name: 'Push Changes', exact: true })).toBeEnabled()
})

test('a destination deleted between GET and MOVE is a skip, not a failure', async ({ page }) => {
  await bootApp(page)
  await mockSubsonic(page)
  const dav = await installWebdavMock(page, { baseUrl: DAV_BASE, files: fixtureFiles() })
  await preparePendingRating(page, dav)

  // A concurrent deletion during upload is seen by the fresh destination
  // check. Recovery GET reports it gone; no MOVE can resurrect the file.
  dav.armVanish('Song One.mp3', 1)

  await page.getByRole('button', { name: 'Push Changes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Write ratings to WebDAV files?' })).toBeVisible()
  await page.getByRole('button', { name: 'Write to files' }).click()
  const result = page.getByText(/Pushed 0 track\(s\), 1 skipped/)
  await expect(result).toBeVisible({ timeout: 30_000 })
  await expect(result).not.toContainText('failed')

  // One attempt, one temp cleanup, nothing orbiting the collection.
  expect(dav.getMoveCount(), 'the vanished destination is detected before MOVE').toBe(0)
  expect(dav.getDeleteCount(), 'the refused attempt cleaned its temp exactly once').toBe(1)
  expect(dav.storedPaths(), 'no .mmdrome-tmp orphan after deletion').not.toContain('Song One.mp3.mmdrome-tmp')
  expect(dav.bytesOf('Song One.mp3'), 'the vanished destination was not resurrected').toBeUndefined()
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
  await openSettingsSection(page, 'library')

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

// ── The Push REPORT is a user surface, not a debug dump ────────────────────

/** A third song + its file, so a batch can commit, fail and land in the
 *  uncertain bucket in ONE run (the other specs need only two). */
const SONG_THREE = { id: 's3', title: 'Song Three', artist: 'Artist C', album: 'Album Z', duration: 200, suffix: 'mp3', starred: false, userRating: 0 }
const THREE_SONGS = [...SONGS, SONG_THREE]

function threeFiles() {
  return [
    ...fixtureFiles(),
    {
      path: fixtureFilePath('Song Three'),
      bytes: buildMp3Fixture({ title: 'Song Three', artist: 'Artist C', album: 'Album Z', track: 3, frames: 12 }),
    },
  ]
}

/** Rate one library row through the real ⋮ → Details → stars path (the single
 *  commit path that marks a row pending_sync). */
async function rateRow(page: Page, trackId: string, rating: number): Promise<void> {
  const row = page.locator(`[data-track-id="${trackId}"]`)
  await row.getByRole('button', { name: 'More options' }).click()
  await row.getByRole('button', { name: 'Details' }).click()
  await page.getByRole('button', { name: `Set rating to ${rating}` }).click()
  await page.getByRole('button', { name: 'Close' }).click()
}

/** Writes `count` pending edits that have NO WebDAV path straight into the
 *  app's own IndexedDB. They are ordinary orphaned edits (the shape a track
 *  removed from the server leaves behind), so the push run classifies and
 *  reports them as `skipped-no-path` — a real report row with no network I/O.
 *  Seeded AFTER the library load (a stale NON-pending row would be pruned) and
 *  read back by the reload, so the run sees them through `getPendingSyncMetadata`
 *  like any other edit. */
async function seedOrphanedPendingEdits(page: Page, count: number): Promise<void> {
  await page.evaluate(async (n) => {
    const req = indexedDB.open('mmdrome')
    await new Promise<void>((resolve, reject) => {
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
    const db = req.result
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('localMetadata', 'readwrite')
      const store = tx.objectStore('localMetadata')
      for (let i = 0; i < n; i++) {
        store.put({
          trackId: `orphan-${String(i).padStart(3, '0')}`,
          title: `Orphan ${i}`,
          artist: 'Artist Z',
          album: 'Album Z',
          duration: 100,
          fileType: 'mp3',
          rating: 80,
          loved: false,
          syncStatus: 'pending_sync',
        })
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  }, count)
}

// The report keeps its first MAX_RETAINED_REPORT_ROWS rows; the seeded orphans
// are what push a single run past that line, so the notice is real.
const RETAINED_ROWS = 200
const ORPHAN_ROWS = 200
const TRUNCATED = ORPHAN_ROWS + 3 - RETAINED_ROWS

test('a mixed push reports per-row disposition, remote/local state, groups and truncation, and survives in Copy', async ({ page }) => {
  // The HUD is opt-in; set the flag before the first boot so the Copy payload
  // can be read from window.__debugHudText (no clipboard permission needed).
  await page.addInitScript(() => {
    try { localStorage.setItem('mmdrome:debugHud', '1') } catch {}
  })
  // A local-reconcile failure cannot be produced by the mocked SERVER (the
  // write lands, then the app's own Dexie update would have to fail). Inject it
  // at the DB boundary instead: the real engine, the real catch branch, one
  // failed `localMetadata` write, then the hook disarms itself.
  await page.addInitScript(() => {
    const w = window as { __failNextLocalMetadataWrite?: boolean }
    const realPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: unknown[]) {
      if (w.__failNextLocalMetadataWrite && this.name === 'localMetadata') {
        w.__failNextLocalMetadataWrite = false
        throw new DOMException('injected local write failure', 'QuotaExceededError')
      }
      return (realPut as (...a: unknown[]) => IDBRequest).apply(this, args)
    }
  })
  await bootApp(page)
  await mockSubsonic(page, THREE_SONGS)
  const dav = await installWebdavMock(page, { baseUrl: DAV_BASE, files: threeFiles() })

  await openSources(page)
  await fillNavidrome(page)
  await page.getByRole('button', { name: 'Connect & Load Songs' }).click()
  await expect(page.getByText('Connected (0.50.0)')).toBeVisible()
  await expect(page.getByText('Loaded 3 song(s), 0 failed')).toBeVisible()

  await fillWebdav(page)
  await openSettingsSection(page, 'library')
  await page.getByRole('button', { name: /Rescan All Metadata \(re-reads all tags\)/ }).click()
  await expect(page.getByText(/Scan complete/)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('fm-audit-summary')).toContainText('3 verified')

  // Three pending edits, one per outcome bucket.
  await page.getByRole('button', { name: 'Songs', exact: true }).click()
  await rateRow(page, 'navidrome-s1', 100)
  await rateRow(page, 'navidrome-s2', 60)
  await rateRow(page, 'navidrome-s3', 80)

  await seedOrphanedPendingEdits(page, ORPHAN_ROWS)
  // Reload so the seeded rows enter the in-memory metadata cache the push and
  // its breakdown read (and so the report DOWNGRADE path is not in play).
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })
  await openSettingsSection(page, 'library')

  await page.getByRole('button', { name: 'Push Changes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Write ratings to WebDAV files?' })).toBeVisible()
  await expect(page.getByText('3 files will be updated:')).toBeVisible()

  // Row 1 fails remotely (the server refuses the rename), row 2 loses its MOVE
  // response (remote state genuinely unknown), row 3 writes remotely and then
  // its LOCAL reconcile fails (injected above).
  dav.armMoveFailure('Song One.mp3', 403, 1)
  dav.armMoveAbort('Song Two.mp3', 1)
  await page.evaluate(() => { (window as { __failNextLocalMetadataWrite?: boolean }).__failNextLocalMetadataWrite = true })
  await page.getByRole('button', { name: 'Write to files' }).click()

  // One file actually changed remotely: Song Three's (whose local reconcile
  // then failed). "Pushed" counts remote commits, so it stays 1.
  const result = page.getByText(/Pushed 1 track\(s\)/)
  await expect(result).toBeVisible({ timeout: 30_000 })
  await expect(result).toContainText('1 written remotely (local cache update failed)')
  await expect(result).toContainText('2 failed')
  await expect(result).toContainText('1 uncertain')
  await expect(result).toContainText(`${ORPHAN_ROWS} skipped`)

  // The expanded report: groups, then the per-row parentheticals.
  const details = page.getByTestId('push-report-details')
  await details.locator('summary').click()
  await expect(details).toBeVisible()
  const groups = page.getByTestId('push-failure-groups')
  await expect(groups).toContainText('403')
  await expect(groups).toContainText('Song One')
  // The committed-but-locally-failed row is its own group with the reconcile
  // instruction — the one case where re-pushing would be wrong.
  await expect(groups).toContainText('local-reconcile')
  await expect(groups).toContainText('run Scan for changes')

  const rows = page.getByTestId('push-report-rows')
  const rowText = (title: string) => rows.locator('li', { hasText: title }).first().innerText()
  await expect.poll(() => rows.locator('li').count()).toBe(RETAINED_ROWS)
  expect(await rowText('Song One')).toMatch(/failed-move \(move.*remote not-committed, local not-needed/)
  expect(await rowText('Song Two')).toMatch(/unknown-outcome \(move.*remote unknown/)
  expect(await rowText('Song Three')).toMatch(/written-local-failed \(local-reconcile.*remote committed, local failed/)
  await expect(details).toContainText(`${TRUNCATED} more rows not retained.`)

  // W-09: the retained report is durable AND lands in the Copy payload.
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Copy' }).click()
  const dump = await page.evaluate(() => JSON.parse((window as { __debugHudText?: string }).__debugHudText ?? 'null'))
  expect(dump?.lastPushReport?.rows?.length, 'Copy carries the retained rows').toBe(RETAINED_ROWS)
  expect(dump.lastPushReport.rowsTruncated).toBe(TRUNCATED)
  const dispositions = dump.lastPushReport.rows.map((r: { disposition: string }) => r.disposition)
  expect(dispositions).toContain('failed-move')
  expect(dispositions).toContain('unknown-outcome')
  expect(dispositions).toContain('written-local-failed')
  expect(dispositions).toContain('skipped-no-path')
  expect(dump.lastPushReport.rows[0].remoteState).toBeDefined()
  expect(dump.lastPushReport.counts).toMatchObject({
    remoteCommitted: 1,
    writtenLocalFailed: 1,
    unknownOutcomes: 1,
    failed: 2,
    skipped: ORPHAN_ROWS,
  })
})

test('the dialog × discards one pending edit after confirmation; only the survivor is pushed', async ({ page }) => {
  await bootApp(page)
  await mockSubsonic(page)
  const dav = await installWebdavMock(page, { baseUrl: DAV_BASE, files: fixtureFiles() })
  await preparePendingRating(page, dav)

  // Make Song Two pending too.
  await page.getByRole('button', { name: 'Songs', exact: true }).click()
  const row2 = page.locator('[data-track-id="navidrome-s2"]')
  await row2.getByRole('button', { name: 'More options' }).click()
  await row2.getByRole('button', { name: 'Details' }).click()
  await expect(page.getByRole('button', { name: 'Set rating to 60' })).toBeVisible()
  await page.getByRole('button', { name: 'Set rating to 60' }).click()
  await page.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: 'Settings' }).click()
  await openSettingsSection(page, 'library')

  await page.getByRole('button', { name: 'Push Changes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Write ratings to WebDAV files?' })).toBeVisible()
  await expect(page.getByText('2 files will be updated:')).toBeVisible()
  // Both rows carry real names.
  const s1Row = page.locator('[data-testid="push-discard-navidrome-s1"]').locator('xpath=ancestor::li')
  const s2Row = page.locator('[data-testid="push-discard-navidrome-s2"]').locator('xpath=ancestor::li')
  await expect(s1Row).toContainText('Song One')
  await expect(s1Row).toContainText('Artist A · Album X')
  await expect(s2Row).toContainText('Song Two')
  await expect(s2Row).toContainText('Artist B · Album Y')

  // × opens the inline confirm strip; Keep closes it without discarding.
  await page.getByTestId('push-discard-navidrome-s1').click()
  const confirmStrip = page.getByTestId('push-discard-confirm-navidrome-s1')
  await expect(confirmStrip).toContainText('Discard this edit?')
  await confirmStrip.getByRole('button', { name: 'Keep' }).click()
  await expect(page.getByText('2 files will be updated:')).toBeVisible()

  // × again → Discard. The dialog rebuilds: count drops 2 → 1, the discarded
  // row leaves the list, Song Two survives.
  await page.getByTestId('push-discard-navidrome-s1').click()
  await expect(confirmStrip).toBeVisible()
  await confirmStrip.getByRole('button', { name: 'Discard' }).click()
  await expect(page.getByText('1 file will be updated:')).toBeVisible()
  await expect(s1Row).toHaveCount(0)
  await expect(s2Row).toContainText('Song Two')
  await expect(s2Row).toContainText('Artist B · Album Y')

  // Push proceeds with the survivor only: Song One's file must be untouched
  // (no POPM), Song Two's carries the write.
  await page.getByRole('button', { name: 'Write to files' }).click()
  await expect(page.getByText(/Pushed 1 track/)).toBeVisible({ timeout: 30_000 })
  expect(dav.getMoveCount(), 'only the surviving row was written').toBe(1)
  expect(dav.bytesOf('Song One.mp3')!.indexOf(Buffer.from('POPM'))).toBe(-1)
  expect(dav.bytesOf('Song Two.mp3')!.indexOf(Buffer.from('POPM'))).toBeGreaterThan(-1)
})

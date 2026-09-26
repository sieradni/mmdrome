import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldKeepPushPending, shouldSkipBeforePut, classifyRowForPush, buildPushBreakdown, withLibraryTitles, EMPTY_PUSH_BREAKDOWN, type PushRowSnapshot, type PushBreakdownRow } from '../src/lib/pushReconcile'

function row(over: Partial<PushRowSnapshot> = {}): PushRowSnapshot {
  return { rating: 70, loved: true, syncStatus: 'pending_sync', webdavPath: '/m/a.mp3', webdavBase: 'u|user', comments: 'c', ...over }
}

test('no live row → flatten (nothing to preserve)', () => {
  assert.equal(shouldKeepPushPending(row(), undefined), false)
})

test('live row no longer pending → flatten (no live edit to preserve)', () => {
  assert.equal(shouldKeepPushPending(row(), row({ syncStatus: 'synced', rating: 90 })), false)
})

test('identical fields → flatten', () => {
  assert.equal(shouldKeepPushPending(row(), row()), false)
})

test('rating diverges → keep pending', () => {
  assert.equal(shouldKeepPushPending(row(), row({ rating: 90 })), true)
})

test('loved diverges → keep pending', () => {
  assert.equal(shouldKeepPushPending(row(), row({ loved: false })), true)
})

test('webdavPath diverges (re-bind) → keep pending', () => {
  assert.equal(shouldKeepPushPending(row(), row({ webdavPath: '/m/b.mp3' })), true)
})

test('webdavBase diverges (server swap) → keep pending', () => {
  assert.equal(shouldKeepPushPending(row(), row({ webdavBase: 'v|user' })), true)
})

test('comments diverges → keep pending', () => {
  assert.equal(shouldKeepPushPending(row(), row({ comments: 'new' })), true)
})

test('path cleared on the live row → keep pending (the stale path must not be restored)', () => {
  assert.equal(shouldKeepPushPending(row(), row({ webdavPath: undefined })), true)
})

test('comments cleared on the live row → keep pending', () => {
  assert.equal(shouldKeepPushPending(row(), row({ comments: undefined })), true)
})

test('syncStatus-only difference does not keep pending (both pending)', () => {
  // Both rows are pending; nothing user-visible differs.
  assert.equal(shouldKeepPushPending(row({ syncStatus: 'synced' }), row({ syncStatus: 'pending_sync' })), false)
})

test('missing optional fields on BOTH sides do not keep pending', () => {
  const bare = row({ webdavPath: undefined, webdavBase: undefined, comments: undefined, matchSource: undefined, ignored: undefined })
  assert.equal(shouldKeepPushPending(bare, row({ webdavPath: undefined, webdavBase: undefined, comments: undefined, matchSource: undefined, ignored: undefined })), false)
})

test('matchSource diverges (manual bind made/revoked) → keep pending', () => {
  assert.equal(shouldKeepPushPending(row(), row({ matchSource: 'manual' })), true)
  assert.equal(shouldKeepPushPending(row({ matchSource: 'manual' }), row({ matchSource: undefined })), true)
})

test('ignored diverges (mid-push dismissal) → keep pending', () => {
  assert.equal(shouldKeepPushPending(row(), row({ ignored: true })), true)
  assert.equal(shouldKeepPushPending(row({ ignored: true }), row({ ignored: false })), true)
})

test('shouldSkipBeforePut: no live edit → proceed with the snapshot', () => {
  assert.equal(shouldSkipBeforePut(row(), undefined, 'u|user'), false)
  assert.equal(shouldSkipBeforePut(row(), row(), 'u|user'), false)
  assert.equal(shouldSkipBeforePut(row(), row({ rating: 90, loved: false, comments: 'x' }), 'u|user'), false, 'rating/loved/comments edits do not abort the PUT (the POST re-pend covers them)')
})

test('shouldSkipBeforePut: live path cleared mid-push → abort', () => {
  assert.equal(shouldSkipBeforePut(row(), row({ webdavPath: undefined }), 'u|user'), true)
})

test('shouldSkipBeforePut: live dismissal mid-push → abort', () => {
  assert.equal(shouldSkipBeforePut(row(), row({ ignored: true }), 'u|user'), true)
})

test('shouldSkipBeforePut: live re-bind (new path) → abort', () => {
  assert.equal(shouldSkipBeforePut(row(), row({ webdavPath: '/m/b.mp3' }), 'u|user'), true)
})

test('shouldSkipBeforePut: live baseKey differs from the current server → abort', () => {
  assert.equal(shouldSkipBeforePut(row(), row({ webdavBase: 'v|user' }), 'u|user'), true)
})

// classifyRowForPush — the ONE per-row classification shared by the push
// loop (syncEngine) and the confirmation dialog's safe count (SettingsView).
// The matrix pins the buckets AND the precedence: the FIRST matching rule
// wins, mirroring the loop's original early-continue chain (path before
// ignored before base).

const BASE_KEY = 'u|user'

test('classify: pushable row (path + matching base)', () => {
  assert.equal(classifyRowForPush(row(), BASE_KEY), 'pushable')
})

test('classify: no path → no-path, even with a stale base stamped', () => {
  assert.equal(classifyRowForPush(row({ webdavPath: undefined, webdavBase: 'v|user' }), BASE_KEY), 'no-path')
})

test('classify: ignored beats wrong-server (dismissal wins over provenance)', () => {
  assert.equal(classifyRowForPush(row({ ignored: true, webdavBase: 'v|user' }), BASE_KEY), 'ignored')
})

test('classify: no base → no-base (unverified legacy row), not wrong-server', () => {
  assert.equal(classifyRowForPush(row({ webdavBase: undefined }), BASE_KEY), 'no-base')
})

test('classify: base differs from the current server → wrong-server', () => {
  assert.equal(classifyRowForPush(row({ webdavBase: 'v|user' }), BASE_KEY), 'wrong-server')
})

test('classify: trailing-slash/case variants of the base count as wrong-server', () => {
  // The baseKey derivation (webdavBaseKey) is the caller's job; the  // classifier only compares strings — a deliberately different key IS a  // different server as far as this decision is concerned.
  assert.equal(classifyRowForPush(row({ webdavBase: 'U|user' }), BASE_KEY), 'wrong-server')
})

test('classify: pushable requires the base to match EXACTLY (not just truthy)', () => {
  assert.equal(classifyRowForPush(row({ webdavBase: 'u|user ' }), BASE_KEY), 'wrong-server', 'whitespace-different key is a different server string')
})

// buildPushBreakdown — the dialog's full picture, derived through the ONE
// classifier (a breakdown that disagreed with the run would be the old
// drift bug again, just rendered prettier).

test('breakdown: counts every bucket and lists only pushable tracks', () => {
  const rows = [
    { ...row(), trackId: 't1', title: 'Keep Me', webdavPath: '/m/a.mp3', webdavBase: 'u|user' },
    { ...row(), trackId: 't2', title: 'Wrong Server', webdavBase: 'v|user' },
    { ...row(), trackId: 't3', title: 'Dismissed', ignored: true },
    { ...row(), trackId: 't4', title: 'No Base', webdavBase: undefined },
    { ...row(), trackId: 't5', title: 'No Path', webdavPath: undefined },
    { ...row(), trackId: 't6', title: 'Also Kept', webdavPath: '/m/b.mp3', webdavBase: 'u|user' },
  ]
  const bd = buildPushBreakdown(rows, BASE_KEY)
  assert.deepEqual(
    { pushable: bd.pushable, noPath: bd.noPath, ignored: bd.ignored, noBase: bd.noBase, wrongServer: bd.wrongServer },
    { pushable: 2, noPath: 1, ignored: 1, noBase: 1, wrongServer: 1 },
  )
  assert.deepEqual(bd.tracks.map((t) => t.title), ['Keep Me', 'Also Kept'])
  assert.deepEqual(bd.tracks.map((t) => t.webdavPath), ['/m/a.mp3', '/m/b.mp3'])
})

test('breakdown: missing title falls back to the trackId (never crashes the dialog)', () => {
  const bd = buildPushBreakdown([{ ...row(), trackId: 'navidrome-x' }], BASE_KEY)
  assert.equal(bd.tracks[0].title, 'navidrome-x')
})

test('breakdown: empty pending → all zeros, empty list', () => {
  assert.deepEqual(buildPushBreakdown([], BASE_KEY), EMPTY_PUSH_BREAKDOWN)
})

// withLibraryTitles — the dialog's display-name decorator. Pending rows carry
// no title of their own; without the library lookup the dialog rendered raw
// navidrome ids (2026-09-26 field report). The unknown-id case must stay
// UNTOUCHED so the `title ?? trackId` fallback + the view's orphan hint can
// do their job — an orphaned row is never renamed to something invented.

test('titles: enriches rows found in the library map (Title — Artist format)', () => {
  const rows: PushBreakdownRow[] = [
    { ...row(), trackId: 'navidrome-s1' },
    { ...row(), trackId: 'navidrome-s2' },
  ]
  const titles = new Map([
    ['navidrome-s1', 'Song One — Artist A'],
    ['navidrome-s2', 'Song Two — Artist B'],
  ])
  assert.deepEqual(
    withLibraryTitles(rows, titles).map((r) => r.title),
    ['Song One — Artist A', 'Song Two — Artist B'],
  )
})

test('titles: ids missing from the map keep their fallback (orphan rows untouched)', () => {
  const rows: PushBreakdownRow[] = [{ ...row(), trackId: 'navidrome-orphan' }]
  const titles = new Map([['navidrome-s1', 'Song One — Artist A']])
  const out = withLibraryTitles(rows, titles)
  assert.equal(out[0].title, undefined, 'no invented name for a library-missing id')
  assert.equal(out[0].trackId, 'navidrome-orphan')
})

test('titles: an existing stale title never overrides the live library name', () => {
  // A re-matched row could theoretically carry an old title field; the live
  // library is the display source of truth.
  const rows: PushBreakdownRow[] = [{ ...row(), trackId: 'navidrome-s1', title: 'Old Title' }]
  const titles = new Map([['navidrome-s1', 'Song One — Artist A']])
  assert.equal(withLibraryTitles(rows, titles)[0].title, 'Song One — Artist A')
})

test('titles: empty map returns the SAME rows (library missing = no enrichment, no crash)', () => {
  const rows: PushBreakdownRow[] = [{ ...row(), trackId: 'navidrome-x', title: undefined }]
  assert.equal(withLibraryTitles(rows, new Map()), rows)
})

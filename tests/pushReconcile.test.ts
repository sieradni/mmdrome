import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldKeepPushPending, shouldSkipBeforePut, type PushRowSnapshot } from '../src/lib/pushReconcile'

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

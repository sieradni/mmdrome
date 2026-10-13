// Pins the pending-scrobble enqueue BEHAVIOR (A3, 2026-10-09) — the fix, not
// just its predicate: a duplicate is still a silent no-op, but an aborted write
// is retried once and, if it still fails, the dropped Listen is named in the
// danger ring instead of masquerading as "already queued".

import './stub-audio-worklet-node'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { db, enqueuePendingScrobble, type PendingScrobbleRow } from '../src/lib/db'
import { clearJsDebugEvents, jsDebugEventsSnapshot } from '../src/lib/debugLog'

// Dexie tables share one prototype (the tests/seekEpochsKillSwitch.test.ts
// pattern): `add` is driven per attempt from the scripted `attempts` queue.
let attempts: Array<'ok' | 'ConstraintError' | 'AbortError'> = []
let calls = 0
Object.getPrototypeOf(db.pendingScrobbles).add = (async () => {
  calls += 1
  const outcome = attempts.shift() ?? 'ok'
  if (outcome === 'ok') return 1
  throw Object.assign(new Error(outcome), { name: outcome })
}) as never

const row: Omit<PendingScrobbleRow, 'seq'> = {
  kind: 'lfm-scrobble',
  artist: 'A',
  track: 'T',
  timestamp: 1_700_000_000,
  queuedAt: 1_700_000_000_000,
  attempts: 0,
}

const dangerLines = () =>
  jsDebugEventsSnapshot().filter((e) => e.level === 'danger' && e.msg.includes('pending scrobble enqueue failed'))

test('a unique-index duplicate stays a silent no-op', async () => {
  clearJsDebugEvents()
  attempts = ['ConstraintError']
  calls = 0
  assert.equal(await enqueuePendingScrobble(row), false)
  assert.equal(calls, 1, 'a duplicate is never retried')
  assert.equal(dangerLines().length, 0, 'a duplicate is by design, not a failure')
})

test('an aborted write is retried once and succeeds', async () => {
  clearJsDebugEvents()
  attempts = ['AbortError', 'ok']
  calls = 0
  assert.equal(await enqueuePendingScrobble(row), true, 'the retry recovers the Listen')
  assert.equal(calls, 2)
  assert.equal(dangerLines().length, 0)
})

test('a duplicate on retry means another producer queued it, not a dropped event', async () => {
  clearJsDebugEvents()
  attempts = ['AbortError', 'ConstraintError']
  calls = 0
  assert.equal(await enqueuePendingScrobble(row), false)
  assert.equal(calls, 2)
  assert.equal(dangerLines().length, 0)
})

test('an unrecoverable write reports the event as NOT queued', async () => {
  clearJsDebugEvents()
  attempts = ['AbortError', 'AbortError']
  calls = 0
  assert.equal(await enqueuePendingScrobble(row), false)
  assert.equal(calls, 2, 'exactly one retry, then give up')
  const lines = dangerLines()
  assert.equal(lines.length, 1)
  assert.match(lines[0].msg, /pending scrobble enqueue failed: AbortError — event NOT queued/)
})

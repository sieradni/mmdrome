// Pins initStores' storage boot recovery (2026-10-13). The field report: iOS
// WebKit invalidated the IndexedDB handle, the first read of the boot threw
// `UnknownError: Attempt to get a record from database without an in-progress
// transaction`, and the app landed with an empty library and no way back —
// while the native engine kept playing.
//
// This test drives the REAL `initStores` over a stubbed Dexie table layer: the
// first metadata read throws the WebKit shape, `reopenDatabase()` is counted,
// and the retried read succeeds. It also pins the two things that make the
// recovery honest — a non-connection error aborts on the FIRST attempt (no
// blind retry), and both attempts are recorded in the debug ring (the report's
// `jsEvents` was empty, so the failure was invisible).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { db } from '../src/lib/db'
import { initStores, metadataCache } from '../src/stores/appState'
import { jsDebugEventsSnapshot } from '../src/lib/debugLog'

function brokenIdbError(): Error {
  return Object.assign(
    new Error('Attempt to get a record from database without an in-progress transaction'),
    { name: 'UnknownError' },
  )
}

// Dexie tables share ONE prototype (F3): `get`/`put`/`toArray` are patched ONCE
// and dispatch on the table instance — patching `db.playQueue.get` would clobber
// `db.userSettings.get`.
const settingsRows = new Map<string, unknown>()
let metadataReadAction: (() => unknown[]) | null = () => {
  throw new Error('boom')
}
let metadataReads = 0
let reopens = 0

Object.getPrototypeOf(db.userSettings).get = (async function (this: { name: string }, key: string) {
  if (this.name === 'playQueue') return undefined
  const value = settingsRows.get(key)
  return value === undefined ? undefined : { key, value }
}) as never
Object.getPrototypeOf(db.userSettings).put = (async (entry: { key: string; value: unknown }) => {
  settingsRows.set(entry.key, entry.value)
}) as never
Object.getPrototypeOf(db.localMetadata).toArray = (async function (this: { name: string }) {
  if (this.name !== 'localMetadata') return []
  metadataReads++
  return metadataReadAction ? metadataReadAction() : []
}) as never

// The recovery leg: `db.close({disableAutoOpen:false})` is harmless without
// IndexedDB, but `db.open()` needs a real IDB — count the reopen instead and
// resolve, exactly as a fresh `indexedDB.open()` would.
Object.getPrototypeOf(db).open = (async () => {
  reopens++
  return db
}) as never

const storageEvents = () => jsDebugEventsSnapshot().filter((e) => e.domain === 'storage')

test('initStores: an ordinary error aborts at once — no reopen, no retry', async () => {
  await assert.rejects(initStores(), /boom/)
  assert.equal(metadataReads, 1, 'no second read: only a dead connection is retried')
  assert.equal(reopens, 0, 'an unknown failure must never close/reopen the database')
  const events = storageEvents()
  assert.equal(events.length, 1)
  assert.equal(events[0].level, 'danger')
  assert.match(events[0].msg, /attempt 1\/3/)
  assert.match(events[0].msg, /Error boom/)
  assert.match(events[0].msg, /→ abort$/)
})

test('initStores: a dead connection reopens the database and completes the boot', async () => {
  metadataReadAction = () => {
    if (metadataReads === 2) throw brokenIdbError()
    return []
  }
  await initStores()
  assert.equal(metadataReads, 3, 'the failed attempt plus the successful retry')
  assert.equal(reopens, 1)
  assert.ok(get(metadataCache) instanceof Map, 'the boot completed — the metadata cache was populated')
  const events = storageEvents()
  // The LAST danger line is this test's — test 1 already recorded its own.
  const danger = events.filter((e) => e.level === 'danger').pop()!
  assert.match(danger.msg, /attempt 1\/3/)
  assert.match(danger.msg, /→ reopen$/)
  assert.match(danger.msg, /UnknownError Attempt to get a record from database without an in-progress transaction/)
  assert.ok(
    events.some((e) => e.level === 'info' && /reopened the local database connection/.test(e.msg)),
    'the recovery itself is recorded, not just the failure',
  )
})

test('initStores is once-per-process after a successful boot', async () => {
  const reads = metadataReads
  await initStores()
  assert.equal(metadataReads, reads)
  assert.equal(reopens, 1)
})

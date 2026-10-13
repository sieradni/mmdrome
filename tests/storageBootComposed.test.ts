// Pins the COMPOSITION of the two recovery layers (2026-10-13), which neither
// of the other suites covers: `storageInitRecovery.test.ts` drives initStores'
// phase loop with the OPERATION WRAPPER bypassed (it patches the per-instance
// prototype, i.e. the seam the installer wraps on), and
// `dbOperationRecovery.test.ts` drives the installer over fake prototypes with
// no boot loop above it. Here both are production code and the ORDER is what is
// pinned: a dead read is absorbed by the operation wrapper, so the boot loop
// never sees a failure and the whole boot needs exactly ONE reopen.
//
// The patch order is the mechanism: Dexie's method-owning prototypes are shared
// module-level classes, so replacing them BEFORE `$lib/db` is first imported
// means the real installer wraps THESE fakes (a throwaway instance reaches the
// same classes the app's db will use). Importing `$lib/db` statically would
// evaluate it first and wrap the real Dexie methods instead.

import Dexie from 'dexie'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { jsDebugEventsSnapshot } from '../src/lib/debugLog'

function deadIdbError(): Error {
  return Object.assign(
    new Error('Attempt to get a record from database without an in-progress transaction'),
    { name: 'UnknownError' },
  )
}

let reopens = 0
let metadataReads = 0

const throwaway = new Dexie('probe')
const tableBase = Object.getPrototypeOf(throwaway.Table.prototype) as Record<string, unknown>
const collectionBase = Object.getPrototypeOf(throwaway.Collection.prototype) as Record<string, unknown>
const dexieBase = Object.getPrototypeOf(throwaway) as Record<string, unknown>

/** The first metadata read fails with the WebKit shape; the retry succeeds. */
tableBase.get = async function (this: { name: string }) {
  return undefined // playQueue / userSettings rows: nothing saved
}
tableBase.toArray = async function (this: { name: string }) {
  if (this.name !== 'localMetadata') return []
  metadataReads++
  if (metadataReads === 1) throw deadIdbError()
  return [{ trackId: 'track-1', rating: 0, loved: false }]
}
tableBase.put = async () => undefined
collectionBase.toArray = tableBase.toArray
// A fresh `indexedDB.open()` cannot run without IndexedDB: count it and resolve,
// exactly as the real reopen would after WebKit's network process restarted.
dexieBase.open = async function (this: unknown) {
  reopens++
  return this
}

test('a dead read during boot is absorbed by the operation wrapper — one reopen, no boot-loop retry', async () => {
  const { initStores, metadataCache } = await import('../src/stores/appState')
  await initStores()

  assert.equal(metadataReads, 2, "the failed read plus the wrapper's retry")
  assert.equal(reopens, 1, 'exactly one reopen for the whole boot')
  assert.ok(get(metadataCache) instanceof Map, 'the boot completed')
  assert.equal(get(metadataCache).size, 1, 'the retried read populated the cache')

  const storage = jsDebugEventsSnapshot().filter((e) => e.domain === 'storage')
  assert.ok(
    storage.some((e) => /toArray: .*without an in-progress transaction → reopen-and-retry/.test(e.msg)),
    'the wrapper recorded what it did',
  )
  assert.ok(storage.some((e) => /reopened the local database connection/.test(e.msg)))
  // The load-bearing assertion: the boot loop's own recovery never ran, so the
  // two layers did not both react to the same failure (one reopen, not two).
  assert.equal(
    storage.filter((e) => /local storage init failed/.test(e.msg)).length,
    0,
    'the failure never reached initStores — the wrapper handled it first',
  )
})

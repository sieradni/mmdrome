// Pins the stale-ID reconciliation that runs on every full setLibrary — the
// Navidrome 0.64 migration's queue/metadata safety net. After the server's ID
// re-encoding, a restored playQueue and the metadata cache can reference ids
// that no longer exist in the loaded library: queue rows must be dropped (and
// the active index re-anchored BY ID), the persisted queue rewritten, and the
// metadata cache pruned — EXCEPT pending_sync rows (unpushed local edits
// survive for Push Changes; they are never silently destroyed).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { db, type LocalMetadataStore } from '../src/lib/db'
import { queue, metadataCache, setLibrary, type Track } from '../src/stores/appState'

const queuePuts: unknown[] = []
const deletedIds: string[] = []

// Dexie under Node: capture the writes (same prototype-patch pattern as
// autoQueueFiltersPersistence.test.ts — tables share one prototype).
Object.getPrototypeOf(db.playQueue).put = (async (row: unknown) => {
  queuePuts.push(row)
}) as never
Object.getPrototypeOf(db.localMetadata).bulkDelete = (async (ids: string[]) => {
  deletedIds.push(...ids)
}) as never

function track(id: string): Track {
  return { trackId: id, title: `T ${id}`, artist: 'A', album: 'Al', duration: 120, fileType: 'mp3' }
}

function meta(id: string, syncStatus: 'synced' | 'pending_sync'): LocalMetadataStore {
  return {
    trackId: id,
    rating: 40,
    loved: true,
    fileType: 'mp3',
    syncStatus,
    lastModifiedLocally: 1,
  }
}

const NEW_IDS = ['navidrome-new-1', 'navidrome-new-2']
const newLibrary = NEW_IDS.map(track)

test('0.64 re-encoding scenario: old-id queue rows are dropped, the persisted queue is rewritten', () => {
  queuePuts.length = 0
  queue.set({ userQueue: ['navidrome-old-1', 'navidrome-old-2'], autoQueue: ['navidrome-old-3'], recentTrackIds: ['navidrome-old-9'], activeIndex: 0 })

  setLibrary(newLibrary)

  const q = get(queue)
  assert.deepEqual(q.userQueue, [], 'dead ids filtered from the user queue')
  assert.deepEqual(q.autoQueue, [])
  assert.deepEqual(q.recentTrackIds, [], 'the LRU window drops dead ids (self-heals on new plays)')
  assert.equal(q.activeIndex, -1, 'the active row is gone → no active index')
  assert.equal(queuePuts.length, 1, 'the pruned state is persisted')
  assert.deepEqual((queuePuts[0] as { userQueue: string[] }).userQueue, [])
})

test('re-anchor is BY ID: the active row keeps its active status at its new position', () => {
  queuePuts.length = 0
  // y is active at index 1. The queue preserves USER order (it is never
  // reordered to match library order) — dropping x shifts y to index 0.
  queue.set({ userQueue: ['navidrome-x', 'navidrome-y'], autoQueue: [], recentTrackIds: [], activeIndex: 1 })

  // Only 'x' survives — the active row (y) is gone → no active index.
  setLibrary([track('navidrome-x')])
  assert.equal(get(queue).activeIndex, -1, 'active row y is gone')

  // Now y is active at index 1, x dies in the load, and y must REMAIN active
  // at its new position 0 (an index-paste would have pointed at x instead).
  queue.set({ userQueue: ['navidrome-x', 'navidrome-y'], autoQueue: [], recentTrackIds: [], activeIndex: 1 })
  setLibrary([track('navidrome-y')])
  const q = get(queue)
  assert.deepEqual(q.userQueue, ['navidrome-y'])
  assert.equal(q.activeIndex, 0, 'y stays active at its new position — anchored by id')
})

test('metadata cache: synced orphans are pruned to Dexie, pending_sync orphans survive', () => {
  deletedIds.length = 0
  metadataCache.set(new Map([
    ['navidrome-old-synced', meta('navidrome-old-synced', 'synced')],
    ['navidrome-old-pending', meta('navidrome-old-pending', 'pending_sync')],
    ['navidrome-new-1', meta('navidrome-new-1', 'synced')],
  ]))

  setLibrary(newLibrary)

  assert.deepEqual(deletedIds, ['navidrome-old-synced'], 'only non-pending orphans are deleted')
  const remaining = get(metadataCache)
  assert.equal(remaining.has('navidrome-old-synced'), false, 'pruned from the in-memory map too')
  assert.equal(remaining.has('navidrome-old-pending'), true, 'unpushed local edits are NEVER silently destroyed')
  assert.equal(remaining.has('navidrome-new-1'), true)
})

test('an incomplete load (complete=false) never reconciles anything', () => {
  deletedIds.length = 0
  queuePuts.length = 0
  queue.set({ userQueue: ['navidrome-old-1'], autoQueue: [], recentTrackIds: [], activeIndex: 0 })
  metadataCache.set(new Map([['navidrome-old-synced', meta('navidrome-old-synced', 'synced')]]))

  setLibrary(newLibrary, false)

  assert.equal(get(queue).userQueue.length, 1, 'queue untouched')
  assert.deepEqual(deletedIds, [], 'no metadata deletion')
  assert.equal(queuePuts.length, 0, 'nothing persisted')
})

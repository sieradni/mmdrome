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
import { queue, metadataCache, setLibrary, relinkPendingMetadata, type Track } from '../src/stores/appState'

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

// ── Pending-edit re-link (2026-09-26) ─────────────────────────────────────────
// An id migration orphans unpushed edits on dead ids. The keep-rule above
// preserves them; the re-link moves each one onto the SAME song's surviving
// id when the orphan's stamped webdavPath names a file exactly one live
// track owns (path witness: row binding + library binding must AGREE), then
// deletes the dead row. The move is never a demotion (stays pending_sync)
// and never overwrites a live pending edit. LocalMetadataStore rows carry no
// title, so in-app metadata-only evidence cannot fire — a bare orphan stays
// residue for the Push dialog's discard ×.

const bulkUpserts: LocalMetadataStore[] = []
// Same prototype-patch pattern as the bulkDelete mock above (bulkUpsertMetadata
// chunks down to table.bulkPut, so the moved row is captured per chunk).
Object.getPrototypeOf(db.localMetadata).bulkPut = (async (items: LocalMetadataStore[]) => {
  bulkUpserts.push(...items)
}) as never

function pathMeta(id: string, path: string, base: string): LocalMetadataStore {
  return {
    trackId: id,
    rating: 80,
    loved: true,
    fileType: 'mp3',
    syncStatus: 'pending_sync',
    lastModifiedLocally: 1,
    webdavPath: path,
    webdavBase: base,
    matchSource: 'auto',
  }
}

function liveTrack(id: string): Track {
  return track(id)
}

const CURRENT_BASE = 'https://dav.test|user'

test('pending re-link: an orphaned edit moves onto the new id whose row owns the same file, then the dead row is deleted', async () => {
  bulkUpserts.length = 0
  deletedIds.length = 0
  metadataCache.set(new Map([
    ['navidrome-old-p', pathMeta('navidrome-old-p', '/music/Song One.mp3', CURRENT_BASE)],
    ['navidrome-new-1', { ...meta('navidrome-new-1', 'synced'), webdavPath: '/music/Song One.mp3', webdavBase: CURRENT_BASE }],
    ['navidrome-new-2', meta('navidrome-new-2', 'synced')],
  ]))

  setLibrary([liveTrack('navidrome-new-1'), liveTrack('navidrome-new-2')])
  await relinkPendingMetadata([liveTrack('navidrome-new-1'), liveTrack('navidrome-new-2')], CURRENT_BASE)

  const remaining = get(metadataCache)
  assert.equal(remaining.has('navidrome-old-p'), false, 'the dead row is gone from the in-memory map')
  const moved = remaining.get('navidrome-new-1')
  assert.ok(moved, 'the new-id row exists')
  assert.equal(moved!.syncStatus, 'pending_sync', 'the edit is NOT demoted — Push still owns it')
  assert.equal(moved!.rating, 80)
  assert.equal(moved!.loved, true)
  assert.equal(moved!.webdavPath, '/music/Song One.mp3', 'the file binding carries over (file evidence)')
  assert.deepEqual(deletedIds, ['navidrome-old-p'], 'the dead id is deleted from Dexie')
  assert.equal(bulkUpserts.some((r) => r.trackId === 'navidrome-new-1'), true, 'the moved row is persisted')
})

test('pending re-link: a live pending row is never overwritten — the orphan survives as residue', async () => {
  bulkUpserts.length = 0
  deletedIds.length = 0
  metadataCache.set(new Map([
    ['navidrome-old-p', pathMeta('navidrome-old-p', '/music/Song One.mp3', CURRENT_BASE)],
    ['navidrome-new-1', pathMeta('navidrome-new-1', '/music/Song One.mp3', CURRENT_BASE)], // the new id has its OWN pending edit
  ]))

  setLibrary([liveTrack('navidrome-new-1')])
  await relinkPendingMetadata([liveTrack('navidrome-new-1')], CURRENT_BASE)

  const remaining = get(metadataCache)
  assert.equal(remaining.has('navidrome-old-p'), true, 'the orphan stays (discard × surface)')
  assert.equal(remaining.get('navidrome-new-1')!.rating, 80, 'the LIVE edit is untouched')
  assert.deepEqual(deletedIds, [], 'nothing deleted')
  assert.equal(bulkUpserts.length, 0, 'nothing written')
})

test('pending re-link: a metadata-lane move carries the identity snapshot and keeps the live binding', async () => {
  bulkUpserts.length = 0
  deletedIds.length = 0
  // Path-less orphan WITH the commit-time identity snapshot (the new lane).
  metadataCache.set(new Map([
    ['navidrome-old-m', { ...pathMeta('navidrome-old-m', '/music/never.mp3', CURRENT_BASE), webdavPath: undefined, webdavBase: undefined, title: 'T navidrome-new-1', artist: 'A' }],
    ['navidrome-new-1', { ...meta('navidrome-new-1', 'synced'), webdavPath: '/music/Song One.mp3', webdavBase: CURRENT_BASE }],
  ]))
  setLibrary([liveTrack('navidrome-new-1')])
  await relinkPendingMetadata([liveTrack('navidrome-new-1')], CURRENT_BASE)

  const moved = get(metadataCache).get('navidrome-new-1')
  assert.ok(moved)
  assert.equal(moved!.syncStatus, 'pending_sync', 'still Push-owned')
  // Identity-only evidence: the edit moves, the file binding does NOT.
  assert.equal(moved!.webdavPath, '/music/Song One.mp3', 'the live binding survives (no path re-stamp from a title fold)')
  assert.equal(moved!.title, 'T navidrome-new-1', 'the snapshot rides along (provenance of the evidence)')
  assert.deepEqual(deletedIds, ['navidrome-old-m'])
})



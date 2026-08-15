// Pins the thin-glue half of the auto-queue fill: the REAL QueueManager
// applying the pure plan to the REAL stores (queue + saveQueue + wrapNotice).
// The pure decision is pinned by autoQueuePlan.test.ts; this suite closes the
// "decision vs application" gap for the interpreter — the two no-op guards
// must skip the Dexie write, and the written queue must equal kept+fill.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { db } from '../src/lib/db'
import { queueManager } from '../src/lib/queueManager'
import { libraryFilters } from '../src/lib/libraryFilters'
import {
  queue,
  library,
  shuffleEnabled,
  metadataCache,
  queueWrapNotice,
  autoQueueFilterFields,
  autoQueueScope,
  autoQueueEmptyNotice,
} from '../src/stores/appState'
import type { Track, AutoQueueFilterFields, QueueState } from '../src/stores/appState'
import type { LocalMetadataStore } from '../src/lib/db'

const track = (id: string, over: Partial<Track> = {}): Track => ({
  trackId: id,
  title: `T${id}`,
  artist: 'Artist A',
  album: 'Album X',
  duration: 100,
  fileType: 'mp3',
  ...over,
})

const metaOf = (rows: [string, number, boolean?][]): Map<string, LocalMetadataStore> =>
  new Map(rows.map(([trackId, rating, loved = false]) => [trackId, {
    trackId, rating, loved, fileType: 'mp3', syncStatus: 'synced' as const, lastModifiedLocally: 0,
  }]))

// saveQueue writes db.playQueue.put. ALL tables on a Dexie instance share ONE
// prototype (F3), so patch `put` once and dispatch on the table name — a
// per-table patch would clobber itself.
const playQueueWrites: unknown[] = []
Object.getPrototypeOf(db.playQueue).put = (async function (this: { name: string }, entry: unknown) {
  if (this.name === 'playQueue') playQueueWrites.push(entry)
}) as never

const FIELDS: AutoQueueFilterFields = {
  minRating: 0, maxRating: 100, lovedOnly: false, fromYear: '', toYear: '', minLength: '', maxLength: '',
}

function setQueue(q: Partial<QueueState>): void {
  queue.set({
    userQueue: [],
    autoQueue: [],
    recentTrackIds: [],
    activeIndex: 0,
    ...q,
  })
}

function reset(): void {
  playQueueWrites.length = 0
  setQueue({})
  library.set([])
  shuffleEnabled.set(false)
  metadataCache.set(new Map())
  autoQueueFilterFields.set({ ...FIELDS })
  autoQueueScope.set({})
  libraryFilters.set({
    filterOpen: false, sortOpen: false, minRating: 0, maxRating: 100, lovedOnly: false,
    genre: '', fromYear: '', toYear: '', minLength: '', maxLength: '', sortBy: null, sortAsc: true,
  })
  queueWrapNotice.set(false)
  autoQueueEmptyNotice.set(false)
}

function lastWrite(): QueueState & { id: string } {
  assert.ok(playQueueWrites.length > 0, 'expected at least one queue write')
  return playQueueWrites[playQueueWrites.length - 1] as QueueState & { id: string }
}

test('replenish fills the auto queue from fresh tracks, excluding the playing user track', () => {
  reset()
  library.set(['t1', 't2', 't3', 't4', 't5', 't6'].map((id) => track(id)))
  setQueue({ userQueue: ['t1'], activeIndex: 0 })

  queueManager.replenishAutoQueue()

  assert.deepEqual(get(queue).autoQueue, ['t2', 't3', 't4', 't5', 't6'])
  assert.equal(get(queueWrapNotice), false)
  assert.deepEqual(lastWrite().autoQueue, ['t2', 't3', 't4', 't5', 't6'], 'the write persisted kept+fill')
})

test('a tightened filter prunes non-matching auto tracks and stops filling (kept-only write)', () => {
  reset()
  const ts = ['t1', 't2', 't3', 't4', 't5', 't6'].map((id) => track(id))
  library.set(ts)
  metadataCache.set(metaOf([['t2', 80]]))
  // First fill at default filters: everything except the playing t1.
  setQueue({ userQueue: ['t1'], activeIndex: 0 })
  queueManager.replenishAutoQueue()
  assert.deepEqual(get(queue).autoQueue, ['t2', 't3', 't4', 't5', 't6'])

  // Tighten to minRating 50 — only t2 still matches.
  autoQueueFilterFields.set({ ...FIELDS, minRating: 50 })
  queueManager.replenishAutoQueue()

  assert.deepEqual(get(queue).autoQueue, ['t2'], 'non-matching auto tracks are dropped')
})

test('the no-op guards skip the Dexie write when nothing can change', () => {
  reset()
  library.set(['t1', 't2'].map((id) => track(id)))
  metadataCache.set(metaOf([['t2', 80]]))
  setQueue({ userQueue: ['t1'], activeIndex: 0 })
  queueManager.replenishAutoQueue()
  assert.deepEqual(get(queue).autoQueue, ['t2'])
  const writes = playQueueWrites.length

  // Tighten so nothing matches and nothing is dropped: kept stays [t2] (still
  // matching), the pool is empty → second no-op guard → NO write.
  autoQueueFilterFields.set({ ...FIELDS, minRating: 50 })
  queueManager.replenishAutoQueue()
  assert.equal(playQueueWrites.length, writes, 'an unchanged queue must not re-write')

  // Queue already full of matching tracks → first no-op guard → NO write.
  const writes2 = playQueueWrites.length
  autoQueueFilterFields.set({ ...FIELDS })
  queueManager.replenishAutoQueue()
  assert.equal(playQueueWrites.length, writes2, 'a full queue must not re-write')
  assert.equal(get(queue).autoQueue.length, 1)
})

test('a sort change rebuilds the whole auto queue in the shared-sort order (B7)', () => {
  reset()
  // Library order scrambled vs. rating order, so the B7 fix is observable.
  library.set(['c', 'e', 'a', 'f', 'b', 'd'].map((id) => track(id)))
  metadataCache.set(metaOf([['a', 10], ['b', 20], ['c', 30], ['d', 40], ['e', 50], ['f', 100]]))
  setQueue({ userQueue: ['f'], activeIndex: 0 })
  libraryFilters.update((lf) => ({ ...lf, sortBy: 'rating', sortAsc: true }))

  queueManager.rebuildAutoQueue()

  // f is the PLAYING track (activeId) — the rotation tier excludes it, so the
  // rebuilt queue is the rating-sorted a..e. Nothing ranks after the anchor f,
  // so the rotation wrapped from the top (wrapNotice).
  assert.deepEqual(get(queue).autoQueue, ['a', 'b', 'c', 'd', 'e'], 'rating-sorted fill (active f excluded)')
  assert.equal(get(queueWrapNotice), true, 'nothing ranks after the anchor f → wrapped')
})

test('shuffle mode permutes the pool (set-preserving) and clears the wrap notice', () => {
  reset()
  const ids = ['t1', 't2', 't3', 't4', 't5', 't6']
  library.set(ids.map((id) => track(id)))
  shuffleEnabled.set(true)
  queueWrapNotice.set(true)

  queueManager.rebuildAutoQueue()

  const auto = get(queue).autoQueue
  assert.deepEqual([...auto].sort(), [...ids].sort(), 'shuffle keeps the same members')
  assert.equal(get(queueWrapNotice), false, 'shuffle clears the wrap hint')
})

test('the empty-fill notice fires when nothing can be added and clears on a successful fill', () => {
  reset()
  library.set(['t1', 't2', 't3', 't4'].map((id) => track(id)))
  metadataCache.set(metaOf([['t2', 80]]))
  setQueue({ userQueue: ['t1'], activeIndex: 0 })
  queueManager.replenishAutoQueue()
  assert.equal(get(autoQueueEmptyNotice), false, 'a successful fill keeps the notice off')

  // Tighten to minRating 80: t2 still matches (and is already queued), nothing
  // new can be added, nothing is dropped → the no-op guard fires the notice.
  autoQueueFilterFields.set({ ...FIELDS, minRating: 80 })
  queueManager.replenishAutoQueue()
  assert.equal(get(autoQueueEmptyNotice), true, 'nothing addable → notice')

  // Tighten further to 90: t2 no longer matches → kept drops, the queue is
  // pruned to empty, and the notice stays (the fill added nothing).
  autoQueueFilterFields.set({ ...FIELDS, minRating: 90 })
  queueManager.replenishAutoQueue()
  assert.equal(get(autoQueueEmptyNotice), true)
  assert.deepEqual(get(queue).autoQueue, [])

  // Loosen again: a successful fill clears the notice.
  autoQueueFilterFields.set({ ...FIELDS })
  queueManager.replenishAutoQueue()
  assert.equal(get(autoQueueEmptyNotice), false, 'a successful fill clears the notice')
  assert.deepEqual(get(queue).autoQueue, ['t2', 't3', 't4'])
})

test('searchQuery persists as a filter through the real manager', () => {
  reset()
  library.set([
    track('b1', { artist: 'The Beatles' }),
    track('s1', { artist: 'The Stones' }),
  ])
  autoQueueFilterFields.set({ ...FIELDS, searchQuery: 'beat' })

  queueManager.replenishAutoQueue()

  assert.deepEqual(get(queue).autoQueue, ['b1'])
})

// Pins the thin-glue half of the auto-queue fill: the REAL QueueManager
// applying the pure plan to the REAL stores (queue + saveQueue + wrapNotice).
// The pure decision is pinned by autoQueuePlan.test.ts; this suite closes the
// "decision vs application" gap for the interpreter — the two no-op guards
// must skip the Dexie write, and the written queue must equal kept+fill.

import './stub-audio-worklet-node'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { db } from '../src/lib/db'
import { queueManager } from '../src/lib/queueManager'
import { PlaybackManager } from '../src/lib/playbackManager'
import { engine } from '../src/lib/engineFacade'
import { libraryFilters } from '../src/lib/libraryFilters'
import {
  queue,
  library,
  shuffleEnabled,
  metadataCache,
  queueWrapNotice,
  autoQueueFilterFields,
  autoQueueSort,
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
  autoQueueSort.set({ sortBy: null, sortAsc: true })
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

/** Minimal engine surface the `_subscribeShared` reactions can touch under Node. */
class FakeEngine {
  setSpeed(): void {}
  setSnapTolerance(): void {}
  setPitchOctaves(): void {}
  setMasterVolume(): void {}
  setTapeMode(): void {}
  setCrossfade(): void {}
  setAudioMixing(): void {}
  setSeekEpochs(): void {}
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

  // Queue unchanged and nothing addable again (defaults restored) → the
  // second no-op guard fires again → NO write.
  const writes2 = playQueueWrites.length
  autoQueueFilterFields.set({ ...FIELDS })
  queueManager.replenishAutoQueue()
  assert.equal(playQueueWrites.length, writes2, 'an unchanged queue must not re-write')
  assert.equal(get(queue).autoQueue.length, 1)
})

test('a queue already full of matching tracks takes the first no-op guard (needed === 0)', () => {
  reset()
  library.set(Array.from({ length: 60 }, (_, i) => track(`t${i + 1}`)))
  setQueue({ autoQueue: Array.from({ length: 50 }, (_, i) => `t${i + 1}`), activeIndex: -1 })

  queueManager.replenishAutoQueue()

  assert.equal(playQueueWrites.length, 0, 'needed === 0 → no write')
  assert.equal(get(autoQueueEmptyNotice), false, 'a full queue is not an empty-fill')
  assert.equal(get(queue).autoQueue.length, 50)
})

test('a sort change rebuilds the whole auto queue in the auto-sort order (B7)', () => {
  reset()
  // Library order scrambled vs. rating order, so the B7 fix is observable.
  library.set(['c', 'e', 'a', 'f', 'b', 'd'].map((id) => track(id)))
  metadataCache.set(metaOf([['a', 10], ['b', 20], ['c', 30], ['d', 40], ['e', 50], ['f', 100]]))
  setQueue({ userQueue: ['f'], activeIndex: 0 })
  autoQueueSort.set({ sortBy: 'rating', sortAsc: true })

  queueManager.rebuildAutoQueue()

  // f is the PLAYING track (activeId) — the rotation tier excludes it, so the
  // rebuilt queue is the rating-sorted a..e. Nothing ranks after the anchor f,
  // so the rotation wrapped from the top (wrapNotice).
  assert.deepEqual(get(queue).autoQueue, ['a', 'b', 'c', 'd', 'e'], 'rating-sorted fill (active f excluded)')
  assert.equal(get(queueWrapNotice), true, 'nothing ranks after the anchor f → wrapped')
})

test('the auto queue follows its OWN sort, never the library sort (2026-09-29 decoupling)', () => {
  reset()
  library.set(['c', 'e', 'a', 'f', 'b', 'd'].map((id) => track(id)))
  metadataCache.set(metaOf([['a', 10], ['b', 20], ['c', 30], ['d', 40], ['e', 50], ['f', 100]]))
  setQueue({ userQueue: ['f'], activeIndex: 0 })
  // Library sort active; auto sort at its library-order default.
  libraryFilters.update((lf) => ({ ...lf, sortBy: 'rating', sortAsc: true }))

  queueManager.rebuildAutoQueue()

  // The fill stays in LIBRARY ORDER (c,e,a,b,d minus user-queued f) — the
  // library sort must NOT re-rank it — then rotates after the anchor f
  // (library position 3): b,d wrap ahead, c,e,a follow (the anchor rule).
  // Pre-decoupling, the active library sort would have re-ranked this a..f.
  assert.deepEqual(get(queue).autoQueue, ['b', 'd', 'c', 'e', 'a'], 'library-order fill (anchor-rotated) despite an active library sort')

  // The AUTO sort is what re-ranks.
  autoQueueSort.set({ sortBy: 'rating', sortAsc: true })
  queueManager.rebuildAutoQueue()
  assert.deepEqual(get(queue).autoQueue, ['a', 'b', 'c', 'd', 'e'], 'the auto sort re-ranks the fill')

  // An explicit sort FLIP still visibly re-ranks the head (the 2026-09-29
  // "flip does nothing" report stays fixed) — the head is the anchor's OTHER
  // neighbor, so the direction is visible without restarting from the top.
  autoQueueSort.set({ sortBy: 'rating', sortAsc: false })
  queueManager.rebuildAutoQueue()
  assert.deepEqual(get(queue).autoQueue, ['e', 'd', 'c', 'b', 'a'], 'rating-sorted DESC, continuing after the anchor f (excluded)')
  assert.equal(get(queueWrapNotice), false, 'the anchor sits at the DESC top — no wrap')
})

test('shuffle mode permutes the pool (set-preserving) and clears the wrap notice', () => {
  reset()
  const ids = ['t1', 't2', 't3', 't4', 't5', 't6']
  library.set(ids.map((id) => track(id)))
  // A shuffle toggle reorders the SAME rule set, so it is not a rule change
  // (D7): the anti-repeat window must survive it.
  setQueue({ recentTrackIds: ['t9'] })
  shuffleEnabled.set(true)
  queueWrapNotice.set(true)

  queueManager.rebuildAutoQueue()

  const auto = get(queue).autoQueue
  assert.deepEqual([...auto].sort(), [...ids].sort(), 'shuffle keeps the same members')
  assert.equal(get(queueWrapNotice), false, 'shuffle clears the wrap hint')
  assert.deepEqual(get(queue).recentTrackIds, ['t9'], 'the window survives a shuffle toggle')
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

test('a fully-tied library still shows the flip at the queue head (rotation preserves the arrow)', () => {
  // The reason `fromTop` once existed: on a library that ties on the sort key
  // (unrated → every rating 0) the old fixed tie-break made the direction a
  // no-op. The tie fix mirrors the arrow in `buildOrderRank`; the anchor
  // rotation must keep that visible at the HEAD — the property the removed
  // fromTop override used to provide redundantly.
  reset()
  library.set(['a', 'b', 'c', 'd', 'e'].map((id) => track(id))) // no ratings → all tie
  setQueue({ userQueue: ['c'], activeIndex: 0 }) // playing c

  autoQueueSort.set({ sortBy: 'rating', sortAsc: true })
  queueManager.rebuildAutoQueue()
  assert.deepEqual(get(queue).autoQueue, ['d', 'e', 'a', 'b'], 'ascending head is the anchor\'s up-neighbor')

  autoQueueSort.set({ sortBy: 'rating', sortAsc: false })
  queueManager.rebuildAutoQueue()
  assert.deepEqual(get(queue).autoQueue, ['b', 'a', 'e', 'd'], 'descending head is the anchor\'s down-neighbor — the flip is visible')
})

test('the autoQueueSort subscription continues the fill from the playing track (not the top)', async () => {
  // REPRODUCTION for the mission report: applying a new filter/sort to the
  // queue with shuffle off regenerated the auto queue from the TOP of the
  // sorted pool instead of from the current position. Driven through the REAL
  // entry point — the PlaybackManager `autoQueueSort` subscription — so a
  // regression in the wiring (not just the pure plan) is caught here.
  reset()
  library.set(['a', 'b', 'c', 'd', 'e'].map((id) => track(id)))
  metadataCache.set(metaOf([['a', 10], ['b', 20], ['c', 30], ['d', 40], ['e', 50]]))
  setQueue({ userQueue: ['c'], activeIndex: 0 }) // playing c, mid-list

  const m = new PlaybackManager({
    engine: new FakeEngine() as unknown as typeof engine,
    queueManager,
  })
  const priv = m as unknown as { _subscribeShared(): Array<() => void>; _initialized: boolean }
  priv._initialized = true
  const unsubs = priv._subscribeShared()
  try {
    autoQueueSort.set({ sortBy: 'rating', sortAsc: true })
    // A rule change lands on the next tick (D7 coalesces it with a filter edit
    // in the same task), so the rebuild is awaited rather than assumed sync.
    await new Promise((resolve) => setTimeout(resolve, 10))

    // The Songs view order is a,b,c,d,e and playback is at c — the regenerated
    // tail must continue d,e then wrap a,b, matching the view order after the
    // current track. Restarting at the top ("a,b,d,e") is the reported bug.
    assert.deepEqual(get(queue).autoQueue, ['d', 'e', 'a', 'b'])
  } finally {
    for (const u of unsubs) u()
  }
})

// --- rule changes WHILE PLAYING (D7, 2026-10-21f: G1/G2 CLOSED) -------------
// A filter or sort edit is a FRESH CONTEXT (D7), not a patch on the old tail:
// one write promotes the audible AUTO row, clears the anti-repeat window and
// rebuilds the pool with `keepAuto: false`. That is what closes G1/G2 — after
// the promotion the anchor names a USER row, so an auto rewrite can no longer
// move it. These replace the three "KNOWN GAP" pins this section used to hold
// ("…leaves the anchor on a different track", "…without re-anchoring the
// playing row", "…leaves activeIndex past the end"): a gap test is rewritten
// with the new rule, never deleted.

function playingAuto(): void {
  reset()
  library.set(['u', 'a', 'b', 'c'].map((id) => track(id)))
  metadataCache.set(metaOf([['u', 0], ['a', 80], ['b', 90], ['c', 95]]))
  setQueue({ userQueue: ['u'], autoQueue: ['a', 'b', 'c'], activeIndex: 1 }) // 'a' plays
}

function combined(): { ids: string[]; anchor: string | undefined } {
  const q = get(queue)
  const ids = [...q.userQueue, ...q.autoQueue]
  return { ids, anchor: ids[q.activeIndex] }
}

test('a filter edit PROMOTES the audible auto row first, so the anchor still names the song playing (D7 / G1 closed)', () => {
  playingAuto()
  const writesBefore = playQueueWrites.length

  // minRating 90 excludes 'a' (80) — the row that is audibly playing. Under the
  // old kept-prefix patch the row was pruned and the anchor stayed put, naming
  // 'b'; D7 promotes it into the user section before the rewrite.
  autoQueueFilterFields.set({ ...FIELDS, minRating: 90 })
  queueManager.rebuildForFreshContext()

  const q = get(queue)
  assert.deepEqual(q.userQueue, ['u', 'a'], 'the audible row is promoted to the user boundary')
  assert.equal(q.activeIndex, 1)
  assert.equal(combined().anchor, 'a', 'the anchor STILL names the audible song')
  assert.deepEqual(q.autoQueue, ['b', 'c'], 'the tail is rebuilt from the matching pool')
  assert.deepEqual(q.recentTrackIds, [], 'a fresh context clears the anti-repeat window (D7.2)')

  // D7 is ONE write: the promotion, the recents reset and the rebuild land
  // together, so the native snapshot can never see a half-rewritten queue.
  assert.equal(playQueueWrites.length, writesBefore + 1, 'one queue write')
  assert.deepEqual((lastWrite() as unknown as QueueState).userQueue, ['u', 'a'])
  assert.equal((lastWrite() as QueueState).activeIndex, 1)
})

test('a sort edit re-derives the order after the PROMOTED anchor (D7 / G2 closed)', () => {
  playingAuto()

  autoQueueSort.set({ sortBy: 'rating', sortAsc: false })
  queueManager.rebuildForFreshContext()

  const q = get(queue)
  assert.deepEqual(q.userQueue, ['u', 'a'])
  assert.equal(combined().anchor, 'a', 'the rebuild cannot move the anchor — it is a user row now')
  // Descending rating within each tier, in the fresh order. The rotation anchor
  // is the promoted row ('a', rank 2 of c,b,a,u), so nothing ranks after it →
  // the fill wraps from the top and the wrap hint is honest. Tier 3 then
  // re-admits the USER-queued 'u' (B4: a short pool recycles rather than
  // starving) as an independent auto occurrence — the active row 'a' is the
  // one id tier 3 excludes.
  assert.deepEqual(q.autoQueue, ['c', 'b', 'u'])
  assert.equal(get(queueWrapNotice), true, 'nothing ranks after the anchor → wrapped')
  assert.deepEqual(q.recentTrackIds, [])
})

test('a rule edit cannot leave the anchor past the end when the audible row was the LAST matching one', () => {
  reset()
  library.set(['u', 'a', 'b'].map((id) => track(id)))
  metadataCache.set(metaOf([['u', 0], ['a', 95], ['b', 50]]))
  setQueue({ userQueue: ['u'], autoQueue: ['a', 'b'], activeIndex: 2 }) // 'b' plays

  autoQueueFilterFields.set({ ...FIELDS, minRating: 90 })
  queueManager.rebuildForFreshContext()

  const q = get(queue)
  assert.deepEqual(q.userQueue, ['u', 'b'], 'the audible (non-matching) row survives as history')
  assert.deepEqual(q.autoQueue, ['a'])
  assert.equal(q.activeIndex, 1)
  assert.ok(q.activeIndex < combined().ids.length, 'the anchor is in range — never past the end')
  assert.equal(combined().anchor, 'b')
})

test('the filter subscription drives the FRESH CONTEXT through the real reaction layer (D7 wiring)', async () => {
  playingAuto()
  const m = new PlaybackManager({
    engine: new FakeEngine() as unknown as typeof engine,
    queueManager,
  })
  const priv = m as unknown as { _subscribeShared(): Array<() => void>; _initialized: boolean }
  priv._initialized = true
  const unsubs = priv._subscribeShared()
  try {
    // `_subscribeShared` replenishes on subscribe (that write is not the one
    // under test) — count from here.
    const writesBefore = playQueueWrites.length
    // Nothing matches at 96 (the played row rates 80): the whole tail empties,
    // which is exactly the shape that used to point the anchor past the end.
    autoQueueFilterFields.set({ ...FIELDS, minRating: 96 })
    await new Promise((resolve) => setTimeout(resolve, 300))

    const q = get(queue)
    assert.deepEqual(q.userQueue, ['u', 'a'], 'the audible auto row was promoted by the reaction')
    assert.deepEqual(q.autoQueue, [], 'the tail was rebuilt, not patched')
    assert.equal(combined().anchor, 'a', 'the anchor names the audible song')
    assert.deepEqual(q.recentTrackIds, [], 'the recency window was reset')
    assert.equal(get(autoQueueEmptyNotice), true, 'nothing matches → the empty notice is honest')
    assert.equal(playQueueWrites.length, writesBefore + 1, 'the debounced reaction is ONE write')
  } finally {
    for (const u of unsubs) u()
    m.destroy()
  }
})

test('a filter edit and a sort pick in ONE task collapse into a single fresh-context write (D7)', async () => {
  // The FilterSortBar apply writes BOTH stores synchronously. Without the
  // shared rule-change timer each write would rebuild (two fresh contexts, two
  // window resets); the contract is ONE queue write carrying BOTH new rules.
  reset()
  library.set(['a', 'b', 'c', 'd', 'e'].map((id) => track(id)))
  // Distinct ratings so the tail can only be in this order if the single write
  // carried the SORT as well as the filter.
  metadataCache.set(metaOf([['a', 10], ['b', 20], ['c', 30], ['d', 40], ['e', 50]]))
  setQueue({ userQueue: ['a'], activeIndex: 0 })

  const m = new PlaybackManager({
    engine: new FakeEngine() as unknown as typeof engine,
    queueManager,
  })
  const priv = m as unknown as { _subscribeShared(): Array<() => void>; _initialized: boolean }
  priv._initialized = true
  const unsubs = priv._subscribeShared()
  try {
    const writesBefore = playQueueWrites.length
    const userBefore = [...get(queue).userQueue]
    autoQueueFilterFields.set({ ...FIELDS, minRating: 10 })
    autoQueueSort.set({ sortBy: 'rating', sortAsc: false })
    await new Promise((resolve) => setTimeout(resolve, 300))

    assert.equal(playQueueWrites.length, writesBefore + 1, 'the apply is ONE queue write')
    const q = get(queue)
    assert.deepEqual(q.recentTrackIds, [], 'the apply is a fresh context, not a fill patch')
    // Descending rating, continued after the anchor 'a' (lowest rank → wrap).
    assert.deepEqual(q.autoQueue, ['e', 'd', 'c', 'b'], 'the one write carried BOTH new rules')
    assert.equal(get(queueWrapNotice), true)
    assert.deepEqual(q.userQueue, userBefore, 'the user section is untouched')
  } finally {
    for (const u of unsubs) u()
    m.destroy()
  }
})

test('a sort flip is a rule change even while shuffling (never skipped)', async () => {
  // Shuffle decides how a rebuilt pool is SAMPLED, not whether the rule
  // changed: the flip must still reset the window and re-derive the tail. The
  // old `if (get(shuffleEnabled)) return` early-out would make this a no-op.
  reset()
  library.set(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => track(id)))
  setQueue({ userQueue: ['a'], activeIndex: 0, recentTrackIds: ['b'] })
  shuffleEnabled.set(true)

  const m = new PlaybackManager({
    engine: new FakeEngine() as unknown as typeof engine,
    queueManager,
  })
  const priv = m as unknown as { _subscribeShared(): Array<() => void>; _initialized: boolean }
  priv._initialized = true
  const unsubs = priv._subscribeShared()
  try {
    const writesBefore = playQueueWrites.length
    autoQueueSort.set({ sortBy: 'rating', sortAsc: true })
    await new Promise((resolve) => setTimeout(resolve, 50))

    assert.equal(playQueueWrites.length, writesBefore + 1, 'the flip re-derived the tail')
    const q = get(queue)
    assert.deepEqual(q.recentTrackIds, [], 'a RULE CHANGE resets the window even under shuffle')
    // Shuffle permutes within tiers, so the membership is the assertion; the
    // cooled 'b' returns because the window was cleared.
    assert.deepEqual([...q.autoQueue].sort(), ['b', 'c', 'd', 'e', 'f'], 'the cleared window re-admits b')
  } finally {
    for (const u of unsubs) u()
    m.destroy()
  }
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

// --- ordered continuation through the real manager (2026-10-24) -------------
// The pure decision is pinned by autoQueuePlan.test.ts; these two drive the
// REAL entry points so a wiring regression (or a fill that stops reading the
// sort/filters once playback is running) fails here.

const AQ_LIB = (): Track[] => [
  track('aq1', { createdAt: Date.parse('2023-03-01T00:00:00Z') }),
  track('aq2', { createdAt: Date.parse('2023-01-01T00:00:00Z'), duration: 600 }),
  track('aq3', { createdAt: Date.parse('2023-06-01T00:00:00Z') }),
  track('aq4', { createdAt: Date.parse('2023-02-01T00:00:00Z') }),
  track('aq5', { createdAt: Date.parse('2023-05-01T00:00:00Z') }),
  track('aq6', { createdAt: Date.parse('2023-04-01T00:00:00Z') }),
]

test('a library press re-derives the auto tail from the pressed row (ordered fill)', () => {
  reset()
  library.set(AQ_LIB())
  autoQueueSort.set({ sortBy: 'added', sortAsc: false })
  // aq1 played: the Added ↓ continuation from it is aq4, aq2, aq3, aq5, aq6.
  setQueue({ userQueue: ['aq1'], autoQueue: ['aq4', 'aq2', 'aq3', 'aq5', 'aq6'], activeIndex: 0 })

  queueManager.selectTrack('aq5')
  queueManager.replenishAutoQueue()

  const q = get(queue)
  assert.deepEqual(q.userQueue, ['aq1', 'aq5'], 'the press appends and anchors its own row')
  assert.equal(q.activeIndex, 1)
  // Added ↓ = aq3, aq5, aq6, aq1, aq4, aq2 → from aq5: aq6, aq4, aq2, wrap aq3,
  // then the short pool recycles the user-queued aq1 (B4). The old kept-prefix
  // fill left the head at aq4 — the previous anchor's order.
  assert.deepEqual(q.autoQueue, ['aq6', 'aq4', 'aq2', 'aq3', 'aq1'])
})

test('a filter and sort applied mid-play keep holding as playback advances', () => {
  reset()
  library.set(AQ_LIB())
  setQueue({ userQueue: ['aq1'], activeIndex: 0 })
  // The maxLength filter excludes the long aq2 for the whole session; Added ↓
  // decides the order. A rule change is a fresh context (D7).
  autoQueueFilterFields.set({ ...FIELDS, maxLength: 300 })
  autoQueueSort.set({ sortBy: 'added', sortAsc: false })
  queueManager.rebuildForFreshContext()
  assert.deepEqual(get(queue).autoQueue, ['aq4', 'aq3', 'aq5', 'aq6'], 'Added ↓ after aq1, aq2 filtered out')

  // Play the first auto row the way a load does: advance, promote, replenish.
  queueManager.advanceTo(1, 'aq1')
  queueManager.promoteActiveTrack()
  queueManager.replenishAutoQueue()

  const q = get(queue)
  assert.deepEqual(q.userQueue, ['aq1', 'aq4'])
  // Both rules still hold after the advance: aq2 (excluded) never appears, and
  // the tail continues in Added ↓ after aq4 — aq3, aq5, aq6, then the wrap.
  assert.deepEqual(q.autoQueue, ['aq3', 'aq5', 'aq6', 'aq1'])
  assert.ok(!q.autoQueue.includes('aq2'), 'the filter holds across the advance')
})

test('a dragged auto order survives the next advance, and a rule change re-derives it', () => {
  reset()
  library.set(AQ_LIB())
  autoQueueSort.set({ sortBy: 'added', sortAsc: false })
  // Playing aq1: Added ↓ continues aq4, aq2, aq3, aq5, aq6.
  setQueue({ userQueue: ['aq1'], autoQueue: ['aq4', 'aq2', 'aq3', 'aq5', 'aq6'], activeIndex: 0 })

  // Drag aq6 (last) up to the second auto slot — a deliberate hand order.
  queueManager.applyDragDrop('auto:aq6', 2, ['aq1'], ['aq4', 'aq2', 'aq3', 'aq5', 'aq6'])
  assert.deepEqual(get(queue).autoQueue, ['aq4', 'aq6', 'aq2', 'aq3', 'aq5'], 'the drop reordered the tail')

  // Advancing plays aq4 and promotes it. The hand order must survive: only the
  // consumed head leaves, nothing is re-sorted underneath the user.
  queueManager.advanceTo(1, 'aq1')
  queueManager.promoteActiveTrack()
  queueManager.replenishAutoQueue()
  assert.deepEqual(get(queue).autoQueue.slice(0, 4), ['aq6', 'aq2', 'aq3', 'aq5'], 'the drag order survives the advance')
  // The derived order would have put aq2 first — that is what this rules out.
  assert.notDeepEqual(get(queue).autoQueue.slice(0, 2), ['aq2', 'aq3'])

  // A sort change is a rule change: the new ordering wins over the hand order.
  autoQueueSort.set({ sortBy: 'added', sortAsc: true })
  queueManager.rebuildForFreshContext()
  // Added ↑ after the promoted aq4: aq6, aq5, aq3, aq2 (aq1/aq4 are user rows;
  // the short pool then recycles them at the tail).
  assert.deepEqual(get(queue).autoQueue.slice(0, 4), ['aq6', 'aq5', 'aq3', 'aq2'], 'the sort wins after a rule change')
  assert.ok(!get(queue).autoQueue.includes('aq4') || get(queue).autoQueue.indexOf('aq4') > 3, 'nothing left of the drag head order')
})

test('a press ends the hand-ordered tail and re-derives it from the pressed row', () => {
  reset()
  library.set(AQ_LIB())
  autoQueueSort.set({ sortBy: 'added', sortAsc: false })
  setQueue({ userQueue: ['aq1'], autoQueue: ['aq4', 'aq2', 'aq3', 'aq5', 'aq6'], activeIndex: 0 })
  queueManager.applyDragDrop('auto:aq6', 2, ['aq1'], ['aq4', 'aq2', 'aq3', 'aq5', 'aq6'])
  assert.deepEqual(get(queue).autoQueue, ['aq4', 'aq6', 'aq2', 'aq3', 'aq5'], 'the drop hand-ordered the tail')

  // A press is an explicit "play this now": the hand order ends with it, so
  // the tail is the filter+sort continuation from the pressed row.
  queueManager.selectTrack('aq3')
  queueManager.replenishAutoQueue()

  const q = get(queue)
  assert.deepEqual(q.userQueue, ['aq1', 'aq3'], 'the press anchors its own row')
  // Added ↓ = aq3, aq5, aq6, aq1, aq4, aq2 → from aq3: aq5, aq6, aq4, aq2,
  // then the short pool recycles the user-queued aq1 (B4).
  assert.deepEqual(q.autoQueue, ['aq5', 'aq6', 'aq4', 'aq2', 'aq1'], 'the sorted continuation wins')
  assert.notDeepEqual(q.autoQueue.slice(0, 4), ['aq4', 'aq6', 'aq2', 'aq5'], 'the dragged order must not survive a press')
})

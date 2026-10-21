import './stub-audio-worklet-node'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { db } from '../src/lib/db'
import { PlaybackManager } from '../src/lib/playbackManager'
import { queueManager } from '../src/lib/queueManager'
import { applyQueueMutation, addToUserQueue, resolveQueueOccurrence, promoteActiveTrack } from '../src/lib/queueMutation'
import { planAutoQueueFill, selectAutoQueueFill, type AutoQueuePlanState } from '../src/lib/autoQueuePlan'
import { reconcileCrossfadeTarget } from '../src/lib/playbackCore/crossfadeReconcile'
import { NativeTransport, type NativeEngineClient, type NativeRefreshPayload, type NativeSnapshotTrack } from '../src/lib/playbackCore/nativeTransport'
import { queue, library, currentTrack, shuffleEnabled, autoQueueScope, autoQueueFilterFields, autoQueueSort, metadataCache, loopMode, type Track } from '../src/stores/appState'
import { setCachedConfig } from '../src/lib/navidromeApi'

Object.getPrototypeOf(db.playQueue).put = (async () => undefined) as never
const track = (trackId: string): Track => ({ trackId, title: trackId, artist: 'A', album: 'B', duration: 180, fileType: 'mp3' })
const filters = { minRating: 0, maxRating: 100, lovedOnly: false, fromYear: '' as const, toYear: '' as const, minLength: '' as const, maxLength: '' as const, searchQuery: '' }
function reset(ids: string[]): void {
  library.set(ids.map(track))
  metadataCache.set(new Map())
  autoQueueScope.set({})
  autoQueueFilterFields.set(filters)
  autoQueueSort.set({ sortBy: null, sortAsc: true })
  shuffleEnabled.set(true)
  loopMode.set('none')
  setCachedConfig({ baseUrl: 'https://srv.example', username: 'u', password: 'p' })
}
function nativeManager(): { _onNativeTrackChanged(id: string, entryId?: string): void } {
  return new PlaybackManager({ queueManager, isNative: () => true }) as unknown as { _onNativeTrackChanged(id: string, entryId?: string): void }
}
function state(over: Partial<AutoQueuePlanState> = {}): AutoQueuePlanState {
  return { library: [], userQueue: [], autoQueue: [], recentTrackIds: [], activeId: undefined, shuffle: true, sort: { sortBy: null, sortAsc: true }, filters, meta: new Map(), ...over }
}

test('occurrence resolver preserves selection, prefers forward auto, and supports wraps/missing rows', () => {
  const ids = ['repeat', 'prev', 'repeat', 'next']
  assert.equal(resolveQueueOccurrence(ids, 'repeat', 1), 2)
  assert.equal(resolveQueueOccurrence(ids, 'repeat', 0), 0, 'explicit history replay')
  assert.equal(resolveQueueOccurrence(ids, 'repeat', 2), 2, 'duplicate event is idempotent')
  assert.equal(resolveQueueOccurrence(ids, 'prev', 3), 1, 'wrap/re-adoption')
  assert.equal(resolveQueueOccurrence(ids, 'missing', 1), -1)
})

test('unrelated mutation preserves the active auto occurrence, not its history duplicate', () => {
  const q = { userQueue: ['repeat', 'prev'], autoQueue: ['repeat', 'next'], activeIndex: 2, recentTrackIds: [] }
  const updated = applyQueueMutation(q, (s) => addToUserQueue(s, 'manual'))!
  assert.equal(updated.activeIndex, 3)
  assert.equal([...updated.userQueue, ...updated.autoQueue][updated.activeIndex], 'repeat')
  assert.deepEqual(updated.autoQueue, q.autoQueue)
})

test('native field shape: row 104 never re-anchors to history row 50; duplicate events are harmless', () => {
  const user = Array.from({ length: 104 }, (_, i) => `history-${i}`)
  user[50] = 'repeat'
  const auto = ['repeat', ...Array.from({ length: 49 }, (_, i) => `upcoming-${i}`)]
  reset([...new Set([...user, ...auto])])
  queue.set({ userQueue: user, autoQueue: auto, activeIndex: 103, recentTrackIds: [] })
  currentTrack.set(track(user[103]))
  const manager = nativeManager()
  manager._onNativeTrackChanged('repeat')
  const q = get(queue)
  // D5 append: the played auto occurrence lands at the user TAIL (index 104),
  // never on the history row at 50 — and the history row survives.
  assert.equal(q.activeIndex, 104)
  assert.equal(q.userQueue[104], 'repeat')
  assert.equal(q.userQueue[50], 'repeat', 'the history occurrence is untouched')
  assert.equal(q.autoQueue[0], 'upcoming-0')
  assert.equal(q.userQueue.length, 105)
  assert.equal(q.userQueue.filter(id => id === 'repeat').length, 2)
  assert.equal(get(currentTrack)?.trackId, 'repeat')
  manager._onNativeTrackChanged('repeat')
  assert.deepEqual(get(queue), q)
  manager._onNativeTrackChanged('upcoming-0')
  assert.equal(get(queue).activeIndex, 105)
  assert.equal(get(queue).userQueue.at(-1), 'upcoming-0')
  assert.equal(get(queue).autoQueue[0], 'upcoming-1')
})

test('native explicit history replay and Previous keep their selected occurrence and auto tail', () => {
  reset(['repeat', 'prev', 'next'])
  const initial = { userQueue: ['repeat', 'prev'], autoQueue: ['repeat', 'next'], activeIndex: 0, recentTrackIds: [] }
  queue.set(initial)
  currentTrack.set(track('repeat'))
  nativeManager()._onNativeTrackChanged('repeat')
  assert.equal(get(queue).activeIndex, 0)
  assert.deepEqual(get(queue).autoQueue.slice(0, 2), initial.autoQueue)
})

test('native lock-screen Previous occurrence wins over an upcoming duplicate', () => {
  reset(['repeat', 'prev', 'next'])
  queue.set({ userQueue: ['repeat', 'prev'], autoQueue: ['repeat', 'next'], activeIndex: 1, recentTrackIds: [] })
  currentTrack.set(track('prev'))
  nativeManager()._onNativeTrackChanged('repeat', 'user:repeat')
  assert.equal(get(queue).activeIndex, 0)
  assert.deepEqual(get(queue).userQueue, ['repeat', 'prev'])
  assert.deepEqual(get(queue).autoQueue.slice(0, 2), ['repeat', 'next'])
})

test('web crossfade reconciliation retains the chosen auto occurrence before promotion', () => {
  const user = ['repeat', 'prev']
  const auto = ['repeat', 'next']
  assert.deepEqual(reconcileCrossfadeTarget({ targetId: 'repeat', combined: [...user, ...auto], userQueue: user, activeIndex: 2, advanced: true, loopMode: 'none' }), { kind: 'none' })
  const promoted = applyQueueMutation({ userQueue: user, autoQueue: auto, activeIndex: 2, recentTrackIds: [] }, promoteActiveTrack)!
  assert.deepEqual(promoted.userQueue, ['repeat', 'prev', 'repeat'], 'append — the history copy stays at 0')
  assert.equal(promoted.activeIndex, 2)
  assert.deepEqual(promoted.autoQueue, ['next'])
})

test('initial native engage syncs a promotion made by an early bridge event even when later promotion is a no-op', async () => {
  reset(['repeat', 'prev', 'next'])
  queue.set({ userQueue: ['repeat', 'prev'], autoQueue: ['repeat', 'next'], activeIndex: 2, recentTrackIds: [] })
  currentTrack.set(track('prev'))
  const refreshes: NativeRefreshPayload[] = []
  let manager!: { _initialized: boolean; _nativeLoadPlay(t: Track): Promise<void>; _onNativeTrackChanged(id: string, entryId?: string): void }
  const client = {
    plugin: () => ({
      setQueueAndPlay: async ({ tracks, activeIndex }: { tracks: NativeSnapshotTrack[]; activeIndex: number }) => {
        const active = tracks[activeIndex]
        manager._onNativeTrackChanged(active.trackId, active.queueEntryId)
      },
      refreshQueue: async (payload: NativeRefreshPayload) => { refreshes.push(payload) },
    }),
    setPositionPolling: () => {},
  } as unknown as NativeEngineClient
  const transport = new NativeTransport(client)
  manager = new PlaybackManager({ queueManager, nativeTransport: transport, isNative: () => true,
    sleepTimerManager: { rearmAfterSnapshot: async () => {} } as never,
  }) as unknown as typeof manager
  manager._initialized = true
  const load = manager._nativeLoadPlay(track('repeat'))
  await load
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(refreshes.length, 1, 'settled engage must not retain the unpromoted native snapshot')
  // The audible auto occurrence was appended at the user tail: the history
  // copy stays at 0 and the new occurrence is its own entry id.
  assert.equal(refreshes[0].activeIndex, 2)
  assert.equal(refreshes[0].tracks[2].queueEntryId, 'user:repeat#1')
  assert.equal(refreshes[0].tracks[0].queueEntryId, 'user:repeat')
  assert.equal(refreshes[0].tracks[3].trackId, 'next')
  transport.disengage()
})

test('one vacancy plus one fresh candidate never admits cooldown/recycled candidates', () => {
  const ids = Array.from({ length: 100 }, (_, i) => `t-${i}`)
  const plan = planAutoQueueFill(state({ library: ids.map(track), userQueue: ids.slice(0, 50), autoQueue: ids.slice(50, 99), activeId: 't-49' }), 50, { keepAuto: true })
  assert.equal(plan.kept.length, 49)
  assert.deepEqual(plan.tiers, { 1: ['t-99'], 2: [], 3: [] })
  assert.deepEqual(selectAutoQueueFill(plan, 1).map(t => t.trackId), ['t-99'])
})

test('shuffle samples entire tiers without mixing priority or mutating the plan', () => {
  const s = state({ library: ['old', 'active', 'cool', 'fresh1', 'fresh2'].map(track), userQueue: ['old', 'active'], recentTrackIds: ['cool'], activeId: 'active' })
  const plan = planAutoQueueFill(s, 50, { keepAuto: false })
  const before = JSON.stringify(plan)
  for (const random of [() => 0, () => 0.999999]) {
    const chosen = selectAutoQueueFill(plan, 4, random).map(t => t.trackId)
    assert.deepEqual(new Set(chosen.slice(0, 2)), new Set(['fresh1', 'fresh2']))
    assert.deepEqual(chosen.slice(2), ['cool', 'old'])
  }
  assert.equal(JSON.stringify(plan), before)
  const sorted = planAutoQueueFill({ ...s, shuffle: false }, 50, { keepAuto: false })
  assert.deepEqual(sorted.pool.map(t => t.trackId), ['fresh1', 'fresh2', 'cool', 'old'])
})

test('real native manager: hands-off shuffle hears the whole eligible library before repeating, then recycles at the boundary', () => {
  for (const size of [2, 7, 49, 50, 51, 105, 160]) {
    const ids = Array.from({ length: size }, (_, i) => `session-${size}-${i}`)
    reset(ids)
    queue.set({ userQueue: [ids[0]], autoQueue: [], activeIndex: 0, recentTrackIds: [] })
    currentTrack.set(track(ids[0]))
    queueManager.replenishAutoQueue()
    const manager = nativeManager()
    const heard = new Set([ids[0]])
    for (let step = 0; step < size * 3; step++) {
      const before = get(queue)
      const id = before.autoQueue[0]
      assert.ok(id, `small/exhausted library must still recycle (size ${size})`)
      if (heard.size < size) assert.ok(!heard.has(id), `premature repeat ${id} at ${step}`)
      heard.add(id)
      const next = before.autoQueue[1]
      manager._onNativeTrackChanged(id)
      const after = get(queue)
      assert.equal(after.activeIndex, after.userQueue.length - 1)
      assert.equal(after.userQueue[after.activeIndex], id)
      assert.equal(get(currentTrack)?.trackId, id)
      // D5: the user section is a listening LOG — repeats are the point, so its
      // only invariant is that it grew by exactly one row per played track.
      assert.equal(after.userQueue.length, before.userQueue.length + 1)
      assert.equal(new Set(after.autoQueue).size, after.autoQueue.length)
      assert.ok(after.autoQueue.length <= 50)
      if (next) assert.equal(after.autoQueue[0], next)
    }
    assert.equal(heard.size, size)
  }
})

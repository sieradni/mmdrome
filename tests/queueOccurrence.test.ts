// The occurrence-identity core (queue redesign step 1). Every queue surface —
// Svelte keys, removal, drag, the anchor, the native entry id — speaks these
// helpers, so this suite is the identity contract the rest of the queue
// assumes: one row = (section, trackId, ordinal), duplicates are distinct
// rows, and no helper ever carries a combined POSITION in a key.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clampStoredActiveIndex,
  combinedEntryIds,
  entryIdAt,
  entryIdOf,
  findEntryIndex,
  findOccurrenceIndex,
  indexOfOccurrence,
  occurrenceAt,
  occurrenceCounts,
  parseEntryId,
  rowKeyOf,
  sectionEntryIds,
  sectionOccurrences,
} from '../src/lib/queueOccurrence'

test('sectionOccurrences assigns per-id ordinals in order', () => {
  assert.deepEqual(sectionOccurrences(['a', 'b', 'a', 'a'], 'user'), [
    { section: 'user', trackId: 'a', ordinal: 0 },
    { section: 'user', trackId: 'b', ordinal: 0 },
    { section: 'user', trackId: 'a', ordinal: 1 },
    { section: 'user', trackId: 'a', ordinal: 2 },
  ])
})

test('entry ids stay in the legacy bare shape for the first copy and suffix later ones', () => {
  assert.deepEqual(sectionEntryIds(['a', 'b', 'a'], 'user'), ['user:a', 'user:b', 'user:a#1'])
  assert.deepEqual(sectionEntryIds(['x', 'x'], 'auto'), ['auto:x', 'auto:x#1'])
  assert.deepEqual(combinedEntryIds(['a'], ['a', 'a']), ['user:a', 'auto:a', 'auto:a#1'])
  assert.equal(entryIdOf('auto', 'z', 0), 'auto:z')
  assert.equal(entryIdOf('user', 'z', 3), 'user:z#3')
})

test('row keys are occurrence-scoped and never contain the row position', () => {
  assert.equal(rowKeyOf('user', 'a', 0), 'u-a#0')
  assert.equal(rowKeyOf('user', 'a', 1), 'u-a#1')
  assert.equal(rowKeyOf('auto', 'a', 1), 'a-a#1')
  // A row's key depends only on its id + ordinal: shifting the section (an
  // advance, an insert above) cannot churn the key.
  const before = sectionOccurrences(['a', 'b'], 'user').map((o) => rowKeyOf('user', o.trackId, o.ordinal))
  const after = sectionOccurrences(['n', 'a', 'b'], 'user').map((o) => rowKeyOf('user', o.trackId, o.ordinal))
  assert.deepEqual(after.slice(1), before)
})

test('parseEntryId round-trips entry ids, including ids containing #digits', () => {
  assert.deepEqual(parseEntryId('user:a'), { section: 'user', trackId: 'a', ordinal: 0 })
  assert.deepEqual(parseEntryId('auto:x#2'), { section: 'auto', trackId: 'x', ordinal: 2 })
  assert.equal(parseEntryId('playlist:a'), null)
  assert.equal(parseEntryId('a'), null)
  // Round-trip for an id that itself ends in #digits.
  const entry = entryIdOf('user', 'x#2', 0)
  const parsed = parseEntryId(entry)
  assert.equal(parsed?.section, 'user')
  assert.equal(entryIdOf(parsed!.section, parsed!.trackId, parsed!.ordinal), entry)
})

test('findEntryIndex resolves the EXACT occurrence, never a same-id neighbour', () => {
  const user = ['a', 'b', 'a']
  const auto = ['a', 'x']
  assert.equal(findEntryIndex(user, auto, 'user:a'), 0)
  assert.equal(findEntryIndex(user, auto, 'user:a#1'), 2)
  assert.equal(findEntryIndex(user, auto, 'auto:a'), 3)
  assert.equal(findEntryIndex(user, auto, 'auto:a#1'), -1, 'only one auto copy exists')
  assert.equal(findEntryIndex(user, auto, 'user:b#1'), -1)
  assert.equal(findEntryIndex(user, auto, 'auto:zzz'), -1)
})

test('findOccurrenceIndex is section-aware and identity-exact', () => {
  const user = ['a', 'b']
  const auto = ['a', 'a']
  assert.equal(findOccurrenceIndex(user, auto, { section: 'user', trackId: 'a', ordinal: 0 }), 0)
  assert.equal(findOccurrenceIndex(user, auto, { section: 'auto', trackId: 'a', ordinal: 0 }), 2)
  assert.equal(findOccurrenceIndex(user, auto, { section: 'auto', trackId: 'a', ordinal: 1 }), 3)
  assert.equal(findOccurrenceIndex(user, auto, { section: 'auto', trackId: 'a', ordinal: 2 }), -1)
})

test('occurrenceAt / entryIdAt name the copy at a combined index', () => {
  const user = ['a', 'a']
  const auto = ['a', 'b']
  assert.deepEqual(occurrenceAt(user, auto, 0), { section: 'user', trackId: 'a', ordinal: 0 })
  assert.deepEqual(occurrenceAt(user, auto, 1), { section: 'user', trackId: 'a', ordinal: 1 })
  assert.deepEqual(occurrenceAt(user, auto, 2), { section: 'auto', trackId: 'a', ordinal: 0 })
  assert.deepEqual(occurrenceAt(user, auto, 3), { section: 'auto', trackId: 'b', ordinal: 0 })
  assert.equal(occurrenceAt(user, auto, 4), null)
  assert.equal(occurrenceAt(user, auto, -1), null)
  assert.equal(entryIdAt(user, auto, 1), 'user:a#1')
  assert.equal(entryIdAt(user, auto, 2), 'auto:a')
})

test('occurrenceCounts is the drag-reconcile budget (per id, per section)', () => {
  assert.deepEqual([...occurrenceCounts(['a', 'a', 'b'])], [['a', 2], ['b', 1]])
  assert.equal(occurrenceCounts([]).size, 0)
})

test('indexOfOccurrence and clampStoredActiveIndex are bounds-safe', () => {
  assert.equal(indexOfOccurrence(['x', 'a', 'a'], 'a', 1), 2)
  assert.equal(indexOfOccurrence(['x', 'a'], 'a', 1), -1)
  assert.equal(clampStoredActiveIndex(4, 7), 4)
  assert.equal(clampStoredActiveIndex(7, 7), -1)
  assert.equal(clampStoredActiveIndex(-1, 7), -1)
  assert.equal(clampStoredActiveIndex(Number.NaN, 7), -1)
  assert.equal(clampStoredActiveIndex(1.5, 7), -1)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { db } from '../src/lib/db'
import { initStores, filterPresets } from '../src/stores/appState'
import {
  PRESET_MAX_COUNT,
  PRESET_NAME_MAX,
  applyPreset,
  applyPresetById,
  decodeFilterPresets,
  filtersFromState,
  planSavePreset,
  presetIsActive,
  removePreset,
  type FilterPreset,
} from '../src/lib/filterPresets'
import type { LibraryFilterState } from '../src/lib/libraryFilters'

// Phase 3A — saved filter/sort presets. The core owns naming, replace-in-place,
// the cap, the active check, apply semantics and the persistence trust
// boundary, so all of it is table-tested here; the view only calls these.

function state(over: Partial<LibraryFilterState> = {}): LibraryFilterState {
  return {
    filterOpen: false,
    sortOpen: false,
    minRating: 0,
    maxRating: 100,
    lovedOnly: false,
    genre: '',
    fromYear: '',
    toYear: '',
    minLength: '',
    maxLength: '',
    sortBy: null,
    sortAsc: true,
    ...over,
  }
}

function preset(over: Partial<FilterPreset> = {}): FilterPreset {
  return {
    id: 'p1',
    name: 'Late night',
    filters: filtersFromState(state({ minRating: 80, lovedOnly: true })),
    sortBy: 'rating',
    sortAsc: false,
    ...over,
  }
}

test('filtersFromState snapshots the filter fields only — never the popup flags', () => {
  const snap = filtersFromState(state({ filterOpen: true, sortOpen: true, genre: 'Jazz', fromYear: 1999 }))
  assert.equal('filterOpen' in snap, false)
  assert.equal('sortOpen' in snap, false)
  assert.deepEqual(snap, {
    minRating: 0,
    maxRating: 100,
    lovedOnly: false,
    genre: 'Jazz',
    fromYear: 1999,
    toYear: '',
    minLength: '',
    maxLength: '',
  })
})

test('planSavePreset normalizes whitespace and trims the name', () => {
  const r = planSavePreset([], '   Late   night   high  ', state({ minRating: 50 }), 'new-1')
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.presets.length, 1)
  assert.equal(r.presets[0].id, 'new-1')
  assert.equal(r.presets[0].name, 'Late night high')
  assert.equal(r.presets[0].filters.minRating, 50)
})

test('planSavePreset refuses an empty or whitespace-only name', () => {
  for (const name of ['', '   ', '\t\n']) {
    const r = planSavePreset([], name, state(), 'x')
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.reason, 'empty-name')
  }
})

test('planSavePreset truncates an over-long name instead of rejecting it', () => {
  const r = planSavePreset([], 'x'.repeat(PRESET_NAME_MAX + 25), state(), 'x')
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.presets[0].name.length, PRESET_NAME_MAX)
})

test('planSavePreset REPLACES an existing name in place, keeping its id, position and count', () => {
  const old = [preset({ id: 'a', name: 'Focus' }), preset({ id: 'b', name: 'Big room' })]
  const r = planSavePreset(old, '  focus ', state({ maxLength: 180, sortBy: 'length', sortAsc: true }), 'ignored')
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.presets.length, 2, 'a replace never grows the list')
  assert.equal(r.presets[0].id, 'a')
  assert.equal(r.presets[0].name, 'Focus')
  assert.equal(r.presets[0].filters.maxLength, 180)
  assert.equal(r.presets[0].sortBy, 'length')
  assert.equal(r.presets[1].id, 'b')
})

test('planSavePreset caps a library at PRESET_MAX_COUNT new presets, but still allows a replace', () => {
  const full: FilterPreset[] = Array.from({ length: PRESET_MAX_COUNT }, (_, i) =>
    preset({ id: `p${i}`, name: `view ${i}` }))
  const refused = planSavePreset(full, 'one more', state(), 'n')
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.equal(refused.reason, 'limit')

  const replaced = planSavePreset(full, 'VIEW 3', state({ genre: 'Ambient' }), 'n')
  assert.equal(replaced.ok, true)
  if (replaced.ok) {
    assert.equal(replaced.presets.length, PRESET_MAX_COUNT)
    assert.equal(replaced.presets[3].filters.genre, 'Ambient')
  }
})

test('planSavePreset never mutates the array it was given', () => {
  const old = [preset({ id: 'a' })]
  const before = JSON.stringify(old)
  planSavePreset(old, 'other', state({ minRating: 30 }), 'b')
  planSavePreset(old, 'late night', state({ minRating: 30 }), 'b')
  assert.equal(JSON.stringify(old), before)
})

test('applyPreset writes the filters and sort and CLOSES both popups', () => {
  const applied = applyPreset(
    state({ filterOpen: true, sortOpen: true, genre: 'Rock' }),
    preset({
      filters: filtersFromState(state({ minRating: 70, lovedOnly: true, toYear: 2010, genre: 'Soul' })),
      sortBy: 'year',
      sortAsc: false,
    }),
  )
  assert.equal(applied.filterOpen, false)
  assert.equal(applied.sortOpen, false)
  assert.equal(applied.minRating, 70)
  assert.equal(applied.lovedOnly, true)
  assert.equal(applied.toYear, 2010)
  // The preset owns every FILTER field, so its saved genre replaces the live one.
  assert.equal(applied.genre, 'Soul')
  assert.equal(applied.sortBy, 'year')
  assert.equal(applied.sortAsc, false)
})

test('applyPreset clears a sort the preset did not save', () => {
  const applied = applyPreset(state({ sortBy: 'added', sortAsc: false }), preset({ sortBy: null, sortAsc: true }))
  assert.equal(applied.sortBy, null)
  assert.equal(applied.sortAsc, true)
})

test('applyPresetById resolves the id once for both surfaces and ignores a stale chip', () => {
  const list = [preset({ id: 'a', name: 'A', sortBy: 'year', sortAsc: true })]
  assert.equal(applyPresetById(state(), list, 'a')?.sortBy, 'year')
  assert.equal(applyPresetById(state(), list, 'gone'), null, 'a removed view must not write anything')
})

test('presetIsActive matches the exact saved combination only', () => {
  const p = preset({
    filters: filtersFromState(state({ minRating: 80, lovedOnly: true })),
    sortBy: 'rating',
    sortAsc: false,
  })
  assert.equal(presetIsActive(p, state({ minRating: 80, lovedOnly: true, sortBy: 'rating', sortAsc: false })), true)
  // Open popups are not part of the comparison.
  assert.equal(
    presetIsActive(p, state({ minRating: 80, lovedOnly: true, sortBy: 'rating', sortAsc: false, filterOpen: true })),
    true,
  )
  assert.equal(presetIsActive(p, state({ minRating: 70, lovedOnly: true, sortBy: 'rating', sortAsc: false })), false)
  assert.equal(presetIsActive(p, state({ minRating: 80, lovedOnly: true, sortBy: 'rating', sortAsc: true })), false)
  assert.equal(presetIsActive(p, state({ minRating: 80, lovedOnly: false, sortBy: 'rating', sortAsc: false })), false)
})

test('removePreset drops one id and leaves the rest in order; unknown ids are a no-op', () => {
  const list = [preset({ id: 'a', name: 'A' }), preset({ id: 'b', name: 'B' }), preset({ id: 'c', name: 'C' })]
  assert.deepEqual(removePreset(list, 'b').map((p) => p.id), ['a', 'c'])
  assert.deepEqual(removePreset(list, 'nope').map((p) => p.id), ['a', 'b', 'c'])
})

test('decodeFilterPresets returns [] for missing, non-array and garbage values', () => {
  for (const raw of [undefined, null, 'nope', 42, {}, []]) {
    assert.deepEqual(decodeFilterPresets(raw), [])
  }
})

test('decodeFilterPresets drops malformed rows and keeps valid ones', () => {
  const out = decodeFilterPresets([
    null,
    'string',
    { id: '', name: 'nameless id' },
    { id: 'ok', name: '   ' },
    { id: 'keep', name: '  Keep  me ', filters: { minRating: 40 }, sortBy: 'length', sortAsc: false },
  ])
  assert.equal(out.length, 1)
  assert.deepEqual(out[0], {
    id: 'keep',
    name: 'Keep me',
    filters: {
      minRating: 40,
      maxRating: 100,
      lovedOnly: false,
      genre: '',
      fromYear: '',
      toYear: '',
      minLength: '',
      maxLength: '',
    },
    sortBy: 'length',
    sortAsc: false,
  })
})

test('decodeFilterPresets coerces out-of-range and mistyped filter values', () => {
  const out = decodeFilterPresets([
    {
      id: 'x',
      name: 'Wild',
      filters: {
        minRating: 400,
        maxRating: -20,
        lovedOnly: 'yes',
        genre: 7,
        fromYear: -5,
        toYear: 2001,
        minLength: NaN,
        maxLength: '120',
      },
      sortBy: 'tempo',
      sortAsc: 'no',
    },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].filters.minRating, 100)
  assert.equal(out[0].filters.maxRating, 0)
  assert.equal(out[0].filters.lovedOnly, false)
  assert.equal(out[0].filters.genre, '')
  assert.equal(out[0].filters.fromYear, '')
  assert.equal(out[0].filters.toYear, 2001)
  assert.equal(out[0].filters.minLength, '')
  assert.equal(out[0].filters.maxLength, '')
  // An unknown sort key degrades to "no sort" rather than throwing.
  assert.equal(out[0].sortBy, null)
  // sortAsc defaults to true unless explicitly false.
  assert.equal(out[0].sortAsc, true)
})

test('decodeFilterPresets keeps the first of a duplicated name and caps the list', () => {
  const dupes = decodeFilterPresets([
    { id: 'one', name: 'Focus' },
    { id: 'two', name: ' focus ' },
  ])
  assert.deepEqual(dupes.map((p) => p.id), ['one'])

  const many = decodeFilterPresets(
    Array.from({ length: PRESET_MAX_COUNT + 5 }, (_, i) => ({ id: `p${i}`, name: `view ${i}` })),
  )
  assert.equal(many.length, PRESET_MAX_COUNT)
})

test('a decoded row round-trips through planSavePreset and applyPreset', () => {
  const saved = decodeFilterPresets([
    { id: 'r1', name: 'Warm', filters: { minRating: 60, lovedOnly: true, genre: 'Soul' }, sortBy: 'rating', sortAsc: false },
  ])
  const applied = applyPreset(state(), saved[0])
  assert.equal(applied.minRating, 60)
  assert.equal(applied.genre, 'Soul')
  assert.equal(applied.sortBy, 'rating')
  assert.equal(presetIsActive(saved[0], applied), true)
})

// ── persisted store wiring ──────────────────────────────────────────────
// The rules above are the decision layer. This pins the one thing they cannot
// see: the boot restore reads the saved row THROUGH decodeFilterPresets, so a
// malformed or duplicate entry never becomes a chip. Same fake-Dexie harness as
// tests/autoQueueFiltersPersistence.test.ts — and, because `initStores` is
// once-per-process, it runs last in this file.
const rows = new Map<string, unknown>()
Object.getPrototypeOf(db.userSettings).get = (async function (this: { name: string }, key: string) {
  if (this.name === 'playQueue') return undefined
  const value = rows.get(key)
  return value === undefined ? undefined : { key, value }
}) as never
Object.getPrototypeOf(db.userSettings).put = (async (entry: { key: string; value: unknown }) => {
  rows.set(entry.key, entry.value)
}) as never
Object.getPrototypeOf(db.localMetadata).toArray = (async () => []) as never

test('initStores restores saved views through decodeFilterPresets and drops a malformed row', async () => {
  rows.set('filterPresets', [
    { id: 'saved', name: '  Late  night ', filters: { minRating: 80, lovedOnly: true }, sortBy: 'rating', sortAsc: false },
    { id: '', name: 'no id' },
    { id: 'dup', name: 'late night' },
  ])
  await initStores()
  const restored = get(filterPresets)
  assert.deepEqual(restored.map((p) => p.id), ['saved'], 'invalid and duplicate rows never become chips')
  assert.equal(restored[0].name, 'Late night', 'the name is normalized on the way in')
  assert.equal(restored[0].filters.minRating, 80)
  assert.equal(restored[0].sortBy, 'rating')
})

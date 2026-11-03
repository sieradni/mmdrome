import { test } from 'node:test'
import { sortOf, sortSignature } from '../src/lib/sortCore'
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
import {
  emptyFilterRuleSet,
  type RangeFilterClause,
  type RangeFilterField,
  type TextFilterClause,
  type TextFilterField,
} from '../src/lib/filterCore'
import type { LibraryFilterState } from '../src/lib/libraryFilters'

// Phase 3A — saved filter/sort presets. The core owns naming, replace-in-place,
// the cap, the active check, apply semantics and the persistence trust
// boundary, so all of it is table-tested here; the view only calls these.
// 2026-11-03: a preset stores the shared filter RULE SET (rating + loved +
// elemental clauses), and a legacy saved row migrates through the same decoder.

function textClause(field: TextFilterField, query: string): TextFilterClause {
  return { id: `c-${field}`, kind: 'text', field, query }
}

function rangeClause(field: RangeFilterField, min: number | null, max: number | null): RangeFilterClause {
  return { id: `c-${field}`, kind: 'range', field, min, max }
}

function state(over: Partial<LibraryFilterState> = {}): LibraryFilterState {
  return {
    filterOpen: false,
    sortOpen: false,
    ...emptyFilterRuleSet(),
    sort: sortOf(null, true),
    ...over,
  }
}

function preset(over: Partial<FilterPreset> = {}): FilterPreset {
  return {
    id: 'p1',
    name: 'Late night',
    filters: filtersFromState(state({ minRating: 80, lovedOnly: true })),
    sort: sortOf('rating', false),
    ...over,
  }
}

function clauseFields(p: FilterPreset): string[] {
  return p.filters.clauses.map((c) => c.field)
}

test('filtersFromState snapshots the rule set only — never the popup flags', () => {
  const snap = filtersFromState(state({ filterOpen: true, sortOpen: true, clauses: [textClause('genre', 'Jazz')] }))
  assert.equal('filterOpen' in snap, false)
  assert.equal('sortOpen' in snap, false)
  assert.deepEqual(snap, {
    minRating: 0,
    maxRating: 100,
    lovedOnly: false,
    clauses: [textClause('genre', 'Jazz')],
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
  const r = planSavePreset(
    old,
    '  focus ',
    state({ clauses: [rangeClause('length', null, 180)], sort: sortOf('length', true) }),
    'ignored',
  )
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.presets.length, 2, 'a replace never grows the list')
  assert.equal(r.presets[0].id, 'a')
  assert.equal(r.presets[0].name, 'Focus')
  assert.deepEqual(r.presets[0].filters.clauses, [rangeClause('length', null, 180)])
  assert.equal(sortSignature(r.presets[0].sort), 'length+')
  assert.equal(r.presets[1].id, 'b')
})

test('planSavePreset caps a library at PRESET_MAX_COUNT new presets, but still allows a replace', () => {
  const full: FilterPreset[] = Array.from({ length: PRESET_MAX_COUNT }, (_, i) =>
    preset({ id: `p${i}`, name: `view ${i}` }))
  const refused = planSavePreset(full, 'one more', state(), 'n')
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.equal(refused.reason, 'limit')

  const replaced = planSavePreset(full, 'VIEW 3', state({ clauses: [textClause('genre', 'Ambient')] }), 'n')
  assert.equal(replaced.ok, true)
  if (replaced.ok) {
    assert.equal(replaced.presets.length, PRESET_MAX_COUNT)
    assert.deepEqual(replaced.presets[3].filters.clauses, [textClause('genre', 'Ambient')])
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
    state({ filterOpen: true, sortOpen: true, clauses: [textClause('genre', 'Rock')] }),
    preset({
      filters: filtersFromState(state({
        minRating: 70,
        lovedOnly: true,
        clauses: [rangeClause('year', null, 2010), textClause('genre', 'Soul')],
      })),
      sort: sortOf('year', false),
    }),
  )
  assert.equal(applied.filterOpen, false)
  assert.equal(applied.sortOpen, false)
  assert.equal(applied.minRating, 70)
  assert.equal(applied.lovedOnly, true)
  // The preset owns every FILTER field, so its saved clauses replace the live one.
  assert.deepEqual(applied.clauses, [rangeClause('year', null, 2010), textClause('genre', 'Soul')])
  assert.equal(sortSignature(applied.sort), 'year-')
})

test('applyPreset clears a sort the preset did not save', () => {
  const applied = applyPreset(state({ sort: sortOf('added', false) }), preset({ sort: sortOf(null, true) }))
  assert.equal(sortSignature(applied.sort), '')
})

test('applyPresetById resolves the id once for both surfaces and ignores a stale chip', () => {
  const list = [preset({ id: 'a', name: 'A', sort: sortOf('year', true) })]
  const appliedA = applyPresetById(state(), list, 'a')
  assert.equal(appliedA && sortSignature(appliedA.sort), 'year+')
  assert.equal(applyPresetById(state(), list, 'gone'), null, 'a removed view must not write anything')
})

test('presetIsActive matches the exact saved combination only', () => {
  const p = preset({
    filters: filtersFromState(state({ minRating: 80, lovedOnly: true, clauses: [textClause('genre', 'Jazz')] })),
    sort: sortOf('rating', false),
  })
  assert.equal(
    presetIsActive(p, state({ minRating: 80, lovedOnly: true, clauses: [textClause('genre', 'Jazz')], sort: sortOf('rating', false) })),
    true,
  )
  // Open popups and clause IDs are not part of the comparison.
  assert.equal(
    presetIsActive(p, state({
      minRating: 80,
      lovedOnly: true,
      clauses: [{ ...textClause('genre', 'Jazz'), id: 'another-id' }],
      sort: sortOf('rating', false),
      filterOpen: true,
    })),
    true,
  )
  assert.equal(presetIsActive(p, state({ minRating: 70, lovedOnly: true, clauses: [textClause('genre', 'Jazz')], sort: sortOf('rating', false) })), false)
  assert.equal(presetIsActive(p, state({ minRating: 80, lovedOnly: true, clauses: [textClause('genre', 'Rock')], sort: sortOf('rating', false) })), false)
  assert.equal(presetIsActive(p, state({ minRating: 80, lovedOnly: true, clauses: [textClause('genre', 'Jazz')], sort: sortOf('rating', true) })), false)
  assert.equal(presetIsActive(p, state({ minRating: 80, lovedOnly: true, clauses: [textClause('genre', 'Jazz')], sort: sortOf('rating', false), filterOpen: false })), true)
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
    { id: 'keep', name: '  Keep  me ', filters: { minRating: 40 }, sort: sortOf('length', false) },
  ])
  assert.equal(out.length, 1)
  assert.deepEqual(out[0], {
    id: 'keep',
    name: 'Keep me',
    filters: { minRating: 40, maxRating: 100, lovedOnly: false, clauses: [] },
    sort: sortOf('length', false),
  })
})

test('decodeFilterPresets migrates LEGACY scalar filter fields into clauses', () => {
  const out = decodeFilterPresets([
    {
      id: 'old',
      name: 'Old view',
      filters: { minRating: 60, lovedOnly: true, genre: 'Soul', fromYear: '1960', toYear: 1979 },
    },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].filters.minRating, 60)
  assert.deepEqual(clauseFields(out[0]), ['genre', 'year'])
  const [genre, year] = out[0].filters.clauses
  assert.equal(genre.kind === 'text' && genre.query, 'Soul')
  assert.ok(year.kind === 'range')
  assert.deepEqual([year.min, year.max], [1960, 1979])
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
  assert.equal(out[0].filters.minRating, 0, 'clamped then swapped into a valid range')
  assert.equal(out[0].filters.maxRating, 100)
  assert.equal(out[0].filters.lovedOnly, false)
  assert.deepEqual(clauseFields(out[0]), ['year', 'length'], 'a non-string genre is dropped')
  const year = out[0].filters.clauses[0]
  assert.ok(year.kind === 'range')
  assert.deepEqual([year.min, year.max], [1900, 2001], 'a nonsense year bound clamps to the domain floor')
  const length = out[0].filters.clauses[1]
  assert.ok(length.kind === 'range')
  assert.deepEqual([length.min, length.max], [null, 120])
  // An unknown sort key degrades to "no sort" rather than throwing.
  assert.equal(sortSignature(out[0].sort), '')
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
    {
      id: 'r1',
      name: 'Warm',
      filters: { minRating: 60, lovedOnly: true, genre: 'Soul' },
      sort: sortOf('rating', false),
    },
  ])
  const applied = applyPreset(state(), saved[0])
  assert.equal(applied.minRating, 60)
  assert.equal(applied.clauses[0].kind === 'text' && applied.clauses[0].query, 'Soul')
  assert.equal(sortSignature(applied.sort), 'rating-')
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
    { id: 'saved', name: '  Late  night ', filters: { minRating: 80, lovedOnly: true }, sort: sortOf('rating', false) },
    { id: '', name: 'no id' },
    { id: 'dup', name: 'late night' },
  ])
  await initStores()
  const restored = get(filterPresets)
  assert.deepEqual(restored.map((p) => p.id), ['saved'], 'invalid and duplicate rows never become chips')
  assert.equal(restored[0].name, 'Late night', 'the name is normalized on the way in')
  assert.equal(restored[0].filters.minRating, 80)
  assert.equal(sortSignature(restored[0].sort), 'rating-')
})

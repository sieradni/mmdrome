// Pins eqStore's persistence surface (TODO 4.6 + the 2026-09-13 working-
// state overlay): initEqStore restore paths (userPresets scan, current state
// + active preset id, bypass via `persisted`), saveUserPreset's builtin-name
// → `custom_` re-id, deleteUserPreset's active-preset fallback to flat,
// applyPreset, and the WORKING SESSION semantics: edits mark dirty against
// the session base, dirty edits debounce-persist, a revert persists
// immediately, and preset-level flows reset the session clean. Dexie tables
// share one prototype (F3): get/put/delete/filter are patched once; the
// filter stub returns `{ key, value }` rows (the shape initEqStore's scan
// reads), and each test resets the stores because initEqStore is not
// idempotent.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { db } from '../src/lib/db'
import {
  initEqStore,
  activePresetId,
  userPresets,
  currentEqState,
  workingEq,
  eqBypassed,
  saveUserPreset,
  deleteUserPreset,
  applyPreset,
  saveAsCurrentPreset,
  saveEqSession,
  editWorkingEq,
  cancelPendingWorkingCommit,
} from '../src/lib/eq/eqStore'
import { startSession } from '../src/lib/eq/eqSession'
import { BUILTIN_PRESETS } from '../src/lib/eq/builtInPresets'
import type { EqPreset } from '../src/lib/eq/eqTypes'

const rows = new Map<string, unknown>()
const presetRows: { key: string; value: EqPreset }[] = []

function clearRows(): void {
  rows.clear()
  presetRows.length = 0
}

// All tables share Table.prototype — patch each method once, dispatch by table.
Object.getPrototypeOf(db.userSettings).get = (async function (this: { name: string }, key: string) {
  if (this.name === 'playQueue') return undefined
  const value = rows.get(key)
  return value === undefined ? undefined : { key, value }
}) as never
Object.getPrototypeOf(db.userSettings).put = (async (entry: { key: string; value: unknown }) => {
  rows.set(entry.key, entry.value)
}) as never
Object.getPrototypeOf(db.userSettings).delete = (async (key: string) => {
  rows.delete(key)
}) as never
Object.getPrototypeOf(db.userSettings).filter = (() => ({
  toArray: async () => [...presetRows],
})) as never
Object.getPrototypeOf(db.localMetadata).toArray = (async () => []) as never

function preset(over: Partial<EqPreset> = {}): EqPreset {
  return { id: 'custom-x', name: 'Mine', mode: 'graphic', preampDb: 0, filters: [], ...over }
}

function resetEqStores(): void {
  cancelPendingWorkingCommit()
  activePresetId.set('flat')
  userPresets.set([])
  currentEqState.set(BUILTIN_PRESETS[0])
  workingEq.set(startSession(BUILTIN_PRESETS[0]))
  eqBypassed.set(false)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('initEqStore: bypass restores from the persisted row; empty preset store → flat defaults', async () => {
  resetEqStores()
  rows.set('eq_bypassed', true)
  await initEqStore()
  assert.equal(get(eqBypassed), true, 'persisted bypass restored')
  assert.equal(get(activePresetId), 'flat', 'no saved preset → flat')
  assert.equal(get(currentEqState).id, 'flat')
  assert.equal(get(workingEq).state.id, 'flat', 'working session mirrors flat')
  assert.equal(get(workingEq).dirty, false, 'fresh session is clean')
})

test('initEqStore: saved state + active preset id restore together', async () => {
  resetEqStores()
  rows.set('current_eq_state', preset({ id: 'user-1', name: 'Saved', preampDb: -3 }))
  rows.set('active_eq_preset', 'user-1')
  await initEqStore()
  assert.equal(get(currentEqState).id, 'user-1')
  assert.equal(get(currentEqState).preampDb, -3)
  assert.equal(get(activePresetId), 'user-1')
  assert.equal(get(workingEq).state.preampDb, -3, 'working session adopts the saved state')
  assert.equal(get(workingEq).dirty, false)
})

test('initEqStore: saved state without an active preset id keeps the default id', async () => {
  resetEqStores()
  rows.set('current_eq_state', preset({ id: 'user-2', name: 'StateOnly' }))
  rows.delete('active_eq_preset')
  await initEqStore()
  assert.equal(get(currentEqState).id, 'user-2')
  assert.equal(get(activePresetId), 'flat')
  assert.equal(get(workingEq).state.id, 'user-2', 'state-only row self-bases into the session')
})

test('initEqStore: user presets are loaded from the prefixed rows', async () => {
  resetEqStores()
  presetRows.length = 0
  presetRows.push(
    { key: 'eq_user_preset_user-a', value: preset({ id: 'user-a', name: 'A' }) },
    { key: 'eq_user_preset_user-b', value: preset({ id: 'user-b', name: 'B' }) },
  )
  await initEqStore()
  assert.deepEqual(get(userPresets).map((p) => p.id), ['user-a', 'user-b'])
})

test('saveUserPreset re-ids a builtin name to custom_ and persists', async () => {
  resetEqStores()
  clearRows()
  await initEqStore()
  await saveUserPreset(preset({ id: 'flat', name: 'Flat' }))
  const savedId = get(activePresetId)
  assert.ok(savedId.startsWith('custom_'), `builtin id re-ided, got ${savedId}`)
  assert.ok(rows.has(`eq_user_preset_${savedId}`), 'custom preset persisted')
  assert.equal(get(userPresets).some((p) => p.id === savedId), true)
  assert.equal(get(currentEqState).id, savedId)
  assert.equal(get(workingEq).base.id, savedId, 'working session re-based on the saved preset')
  assert.equal(get(workingEq).dirty, false)
  assert.equal(get(currentEqState).isBuiltin, false)
})

test('saveUserPreset with an existing custom id updates in place', async () => {
  resetEqStores()
  clearRows()
  presetRows.push({ key: 'eq_user_preset_user-a', value: preset({ id: 'user-a', name: 'A', preampDb: 0 }) })
  await initEqStore()
  await saveUserPreset(preset({ id: 'user-a', name: 'A', preampDb: -6 }))
  assert.equal(get(userPresets).find((p) => p.id === 'user-a')?.preampDb, -6)
  assert.equal(get(userPresets).length, 1, 'updated, not duplicated')
})

test('deleteUserPreset of the active preset falls back to flat', async () => {
  resetEqStores()
  clearRows()
  presetRows.push({ key: 'eq_user_preset_user-active', value: preset({ id: 'user-active', name: 'Active', isBuiltin: false }) })
  rows.set('eq_user_preset_user-active', preset({ id: 'user-active', name: 'Active', isBuiltin: false }))
  await initEqStore()
  await applyPreset('user-active')
  assert.equal(get(activePresetId), 'user-active')

  await deleteUserPreset('user-active')
  assert.equal(get(userPresets).some((p) => p.id === 'user-active'), false, 'preset removed')
  assert.equal(get(activePresetId), 'flat', 'active id falls back to flat')
  assert.equal(get(currentEqState).id, 'flat')
  assert.equal(get(workingEq).dirty, false, 'session reset clean on the fallback')
  assert.equal(rows.get('active_eq_preset'), 'flat', 'fallback persisted')
  assert.equal(rows.has('eq_user_preset_user-active'), false, 'deleted row removed from Dexie')
})

test('deleteUserPreset refuses builtin ids', async () => {
  resetEqStores()
  clearRows()
  await initEqStore()
  await deleteUserPreset('flat')
  assert.equal(get(activePresetId), 'flat')
  assert.equal(get(userPresets).length, 0)
})

test('applyPreset sets stores and persists the active id', async () => {
  resetEqStores()
  clearRows()
  presetRows.push({ key: 'eq_user_preset_user-app', value: preset({ id: 'user-app', name: 'App', preampDb: -2 }) })
  rows.delete('current_eq_state')
  rows.delete('active_eq_preset')
  await initEqStore()
  const result = await applyPreset('user-app')
  assert.equal(result?.id, 'user-app')
  assert.equal(get(activePresetId), 'user-app')
  assert.equal(get(currentEqState).id, 'user-app')
  assert.equal(get(workingEq).base.id, 'user-app', 'session re-based on the selection')
  assert.equal(get(workingEq).dirty, false)
  assert.equal(rows.get('active_eq_preset'), 'user-app')
  assert.deepEqual(rows.get('current_eq_state'), get(currentEqState), 'state persisted')
})

test('editWorkingEq marks dirty against the base and debounce-persists (leaving the view loses nothing)', async () => {
  resetEqStores()
  clearRows()
  await initEqStore()
  editWorkingEq((st) => {
    st.preampDb = -4
    return st
  })
  assert.equal(get(workingEq).dirty, true, 'edit over flat marks dirty')
  assert.equal(get(workingEq).base.id, 'flat', 'base preset unchanged by the edit')
  assert.equal(get(currentEqState).preampDb, -4, 'engine-facing state mirrors the edit instantly')
  assert.notEqual((rows.get('current_eq_state') as EqPreset | undefined)?.preampDb, -4, 'not yet persisted (debounce)')
  await sleep(700)
  assert.equal((rows.get('current_eq_state') as EqPreset).preampDb, -4, 'debounced write landed')
  assert.equal(rows.get('active_eq_preset'), 'flat', 'active id keeps pointing at the base preset')
})

test('reverting to the preset values clears dirty and persists immediately', async () => {
  resetEqStores()
  clearRows()
  await initEqStore()
  editWorkingEq((st) => {
    st.preampDb = -4
    return st
  })
  await sleep(700) // let the dirty write land
  editWorkingEq((st) => {
    st.preampDb = 0
    return st
  })
  assert.equal(get(workingEq).dirty, false, 'back to base → clean')
  // Immediate write: no debounce wait — a pending dirty write must never
  // resurrect a reverted overlay on the next boot.
  await sleep(20)
  assert.equal((rows.get('current_eq_state') as EqPreset).preampDb, 0, 'clean state persisted immediately')
})

test('applyPreset while dirty resets the session clean on the new preset', async () => {
  resetEqStores()
  clearRows()
  presetRows.push({ key: 'eq_user_preset_user-x', value: preset({ id: 'user-x', name: 'X' }) })
  await initEqStore()
  editWorkingEq((st) => {
    st.preampDb = -5
    return st
  })
  assert.equal(get(workingEq).dirty, true)
  await applyPreset('user-x')
  assert.equal(get(workingEq).dirty, false, 'fresh selection starts clean')
  assert.equal(get(workingEq).base.id, 'user-x')
  assert.equal(get(currentEqState).id, 'user-x')
  assert.equal((rows.get('current_eq_state') as EqPreset).id, 'user-x')
})

test('saveAsCurrentPreset consumes the working state and re-bases the session clean', async () => {
  resetEqStores()
  clearRows()
  await initEqStore()
  editWorkingEq((st) => {
    st.preampDb = -7
    return st
  })
  const committed = await saveAsCurrentPreset(structuredClone(get(workingEq).state))
  assert.equal(committed.preampDb, -7)
  assert.equal(get(activePresetId), committed.id, 'active id moved to the committed preset')
  assert.equal(get(workingEq).dirty, false, 'session clean against the committed preset')
  assert.equal(get(workingEq).base.id, committed.id)
  assert.equal((rows.get('active_eq_preset') as string), committed.id, 'committed selection persisted')
})

// ── saveEqSession (2026-09-14 unified save) ──────────────────────────────

test('saveEqSession overwrites a user-preset base in place and re-bases clean', async () => {
  resetEqStores()
  clearRows()
  await initEqStore()
  await saveUserPreset({ id: 'user_probe', name: 'Probe', mode: 'parametric', preampDb: 0, filters: BUILTIN_PRESETS[0].filters.map((f) => ({ ...f })) })
  assert.equal(get(activePresetId), 'user_probe')
  editWorkingEq((st) => {
    st.preampDb = -4
    return st
  })
  const committed = await saveEqSession()
  assert.equal(committed.id, 'user_probe', 'overwrote in place')
  assert.equal(committed.preampDb, -4)
  assert.equal(get(workingEq).dirty, false, 'session re-based clean')
  assert.equal(get(currentEqState)?.preampDb, -4)
})

test('saveEqSession over a builtin creates a new preset with the default (modified) name', async () => {
  resetEqStores()
  clearRows()
  await initEqStore()
  editWorkingEq((st) => {
    st.filters[0].gain = 3
    return st
  })
  const committed = await saveEqSession()
  assert.match(committed.id, /^user_/)
  assert.equal(committed.name, 'Flat (modified)')
  assert.equal(committed.filters[0].gain, 3)
  assert.equal(get(activePresetId), committed.id)
  assert.equal(get(workingEq).dirty, false)
})

test('saveEqSession with a name uses it; a clean session still saves (no-op overwrite)', async () => {
  resetEqStores()
  clearRows()
  await initEqStore()
  const committed = await saveEqSession('My Mix')
  assert.equal(committed.name, 'My Mix')
  assert.equal(get(activePresetId), committed.id)
  // Clean session over the new user preset: second save is a clean no-op overwrite
  const again = await saveEqSession()
  assert.equal(again.id, committed.id)
  assert.equal(get(workingEq).dirty, false)
})

test('saveEqSession over an imported base creates a new preset carrying graphicEqCurves', async () => {
  resetEqStores()
  clearRows()
  await initEqStore()
  const imported: EqPreset = {
    id: 'imported',
    name: 'Imported',
    mode: 'parametric',
    preampDb: -2,
    filters: BUILTIN_PRESETS[0].filters.map((f) => ({ ...f })),
    graphicEqCurves: [[{ frequency: 100, gainDb: 4 }]],
  }
  // Land the session on the import without going through the view's handler.
  applyPreset('flat')
  workingEq.set({
    base: imported,
    state: imported,
    dirty: false,
  } as never)
  editWorkingEq((st) => {
    st.preampDb = -5
    return st
  })
  const committed = await saveEqSession()
  assert.match(committed.id, /^user_/)
  assert.equal(committed.name, 'Imported (modified)')
  assert.deepEqual(committed.graphicEqCurves, [[{ frequency: 100, gainDb: 4 }]], 'curve stack survives the save')
  assert.equal(committed.preampDb, -5)
})

test("saveEqSession mode 'new' duplicates a user-preset session instead of overwriting", async () => {
  resetEqStores()
  clearRows()
  await initEqStore()
  await saveUserPreset({ id: 'user_probe', name: 'Probe', mode: 'parametric', preampDb: 0, filters: BUILTIN_PRESETS[0].filters.map((f) => ({ ...f })) })
  editWorkingEq((st) => {
    st.preampDb = -9
    return st
  })
  const copy = await saveEqSession(undefined, 'new')
  assert.notEqual(copy.id, 'user_probe', 'a NEW preset was created, not an overwrite')
  assert.equal(copy.name, 'Probe (modified)', 'default name follows the base')
  assert.equal(copy.preampDb, -9)
  assert.equal(get(activePresetId), copy.id, 'the copy is now active')
  const original = get(userPresets).find((p) => p.id === 'user_probe')
  assert.equal(original?.preampDb, 0, 'the original preset is untouched (duplicate semantics)')
  assert.equal(get(userPresets).length, 2, 'both presets exist')
})

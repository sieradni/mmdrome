// Pins eqStore's persistence surface (TODO 4.6): initEqStore restore paths
// (userPresets scan, current state + active preset id, bypass via `persisted`),
// saveUserPreset's builtin-name → `custom_` re-id, deleteUserPreset's
// active-preset fallback to flat, and applyPreset. Dexie tables share one
// prototype (F3): get/put/delete/filter are patched once; the filter stub
// returns `{ key, value }` rows (the shape initEqStore's scan reads), and each
// test resets the stores because initEqStore is not idempotent.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { db } from '../src/lib/db'
import {
  initEqStore,
  activePresetId,
  userPresets,
  currentEqState,
  draftState,
  eqBypassed,
  saveUserPreset,
  deleteUserPreset,
  applyPreset,
} from '../src/lib/eq/eqStore'
import { BUILTIN_PRESETS } from '../src/lib/eq/builtInPresets'
import type { EqPreset } from '../src/lib/eq/eqTypes'

const rows = new Map<string, unknown>()
const presetRows: { key: string; value: EqPreset }[] = []

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
  activePresetId.set('flat')
  userPresets.set([])
  currentEqState.set(BUILTIN_PRESETS[0])
  draftState.set(BUILTIN_PRESETS[0])
  eqBypassed.set(false)
}

test('initEqStore: bypass restores from the persisted row; empty preset store → flat defaults', async () => {
  resetEqStores()
  rows.set('eq_bypassed', true)
  await initEqStore()
  assert.equal(get(eqBypassed), true, 'persisted bypass restored')
  assert.equal(get(activePresetId), 'flat', 'no saved preset → flat')
  assert.equal(get(currentEqState).id, 'flat')
  assert.equal(get(draftState).id, 'flat', 'draft mirrors the current state')
})

test('initEqStore: saved state + active preset id restore together', async () => {
  resetEqStores()
  rows.set('current_eq_state', preset({ id: 'user-1', name: 'Saved', preampDb: -3 }))
  rows.set('active_eq_preset', 'user-1')
  await initEqStore()
  assert.equal(get(currentEqState).id, 'user-1')
  assert.equal(get(currentEqState).preampDb, -3)
  assert.equal(get(activePresetId), 'user-1')
})

test('initEqStore: saved state without an active preset id keeps the default id', async () => {
  resetEqStores()
  rows.set('current_eq_state', preset({ id: 'user-2', name: 'StateOnly' }))
  rows.delete('active_eq_preset')
  await initEqStore()
  assert.equal(get(currentEqState).id, 'user-2')
  assert.equal(get(activePresetId), 'flat')
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
  presetRows.length = 0
  await initEqStore()
  await saveUserPreset(preset({ id: 'flat', name: 'Flat' }))
  const savedId = get(activePresetId)
  assert.ok(savedId.startsWith('custom_'), `builtin id re-ided, got ${savedId}`)
  assert.ok(rows.has(`eq_user_preset_${savedId}`), 'custom preset persisted')
  assert.equal(get(userPresets).some((p) => p.id === savedId), true)
  assert.equal(get(currentEqState).id, savedId)
  assert.equal(get(draftState).id, savedId)
  assert.equal(get(currentEqState).isBuiltin, false)
})

test('saveUserPreset with an existing custom id updates in place', async () => {
  resetEqStores()
  presetRows.length = 0
  presetRows.push({ key: 'eq_user_preset_user-a', value: preset({ id: 'user-a', name: 'A', preampDb: 0 }) })
  await initEqStore()
  await saveUserPreset(preset({ id: 'user-a', name: 'A', preampDb: -6 }))
  assert.equal(get(userPresets).find((p) => p.id === 'user-a')?.preampDb, -6)
  assert.equal(get(userPresets).length, 1, 'updated, not duplicated')
})

test('deleteUserPreset of the active preset falls back to flat', async () => {
  resetEqStores()
  presetRows.length = 0
  presetRows.push({ key: 'eq_user_preset_user-active', value: preset({ id: 'user-active', name: 'Active', isBuiltin: false }) })
  rows.set('eq_user_preset_user-active', preset({ id: 'user-active', name: 'Active', isBuiltin: false }))
  await initEqStore()
  await applyPreset('user-active')
  assert.equal(get(activePresetId), 'user-active')

  await deleteUserPreset('user-active')
  assert.equal(get(userPresets).some((p) => p.id === 'user-active'), false, 'preset removed')
  assert.equal(get(activePresetId), 'flat', 'active id falls back to flat')
  assert.equal(get(currentEqState).id, 'flat')
  assert.equal(rows.get('active_eq_preset'), 'flat', 'fallback persisted')
  assert.equal(rows.has('eq_user_preset_user-active'), false, 'deleted row removed from Dexie')
})

test('deleteUserPreset refuses builtin ids', async () => {
  resetEqStores()
  presetRows.length = 0
  await initEqStore()
  await deleteUserPreset('flat')
  assert.equal(get(activePresetId), 'flat')
  assert.equal(get(userPresets).length, 0)
})

test('applyPreset sets stores and persists the active id', async () => {
  resetEqStores()
  presetRows.length = 0
  presetRows.push({ key: 'eq_user_preset_user-app', value: preset({ id: 'user-app', name: 'App', preampDb: -2 }) })
  rows.delete('current_eq_state')
  rows.delete('active_eq_preset')
  await initEqStore()
  const result = await applyPreset('user-app')
  assert.equal(result?.id, 'user-app')
  assert.equal(get(activePresetId), 'user-app')
  assert.equal(get(currentEqState).id, 'user-app')
  assert.equal(get(draftState).id, 'user-app')
  assert.equal(rows.get('active_eq_preset'), 'user-app')
  assert.deepEqual(rows.get('current_eq_state'), get(currentEqState), 'state persisted')
})

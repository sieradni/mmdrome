// Pins eqStore's persistence surface (TODO 4.6 + the 2026-09-13 working-
// state overlay): initEqStore restore paths (userPresets scan, current state
// + active preset id, bypass via `persisted`), deleteUserPreset's
// active-preset fallback to flat, applyPreset, saveEqSession, and the WORKING
// SESSION semantics: edits mark dirty against the session base, dirty edits
// debounce-persist, a revert persists immediately, preset-level flows reset
// the session clean, and the selection (`activePresetId`) plus the
// engine-facing state (`currentEqState`) are DERIVED from that one session
// rather than mirrored (the divergence the 2026-10 audit could construct).
// Dexie tables
// share one prototype (F3): get/put/delete/filter are patched once; the
// filter stub returns `{ key, value }` rows (the shape initEqStore's scan
// reads), and each test resets the stores because initEqStore is not
// idempotent.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { db, getSetting } from '../src/lib/db'
import {
  initEqStore,
  activePresetId,
  userPresets,
  workingEq,
  eqBypassed,
  deleteUserPreset,
  applyPreset,
  saveEqSession,
  editWorkingEq,
  resetWorkingEq,
  flushWorkingEqPersistence,
  cancelPendingWorkingCommit,
} from '../src/lib/eq/eqStore'
import { startSession } from '../src/lib/eq/eqSession'
import { BUILTIN_PRESETS } from '../src/lib/eq/builtInPresets'

// Key used by persistEqState for the working-state row (duplicated here
// rather than exported — keep the store's surface minimal).
const CURRENT_EQ_STATE_KEY = 'current_eq_state'
import type { EqPreset } from '../src/lib/eq/eqTypes'

const rows = new Map<string, unknown>()
const presetRows: { key: string; value: EqPreset }[] = []
/** Counts every Dexie put — distinguishes "the flush wrote once" from "the
 *  cleared debounce fired again later". */
let putCount = 0

function clearRows(): void {
  rows.clear()
  presetRows.length = 0
  putCount = 0
}

// All tables share Table.prototype — patch each method once, dispatch by table.
Object.getPrototypeOf(db.userSettings).get = (async function (this: { name: string }, key: string) {
  if (this.name === 'playQueue') return undefined
  const value = rows.get(key)
  return value === undefined ? undefined : { key, value }
}) as never
Object.getPrototypeOf(db.userSettings).put = (async (entry: { key: string; value: unknown }) => {
  putCount++
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
  userPresets.set([])
  workingEq.set(startSession(BUILTIN_PRESETS[0]))
  eqBypassed.set(false)
}

/** A user preset seeded into the persisted rows (initEqStore loads it). */
function probePreset(preampDb = 0): EqPreset {
  return {
    id: 'user_probe',
    name: 'Probe',
    mode: 'parametric',
    preampDb,
    filters: BUILTIN_PRESETS[0].filters.map((f) => ({ ...f })),
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('initEqStore: bypass restores from the persisted row; empty preset store → flat defaults', async () => {
  resetEqStores()
  rows.set('eq_bypassed', true)
  await initEqStore()
  assert.equal(get(eqBypassed), true, 'persisted bypass restored')
  assert.equal(get(activePresetId), 'flat', 'no saved preset → flat')
  assert.equal(get(workingEq).state.id, 'flat')
  assert.equal(get(workingEq).state.id, 'flat', 'working session mirrors flat')
  assert.equal(get(workingEq).dirty, false, 'fresh session is clean')
})

test('initEqStore: saved state + active preset id restore together', async () => {
  resetEqStores()
  rows.set('current_eq_state', preset({ id: 'user-1', name: 'Saved', preampDb: -3 }))
  rows.set('active_eq_preset', 'user-1')
  await initEqStore()
  assert.equal(get(workingEq).state.id, 'user-1')
  assert.equal(get(workingEq).state.preampDb, -3)
  assert.equal(get(activePresetId), 'user-1')
  assert.equal(get(workingEq).state.preampDb, -3, 'working session adopts the saved state')
  assert.equal(get(workingEq).dirty, false)
})

test('initEqStore: a state-only row self-bases and the selection follows it', async () => {
  resetEqStores()
  rows.set('current_eq_state', preset({ id: 'user-2', name: 'StateOnly' }))
  rows.delete('active_eq_preset')
  await initEqStore()
  assert.equal(get(workingEq).state.id, 'user-2')
  // The session base IS the selection: leaving the id on 'flat' made the
  // select name a preset the working state (and the engine) never held.
  assert.equal(get(activePresetId), 'user-2')
  assert.equal(get(workingEq).state.id, 'user-2', 'state-only row self-bases into the session')
})

test('import over a CLEAN session persists at once and survives a relaunch', async () => {
  resetEqStores()
  clearRows()
  await initEqStore() // clean Flat session, no pending edits
  const imported: EqPreset = {
    id: 'imported',
    name: 'Imported',
    mode: 'graphic',
    preampDb: -5,
    filters: [{ type: 'peaking', frequency: 100, gain: 6, q: 0.7, enabled: true }],
    graphicEqCurves: [[{ frequency: 100, gainDb: 6 }, { frequency: 1000, gainDb: -2 }]],
  }

  resetWorkingEq(imported) // the store leg of EQView.handleImport
  await sleep(20) // no debounce window to wait out
  assert.equal((rows.get('current_eq_state') as EqPreset).preampDb, -5, 'written immediately')
  assert.equal(rows.get('active_eq_preset'), 'imported', 'the session base id is persisted')
  assert.equal(get(activePresetId), 'imported', 'the select names what is playing')

  // Relaunch: same rows, fresh stores (module-level state is per page load).
  cancelPendingWorkingCommit()
  userPresets.set([])
  workingEq.set(startSession(BUILTIN_PRESETS[0]))
  await initEqStore()

  assert.equal(get(workingEq).state.preampDb, -5, 'controls restore the import')
  assert.deepEqual(get(workingEq).state.graphicEqCurves, imported.graphicEqCurves)
  assert.equal(get(workingEq).dirty, false)
  assert.equal(get(workingEq).state.preampDb, -5, 'playback applies the import')
  assert.equal(get(activePresetId), 'imported')
})

test('an import discards a pending debounced edit instead of resurrecting it', async () => {
  resetEqStores()
  clearRows()
  await initEqStore()
  editWorkingEq((st) => {
    st.preampDb = -2
    return st
  }) // schedules a debounced write of the OLD session
  resetWorkingEq(
    preset({ id: 'imported', name: 'Imported', mode: 'graphic', preampDb: -8, graphicEqCurves: [[{ frequency: 60, gainDb: 4 }]] })
  )
  await sleep(700) // the old debounce would fire here if it were not cancelled
  assert.equal((rows.get('current_eq_state') as EqPreset).preampDb, -8, 'the import wins, not the discarded edit')
  assert.equal(rows.get('active_eq_preset'), 'imported')
  assert.equal(get(workingEq).state.preampDb, -8)
})

test('a SECOND import (same base id, different curve) still persists', async () => {
  resetEqStores()
  clearRows()
  await initEqStore()
  resetWorkingEq(
    preset({ id: 'imported', name: 'Imported', mode: 'graphic', preampDb: -3, graphicEqCurves: [[{ frequency: 80, gainDb: 3 }]] })
  )
  await sleep(20)
  // Same base id both times: a base-id-only trigger would write nothing here.
  resetWorkingEq(
    preset({ id: 'imported', name: 'Imported', mode: 'graphic', preampDb: -9, graphicEqCurves: [[{ frequency: 200, gainDb: -6 }]] })
  )
  await sleep(20)
  assert.equal((rows.get('current_eq_state') as EqPreset).preampDb, -9, 'second import persisted')
  assert.equal(get(workingEq).state.preampDb, -9)
})

test('flushWorkingEqPersistence writes a pending debounced edit exactly once', async () => {
  resetEqStores()
  clearRows()
  await initEqStore()
  editWorkingEq((st) => {
    st.preampDb = -6
    return st
  })
  assert.notEqual((rows.get('current_eq_state') as EqPreset | undefined)?.preampDb, -6, 'still debounced')

  flushWorkingEqPersistence() // pagehide
  await sleep(0) // one persist = the state row + the base-id row
  assert.equal((rows.get('current_eq_state') as EqPreset).preampDb, -6, 'pending edit written now')
  const afterFlush = putCount
  await sleep(700)
  assert.equal(putCount, afterFlush, 'the cleared debounce never fires a second write')

  // Nothing pending → no write at all.
  flushWorkingEqPersistence()
  assert.equal(putCount, afterFlush)
})

test('restore: an active preset id with no state row applies that preset', async () => {
  resetEqStores()
  clearRows()
  presetRows.push({ key: 'eq_user_preset_user-only', value: preset({ id: 'user-only', name: 'Only', preampDb: -4 }) })
  rows.set('active_eq_preset', 'user-only')
  await initEqStore()
  assert.equal(get(activePresetId), 'user-only')
  assert.equal(get(workingEq).state.preampDb, -4)
  assert.equal(get(workingEq).state.preampDb, -4, 'the session is not left on flat')
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

test('the selection is DERIVED from the session (it cannot diverge)', async () => {
  resetEqStores()
  clearRows()
  await initEqStore()
  assert.equal(get(activePresetId), get(workingEq).base.id, 'selection IS the session base')

  editWorkingEq((st) => {
    st.preampDb = -4
    return st
  })
  assert.equal(get(workingEq).state.preampDb, -4)
  assert.equal(get(activePresetId), 'flat', 'a dirty edit keeps the base selected')

  await resetWorkingEq(preset({ id: 'user-y', name: 'Y', preampDb: -1 }))
  assert.equal(get(workingEq).state.preampDb, -1)
  assert.equal(get(activePresetId), 'user-y', 'a new base moves the selection with the state')
})

test('a save that only creates a preset row still persists the selection', async () => {
  resetEqStores()
  clearRows()
  await initEqStore()
  // Clean Flat session, no value changes: only the base id moves. Keying the
  // persist decision on the values alone lost the selection on relaunch.
  const committed = await saveEqSession('Same values')
  assert.equal(rows.get('active_eq_preset'), committed.id, 'selection written even though the values did not change')
  assert.equal(get(activePresetId), committed.id)
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
  assert.equal(get(workingEq).state.id, 'flat')
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
  assert.equal(get(workingEq).state.id, 'user-app')
  assert.equal(get(workingEq).base.id, 'user-app', 'session re-based on the selection')
  assert.equal(get(workingEq).dirty, false)
  assert.equal(rows.get('active_eq_preset'), 'user-app')
  assert.deepEqual(rows.get('current_eq_state'), get(workingEq).state, 'state persisted')
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
  assert.equal(get(workingEq).state.preampDb, -4, 'a dirty edit keeps its values')
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
  assert.equal(get(workingEq).state.id, 'user-x')
  assert.equal((rows.get('current_eq_state') as EqPreset).id, 'user-x')
})


// ── saveEqSession (2026-09-14 unified save) ──────────────────────────────

test('saveEqSession overwrites a user-preset base in place and re-bases clean', async () => {
  resetEqStores()
  clearRows()
  presetRows.push({ key: 'eq_user_preset_user_probe', value: probePreset() })
  await initEqStore()
  await applyPreset('user_probe')
  assert.equal(get(activePresetId), 'user_probe')
  editWorkingEq((st) => {
    st.preampDb = -4
    return st
  })
  const committed = await saveEqSession()
  assert.equal(committed.id, 'user_probe', 'overwrote in place')
  assert.equal(committed.preampDb, -4)
  assert.equal(get(workingEq).dirty, false, 'session re-based clean')
  assert.equal(get(workingEq).state?.preampDb, -4)
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
  presetRows.push({ key: 'eq_user_preset_user_probe', value: probePreset() })
  await initEqStore()
  await applyPreset('user_probe')
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

// ── applyPreset (2026-09-15, CLASSIC switch — user decision) ───────────
// The 2026-09-15 "continuous re-base" (switchSessionBase/rebaseSession,
// which carried edits across a switch so the sound never changed) was
// REMOVED: selecting a preset now APPLIES it — the session resets on the
// selection and the sound changes. The VIEW asks before discarding edits
// (Keep / Discard / Save-first dialog); the store's contract is simply
// "apply = discard + switch", pinned here.

test('applyPreset applies the selection: session resets on it, edits do NOT carry, selection persists', async () => {
  resetEqStores()
  clearRows()
  presetRows.push({ key: 'eq_user_preset_user_probe', value: probePreset(-6) })
  await initEqStore()
  await applyPreset('user_probe')
  editWorkingEq((st) => {
    st.preampDb = -9
    return st
  })
  assert.equal(get(workingEq).dirty, true)

  const applied = await applyPreset('flat')
  assert.equal(applied?.id, 'flat')
  assert.equal(get(activePresetId), 'flat', 'the selection persisted')
  assert.equal(get(workingEq).base.id, 'flat', 'the session re-based on the selection')
  assert.equal(get(workingEq).state.preampDb, 0, 'the preset was APPLIED (edits discarded — classic switch)')
  assert.equal(get(workingEq).dirty, false, 'a fresh selection is clean')
  assert.equal(get(workingEq).state?.preampDb, 0, 'the applied preset is the session state')
  // The persisted rows agree (selection + applied state, not the old overlay).
  const saved = await getSetting<EqPreset>(CURRENT_EQ_STATE_KEY)
  assert.equal(saved?.preampDb, 0)
})

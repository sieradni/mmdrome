// Pins the ONE EQ → engine path (eqEngineSync + engineFacade.applyEq) against
// the REAL store and the REAL web engine's recorded config — not a mock of the
// thing under test. The 2026-10 audit's worst defect lived here: a preset
// switch moved the sliders and the session but never reached the audio (on
// iOS, only at relaunch — the native push ran at boot only). These cases drive
// applyPreset / editWorkingEq / resetWorkingEq / deleteUserPreset / bypass and
// read `audioManager.getEngineDebugState()` — the config the engine would
// actually run — after each transition.
//
// The web AudioManager records `_eqFilterConfigs`, `_eqPreampDb` and
// `_eqBypassed` BEFORE it needs a live AudioContext, so a Node test sees the
// same values the browser's graph was built from.
//
// The native half of `applyEq` is the same subscription calling the same
// projection and then ONE bridge snapshot; its band cap and curve
// approximation are pinned in eqEffective.test.ts, and the bridge itself needs
// a device (the plugin is not implemented in Node).

import './stub-audio-worklet-node'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { db } from '../src/lib/db'
import { audioManager } from '../src/lib/audioManager'
import {
  applyPreset,
  cancelPendingWorkingCommit,
  deleteUserPreset,
  editWorkingEq,
  eqBypassed,
  initEqStore,
  resetWorkingEq,
  userPresets,
  workingEq,
} from '../src/lib/eq/eqStore'
import { startEqEngineSync } from '../src/lib/eq/eqEngineSync'
import { startSession } from '../src/lib/eq/eqSession'
import { BUILTIN_PRESETS } from '../src/lib/eq/builtInPresets'
import type { EqFilterConfig, EqPreset } from '../src/lib/eq/eqTypes'

// Dexie is patched once per table prototype (the shape eqStore.test.ts uses):
// a `put`/`get`/`delete` map, and the preset scan's filter().toArray().
const rows = new Map<string, unknown>()
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
Object.getPrototypeOf(db.userSettings).filter = (() => ({ toArray: async () => [] })) as never

interface EngineEq {
  bands: EqFilterConfig[]
  preampDb: number
  bypassed: boolean
  convolver: boolean
}

/** The engine's OWN record of what it applies (the e2e reads the same fields
 *  off the debug dump — one vocabulary for unit and browser). */
function engineEq(): EngineEq {
  const state = audioManager.getEngineDebugState() as unknown as {
    eqBands: EqFilterConfig[]
    eqPreampDb: number
    eqBypassed: boolean
    convolverActive: boolean
  }
  return {
    bands: state.eqBands,
    preampDb: state.eqPreampDb,
    bypassed: state.eqBypassed,
    convolver: state.convolverActive,
  }
}

const gains = (): number[] => engineEq().bands.map((b) => b.gain)
const freqs = (): number[] => engineEq().bands.map((b) => b.frequency)

/** A fresh flat session + a started sync, torn down by the caller. */
function bootEq(): () => void {
  cancelPendingWorkingCommit()
  userPresets.set([])
  eqBypassed.set(false)
  workingEq.set(startSession(BUILTIN_PRESETS[0]))
  return startEqEngineSync()
}

const FLAT = BUILTIN_PRESETS[0]
const IMPORTED: EqPreset = {
  id: 'imported',
  name: 'Imported',
  mode: 'parametric',
  preampDb: -5,
  filters: [
    { type: 'peaking', frequency: 500, gain: 4, q: 1, enabled: true },
    { type: 'peaking', frequency: 4000, gain: -6, q: 1, enabled: true },
  ],
}

test('a preset switch reaches the engine (the audit defect)', async (t) => {
  const stop = bootEq()
  t.after(stop)
  assert.deepEqual(gains(), FLAT.filters.map(() => 0), 'boot pushed the restored session')

  await applyPreset('bass_boost')
  const bass = BUILTIN_PRESETS.find((p) => p.id === 'bass_boost')!
  assert.deepEqual(gains(), bass.filters.map((f) => f.gain), 'the switched preset is what the engine holds')
  assert.equal(engineEq().preampDb, bass.preampDb, 'its preamp too')

  // And the switch back, from a different band set than the previous push.
  await applyPreset('v_shape')
  const v = BUILTIN_PRESETS.find((p) => p.id === 'v_shape')!
  assert.deepEqual(gains(), v.filters.map((f) => f.gain))
  assert.equal(engineEq().preampDb, v.preampDb)
})

test('a dirty edit lands live (no chain rebuild) and in the engine config', async (t) => {
  const stop = bootEq()
  t.after(stop)
  await applyPreset('bass_boost')
  const rebuilds = t.mock.method(audioManager, 'applyFiltersConfig')

  editWorkingEq((st) => {
    st.filters[2].gain = 5
    st.preampDb = -1
    return st
  })

  assert.equal(engineEq().bands[2].gain, 5, 'the engine band moved')
  assert.equal(engineEq().preampDb, -1, 'preamp is live too')
  assert.equal(rebuilds.mock.callCount(), 0, 'a gain edit never re-materializes the chain')
})

test('an import over a clean session reaches the engine, curve stack included', async (t) => {
  const stop = bootEq()
  t.after(stop)
  const rebuilds = t.mock.method(audioManager, 'applyFiltersConfig')

  await resetWorkingEq(IMPORTED)
  assert.deepEqual(freqs(), [500, 4000])
  assert.deepEqual(gains(), [4, -6])
  assert.equal(engineEq().preampDb, -5)
  assert.equal(rebuilds.mock.callCount(), 1, 'a new band set re-materializes the chain')

  const curve: EqPreset = {
    ...IMPORTED,
    mode: 'graphic',
    graphicEqCurves: [[{ frequency: 30, gainDb: 6 }, { frequency: 20000, gainDb: -6 }]],
  }
  await resetWorkingEq(curve)
  assert.equal(engineEq().convolver, true, 'the imported curve is the sound')
  assert.equal(engineEq().preampDb, -5)
})

test('Reset All and deleting the active preset both reach the engine', async (t) => {
  const stop = bootEq()
  t.after(stop)

  await resetWorkingEq(IMPORTED)
  await resetWorkingEq(FLAT)
  assert.deepEqual(gains(), FLAT.filters.map(() => 0), 'Reset All is what the engine holds')
  assert.equal(engineEq().preampDb, 0)

  // A user preset that is the active selection, then deleted.
  const mine: EqPreset = { ...IMPORTED, id: 'user_mine', name: 'Mine' }
  userPresets.set([mine])
  await applyPreset('user_mine')
  assert.deepEqual(gains(), [4, -6])

  await deleteUserPreset('user_mine')
  assert.equal(get(workingEq).base.id, 'flat', 'the session fell back to flat')
  assert.deepEqual(gains(), FLAT.filters.map(() => 0), 'and so did the engine')
  assert.equal(engineEq().preampDb, 0)
})

test('bypass is inert in what applies: preamp 0, and every band still defined', async (t) => {
  const stop = bootEq()
  t.after(stop)
  await applyPreset('bass_boost')
  const preamp = BUILTIN_PRESETS.find((p) => p.id === 'bass_boost')!.preampDb

  eqBypassed.set(true)
  assert.equal(engineEq().bypassed, true)
  assert.equal(engineEq().preampDb, 0, 'a bypassed EQ applies no preamp')

  eqBypassed.set(false)
  assert.equal(engineEq().bypassed, false)
  assert.equal(engineEq().preampDb, preamp, 'un-bypassing restores it')
})

test('the sync survives an EQ store that never boots (no restored session)', async (t) => {
  // initEqStore on empty rows resolves the flat fallback; the boot push still
  // happens, so a first-run app has an engine config rather than silence.
  rows.clear()
  const stop = bootEq()
  t.after(stop)
  await initEqStore()
  assert.equal(get(workingEq).base.id, FLAT.id)
  assert.deepEqual(gains(), FLAT.filters.map(() => 0))
})

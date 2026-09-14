import { writable, get } from 'svelte/store'
import { db, getSetting, setSetting } from '../db'
import { persisted } from '../persistedStore'
import { BUILTIN_PRESETS } from './builtInPresets'
import type { EqPreset } from './eqTypes'
import {
  EQ_COMMIT_DEBOUNCE_MS,
  editDraft,
  planWorkingPersist,
  resolveSession,
  reconcileOnRestore,
  startSession,
  type EqSessionPersistencePlan,
  type EqWorkingSession,
} from './eqSession'

const USER_PRESET_PREFIX = 'eq_user_preset_'
const ACTIVE_PRESET_KEY = 'active_eq_preset'
const CURRENT_EQ_STATE_KEY = 'current_eq_state'

export const activePresetId = writable<string>('flat')
export const userPresets = writable<EqPreset[]>([])
/** What the engine last applied / what a track load re-applies. */
export const currentEqState = writable<EqPreset>(BUILTIN_PRESETS[0])
/**
 * The working session — the single source the EQ view renders from: the
 * user's edits as a dirty overlay over the active preset. Auto-persisted
 * (debounced) via commitWorkingState, so leaving the view loses nothing;
 * presets are never silently modified. Replaces the old never-persisted
 * `draftState` (removed 2026-09-13).
 */
export const workingEq = writable<EqWorkingSession>(startSession(BUILTIN_PRESETS[0]))
// Bypass is an engine-bound scalar — store-layer persistence via `persisted`,
// restored in `initEqStore` (the eq module owns its init).
const _eqBypassed = persisted<boolean>('eq_bypassed', false)
export const eqBypassed = _eqBypassed.store

// ── Working-state commit machinery ─────────────────────────────────────
// One debounce timer per app. The view calls editWorkingEq (or
// commitWorkingState directly) after every slider move — the engine push is
// the view's job and stays INSTANT; only the Dexie leg debounces.

let _commitTimer: ReturnType<typeof setTimeout> | null = null

/** Drop a pending debounced working-state write (session turned clean or a
 *  preset-level flow already persisted). */
export function cancelPendingWorkingCommit(): void {
  if (_commitTimer !== null) {
    clearTimeout(_commitTimer)
    _commitTimer = null
  }
}

function persistWorkingNow(session: EqWorkingSession): void {
  void persistEqState(session.state, session.base.id)
}

/** Apply the persist plan for `session` (pure policy from eqSession): dirty
 *  → debounced write; clean after dirty → immediate write (a revert must
 *  not resurrect from a pending dirty write); clean → no writes. */
export function commitWorkingState(session: EqWorkingSession, wasDirty: boolean): void {
  // The engine-facing state always mirrors the working copy — playbackManager
  // re-applies it on every track load, so it must equal what the user hears.
  currentEqState.set(session.state)
  const plan: EqSessionPersistencePlan = planWorkingPersist(session, wasDirty)
  if (!plan.persist) return
  if (plan.mode === 'immediate') {
    cancelPendingWorkingCommit()
    persistWorkingNow(session)
    return
  }
  if (_commitTimer !== null) clearTimeout(_commitTimer)
  _commitTimer = setTimeout(() => {
    _commitTimer = null
    persistWorkingNow(session)
  }, EQ_COMMIT_DEBOUNCE_MS)
}

/** The view's single edit entry: apply `edit` to the working session, mark
 *  dirtiness against the session's own base, and run the persist plan. */
export function editWorkingEq(edit: (state: EqPreset) => EqPreset): void {
  const wasDirty = get(workingEq).dirty
  const prev = get(workingEq)
  const next = editDraft(prev, edit)
  workingEq.set(next)
  commitWorkingState(next, wasDirty)
}

/** Replace the working session wholesale (fresh selection, restore, save
 *  flows) and persist the clean state immediately if the old one was dirty. */
export function resetWorkingEq(basePreset: EqPreset): void {
  const wasDirty = get(workingEq).dirty
  const fresh = startSession(basePreset)
  workingEq.set(fresh)
  commitWorkingState(fresh, wasDirty)
}

export async function initEqStore(): Promise<void> {
  // Load user presets from IndexedDB
  try {
    const entries = await db.userSettings
      .filter((s) => s.key.startsWith(USER_PRESET_PREFIX))
      .toArray()

    const loadedUserPresets: EqPreset[] = []
    for (const e of entries) {
      if (e.value && typeof e.value === 'object') {
        loadedUserPresets.push(e.value as EqPreset)
      }
    }
    userPresets.set(loadedUserPresets)

    // Load last active state or default to Flat
    const savedState = await getSetting<EqPreset>(CURRENT_EQ_STATE_KEY)
    const savedPresetId = await getSetting<string>(ACTIVE_PRESET_KEY)

    // Restore the working session FIRST (it decides what currentEqState
    // holds: a persisted dirty overlay beats the bare preset row), then
    // reconcile the active id — an existing active selection newer than the
    // overlay wins (applyPreset persists immediately, the overlay debounces).
    const session = resolveSession(savedState, savedPresetId, loadedUserPresets, BUILTIN_PRESETS[0])
    let activeId = get(activePresetId)
    if (savedState) currentEqState.set(session.state)
    if (savedPresetId) {
      const decision = reconcileOnRestore(session, savedPresetId)
      activeId = decision.activePresetId
      activePresetId.set(activeId)
      if (decision.adoptSaved) {
        workingEq.set(session)
      } else {
        const preset = findPresetById(activeId, loadedUserPresets)
        if (preset) {
          workingEq.set(startSession(preset))
          currentEqState.set(preset)
        }
      }
    } else {
      // No persisted selection: the saved state (if any) is a self-based
      // session (imported EQ / legacy row) — adopt it as-is.
      workingEq.set(session)
    }

    // Bypass is a `persisted` store — restore it (idempotent) before any write.
    await _eqBypassed.restore()
  } catch (err) {
    console.error('Failed to initialize EQ store:', err)
  }
}

export function findPresetById(id: string, customPresets?: EqPreset[]): EqPreset | undefined {
  const custom = customPresets ?? get(userPresets)
  return BUILTIN_PRESETS.find((p) => p.id === id) || custom.find((p) => p.id === id)
}

export async function saveUserPreset(preset: EqPreset): Promise<void> {
  const isBuiltin = BUILTIN_PRESETS.some((p) => p.id === preset.id)
  const cleanPreset: EqPreset = {
    ...preset,
    id: isBuiltin ? `custom_${Date.now()}` : preset.id,
    isBuiltin: false,
  }

  await setSetting(`${USER_PRESET_PREFIX}${cleanPreset.id}`, cleanPreset)

  userPresets.update((list) => {
    const idx = list.findIndex((p) => p.id === cleanPreset.id)
    if (idx >= 0) {
      const updated = [...list]
      updated[idx] = cleanPreset
      return updated
    }
    return [...list, cleanPreset]
  })

  activePresetId.set(cleanPreset.id)
  currentEqState.set(cleanPreset)
  resetWorkingEq(cleanPreset)
  await persistEqState(cleanPreset, cleanPreset.id)
}

export async function deleteUserPreset(id: string): Promise<void> {
  if (BUILTIN_PRESETS.some((p) => p.id === id)) return // cannot delete built-in

  await db.userSettings.delete(`${USER_PRESET_PREFIX}${id}`)

  userPresets.update((list) => list.filter((p) => p.id !== id))

  if (get(activePresetId) === id) {
    const defaultPreset = BUILTIN_PRESETS[0]
    activePresetId.set(defaultPreset.id)
    currentEqState.set(defaultPreset)
    resetWorkingEq(defaultPreset)
    await persistEqState(defaultPreset, defaultPreset.id)
  }
}

export async function applyPreset(id: string): Promise<EqPreset | undefined> {
  const preset = findPresetById(id)
  if (!preset) return undefined

  activePresetId.set(id)
  currentEqState.set(preset)
  resetWorkingEq(preset)
  await persistEqState(preset, id)
  return preset
}

export async function saveAsCurrentPreset(draft: EqPreset): Promise<EqPreset> {
  const activeId = get(activePresetId)
  const preset = findPresetById(activeId)

  let committed: EqPreset

  if (preset && !preset.isBuiltin) {
    committed = {
      ...preset,
      mode: draft.mode,
      preampDb: draft.preampDb,
      filters: draft.filters.map((f) => ({ ...f })),
    }
    await setSetting(`${USER_PRESET_PREFIX}${committed.id}`, committed)

    userPresets.update((list) => {
      const idx = list.findIndex((p) => p.id === committed.id)
      if (idx >= 0) {
        const updated = [...list]
        updated[idx] = committed
        return updated
      }
      return list
    })
  } else {
    const name = preset ? `${preset.name} (modified)` : `User Preset ${Date.now()}`
    committed = {
      id: `user_${Date.now()}`,
      name,
      mode: draft.mode,
      preampDb: draft.preampDb,
      filters: draft.filters.map((f) => ({ ...f })),
      isBuiltin: false,
    }
    await setSetting(`${USER_PRESET_PREFIX}${committed.id}`, committed)
    userPresets.update((list) => [...list, committed])
    activePresetId.set(committed.id)
  }

  currentEqState.set(committed)
  resetWorkingEq(committed)
  await persistEqState(committed, get(activePresetId))
  return committed
}

/**
 * Unified save (2026-09-14 UX pass): ONE function behind the EQ's single
 * Save button — overwrites the active preset when it is a user preset,
 * otherwise (builtin or imported base) creates a new preset from the
 * optional name (default `"<base> (modified)"`, exactly what Save-as-Current
 * did for builtins). Succeeds cleanly on a CLEAN session too (no-op
 * overwrite of the preset it already equals) so the button never has to be
 * disabled or explained. Carries graphicEqCurves through (the old
 * Save-as-Current dropped them — a saved import lost its curve stack).
 */
export async function saveEqSession(name?: string): Promise<EqPreset> {
  const activeId = get(activePresetId)
  const preset = findPresetById(activeId)
  const session = get(workingEq)
  const draft = session.state
  // The base id — NOT activePresetId — decides: the import flow keeps the
  // previously active preset selected while the session base is 'imported',
  // so an activePresetId check would happily OVERWRITE that unrelated user
  // preset with imported values (found by the eqStore test).
  const baseIsImport = session.base.id === 'imported'

  if (preset && !preset.isBuiltin && !baseIsImport) {
    // Overwrite path: keep the preset's identity, take the working values.
    const committed: EqPreset = {
      ...preset,
      mode: draft.mode,
      preampDb: draft.preampDb,
      filters: draft.filters.map((f) => ({ ...f })),
      graphicEqCurves: draft.graphicEqCurves?.map((c) => c.map((p) => ({ ...p }))),
    }
    await setSetting(`${USER_PRESET_PREFIX}${committed.id}`, committed)
    userPresets.update((list) => {
      const idx = list.findIndex((p) => p.id === committed.id)
      if (idx >= 0) {
        const updated = [...list]
        updated[idx] = committed
        return updated
      }
      return list
    })
    currentEqState.set(committed)
    resetWorkingEq(committed)
    await persistEqState(committed, activeId)
    return committed
  }

  // Builtin or imported base: create a new user preset. The default name
  // follows the SESSION BASE (an import saved while 'Flat' is selected must
  // not call itself "Flat (modified)").
  const committed: EqPreset = {
    id: `user_${Date.now()}`,
    name: name?.trim() || `${session.base.name ?? preset?.name ?? 'User'} (modified)`,
    mode: draft.mode,
    preampDb: draft.preampDb,
    filters: draft.filters.map((f) => ({ ...f })),
    graphicEqCurves: draft.graphicEqCurves?.map((c) => c.map((p) => ({ ...p }))),
    isBuiltin: false,
  }
  await setSetting(`${USER_PRESET_PREFIX}${committed.id}`, committed)
  userPresets.update((list) => [...list, committed])
  activePresetId.set(committed.id)
  currentEqState.set(committed)
  resetWorkingEq(committed)
  await persistEqState(committed, committed.id)
  return committed
}

export async function persistEqState(state: EqPreset, presetId: string): Promise<void> {
  await setSetting(CURRENT_EQ_STATE_KEY, state)
  await setSetting(ACTIVE_PRESET_KEY, presetId)
}

import { derived, get, writable } from 'svelte/store'
import { db, getSetting, setSetting } from '../db'
import { persisted } from '../persistedStore'
import { BUILTIN_PRESETS } from './builtInPresets'
import type { EqPreset } from './eqTypes'
import {
  EQ_COMMIT_DEBOUNCE_MS,
  editDraft,
  planWorkingPersist,
  resolveSession,
  startSession,
  type EqWorkingSession,
} from './eqSession'

const USER_PRESET_PREFIX = 'eq_user_preset_'
const ACTIVE_PRESET_KEY = 'active_eq_preset'
const CURRENT_EQ_STATE_KEY = 'current_eq_state'

/**
 * THE EQ state: the working session (base preset snapshot + working values +
 * dirty flag). It is the ONLY writable piece of EQ state, and every other
 * surface-facing value is DERIVED from it, so the controls and the audio
 * cannot disagree:
 *
 * - `activePresetId` — the session base id, i.e. the preset the select names;
 *   the ENGINE-facing read is the sync subscription (eqEngineSync), which
 *   projects the same session through `resolveAppliedEq` (eqEffective).
 *
 * Presets are never silently modified: edits live as a dirty overlay over the
 * base, and the whole session (edits included) is auto-persisted, so leaving
 * the view loses nothing. Replaces the never-persisted `draftState`
 * (removed 2026-09-13).
 */
export const workingEq = writable<EqWorkingSession>(startSession(BUILTIN_PRESETS[0]))
/** The selected preset id — read-only: a preset that is not the session base
 *  can never be shown as selected. */
export const activePresetId = derived(workingEq, (session) => session.base.id)
export const userPresets = writable<EqPreset[]>([])
// Bypass is an engine-bound scalar — store-layer persistence via `persisted`,
// restored in `initEqStore` (the eq module owns its init).
const _eqBypassed = persisted<boolean>('eq_bypassed', false)
export const eqBypassed = _eqBypassed.store

// ── Working-session commit machinery ────────────────────────────────────
// One debounce timer per app. The view calls editWorkingEq after every slider
// move and resetWorkingEq for a new base — the engine push is eqEngineSync's
// subscription and stays INSTANT; only the Dexie leg debounces.

let _commitTimer: ReturnType<typeof setTimeout> | null = null
/** The session the pending debounced write belongs to (the flush needs it). */
let _pendingSession: EqWorkingSession | null = null

/** Drop a pending debounced working-state write — a new base, a revert or a
 *  save already superseded it. */
export function cancelPendingWorkingCommit(): void {
  if (_commitTimer !== null) {
    clearTimeout(_commitTimer)
    _commitTimer = null
  }
  _pendingSession = null
}

function persistNow(session: EqWorkingSession): Promise<void> {
  return persistEqState(session.state, session.base.id)
}

/**
 * THE one persistence path for a session transition (policy:
 * eqSession.planWorkingPersist). Immediate writes return their durability
 * promise so a save flow can await it; the debounced path resolves at once.
 */
function persistTransition(
  previous: EqWorkingSession,
  next: EqWorkingSession
): Promise<void> {
  const mode = planWorkingPersist(previous, next)
  // 'none' means the session already equals what is on disk (or what a pending
  // write holds) — writing again would be a duplicate, and cancelling the
  // pending write would drop the only copy of those values.
  if (mode === 'none') return Promise.resolve()
  if (mode === 'immediate') {
    cancelPendingWorkingCommit() // the new value supersedes a pending write
    return persistNow(next)
  }
  if (_commitTimer !== null) clearTimeout(_commitTimer)
  _pendingSession = next
  _commitTimer = setTimeout(() => {
    _commitTimer = null
    _pendingSession = null
    void persistNow(next)
  }, EQ_COMMIT_DEBOUNCE_MS)
  return Promise.resolve()
}

/** Write a pending debounced edit NOW. Wired to pagehide/visibilitychange
 *  (see below) and used by tests: iOS kills the webview without a reliable
 *  `beforeunload`, so a slider move followed by a background must not wait
 *  out the debounce window it may never survive. */
export function flushWorkingEqPersistence(): void {
  const session = _pendingSession
  if (!session) return
  cancelPendingWorkingCommit()
  void persistNow(session)
}

/** The view's single edit entry: apply `edit` to the working session, mark
 *  dirtiness against the session's own base, and run the persist plan. */
export function editWorkingEq(edit: (state: EqPreset) => EqPreset): void {
  const previous = get(workingEq)
  const next = editDraft(previous, edit)
  workingEq.set(next)
  void persistTransition(previous, next)
}

/** Install a NEW base (preset selection, import, Reset All) as a CLEAN
 *  session. The base id IS the selection, so the select and the engine always
 *  name the same EQ — an import has no preset row and therefore shows as the
 *  session's own base instead of the preset it replaced (and never renders
 *  empty after a relaunch on the persisted id). Returns the durability
 *  promise: save flows await it, the view's handlers fire and forget. */
export function resetWorkingEq(basePreset: EqPreset): Promise<void> {
  const previous = get(workingEq)
  const fresh = startSession(basePreset)
  workingEq.set(fresh)
  return persistTransition(previous, fresh)
}

// Page-lifecycle flush (viewState.ts's pattern) — the engine push is instant
// and the Dexie leg is what can be lost; guarded so a Node import stays
// side-effect-free.
if (typeof document !== 'undefined') {
  const flush = () => flushWorkingEqPersistence()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
  window.addEventListener('pagehide', flush)
  window.addEventListener('beforeunload', flush)
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

    // Load the persisted working state + base id.
    const savedState = await getSetting<EqPreset>(CURRENT_EQ_STATE_KEY)
    const savedPresetId = await getSetting<string>(ACTIVE_PRESET_KEY)

    // ONE restore write: the resolved session carries the base (the
    // selection) and the working values, and every derived reader follows it.
    // A saved overlay whose base row is gone (deleted preset, imported EQ)
    // self-bases, so the select names the EQ that actually restored.
    workingEq.set(
      resolveSession(savedState, savedPresetId, loadedUserPresets, BUILTIN_PRESETS[0])
    )

    // Bypass is a `persisted` store — restore it (idempotent) before any write.
    await _eqBypassed.restore()
  } catch (err) {
    console.error('Failed to initialize EQ store:', err)
  }
}

export function findPresetById(id: string): EqPreset | undefined {
  return BUILTIN_PRESETS.find((p) => p.id === id) || get(userPresets).find((p) => p.id === id)
}

/** Write a user preset row in place, or append it. */
async function writeUserPreset(preset: EqPreset): Promise<void> {
  await setSetting(`${USER_PRESET_PREFIX}${preset.id}`, preset)
  userPresets.update((list) => {
    const idx = list.findIndex((p) => p.id === preset.id)
    if (idx < 0) return [...list, preset]
    const updated = [...list]
    updated[idx] = preset
    return updated
  })
}

export async function deleteUserPreset(id: string): Promise<void> {
  if (BUILTIN_PRESETS.some((p) => p.id === id)) return // cannot delete built-in

  await db.userSettings.delete(`${USER_PRESET_PREFIX}${id}`)

  userPresets.update((list) => list.filter((p) => p.id !== id))

  if (get(activePresetId) === id) await resetWorkingEq(BUILTIN_PRESETS[0])
}

/** Select a preset: APPLY it (classic switch — a fresh selection discards the
 *  dirty overlay; the view asks before discarding). */
export async function applyPreset(id: string): Promise<EqPreset | undefined> {
  const preset = findPresetById(id)
  if (!preset) return undefined
  await resetWorkingEq(preset)
  return preset
}

/**
 * Unified save (2026-09-14 UX pass): ONE function behind the EQ's single
 * Save button. mode 'auto' (default): overwrite the active preset when it
 * is a user preset, otherwise (builtin or imported base) create a new
 * preset from the optional name (default `"<base> (modified)"`). mode
 * 'new': ALWAYS create a new preset — the explicit "Save as New" choice
 * (copy/duplicate), even when the base is a user preset the auto path
 * would have overwritten. Succeeds cleanly on a CLEAN session too (no-op
 * overwrite in 'auto') so the button never has to be disabled or
 * explained. Carries graphicEqCurves through (the old Save-as-Current
 * dropped them — a saved import lost its curve stack).
 */
export async function saveEqSession(name?: string, mode: 'auto' | 'new' = 'auto'): Promise<EqPreset> {
  const session = get(workingEq)
  const preset = findPresetById(session.base.id)
  const draft = session.state
  // The base id — NOT the selected preset's row — decides: an imported base
  // has no preset row at all (`findPresetById('imported')` is undefined), so
  // resolving through the selection's row would create a preset from the
  // WRONG name (or overwrite an unrelated user preset — found by the eqStore
  // test). The base is the session's own identity.
  const baseIsImport = session.base.id === 'imported'
  const asNew = mode === 'new' || !preset || preset.isBuiltin || baseIsImport

  // Overwrite keeps the preset's identity and takes the working values; a new
  // preset takes its name from the SESSION BASE (an import saved while 'Flat'
  // is selected must not call itself "Flat (modified)").
  const committed: EqPreset = asNew
    ? {
        id: `user_${Date.now()}`,
        name: name?.trim() || `${session.base.name ?? preset?.name ?? 'User'} (modified)`,
        mode: draft.mode,
        preampDb: draft.preampDb,
        filters: draft.filters.map((f) => ({ ...f })),
        graphicEqCurves: draft.graphicEqCurves?.map((c) => c.map((p) => ({ ...p }))),
        isBuiltin: false,
      }
    : {
        ...preset,
        mode: draft.mode,
        preampDb: draft.preampDb,
        filters: draft.filters.map((f) => ({ ...f })),
        graphicEqCurves: draft.graphicEqCurves?.map((c) => c.map((p) => ({ ...p }))),
      }

  await writeUserPreset(committed)
  await resetWorkingEq(committed)
  return committed
}

async function persistEqState(state: EqPreset, presetId: string): Promise<void> {
  await setSetting(CURRENT_EQ_STATE_KEY, state)
  await setSetting(ACTIVE_PRESET_KEY, presetId)
}
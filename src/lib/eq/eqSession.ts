import type { EqPreset } from './eqTypes'
import { BUILTIN_PRESETS } from './builtInPresets'

/**
 * Pure working-EQ session model: a DIRTY OVERLAY over the active preset.
 *
 * The working state survives leaving the EQ view (persisted by the store
 * layer's one transition path, eqStore) WITHOUT changing what "presets"
 * mean: `base` keeps a snapshot of the preset the session diverged from,
 * presets are never silently modified, and the dirty flag drives the UI's
 * "(edited)" marker.
 *
 * Persist policy lives HERE (one decision point, `planWorkingPersist`): a
 * dirty edit debounces, an unchanged session writes nothing, and any other
 * change — the working values (a revert) or the base id (preset selection,
 * import, Reset All, a save that creates a new preset with identical values)
 * — writes IMMEDIATELY and cancels a pending write, so a stale overlay can
 * never resurrect from disk. The engine push is NOT part of this module either:
 * eqEngineSync's subscription applies every session transition to the audio
 * instantly (engineFacade.applyEq); persistence is the only debounced leg.
 */

export const EQ_COMMIT_DEBOUNCE_MS = 600

export interface EqWorkingSession {
  /** Snapshot of the preset the session is based on (stable while dirty). */
  base: EqPreset
  /** The working copy — what the view renders and the engine plays. */
  state: EqPreset
  /** True when `state` deep-differs from `base`. */
  dirty: boolean
}

/** Deep structural equality for EqPreset values (order-sensitive arrays;
 *  `curve`/`graphicEqCurves` compared when present; identity ignored). */
export function sessionEqualsPreset(a: EqPreset, b: EqPreset): boolean {
  if (a.mode !== b.mode) return false
  if (a.preampDb !== b.preampDb) return false
  const af = a.filters
  const bf = b.filters
  if (af.length !== bf.length) return false
  for (let i = 0; i < af.length; i++) {
    const x = af[i]
    const y = bf[i]
    if (x.type !== y.type) return false
    if (x.frequency !== y.frequency) return false
    if (x.gain !== y.gain) return false
    if (x.q !== y.q) return false
    if (x.enabled !== y.enabled) return false
    // Absent curve IS 'parametric' (the field is optional by design) — an
    // explicit 'parametric' must not read as a difference.
    if ((x.curve ?? 'parametric') !== (y.curve ?? 'parametric')) return false
  }
  const ac = a.graphicEqCurves
  const bc = b.graphicEqCurves
  if (!ac !== !bc) return false
  if (ac && bc) {
    if (ac.length !== bc.length) return false
    for (let g = 0; g < ac.length; g++) {
      const ga = ac[g]
      const gb = bc[g]
      if (ga.length !== gb.length) return false
      for (let p = 0; p < ga.length; p++) {
        if (ga[p].frequency !== gb[p].frequency) return false
        if (ga[p].gainDb !== gb[p].gainDb) return false
      }
    }
  }
  return true
}

function clonePreset(p: EqPreset): EqPreset {
  // Preserve ABSENT optional keys: always writing `graphicEqCurves:
  // undefined` would make deep-equality against persisted rows (which lack
  // the key) fail and dirty a freshly-selected preset.
  const clone: EqPreset = { ...p, filters: p.filters.map((f) => ({ ...f })) }
  if (p.graphicEqCurves) {
    clone.graphicEqCurves = p.graphicEqCurves.map((c) => c.map((pt) => ({ ...pt })))
  }
  return clone
}

/** Start a CLEAN session from a preset (fresh selection, restore, import). */
export function startSession(basePreset: EqPreset): EqWorkingSession {
  return {
    base: clonePreset(basePreset),
    state: clonePreset(basePreset),
    dirty: false,
  }
}

/**
 * Apply an edit to the session. `dirty` is recomputed against the session's
 * own base — never set blindly true, so an edit that returns the working
 * state to the preset's exact values clears the marker.
 */
export function editDraft(
  session: EqWorkingSession,
  edit: (state: EqPreset) => EqPreset
): EqWorkingSession {
  const next = edit(clonePreset(session.state))
  return {
    base: session.base,
    state: next,
    dirty: !sessionEqualsPreset(next, session.base),
  }
}

/**
 * What the store layer does with a transition: 'none' writes nothing, 'debounce'
 * coalesces rapid slider moves (the engine push is never part of this), and
 * 'immediate' writes at once and drops any pending write — the new value
 * supersedes it. One field, because the two can never disagree.
 */
export type EqPersistMode = 'none' | 'debounce' | 'immediate'

/**
 * Persist policy for a session TRANSITION — the ONE decision point for what
 * reaches disk. Every trigger reduces to "did the working state change?":
 *
 * - the state and the base id are both unchanged → nothing to write;
 * - a DIRTY edit → debounce (a slider drag must not hammer Dexie);
 * - a CLEAN value or a different base id → write IMMEDIATELY and cancel any
 *   pending debounced write. That covers a new base (preset selection,
 *   import, Reset All), a revert back to the base, and a save that only moves
 *   the selection onto a new preset row.
 *
 * Keying on the CHANGE, never on the previous session's dirty flag, is what
 * makes an import over a clean session persist: `dirty` describes the new
 * session against its own base, and a fresh import is clean by construction,
 * so a dirty-only policy wrote NOTHING and the import died on relaunch. The
 * comparison covers a second import (same base id 'imported', different
 * state) AND a save-as-new of an unedited preset (same state, new base id —
 * a values-only comparison would lose the selection on relaunch).
 */
export function planWorkingPersist(
  previous: EqWorkingSession,
  next: EqWorkingSession
): EqPersistMode {
  const stateChanged = !sessionEqualsPreset(previous.state, next.state)
  const baseChanged = previous.base.id !== next.base.id
  if (!stateChanged && !baseChanged) return 'none'
  return stateChanged && next.dirty ? 'debounce' : 'immediate'
}

/**
 * Resolve the working session at boot from the persisted rows: the saved
 * overlay is re-based against the preset matching the persisted base id
 * (falling back through the state's own id, the state itself for imported
 * EQs, and finally the flat fallback). `savedBaseId` absent + a saved state
 * self-bases (legacy `current_eq_state` row). The persisted dirty flag is
 * recomputed, never trusted.
 */
export function resolveSession(
  savedState: EqPreset | undefined,
  savedBaseId: string | undefined,
  userPresets: EqPreset[],
  fallback: EqPreset
): EqWorkingSession {
  const findById = (id: string): EqPreset | undefined =>
    BUILTIN_PRESETS.find((p) => p.id === id) ?? userPresets.find((p) => p.id === id)
  const base =
    (savedBaseId ? findById(savedBaseId) : undefined) ??
    (savedState ? findById(savedState.id) : undefined) ??
    savedState ??
    fallback
  if (!savedState) return startSession(base)
  const session: EqWorkingSession = { base, state: savedState, dirty: false }
  session.dirty = !sessionEqualsPreset(session.state, base)
  return session
}


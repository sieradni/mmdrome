import type { EqPreset } from './eqTypes'
import { BUILTIN_PRESETS } from './builtInPresets'

/**
 * Pure working-EQ session model: a DIRTY OVERLAY over the active preset.
 *
 * The working state survives leaving the EQ view (debounce-persisted by the
 * store layer, eqStore.commitWorkingState) WITHOUT changing what "presets"
 * mean: `base` keeps a snapshot of the preset the session diverged from,
 * presets are never silently modified, and the dirty flag drives the UI's
 * "(edited)" marker.
 *
 * Persist policy lives HERE (one decision point): dirty → debounced write;
 * clean → no writes, and turning clean from dirty flushes IMMEDIATELY
 * (revert-to-preset, fresh selection, preset save) so a stale overlay can
 * never resurrect from disk. The engine push is NOT part of this module —
 * the view pushes on every edit so audio always matches the sliders
 * instantly; persistence is the only debounced leg.
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
 * Re-base a session on a NEW preset while keeping the working state (2026-
 * 09-15 preset-switch semantics): the user's edits survive the switch as a
 * dirty overlay over the newly selected preset — the sound never changes,
 * and "Save as Current" now correctly offers to overwrite the selection.
 * Dirty is recomputed against the new base (a switch to a preset that
 * happens to equal the working state lands clean, never fake-dirty).
 */
export function rebaseSession(
  session: EqWorkingSession,
  newBase: EqPreset
): EqWorkingSession {
  const next: EqWorkingSession = {
    base: clonePreset(newBase),
    state: session.state,
    dirty: false,
  }
  next.dirty = !sessionEqualsPreset(session.state, newBase)
  return next
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

export interface EqSessionPersistencePlan {
  /** The store layer must schedule (or run) a Dexie write of the session. */
  persist: boolean
  /** How to persist: 'debounce' coalesces rapid slider moves (the engine
   *  push is never part of this), 'immediate' writes synchronously. */
  mode: 'debounce' | 'immediate'
  /** The session turned clean — drop any pending debounced write first. */
  cancelPending: boolean
}

/**
 * Persist policy for the CURRENT session (pure, decided per state change):
 * dirty sessions debounce a write; clean sessions write nothing, and a
 * dirty→clean transition (revert, preset selection, preset save) cancels
 * the pending write and persists the clean state IMMEDIATELY so the row on
 * disk matches what the stores hold before the next slider move can start
 * a new debounce. `wasDirty` is the dirty flag before this change.
 */
export function planWorkingPersist(
  session: EqWorkingSession,
  wasDirty: boolean
): EqSessionPersistencePlan {
  if (session.dirty) {
    return { persist: true, mode: 'debounce', cancelPending: false }
  }
  return wasDirty
    ? { persist: true, mode: 'immediate', cancelPending: true }
    : { persist: false, mode: 'immediate', cancelPending: false }
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

/**
 * Pure restore decision: does the persisted working overlay survive the
 * boot, or did a newer preset selection win? applyPreset persists the
 * selection IMMEDIATELY while the overlay debounces — so when the persisted
 * base id and the persisted active id disagree, the selection is the newer
 * intent and the saved overlay must NOT resurrect over it.
 */
export function reconcileOnRestore(
  session: EqWorkingSession,
  activeId: string
): { adoptSaved: boolean; activePresetId: string } {
  if (session.base.id === activeId) {
    return { adoptSaved: true, activePresetId: activeId }
  }
  return { adoptSaved: false, activePresetId: activeId }
}

/** The id of the preset a session is based on (read-only convenience). */
export function sessionBaseId(session: EqWorkingSession): string {
  return session.base.id
}

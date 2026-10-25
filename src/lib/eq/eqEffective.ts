import { hasGraphicBands } from './eqCurveTopology'
import type { EqFilterConfig, EqPreset } from './eqTypes'

/**
 * The ONE owner of "what the engine will actually apply" for an EQ state.
 *
 * The UI renders from the working state; the engine applies a projection of
 * it — disabled bands are skipped, iOS runs a single AVAudioUnitEQ so only
 * the first 24 enabled bands exist at all, iOS has no convolver (an imported
 * GraphicEQ curve becomes per-band biquads), and a bypassed EQ applies
 * nothing but its own routing. Every surface that has to describe the sound
 * (the graph's response, a band row's "in effect" state, the notices, the
 * native snapshot) reads THIS projection instead of re-deriving it, so the
 * controls and the audio cannot drift apart.
 */

/** The iOS engine's single AVAudioUnitEQ band count (AudioEngine.swift). */
export const NATIVE_MAX_EQ_BANDS = 24

export interface EqPlatform {
  /** Bands the engine can run at all (Infinity = no limit). */
  maxBands: number
  /** Does the platform render an imported GraphicEQ curve stack verbatim?
   *  Web has a convolver for it; iOS has only parametric bands. */
  appliesCurves: boolean
}

export const WEB_EQ_PLATFORM: EqPlatform = { maxBands: Infinity, appliesCurves: true }
export const NATIVE_EQ_PLATFORM: EqPlatform = {
  maxBands: NATIVE_MAX_EQ_BANDS,
  appliesCurves: false,
}

/**
 * The response shape the engine renders:
 * - 'curve'      the imported GraphicEQ stack verbatim (web convolver);
 * - 'graphic'    ONE interpolated line through the enabled band points (web
 *                convolver for a hybrid EQ — a convolver cannot be mixed
 *                with the biquad chain);
 * - 'parametric' the sum of the band biquads (everything on iOS).
 */
export type EqPath = 'curve' | 'graphic' | 'parametric'

export interface AppliedEq {
  /** The bands the engine runs, in model order. */
  filters: EqFilterConfig[]
  /** Indices into the state's filters that are NOT in effect (disabled bands
   *  and anything past the platform's band limit). */
  inertIndices: ReadonlySet<number>
  /** The preamp the engine applies — 0 when bypassed (bypass is the whole EQ,
   *  preamp included). */
  preampDb: number
  path: EqPath
  /** Enabled bands the platform's band limit excludes (for the UI notice). */
  overLimit: number
}

/** True when the state's authoritative response is its imported curve stack.
 *  A state fact, not a row fact: an import saved as a preset keeps its
 *  curves, so it plays the stack too (web only — see EqPlatform). */
export function hasCurveStack(state: EqPreset): boolean {
  return state.mode === 'graphic' && !state.isBuiltin && !!state.graphicEqCurves?.length
}

/** Indices of the enabled bands the platform can run, in model order. A
 *  disabled band does not consume a band slot. */
export function applicableBandIndices(
  filters: EqFilterConfig[],
  platform: EqPlatform
): number[] {
  const out: number[] = []
  for (let i = 0; i < filters.length; i++) {
    if (!filters[i].enabled) continue
    if (out.length >= platform.maxBands) break
    out.push(i)
  }
  return out
}

/**
 * How a change reaches the engine, from the two band LISTS alone:
 *
 * - an array of indices when only live params moved (gain/frequency/Q) — the
 *   engine updates those in place and never rebuilds its chain (a slider drag
 *   is dozens of these per second; a rebuild per event is audible garbage);
 * - `null` when the band set itself changed (count, order, enabled, curve
 *   kind, filter type) — the engine must re-materialize its filters.
 *
 * Indices are MODEL indices: the web engine is handed the model's band list
 * and skips disabled bands itself (a gain of 0 cannot neutralize a
 * low/highpass), so its own band list stays index-aligned with the model.
 */
export function liveBandChanges(
  previous: EqFilterConfig[],
  next: EqFilterConfig[]
): number[] | null {
  if (previous.length !== next.length) return null
  const changed: number[] = []
  for (let i = 0; i < next.length; i++) {
    const a = previous[i]
    const b = next[i]
    if (a.type !== b.type || a.enabled !== b.enabled) return null
    if ((a.curve ?? 'parametric') !== (b.curve ?? 'parametric')) return null
    if (a.frequency !== b.frequency || a.gain !== b.gain || a.q !== b.q) changed.push(i)
  }
  return changed
}

/** Project a state onto what the engine applies on `platform`. */
export function resolveAppliedEq(
  state: EqPreset,
  platform: EqPlatform,
  bypassed: boolean
): AppliedEq {
  const applied = applicableBandIndices(state.filters, platform)
  const live = new Set(applied)
  const inertIndices = new Set<number>()
  let enabled = 0
  for (let i = 0; i < state.filters.length; i++) {
    if (!live.has(i)) inertIndices.add(i)
    if (state.filters[i].enabled) enabled++
  }
  return {
    filters: applied.map((i) => state.filters[i]),
    inertIndices,
    preampDb: bypassed ? 0 : state.preampDb,
    path: !platform.appliesCurves
      ? 'parametric'
      : hasCurveStack(state)
        ? 'curve'
        : hasGraphicBands(state.filters)
          ? 'graphic'
          : 'parametric',
    overLimit: enabled - applied.length,
  }
}

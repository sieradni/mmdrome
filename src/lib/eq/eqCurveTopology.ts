import type { EqCurveType, EqFilterConfig, EqPoint } from './eqTypes'

/**
 * Pure curve-topology core for the hybrid EQ model.
 *
 * A band's `curve` field (absent = 'parametric') decides how it renders and
 * is applied: 'parametric' = its own peaking/shelving biquad; 'graphic' = a
 * point on the interpolated curve (reached by linear log-frequency
 * interpolation from its neighbors, GraphicEQ-style).
 *
 * The user's neighborhood rule — "if the two points around it are
 * parametric, it transitions to non-parametric for that point" — is an
 * INSERTION rule: a newly added band is parametric only when BOTH existing
 * neighbors are parametric; touching the graphic curve (either side, or an
 * empty side next to a graphic band) makes it a curve point. Explicit flips
 * never cascade — flipping one point does not silently retype its
 * neighbors; the "flip all" control covers the whole-EQ switch.
 */

/** The effective curve type of a band (the field is optional by design). */
export function effectiveCurve(filter: EqFilterConfig): EqCurveType {
  return filter.curve ?? 'parametric'
}

/** Any enabled graphic band forces the whole EQ through the convolution
 *  path (parametric bands contribute their gain as points — mixing a
 *  biquad chain and a convolver in one signal path is not supported). */
export function hasGraphicBands(filters: EqFilterConfig[]): boolean {
  return filters.some((f) => f.enabled && effectiveCurve(f) === 'graphic')
}

/**
 * Curve type for a band inserted between `left` and `right` (either may be
 * null at the list edges): parametric only when BOTH neighbors exist and
 * are parametric — the user's rule. No neighbors (first band into an empty
 * EQ) → parametric.
 */
export function curveTypeForNewBand(
  left: EqFilterConfig | null,
  right: EqFilterConfig | null
): EqCurveType {
  if (left && effectiveCurve(left) === 'graphic') return 'graphic'
  if (right && effectiveCurve(right) === 'graphic') return 'graphic'
  if (!left || !right) {
    // Edge insert next to a parametric band: joining a parametric run is
    // the useful default (the grid grows); the curve is untouched.
    return 'parametric'
  }
  return 'parametric'
}

/** Explicitly flip ONE band's curve type (no neighbor cascades). */
export function withExplicitCurve(
  filters: EqFilterConfig[],
  index: number,
  curve: EqCurveType
): EqFilterConfig[] {
  return filters.map((f, i) => (i === index ? { ...f, curve } : f))
}

/** Flip EVERY band to the opposite curve type (the user-confirmed whole-EQ
 *  switch control). Bands missing the field count as parametric. */
export function flipAllCurveTypes(filters: EqFilterConfig[]): EqFilterConfig[] {
  return filters.map((f) => ({
    ...f,
    curve: effectiveCurve(f) === 'graphic' ? 'parametric' : 'graphic',
  }))
}

/**
 * All enabled bands as curve points (frequency-sorted) — the input to both
 * the graphic response calculator and the convolution engine path. Used
 * whenever any graphic band exists (hasGraphicBands) or by the graphic
 * import flow.
 */
export function bandsToCurvePoints(filters: EqFilterConfig[]): EqPoint[] {
  return filters
    .filter((f) => f.enabled)
    .map((f) => ({ frequency: f.frequency, gainDb: f.gain }))
    .sort((a, b) => a.frequency - b.frequency)
}

/**
 * Frequency for a new band: the geometric mean of the largest log-frequency
 * gap between consecutive bands (clamped to the audible 20 Hz–20 kHz range),
 * so "add band" always lands in the widest hole in the grid.
 */
export function suggestInsertFrequency(
  filters: EqFilterConfig[],
  minFreq = 20,
  maxFreq = 20000
): number {
  if (filters.length === 0) return 1000
  const sorted = [...filters].sort((a, b) => a.frequency - b.frequency)
  const clampedEdges = (f: number) => Math.min(Math.max(f, minFreq), maxFreq)
  // Candidate gaps include the outer edges (below the lowest, above the
  // highest band) so a dense mid-range still grows at the extremes.
  const gaps: { mid: number; width: number }[] = []
  const first = sorted[0].frequency
  const last = sorted[sorted.length - 1].frequency
  if (first > minFreq) {
    const lo = Math.max(minFreq, first / 4)
    gaps.push({ mid: Math.sqrt(lo * first), width: Math.log2(first / lo) })
  }
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i].frequency
    const b = sorted[i + 1].frequency
    if (b <= a) continue
    gaps.push({ mid: Math.sqrt(a * b), width: Math.log2(b / a) })
  }
  if (last < maxFreq) {
    const hi = Math.min(maxFreq, last * 4)
    gaps.push({ mid: Math.sqrt(last * hi), width: Math.log2(hi / last) })
  }
  if (gaps.length === 0) return clampedEdges(first)
  gaps.sort((x, y) => y.width - x.width)
  return Math.round(clampedEdges(gaps[0].mid))
}

/** Insert a band at `frequency` with the neighborhood rule's curve type. */
export function insertBandAt(
  filters: EqFilterConfig[],
  frequency: number,
  defaults: { gain?: number; q?: number; type?: EqFilterConfig['type'] } = {}
): EqFilterConfig[] {
  const sorted = [...filters].sort((a, b) => a.frequency - b.frequency)
  let rightIdx = sorted.findIndex((f) => f.frequency > frequency)
  if (rightIdx === -1) rightIdx = sorted.length
  const left = rightIdx > 0 ? sorted[rightIdx - 1] : null
  const right = rightIdx < sorted.length ? sorted[rightIdx] : null
  const band: EqFilterConfig = {
    type: defaults.type ?? 'peaking',
    frequency,
    gain: defaults.gain ?? 0,
    q: defaults.q ?? Math.SQRT1_2,
    enabled: true,
    curve: curveTypeForNewBand(left, right) === 'graphic' ? 'graphic' : undefined,
  }
  const next = [...sorted]
  next.splice(rightIdx, 0, band)
  return next
}

/** Remove a band by index (identity-stable for the rest). */
export function removeBandAt(filters: EqFilterConfig[], index: number): EqFilterConfig[] {
  return filters.filter((_, i) => i !== index)
}

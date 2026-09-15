/**
 * Pure spectrum-band model (2026-09-15) — the analytical half of the EQ
 * spectrum overlay, shared with the native engine's `SpectrumBands.swift`
 * (same edge ladder, same aggregation, same smoothing constants so both
 * platforms render the same picture).
 *
 * DOM/Web-Audio-free so it is unit-testable: the engine adapters hand in
 * raw FFT magnitudes (Web: AnalyserNode.getFloatFrequencyData; native:
 * Accelerate vDSP FFT), this module turns them into a per-band 0..1
 * display level with attack/release smoothing.
 *
 * Design notes:
 * - Bands are LOG-SPACED across 20 Hz–20 kHz (10 octaves). A linear FFT
 *   bin ladder puts 90% of its resolution above 2 kHz where music has the
 *   least energy — useless for "which frequencies to target". The band
 *   edges are computed in log space so each of the N bands covers the
 *   same PERCEPTUAL width.
 * - Sub-binwidth low bands (at 48 bands the 20–21 Hz band is narrower
 *   than one 44.1 kHz FFT bin) get a nearest-bin fallback instead of a
 *   silent zero: `mapBinsToBands` splits each bin across the bands it
 *   overlaps (energy-conserving), and a band with NO overlapping bin
 *   inherits the nearest bin that does.
 * - Normalization: dBm magnitudes (AnalyserNode units) map linearly from
 *   FLOOR_DB (silence) to CEIL_DB (loud). Music sits ~-90..-20 dBm
 *   depending on the source, so the default ceiling sits above typical
 *   program material; per-band peak-normalization was rejected — it makes
 *   noise look like signal at quiet passages.
 * - Smoothing: per-band exponential with ATTACK ~50 ms (fast rise, so
 *   transients read) and RELEASE ~180 ms (slow decay, so the picture is
 *   calm). Constants here mirror SpectrumBands.swift.
 */

/** The default band count. Both platforms ship this ladder. */
export const SPECTRUM_BAND_COUNT = 48
/** Bottom/top of the analysis range (matches the EQ graph's axis). */
export const SPECTRUM_MIN_HZ = 20
export const SPECTRUM_MAX_HZ = 20000
/** dBm normalization window (see module note). */
export const SPECTRUM_FLOOR_DB = -92
export const SPECTRUM_CEIL_DB = -22
/** Per-band smoothing time constants, seconds (mirrored in Swift). */
export const SPECTRUM_ATTACK_S = 0.05
export const SPECTRUM_RELEASE_S = 0.18

/** Geometric band edges: `count + 1` frequencies from MIN to MAX in Hz. */
export function spectrumBandEdges(
  count: number = SPECTRUM_BAND_COUNT,
  minHz: number = SPECTRUM_MIN_HZ,
  maxHz: number = SPECTRUM_MAX_HZ
): number[] {
  const lo = Math.log10(minHz)
  const hi = Math.log10(maxHz)
  const edges: number[] = []
  for (let i = 0; i <= count; i++) {
    edges.push(Math.pow(10, lo + ((hi - lo) * i) / count))
  }
  return edges
}

/**
 * Aggregate raw FFT magnitudes (dBm per bin) into per-band dBm values.
 * `binHz` is the frequency width of one bin; `magnitudes[i]` is bin i's
 * level. Energy-conserving split: a bin spanning several bands contributes
 * its value to EVERY overlapped band (bands are for display — a max/mean
 * would both be defensible; max preserves transients, mean smooths them —
 * max is chosen and mirrored in Swift). A band with no overlapping bin
 * (sub-binwidth lows) inherits the nearest overlapping bin's value.
 * Returns dBm per band (FLOOR_DB where there is no data at all).
 */
export function mapBinsToBands(
  magnitudes: Float32Array | number[],
  binHz: number,
  count: number = SPECTRUM_BAND_COUNT,
  minHz: number = SPECTRUM_MIN_HZ,
  maxHz: number = SPECTRUM_MAX_HZ
): number[] {
  const out = new Array<number>(count).fill(SPECTRUM_FLOOR_DB)
  if (binHz <= 0 || magnitudes.length === 0) return out
  const edges = spectrumBandEdges(count, minHz, maxHz)

  // Bands the bins reached (drives the sub-binwidth inheritance pass).
  const touched = new Array<boolean>(count).fill(false)

  for (let b = 0; b < magnitudes.length; b++) {
    const fLo = b * binHz
    const fHi = fLo + binHz
    if (fHi <= minHz) continue
    if (fLo >= maxHz) break
    const v = magnitudes[b]
    if (!Number.isFinite(v)) continue
    // Bands overlapped by [fLo, fHi): first band whose upper edge > fLo,
    // through the last whose lower edge < fHi.
    let i = 0
    while (i < count && edges[i + 1] <= fLo) i++
    for (; i < count && edges[i] < fHi; i++) {
      out[i] = Math.max(out[i], v)
      touched[i] = true
    }
  }

  // Sub-binwidth inheritance: a band the bins never reached (between DC
  // and the first covered band) inherits from the first covered band
  // toward the lows.
  let carry: number | null = null
  for (let i = count - 1; i >= 0; i--) {
    if (touched[i]) {
      carry = out[i]
    } else if (carry !== null) {
      out[i] = carry
    }
  }
  return out
}

/** dBm → display level 0..1 against the floor/ceiling window. */
export function dbToLevel(db: number): number {
  const t = (db - SPECTRUM_FLOOR_DB) / (SPECTRUM_CEIL_DB - SPECTRUM_FLOOR_DB)
  return Math.max(0, Math.min(1, t))
}

/** Per-band attack/release smoothing step. `held` is the previous smoothed
 *  value, `target` the raw level this frame; `dt` the frame seconds. */
export function smoothBand(held: number, target: number, dt: number): number {
  const rate = target > held ? SPECTRUM_ATTACK_S : SPECTRUM_RELEASE_S
  const alpha = 1 - Math.exp(-dt / Math.max(rate, 1e-4))
  return held + (target - held) * alpha
}

/**
 * Which of the display bands are inside the graph's current view window —
 * the overlay renders only the visible slice (the view pans/zooms).
 * Returns the 0..1 levels re-indexed to the VISIBLE bands, plus the
 * frequency of the first visible band edge so the renderer can anchor x.
 */
export function visibleBands(
  levels: number[],
  edges: number[],
  viewMinHz: number,
  viewMaxHz: number
): { levels: number[]; startEdgeHz: number; endEdgeHz: number } {
  let first = edges.length - 1
  let last = 0
  for (let i = 0; i < edges.length - 1; i++) {
    if (edges[i + 1] > viewMinHz && edges[i] < viewMaxHz) {
      if (i < first) first = i
      if (i > last) last = i
    }
  }
  if (first > last) return { levels: [], startEdgeHz: viewMinHz, endEdgeHz: viewMaxHz }
  return {
    levels: levels.slice(first, last + 1),
    startEdgeHz: Math.max(edges[first], viewMinHz),
    endEdgeHz: Math.min(edges[last + 1], viewMaxHz),
  }
}

/** One smoothing step across a whole band array (convenience). */
export function smoothBands(held: number[], target: number[], dt: number): number[] {
  const out = new Array<number>(held.length)
  for (let i = 0; i < held.length; i++) {
    out[i] = smoothBand(held[i] ?? 0, target[i] ?? 0, dt)
  }
  return out
}

/**
 * Into-variant of `mapBinsToBands` + `dbToLevel` for the hot path: writes
 * normalized 0..1 band levels straight into `outBands` (a reused
 * Float32Array) without per-frame allocations. Same aggregation/inheritance
 * semantics as `mapBinsToBands`.
 */
export function mapBinsToBandsInto(
  magnitudes: Float32Array,
  binHz: number,
  outBands: Float32Array,
  minHz: number = SPECTRUM_MIN_HZ,
  maxHz: number = SPECTRUM_MAX_HZ
): void {
  const count = outBands.length
  outBands.fill(0)
  if (binHz <= 0 || magnitudes.length === 0) return
  const edges = spectrumBandEdges(count, minHz, maxHz)
  const touched = new Array<boolean>(count).fill(false)

  for (let b = 0; b < magnitudes.length; b++) {
    const fLo = b * binHz
    const fHi = fLo + binHz
    if (fHi <= minHz) continue
    if (fLo >= maxHz) break
    const v = magnitudes[b]
    if (!Number.isFinite(v)) continue
    const level = dbToLevel(v)
    let i = 0
    while (i < count && edges[i + 1] <= fLo) i++
    for (; i < count && edges[i] < fHi; i++) {
      if (level > outBands[i]) outBands[i] = level
      touched[i] = true
    }
  }

  // Sub-binwidth inheritance toward the lows (see mapBinsToBands).
  let carry: number | null = null
  for (let i = count - 1; i >= 0; i--) {
    if (touched[i]) carry = outBands[i]
    else if (carry !== null) outBands[i] = carry
  }
}

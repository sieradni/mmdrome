import type { EqPreset, EqFilterConfig } from './eqTypes'

export const DEFAULT_GRAPHIC_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
const DEFAULT_BAND_Q = Math.SQRT1_2

/**
 * Merge imported EQ filters onto the 10-band default grid.
 * Filters close to a standard band (< 1/3 octave) set that band's gain/type/Q.
 * Unmatched filters are returned as extras (appended after the 10-band).
 */
export function mergeFiltersIntoDefaultGrid(
  importedFilters: EqFilterConfig[]
): { baseFilters: EqFilterConfig[]; extraFilters: EqFilterConfig[] } {
  const baseFilters: EqFilterConfig[] = DEFAULT_GRAPHIC_FREQUENCIES.map((freq) => ({
    type: 'peaking',
    frequency: freq,
    gain: 0,
    q: DEFAULT_BAND_Q,
    enabled: true,
  }))

  const usedImportIndices = new Set<number>()

  for (let i = 0; i < DEFAULT_GRAPHIC_FREQUENCIES.length; i++) {
    let bestMatch: { index: number; deviation: number } | null = null

    for (let j = 0; j < importedFilters.length; j++) {
      if (usedImportIndices.has(j)) continue
      const ratio = Math.max(
        importedFilters[j].frequency / DEFAULT_GRAPHIC_FREQUENCIES[i],
        DEFAULT_GRAPHIC_FREQUENCIES[i] / importedFilters[j].frequency
      )
      if (ratio < 1.26) {
        if (!bestMatch || ratio < bestMatch.deviation) {
          bestMatch = { index: j, deviation: ratio }
        }
      }
    }

    if (bestMatch) {
      const imp = importedFilters[bestMatch.index]
      baseFilters[i] = {
        type: imp.type,
        frequency: DEFAULT_GRAPHIC_FREQUENCIES[i],
        gain: imp.gain,
        q: imp.q,
        enabled: imp.enabled,
      }
      usedImportIndices.add(bestMatch.index)
    }
  }

  const extraFilters = importedFilters
    .filter((_, i) => !usedImportIndices.has(i))
    .map((f) => ({ ...f }))

  return { baseFilters, extraFilters }
}

function createGraphicPreset(id: string, name: string, gains: number[], preampDb = 0): EqPreset {
  return {
    id,
    name,
    isBuiltin: true,
    mode: 'graphic',
    preampDb,
    filters: DEFAULT_GRAPHIC_FREQUENCIES.map((freq, i) => ({
      type: 'peaking',
      frequency: freq,
      gain: gains[i] ?? 0,
      q: 1.41,
      enabled: true,
    })),
  }
}

export const BUILTIN_PRESETS: EqPreset[] = [
  createGraphicPreset('flat', 'Flat', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  createGraphicPreset('bass_boost', 'Bass Boost', [6, 5, 4, 2, 0, 0, 0, 0, 0, 0], -3),
  createGraphicPreset('treble_boost', 'Treble Boost', [0, 0, 0, 0, 0, 1, 2.5, 4, 5, 6], -3),
  createGraphicPreset('mid_boost', 'Mid Range Boost', [-2, -1, 1, 2.5, 4, 3.5, 2, 0, -1, -2], -2),
  createGraphicPreset('v_shape', 'V Shape', [5, 4, 2, -1, -3, -3, -1, 2, 4.5, 6], -3),
]

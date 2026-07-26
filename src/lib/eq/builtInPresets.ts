import type { EqPreset } from './eqTypes'

export const DEFAULT_GRAPHIC_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

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

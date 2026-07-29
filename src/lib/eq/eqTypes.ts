export const DEFAULT_EQ_Q = Math.SQRT1_2

export type EqFilterType =
  | 'peaking'
  | 'lowshelf'
  | 'highshelf'
  | 'lowpass'
  | 'highpass'
  | 'bandpass'
  | 'notch'

export interface EqFilterConfig {
  type: EqFilterType
  frequency: number
  gain: number
  q: number
  enabled: boolean
}

/** A single GraphicEQ frequency-gain point */
export interface EqPoint {
  frequency: number
  gainDb: number
}

export interface EqPreset {
  id: string
  name: string
  isBuiltin?: boolean
  mode: 'graphic' | 'parametric'
  preampDb: number
  filters: EqFilterConfig[]
  rawText?: string
  /** Separate GraphicEQ curve groups for stacked lines */
  graphicEqCurves?: EqPoint[][]
}

export interface ParseEqResult {
  preampDb: number
  filters: EqFilterConfig[]
  errors: string[]
  mode: 'graphic' | 'parametric'
  /** Separate GraphicEQ curve groups (each array is one GraphicEQ: line) */
  graphicEqCurves?: EqPoint[][]
}

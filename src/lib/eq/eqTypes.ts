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

export interface EqPreset {
  id: string
  name: string
  isBuiltin?: boolean
  mode: 'graphic' | 'parametric'
  preampDb: number
  filters: EqFilterConfig[]
  rawText?: string
}

export interface ParseEqResult {
  preampDb: number
  filters: EqFilterConfig[]
  errors: string[]
  mode: 'graphic' | 'parametric'
}

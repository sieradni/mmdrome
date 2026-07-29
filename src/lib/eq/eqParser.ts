import { DEFAULT_EQ_Q } from './eqTypes'
import type { EqFilterConfig, EqFilterType, ParseEqResult } from './eqTypes'

const FILTER_TYPE_MAP: Record<string, EqFilterType> = {
  PK: 'peaking',
  PEK: 'peaking',
  PEAK: 'peaking',
  PEAKING: 'peaking',
  LSC: 'lowshelf',
  LS: 'lowshelf',
  LOWSHELF: 'lowshelf',
  'LOW-SHELF': 'lowshelf',
  HSC: 'highshelf',
  HS: 'highshelf',
  HIGHSHELF: 'highshelf',
  'HIGH-SHELF': 'highshelf',
  LP: 'lowpass',
  LPK: 'lowpass',
  LOWPASS: 'lowpass',
  'LOW-PASS': 'lowpass',
  HP: 'highpass',
  HPK: 'highpass',
  HIGHPASS: 'highpass',
  'HIGH-PASS': 'highpass',
  BP: 'bandpass',
  BANDPASS: 'bandpass',
  NO: 'notch',
  NOTCH: 'notch',
}

/**
 * Parses AutoEQ, EqualizerAPO, Peace EQ, or GraphicEQ formatted text configurations.
 */
export function parseEqText(text: string): ParseEqResult {
  const lines = text.split(/\r?\n/)
  let preampDb = 0
  const filters: EqFilterConfig[] = []
  const errors: string[] = []
  let mode: 'graphic' | 'parametric' = 'parametric'

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim()
    if (!rawLine || rawLine.startsWith('#') || rawLine.startsWith('//')) {
      continue
    }

    // Check for Preamp setting
    const preampMatch = rawLine.match(/^Preamp:\s*(-?[\d.]+)\s*dB/i)
    if (preampMatch) {
      const val = parseFloat(preampMatch[1])
      if (!isNaN(val)) {
        preampDb = val
      }
      continue
    }

    // Check for GraphicEQ setting
    if (rawLine.startsWith('GraphicEQ:')) {
      mode = 'graphic'
      const dataStr = rawLine.slice(10).trim()
      const pairs = dataStr.split(';').map((s) => s.trim()).filter(Boolean)
      for (const pair of pairs) {
        const parts = pair.split(/\s+/)
        if (parts.length >= 2) {
          const freq = parseFloat(parts[0])
          const gain = parseFloat(parts[1])
          if (!isNaN(freq) && !isNaN(gain)) {
            filters.push({
              type: 'peaking',
              frequency: freq,
              gain,
              q: DEFAULT_EQ_Q,
              enabled: true,
            })
          }
        }
      }
      continue
    }

    // Check for Parametric Filter line
    // Standard AutoEQ line format variants:
    // Filter 1: ON PK Fc 31.0 Hz Gain 2.5 dB Q 1.41
    // Filter: 1 PK Fc 31.0 Hz Gain 2.5 dB Q 0.70
    // Filter 1: ON LSC Fc 105 Hz Gain 3.0 dB Q 0.70
    const filterMatch = rawLine.match(
      /^(?:Filter|Param)?\s*:?\s*(\d+)?\s*:?\s*(ON|OFF)?\s*([a-zA-Z-]+)\s+(?:Fc\s+)?([\d.]+)\s*Hz\s+(?:Gain\s+)?(-?[\d.]+)\s*dB\s+(?:Q\s+)?([\d.]+)/i
    )

    if (filterMatch) {
      const status = filterMatch[2] ? filterMatch[2].toUpperCase() : 'ON'
      const rawType = filterMatch[3].toUpperCase()
      const freq = parseFloat(filterMatch[4])
      const gain = parseFloat(filterMatch[5])
      const q = parseFloat(filterMatch[6])

      const filterType = FILTER_TYPE_MAP[rawType] || 'peaking'

      if (!isNaN(freq) && !isNaN(gain) && !isNaN(q)) {
        filters.push({
          type: filterType,
          frequency: freq,
          gain,
          q,
          enabled: status !== 'OFF',
        })
      } else {
        errors.push(`Line ${i + 1}: Invalid numerical parameters.`)
      }
      continue
    }

    // If line is not empty and didn't match known patterns, record notice if non-comment
    if (!rawLine.toLowerCase().startsWith('stage:')) {
      errors.push(`Line ${i + 1}: Unrecognized syntax "${rawLine}"`)
    }
  }

  return { preampDb, filters, errors, mode }
}

/**
 * Formats a list of filters and preamp gain into EqualizerAPO / AutoEQ text format.
 */
export function formatEqText(preampDb: number, filters: EqFilterConfig[]): string {
  const lines: string[] = []
  if (preampDb !== 0) {
    lines.push(`Preamp: ${preampDb > 0 ? '+' : ''}${preampDb.toFixed(1)} dB`)
  }

  const typeReverseMap: Record<EqFilterType, string> = {
    peaking: 'PK',
    lowshelf: 'LSC',
    highshelf: 'HSC',
    lowpass: 'LP',
    highpass: 'HP',
    bandpass: 'BP',
    notch: 'NO',
  }

  filters.forEach((f, index) => {
    const status = f.enabled ? 'ON' : 'OFF'
    const typeStr = typeReverseMap[f.type] || 'PK'
    const freqStr = f.frequency >= 1000 ? `${(f.frequency / 1000).toFixed(1)}k` : `${Math.round(f.frequency)}`
    lines.push(
      `Filter ${index + 1}: ${status} ${typeStr} Fc ${freqStr} Hz Gain ${f.gain >= 0 ? '+' : ''}${f.gain.toFixed(1)} dB Q ${f.q.toFixed(2)}`
    )
  })

  return lines.join('\n')
}

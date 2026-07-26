import type { EqFilterConfig } from './eqTypes'

export interface FrequencyPoint {
  frequency: number
  gainDb: number
}

const SAMPLE_RATE = 48000

function calculateBiquadResponse(
  filter: EqFilterConfig,
  frequencies: Float32Array
): Float32Array {
  const response = new Float32Array(frequencies.length)
  if (!filter.enabled) return response

  const f0 = filter.frequency
  const gain = filter.gain
  const Q = Math.max(0.01, filter.q)
  const type = filter.type

  const w0 = (2 * Math.PI * f0) / SAMPLE_RATE
  const cosW0 = Math.cos(w0)
  const sinW0 = Math.sin(w0)
  const alpha = sinW0 / (2 * Q)
  const A = Math.pow(10, gain / 40)

  let b0 = 0,
    b1 = 0,
    b2 = 0,
    a0 = 1,
    a1 = 0,
    a2 = 0

  switch (type) {
    case 'peaking':
      b0 = 1 + alpha * A
      b1 = -2 * cosW0
      b2 = 1 - alpha * A
      a0 = 1 + alpha / A
      a1 = -2 * cosW0
      a2 = 1 - alpha / A
      break
    case 'lowshelf': {
      const sqrtA = Math.sqrt(A)
      b0 = A * (A + 1 - (A - 1) * cosW0 + 2 * sqrtA * alpha)
      b1 = 2 * A * (A - 1 - (A + 1) * cosW0)
      b2 = A * (A + 1 - (A - 1) * cosW0 - 2 * sqrtA * alpha)
      a0 = A + 1 + (A - 1) * cosW0 + 2 * sqrtA * alpha
      a1 = -2 * (A - 1 + (A + 1) * cosW0)
      a2 = A + 1 + (A - 1) * cosW0 - 2 * sqrtA * alpha
      break
    }
    case 'highshelf': {
      const sqrtA = Math.sqrt(A)
      b0 = A * (A + 1 + (A - 1) * cosW0 + 2 * sqrtA * alpha)
      b1 = -2 * A * (A - 1 + (A + 1) * cosW0)
      b2 = A * (A + 1 + (A - 1) * cosW0 - 2 * sqrtA * alpha)
      a0 = A + 1 - (A - 1) * cosW0 + 2 * sqrtA * alpha
      a1 = 2 * (A - 1 - (A + 1) * cosW0)
      a2 = A + 1 - (A - 1) * cosW0 - 2 * sqrtA * alpha
      break
    }
    case 'lowpass':
      b0 = (1 - cosW0) / 2
      b1 = 1 - cosW0
      b2 = (1 - cosW0) / 2
      a0 = 1 + alpha
      a1 = -2 * cosW0
      a2 = 1 - alpha
      break
    case 'highpass':
      b0 = (1 + cosW0) / 2
      b1 = -(1 + cosW0)
      b2 = (1 + cosW0) / 2
      a0 = 1 + alpha
      a1 = -2 * cosW0
      a2 = 1 - alpha
      break
    case 'bandpass':
      b0 = alpha
      b1 = 0
      b2 = -alpha
      a0 = 1 + alpha
      a1 = -2 * cosW0
      a2 = 1 - alpha
      break
    case 'notch':
      b0 = 1
      b1 = -2 * cosW0
      b2 = 1
      a0 = 1 + alpha
      a1 = -2 * cosW0
      a2 = 1 - alpha
      break
  }

  // Normalize coefficients
  const nb0 = b0 / a0
  const nb1 = b1 / a0
  const nb2 = b2 / a0
  const na1 = a1 / a0
  const na2 = a2 / a0

  for (let i = 0; i < frequencies.length; i++) {
    const freq = frequencies[i]
    if (freq >= SAMPLE_RATE / 2) {
      response[i] = 0
      continue
    }

    const w = (2 * Math.PI * freq) / SAMPLE_RATE
    const cosW = Math.cos(w)
    const sinW = Math.sin(w)
    const cos2W = Math.cos(2 * w)
    const sin2W = Math.sin(2 * w)

    const numReal = nb0 + nb1 * cosW + nb2 * cos2W
    const numImag = -(nb1 * sinW + nb2 * sin2W)
    const denReal = 1 + na1 * cosW + na2 * cos2W
    const denImag = -(na1 * sinW + na2 * sin2W)

    const numMagSq = numReal * numReal + numImag * numImag
    const denMagSq = denReal * denReal + denImag * denImag

    if (denMagSq > 0) {
      const magRatio = Math.sqrt(numMagSq / denMagSq)
      response[i] = 20 * Math.log10(Math.max(1e-6, magRatio))
    } else {
      response[i] = 0
    }
  }

  return response
}

/**
 * Calculates total frequency response curve in dB across 20Hz - 20kHz.
 */
export function calculateTotalResponse(
  preampDb: number,
  filters: EqFilterConfig[],
  pointCount = 150
): FrequencyPoint[] {
  const minFreq = 20
  const maxFreq = 20000
  const logMin = Math.log10(minFreq)
  const logMax = Math.log10(maxFreq)

  const freqs = new Float32Array(pointCount)
  for (let i = 0; i < pointCount; i++) {
    const logF = logMin + (i / (pointCount - 1)) * (logMax - logMin)
    freqs[i] = Math.pow(10, logF)
  }

  const totalGains = new Float32Array(pointCount)
  totalGains.fill(preampDb)

  for (const filter of filters) {
    if (!filter.enabled) continue
    const filterGains = calculateBiquadResponse(filter, freqs)
    for (let i = 0; i < pointCount; i++) {
      totalGains[i] += filterGains[i]
    }
  }

  const points: FrequencyPoint[] = []
  for (let i = 0; i < pointCount; i++) {
    points.push({
      frequency: freqs[i],
      gainDb: totalGains[i],
    })
  }

  return points
}

import type { EqFilterConfig } from './eqTypes'

export interface Point {
  frequency: number
  gainDb: number
}

/**
  Radix-2 Cooley-Tukey FFT / IFFT for power-of-two size N.
 */
function fftRadix2(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length
  if ((n & (n - 1)) !== 0) {
    throw new Error('FFT length must be a power of 2')
  }

  // Bit reversal permutation
  let j = 0
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      const tempRe = re[i]
      re[i] = re[j]
      re[j] = tempRe

      const tempIm = im[i]
      im[i] = im[j]
      im[j] = tempIm
    }
    let k = n >> 1
    while (k >= 1 && k <= j) {
      j -= k
      k >>= 1
    }
    j += k
  }

  // Butterfly stages
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1
    const angle = (inverse ? 2 : -2) * Math.PI / len
    const wStepRe = Math.cos(angle)
    const wStepIm = Math.sin(angle)

    for (let i = 0; i < n; i += len) {
      let wRe = 1.0
      let wIm = 0.0
      for (let k = 0; k < halfLen; k++) {
        const uRe = re[i + k]
        const uIm = im[i + k]

        const vIndex = i + k + halfLen
        const vRe = re[vIndex] * wRe - im[vIndex] * wIm
        const vIm = re[vIndex] * wIm + im[vIndex] * wRe

        re[i + k] = uRe + vRe
        im[i + k] = uIm + vIm
        re[vIndex] = uRe - vRe
        im[vIndex] = uIm - vIm

        const nextWRe = wRe * wStepRe - wIm * wStepIm
        const nextWIm = wRe * wStepIm + wIm * wStepRe
        wRe = nextWRe
        wIm = nextWIm
      }
    }
  }

  // Scaling on IFFT
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n
      im[i] /= n
    }
  }
}

/**
 * Linearly interpolates gain (dB) on a log-frequency axis.
 */
export function interpolateGraphicEqPoints(points: Point[], targetFreq: number): number {
  if (points.length === 0) return 0
  if (points.length === 1) return points[0].gainDb

  if (targetFreq <= points[0].frequency) {
    return points[0].gainDb
  }
  if (targetFreq >= points[points.length - 1].frequency) {
    return points[points.length - 1].gainDb
  }

  // Binary search or linear scan
  for (let i = 0; i < points.length - 1; i++) {
    const f0 = points[i].frequency
    const f1 = points[i + 1].frequency
    if (targetFreq >= f0 && targetFreq <= f1) {
      const logF = Math.log10(targetFreq)
      const logF0 = Math.log10(f0)
      const logF1 = Math.log10(f1)
      if (logF1 === logF0) return points[i].gainDb
      const t = (logF - logF0) / (logF1 - logF0)
      return points[i].gainDb + t * (points[i + 1].gainDb - points[i].gainDb)
    }
  }

  return 0
}

/**
 * Extracts frequency-gain pairs from EqFilterConfig array.
 */
export function filtersToPoints(filters: EqFilterConfig[]): Point[] {
  return filters
    .filter((f) => f.enabled)
    .map((f) => ({ frequency: f.frequency, gainDb: f.gain }))
    .sort((a, b) => a.frequency - b.frequency)
}

/**
 * Generates a minimum-phase impulse response from a GraphicEQ curve via real cepstrum minimum-phase reconstruction.
 *
 * @param points Array of { frequency, gainDb }
 * @param sampleRate AudioContext sample rate (e.g. 44100, 48000)
 * @param fftSize FFT length, must be a power of two (default 4096)
 * @returns Float32Array containing time-domain impulse response
 */
export function generateMinimumPhaseIR(
  points: Point[],
  sampleRate = 48000,
  fftSize = 4096
): Float32Array {
  const sortedPoints = [...points].sort((a, b) => a.frequency - b.frequency)
  const half = fftSize / 2

  // 1. Compute target magnitude response at each FFT frequency bin
  const logMag = new Float64Array(fftSize)
  const im = new Float64Array(fftSize)

  const minValDb = -60 // clamp floor for log(0) safety

  for (let k = 0; k <= half; k++) {
    const freq = (k * sampleRate) / fftSize
    // Use DC frequency as lowest point frequency
    const evalFreq = Math.max(20, freq)
    const gainDb = sortedPoints.length > 0 ? interpolateGraphicEqPoints(sortedPoints, evalFreq) : 0
    const clampedDb = Math.max(minValDb, Math.min(36, gainDb))
    // Linear amplitude = 10^(dB / 20)
    const amplitude = Math.pow(10, clampedDb / 20)
    const logAmp = Math.log(Math.max(1e-6, amplitude))

    logMag[k] = logAmp
    if (k > 0 && k < half) {
      logMag[fftSize - k] = logAmp // Hermitian symmetry
    }
  }

  // 2. Real Cepstrum computation: IFFT of log magnitude
  fftRadix2(logMag, im, true) // inverse transform: logMag now holds real cepstrum c[n]

  // 3. Minimum-phase foldover windowing in cepstral domain
  // w[0] = 1, w[N/2] = 1, w[n] = 2 (1 <= n < N/2), w[n] = 0 (N/2 < n < N)
  const cepstrumRe = new Float64Array(fftSize)
  const cepstrumIm = new Float64Array(fftSize)

  cepstrumRe[0] = logMag[0]
  cepstrumRe[half] = logMag[half]
  for (let n = 1; n < half; n++) {
    cepstrumRe[n] = 2.0 * logMag[n]
  }
  // n > half are left as 0

  // 4. Forward FFT of windowed cepstrum -> gives min-phase complex log spectrum L_min[k]
  fftRadix2(cepstrumRe, cepstrumIm, false)

  // 5. Exponentiate complex spectrum to get min-phase frequency response H[k]
  // exp(a + j*b) = exp(a) * (cos(b) + j*sin(b))
  const specRe = new Float64Array(fftSize)
  const specIm = new Float64Array(fftSize)

  for (let k = 0; k < fftSize; k++) {
    const mag = Math.exp(cepstrumRe[k])
    const phase = cepstrumIm[k]
    specRe[k] = mag * Math.cos(phase)
    specIm[k] = mag * Math.sin(phase)
  }

  // 6. IFFT of minimum-phase spectrum -> gives minimum-phase time-domain impulse response h[n]
  fftRadix2(specRe, specIm, true)

  // 7. Apply a smooth tail taper (last 10% of buffer) to guarantee no end discontinuity
  const output = new Float32Array(fftSize)
  const taperLen = Math.floor(fftSize * 0.1)
  const taperStart = fftSize - taperLen

  for (let n = 0; n < fftSize; n++) {
    let val = specRe[n]
    if (n >= taperStart) {
      const progress = (n - taperStart) / taperLen
      // Hann taper window
      const win = 0.5 * (1 + Math.cos(Math.PI * progress))
      val *= win
    }
    output[n] = val
  }

  return output
}

/**
 * Creates an AudioBuffer containing the minimum-phase impulse response.
 */
export function createGraphicEqAudioBuffer(
  ctx: AudioContext,
  points: Point[],
  fftSize = 4096
): AudioBuffer {
  const irData = generateMinimumPhaseIR(points, ctx.sampleRate, fftSize)
  // Stereo impulse response buffer with identical left/right channels
  const buffer = ctx.createBuffer(2, irData.length, ctx.sampleRate)
  buffer.getChannelData(0).set(irData)
  buffer.getChannelData(1).set(irData)
  return buffer
}

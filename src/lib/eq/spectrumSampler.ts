/**
 * Spectrum sampler (2026-09-15) — drives the EQ overlay's data cadence.
 *
 * Owns ONE requestAnimationFrame loop: each frame pulls a band snapshot
 * from the engine facade (web: synchronous AnalyserNode read; native: a
 * bridge `getSpectrum` call), normalizes/aggregates via the pure
 * `spectrumCore`, applies per-band attack/release smoothing, and hands the
 * caller a callback. The loop is idempotent to start/stop, decays to
 * silence (never freezes) when the engine reports not-playing, and exists
 * ONLY while the EQ view is mounted — no global timers.
 *
 * Native cadence: rAF fires 60–120 Hz but a bridge round-trip per frame is
 * wasteful; the sampler coalesces to ~20 Hz on native (50 ms) and reads
 * every frame on web (the analyser read is a typed-array copy, ~µs).
 */

import {
  SPECTRUM_BAND_COUNT,
  smoothBands,
} from './spectrumCore'

interface SpectrumSource {
  /** One frame → per-band 0..1 levels into `out`; false = no audio data. */
  readSpectrumBands(out: Float32Array): Promise<boolean>
}

export class SpectrumSampler {
  private source: SpectrumSource
  private onFrame: (levels: Float32Array) => void
  private native: boolean

  private rafId: number | null = null
  private running = false
  private lastT = 0
  private lastNativePull = 0
  /** Smoothed levels — what the caller renders. */
  readonly levels = new Float32Array(SPECTRUM_BAND_COUNT)
  /** Raw target levels from the latest frame (for the decay path). */
  private target = new Float32Array(SPECTRUM_BAND_COUNT)
  /** Fallback decay rate for frames with no data (dB-equiv per second). */
  private static readonly DECAY_PER_S = 2.5
  private static readonly NATIVE_MIN_INTERVAL_MS = 50

  constructor(source: SpectrumSource, onFrame: (levels: Float32Array) => void, native: boolean) {
    this.source = source
    this.onFrame = onFrame
    this.native = native
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.lastT = performance.now()
    const tick = (t: number) => {
      if (!this.running) return
      const dt = Math.min((t - this.lastT) / 1000, 0.1)
      this.lastT = t
      void this.pull(dt)
      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)
  }

  stop(): void {
    this.running = false
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  private async pull(dt: number): Promise<void> {
    const now = performance.now()
    if (this.native && now - this.lastNativePull < SpectrumSampler.NATIVE_MIN_INTERVAL_MS) {
      // Between native pulls: just re-emit the smoothed state (release
      // continues smoothly at the display cadence).
      this.onFrame(this.levels)
      return
    }
    this.lastNativePull = now

    let got = false
    try {
      got = await this.source.readSpectrumBands(this.target)
    } catch {
      got = false
    }

    if (got) {
      const smoothed = smoothBands(Array.from(this.levels), Array.from(this.target), dt)
      for (let i = 0; i < this.levels.length; i++) this.levels[i] = smoothed[i] ?? 0
    } else {
      // No data (paused / no engine): decay toward silence so the overlay
      // never freezes on the last real frame.
      const decay = Math.max(0, 1 - SpectrumSampler.DECAY_PER_S * dt)
      for (let i = 0; i < this.levels.length; i++) {
        this.levels[i] = this.levels[i] * decay
        if (this.levels[i] < 0.005) this.levels[i] = 0
      }
    }
    this.onFrame(this.levels)
  }
}

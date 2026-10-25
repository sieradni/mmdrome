import { Capacitor } from '@capacitor/core'
import { audioManager } from './audioManager'
import { BackgroundAudio, type NativeFilterSnapshot } from './nativePlugin'
import { playbackSpeed, pitchOctaves, tapeMode, snapTolerance, masterGain } from '../stores/appState'
import { snapPitchToSemitone } from './playbackCore/pitchSnap'
import { mapBinsToBandsInto } from './eq/spectrumCore'
import {
  liveBandChanges,
  resolveAppliedEq,
  NATIVE_EQ_PLATFORM,
  WEB_EQ_PLATFORM,
  type AppliedEq,
  type EqPlatform,
} from './eq/eqEffective'
import type { EqPreset } from './eq/eqTypes'

/**
 * Engine facade shared by views (EQ, pitch/speed, volume) and the playback
 * manager. On the PWA it delegates to the Web Audio `audioManager` unchanged;
 * on iOS it mirrors the settings locally and pushes them to the native
 * `BackgroundAudio` plugin (AVAudioEngine).
 *
 * Views only ever talk to this facade so the engine backend stays swappable.
 */
class EngineFacade {
  private _speed = 1
  private _pitchOctaves = 0
  private _tapeMode = false
  private _snapTolerance = 0.15
  private _volume = 1
  /** The last EQ applied to THIS engine — what a new transition is diffed
   *  against (live band writes vs a full re-materialization, and whether the
   *  preamp even moved on the native bridge). */
  private _applied: { state: EqPreset; applied: AppliedEq } | null = null

  get isNative(): boolean {
    return Capacitor.isNativePlatform()
  }

  /** What this platform's EQ can do (band limit, curve support) — the view
   *  reads it so its controls describe the same projection the push applies. */
  get eqPlatform(): EqPlatform {
    return this.isNative ? NATIVE_EQ_PLATFORM : WEB_EQ_PLATFORM
  }

  get speed(): number {
    return this.isNative ? this._speed : audioManager.speed
  }

  get pitchOctaves(): number {
    return this.isNative ? this._pitchOctaves : audioManager.pitchOctaves
  }

  get tapeMode(): boolean {
    return this.isNative ? this._tapeMode : audioManager.tapeMode
  }

  get snapTolerance(): number {
    return this.isNative ? this._snapTolerance : audioManager.snapTolerance
  }

  get volume(): number {
    return this.isNative ? this._volume : audioManager.preamp?.gain.value ?? 1
  }

  setSpeed(speed: number): void {
    if (this.isNative) {
      this._speed = speed
      // Persist through the shared store: _subscribeShared writes the setting
      // and echoes the value back (same-value store writes are no-ops).
      playbackSpeed.set(speed)
      BackgroundAudio.setSpeed({ speed }).catch(() => {})
    } else {
      audioManager.setSpeed(speed)
    }
  }

  setPitchOctaves(octaves: number): void {
    if (this.isNative) {
      // Clamp + snap on the facade so `engine.pitchOctaves` reflects what
      // actually plays (the plugin re-snaps defensively, but this keeps the
      // UI/store honest and matches the web/Swift [-2, 2] clamp).
      const clamped = Math.min(2, Math.max(-2, octaves))
      const snapped = snapPitchToSemitone(clamped, this._snapTolerance)
      this._pitchOctaves = snapped
      pitchOctaves.set(snapped)
      BackgroundAudio.setPitchOctaves({ octaves: snapped }).catch(() => {})
    } else {
      audioManager.setPitchOctaves(octaves)
    }
  }

  setTapeMode(enabled: boolean): void {
    if (this.isNative) {
      this._tapeMode = enabled
      tapeMode.set(enabled)
      BackgroundAudio.setTapeMode({ enabled }).catch(() => {})
    } else {
      audioManager.setTapeMode(enabled)
    }
  }

  setSnapTolerance(value: number): void {
    const clamped = Math.min(0.5, Math.max(0, value))
    if (this.isNative) {
      if (this._snapTolerance === clamped) return
      this._snapTolerance = clamped
      snapTolerance.set(clamped)
      BackgroundAudio.setSnapTolerance({ semitones: clamped }).catch(() => {})
      // Widening the tolerance can pull an off-grid pitch onto the grid — re-snap
      // the mirrored pitch so the facade, store, and engine stay in lockstep.
      const snapped = snapPitchToSemitone(this._pitchOctaves, clamped)
      if (snapped !== this._pitchOctaves) {
        this._pitchOctaves = snapped
        pitchOctaves.set(snapped)
        BackgroundAudio.setPitchOctaves({ octaves: snapped }).catch(() => {})
      }
    } else {
      audioManager.setSnapTolerance(clamped)
    }
  }

  setMasterVolume(volume: number): void {
    // The store mirrors the applied volume so it persists and restores (the
    // store is the single source of truth; the engine push stays here).
    masterGain.set(volume)
    if (this.isNative) {
      this._volume = volume
      BackgroundAudio.setMasterVolume({ volume }).catch(() => {})
    } else {
      audioManager.setMasterVolume(volume)
    }
  }

  setCrossfade(duration: number): void {
    if (this.isNative) {
      BackgroundAudio.setCrossfade({ duration, curve: 'sigmoid', sigmoidSteepness: 8 }).catch(() => {})
    } else {
      audioManager.crossfadeDuration = duration
    }
  }

  /**
   * iOS audio-session sharing (native only). 'exclusive' takes over audio;
   * 'mix' plays alongside other apps. No-op on web — the PWA has no
   * audio-session API, so Safari owns mixing there.
   */
  setAudioMixing(mode: string): void {
    if (!this.isNative) return
    BackgroundAudio.setAudioMixing({ mode }).catch(() => {})
  }

  /**
   * The seek-epoch kill switch (Phase 2, 2026-10-07). 'auto' (default) lets a
   * far seek open a server-offset epoch; 'off' reproduces Phase-1 behavior
   * exactly (position-preserving wait, no extra request) — the field rollback
   * for Phases 2-3. No-op on web: the web lane never opens an epoch.
   */
  setSeekEpochs(mode: 'auto' | 'off'): void {
    if (!this.isNative) return
    BackgroundAudio.setSeekEpochs({ mode }).catch(() => {})
  }

  /**
   * Explicit native audio-engine restart (2026-10-04). Called from the
   * engine-unavailable banner after the recovery ladder surfaced. Clears the
   * surfaced state and rebuilds the AVAudioEngine graph. No-op on web — the
   * PWA engine cannot enter that state.
   */
  restartAudioEngine(): void {
    if (!this.isNative) return
    BackgroundAudio.restartAudioEngine().catch(() => {})
  }

  /**
   * THE engine-facing EQ write — the only one. `eqEngineSync` calls it for every
   * transition of the EQ session (a slider edit, preset switch, import, Reset
   * All, preset deletion) and every bypass flip, so a state change cannot
   * forget to reach the audio.
   *
   * `resolveAppliedEq` decides WHAT runs (disabled bands skipped, iOS's band
   * cap, bypassed preamp); `liveBandChanges` decides HOW it lands — same band
   * set → per-band writes with no chain rebuild, otherwise a full
   * re-materialization. Native takes the whole snapshot: AVAudioUnitEQ has no
   * live rewire worth maintaining, and its snapshot is already band-limited.
   */
  applyEq(state: EqPreset, bypassed: boolean): void {
    const applied = resolveAppliedEq(state, this.eqPlatform, bypassed)
    const previous = this._applied
    this._applied = { state, applied }

    if (this.isNative) {
      this._pushNativeEq(applied, bypassed, previous?.applied.preampDb !== applied.preampDb)
      return
    }

    audioManager.setEqBypass(bypassed)
    audioManager.setPreampDb(applied.preampDb)

    const live =
      previous &&
      previous.applied.path === applied.path &&
      previous.state.graphicEqCurves === state.graphicEqCurves
        ? liveBandChanges(previous.state.filters, state.filters)
        : null
    if (live) {
      for (const i of live) {
        const f = state.filters[i]
        audioManager.setEqBandParams(i, f.frequency, f.gain, f.q)
      }
      return
    }
    // A curve stack plays its stored points verbatim; the band list is only
    // context there, so the FULL model goes over (bands off must not drop it).
    if (applied.path === 'curve') audioManager.applyGraphicEQ(state.filters, state.graphicEqCurves)
    else audioManager.applyFiltersConfig(state.filters)
  }

  /**
   * One spectrum frame as per-band 0..1 display levels (SPECTRUM_BAND_COUNT
   * bands, 20 Hz–20 kHz log ladder — see spectrumCore). Web reads the
   * AnalyserNode tap synchronously; native polls the engine's Accelerate-FFT
   * snapshot over the bridge (throttled by the caller's sampler). Returns
   * null when the engine can't provide audio data (not playing, no analyser,
   * bridge error) — the overlay then decays to silence.
   */
  async readSpectrumBands(out: Float32Array): Promise<boolean> {
    if (this.isNative) {
      try {
        const res = await BackgroundAudio.getSpectrum()
        const bands = (res?.bands as number[] | undefined) ?? []
        if (bands.length === 0) return false
        const n = Math.min(out.length, bands.length)
        for (let i = 0; i < n; i++) out[i] = bands[i]
        return res?.playing === true
      } catch {
        return false
      }
    }
    const frame = audioManager.readSpectrum(this._binScratch)
    if (!frame) return false
    mapBinsToBandsInto(
      this._binScratch,
      frame.binHz,
      out
    )
    // "Playing" on web = the context is running AND an element reports
    // audio time advancing; the analyser alone reads silence on pause. The
    // manager exposes the cheap truth: is either element actively playing.
    return audioManager.isPlaying
  }

  private _binScratch = new Float32Array(1024)

  private _pushNativeEq(applied: AppliedEq, bypassed: boolean, pushPreamp: boolean): void {
    // Only the bands the engine can run are sent: the same projection the view
    // renders from, so nothing past the platform's limit is silently dropped
    // by the Swift side.
    const filters: NativeFilterSnapshot[] = applied.filters.map((f) => ({
      type: f.type,
      frequency: f.frequency,
      gain: f.gain,
      q: f.q,
      enabled: f.enabled,
      curve: f.curve,
    }))
    BackgroundAudio.setEq({ filters, bypassed }).catch(() => {})
    // The preamp rides its own bridge method; a drag only moved a band, and a
    // second IPC per pointermove is pure latency.
    if (pushPreamp) BackgroundAudio.setPreampDb({ db: applied.preampDb }).catch(() => {})
  }
}

export const engine = new EngineFacade()
import { Capacitor } from '@capacitor/core'
import { get } from 'svelte/store'
import { audioManager } from './audioManager'
import { BackgroundAudio, type NativeFilterSnapshot } from './nativePlugin'
import { eqBypassed, currentEqState } from './eq/eqStore'
import { playbackSpeed, pitchOctaves } from '../stores/appState'
import type { EqFilterConfig, EqPoint } from './eq/eqTypes'

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
  private _volume = 1
  private _preampDb = 0
  private _bypassed = false
  private _filters: EqFilterConfig[] = []

  get isNative(): boolean {
    return Capacitor.isNativePlatform()
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
      this._pitchOctaves = octaves
      pitchOctaves.set(octaves)
      BackgroundAudio.setPitchOctaves({ octaves }).catch(() => {})
    } else {
      audioManager.setPitchOctaves(octaves)
    }
  }

  setTapeMode(enabled: boolean): void {
    if (this.isNative) {
      this._tapeMode = enabled
      BackgroundAudio.setTapeMode({ enabled }).catch(() => {})
    } else {
      audioManager.setTapeMode(enabled)
    }
  }

  setMasterVolume(volume: number): void {
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

  setEqBypass(bypassed: boolean): void {
    if (this.isNative) {
      this._bypassed = bypassed
      this._pushNativeEq()
    } else {
      audioManager.setEqBypass(bypassed)
    }
  }

  setPreampDb(db: number): void {
    if (this.isNative) {
      this._preampDb = db
      BackgroundAudio.setPreampDb({ db }).catch(() => {})
    } else {
      audioManager.setPreampDb(db)
    }
  }

  setEqBandGain(index: number, gainDb: number): void {
    if (this.isNative) {
      if (this._filters[index]) {
        this._filters[index].gain = gainDb
      }
      this._pushNativeEq()
    } else {
      audioManager.setEqBandGain(index, gainDb)
    }
  }

  applyFiltersConfig(filters: EqFilterConfig[]): void {
    if (this.isNative) {
      this._filters = filters.map((f) => ({ ...f }))
      this._pushNativeEq()
    } else {
      audioManager.applyFiltersConfig(filters)
    }
  }

  applyGraphicEQ(filters: EqFilterConfig[], curves?: EqPoint[][]): void {
    if (this.isNative) {
      void curves // GraphicEQ interpolation curves are ignored on native (24-band parametric mapping)
      this._filters = filters.map((f) => ({ ...f }))
      this._pushNativeEq()
    } else {
      audioManager.applyGraphicEQ(filters, curves)
    }
  }

  /** Push the current EQ store state to the native engine (used at init). */
  pushNativeEqFromStore(): void {
    if (!this.isNative) return
    const state = get(currentEqState)
    this._preampDb = state.preampDb
    this._bypassed = get(eqBypassed)
    this._filters = state.filters.map((f) => ({ ...f }))
    this._pushNativeEq()
    BackgroundAudio.setPreampDb({ db: state.preampDb }).catch(() => {})
  }

  private _pushNativeEq(): void {
    const filters: NativeFilterSnapshot[] = this._filters.map((f) => ({
      type: f.type,
      frequency: f.frequency,
      gain: f.gain,
      q: f.q,
      enabled: f.enabled,
    }))
    BackgroundAudio.setEq({ filters, bypassed: this._bypassed }).catch(() => {})
  }
}

export const engine = new EngineFacade()
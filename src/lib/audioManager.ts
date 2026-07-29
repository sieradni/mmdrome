import { SoundTouchNode } from '@soundtouchjs/audio-worklet'
import { parseEqText } from './eq/eqParser'
import { computeBiquadCoefficients } from './eq/eqResponseCalculator'
import { createGraphicEqAudioBuffer, filtersToPoints } from './eq/graphicEqEngine'
import { DEFAULT_EQ_Q } from './eq/eqTypes'
import type { EqFilterConfig } from './eq/eqTypes'
import type { EqPoint } from './eq/eqTypes'
import { get } from 'svelte/store'
import { currentTrack } from '../stores/appState'

const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
const WORKLET_CACHE_BUST = '1' // increment when public/*-processor.js files change

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

class AudioManager {
  readonly a: HTMLAudioElement
  readonly b: HTMLAudioElement
  private _ctx: AudioContext | null = null
  private _sourceA: MediaElementAudioSourceNode | null = null
  private _sourceB: MediaElementAudioSourceNode | null = null
  private _gainA: GainNode | null = null
  private _gainB: GainNode | null = null
  private _rgGainA: GainNode | null = null
  private _rgGainB: GainNode | null = null
  private _soundTouch: AudioNode | null = null
  private _initialized = false
  private _webAudioReady = false
  private _speed = 1
  private _pitchOctaves = 0
  private _tapeMode = false
  private _snapTolerance = 0.15
  private _eqBypassed = false
  private _eqFilters: BiquadFilterNode[] = []
  private _eqFilterConfigs: EqFilterConfig[] = []
  private _eqWorkletNode: AudioWorkletNode | null = null
  private _eqProcessorReady = false
  private _convolverNode: ConvolverNode | null = null
  private _graphicEqMode = false
  private _graphicEqCurves: EqPoint[][] = []
  private _preamp: GainNode | null = null
  private _eqPreamp: GainNode | null = null
  private _eqPreampDb = 0
  private _activeElement: 'a' | 'b' = 'a'
  private _crossfadeDuration = 0
  private _crossfadeCurve: 'exponential' | 'linear' | 'sigmoid' = 'sigmoid'
  private _sigmoidSteepness = 6
  private _nextTrackUrl: string | null = null
  private _nextTrackReplayGainLinear: number | null = null
  private _transitionArmed = false
  private _crossfadeInterval: ReturnType<typeof setInterval> | null = null
  private _replayGainMode: 'off' | 'track' | 'album' = 'off'
  private _currentTrackGainDb: number | null = null
  private _currentAlbumGainDb: number | null = null
  private _bgEl: HTMLAudioElement | null = null
  private _inBgMode = false
  onTrackEnd: (() => void) | null = null
  /** Fires when _bgEl ends while in background mode */
  onBgTrackEnd: (() => void) | null = null
  /** Fires when _bgEl encounters an error in background mode */
  onBgError: (() => void) | null = null
  onSpeedChange: ((speed: number) => void) | null = null
  onPitchChange: ((pitch: number) => void) | null = null
  private _isIOS: boolean
  private _bgTrackEndHandled = false
  private _enterBgSeq = 0
  private _webAudioFailed = false
  /** Estimated latency of the WebAudio processing pipeline (SoundTouch + EQ + output buffer).
   *  Used to compensate when transitioning between WebAudio and raw element playback
   *  on iOS to prevent audible sync jumps. Populated in ensureWebAudioReady(). */
  private _pipelineLatency = 0

  constructor() {
    this.a = new Audio()
    this.b = new Audio()
    this.a.crossOrigin = 'anonymous'
    this.b.crossOrigin = 'anonymous'
    this.a.preservesPitch = false
    this.b.preservesPitch = false
    this._isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

    // Pre-create background element for iOS — keeps audio session warm
    this._bgEl = new Audio()
    this._bgEl.crossOrigin = 'anonymous'
    this._bgEl.preservesPitch = false
    this._bgEl.preload = 'metadata' // avoid loading full track data until actually needed
    this._bgEl.volume = 0 // silent until swapped in
    this._bgEl.addEventListener('ended', () => {
      if (this._inBgMode) {
        this.onBgTrackEnd?.()
      }
    })
    this._bgEl.addEventListener('error', () => {
      if (this._inBgMode) {
        this.onBgError?.()
      }
    })
  }

  get ctx(): AudioContext | null { return this._ctx }
  get webAudioReady(): boolean { return this._webAudioReady }
  get gainA(): GainNode | null { return this._gainA }
  get gainB(): GainNode | null { return this._gainB }
  get soundTouch(): AudioNode | null { return this._soundTouch }
  get initialized(): boolean { return this._initialized }
  get speed(): number { return this._speed }
  get pitchOctaves(): number { return this._pitchOctaves }
  get tapeMode(): boolean { return this._tapeMode }
  get snapTolerance(): number { return this._snapTolerance }
  get eqBypassed(): boolean { return this._eqBypassed }
  get preamp(): GainNode | null { return this._preamp }
  get preampDb(): number { return this._eqPreampDb }
  get eqFilterConfigs(): EqFilterConfig[] { return this._eqFilterConfigs }
  get graphicEqMode(): boolean { return this._graphicEqMode }
  get graphicEqCurves(): EqPoint[][] { return this._graphicEqCurves }

  set snapTolerance(value: number) { this._snapTolerance = Math.max(0, value) }

  get isInBgMode(): boolean { return this._inBgMode }

  get activeElement(): HTMLAudioElement {
    return this._activeElement === 'a' ? this.a : this.b
  }

  get standbyElement(): HTMLAudioElement {
    return this._activeElement === 'a' ? this.b : this.a
  }

  /** Returns the element currently driving audible playback (respects bg mode) */
  get playbackElement(): HTMLAudioElement {
    return this._inBgMode && this._bgEl ? this._bgEl : this.activeElement
  }

  get crossfadeDuration(): number {
    return this._crossfadeDuration
  }

  set crossfadeDuration(seconds: number) {
    this._crossfadeDuration = Math.max(0, Math.min(15, seconds))
  }

  get crossfadeCurve(): 'exponential' | 'linear' | 'sigmoid' {
    return this._crossfadeCurve
  }

  set crossfadeCurve(curve: 'exponential' | 'linear' | 'sigmoid') {
    this._crossfadeCurve = curve
  }

  get sigmoidSteepness(): number {
    return this._sigmoidSteepness
  }

  set sigmoidSteepness(value: number) {
    this._sigmoidSteepness = Math.max(1, Math.min(16, value))
  }

  async init(): Promise<void> {
    if (this._initialized) return
    this._initialized = true
    this._setupVisibilityHandler()
  }

  private _setupVisibilityHandler(): void {
    if (!this._isIOS) return
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this._enterBackground()
      } else if (this._inBgMode) {
        this._exitBackground()
      } else if (this._ctx && this._ctx.state !== 'running') {
        /* _bgEl.play() may have failed — still try to revive context */
        this._ctx.resume().catch(() => {})
      }
    })
  }

  /** Keep the background element's source in sync so it can resume from a loaded buffer */
  syncBgSource(url: string): void {
    if (!this._bgEl || this._inBgMode) return
    if (this._bgEl.src !== url) {
      this._bgEl.src = url
    }
  }

  /** Mark that _onBgTrackEnd has already advanced the queue and set the active element.
   *  Used by _exitBackground to avoid conflicting src/currentTime writes. */
  setBgTrackEndHandled(): void {
    this._bgTrackEndHandled = true
  }

  /** Load and play a URL on the background element (used during bg track advancement).
   *  Returns true if playback started successfully, false if it failed or was interrupted. */
  async playBg(url: string): Promise<boolean> {
    if (!this._bgEl || !this._inBgMode) return false
    this._bgEl.src = url
    this._bgEl.currentTime = 0
    this._bgEl.playbackRate = this._speed
    try {
      await this._bgEl.play()
      return true
    } catch {
      return false
    }
  }

  private _enterBackground(): void {
    if (this._inBgMode || !this._bgEl) return

    const el = this.activeElement
    if (el.paused || el.ended || !el.src) return

    this._teardownCrossfadeMonitor()

    if (!this._bgEl.src || this._bgEl.src !== el.src) {
      this._bgEl.src = el.src
      // On iOS, preload is ignored and the element may not have loaded enough
      // data for a reliable seek. Force a reinitialization so currentTime
      // takes effect properly.
      if (this._isIOS) {
        this._bgEl.load()
      }
    } else if (this._isIOS && this._bgEl.readyState < 2) {
      // Same src already set but element hasn't loaded enough data for accurate seeking.
      this._bgEl.load()
    }

    // Compensate for the WebAudio pipeline latency: in foreground mode the user
    // hears audio slightly behind the element's decode position (due to SoundTouch,
    // EQ, and output buffering). In background mode the raw element bypasses all
    // this, so we start slightly earlier to match what was just heard.
    const offset = this._getTransitionOffset()
    this._bgEl.currentTime = Math.max(0, el.currentTime - offset)
    this._bgEl.playbackRate = this._speed

    const seq = ++this._enterBgSeq
    this._inBgMode = true
    this._bgEl.play().then(() => {
      if (this._enterBgSeq !== seq) return
      el.pause()
    }).catch(() => {
      if (this._enterBgSeq !== seq) return
      this._inBgMode = false
      this._bgEl!.volume = 0
    })
  }

  private async _exitBackground(): Promise<void> {
    if (!this._bgEl) return
    this._enterBgSeq++
    this._inBgMode = false

    const wasPlaying = !this._bgEl.paused
    const bgTime = this._bgEl.currentTime

    this._bgEl.pause()
    this._bgEl.removeAttribute('src')
    this._bgEl.load()

    if (this._ctx) {
      if (this._ctx.state !== 'running') {
        try {
          await this._ctx.suspend()
          await this._ctx.resume()
        } catch {
          /* Context irrecoverable — play() on element will use system audio */        }
      }
      this.reapplyEffects()
    }

    const el = this.activeElement

    if (this._bgTrackEndHandled) {
      /* _onBgTrackEnd already advanced the queue and set the active element's
         src to the next track.  Just resume playback from wherever it is. */
      if (wasPlaying) {
        await el.play().catch(() => {})
      }
    } else if (wasPlaying) {
      el.currentTime = bgTime
      await el.play().catch(() => {})
    }

    this._bgTrackEndHandled = false

    if (this._nextTrackUrl && this._crossfadeDuration > 0 && this._webAudioReady) {
      this._setupCrossfadeMonitor()
      const el = this.activeElement
      const metaDur = get(currentTrack)?.duration ?? 0
      if (metaDur && metaDur >= this._crossfadeDuration + 1 && !el.paused) {
        if (el.currentTime >= metaDur - this._crossfadeDuration) {
          this._executeCrossfade()
        }
      }
    }
  }

  async ensureWebAudioReady(): Promise<boolean> {
    if (this._webAudioFailed) return false
    if (this._webAudioReady) {
      if (this._ctx && this._ctx.state !== 'running') {
        try {
          /* Work around iOS zombie AudioContext: suspend then resume resets state */
          await this._ctx.suspend()
          await this._ctx.resume()
        } catch {
          /* Context irrecoverable — new context can't reuse these audio elements */
        }
      }
      return true
    }
    if (this._ctx) return true

    try {
      this._ctx = new AudioContext()
      if (this._ctx.state === 'suspended') {
        await this._ctx.resume()
      }

      try {
        await SoundTouchNode.register(this._ctx, `soundtouch-processor.js?v=${WORKLET_CACHE_BUST}`)
        const stNode = new SoundTouchNode({ context: this._ctx })
        this._soundTouch = stNode
      } catch {
        this._soundTouch = this._ctx.createGain()
      }

      this._sourceA = this._ctx.createMediaElementSource(this.a)
      this._sourceB = this._ctx.createMediaElementSource(this.b)
      this._gainA = this._ctx.createGain()
      this._gainB = this._ctx.createGain()
      this._rgGainA = this._ctx.createGain()
      this._rgGainB = this._ctx.createGain()
      this._rgGainA.gain.value = 1
      this._rgGainB.gain.value = 1

      this._sourceA.connect(this._gainA)
      this._gainA.connect(this._rgGainA)
      this._rgGainA.connect(this._soundTouch)

      this._sourceB.connect(this._gainB)
      this._gainB.connect(this._rgGainB)
      this._rgGainB.connect(this._soundTouch)

      this._preamp = this._ctx.createGain()
      this._preamp.gain.value = 1
      this._eqPreamp = this._ctx.createGain()
      this._eqPreamp.gain.value = 1

      try {
        await this._ctx.audioWorklet.addModule(`eq-processor.js?v=${WORKLET_CACHE_BUST}`)
        this._eqWorkletNode = new AudioWorkletNode(this._ctx, 'eq-processor')
        this._eqProcessorReady = true
      } catch {
        console.warn('EQ worklet not supported, using BiquadFilterNode fallback')
        this._eqProcessorReady = false
      }

      if (this._graphicEqMode && this._eqFilterConfigs.length > 0) {
        this._updateConvolverBuffer()
        this._reconnectChain()
      } else if (this._eqProcessorReady) {
        this._reconnectChain()
        this._sendEqConfigToWorklet()
      } else {
        this._buildDefaultEq()
        this._reconnectChain()
      }

      this._applyTempo()
      this._applyPitch(this._pitchOctaves)

      this._webAudioReady = true
      this._measurePipelineLatency()
    } catch (err) {
      console.warn('WebAudio init failed, using direct playback', err)
      this._cleanupWebAudio()
    }

    return this._webAudioReady
  }

  private _cleanupWebAudio(): void {
    if (this._sourceA) { try { this._sourceA.disconnect() } catch {} }
    if (this._sourceB) { try { this._sourceB.disconnect() } catch {} }
    if (this._gainA) { try { this._gainA.disconnect() } catch {} }
    if (this._gainB) { try { this._gainB.disconnect() } catch {} }
    if (this._rgGainA) { try { this._rgGainA.disconnect() } catch {} }
    if (this._rgGainB) { try { this._rgGainB.disconnect() } catch {} }
    if (this._soundTouch) { try { this._soundTouch.disconnect() } catch {} }
    if (this._preamp) { try { this._preamp.disconnect() } catch {} }
    if (this._eqPreamp) { try { this._eqPreamp.disconnect() } catch {} }
    if (this._eqWorkletNode) { try { this._eqWorkletNode.disconnect() } catch {} }
    if (this._convolverNode) { try { this._convolverNode.disconnect() } catch {} }
    this._teardownFilters()
    if (this._ctx) { try { this._ctx.close() } catch {} }
    this._ctx = null
    this._sourceA = null
    this._sourceB = null
    this._gainA = null
    this._gainB = null
    this._rgGainA = null
    this._rgGainB = null
    this._soundTouch = null
    this._preamp = null
    this._eqPreamp = null
    this._eqWorkletNode = null
    this._convolverNode = null
    this._graphicEqMode = false
    this._graphicEqCurves = []
    this._eqProcessorReady = false
    this._eqFilters = []
    this._eqFilterConfigs = []
    this._webAudioReady = false
    this._webAudioFailed = true
  }

  /** Measure the WebAudio processing pipeline latency so we can compensate
   *  when transitioning to/from raw HTMLAudioElement playback on iOS.
   *  The pipeline (SoundTouch worklet + EQ + output buffer) adds delay between
   *  the element's decode position and what the user actually hears. */
  private _measurePipelineLatency(): void {
    if (!this._ctx) return
    let latency = 0
    if (typeof this._ctx.baseLatency === 'number' && this._ctx.baseLatency > 0) {
      latency += this._ctx.baseLatency
    }
    if (typeof this._ctx.outputLatency === 'number' && this._ctx.outputLatency > 0) {
      latency += this._ctx.outputLatency
    }
    // Fallback: empirically reasonable estimate for SoundTouch worklet + 10-band EQ
    // on iOS. SoundTouch buffers ~1024 samples (~23ms at 44.1kHz), EQ adds group
    // delay (~2-10ms per biquad stage), and the output device adds ~10-50ms.
    if (latency === 0) latency = 0.15
    this._pipelineLatency = latency
  }

  /** Returns the time offset to apply when entering background mode.
   *  Accounts for the WebAudio pipeline latency (SoundTouch + EQ + output buffer)
   *  so the raw _bgEl starts at the position the user was audibly hearing. */
  private _getTransitionOffset(): number {
    return this._pipelineLatency
  }

  setSpeed(value: number): void {
    this._speed = clamp(value, 0.2, 4)
    this._applyTempo()
    this.onSpeedChange?.(this._speed)
  }

  setPitchOctaves(octaves: number): void {
    this._pitchOctaves = clamp(octaves, -2, 2)
    const snapped = this._snapOctaves(this._pitchOctaves)
    this._pitchOctaves = snapped
    this._applyPitch(snapped)
    this.onPitchChange?.(this._pitchOctaves)
  }

  toggleTapeMode(): void {
    this._tapeMode = !this._tapeMode
    this._applyTempo()
    this._applyPitch(this._pitchOctaves)
  }

  setTapeMode(enabled: boolean): void {
    if (this._tapeMode === enabled) return
    this._tapeMode = enabled
    this._applyTempo()
    this._applyPitch(this._pitchOctaves)
  }

  reapplyEffects(): void {
    this._applyTempo()
    this._applyPitch(this._pitchOctaves)
  }

  cancelNextTrack(): void {
    this.setNextTrack(null)
  }

  setNextTrack(url: string | null, replayGainLinear?: number): void {
    this._nextTrackUrl = url
    this._nextTrackReplayGainLinear = replayGainLinear ?? null
    if (url && this._crossfadeDuration > 0 && this._webAudioReady) {
      this._setupCrossfadeMonitor()
    } else {
      this._teardownCrossfadeMonitor()
    }
  }

  setEqBandGain(bandIndex: number, gainDb: number): void {
    const clamped = clamp(gainDb, -12, 12)

    const filter = this._eqFilters[bandIndex]
    if (filter) {
      filter.gain.value = clamped
    }

    const config = this._eqFilterConfigs[bandIndex]
    if (config) {
      config.gain = clamped
    }

    if (this._graphicEqMode) {
      this._updateConvolverBuffer()
    } else if (this._eqProcessorReady) {
      this._sendEqConfigToWorklet()
    }
  }

  toggleEqBypass(): void {
    if (!this._webAudioReady) return
    this._eqBypassed = !this._eqBypassed
    this._reconnectChain()
    if (this._eqWorkletNode) {
      this._eqWorkletNode.port.postMessage({ type: 'set-bypass', bypassed: this._eqBypassed })
    }
  }

  setEqBypass(enabled: boolean): void {
    if (!this._webAudioReady) return
    if (this._eqBypassed === enabled) return
    this._eqBypassed = enabled
    this._reconnectChain()
    if (this._eqWorkletNode) {
      this._eqWorkletNode.port.postMessage({ type: 'set-bypass', bypassed: this._eqBypassed })
    }
  }

  setReplayGainMode(mode: 'off' | 'track' | 'album'): void {
    this._replayGainMode = mode
    this._applyReplayGainInternal()
  }

  applyReplayGain(trackGainDb?: number, albumGainDb?: number): void {
    this._currentTrackGainDb = trackGainDb ?? null
    this._currentAlbumGainDb = albumGainDb ?? null
    this._applyReplayGainInternal()
  }

  private _applyReplayGainInternal(): void {
    if (!this._webAudioReady) return
    const activeRgGain = this._activeElement === 'a' ? this._rgGainA : this._rgGainB
    if (!activeRgGain) return

    let gainDb: number | null = null
    if (this._replayGainMode === 'track') {
      gainDb = this._currentTrackGainDb
    } else if (this._replayGainMode === 'album') {
      gainDb = this._currentAlbumGainDb
    }

    if (gainDb !== null && isFinite(gainDb)) {
      activeRgGain.gain.value = Math.pow(10, gainDb / 20)
    } else {
      activeRgGain.gain.value = 1
    }

  }

  parseParametricEQ(configText: string): void {
    const result = parseEqText(configText)
    if (result.filters.length === 0) return

    this.setPreampDb(result.preampDb)
    if (result.mode === 'graphic') {
      this.applyGraphicEQ(result.filters)
    } else {
      this.applyFiltersConfig(result.filters)
    }
  }

  applyGraphicEQ(configs: EqFilterConfig[], curves?: EqPoint[][]): void {
    this._teardownFilters()
    this._graphicEqMode = true
    this._eqFilterConfigs = configs
    this._graphicEqCurves = curves ?? []

    if (this._ctx) {
      this._updateConvolverBuffer()
      this._reconnectChain()
    }
  }

  applyFiltersConfig(configs: EqFilterConfig[]): void {
    this._teardownFilters()
    this._graphicEqMode = false
    this._graphicEqCurves = []
    this._eqFilterConfigs = configs

    if (!this._ctx) return

    if (this._eqProcessorReady && this._eqWorkletNode) {
      this._sendEqConfigToWorklet()
      this._reconnectChain()
      return
    }

    this._eqFilters = configs.map(cfg => {
      const f = this._ctx!.createBiquadFilter()
      f.type = cfg.type
      f.frequency.value = cfg.frequency
      f.gain.value = clamp(cfg.enabled ? cfg.gain : 0, -12, 12)
      f.Q.value = cfg.q
      return f
    })

    this._reconnectChain()
  }

  setPreampDb(db: number): void {
    this._eqPreampDb = clamp(db, -12, 12)
    if (this._eqPreamp) {
      this._eqPreamp.gain.value = Math.pow(10, this._eqPreampDb / 20)
    }
  }

  setMasterVolume(linear: number): void {
    if (this._preamp) {
      this._preamp.gain.value = linear
    }
  }

  private _sendEqConfigToWorklet(): void {
    if (!this._eqWorkletNode || !this._ctx) return

    const sampleRate = this._ctx.sampleRate
    const coeffs = this._eqFilterConfigs
      .filter(c => c.enabled)
      .map(c => computeBiquadCoefficients(c.type, c.frequency, c.gain, c.q, sampleRate))

    this._eqWorkletNode.port.postMessage({
      type: 'set-coefficients',
      coeffs,
      bypassed: this._eqBypassed,
    })
  }

  private _buildDefaultEq(): void {
    if (!this._ctx) return
    this._eqFilterConfigs = EQ_FREQUENCIES.map(freq => ({
      type: 'peaking',
      frequency: freq,
      gain: 0,
      q: DEFAULT_EQ_Q,
      enabled: true,
    }))
    this._eqFilters = EQ_FREQUENCIES.map(freq => {
      const f = this._ctx!.createBiquadFilter()
      f.type = 'peaking'
      f.frequency.value = freq
      f.gain.value = 0
      f.Q.value = DEFAULT_EQ_Q
      return f
    })
  }

  private _teardownFilters(): void {
    for (const f of this._eqFilters) {
      f.disconnect()
    }
    this._eqFilters = []
  }

  private _updateConvolverBuffer(): void {
    if (!this._ctx) return
    if (!this._convolverNode) {
      this._convolverNode = this._ctx.createConvolver()
      this._convolverNode.normalize = false
    }
    if (this._graphicEqCurves.length > 0) {
      const buffer = createGraphicEqAudioBuffer(this._ctx, this._graphicEqCurves)
      this._convolverNode.buffer = buffer
    } else {
      const points = filtersToPoints(this._eqFilterConfigs)
      if (points.length > 0) {
        const buffer = createGraphicEqAudioBuffer(this._ctx, [points])
        this._convolverNode.buffer = buffer
      } else {
        this._convolverNode.buffer = null
      }
    }
  }

  private _reconnectChain(): void {
    if (!this._soundTouch || !this._preamp || !this._eqPreamp || !this._ctx) return

    this._soundTouch.disconnect()
    this._eqPreamp.disconnect()
    this._preamp.disconnect()
    if (this._eqWorkletNode) { try { this._eqWorkletNode.disconnect() } catch {} }
    if (this._convolverNode) { try { this._convolverNode.disconnect() } catch {} }

    if (this._graphicEqMode && this._convolverNode && this._convolverNode.buffer) {
      if (this._eqBypassed || this._eqFilterConfigs.length === 0) {
        this._soundTouch.connect(this._preamp)
      } else {
        this._soundTouch.connect(this._convolverNode)
        this._convolverNode.connect(this._eqPreamp)
      }
    } else if (this._eqProcessorReady && this._eqWorkletNode) {
      if (this._eqBypassed || this._eqFilterConfigs.length === 0) {
        this._soundTouch.connect(this._preamp)
      } else {
        this._soundTouch.connect(this._eqWorkletNode)
        this._eqWorkletNode.connect(this._eqPreamp)
      }
    } else if (this._eqBypassed || this._eqFilters.length === 0) {
      this._soundTouch.connect(this._preamp)
    } else {
      this._soundTouch.connect(this._eqFilters[0])
      for (let i = 0; i < this._eqFilters.length - 1; i++) {
        this._eqFilters[i].connect(this._eqFilters[i + 1])
      }
      this._eqFilters[this._eqFilters.length - 1].connect(this._eqPreamp)
    }

    this._eqPreamp.connect(this._preamp)
    this._preamp.connect(this._ctx.destination)
  }

  private _applyTempo(): void {
    if (this._soundTouch instanceof SoundTouchNode) {
      if (this._tapeMode) {
        this.a.playbackRate = this._speed
        this.b.playbackRate = this._speed
        this._soundTouch.playbackRate.value = 1
      } else {
        this.a.playbackRate = this._speed
        this.b.playbackRate = this._speed
        this._soundTouch.playbackRate.value = this._speed
      }
    } else {
      this.a.playbackRate = this._speed
      this.b.playbackRate = this._speed
    }

    if (this._bgEl) {
      this._bgEl.playbackRate = this._speed
    }
  }

  private _applyPitch(octaves: number): void {
    if (this._soundTouch instanceof SoundTouchNode) {
      if (this._tapeMode) {
        this._soundTouch.pitch.value = 1
      } else {
        this._soundTouch.pitch.value = Math.pow(2, octaves)
      }
    }
  }

  private _snapOctaves(octaves: number): number {
    const nearestSemitone = Math.round(octaves * 12) / 12
    const semitoneDist = Math.abs(octaves - nearestSemitone)
    const nearestOctave = Math.round(octaves)
    const octDist = Math.abs(octaves - nearestOctave)

    const best = semitoneDist <= octDist ? nearestSemitone : nearestOctave
    const bestDist = Math.min(semitoneDist, octDist)

    return bestDist <= this._snapTolerance ? best : octaves
  }

  private _setupCrossfadeMonitor(): void {
    this._teardownCrossfadeMonitor()
    if (!this._webAudioReady || this._crossfadeDuration <= 0 || !this._nextTrackUrl) return

    this._transitionArmed = false
    this._crossfadeInterval = setInterval(() => {
      if (!this._nextTrackUrl || this._transitionArmed) return
      const el = this.activeElement
      const metaDur = get(currentTrack)?.duration ?? 0
      if (!metaDur || el.paused) return

      if (metaDur < this._crossfadeDuration + 1) return
      const transitionPoint = metaDur - this._crossfadeDuration

      if (el.currentTime >= transitionPoint) {
        this._executeCrossfade()
      }
    }, 100)
  }

  private _teardownCrossfadeMonitor(): void {
    if (this._crossfadeInterval !== null) {
      clearInterval(this._crossfadeInterval)
      this._crossfadeInterval = null
    }
    this._transitionArmed = false
  }

  private _executeCrossfade(): void {
    if (this._transitionArmed || !this._nextTrackUrl || !this._ctx || !this._webAudioReady) return
    this._transitionArmed = true

    const fadeDuration = this._crossfadeDuration
    const ctx = this._ctx
    const now = ctx.currentTime

    if (ctx.state === 'suspended') {
      ctx.resume()
    }

    const fadeOutGain = this._activeElement === 'a' ? this._gainA : this._gainB
    const fadeInGain = this._activeElement === 'a' ? this._gainB : this._gainA
    const standbyRgGain = this._activeElement === 'a' ? this._rgGainB : this._rgGainA
    if (!fadeOutGain || !fadeInGain) return

    if (standbyRgGain && this._nextTrackReplayGainLinear !== null) {
      standbyRgGain.gain.value = this._nextTrackReplayGainLinear
    }

    const standbyEl = this.standbyElement
    standbyEl.src = this._nextTrackUrl
    standbyEl.play()
    this.reapplyEffects()

    const steps = 40
    const stepTime = fadeDuration / steps

    const applyCurve = (gain: GainNode, start: number, end: number) => {
      gain.gain.cancelScheduledValues(now)
      gain.gain.setValueAtTime(start, now)

      if (this._crossfadeCurve === 'linear') {
        gain.gain.linearRampToValueAtTime(end, now + fadeDuration)
      } else if (this._crossfadeCurve === 'exponential') {
        // Use audible start/end values instead of near-silent 0.001
        gain.gain.exponentialRampToValueAtTime(end, now + fadeDuration)
      } else {
        // Sigmoid/S-curve: manual interpolation for natural crossfade
        for (let i = 1; i <= steps; i++) {
          const t = i / steps
          // Sigmoid: 1 / (1 + exp(-k * (t - 0.5))) scaled to [0, 1]
          const k = this._sigmoidSteepness
          const sig = 1 / (1 + Math.exp(-k * (t - 0.5)))
          const value = start + (end - start) * sig
          gain.gain.setValueAtTime(value, now + i * stepTime)
        }
      }
    }

    // Fade out: 1 -> 0 (sigmoid inverts naturally)
    applyCurve(fadeOutGain, fadeOutGain.gain.value, 0)

    // Fade in: 0 -> 1
    applyCurve(fadeInGain, 0, 1)

    const oldEl = this.activeElement
    setTimeout(() => {
      if (!oldEl.ended) oldEl.pause()
    }, fadeDuration * 1000)

    this._teardownCrossfadeMonitor()
    this._activeElement = this._activeElement === 'a' ? 'b' : 'a'
    this._nextTrackUrl = null
    this._nextTrackReplayGainLinear = null

    this.onTrackEnd?.()
  }
}

const audioManager = new AudioManager()
export { audioManager }
export type { AudioManager }

import { SoundTouchNode } from '@soundtouchjs/audio-worklet'
import { getSetting, setSetting, db } from './db'

const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
const PROFILE_KEY_PREFIX = 'eq_profile_'
const DEFAULT_BAND_Q = Math.SQRT1_2

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

interface EqFilterConfig {
  type: BiquadFilterType
  frequency: number
  gain: number
  q: number
}

function parseEqLine(line: string): EqFilterConfig | null {
  const m = line.match(
    /^Filter\s+\d+:\s+(ON|OFF)\s+(PK|LSC|HSC)\s+Fc\s+([\d.]+)\s+Hz\s+Gain\s+(-?[\d.]+)\s+dB\s+Q\s+([\d.]+)$/i
  )
  if (!m) return null

  const typeMap: Record<string, BiquadFilterType> = { PK: 'peaking', LSC: 'lowshelf', HSC: 'highshelf' }
  const cfg: EqFilterConfig = {
    type: typeMap[m[2].toUpperCase()] ?? 'peaking',
    frequency: parseFloat(m[3]),
    gain: m[1].toUpperCase() === 'ON' ? parseFloat(m[4]) : 0,
    q: parseFloat(m[5]),
  }
  return cfg
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
  private _preamp: GainNode | null = null
  private _activeElement: 'a' | 'b' = 'a'
  private _crossfadeDuration = 0
  private _nextTrackUrl: string | null = null
  private _nextTrackReplayGainLinear: number | null = null
  private _transitionArmed = false
  private _replayGainMode: 'off' | 'track' | 'album' = 'off'
  private _currentTrackGainDb: number | null = null
  private _currentAlbumGainDb: number | null = null
  private _timeupdateEl: HTMLAudioElement | null = null
  private _timeupdateHandler: ((e: Event) => void) | null = null
  private _bgEl: HTMLAudioElement | null = null
  private _inBgMode = false
  onTrackEnd: (() => void) | null = null
  onSpeedChange: ((speed: number) => void) | null = null
  private _isIOS: boolean

  constructor() {
    this.a = new Audio()
    this.b = new Audio()
    this.a.crossOrigin = 'anonymous'
    this.b.crossOrigin = 'anonymous'
    this.a.preservesPitch = false
    this.b.preservesPitch = false
    this._isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
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

  set snapTolerance(value: number) { this._snapTolerance = Math.max(0, value) }

  get activeElement(): HTMLAudioElement {
    return this._activeElement === 'a' ? this.a : this.b
  }

  get standbyElement(): HTMLAudioElement {
    return this._activeElement === 'a' ? this.b : this.a
  }

  get crossfadeDuration(): number {
    return this._crossfadeDuration
  }

  set crossfadeDuration(seconds: number) {
    this._crossfadeDuration = Math.max(0, Math.min(15, seconds))
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
      }
    })
  }

  private _enterBackground(): void {
    if (this._inBgMode) return

    const el = this.activeElement
    if (el.paused || el.ended || !el.src) return

    this._teardownTimeupdateMonitor()

    this._inBgMode = true

    if (!this._bgEl) {
      this._bgEl = new Audio()
      this._bgEl.crossOrigin = 'anonymous'
      this._bgEl.preservesPitch = false
    }

    this._bgEl.src = el.src
    this._bgEl.currentTime = el.currentTime
    this._bgEl.playbackRate = this._speed

    this._bgEl.play().catch(() => {
      this._inBgMode = false
    })

    el.pause()
  }

  private async _exitBackground(): Promise<void> {
    if (!this._bgEl) return
    this._inBgMode = false

    const wasPlaying = !this._bgEl.paused
    const ended = this._bgEl.ended
    const bgTime = this._bgEl.currentTime

    this._bgEl.pause()
    this._bgEl.removeAttribute('src')
    this._bgEl.load()

    if (this._ctx && this._ctx.state !== 'running') {
      try { await this._ctx.resume() } catch {}
    }

    const el = this.activeElement

    if (ended) {
      el.dispatchEvent(new Event('ended'))
    } else if (wasPlaying) {
      el.currentTime = bgTime
      await el.play().catch(() => {})
    }
  }

  async ensureWebAudioReady(): Promise<boolean> {
    if (this._webAudioReady) return true
    if (this._ctx) return true

    try {
      this._ctx = new AudioContext()
      if (this._ctx.state === 'suspended') {
        await this._ctx.resume()
      }

      try {
        await SoundTouchNode.register(this._ctx, 'soundtouch-processor.js')
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
      this._buildDefaultEq()
      this._reconnectChain()

      this._applyTempo()
      this._applyPitch(this._pitchOctaves)

      this._webAudioReady = true
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
    this._eqFilters = []
    this._webAudioReady = false
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

  setNextTrack(url: string | null, replayGainLinear?: number): void {
    this._nextTrackUrl = url
    this._nextTrackReplayGainLinear = replayGainLinear ?? null
    if (url && this._crossfadeDuration > 0 && this._webAudioReady) {
      this._setupTimeupdateMonitor()
    } else {
      this._teardownTimeupdateMonitor()
    }
  }

  setEqBandGain(bandIndex: number, gainDb: number): void {
    const filter = this._eqFilters[bandIndex]
    if (!filter) return
    filter.gain.value = clamp(gainDb, -12, 12)
  }

  toggleEqBypass(): void {
    if (!this._webAudioReady) return
    this._eqBypassed = !this._eqBypassed
    this._reconnectChain()
  }

  setEqBypass(enabled: boolean): void {
    if (!this._webAudioReady) return
    if (this._eqBypassed === enabled) return
    this._eqBypassed = enabled
    this._reconnectChain()
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
    if (!this._ctx) return
    const lines = configText.trim().split('\n')
    const configs: EqFilterConfig[] = []

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const parsed = parseEqLine(trimmed)
      if (parsed) configs.push(parsed)
    }

    this._teardownFilters()

    if (configs.length === 0) {
      this._eqFilters = []
      this._reconnectChain()
      return
    }

    this._eqFilters = configs.map(cfg => {
      const f = this._ctx!.createBiquadFilter()
      f.type = cfg.type
      f.frequency.value = cfg.frequency
      f.gain.value = clamp(cfg.gain, -12, 12)
      f.Q.value = cfg.q
      return f
    })

    this._reconnectChain()
  }

  async saveEqProfile(name: string, configText: string): Promise<void> {
    await setSetting(`${PROFILE_KEY_PREFIX}${name}`, configText)
  }

  async loadEqProfile(name: string): Promise<void> {
    const config = await getSetting<string>(`${PROFILE_KEY_PREFIX}${name}`)
    if (config) this.parseParametricEQ(config)
  }

  async deleteEqProfile(name: string): Promise<void> {
    await db.userSettings.delete(`${PROFILE_KEY_PREFIX}${name}`)
  }

  async listEqProfiles(): Promise<string[]> {
    const entries = await db.userSettings
      .filter(s => s.key.startsWith(PROFILE_KEY_PREFIX))
      .toArray()
    return entries.map(e => e.key.slice(PROFILE_KEY_PREFIX.length))
  }

  async getEqProfileConfig(name: string): Promise<string | undefined> {
    return getSetting<string>(`${PROFILE_KEY_PREFIX}${name}`)
  }

  private _buildDefaultEq(): void {
    if (!this._ctx) return
    this._eqFilters = EQ_FREQUENCIES.map(freq => {
      const f = this._ctx!.createBiquadFilter()
      f.type = 'peaking'
      f.frequency.value = freq
      f.gain.value = 0
      f.Q.value = DEFAULT_BAND_Q
      return f
    })
  }

  private _teardownFilters(): void {
    for (const f of this._eqFilters) {
      f.disconnect()
    }
    this._eqFilters = []
  }

  private _reconnectChain(): void {
    if (!this._soundTouch || !this._preamp || !this._ctx) return

    this._soundTouch.disconnect()
    this._preamp.disconnect()

    if (this._eqBypassed || this._eqFilters.length === 0) {
      this._soundTouch.connect(this._preamp)
    } else {
      this._soundTouch.connect(this._eqFilters[0])
      for (let i = 0; i < this._eqFilters.length - 1; i++) {
        this._eqFilters[i].connect(this._eqFilters[i + 1])
      }
      this._eqFilters[this._eqFilters.length - 1].connect(this._preamp)
    }

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

  private _setupTimeupdateMonitor(): void {
    this._teardownTimeupdateMonitor()
    if (!this._webAudioReady || this._crossfadeDuration <= 0 || !this._nextTrackUrl) return

    const el = this.activeElement
    this._timeupdateEl = el
    this._transitionArmed = false
    this._timeupdateHandler = () => {
      if (!this._nextTrackUrl || this._transitionArmed) return
      if (!el.duration || !isFinite(el.duration)) return

      const transitionPoint = el.duration - this._crossfadeDuration
      if (transitionPoint <= 0) return

      if (el.currentTime >= transitionPoint) {
        this._executeCrossfade()
      }
    }
    el.addEventListener('timeupdate', this._timeupdateHandler)
  }

  private _teardownTimeupdateMonitor(): void {
    if (this._timeupdateEl && this._timeupdateHandler) {
      this._timeupdateEl.removeEventListener('timeupdate', this._timeupdateHandler)
    }
    this._timeupdateEl = null
    this._timeupdateHandler = null
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

    fadeOutGain.gain.cancelScheduledValues(now)
    fadeOutGain.gain.setValueAtTime(fadeOutGain.gain.value, now)
    fadeOutGain.gain.exponentialRampToValueAtTime(0.001, now + fadeDuration)

    fadeInGain.gain.cancelScheduledValues(now)
    fadeInGain.gain.setValueAtTime(0.001, now)
    fadeInGain.gain.exponentialRampToValueAtTime(1.0, now + fadeDuration)

    this._teardownTimeupdateMonitor()
    this._activeElement = this._activeElement === 'a' ? 'b' : 'a'
    this._nextTrackUrl = null
    this._nextTrackReplayGainLinear = null

    this.onTrackEnd?.()
  }
}

const audioManager = new AudioManager()
export { audioManager }
export type { AudioManager }

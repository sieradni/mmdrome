import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

// MARK: - Types shared with the native engine

export interface NativeTrackSnapshot {
  index: number
  trackId: string
  title: string
  artist: string
  album: string
  duration: number
  url: string
  coverUrl?: string
  replayGain?: number
  albumReplayGain?: number
}

export interface NativeFilterSnapshot {
  type: 'peaking' | 'lowshelf' | 'highshelf' | 'lowpass' | 'highpass' | 'bandpass' | 'notch'
  frequency: number
  gain: number
  q: number
  enabled: boolean
}

export interface NativeEngineState {
  index: number
  trackId: string
  position: number
  duration: number
  playing: boolean
  speed: number
}

export type NativeLoopMode = 'none' | 'one' | 'all'
export type NativeCrossfadeCurve = 'linear' | 'exponential' | 'sigmoid'

interface BackgroundAudioPlugin {
  initialize(): Promise<void>
  setQueue(options: { tracks: NativeTrackSnapshot[]; activeIndex: number; loopMode: NativeLoopMode }): Promise<void>
  refreshQueue(options: { tracks: NativeTrackSnapshot[]; activeIndex: number }): Promise<void>
  setLoopMode(options: { loopMode: NativeLoopMode }): Promise<void>
  playTrackAt(options: { index: number; autoPlay: boolean }): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  toggle(): Promise<void>
  seek(options: { position: number }): Promise<void>
  next(): Promise<void>
  previous(): Promise<void>
  setSpeed(options: { speed: number }): Promise<void>
  setPitchOctaves(options: { octaves: number }): Promise<void>
  setTapeMode(options: { enabled: boolean }): Promise<void>
  setSnapTolerance(options: { semitones: number }): Promise<void>
  setReplayGainMode(options: { mode: 'off' | 'track' | 'album' }): Promise<void>
  setPreampDb(options: { db: number }): Promise<void>
  setMasterVolume(options: { volume: number }): Promise<void>
  setCrossfade(options: {
    duration: number
    curve: NativeCrossfadeCurve
    sigmoidSteepness: number
  }): Promise<void>
  setPreloadCount(options: { count: number }): Promise<void>
  setSleepTimer(options: { active: boolean; mode: 'minutes' | 'endOfTrack'; minutes: number }): Promise<void>
  setEq(options: { filters: NativeFilterSnapshot[]; bypassed: boolean }): Promise<void>
  getState(): Promise<NativeEngineState>
  addListener(
    eventName: 'trackChanged',
    listenerFunc: (data: { trackId: string }) => void
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: 'playbackStateChanged',
    listenerFunc: (data: { playing: boolean }) => void
  ): Promise<PluginListenerHandle>
  addListener(eventName: 'ended', listenerFunc: () => void): Promise<PluginListenerHandle>
  addListener(eventName: 'error', listenerFunc: (data: { message: string }) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'sleepTimerFired', listenerFunc: () => void): Promise<PluginListenerHandle>
  addListener(eventName: string, listenerFunc: (data: unknown) => void): Promise<PluginListenerHandle>
}

export interface NativeEngineCallbacks {
  onTrackChanged: (trackId: string) => void
  onPlaybackStateChanged: (playing: boolean) => void
  onQueueEnded: () => void
  onError: (message: string) => void
}

export const BackgroundAudio = registerPlugin<BackgroundAudioPlugin>('BackgroundAudio')

/**
 * Thin client wrapper around the native BackgroundAudio plugin. The Svelte app
 * sends queue snapshots and commands; the native engine owns the playback clock
 * and emits track/state events which are forwarded to the callbacks.
 */
export class NativeAudioEngineApp {
  private callbacks: NativeEngineCallbacks | null = null
  private listeners: PluginListenerHandle[] = []
  private positionPoll: ReturnType<typeof setInterval> | null = null
  private positionHandler: ((state: NativeEngineState) => void) | null = null

  isNative(): boolean {
    return Capacitor.isNativePlatform()
  }

  plugin(): BackgroundAudioPlugin {
    return BackgroundAudio
  }

  async init(callbacks: NativeEngineCallbacks): Promise<void> {
    this.callbacks = callbacks
    if (!this.isNative()) return
    const plugin = BackgroundAudio

    this.listeners.push(
      await plugin.addListener('trackChanged', (data) => {
        this.callbacks?.onTrackChanged(data.trackId)
      }),
    )
    this.listeners.push(
      await plugin.addListener('playbackStateChanged', (data) => {
        this.callbacks?.onPlaybackStateChanged(data.playing)
      }),
    )
    this.listeners.push(
      await plugin.addListener('ended', () => {
        this.callbacks?.onQueueEnded()
      }),
    )
    this.listeners.push(
      await plugin.addListener('error', (data) => {
        this.callbacks?.onError(data.message)
      }),
    )

    await plugin.initialize()
  }

  /**
   * Starts (or stops) the 250ms position poll used to refresh the UI clock.
   * The native engine's clock is polled rather than evented to avoid bridge chatter.
   */
  setPositionPolling(enabled: boolean, handler: (state: NativeEngineState) => void): void {
    this.positionHandler = handler
    if (enabled) {
      if (this.positionPoll) return
      this.positionPoll = setInterval(() => {
        BackgroundAudio.getState()
          .then((state) => this.positionHandler?.(state))
          .catch(() => {})
      }, 250)
    } else {
      if (this.positionPoll) {
        clearInterval(this.positionPoll)
        this.positionPoll = null
      }
    }
  }

  async destroy(): Promise<void> {
    this.setPositionPolling(false, () => {})
    await Promise.all(this.listeners.map((h) => h.remove()))
    this.listeners = []
    this.callbacks = null
  }
}

export const nativeEngine = new NativeAudioEngineApp()
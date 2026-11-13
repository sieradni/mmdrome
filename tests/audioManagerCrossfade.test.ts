import './stub-audio-worklet-node'
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { get } from 'svelte/store'
import { audioManager } from '../src/lib/audioManager'
import { PlaybackManager } from '../src/lib/playbackManager'
import { currentTrack, playbackState, setCurrentTrack, setPlaybackState, type Track } from '../src/stores/appState'

class FakeElement {
  src = ''
  paused = true
  ended = false
  currentTime = 0
  playCalls = 0
  pauseCalls = 0

  async play(): Promise<void> {
    this.playCalls++
    this.paused = false
  }

  pause(): void {
    this.pauseCalls++
    this.paused = true
  }
}

class FakeGain {
  value = 1
  scheduled: Array<{ value: number; time: number }> = []

  cancelScheduledValues(time: number): void {
    this.scheduled = this.scheduled.filter((event) => event.time < time)
  }

  setValueAtTime(value: number, time: number): void {
    if (time <= Date.now() / 1000) this.value = value
    this.scheduled.push({ value, time })
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.scheduled.push({ value, time })
  }
}

const tracks = ['first', 'second', 'third'].map((id): Track => ({
  trackId: id,
  title: id,
  artist: 'Artist',
  album: 'Album',
  duration: 30,
  fileType: 'mp3',
}))

function makeHarness(t: TestContext) {
  const previousTrack = get(currentTrack)
  const previousState = get(playbackState)
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] })
  const manager = new (audioManager.constructor as new () => typeof audioManager)()
  const a = new FakeElement()
  const b = new FakeElement()
  const gainA = new FakeGain()
  const gainB = new FakeGain()
  Object.assign(manager, {
    _elA: a,
    _elB: b,
    _ctx: { state: 'running', get currentTime() { return Date.now() / 1000 } },
    _gainA: { gain: gainA },
    _gainB: { gain: gainB },
    _webAudioReady: true,
  })
  const playback = new PlaybackManager({ audioManager: manager, isNative: () => false })
  const transitions: string[] = []
  manager.crossfadeDuration = 6
  manager.crossfadeCurve = 'linear'
  manager.onTrackEnd = () => {
    const track = tracks[transitions.length + 1]
    transitions.push(track.trackId)
    setCurrentTrack(track)
  }
  a.src = tracks[0].trackId
  a.paused = false
  setCurrentTrack(tracks[0])
  setPlaybackState('playing')
  t.after(() => {
    manager.teardownCrossfadeMonitor()
    setCurrentTrack(previousTrack)
    setPlaybackState(previousState)
  })

  function startFade(outgoing: FakeElement, next: Track): void {
    outgoing.currentTime = 24
    manager.setNextTrack(next.trackId, 1, next.duration)
    t.mock.timers.tick(100)
  }

  return { manager, playback, a, b, gainA, gainB, transitions, startFade }
}

test('pausing a crossfade silences both songs and resumes only the committed song at its paused position', async (t) => {
  const h = makeHarness(t)
  h.startFade(h.a, tracks[1])
  assert.deepEqual(h.transitions, ['second'])
  assert.equal(h.a.paused, false)
  assert.equal(h.b.paused, false)

  t.mock.timers.tick(400)
  h.b.currentTime = 0.4
  h.playback.pause()
  assert.equal(get(playbackState), 'paused')
  assert.equal(h.a.paused, true)
  assert.equal(h.b.paused, true)
  assert.equal(h.manager.isPlaying, false)
  assert.equal(h.gainB.value, 1)
  assert.equal(h.gainA.scheduled.some(({ time }) => time > Date.now() / 1000), false)
  assert.equal(h.gainB.scheduled.some(({ time }) => time > Date.now() / 1000), false)
  const outgoingPauses = h.a.pauseCalls

  h.playback.pause()
  t.mock.timers.tick(6000)
  assert.equal(h.a.pauseCalls, outgoingPauses)
  assert.equal(h.b.currentTime, 0.4)

  await h.playback.play()
  assert.equal(get(playbackState), 'playing')
  assert.equal(h.a.paused, true)
  assert.equal(h.a.playCalls, 0)
  assert.equal(h.b.paused, false)
  assert.equal(h.b.currentTime, 0.4)
  assert.deepEqual(h.transitions, ['second'])
})

test('rapid pause and resume let the next crossfade use both elements and retire on its own schedule', async (t) => {
  const h = makeHarness(t)
  h.startFade(h.a, tracks[1])
  t.mock.timers.tick(400)
  h.playback.pause()
  await h.playback.play()

  h.startFade(h.b, tracks[2])
  assert.deepEqual(h.transitions, ['second', 'third'])
  assert.equal(h.a.src, 'third')
  assert.equal(h.a.paused, false)
  assert.equal(h.b.paused, false)

  t.mock.timers.tick(5600) // Across the old retire deadline, before the new one.
  assert.equal(h.a.paused, false)
  assert.equal(h.b.paused, false)
  t.mock.timers.tick(400)
  assert.equal(h.a.paused, false)
  assert.equal(h.b.paused, true)
})

test('pausing without a crossfade leaves a preloaded standby untouched', async (t) => {
  const h = makeHarness(t)
  h.b.src = tracks[1].trackId
  h.b.currentTime = 0.25
  h.manager.setNextTrack(h.b.src, 1, tracks[1].duration)
  h.playback.pause()
  await h.playback.play()

  assert.equal(h.a.paused, false)
  assert.equal(h.b.paused, true)
  assert.equal(h.b.pauseCalls, 0)
  assert.equal(h.b.playCalls, 0)
  assert.equal(h.b.currentTime, 0.25)
  h.a.currentTime = 24
  t.mock.timers.tick(100)
  assert.deepEqual(h.transitions, ['second'])
})

test('a pause during audio context recovery supersedes the pending resume', async (t) => {
  const h = makeHarness(t)
  h.startFade(h.a, tracks[1])
  h.playback.pause()

  let finishRecovery!: (ready: boolean) => void
  const ready = new Promise<boolean>((resolve) => { finishRecovery = resolve })
  const recovery = t.mock.method(h.manager, 'ensureWebAudioReady', () => ready)
  const pendingResume = h.playback.play()
  assert.equal(recovery.mock.callCount(), 1)

  h.playback.pause()
  finishRecovery(true)
  await pendingResume

  assert.equal(get(playbackState), 'paused')
  assert.equal(h.manager.isPlaying, false)
  assert.equal(h.b.playCalls, 1)
})

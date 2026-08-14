import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NativeTransport,
  type NativeEngineClient,
  type NativeLoopMode,
  type NativePluginClient,
  type NativePollState,
  type NativeRefreshPayload,
  type NativeSnapshotTrack,
} from '../src/lib/playbackCore/nativeTransport'
import type { TransportEndedEvent } from '../src/lib/playbackCore/types'

// ── fakes ──────────────────────────────────────────────────────────────────

class FakePlugin implements NativePluginClient {
  setQueueCalls: Array<{ tracks: NativeSnapshotTrack[]; activeIndex: number; loopMode: NativeLoopMode }> = []
  playTrackAtCalls: Array<{ index: number; autoPlay: boolean }> = []
  refreshCalls: Array<{ tracks: NativeSnapshotTrack[]; activeIndex: number }> = []
  commands: string[] = []
  failSetQueue = false
  failPlayTrackAt = false
  setQueueGate: Promise<void> | null = null

  async setQueue(options: { tracks: NativeSnapshotTrack[]; activeIndex: number; loopMode: NativeLoopMode }): Promise<void> {
    this.setQueueCalls.push(options)
    if (this.failSetQueue) throw new Error('setQueue rejected')
    if (this.setQueueGate) await this.setQueueGate
  }

  async playTrackAt(options: { index: number; autoPlay: boolean }): Promise<void> {
    this.playTrackAtCalls.push(options)
    if (this.failPlayTrackAt) throw new Error('playTrackAt rejected')
  }

  async refreshQueue(options: { tracks: NativeSnapshotTrack[]; activeIndex: number }): Promise<void> {
    this.refreshCalls.push(options)
  }

  async play(): Promise<void> {
    this.commands.push('play')
  }

  async pause(): Promise<void> {
    this.commands.push('pause')
  }

  async seek(options: { position: number }): Promise<void> {
    this.commands.push(`seek:${options.position}`)
  }

  async setLoopMode(options: { loopMode: NativeLoopMode }): Promise<void> {
    this.commands.push(`loop:${options.loopMode}`)
  }
}

class FakeClient implements NativeEngineClient {
  pluginInst: FakePlugin
  callbacks: {
    onTrackChanged(trackId: string): void
    onPlaybackStateChanged(playing: boolean): void
    onQueueEnded(): void
    onError(message: string): void
  } | null = null
  polling: Array<{ enabled: boolean; handler: ((state: NativePollState) => void) | null }> = []
  destroyed = false

  constructor(plugin: FakePlugin) {
    this.pluginInst = plugin
  }

  async init(callbacks: {
    onTrackChanged(trackId: string): void
    onPlaybackStateChanged(playing: boolean): void
    onQueueEnded(): void
    onError(message: string): void
  }): Promise<void> {
    this.callbacks = callbacks
  }

  setPositionPolling(enabled: boolean, handler: (state: NativePollState) => void): void {
    this.polling.push({ enabled, handler: enabled ? handler : null })
  }

  plugin(): NativePluginClient {
    return this.pluginInst
  }

  async destroy(): Promise<void> {
    this.destroyed = true
  }
}

const tracks: NativeSnapshotTrack[] = [
  { index: 0, trackId: 't1', url: 'u1' },
  { index: 1, trackId: 't2', url: 'u2' },
]

/** Flushes the pending microtask queue. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function setup(): { transport: NativeTransport; client: FakeClient; plugin: FakePlugin } {
  const plugin = new FakePlugin()
  const client = new FakeClient(plugin)
  const transport = new NativeTransport(client)
  return { transport, client, plugin }
}

// ── init / listener wiring ─────────────────────────────────────────────────

test('init registers engine callbacks that forward policy events', async () => {
  const { transport, client } = setup()
  const changed: string[] = []
  const states: Array<'playing' | 'paused'> = []
  const ended: TransportEndedEvent[] = []
  transport.onTrackChanged = (id) => changed.push(id)
  transport.onPlaybackState = (s) => states.push(s)
  transport.onTrackEnded = (e) => ended.push(e)
  await transport.init()

  client.callbacks!.onTrackChanged('t2')
  client.callbacks!.onPlaybackStateChanged(true)
  client.callbacks!.onPlaybackStateChanged(false)
  client.callbacks!.onQueueEnded()

  assert.deepEqual(changed, ['t2'])
  assert.deepEqual(states, ['playing', 'paused'])
  assert.deepEqual(ended, [{ kind: 'natural', fromError: false }])
})

test('init without callbacks assigned is safe (no throw)', async () => {
  const { transport, client } = setup()
  await transport.init()
  client.callbacks!.onQueueEnded()
  client.callbacks!.onPlaybackStateChanged(true)
})

// ── engage / disengage ─────────────────────────────────────────────────────

test('engage sends setQueue + playTrackAt and becomes engaged', async () => {
  const { transport, plugin } = setup()
  const ok = await transport.engage(tracks, 1, 'all')
  assert.equal(ok, true)
  assert.equal(transport.engaged, true)
  assert.deepEqual(plugin.setQueueCalls, [{ tracks, activeIndex: 1, loopMode: 'all' }])
  assert.deepEqual(plugin.playTrackAtCalls, [{ index: 1, autoPlay: true }])
})

test('engage rejection (setQueue) returns false and stays disengaged', async () => {
  const { transport, plugin } = setup()
  plugin.failSetQueue = true
  const ok = await transport.engage(tracks, 0, 'none')
  assert.equal(ok, false)
  assert.equal(transport.engaged, false)
  assert.equal(plugin.playTrackAtCalls.length, 0)
})

test('engage rejection (playTrackAt) returns false and stays disengaged', async () => {
  const { transport, plugin } = setup()
  plugin.failPlayTrackAt = true
  const ok = await transport.engage(tracks, 0, 'none')
  assert.equal(ok, false)
  assert.equal(transport.engaged, false)
})

test('disengage drops the engaged flag and stops the poll', async () => {
  const { transport, client } = setup()
  await transport.engage(tracks, 0, 'none')
  transport.disengage()
  assert.equal(transport.engaged, false)
  const last = client.polling[client.polling.length - 1]
  assert.equal(last.enabled, false)
})

test('a disengage mid-flight drops the stale engage settle (never re-engages)', async () => {
  const { transport, client, plugin } = setup()
  let release!: () => void
  plugin.setQueueGate = new Promise((r) => {
    release = r
  })
  const engaging = transport.engage(tracks, 0, 'none')
  transport.disengage()
  release()
  assert.equal(await engaging, false)
  assert.equal(transport.engaged, false)
  assert.equal(client.polling.filter((p) => p.enabled).length, 0)
})

test('a destroy mid-flight drops the stale engage settle', async () => {
  const { transport, client, plugin } = setup()
  let release!: () => void
  plugin.setQueueGate = new Promise((r) => {
    release = r
  })
  const engaging = transport.engage(tracks, 0, 'none')
  await transport.destroy()
  release()
  assert.equal(await engaging, false)
  assert.equal(transport.engaged, false)
  assert.equal(client.polling.filter((p) => p.enabled).length, 0)
})

// ── position poll ──────────────────────────────────────────────────────────

test('engage starts the 250ms poll; ticks forward onTick(position)', async () => {
  const { transport, client } = setup()
  const positions: number[] = []
  transport.onTick = (p) => positions.push(p)
  await transport.engage(tracks, 0, 'none')

  const enabled = client.polling.filter((p) => p.enabled)
  assert.equal(enabled.length, 1)
  enabled[0].handler!({ trackId: 't1', position: 12.5, playing: true })
  enabled[0].handler!({ trackId: 't1', position: 13.1, playing: true })
  assert.deepEqual(positions, [12.5, 13.1])
})

test('tick with no onTick assigned is safe', async () => {
  const { transport, client } = setup()
  await transport.engage(tracks, 0, 'none')
  const enabled = client.polling.filter((p) => p.enabled)
  enabled[0].handler!({ trackId: 't1', position: 1, playing: true })
})

test('re-engage restarts the poll with a fresh handler', async () => {
  const { transport, client } = setup()
  await transport.engage(tracks, 0, 'none')
  await transport.engage(tracks, 1, 'all')
  assert.equal(client.polling.filter((p) => p.enabled).length, 2)
})

// ── scheduleSync / coalescing ──────────────────────────────────────────────

test('scheduleSync while disengaged is ignored', async () => {
  const { transport, plugin } = setup()
  transport.scheduleSync(() => ({ tracks, activeIndex: 0 }))
  await tick()
  assert.equal(plugin.refreshCalls.length, 0)
})

test('scheduleSync sends the refresh with the payload', async () => {
  const { transport, plugin } = setup()
  await transport.engage(tracks, 1, 'none')
  transport.scheduleSync(() => ({ tracks, activeIndex: 1 }))
  await tick()
  assert.deepEqual(plugin.refreshCalls, [{ tracks, activeIndex: 1 }])
})

test('a burst of scheduleSync calls collapses into ONE refresh with the LAST factory', async () => {
  const { transport, plugin } = setup()
  await transport.engage(tracks, 0, 'none')
  const payloads: NativeRefreshPayload[] = [
    { tracks, activeIndex: 0 },
    { tracks, activeIndex: 2 },
    { tracks, activeIndex: 3 },
  ]
  for (const p of payloads) {
    transport.scheduleSync(() => p)
  }
  await tick()
  assert.equal(plugin.refreshCalls.length, 1)
  assert.deepEqual(plugin.refreshCalls[0], payloads[2])
})

test('the factory is evaluated at FIRE time, not schedule time (fresh state)', async () => {
  const { transport, plugin } = setup()
  await transport.engage(tracks, 0, 'none')
  let activeIndex = 0
  transport.scheduleSync(() => ({ tracks, activeIndex }))
  activeIndex = 7
  await tick()
  assert.equal(plugin.refreshCalls.length, 1)
  assert.equal(plugin.refreshCalls[0].activeIndex, 7)
})

test('a null factory result skips the refresh', async () => {
  const { transport, plugin } = setup()
  await transport.engage(tracks, 0, 'none')
  transport.scheduleSync(() => null)
  await tick()
  assert.equal(plugin.refreshCalls.length, 0)
})

test('disengage before the microtask fires cancels the pending refresh', async () => {
  const { transport, plugin } = setup()
  await transport.engage(tracks, 0, 'none')
  transport.scheduleSync(() => ({ tracks, activeIndex: 0 }))
  transport.disengage()
  await tick()
  assert.equal(plugin.refreshCalls.length, 0)
})

test('scheduleSync after destroy is ignored', async () => {
  const { transport, plugin } = setup()
  await transport.engage(tracks, 0, 'none')
  await transport.destroy()
  transport.scheduleSync(() => ({ tracks, activeIndex: 0 }))
  await tick()
  assert.equal(plugin.refreshCalls.length, 0)
})

test('a refreshQueue bridge rejection is swallowed (logged, no throw)', async () => {
  const { transport, plugin } = setup()
  await transport.engage(tracks, 0, 'none')
  const original = plugin.refreshQueue.bind(plugin)
  plugin.refreshQueue = async () => {
    await original({ tracks, activeIndex: 0 })
    throw new Error('refresh rejected')
  }
  transport.scheduleSync(() => ({ tracks, activeIndex: 0 }))
  await tick()
  assert.equal(plugin.refreshCalls.length, 1)
})

// ── command pass-throughs ──────────────────────────────────────────────────

test('play/pause/seek/setLoopMode forward to the plugin', async () => {
  const { transport, plugin } = setup()
  await transport.play()
  await transport.pause()
  await transport.seek(42)
  await transport.setLoopMode('one')
  assert.deepEqual(plugin.commands, ['play', 'pause', 'seek:42', 'loop:one'])
})

// ── destroy ────────────────────────────────────────────────────────────────

test('destroy tears down the client and drops engaged', async () => {
  const { transport, client } = setup()
  await transport.engage(tracks, 0, 'none')
  await transport.destroy()
  assert.equal(client.destroyed, true)
  assert.equal(transport.engaged, false)
})
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
  type NativeTransportTimers,
} from '../src/lib/playbackCore/nativeTransport'
import type { TransportEndedEvent } from '../src/lib/playbackCore/types'

// ── fakes ──────────────────────────────────────────────────────────────────

class FakePlugin implements NativePluginClient {
  setQueueCalls: Array<{ tracks: NativeSnapshotTrack[]; activeIndex: number; loopMode: NativeLoopMode }> = []
  playTrackAtCalls: Array<{ index: number; autoPlay: boolean }> = []
  refreshCalls: Array<{ tracks: NativeSnapshotTrack[]; activeIndex: number }> = []
  commands: string[] = []
  /** Interleaved call order across setQueue/playTrackAt/seek/refreshQueue. */
  order: string[] = []
  failSetQueue = false
  failPlayTrackAt = false
  setQueueGate: Promise<void> | null = null

  async setQueue(options: { tracks: NativeSnapshotTrack[]; activeIndex: number; loopMode: NativeLoopMode }): Promise<void> {
    this.setQueueCalls.push(options)
    this.order.push(`setQueue:${options.activeIndex}`)
    if (this.failSetQueue) throw new Error('setQueue rejected')
    if (this.setQueueGate) await this.setQueueGate
  }

  async playTrackAt(options: { index: number; autoPlay: boolean }): Promise<void> {
    this.playTrackAtCalls.push(options)
    this.order.push(`playTrackAt:${options.index}`)
    if (this.failPlayTrackAt) throw new Error('playTrackAt rejected')
  }

  async refreshQueue(options: { tracks: NativeSnapshotTrack[]; activeIndex: number }): Promise<void> {
    this.refreshCalls.push(options)
    this.order.push('refreshQueue')
  }

  async play(): Promise<void> {
    this.commands.push('play')
  }

  async pause(): Promise<void> {
    this.commands.push('pause')
  }

  async seek(options: { position: number }): Promise<void> {
    this.commands.push(`seek:${options.position}`)
    this.order.push(`seek:${options.position}`)
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

const tracks3: NativeSnapshotTrack[] = [
  { index: 0, trackId: 't1', url: 'u1' },
  { index: 1, trackId: 't2', url: 'u2' },
  { index: 2, trackId: 't3', url: 'u3' },
]

/** Flushes the pending microtask queue. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Manual timer wheel — fireAll() runs every still-armed entry in order. */
class FakeTimers implements NativeTransportTimers {
  entries: Array<{ delayMs: number; fn: () => void; cancelled: boolean }> = []

  schedule(delayMs: number, fn: () => void): () => void {
    const entry = { delayMs, fn, cancelled: false }
    this.entries.push(entry)
    return () => {
      entry.cancelled = true
    }
  }

  fireAll(): void {
    for (const entry of this.entries) {
      if (entry.cancelled) continue
      // A fired timer is consumed — later "armed" filters must not count it.
      entry.cancelled = true
      entry.fn()
    }
  }
}

function setup(): { transport: NativeTransport; client: FakeClient; plugin: FakePlugin } {
  const plugin = new FakePlugin()
  const client = new FakeClient(plugin)
  const transport = new NativeTransport(client)
  return { transport, client, plugin }
}

function setupTimed(): { transport: NativeTransport; client: FakeClient; plugin: FakePlugin; timers: FakeTimers } {
  const plugin = new FakePlugin()
  const client = new FakeClient(plugin)
  const timers = new FakeTimers()
  const transport = new NativeTransport(client, timers)
  return { transport, client, plugin, timers }
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

// ── fail-fast (1.6) ────────────────────────────────────────────────────────

test('fail-fast: an empty active url rejects before any plugin call', async () => {
  const { transport, plugin } = setup()
  const ok = await transport.engage([{ index: 0, trackId: 't1', url: '' }], 0, 'none')
  assert.equal(ok, false)
  assert.equal(transport.engaged, false)
  assert.equal(plugin.setQueueCalls.length, 0)
  assert.equal(plugin.playTrackAtCalls.length, 0)
})

test('fail-fast: an out-of-bounds activeIndex rejects before any plugin call', async () => {
  const { transport, plugin } = setup()
  const ok = await transport.engage(tracks, 5, 'none')
  assert.equal(ok, false)
  assert.equal(plugin.setQueueCalls.length, 0)
})

test('a fail-fast engage queued behind an in-flight one never touches the engine', async () => {
  const { transport, plugin } = setup()
  let release!: () => void
  plugin.setQueueGate = new Promise((r) => {
    release = r
  })
  const p1 = transport.engage(tracks, 0, 'none')
  const p2 = transport.engage([{ index: 0, trackId: 't1', url: '' }], 0, 'none')
  release()
  assert.equal(await p1, true)
  assert.equal(await p2, false)
  assert.deepEqual(plugin.order, ['setQueue:0', 'playTrackAt:0'])
})

// ── retry machine ──────────────────────────────────────────────────────────

test('an engine error with no engaged track is ignored', async () => {
  const { transport, client, timers } = setupTimed()
  const ended: TransportEndedEvent[] = []
  transport.onTrackEnded = (e) => ended.push(e)
  await transport.init()
  client.callbacks!.onError('boom')
  assert.equal(timers.entries.length, 0)
  assert.deepEqual(ended, [])
})

test('an engine error schedules the 1s retry; the fire forwards onRetry', async () => {
  const { transport, client, timers } = setupTimed()
  const retried: string[] = []
  transport.onRetry = (id) => retried.push(id)
  await transport.init()
  await transport.engage(tracks, 0, 'none')
  client.callbacks!.onError('boom')
  assert.equal(timers.entries.length, 1)
  assert.equal(timers.entries[0].delayMs, 1000)
  assert.equal(timers.entries[0].cancelled, false)
  assert.deepEqual(retried, [])
  timers.fireAll()
  assert.deepEqual(retried, ['t1'])
})

test('a second error cancels the pending timer and backs off to 2s', async () => {
  const { transport, client, timers } = setupTimed()
  const retried: string[] = []
  transport.onRetry = (id) => retried.push(id)
  await transport.init()
  await transport.engage(tracks, 0, 'none')
  client.callbacks!.onError('e1')
  client.callbacks!.onError('e2')
  assert.deepEqual(timers.entries.map((e) => e.delayMs), [1000, 2000])
  assert.equal(timers.entries[0].cancelled, true)
  assert.equal(timers.entries[1].cancelled, false)
  timers.fireAll()
  assert.deepEqual(retried, ['t1'])
})

test('give-up after 3 errors: onTrackEnded natural+fromError and no armed timers', async () => {
  const { transport, client, timers } = setupTimed()
  const ended: TransportEndedEvent[] = []
  const retried: string[] = []
  transport.onTrackEnded = (e) => ended.push(e)
  transport.onRetry = (id) => retried.push(id)
  await transport.init()
  await transport.engage(tracks, 0, 'none')
  client.callbacks!.onError('e1')
  client.callbacks!.onError('e2')
  client.callbacks!.onError('e3')
  assert.deepEqual(ended, [{ kind: 'natural', fromError: true }])
  timers.fireAll()
  assert.deepEqual(retried, [])
  assert.equal(timers.entries.filter((e) => !e.cancelled).length, 0)
})

test('a track change during the retry window suppresses the fire (track-keyed validity)', async () => {
  const { transport, client, timers } = setupTimed()
  const retried: string[] = []
  transport.onRetry = (id) => retried.push(id)
  await transport.init()
  await transport.engage(tracks, 0, 'none')
  client.callbacks!.onError('boom')
  client.callbacks!.onTrackChanged('t2')
  timers.fireAll()
  assert.deepEqual(retried, [])
})

test('a reload engage resets the retry policy (fresh backoff after reload)', async () => {
  const { transport, client, timers } = setupTimed()
  const retried: string[] = []
  transport.onRetry = (id) => retried.push(id)
  await transport.init()
  await transport.engage(tracks, 0, 'none')
  client.callbacks!.onError('e1')
  client.callbacks!.onError('e2')
  timers.fireAll()
  assert.deepEqual(retried, ['t1'])
  assert.equal(await transport.engage(tracks, 0, 'none'), true)
  client.callbacks!.onError('e3')
  const armed = timers.entries.filter((e) => !e.cancelled)
  assert.equal(armed.length, 1)
  assert.equal(armed[0].delayMs, 1000)
})

// ── seek memory (1.7) ──────────────────────────────────────────────────────

test('a retry reload of the SAME track re-issues the remembered seek after playTrackAt', async () => {
  const { transport, client, plugin, timers } = setupTimed()
  const retried: string[] = []
  transport.onRetry = (id) => retried.push(id)
  await transport.init()
  await transport.engage(tracks, 0, 'none')
  await transport.seek(30)
  client.callbacks!.onError('boom')
  timers.fireAll()
  assert.deepEqual(retried, ['t1'])
  assert.equal(await transport.engage(tracks, 0, 'none'), true)
  assert.deepEqual(plugin.order, [
    'setQueue:0',
    'playTrackAt:0',
    'seek:30',
    'setQueue:0',
    'playTrackAt:0',
    'seek:30',
  ])
})

test('the remembered seek is consumed: a second reload does not re-issue it', async () => {
  const { transport, client, plugin, timers } = setupTimed()
  transport.onRetry = () => {}
  await transport.init()
  await transport.engage(tracks, 0, 'none')
  await transport.seek(30)
  client.callbacks!.onError('boom')
  timers.fireAll()
  await transport.engage(tracks, 0, 'none')
  await transport.engage(tracks, 0, 'none')
  assert.deepEqual(plugin.order.filter((o) => o.startsWith('seek:')), ['seek:30', 'seek:30'])
})

test('a retry reload of a DIFFERENT track does not re-issue the seek', async () => {
  const { transport, client, plugin, timers } = setupTimed()
  transport.onRetry = () => {}
  await transport.init()
  await transport.engage(tracks, 0, 'none')
  await transport.seek(30)
  client.callbacks!.onError('boom')
  timers.fireAll()
  assert.equal(await transport.engage(tracks, 1, 'none'), true)
  assert.deepEqual(plugin.order, ['setQueue:0', 'playTrackAt:0', 'seek:30', 'setQueue:1', 'playTrackAt:1'])
})

test('a plain re-engage (no retry) never re-seeks', async () => {
  const { transport, plugin } = setup()
  await transport.engage(tracks, 0, 'none')
  await transport.seek(30)
  await transport.engage(tracks, 0, 'none')
  assert.deepEqual(plugin.order.filter((o) => o.startsWith('seek:')), ['seek:30'])
})

test('disengage cancels the retry and clears the seek memory', async () => {
  const { transport, client, plugin, timers } = setupTimed()
  const retried: string[] = []
  transport.onRetry = (id) => retried.push(id)
  await transport.init()
  await transport.engage(tracks, 0, 'none')
  await transport.seek(30)
  client.callbacks!.onError('boom')
  transport.disengage()
  timers.fireAll()
  assert.deepEqual(retried, [])
  assert.equal(await transport.engage(tracks, 0, 'none'), true)
  assert.deepEqual(plugin.order.filter((o) => o.startsWith('seek:')), ['seek:30'])
})

// ── engage serialization ───────────────────────────────────────────────────

test('rapid engages serialize into full setQueue+playTrackAt pairs in order', async () => {
  const { transport, plugin } = setup()
  const p1 = transport.engage(tracks, 0, 'none')
  const p2 = transport.engage(tracks, 1, 'none')
  assert.equal(await p1, true)
  assert.equal(await p2, true)
  assert.deepEqual(plugin.order, ['setQueue:0', 'playTrackAt:0', 'setQueue:1', 'playTrackAt:1'])
  assert.equal(transport.engaged, true)
})

test('queued engages supersede: only the latest survivor runs after the in-flight one', async () => {
  const { transport, plugin } = setup()
  let release!: () => void
  plugin.setQueueGate = new Promise((r) => {
    release = r
  })
  const p1 = transport.engage(tracks3, 0, 'none')
  const p2 = transport.engage(tracks3, 1, 'none')
  const p3 = transport.engage(tracks3, 2, 'none')
  release()
  assert.equal(await p1, true)
  assert.equal(await p2, true)
  assert.equal(await p3, true)
  assert.deepEqual(plugin.order, ['setQueue:0', 'playTrackAt:0', 'setQueue:2', 'playTrackAt:2'])
})

test('a disengage mid-cycle drops the queued engage', async () => {
  const { transport, plugin } = setup()
  let release!: () => void
  plugin.setQueueGate = new Promise((r) => {
    release = r
  })
  const p1 = transport.engage(tracks, 0, 'none')
  const p2 = transport.engage(tracks, 1, 'none')
  transport.disengage()
  release()
  assert.equal(await p1, false)
  assert.equal(await p2, false)
  assert.equal(transport.engaged, false)
  assert.deepEqual(plugin.order, ['setQueue:0', 'playTrackAt:0'])
})

test('an engage after a disengage runs fresh (generation only drops stale settles)', async () => {
  const { transport, plugin } = setup()
  await transport.engage(tracks, 0, 'none')
  transport.disengage()
  assert.equal(await transport.engage(tracks, 1, 'none'), true)
  assert.equal(transport.engaged, true)
  assert.deepEqual(plugin.order, ['setQueue:0', 'playTrackAt:0', 'setQueue:1', 'playTrackAt:1'])
})

test('an engage queued in the settle window (after an awaited engage + seek) is not orphaned', async () => {
  const { transport, plugin } = setup()
  // The caller's continuation runs before the cycle's `.finally` clears the
  // in-flight flag — a second engage issued there must be handed to a fresh
  // cycle, not dropped with a promise that never resolves.
  await transport.engage(tracks, 0, 'none')
  await transport.seek(1)
  assert.equal(await transport.engage(tracks, 1, 'none'), true)
  assert.equal(transport.engaged, true)
  assert.deepEqual(plugin.order, ['setQueue:0', 'playTrackAt:0', 'seek:1', 'setQueue:1', 'playTrackAt:1'])
})

test('a tail sync waits for an in-flight engage to settle before refreshing', async () => {
  const { transport, plugin } = setup()
  await transport.engage(tracks, 0, 'none')

  let release!: () => void
  plugin.setQueueGate = new Promise((r) => {
    release = r
  })
  const p2 = transport.engage(tracks, 1, 'none')

  transport.scheduleSync(() => ({ tracks: tracks3, activeIndex: 1 }))
  await tick()
  // The refresh must NOT fire while the engage is in flight.
  assert.equal(plugin.refreshCalls.length, 0)

  release()
  assert.equal(await p2, true)
  await tick()
  assert.equal(plugin.refreshCalls.length, 1)
  assert.deepEqual(plugin.order, ['setQueue:0', 'playTrackAt:0', 'setQueue:1', 'playTrackAt:1', 'refreshQueue'])
})
// Pins the low-data-mode WIRING invariants that live in the ADAPTERS (the
// pure policy matrix is pinned by tests/transcodePolicy.test.ts):
//  1. the `effectiveLowData` composition (manual OR cellular-known OR OS flag),
//  2. the flush engine's autoFlush gate (kick/tick suspended, runNow alive),
//  3. the manager's LDM engage/lift edges (scan cancel on an ACTIVE scan only,
//     one flush kick on lift) and the transcode-change invalidation edges
//     (native snapshot sync / web re-arm).
// The networkStatus store is driven through the `__setNetworkStatus` test hook
// (the `__setScannerDeps` precedent) — no Capacitor or Connection-API fakes.

import './stub-audio-worklet-node'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { settings, metadataScanState, type Track } from '../src/stores/appState'
import { effectiveLowData, __setNetworkStatus } from '../src/lib/networkMode'
import { PlaybackManager } from '../src/lib/playbackManager'
import { tagProbeState } from '../src/lib/metadataScanner'
import { engine } from '../src/lib/engineFacade'
import { queueManager } from '../src/lib/queueManager'
import { ScrobbleFlushEngine, scrobbleFlushEngine, scrobbleFlushStatus, type FlushStore } from '../src/lib/scrobbleFlush'
import { setCachedConfig } from '../src/lib/navidromeApi'
import type { PendingScrobbleRow } from '../src/lib/db'

// --- fakes (the playbackManagerRestore harness pattern) ---------------------

class FakeEngine {
  calls: string[] = []
  setSpeed(v: number): void { this.calls.push(`setSpeed:${v}`) }
  setSnapTolerance(v: number): void { this.calls.push(`setSnapTolerance:${v}`) }
  setPitchOctaves(v: number): void { this.calls.push(`setPitchOctaves:${v}`) }
  setMasterVolume(v: number): void { this.calls.push(`setMasterVolume:${v}`) }
  setTapeMode(v: boolean): void { this.calls.push(`setTapeMode:${v}`) }
  setCrossfade(v: number): void { this.calls.push(`setCrossfade:${v}`) }
  setAudioMixing(mode: string): void { this.calls.push(`setAudioMixing:${mode}`) }
  pushNativeEqFromStore(): void { this.calls.push('pushNativeEqFromStore') }
}

class FakeQueueManager {
  replenished = 0
  rebuilt = 0
  replenishAutoQueue(): void { this.replenished++ }
  rebuildAutoQueue(): void { this.rebuilt++ }
}

type ManagerPrivates = {
  _subscribeShared(): Array<() => void>
  _initialized: boolean
}

type ManagerHarness = {
  m: PlaybackManager
  priv: ManagerPrivates
  /** Unsubscribes every `_subscribeShared` handle — MANDATORY in finally, or a
   *  later test's store reset fires this manager's lift edge into the REAL
   *  singleton flush engine (Dexie kick → unhandled rejection in Node). */
  cleanup(): void
}

function makeManager(opts: { isNative?: () => boolean } = {}): ManagerHarness {
  const m = new PlaybackManager({
    engine: new FakeEngine() as unknown as typeof engine,
    queueManager: new FakeQueueManager() as unknown as typeof queueManager,
    isNative: opts.isNative,
  })
  const priv = m as unknown as ManagerPrivates
  let unsubs: Array<() => void> = []
  const harness: ManagerHarness = {
    m,
    priv,
    cleanup() {
      for (const u of unsubs) u()
      unsubs = []
    },
  }
  return harness
}

/** Subscribes the harness and REMEMBERS the handles so cleanup() also
 *  unsubscribes — the store singletons outlive every test. */
function subscribeShared(h: ManagerHarness): void {
  const unsubs = h.priv._subscribeShared()
  const base = h.cleanup
  h.cleanup = () => {
    for (const u of unsubs) u()
    base()
  }
}

function resetLowDataState(): void {
  __setNetworkStatus({ known: false, isCellular: false, osLowData: false })
  settings.set({})
}

function scanningState(): void {
  metadataScanState.set({
    status: 'scanning',
    progress: { scanned: 2, total: 10, failed: 0, notFound: 0, missing: 0, duplicateMatches: 0 },
  })
}

// 1. effectiveLowData composition — the derived store is THE gate (A13);
//    every consumer reading the raw setting instead would bypass these rules.
test('effectiveLowData is false by default (never guesses toward engagement)', () => {
  resetLowDataState()
  assert.equal(get(effectiveLowData), false)
})

test('effectiveLowData: the manual toggle alone engages', () => {
  resetLowDataState()
  settings.set({ lowDataMode: true })
  assert.equal(get(effectiveLowData), true)
})

test('effectiveLowData: cellular auto-toggle engages ONLY when cellular is known', () => {
  resetLowDataState()
  settings.set({ lowDataOnCellular: true })

  __setNetworkStatus({ known: false, isCellular: true })
  assert.equal(get(effectiveLowData), false, 'unknown network must never engage')

  __setNetworkStatus({ known: true, isCellular: false })
  assert.equal(get(effectiveLowData), false, 'known Wi-Fi must not engage')

  __setNetworkStatus({ known: true, isCellular: true })
  assert.equal(get(effectiveLowData), true)
})

test('effectiveLowData: the OS Low Data Mode flag engages on its own', () => {
  resetLowDataState()
  __setNetworkStatus({ known: true, isCellular: false, osLowData: true })
  assert.equal(get(effectiveLowData), true)
})

test('effectiveLowData: a manual toggle survives leaving cellular', () => {
  resetLowDataState()
  settings.set({ lowDataOnCellular: true, lowDataMode: true })
  __setNetworkStatus({ known: true, isCellular: true })
  assert.equal(get(effectiveLowData), true)
  __setNetworkStatus({ known: true, isCellular: false })
  assert.equal(get(effectiveLowData), true, 'manual toggle keeps LDM on')
})

// 2. flush engine gate — the durable queue must never be touched by the gate;
//    only the AUTOMATIC delivery stops. (The singleton is gated in App boot;
//    fresh instances pin the mechanism itself.)
function memoryStore(): FlushStore & { rows: Array<PendingScrobbleRow & { seq: number }> } {
  const rows: Array<PendingScrobbleRow & { seq: number }> = []
  let nextSeq = 1
  return {
    rows,
    async enqueue(row) {
      if (rows.some((r) => r.kind === row.kind && r.artist === row.artist && r.track === row.track && r.timestamp === row.timestamp)) return false
      rows.push({ ...row, seq: nextSeq++ })
      return true
    },
    async oldest(limit) { return [...rows].sort((a, b) => a.seq - b.seq).slice(0, limit) },
    async remove(seqs) { for (const seq of seqs) { const i = rows.findIndex((r) => r.seq === seq); if (i >= 0) rows.splice(i, 1) } },
    async markFailed(failed) { for (const row of failed) { const t = rows.find((r) => r.seq === row.seq); if (t) t.attempts++ } },
    async count() { return rows.length },
  }
}

function spyDeps() {
  const submitted: string[] = []
  return {
    submitted,
    deps: {
      batchSize: () => 50,
      lfmScrobble: async (metas: Array<{ track: string }>) => { metas.forEach((m) => submitted.push(m.track)) },
      lfmLove: async () => {},
      lbListen: async () => {},
      lbFeedback: async () => {},
    },
  }
}

test('flush gate: suspended engine holds rows (kick no-op) but runNow still delivers', async () => {
  const store = memoryStore()
  const { submitted, deps } = spyDeps()
  const eng = new ScrobbleFlushEngine(store, deps)
  eng.setAutoFlushEnabled(false)

  const before = get(scrobbleFlushStatus).pending
  await eng.enqueue('lfm-scrobble', 'Artist', 'Track')
  assert.equal(store.rows.length, 1, 'the row IS enqueued durably')
  assert.equal(get(scrobbleFlushStatus).pending, before + 1)
  assert.equal(submitted.length, 0, 'autoKick must not deliver while suspended')

  eng.kick()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(submitted.length, 0, 'an explicit kick is still gated')

  await eng.runNow()
  assert.deepEqual(submitted, ['Track'], 'explicit runNow bypasses the gate')
  assert.equal(store.rows.length, 0)
})

test('flush gate: an enabled engine delivers via kick (the gate demonstrably gated something)', async () => {
  const store = memoryStore()
  const { submitted, deps } = spyDeps()
  // autoKick false: the enqueue-kick would race the assertion; the point is
  // that WITHOUT the suspension, an explicit kick delivers.
  const eng = new ScrobbleFlushEngine(store, deps, { autoKick: false })
  await eng.enqueue('lfm-scrobble', 'Artist', 'Track')
  assert.equal(submitted.length, 0)
  eng.kick()
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(submitted, ['Track'], 'kick delivers when autoFlush is enabled')
  assert.equal(store.rows.length, 0)
})

// 3. manager LDM edges. `_initialized` is set directly (the restore-harness
//    pattern: the real init() needs DOM/Dexie; the logic under test is
//    `_subscribeShared`'s). Every subscribing test unsubscribes in finally.
test('LDM engage cancels an ACTIVE scan (honest D4 landing) via the cellular edge', () => {
  resetLowDataState()
  const h = makeManager()
  h.priv._initialized = true
  try {
    subscribeShared(h)

    scanningState()
    settings.set({ lowDataOnCellular: true })
    __setNetworkStatus({ known: true, isCellular: true })

    const st = get(metadataScanState)
    assert.equal(st.status, 'complete', 'the scan was cancelled, not left mid-scanning')
    assert.ok(st.progress.annotation?.startsWith('Cancelled'), 'the landing is honest')
  } finally {
    h.cleanup()
  }
})

test('LDM engage via the manual toggle cancels an ACTIVE scan too', () => {
  resetLowDataState()
  const h = makeManager()
  h.priv._initialized = true
  try {
    subscribeShared(h)

    scanningState()
    settings.set({ lowDataMode: true })
    assert.equal(get(metadataScanState).status, 'complete')
  } finally {
    h.cleanup()
  }
})

test('LDM engage with NO active scan leaves the scan state untouched', () => {
  resetLowDataState()
  const h = makeManager()
  h.priv._initialized = true
  try {
    subscribeShared(h)

    metadataScanState.set({ status: 'idle', progress: { scanned: 0, total: 0, failed: 0, notFound: 0, missing: 0, duplicateMatches: 0 } })
    settings.set({ lowDataMode: true })
    assert.equal(get(metadataScanState).status, 'idle', 'an idle cancelScan must be a no-op')
  } finally {
    h.cleanup()
  }
})

test('LDM engage aborts an ACTIVE standalone tag probe (the tail runs after the scan state lands)', () => {
  resetLowDataState()
  const h = makeManager()
  h.priv._initialized = true
  // Observable-effect pin: the post-scan tail and the boot/restore probe both
  // run while metadataScanState is already terminal, so the scan-status guard
  // alone misses them — engage must abort the probe itself. The probe's
  // `active` flag is the user-visible signal the edge's cancel resets
  // (the gen-bump abort semantics are pinned in scannerLifecycle.test.ts).
  const idle = { active: false, done: 0, remaining: 0, revision: 0, resolved: 0 }
  // The lift edge kicks the module-singleton engine — patch it out so the
  // real Dexie-backed kick never fires in Node (the lift-kick behavior is
  // pinned separately below).
  const singleton = scrobbleFlushEngine as unknown as { kick(): void }
  const realKick = singleton.kick
  singleton.kick = () => {}
  try {
    subscribeShared(h)

    tagProbeState.set({ active: true, done: 3, remaining: 5, revision: 1, resolved: 0 })
    settings.set({ lowDataMode: true }) // engage
    assert.equal(get(tagProbeState).active, false, 'engage aborts the active probe')

    // Lift must NOT re-probe (no make-up): the state stays idle.
    settings.set({ lowDataMode: false })
    assert.deepEqual(get(tagProbeState), { ...idle, revision: 1 }, 'lift leaves the probe idle — no make-up')
  } finally {
    singleton.kick = realKick
    tagProbeState.set(idle)
    h.cleanup()
  }
})

test('LDM lift kicks the flush engine exactly once', () => {
  resetLowDataState()
  const h = makeManager()
  h.priv._initialized = true
  // The lift edge calls the MODULE-SINGLETON engine's kick — patch the
  // instance method (lookup is at call time) and restore it in finally; the
  // singleton is otherwise the real Dexie-backed engine.
  const singleton = scrobbleFlushEngine as unknown as { kick(): void }
  const realKick = singleton.kick
  let kicks = 0
  singleton.kick = () => { kicks++ }
  try {
    subscribeShared(h)

    settings.set({ lowDataMode: true }) // engage
    settings.set({ lowDataMode: false }) // lift → one kick
    assert.equal(kicks, 1, 'the lift edge kicks exactly one flush cycle')
  } finally {
    singleton.kick = realKick
    h.cleanup()
  }
})

// Mid-session TRANSITIONS on the REAL engine (fresh instance + memory store,
// not the Dexie singleton): the engage edge flips autoFlushEnabled and the
// lift edge's enable-then-kick order actually delivers a row that was
// enqueued while suspended — the full held-then-delivered cycle.
test('flush engine mid-session: rows enqueued under LDM deliver on the lift edge', async () => {
  resetLowDataState()
  const store = memoryStore()
  const { submitted, deps } = spyDeps()
  const eng = new ScrobbleFlushEngine(store, deps, { autoKick: false })
  const h = makeManager()
  h.priv._initialized = true
  // Route the manager's edges into the FRESH engine instead of the Dexie
  // singleton (patch-at-call-time convention; restored in finally).
  const singleton = scrobbleFlushEngine as unknown as Record<string, unknown>
  const realSet = singleton.setAutoFlushEnabled
  const realKick = singleton.kick
  singleton.setAutoFlushEnabled = (v: boolean) => eng.setAutoFlushEnabled(v)
  singleton.kick = () => eng.kick()
  try {
    subscribeShared(h)

    settings.set({ lowDataMode: true }) // engage — the edge suspends the gate
    assert.equal(get(effectiveLowData), true)
    await eng.enqueue('lfm-scrobble', 'Artist', 'Track')
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(submitted.length, 0, 'nothing delivers while LDM is engaged')
    assert.equal(store.rows.length, 1, 'the row stays queued durably')

    settings.set({ lowDataMode: false }) // lift — flip THEN kick, in order
    await new Promise((r) => setTimeout(r, 0))
    assert.deepEqual(submitted, ['Track'], 'the lift edge delivers the held row')
    assert.equal(store.rows.length, 0)
  } finally {
    singleton.setAutoFlushEnabled = realSet
    singleton.kick = realKick
    h.cleanup()
  }
})

test('flush engine mid-session: the engage edge suspends a running auto-drain', async () => {
  resetLowDataState()
  const store = memoryStore()
  const { submitted, deps } = spyDeps()
  const eng = new ScrobbleFlushEngine(store, deps, { autoKick: false })
  const h = makeManager()
  h.priv._initialized = true
  const singleton = scrobbleFlushEngine as unknown as Record<string, unknown>
  const realSet = singleton.setAutoFlushEnabled
  const realKick = singleton.kick
  singleton.setAutoFlushEnabled = (v: boolean) => eng.setAutoFlushEnabled(v)
  singleton.kick = () => eng.kick()
  try {
    subscribeShared(h)

    // Row present, gate ON (boot-time state): a kick delivers normally.
    await eng.enqueue('lfm-scrobble', 'Artist', 'Track')
    eng.kick()
    await new Promise((r) => setTimeout(r, 0))
    assert.deepEqual(submitted, ['Track'], 'the engine works before any LDM edge')

    // Engage mid-session: the edge flips the gate — subsequent kicks no-op.
    settings.set({ lowDataMode: true })
    await eng.enqueue('lfm-scrobble', 'Artist', 'Track2')
    eng.kick()
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(submitted.length, 1, 'no delivery while suspended')
    assert.equal(store.rows.length, 1, 'the second row waits durably')
  } finally {
    singleton.setAutoFlushEnabled = realSet
    singleton.kick = realKick
    h.cleanup()
  }
})

// 4. transcode-change invalidation (the staleness guard): native re-syncs the
//    snapshot, web re-arms the crossfade target; unrelated settings changes
//    must not. The private methods are shadowed with counting spies (the bg
//    suite's private-access convention) and asserted by DELTA — the queue
//    subscription fires once at subscribe time, so absolute counts start at 1.
test('a transcode settings change triggers native snapshot re-sync exactly once', () => {
  resetLowDataState()
  // `isNative: () => true` routes the subscription into the native branch —
  // without the injection, Node's Capacitor.isNativePlatform() is false and
  // the web branch would run instead.
  const h = makeManager({ isNative: () => true })
  h.priv._initialized = true
  try {
    let syncs = 0
    ;(h.m as unknown as Record<string, unknown>)._scheduleNativeQueueSync = () => { syncs++ }
    // Also shadow the per-fire preload push — with isNative true it would hit
    // the REAL Capacitor plugin on every settings fire.
    ;(h.m as unknown as Record<string, unknown>)._syncNativePreload = () => {}
    subscribeShared(h)
    const baseline = syncs

    settings.set({ transcodeMode: 'off', scrobbling: false })
    assert.equal(syncs, baseline, 'unrelated settings changes must not re-sync')

    settings.set({ transcodeMode: 'always', scrobbling: false })
    assert.equal(syncs, baseline + 1, 'the mode change re-syncs the native snapshot once')
  } finally {
    h.cleanup()
  }
})

test('a transcode settings change re-arms the WEB crossfade target exactly once', () => {
  resetLowDataState()
  const h = makeManager()
  h.priv._initialized = true
  try {
    let rearms = 0
    ;(h.m as unknown as Record<string, unknown>)._rearmCrossfadeTarget = () => { rearms++ }
    subscribeShared(h)
    const baseline = rearms

    settings.set({ transcodeMode: 'off', transcodeFormat: 'opus', transcodeBitrate: 128 })
    assert.equal(rearms, baseline, 'the subscription init fire must NOT invalidate')

    settings.set({ transcodeMode: 'lowData', transcodeFormat: 'opus', transcodeBitrate: 128 })
    assert.equal(rearms, baseline + 1, 'the mode change re-arms once')

    settings.set({ transcodeMode: 'lowData', transcodeFormat: 'mp3', transcodeBitrate: 128 })
    assert.equal(rearms, baseline + 2, 'a format change re-arms too')

    settings.set({ transcodeMode: 'lowData', transcodeFormat: 'mp3', transcodeBitrate: 192 })
    assert.equal(rearms, baseline + 3, 'a bitrate change re-arms too')

    settings.set({ transcodeMode: 'lowData', transcodeFormat: 'mp3', transcodeBitrate: 192, scrobbling: false })
    assert.equal(rearms, baseline + 3, 'an unrelated change must not re-arm')
  } finally {
    h.cleanup()
  }
})

// 5. The A11 asymmetry under LDM: the DIRECT Navidrome legs are suppressed
//    (no server HTTP fires) while the DURABLE Last.fm/ListenBrainz legs keep
//    enqueueing — a master gate here would starve direct-only users and a
//    gated LFM leg would drop listens offline. Driven through the REAL
//    defaultDestinations() wiring (spy fetch + patched flush singleton),
//    because the gate lives at the fire site, not in the pure helpers.
test('LDM suppresses the direct Navidrome scrobble legs but Last.fm/LB stay durable', async (t) => {
  const originalFetch = globalThis.fetch
  const httpCalls: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    httpCalls.push(String(input))
    return new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = originalFetch })

  const flushSingleton = scrobbleFlushEngine as unknown as { enqueue: typeof scrobbleFlushEngine.enqueue }
  const realEnqueue = flushSingleton.enqueue
  const enqueued: string[] = []
  flushSingleton.enqueue = (async (kind: string, _artist: string, track: string) => {
    enqueued.push(`${kind}:${track}`)
    return true
  }) as typeof flushSingleton.enqueue
  t.after(() => { flushSingleton.enqueue = realEnqueue })

  const { ScrobbleManager: SM } = await import('../src/lib/scrobbleManager')
  const { __setLfmSessionForTests } = await import('../src/lib/lastfmAuth')
  __setLfmSessionForTests({ key: 'sk-test', name: 'tester' })
  t.after(() => { __setLfmSessionForTests(null) })

  resetLowDataState()
  settings.set({ scrobbling: true, lastfmScrobbling: true, listenbrainzScrobbling: true, listenbrainzToken: 'tok' })
  __setNetworkStatus({ known: true, isCellular: false })

  const manager = new SM() // defaultDestinations() — the real wiring
  manager.enable()
  // The fire-site gates live on the DESTINATIONS object (private; the
  // private-access convention used across the manager suites) — the manager
  // itself is deliberately gate-free (A11).
  const dests = (manager as unknown as { destinations: {
    navidromeScrobble(track: Track, startedAtMs: number): void
    navidromeNowPlaying(track: Track): void
    lastfmScrobble(event: { artist: string; title: string; album: string; albumArtist?: string; duration: number; startedAtMs: number }): void
    listenbrainzScrobble(event: { artist: string; title: string; album: string; albumArtist?: string; duration: number; startedAtMs: number }): void
  } }).destinations
  const track: Track = { trackId: 'navidrome-1', title: 'Song', artist: 'Artist', album: 'Album', duration: 300, fileType: 'mp3' }
  // A live config is REQUIRED for a non-vacuous gate pin: the navidrome leg
  // checks config AFTER the LDM gate, so with no config the leg would be
  // suppressed regardless of LDM and the assertion would prove nothing.
  setCachedConfig({ baseUrl: 'https://srv.example', username: 'u', password: 'p' })
  try {
    // Phase 1 — LDM OFF: the direct leg really fires (the gate demonstrably gates).
    __setNetworkStatus({ known: true, isCellular: false })
    assert.equal(get(effectiveLowData), false)
    dests.navidromeScrobble(track, Date.now())
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(httpCalls.length, 1, 'the leg fires end-to-end with LDM off')
    assert.ok(new URL(httpCalls[0]).pathname.endsWith('/rest/scrobble'))

    // Phase 2 — LDM ON (the OS flag): both direct legs are suppressed.
    __setNetworkStatus({ known: true, isCellular: false, osLowData: true })
    assert.equal(get(effectiveLowData), true)
    dests.navidromeScrobble(track, Date.now())
    dests.navidromeNowPlaying(track)
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(httpCalls.length, 1, 'no ADDITIONAL server HTTP while LDM is engaged')

    // Phase 3 — the DURABLE legs keep enqueueing under LDM (A11 asymmetry).
    dests.lastfmScrobble({ artist: 'Artist', title: 'Song', album: 'Album', duration: 300, startedAtMs: Date.now() })
    dests.listenbrainzScrobble({ artist: 'Artist', title: 'Song', album: 'Album', duration: 300, startedAtMs: Date.now() })
    await new Promise((r) => setTimeout(r, 0))
    assert.ok(enqueued.includes('lfm-scrobble:Song'), 'the Last.fm leg enqueues durably under LDM')
    assert.ok(enqueued.includes('lb-listen:Song'), 'the ListenBrainz leg enqueues durably under LDM')
  } finally {
    manager.disable()
    setCachedConfig(null)
    resetLowDataState()
  }
})

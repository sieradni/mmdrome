// Pins the durable scrobble/heart queue lifecycle over an in-memory store and
// fake submitters: dedupe via the unique-event identity, successful drain,
// attempt bumping on failure, poison drop at the cap, expiry of stale
// time-sensitive entries, per-kind dispatch, and MBID-miss skipping.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ScrobbleFlushEngine, NoMbidMatchError, scrobbleFlushStatus, type FlushStore } from '../src/lib/scrobbleFlush'
import { get } from 'svelte/store'
import { settings } from '../src/stores/appState'
import { LastfmError } from '../src/lib/lastfmApi'
import type { PendingScrobbleRow } from '../src/lib/db'
import type { ScrobbleMeta } from '../src/lib/lastfmCore'

interface MemoryRow extends PendingScrobbleRow {
  seq: number
}

interface DepsSpy {
  batchSize: () => number
  lfmScrobble: (metas: ScrobbleMeta[]) => Promise<void>
  lfmLove: (artist: string, track: string, loved: boolean) => Promise<void>
  lbListen: (entry: PendingScrobbleRow, playingNow: boolean) => Promise<void>
  lbFeedback: (artist: string, track: string, score: 1 | 0 | -1) => Promise<void>
}

function memoryStore(): FlushStore & { rows: MemoryRow[] } {
  const rows: MemoryRow[] = []
  let nextSeq = 1
  return {
    rows,
    async enqueue(row) {
      if (rows.some((r) => r.kind === row.kind && r.artist === row.artist && r.track === row.track && r.timestamp === row.timestamp)) {
        return false
      }
      rows.push({ ...row, seq: nextSeq++ })
      return true
    },
    async oldest(limit) {
      return [...rows].sort((a, b) => a.seq - b.seq).slice(0, limit)
    },
    async remove(seqs) {
      for (const seq of seqs) {
        const i = rows.findIndex((r) => r.seq === seq)
        if (i >= 0) rows.splice(i, 1)
      }
    },
    async markFailed(failed) {
      for (const row of failed) {
        const target = rows.find((r) => r.seq === row.seq)
        if (target) target.attempts = target.attempts + 1
      }
    },
    async count() {
      return rows.length
    },
  }
}

function spyDeps(over: Partial<DepsSpy> = {}): DepsSpy {
  return {
    batchSize: () => 50,
    lfmScrobble: async () => {},
    lfmLove: async () => {},
    lbListen: async () => {},
    lbFeedback: async () => {},
    ...over,
  }
}

function engineWith(store: ReturnType<typeof memoryStore>, deps: DepsSpy): ScrobbleFlushEngine {
  // autoKick=false + backoffMs=0 keep the lifecycle fully deterministic.
  return new ScrobbleFlushEngine(store, deps, { backoffMs: 0, autoKick: false })
}

test('enqueue dedupes identical events and drains on delivery success', async () => {
  const store = memoryStore()
  const scrobbled: ScrobbleMeta[] = []
  const engine = engineWith(store, spyDeps({ lfmScrobble: async (metas) => { scrobbled.push(...metas) } }))
  const ts = Math.floor(Date.now() / 1000)

  assert.equal(await engine.enqueue('lfm-scrobble', 'A', 'T', { timestamp: ts }), true)
  assert.equal(await engine.enqueue('lfm-scrobble', 'A', 'T', { timestamp: ts }), false, 'unique identity rejects the duplicate')

  await engine.runNow()
  assert.equal(store.rows.length, 0)
  assert.equal(scrobbled.length, 1)
  assert.equal(scrobbled[0].timestamp, ts)
  assert.equal(get(scrobbleFlushStatus).pending, 0)
})

test('a failing batch bumps attempts and keeps the row queued; recovery drains it', async () => {
  const store = memoryStore()
  let failing = true
  const engine = engineWith(store, spyDeps({
    lfmScrobble: async () => {
      if (failing) throw new Error('network down')
    },
  }))
  await engine.enqueue('lfm-scrobble', 'A', 'T', { timestamp: Math.floor(Date.now() / 1000) })

  await engine.runNow()
  assert.equal(store.rows.length, 1)
  assert.equal(store.rows[0].attempts, 1)

  failing = false
  await engine.runNow()
  assert.equal(store.rows.length, 0)
})

test('entries at the attempt cap are dropped without submitting (poison guard)', async () => {
  const store = memoryStore()
  let submitted = 0
  const engine = engineWith(store, spyDeps({ lfmScrobble: async () => { submitted++ } }))
  await store.enqueue({ kind: 'lfm-scrobble', artist: 'X', track: 'Y', timestamp: 1700000000, queuedAt: Date.now(), attempts: 8 })
  const before = get(scrobbleFlushStatus).dropped

  await engine.runNow()
  assert.equal(submitted, 0, 'poison rows never reach the wire again')
  assert.equal(store.rows.length, 0)
  assert.equal(get(scrobbleFlushStatus).dropped, before + 1, 'drop is surfaced in the status store')
})

test('stale time-sensitive entries expire; hearts of the same age do not', async () => {
  const store = memoryStore()
  const loves: [string, boolean][] = []
  const engine = engineWith(store, spyDeps({
    lfmLove: async (_artist, track, loved) => { loves.push([track, loved]) },
  }))
  const ancientSec = Math.floor(Date.now() / 1000) - 20 * 24 * 3600
  await store.enqueue({ kind: 'lfm-scrobble', artist: 'A', track: 'OldListen', timestamp: ancientSec, queuedAt: Date.now(), attempts: 0 })
  await store.enqueue({ kind: 'lfm-love', artist: 'A', track: 'OldHeart', timestamp: ancientSec, queuedAt: Date.now(), attempts: 0 })
  const before = get(scrobbleFlushStatus).dropped

  await engine.runNow()
  assert.deepEqual(loves, [['OldHeart', true]], 'love survives its age')
  assert.equal(get(scrobbleFlushStatus).dropped, before + 1, 'stale listen expired')
})

test('per-kind dispatch routes love/unlove/listen/feedback to their submitters', async () => {
  const store = memoryStore()
  const calls: string[] = []
  const engine = engineWith(store, spyDeps({
    lfmLove: async (_a, _t, loved) => { calls.push(`love:${loved}`) },
    lbListen: async () => { calls.push('lb-listen') },
    lbFeedback: async (_a, _t, score) => { calls.push(`lb-fb:${score}`) },
  }))
  await engine.enqueue('lfm-love', 'A', 'T1')
  await engine.enqueue('lfm-unlove', 'A', 'T2')
  await engine.enqueue('lb-listen', 'A', 'T3')
  await engine.enqueue('lb-love', 'A', 'T4')
  await engine.enqueue('lb-unlove', 'A', 'T5')

  for (let i = 0; i < 5; i++) await engine.runNow()
  assert.deepEqual(
    calls.sort(),
    ['lb-fb:0', 'lb-fb:1', 'lb-listen', 'love:false', 'love:true'],
    'LB heart polarity maps love→1 / unlove→0',
  )
  assert.equal(store.rows.length, 0)
})

test('LB feedback with no MBID match is skipped permanently with a surfaced counter', async () => {
  const store = memoryStore()
  const engine = engineWith(store, spyDeps({
    lbFeedback: async () => { throw new NoMbidMatchError() },
  }))
  await engine.enqueue('lb-love', 'Obscure', 'Track')
  const pendingBefore = get(scrobbleFlushStatus).pending
  const skippedBefore = get(scrobbleFlushStatus).skippedNoMbid

  await engine.runNow()
  assert.equal(store.rows.length, 0)
  assert.equal(get(scrobbleFlushStatus).skippedNoMbid, skippedBefore + 1)
  // The row was removed ONCE and counted ONCE. Double-counting it drifted
  // `pending` negative, which silences the periodic auto-flush.
  assert.equal(get(scrobbleFlushStatus).pending, pendingBefore - 1)
})

test('heart rows are delivered in enqueue order across kinds (toggle state cannot invert)', async () => {
  // Field-relevant ordering: ♥ off → on queues unlove then love. Grouping by
  // KIND NAME sent every love before every unlove, so a rapid re-love ended
  // unloved at the services. Queue order is the state transition order.
  const store = memoryStore()
  const calls: string[] = []
  const engine = engineWith(store, spyDeps({
    lfmLove: async (_a, _t, loved) => { calls.push(`lfm:${loved}`) },
    lbFeedback: async (_a, _t, score) => { calls.push(`lb:${score}`) },
  }))
  await engine.enqueue('lfm-unlove', 'A', 'T1')
  await engine.enqueue('lfm-love', 'A', 'T1')
  await engine.enqueue('lb-unlove', 'A', 'T2')
  await engine.enqueue('lb-love', 'A', 'T2')

  await engine.runNow()
  assert.deepEqual(calls, ['lfm:false', 'lfm:true', 'lb:0', 'lb:1'], 'per-destination order is preserved')
  assert.equal(store.rows.length, 0)
})

test('the DEFAULT LB heart path really reaches the wire: lookup then recording-feedback', async (t) => {
  // End-to-end of the two real defects (2026-10-21): the shipped lookup read an
  // invented `recording_mbids[]` shape without a token, and feedback posted a
  // bulk envelope to a non-existent endpoint. Every LB heart died as
  // "no MBID match". This drives the DEFAULT deps through stubbed fetch.
  const originalFetch = globalThis.fetch
  const calls: { url: string; init: RequestInit }[] = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const request = init ?? { method: 'GET' }
    calls.push({ url, init: request })
    const body = url.includes('/1/metadata/lookup/')
      ? { artist_credit_name: 'Artist', recording_mbid: 'recording-mbid-1', recording_name: 'Track' }
      : { status: 'ok' }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = originalFetch })

  settings.set({ listenbrainzScrobbling: true, listenbrainzToken: 'lb-tok' })
  const store = memoryStore()
  const engine = new ScrobbleFlushEngine(store, undefined, { backoffMs: 0, autoKick: false })
  await engine.enqueue('lb-love', 'Artist', 'Track')
  await engine.runNow()

  assert.equal(store.rows.length, 0, 'the heart drained')
  assert.equal(calls.length, 2, 'lookup + feedback')
  assert.equal(new URL(calls[0].url).pathname, '/1/metadata/lookup/')
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Token lb-tok')
  assert.equal(new URL(calls[1].url).pathname, '/1/feedback/recording-feedback')
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { recording_mbid: 'recording-mbid-1', score: 1 })
})

test('rate limiting aborts the remaining group but still records what succeeded', async () => {
  const store = memoryStore()
  const engine = engineWith(store, spyDeps({
    lfmLove: async (_a, track) => {
      if (track === 'fail') throw new LastfmError(29)
    },
  }))
  await engine.enqueue('lfm-love', 'A', 'ok1')
  await engine.enqueue('lfm-love', 'A', 'fail')
  await engine.enqueue('lfm-love', 'A', 'never-attempted')

  await engine.runNow()
  // Rows after the rate limit were never sent — they must stay queued, never
  // be mistaken for delivered (which deleted up to 24 hearts).
  assert.deepEqual(store.rows.map((r) => r.track), ['fail', 'never-attempted'])
  assert.deepEqual(store.rows.map((r) => r.attempts), [1, 1], 'unattempted rows are retried, not lost')
})

test('a failed cycle surfaces lastError; success clears it', async () => {
  const store = memoryStore()
  let failing = true
  const engine = engineWith(store, spyDeps({
    lfmScrobble: async () => { if (failing) throw new LastfmError(11) },
  }))
  await engine.enqueue('lfm-scrobble', 'A', 'T', { timestamp: Math.floor(Date.now() / 1000) })

  await engine.runNow()
  assert.match(get(scrobbleFlushStatus).lastError ?? '', /offline/i)

  failing = false
  await engine.runNow()
  assert.equal(get(scrobbleFlushStatus).lastError, undefined)
})

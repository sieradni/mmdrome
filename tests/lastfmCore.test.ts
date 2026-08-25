// Pins the pure Last.fm protocol core: lexicographic request signing (the
// classic `artist[10]` vs `artist[2]` sort trap), scrobble param flattening,
// batch chunking, the flush plan (expiry window, poison cap), and the auth
// poll step machine. Signature vectors computed independently (.NET MD5).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  apiSig,
  signedCallParams,
  buildScrobbleParams,
  chunkScrobbles,
  planFlush,
  nextAuthStep,
  describeLfmError,
  type FlushableEntry,
  LFM_SCROBBLE_BATCH_MAX,
} from '../src/lib/lastfmCore'

const CREDS = { apiKey: '0e701f798ed495a7fa9f9a7660e20d78', secret: 'e4c8a2dc535e02bbeacfcfd46875fe7e' }

test('apiSig matches an independently computed vector', () => {
  const sig = apiSig({ api_key: CREDS.apiKey, method: 'auth.getToken' }, CREDS.secret)
  assert.equal(sig, '616552bb6f2e562274bd7794dd41c50a')
})

test('apiSig sorts keys lexicographically — artist[10] before artist[2]', () => {
  // A numeric-aware sort would order artist[2] first and produce a different
  // (rejected) signature. The expected hash assumes plain string ordering.
  const sig = apiSig(
    { method: 'track.scrobble', api_key: CREDS.apiKey, 'artist[10]': 'Bach', 'artist[2]': 'Mozart' },
    CREDS.secret,
  )
  assert.equal(sig, '7fbdb4e95cb4c8b86245fb0291ad2db4')
})

test('signedCallParams adds method/api_key/sk and signs over exactly those params', () => {
  const p = signedCallParams('auth.getSession', { token: 'tok123' }, CREDS, 'sk456')
  assert.equal(p.method, 'auth.getSession')
  assert.equal(p.api_key, CREDS.apiKey)
  assert.equal(p.sk, 'sk456')
  assert.equal(p.token, 'tok123')
  assert.ok(/^[0-9a-f]{32}$/.test(p.api_sig))
  // format/callback must never leak into the signed body (transport-only).
  assert.equal('format' in p, false)
  assert.equal('callback' in p, false)
})

test('buildScrobbleParams flattens entries into the [i] array syntax, skipping empty optionals', () => {
  const params = buildScrobbleParams([
    { artist: 'A', track: 'T1', timestamp: 1700000000.7 },
    { artist: 'B', track: 'T2', album: 'AL', albumArtist: 'BA', duration: 200, trackNumber: 3, timestamp: 1700000300 },
  ])
  assert.deepEqual(params['artist[0]'], 'A')
  assert.deepEqual(params['timestamp[0]'], '1700000000')
  assert.equal('album[0]' in params, false)
  assert.equal('duration[0]' in params, false)
  assert.equal(params['album[1]'], 'AL')
  assert.equal(params['albumArtist[1]'], 'BA')
  assert.equal(params['duration[1]'], '200')
  assert.equal(params['trackNumber[1]'], '3')
})

test('chunkScrobbles respects boundaries including exact multiples', () => {
  const three = [1, 2, 3]
  assert.deepEqual(chunkScrobbles(three, 2), [[1, 2], [3]])
  assert.deepEqual(chunkScrobbles([1, 2, 3, 4], 2), [[1, 2], [3, 4]])
  assert.deepEqual(chunkScrobbles([], 50), [])
})

function entry(over: Partial<FlushableEntry> = {}): FlushableEntry {
  return {
    kind: 'lfm-scrobble',
    artist: 'Artist',
    track: 'Track',
    timestamp: Math.floor((over.queuedAt ?? 1000000) / 1000),
    queuedAt: 1000000,
    attempts: 0,
    ...over,
  }
}

test('planFlush batches up to the requested size and preserves queue order', () => {
  const entries = Array.from({ length: LFM_SCROBBLE_BATCH_MAX + 1 }, (_, i) => entry({ track: `T${i}` }))
  const plan = planFlush(entries, { nowMs: 1000000, batchSize: 50 })
  assert.equal(plan.batches.length, 2)
  assert.equal(plan.batches[0].length, 50)
  assert.equal(plan.batches[1].length, 1)
  assert.deepEqual(plan.expiredIdx, [])
  assert.deepEqual(plan.droppedIdx, [])
})

test('planFlush expires time-sensitive entries past the age window only', () => {
  const nowMs = 30 * 24 * 60 * 60 * 1000
  const entries = [
    entry({ kind: 'lfm-scrobble', timestamp: 100 }), // ancient listen → expired
    entry({ kind: 'lfm-love', timestamp: 100, attempts: 0 }), // loves never expire by age
    entry({ kind: 'lb-listen', timestamp: nowMs / 1000 - 3600 }), // fresh → kept
  ]
  const plan = planFlush(entries, { nowMs, batchSize: 50 })
  assert.deepEqual(plan.expiredIdx, [0])
  assert.equal(plan.batches.length, 1)
  assert.equal(plan.batches[0].length, 2)
})

test('planFlush drops poison entries at the attempt cap regardless of kind', () => {
  const entries = [entry({ kind: 'lfm-love', attempts: 8 }), entry({ kind: 'lfm-scrobble', attempts: 7 })]
  const plan = planFlush(entries, { nowMs: 1000000, batchSize: 50 })
  assert.deepEqual(plan.droppedIdx, [0])
  assert.equal(plan.batches.length, 1)
})

test('nextAuthStep: no result yet polls; error 14 polls within window then times out', () => {
  assert.equal(nextAuthStep(null, 0), 'poll')
  assert.equal(nextAuthStep({ ok: false, code: 14 }, 5000), 'poll')
  const timeout = nextAuthStep({ ok: false, code: 14 }, 11 * 60 * 1000, 10 * 60 * 1000)
  assert.deepEqual(timeout, { step: 'fail', reason: 'Timed out waiting for authorization' })
})

test('nextAuthStep: success finishes; other errors are terminal with descriptions', () => {
  const done = nextAuthStep({ ok: true, session: { key: 'k', name: 'n' } }, 10)
  assert.deepEqual(done, { step: 'done', session: { key: 'k', name: 'n' } })
  assert.deepEqual(nextAuthStep({ ok: false, code: 15 }, 10), { step: 'fail', reason: 'Authorization was denied' })
  const fatal = nextAuthStep({ ok: false, code: 26 }, 10) as { step: string; reason: string }
  assert.equal(fatal.step, 'fail')
  assert.equal(fatal.reason, describeLfmError(26))
})

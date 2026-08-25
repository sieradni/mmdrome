// Pins the ListenBrainz method layer over a stubbed global fetch: token
// validation, the submit-listens body shape (listened_at present for real
// listens, absent for playing_now), the name→MBID lookup, and feedback
// submission. CORS-native service — plain fetch on both platforms.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  lbValidateToken,
  lbSubmitListen,
  lbLookupRecordingMbid,
  lbSubmitFeedback,
  ListenBrainzError,
} from '../src/lib/listenbrainzApi'

interface RecordedCall { url: string; init: RequestInit }

function stubFetch(answer: (url: string, init: RequestInit) => unknown): { calls: RecordedCall[]; restore: () => void } {
  const original = globalThis.fetch
  const calls: RecordedCall[] = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const recordedInit = init ?? { method: 'GET' }
    calls.push({ url, init: recordedInit })
    const payload = answer(url, recordedInit)
    if (payload instanceof Error) throw payload
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('validate-token sends the Token header and maps user_name', async (t) => {
  const { calls, restore } = stubFetch(() => ({ valid: true, user_name: 'alice' }))
  t.after(restore)
  const v = await lbValidateToken('lb-tok')
  assert.equal(v.valid, true)
  assert.equal(v.username, 'alice')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Token lb-tok')
})

test('submitListen posts a single listen with listened_at and track metadata', async (t) => {
  const { calls, restore } = stubFetch(() => ({ status: 'ok' }))
  t.after(restore)
  await lbSubmitListen('lb-tok', { artist: 'A', track: 'T', album: 'AL', duration: 200 }, { listenedAtSec: 1700000000 })
  assert.equal(calls[0].init.method, 'POST')
  const body = JSON.parse(String(calls[0].init.body))
  assert.equal(body.listen_type, 'single')
  assert.equal(body.payload[0].listened_at, 1700000000)
  assert.equal(body.payload[0].track_metadata.artist_name, 'A')
  assert.equal(body.payload[0].track_metadata.track_name, 'T')
  assert.equal(body.payload[0].track_metadata.release_name, 'AL')
  assert.equal(body.payload[0].track_metadata.additional_info.duration_ms, 200000)
})

test('playing_now omits listened_at entirely', async (t) => {
  const { calls, restore } = stubFetch(() => ({ status: 'ok' }))
  t.after(restore)
  await lbSubmitListen('lb-tok', { artist: 'A', track: 'T' }, { playingNow: true })
  const body = JSON.parse(String(calls[0].init.body))
  assert.equal(body.listen_type, 'playing_now')
  assert.equal('listened_at' in body.payload[0], false)
})

test('lookup returns the first recording MBID and null when none match', async (t) => {
  const { calls, restore } = stubFetch((_url) => ({ recording_mbids: [{ recording_mbid: 'mbid-1' }] }))
  t.after(restore)
  const mbid = await lbLookupRecordingMbid('Artist', 'Track')
  assert.equal(mbid, 'mbid-1')
  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/1/metadata/lookup')
  assert.equal(url.searchParams.get('artist_name'), 'Artist')
  assert.equal(url.searchParams.get('recording_name'), 'Track')

  const empty = stubFetch(() => ({}))
  t.after(empty.restore)
  assert.equal(await lbLookupRecordingMbid('X', 'Y'), null)
})

test('feedback submits the mbid + score envelope; HTTP failures raise typed errors', async (t) => {
  const { calls, restore } = stubFetch(() => ({ status: 'ok' }))
  t.after(restore)
  await lbSubmitFeedback('lb-tok', 'mbid-1', 1)
  const body = JSON.parse(String(calls[0].init.body))
  assert.deepEqual(body.recordings[0], { recording_mbid: 'mbid-1', score: 1 })

  const failing = stubFetch(() => new Error('should not be reached'))
  t.after(failing.restore)
  globalThis.fetch = (async () => new Response('{"code":404,"error":"not found"}', { status: 404 })) as typeof fetch
  await assert.rejects(lbValidateToken('lb-tok'), (err: unknown) => err instanceof ListenBrainzError && err.status === 404)
})

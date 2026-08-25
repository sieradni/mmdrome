// Pins the Last.fm method layer against an injected transport: signed param
// assembly per method (method/api_key/sk/api_sig present, no format/callback),
// the `{error:n}` → typed-error mapping, and the auth-page URL shape.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  lfmGetToken,
  lfmGetSession,
  lfmScrobbleBatch,
  lfmUpdateNowPlaying,
  lfmSetLoved,
  lfmAuthUrl,
  LastfmError,
} from '../src/lib/lastfmApi'

const CREDS = { apiKey: 'k-test', secret: 's-test' }

function okTransport() {
  const calls: Record<string, string>[] = []
  const transport = async (params: Record<string, string>) => {
    calls.push(params)
    return {}
  }
  return { calls, transport }
}

test('lfmGetToken sends a signed auth.getToken call and returns the token', async () => {
  const { calls, transport } = okTransport()
  let answered = false
  const t = async (params: Record<string, string>) => {
    calls.push(params)
    answered = true
    return { token: 'tok-1' }
  }
  void transport
  void answered
  const token = await lfmGetToken(CREDS, t)
  assert.equal(token, 'tok-1')
  assert.equal(calls[0].method, 'auth.getToken')
  assert.equal(calls[0].api_key, 'k-test')
  assert.ok(calls[0].api_sig)
})

test('an {error:n} payload becomes a typed LastfmError carrying the code', async () => {
  await assert.rejects(
    lfmGetToken(CREDS, async () => ({ error: 14, message: 'Unauthorized Token' })),
    (err: unknown) => err instanceof LastfmError && err.code === 14 && err.message.includes('authorization'),
  )
})

test('lfmGetSession extracts the session envelope and signs with the token', async () => {
  const calls: Record<string, string>[] = []
  const session = await lfmGetSession(CREDS, 'tok-9', async (params) => {
    calls.push(params)
    return { session: { key: 'sk-1', name: 'alice', subscriber: 0 } }
  })
  assert.deepEqual(session, { key: 'sk-1', name: 'alice' })
  assert.equal(calls[0].token, 'tok-9')
  assert.equal(calls[0].sk, undefined)
})

test('lfmScrobbleBatch carries the session key and flattened [i] params', async () => {
  const calls: Record<string, string>[] = []
  await lfmScrobbleBatch(
    CREDS,
    'sk-7',
    [{ artist: 'A', track: 'T', timestamp: 100 }],
    async (params) => { calls.push(params); return {} },
  )
  assert.equal(calls[0].sk, 'sk-7')
  assert.equal(calls[0]['artist[0]'], 'A')
  assert.equal(calls[0]['timestamp[0]'], '100')
})

test('now-playing uses updatenowplaying with singular params', async () => {
  const calls: Record<string, string>[] = []
  await lfmUpdateNowPlaying(
    CREDS,
    'sk-7',
    { artist: 'A', track: 'T', album: 'AL', duration: 180 },
    async (params) => { calls.push(params); return {} },
  )
  assert.equal(calls[0].method, 'track.updatenowplaying')
  assert.equal(calls[0].artist, 'A')
  assert.equal(calls[0].album, 'AL')
  assert.equal(calls[0].duration, '180')
})

test('lfmSetLoved picks track.love vs track.unlove by flag', async () => {
  const methods: string[] = []
  const t = async (params: Record<string, string>) => { methods.push(params.method); return {} }
  await lfmSetLoved(CREDS, 'sk', 'A', 'T', true, t)
  await lfmSetLoved(CREDS, 'sk', 'A', 'T', false, t)
  assert.deepEqual(methods, ['track.love', 'track.unlove'])
})

test('lfmAuthUrl embeds api_key and token as query params', () => {
  const url = new URL(lfmAuthUrl('key-x', 'tok x'))
  assert.equal(url.origin + url.pathname, 'https://www.last.fm/api/auth/')
  assert.equal(url.searchParams.get('api_key'), 'key-x')
  assert.equal(url.searchParams.get('token'), 'tok x')
})

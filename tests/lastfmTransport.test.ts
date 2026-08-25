// Pins the Last.fm transport against the 2026-08-25 field findings: writes go
// as POST form-urlencoded (Last.fm rejects GET with error 4 "You must use POST
// method"), `format=json` joins the BODY after signing, and typed `{error:n}`
// payloads ride non-2xx statuses — the body must win over the HTTP status.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lfmRequest } from '../src/lib/lastfmTransport'

interface Recorded { url: string; init: RequestInit }

function stubFetch(answer: (url: string, init: RequestInit) => Response | Promise<Response>): Recorded[] {
  const calls: Recorded[] = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const recorded = { url: String(input), init: init ?? {} }
    calls.push(recorded)
    return answer(recorded.url, recorded.init)
  }) as typeof fetch
  return calls
}

test('posts the signed params + format=json as a form-urlencoded simple request', async () => {
  const calls = stubFetch(() => new Response('{}', { status: 200 }))
  await lfmRequest({ method: 'auth.getToken', api_key: 'k', api_sig: 'sig' })
  assert.equal(calls.length, 1)
  const { url, init } = calls[0]
  assert.equal(url, 'https://ws.audioscrobbler.com/2.0/')
  assert.equal(init.method, 'POST')
  assert.equal((init.headers as Record<string, string>)['Content-Type'], 'application/x-www-form-urlencoded')
  const body = new URLSearchParams(String(init.body))
  // format rides in the body (never in the signed param set), alongside the caller's params.
  assert.equal(body.get('format'), 'json')
  assert.equal(body.get('method'), 'auth.getToken')
  assert.equal(body.get('api_sig'), 'sig')
})

test('a non-JSON 5xx becomes a generic retryable transport error', async () => {
  stubFetch(() => new Response('<html>gateway timeout</html>', { status: 504 }))
  await assert.rejects(lfmRequest({ method: 'x' }), /HTTP 504/)
})

test('a network-level failure (CORS/DNS/abort) becomes a generic retryable error', async () => {
  stubFetch(() => { throw new TypeError('NetworkError when attempting to fetch resource') })
  await assert.rejects(lfmRequest({ method: 'x' }), /request failed/)
})

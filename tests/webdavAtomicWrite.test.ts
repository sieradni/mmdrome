// Pins the atomic-write CONTRACT extracted from syncEngine (webdavAtomicWrite
// is the pure core; syncEngine's webdavPutAtomicViaAppFetch is a thin adapter
// binding the real webdavFetch). The critical invariant — the failed attempt
// deletes its temp file EXACTLY ONCE — is what the previous structure
// violated: the `!moveRes.ok` branch cleaned up, threw ConflictError, and the
// catch-all cleaned up AGAIN (two DELETEs per failed MOVE, observed in the
// browser e2e before this extraction).
//
// The fake transport records every request (method + URL) and answers from a
// scripted queue, so the assertions are on the OBSERVED wire sequence — the
// same shape the browser e2e asserts against the route-mocked server.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webdavPutAtomic, ConflictError, type ResponseLike } from '../src/lib/webdavAtomicWrite'

const BASE = 'https://dav.test/files/user/'
const FILE = 'Song One.mp3'
const DEST_URL = `${BASE}Song%20One.mp3`
const TEMP_URL = `${BASE}Song%20One.mp3.mmdrome-tmp`

interface Call {
  method: string
  url: string
  headers: Record<string, string>
  body?: unknown
}

function okRes(status = 201): ResponseLike {
  return { ok: status >= 200 && status < 300, status }
}

/** Scripted transport: one response per call (last repeats), full call log. */
function fakeTransport(script: Array<{ status: number } | { reject: Error }>) {
  const calls: Call[] = []
  let i = 0
  const impl = async (url: string, options: RequestInit): Promise<ResponseLike> => {
    const call: Call = { method: String(options.method), url, headers: (options.headers ?? {}) as Record<string, string>, body: options.body }
    calls.push(call)
    const step = script[Math.min(i, script.length - 1)]
    i++
    if ('reject' in step) throw step.reject
    return okRes(step.status)
  }
  return { impl, calls }
}

function runFailureCase(
  name: string,
  script: Array<{ status: number } | { reject: Error }>,
  expectError: 'conflict' | 'plain',
  expectedCalls: Array<[string, string]>,
) {
  test(name, async () => {
    const t = fakeTransport(script)
    const err = await webdavPutAtomic(BASE, FILE, new ArrayBuffer(8), 'user', 'token', '"etag-1"', t.impl, 1000).then(
      () => null,
      (e: unknown) => e,
    )
    assert.ok(err instanceof Error, 'the write must fail')
    if (expectError === 'conflict') {
      assert.ok(err instanceof ConflictError, `expected ConflictError, got ${String(err)}`)
    } else {
      assert.ok(!(err instanceof ConflictError), 'non-412 failures must NOT be ConflictError')
    }
    assert.deepEqual(
      t.calls.map((c) => [c.method, c.url] as [string, string]),
      expectedCalls,
    )
    const deletes = t.calls.filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1, `exactly one temp cleanup, got ${deletes.length}`)
    assert.equal(deletes[0].url, TEMP_URL, 'the DELETE targets the temp path')
  })
}

test('success: PUT temp → MOVE dest, no DELETE, If-Match carries the etag', async () => {
  const t = fakeTransport([{ status: 201 }, { status: 201 }])
  await webdavPutAtomic(BASE, FILE, new ArrayBuffer(8), 'user', 'token', '"etag-1"', t.impl, 1000)
  assert.deepEqual(
    t.calls.map((c) => [c.method, c.url] as [string, string]),
    [
      ['PUT', TEMP_URL],
      ['MOVE', TEMP_URL],
    ],
  )
  const move = t.calls[1]
  assert.equal(move.headers['If-Match'], '"etag-1"', 'the GET etag rides as If-Match')
  assert.equal(move.headers.Destination, DEST_URL)
  assert.equal(move.headers.Overwrite, 'T')
  assert.equal(move.headers.Authorization, `Basic ${btoa('user:token')}`)
  assert.equal(t.calls.filter((c) => c.method === 'DELETE').length, 0, 'a successful MOVE deletes nothing')
})

test('without an etag the MOVE is a blind overwrite (no If-Match header)', async () => {
  const t = fakeTransport([{ status: 201 }, { status: 201 }])
  await webdavPutAtomic(BASE, FILE, new ArrayBuffer(8), 'user', 'token', undefined, t.impl, 1000)
  assert.equal(t.calls[1].headers['If-Match'], undefined)
})

runFailureCase(
  '412 (ConflictError): PUT → MOVE(412) → exactly one temp DELETE',
  [{ status: 201 }, { status: 412 }],
  'conflict',
  [
    ['PUT', TEMP_URL],
    ['MOVE', TEMP_URL],
    ['DELETE', TEMP_URL],
  ],
)

runFailureCase(
  'other MOVE failure (500): PUT → MOVE(500) → exactly one temp DELETE, plain Error',
  [{ status: 201 }, { status: 500 }],
  'plain',
  [
    ['PUT', TEMP_URL],
    ['MOVE', TEMP_URL],
    ['DELETE', TEMP_URL],
  ],
)

runFailureCase(
  'MOVE network rejection: PUT → reject → exactly one temp DELETE',
  [{ status: 201 }, { reject: new Error('network down') }],
  'plain',
  [
    ['PUT', TEMP_URL],
    ['MOVE', TEMP_URL],
    ['DELETE', TEMP_URL],
  ],
)

test('PUT failure throws before any temp exists — no DELETE at all', async () => {
  const t = fakeTransport([{ status: 507 }])
  const err = await webdavPutAtomic(BASE, FILE, new ArrayBuffer(8), 'user', 'token', '"etag-1"', t.impl, 1000).then(
    () => null,
    (e: unknown) => e,
  )
  assert.ok(err instanceof Error)
  assert.ok(!(err instanceof ConflictError))
  assert.deepEqual(
    t.calls.map((c) => c.method),
    ['PUT'],
    'the failed PUT is the only wire call',
  )
})

test('temp path naming matches the shared suffix convention (mirror check)', async () => {
  // webdavAtomicWrite mirrors webdavUtils.webdavTempPath to stay
  // Capacitor-free; this pins the mirror so drift fails here first.
  const t = fakeTransport([{ status: 201 }, { status: 201 }])
  await webdavPutAtomic(BASE, FILE, new ArrayBuffer(8), 'user', 'token', undefined, t.impl, 1000)
  assert.ok(t.calls[0].url.endsWith('.mmdrome-tmp'), `temp URL must carry the shared suffix: ${t.calls[0].url}`)
})

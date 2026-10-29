// Pins the atomic-write CONTRACT (`src/lib/webdavAtomicWrite.ts`, the pure core;
// syncEngine's webdavPutAtomicViaAppFetch is a thin adapter binding the real
// webdavFetch). Assertions are on the OBSERVED wire sequence through a scripted
// transport, the same shape the browser e2e asserts against the mock server.
//
// Two invariants carry the 2026-10-27 field fix:
//
// 1. THE LADDER. The destination's validators are read from PROPFIND (where the
//    server publishes the very value it compares), and the MOVE starts at the
//    RFC 4918 tagged `If` list. A 412 whose re-check shows the destination
//    UNCHANGED is the server refusing that dialect, not a concurrent write — so
//    the write advances to the next rung and re-MOVEs the temp ALREADY on the
//    server. That is what stops a server-wide 412 storm from being paid with a
//    second full upload per row.
// 2. THE RE-CHECK IS THE REAL GUARD. The destination is re-read immediately
//    before the MOVE, so a destination that changed while the temp was being
//    written is refused even on a server that honours no precondition at all —
//    and `ConflictError` now means exactly that, which is why only the caller's
//    recovery path ever uploads a file twice.
//
// The exactly-once temp cleanup invariant (the reason this core was extracted)
// is asserted on EVERY failure path below.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  webdavPutAtomic,
  ConflictError,
  AbortedBeforeMoveError,
  AtomicWriteError,
  type AtomicWriteOutcome,
  type ResponseLike,
} from '../src/lib/webdavAtomicWrite'
import type { DestinationValidators } from '../src/lib/webdavPreconditions'

const BASE = 'https://dav.test/files/user/'
const FILE = 'Song One.mp3'
const DEST_URL = `${BASE}Song%20One.mp3`
const TEMP_URL = `${BASE}Song%20One.mp3.mmdrome-tmp`

interface Call {
  method: string
  url: string
  headers: Record<string, string>
  body?: unknown
  cache?: RequestCache
}

/** A `Depth: 0` multistatus for the destination, as sabre/Nextcloud answer. */
function validatorsXml(v: DestinationValidators): string {
  return '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response>'
    + `<d:href>${DEST_URL}</d:href><d:propstat><d:prop>`
    + (v.etag ? `<d:getetag>${v.etag.replace(/&/g, '&amp;')}</d:getetag>` : '')
    + (v.lastModified ? `<d:getlastmodified>${v.lastModified}</d:getlastmodified>` : '')
    + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>'
}

type Step = { status: number; xml?: string } | { reject: Error }

/** Scripted transport: one response per call (last repeats), full call log. */
function fakeTransport(script: Step[]) {
  const calls: Call[] = []
  let i = 0
  const impl = async (url: string, options: RequestInit): Promise<ResponseLike> => {
    calls.push({
      method: String(options.method),
      url,
      headers: (options.headers ?? {}) as Record<string, string>,
      body: options.body,
      cache: options.cache,
    })
    const step = script[Math.min(i, script.length - 1)]
    i++
    if ('reject' in step) throw step.reject
    const status = step.status
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => step.xml ?? '',
    }
  }
  return { impl, calls }
}

const ETAG = '"etag-1"'
const LM = 'Mon, 01 Jan 2024 00:00:00 GMT'
const PUT_OK: Step = { status: 201 }
/** One pre-MOVE re-check answering with these validators. */
const READ = (v: DestinationValidators = { etag: ETAG, lastModified: LM }): Step => ({ status: 207, xml: validatorsXml(v) })

function methods(calls: Call[]): string[] {
  return calls.map((c) => c.method)
}

function tempDeletes(calls: Call[]): Call[] {
  return calls.filter((c) => c.method === 'DELETE' && c.url === TEMP_URL)
}

const VALIDATORS: DestinationValidators = { etag: ETAG, lastModified: LM }

/**
 * Run one write with the caller's baseline already in hand — the ORDER the
 * production caller uses (read the destination's validators, THEN its bytes,
 * then hand both to the write). `undefined` models a server that publishes no
 * validators at all.
 */
async function run(
  script: Step[],
  opts?: Parameters<typeof webdavPutAtomic>[8],
  /** `null` = the caller could not read any validators at all. */
  validators: DestinationValidators | null = VALIDATORS,
) {
  const t = fakeTransport(script)
  return webdavPutAtomic(BASE, FILE, new ArrayBuffer(8), 'user', 'token', validators ?? undefined, t.impl, 1000, opts).then(
    (value) => ({ ...t, value, error: undefined as unknown }),
    (error: unknown) => ({ ...t, value: undefined as AtomicWriteOutcome | undefined, error }),
  )
}

test('the first rung holds: PUT temp → re-check → MOVE with the tagged If', async () => {
  const r = await run([PUT_OK, READ(), { status: 201 }])
  assert.ok(r.value, String(r.error))
  assert.deepEqual(methods(r.calls), ['PUT', 'PROPFIND', 'MOVE'])
  assert.deepEqual(r.value, { precondition: 'tagged-if', moveAttempts: 1, tempPath: 'Song One.mp3.mmdrome-tmp' })

  // The re-check reads the destination itself, Depth 0, asking for exactly the
  // two validators (a body read is what the core parses).
  const read = r.calls[1]
  assert.equal(read.url, DEST_URL)
  assert.equal(read.headers.Depth, '0')
  assert.equal(read.cache, 'no-store', 'a cached multistatus would be a validator for a past state')
  assert.equal(new Headers(read.headers).has('Cache-Control'), false, 'do not add a CORS header permission')
  assert.match(String(read.body), /getetag/)
  assert.match(String(read.body), /getlastmodified/)

  const move = r.calls[2]
  assert.equal(move.url, TEMP_URL, 'the MOVE source is the temp file')
  assert.equal(move.headers.If, `<${DEST_URL}> ([${ETAG}])`)
  assert.equal(move.headers['If-Match'], undefined, 'the tagged list is the first rung')
  assert.equal(move.headers.Destination, DEST_URL)
  assert.equal(move.headers.Overwrite, 'T')
  assert.equal(move.headers.Authorization, `Basic ${btoa('user:token')}`)
  assert.equal(tempDeletes(r.calls).length, 0, 'a successful MOVE deletes nothing')
})

test('a server that refuses the tagged If falls to If-Match with the SAME temp (no second upload)', async () => {
  const r = await run([PUT_OK, READ(), { status: 412 }, READ(), { status: 201 }])
  assert.ok(r.value, String(r.error))
  assert.deepEqual(methods(r.calls), ['PUT', 'PROPFIND', 'MOVE', 'PROPFIND', 'MOVE'])
  assert.deepEqual(r.value, { precondition: 'if-match', moveAttempts: 2, tempPath: 'Song One.mp3.mmdrome-tmp' })
  assert.equal(r.calls.filter((c) => c.method === 'PUT').length, 1, 'the payload is uploaded exactly once')
  assert.equal(r.calls[2].headers.If, `<${DEST_URL}> ([${ETAG}])`)
  assert.equal(r.calls[4].headers['If-Match'], ETAG, 'the rejected rung is replaced, not repeated')
  assert.equal(r.calls[4].headers.If, undefined)
  assert.equal(tempDeletes(r.calls).length, 0, 'the temp is carried from rung to rung')
})

test('minimal-header writes use a verified fresh destination and no conditional MOVE headers', async () => {
  const r = await run([PUT_OK, READ(), { status: 201 }], { revalidateOnly: true })
  assert.ok(r.value, String(r.error))
  assert.equal(r.value.precondition, 'revalidated')
  assert.deepEqual(methods(r.calls), ['PUT', 'PROPFIND', 'MOVE'])
  assert.deepEqual(Object.keys(r.calls[2].headers).sort(), ['Authorization', 'Destination', 'Overwrite'])
  assert.equal(r.calls[2].headers.Overwrite, 'T', 'existing files need explicit overwrite on Go-style servers')
})

test('minimal-header writes refuse a missing baseline without uploading', async () => {
  const r = await run([], { revalidateOnly: true }, null)
  assert.ok(r.error instanceof AtomicWriteError)
  assert.equal(r.error.stage, 'pre-move-validation')
  assert.equal(r.error.cleanup, 'not-needed')
  assert.equal(r.calls.length, 0)
})

test('minimal-header writes refuse failed or incomparable rechecks, cleaning the temp once', async () => {
  for (const read of [{ status: 500 }, { reject: new Error('network') }, READ({})]) {
    const r = await run([PUT_OK, read, { status: 204 }], { revalidateOnly: true })
    assert.ok(r.error instanceof AtomicWriteError, String(r.error))
    assert.equal(r.error.stage, 'pre-move-validation')
    assert.deepEqual(methods(r.calls), ['PUT', 'PROPFIND', 'DELETE'])
    assert.equal(r.error.cleanup, 'deleted')
  }
})

test('minimal-header writes refuse a changed destination before sending MOVE', async () => {
  const r = await run([PUT_OK, READ({ etag: '"new"' }), { status: 204 }], { revalidateOnly: true })
  assert.ok(r.error instanceof ConflictError)
  assert.deepEqual(methods(r.calls), ['PUT', 'PROPFIND', 'DELETE'])
})

test('minimal-header MOVE network failures remain unknown and are never retried with weaker headers', async () => {
  const r = await run([PUT_OK, READ(), { reject: new Error('lost response') }, { status: 204 }], { revalidateOnly: true })
  assert.equal((r.error as { remoteState: string }).remoteState, 'unknown')
  assert.deepEqual(methods(r.calls), ['PUT', 'PROPFIND', 'MOVE', 'DELETE'])
})

test('a server that refuses both etag rungs falls to the date rung, then to the re-check alone', async () => {
  const dateRung = await run([
    PUT_OK, READ(),
    { status: 412 }, READ(),
    { status: 412 }, READ(),
    { status: 201 },
  ])
  assert.ok(dateRung.value, String(dateRung.error))
  assert.deepEqual(dateRung.value, { precondition: 'if-unmodified-since', moveAttempts: 3, tempPath: 'Song One.mp3.mmdrome-tmp' })
  assert.equal(dateRung.calls[6].headers['If-Unmodified-Since'], LM)

  const bottomRung = await run([
    PUT_OK, READ(),
    { status: 412 }, READ(),
    { status: 412 }, READ(),
    { status: 412 }, READ(),
    { status: 201 },
  ])
  assert.ok(bottomRung.value, String(bottomRung.error))
  assert.deepEqual(bottomRung.value, { precondition: 'revalidated', moveAttempts: 4, tempPath: 'Song One.mp3.mmdrome-tmp' })
  const last = bottomRung.calls[bottomRung.calls.length - 1]
  assert.equal(last.headers.If, undefined)
  assert.equal(last.headers['If-Match'], undefined)
  assert.equal(last.headers['If-Unmodified-Since'], undefined, 'the bottom rung sends no precondition')
  assert.equal(bottomRung.calls.filter((c) => c.method === 'PUT').length, 1)
})

test('a destination with no etag starts at the date rung', async () => {
  const over = { lastModified: LM }
  const r = await run([PUT_OK, READ(over), { status: 201 }], undefined, over)
  assert.ok(r.value, String(r.error))
  assert.equal(r.value.precondition, 'if-unmodified-since')
  assert.equal(r.calls[2].headers['If-Unmodified-Since'], LM)
})

test('a weak etag is expressible in the tagged list (sabre compares the raw tag)', async () => {
  const over = { etag: 'W/"etag-2"' }
  const r = await run([PUT_OK, READ(over), { status: 201 }], undefined, over)
  assert.ok(r.value, String(r.error))
  assert.equal(r.calls[2].headers.If, `<${DEST_URL}> ([W/"etag-2"])`)
})

test('a concurrent write lands while the temp is uploading: refused before any MOVE', async () => {
  // The re-check is the whole point: the destination's validators moved between
  // the baseline that produced our tag edit and the MOVE — so the row is
  // refused with the temp cleaned up and NOT ONE byte re-uploaded here (the
  // caller's recovery re-reads the NEW bytes and re-tags those).
  const r = await run([PUT_OK, READ({ etag: '"etag-2"' })])
  assert.ok(r.error instanceof ConflictError, String(r.error))
  assert.match(r.error.message, /changed since it was read/)
  assert.deepEqual(methods(r.calls), ['PUT', 'PROPFIND', 'DELETE'], 'no MOVE is sent at all')
  assert.equal(tempDeletes(r.calls).length, 1, 'the refused write cleans its temp exactly once')
})

test('a 412 with an UNCHANGED destination is a dialect rejection; a CHANGED one is a lost race', async () => {
  const dialect = await run([PUT_OK, READ(), { status: 412 }, READ(), { status: 201 }])
  assert.ok(dialect.value, String(dialect.error))
  assert.equal(dialect.value?.precondition, 'if-match')

  const race = await run([PUT_OK, READ(), { status: 412 }, READ({ etag: '"etag-9"' })])
  assert.ok(race.error instanceof ConflictError, String(race.error))
  assert.match(race.error.message, /HTTP 412/)
  assert.equal(methods(race.calls).filter((m) => m === 'MOVE').length, 1, 'the race is not re-tried blindly')
  assert.equal(tempDeletes(race.calls).length, 1)
})

test('a 412 we cannot adjudicate is refused rather than weakened', async () => {
  // The re-check could not read validators (server error): advancing the rung
  // would mean replacing a destination we cannot prove is unchanged.
  const r = await run([PUT_OK, READ(), { status: 412 }, { status: 500 }])
  assert.ok(r.error instanceof ConflictError, String(r.error))
  assert.equal(tempDeletes(r.calls).length, 1)
})

test('a destination whose validators could not be read still writes, and says it was blind', async () => {
  const r = await run([PUT_OK, { status: 201 }], undefined, null)
  assert.ok(r.value, String(r.error))
  assert.deepEqual(r.value, { precondition: 'blind', moveAttempts: 1, tempPath: 'Song One.mp3.mmdrome-tmp' })
  assert.deepEqual(methods(r.calls), ['PUT', 'MOVE'], 'no re-check is spent when there is nothing to compare')
  assert.equal(r.calls[1].headers.If, undefined)
  assert.equal(r.calls[1].headers['If-Match'], undefined)
})

test('the re-check sees the destination gone: ConflictError, one DELETE', async () => {
  const r = await run([PUT_OK, { status: 404 }])
  assert.ok(r.error instanceof ConflictError, String(r.error))
  assert.match(r.error.message, /removed since it was read/)
  assert.equal(tempDeletes(r.calls).length, 1)
})

test('MOVE 404 (destination vanished between the read and the rename): ConflictError, one DELETE', async () => {
  const r = await run([PUT_OK, READ(), { status: 404 }])
  assert.ok(r.error instanceof ConflictError, String(r.error))
  assert.equal(r.error.status, 404)
  assert.equal(tempDeletes(r.calls).length, 1)
})

test('other MOVE failures are hard errors, not conflicts, and clean the temp once', async () => {
  const r = await run([PUT_OK, READ(), { status: 500 }])
  assert.ok(r.error instanceof AtomicWriteError, String(r.error))
  assert.ok(!(r.error instanceof ConflictError))
  assert.equal(r.error.stage, 'move')
  assert.equal(tempDeletes(r.calls).length, 1)
})

test('a MOVE network rejection leaves remote state UNKNOWN and cleans the temp once', async () => {
  const r = await run([PUT_OK, READ(), { reject: new Error('network down') }])
  assert.ok(r.error instanceof Error && !(r.error instanceof ConflictError), String(r.error))
  assert.equal((r.error as { remoteState?: string }).remoteState, 'unknown')
  assert.equal(tempDeletes(r.calls).length, 1)
})

test('PUT failure throws before any temp exists — no DELETE at all', async () => {
  const r = await run([{ status: 507 }])
  assert.ok(r.error instanceof AtomicWriteError, String(r.error))
  assert.equal(r.error.stage, 'put-temp')
  assert.deepEqual(methods(r.calls), ['PUT'])
})

test('beforeMove returning false aborts before MOVE and cleans the temp once', async () => {
  const r = await run([PUT_OK, { status: 204 }], { beforeMove: () => false })
  assert.ok(r.error instanceof AbortedBeforeMoveError, String(r.error))
  assert.equal(r.error.cleanup, 'deleted')
  assert.deepEqual(methods(r.calls), ['PUT', 'DELETE'])
})

test('unique runToken suffixes the temp path and the MOVE source', async () => {
  const r = await run([PUT_OK, READ(), { status: 201 }], { runToken: 'run-42' })
  assert.ok(r.value, String(r.error))
  assert.equal(r.calls[0].url, `${BASE}Song%20One.mp3.run-42.mmdrome-tmp`)
  assert.equal(r.calls[2].url, `${BASE}Song%20One.mp3.run-42.mmdrome-tmp`)
})

test('the write core and the transport layer build the SAME URLs', async () => {
  // Both sides import webdavPaths — this is the pin that they cannot drift into
  // a read at one URL and a write at another. The whitespace base is the field
  // case that used to break exactly that way.
  const { buildWebdavUrl, webdavTempPath } = await import('../src/lib/webdavPaths')
  for (const base of [BASE, `${BASE} `, BASE.replace(/\/+$/, ''), `  ${BASE.replace(/\/+$/, '')}  `]) {
    const t = fakeTransport([PUT_OK, READ(), { status: 201 }])
    await webdavPutAtomic(base, FILE, new ArrayBuffer(8), 'user', 'token', VALIDATORS, t.impl, 1000, { runToken: 'r' })
    assert.equal(t.calls[0].url, buildWebdavUrl(base, webdavTempPath(FILE, 'r')))
    assert.equal(t.calls[1].url, DEST_URL, `re-check url for base ${JSON.stringify(base)}`)
    assert.equal(t.calls[2].headers.Destination, DEST_URL)
  }
})

// Pins the pure collision-check core (`src/lib/webdavPreconditions.ts`) and the
// two entity-tag grammars it chooses between (`webdavPaths.ts`).
//
// The rules here are the ones a field failure would come back through:
// - the ladder must never place a rung a destination's validators cannot
//   express (a missing/inexpressible etag, a non-date last-modified);
// - `validatorsChanged` may only answer `false` from a real comparison —
//   `'unknown'` is what stops the write walking down the ladder;
// - a weak tag and its strong form are the SAME version (RFC 9110 §8.8.3.2), or
//   a proxy that weakens a tag would read as a concurrent write on every row.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  httpDateMs,
  movePreconditionHeaders,
  parseDestinationValidators,
  planPreconditionLadder,
  propfindValidatorsBody,
  revalidationResult,
  validatorsChanged,
} from '../src/lib/webdavPreconditions'
import { expressibleIfEtag, isHttpEntityTag } from '../src/lib/webdavPaths'

const DEST = 'https://dav.example/dav/Song%20One.flac'
const LM = 'Mon, 01 Jan 2024 00:00:00 GMT'
const LATER = 'Tue, 02 Jan 2024 00:00:00 GMT'

test('the validator read asks for exactly the two validators, at Depth 0', () => {
  const body = propfindValidatorsBody()
  assert.match(body, /<d:propfind/)
  assert.match(body, /<d:getetag\/>/)
  assert.match(body, /<d:getlastmodified\/>/)
  assert.doesNotMatch(body, /getcontentlength/, 'a length is not a validator (RFC 9110 §8.6)')
})

test('the ladder starts at the destination-tagged If and always ends with the re-check', () => {
  assert.deepEqual(planPreconditionLadder({ etag: '"a"', lastModified: LM }), [
    'tagged-if',
    'if-match',
    'if-unmodified-since',
    'revalidated',
  ])
})

test('the ladder drops rungs the destination cannot express', () => {
  assert.deepEqual(planPreconditionLadder({ lastModified: LM }), ['if-unmodified-since', 'revalidated'])
  assert.deepEqual(planPreconditionLadder({ etag: '"a"' }), ['tagged-if', 'if-match', 'revalidated'])
  assert.deepEqual(planPreconditionLadder(undefined), ['revalidated'])
  // An etag containing `]` terminates sabre's bracketed capture, so the tagged
  // list cannot carry it — but `If-Match` (RFC 9110 entity-tag grammar) can.
  assert.deepEqual(planPreconditionLadder({ etag: '"a]b"' }), ['if-match', 'revalidated'])
  // Neither grammar can carry an unquoted or control-character tag.
  assert.deepEqual(planPreconditionLadder({ etag: 'abc', lastModified: 'not a date' }), ['revalidated'])
})

test('startAt resumes at the learned rung without re-walking the ones above it', () => {
  const validators = { etag: '"a"', lastModified: LM }
  assert.deepEqual(planPreconditionLadder(validators, 'if-match'), ['if-match', 'if-unmodified-since', 'revalidated'])
  assert.deepEqual(planPreconditionLadder(validators, 'revalidated'), ['revalidated'])
  // A learned rung this destination cannot express falls through to the next
  // usable one instead of blocking the write.
  assert.deepEqual(planPreconditionLadder({ lastModified: LM }, 'tagged-if'), ['if-unmodified-since', 'revalidated'])
  assert.deepEqual(planPreconditionLadder(validators, 'blind'), [...'tagged-if if-match if-unmodified-since revalidated'.split(' ')])
})

test('each rung emits its own header and nothing else', () => {
  const v = { etag: '"abc"', lastModified: LM }
  assert.deepEqual(movePreconditionHeaders('tagged-if', DEST, v), { If: `<${DEST}> (["abc"])` })
  assert.deepEqual(movePreconditionHeaders('if-match', DEST, v), { 'If-Match': '"abc"' })
  assert.deepEqual(movePreconditionHeaders('if-unmodified-since', DEST, v), { 'If-Unmodified-Since': LM })
  assert.deepEqual(movePreconditionHeaders('revalidated', DEST, v), {})
})

test('change detection compares the strongest available validator', () => {
  assert.equal(validatorsChanged({ etag: '"a"' }, { etag: '"a"' }), false)
  assert.equal(validatorsChanged({ etag: '"a"' }, { etag: '"b"' }), true)
  // The etag wins over the date: a server that touches the mtime but not the
  // content has not changed the representation.
  assert.equal(validatorsChanged({ etag: '"a"', lastModified: LM }, { etag: '"a"', lastModified: LATER }), false)
  assert.equal(validatorsChanged({ lastModified: LM }, { lastModified: LM }), false)
  assert.equal(validatorsChanged({ lastModified: LM }, { lastModified: LATER }), true)
})

test('a weak tag and its strong form are the same version', () => {
  assert.equal(validatorsChanged({ etag: 'W/"abc"' }, { etag: '"abc"' }), false)
  assert.equal(validatorsChanged({ etag: 'W/"abc"' }, { etag: '"xyz"' }), true)
})

test('comparison never guesses: an unpaired validator reads as unknown', () => {
  assert.equal(validatorsChanged({ etag: '"a"' }, { lastModified: LM }), 'unknown')
  assert.equal(validatorsChanged({ etag: '"a"' }, {}), 'unknown')
  assert.equal(validatorsChanged({}, {}), 'unknown')
  assert.equal(validatorsChanged({ lastModified: 'yesterday' }, { lastModified: LM }), 'unknown')
})

test('dates compare as instants, not as strings', () => {
  assert.equal(httpDateMs('Mon, 01 Jan 2024 00:00:00 GMT'), Date.parse('2024-01-01T00:00:00Z'))
  assert.equal(httpDateMs(''), undefined)
  assert.equal(httpDateMs('soon'), undefined)
  assert.equal(validatorsChanged({ lastModified: '2024-01-01T00:00:00Z' }, { lastModified: LM }), false)
})

test('the re-check verdict maps a missing reading to unknown, never to unchanged', () => {
  assert.equal(revalidationResult({ etag: '"a"' }, { etag: '"a"' }), 'unchanged')
  assert.equal(revalidationResult({ etag: '"a"' }, { etag: '"b"' }), 'changed')
  assert.equal(revalidationResult({ etag: '"a"' }, null), 'unknown')
})

test('the PROPFIND parser tolerates any namespace prefix and a collection entry first', () => {
  const xml = [
    '<?xml version="1.0"?>',
    '<D:multistatus xmlns:D="DAV:">',
    // Some servers echo the collection alongside the resource.
    '<D:response><D:href>/dav/Song%20One.flac/</D:href><D:propstat><D:prop>',
    '<D:resourcetype><D:collection/></D:resourcetype>',
    '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>',
    '<D:response><D:href>/dav/Song%20One.flac</D:href><D:propstat><D:prop>',
    '<D:getetag>&quot;md5-abc&quot;</D:getetag>',
    '<D:getlastmodified>Mon, 01 Jan 2024 00:00:00 GMT</D:getlastmodified>',
    '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>',
    '</D:multistatus>',
  ].join('')
  assert.deepEqual(parseDestinationValidators(xml), { etag: '"md5-abc"', lastModified: LM })
})

test('the parser reports no validators rather than inventing them', () => {
  assert.equal(parseDestinationValidators(''), null)
  assert.equal(parseDestinationValidators('<not-xml/>'), null)
  // A propstat 404 for the requested props is "no validators", not "unchanged".
  assert.equal(
    parseDestinationValidators('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/x</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response></d:multistatus>'),
    null,
  )
})

test('the two entity-tag grammars differ exactly where WebDAV does', () => {
  for (const ok of ['"abc"', 'W/"abc"', '"a]b"', '"a!b"']) {
    assert.equal(isHttpEntityTag(ok), true, `If-Match can carry ${ok}`)
  }
  // Space (0x20) and DQUOTE are excluded from `etagc`, so a tag carrying one is
  // not transportable in ANY of the two grammars — such a destination falls to
  // the date rung / re-check rather than sending an invalid header.
  assert.equal(isHttpEntityTag('"a b"'), false)
  assert.equal(isHttpEntityTag('abc'), false, 'unquoted')
  assert.equal(isHttpEntityTag('"a"b"'), false)
  assert.equal(isHttpEntityTag('"a\rb"'), false, 'control character')
  assert.equal(isHttpEntityTag(undefined), false)

  assert.equal(expressibleIfEtag('"abc"'), true)
  assert.equal(expressibleIfEtag('W/"abc"'), true)
  assert.equal(expressibleIfEtag('"a]b"'), false, 'the bracket terminates sabre\'s capture')
  assert.equal(expressibleIfEtag('abc'), false)
  assert.equal(expressibleIfEtag('"a\nb"'), false)
})

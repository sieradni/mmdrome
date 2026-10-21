// Pins the single WebDAV wire derivation (`src/lib/webdavPaths.ts`, re-exported
// by `webdavUtils.ts`): base-URL normalization, CapacitorHttp-safe URL
// construction, UTF-8 Basic auth headers, `.mmdrome-tmp` temp-file naming, and
// destination-tagged `If` preconditions.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MMDROME_TMP_SUFFIX,
  authHeaders,
  buildWebdavUrl,
  isTempFile,
  normalizeUrl,
  webdavIfHeader,
  webdavTempPath,
} from '../src/lib/webdavPaths'

const BASE = 'https://dav.example/remote.php/dav/files/alice/'

test('normalizeUrl trims surrounding whitespace and every trailing slash', () => {
  assert.equal(normalizeUrl(BASE), 'https://dav.example/remote.php/dav/files/alice')
  assert.equal(normalizeUrl(`  ${BASE}  `), 'https://dav.example/remote.php/dav/files/alice')
  assert.equal(normalizeUrl(BASE + '//'), 'https://dav.example/remote.php/dav/files/alice')
  assert.equal(normalizeUrl('https://dav.example'), 'https://dav.example')
})

test('buildWebdavUrl is stable across base whitespace and trailing slashes', () => {
  const expected = 'https://dav.example/remote.php/dav/files/alice/Album/Song%20One.flac'
  for (const base of [BASE, BASE.replace(/\/+$/, ''), ` ${BASE} `, BASE + '///']) {
    assert.equal(buildWebdavUrl(base, 'Album/Song One.flac'), expected, `base ${JSON.stringify(base)}`)
  }
  assert.equal(buildWebdavUrl(BASE, '/'), 'https://dav.example/remote.php/dav/files/alice/')
  assert.equal(buildWebdavUrl(BASE, ''), 'https://dav.example/remote.php/dav/files/alice/')
})

test('buildWebdavUrl encodes each segment once and sanitizes raw characters in base URLs for CapacitorHttp', () => {
  assert.equal(
    buildWebdavUrl(BASE, 'A & B/100% Pure + Loud #1?.flac'),
    'https://dav.example/remote.php/dav/files/alice/A%20%26%20B/100%25%20Pure%20%2B%20Loud%20%231%3F.flac',
  )
  assert.equal(
    buildWebdavUrl(BASE, '/Album/Ünïcodé.flac'),
    'https://dav.example/remote.php/dav/files/alice/Album/%C3%9Cn%C3%AFcod%C3%A9.flac',
  )
  // An already-escaped base URL is preserved without double-encoding, while a
  // raw space or non-ASCII char in the base URL is percent-encoded so
  // CapacitorHttp's `urlString == urlString.removingPercentEncoding` check on
  // iOS never hands `URL(string:)` an unencoded space when the path has `%XX`.
  assert.equal(
    buildWebdavUrl('https://dav.example/dav%20files/', 'Song One.flac'),
    'https://dav.example/dav%20files/Song%20One.flac',
  )
  assert.equal(
    buildWebdavUrl('https://dav.example/My Music/Ünï/', '100% Pure.flac'),
    'https://dav.example/My%20Music/%C3%9Cn%C3%AF/100%25%20Pure.flac',
  )
})

test('buildWebdavUrl round-trips: the server decodes back to the exact stored path', () => {
  // The index stores DECODED paths (stripBasePath), so encoding must be
  // lossless per segment — a double-encoded or over-escaped path would send
  // the server to a filename that does not exist.
  const base = 'https://dav.example/My Music/Ünï/'
  for (const path of [
    'Album/Song One.flac',
    'A & B/100% Pure + Loud #1?.flac',
    'Ünïcodé/日本語 — タイトル.flac',
    "apostrophe's/file.flac",
    'already%20escaped-looking name.flac',
  ]) {
    const url = buildWebdavUrl(base, path)
    assert.equal(decodeURIComponent(url.slice(url.indexOf('/My%20Music') + 1)), `My Music/Ünï/${path}`, path)
    // A uniformly-encoded string is what CapacitorHttp needs: its iOS handler
    // only re-encodes a FULLY-raw URL, so a raw space or non-ASCII character
    // left here would mean a MIXED string reaching URL(string:) and failing.
    assert.match(url, /^[\x21-\x7E]+$/, `only printable ASCII left in ${url}`)
    assert.doesNotMatch(url, /%(?![0-9A-Fa-f]{2})/, `every % starts an escape in ${url}`)
  }
})

test('authHeaders encodes ASCII and non-ASCII UTF-8 credentials without throwing', () => {
  assert.deepEqual(authHeaders('alice', 'tok en'), { Authorization: `Basic ${btoa('alice:tok en')}` })
  const utf8Expected = Buffer.from('älice:pässwörd🎵', 'utf8').toString('base64')
  assert.deepEqual(authHeaders('älice', 'pässwörd🎵'), { Authorization: `Basic ${utf8Expected}` })
})

test('webdavTempPath and isTempFile share the single .mmdrome-tmp convention', () => {
  assert.equal(webdavTempPath('Song.flac'), 'Song.flac.mmdrome-tmp')
  assert.equal(webdavTempPath('/dav/files/user/Song.flac'), '/dav/files/user/Song.flac.mmdrome-tmp')
  assert.equal(webdavTempPath('Album/Song.flac'), `Album/Song.flac${MMDROME_TMP_SUFFIX}`)
  assert.equal(isTempFile(webdavTempPath('Album/Song.flac')), true)
  assert.equal(isTempFile('/dav/files/user/Song.flac.mmdrome-tmp'), true)
  assert.equal(isTempFile('Song.flac'), false)
  assert.equal(isTempFile('Song.flac.tmp'), false, 'other tmp suffixes are not ours')
  assert.equal(isTempFile('Song.mmdrome-tmp.flac'), false, 'suffix must be terminal')
})

test('webdavIfHeader scopes the precondition to the DESTINATION (never If-Match)', () => {
  const dest = 'https://dav.example/remote.php/dav/files/alice/Song%20One.flac'
  assert.equal(webdavIfHeader(dest, '"abc123"'), `<${dest}> (["abc123"])`)
  assert.equal(webdavIfHeader(dest, 'W/"abc123"'), `<${dest}> ([W/"abc123"])`)
})

test('webdavIfHeader refuses server-controlled junk instead of emitting a malformed header', () => {
  const dest = 'https://dav.example/dav/Song.flac'
  for (const bogus of ['', 'abc', '"unterminated', '"a"b"', '"a\rb"', '"a]b"', '"a\nb"']) {
    assert.equal(webdavIfHeader(dest, bogus), null, `etag ${JSON.stringify(bogus)} must be dropped`)
  }
  assert.equal(webdavIfHeader(dest, undefined), null)
  assert.equal(webdavIfHeader(dest, null), null)
  assert.equal(webdavIfHeader('https://dav.example/a b.flac', '"abc"'), null)
  assert.equal(webdavIfHeader('https://dav.example/a>.flac', '"abc"'), null)
  assert.equal(webdavIfHeader(dest, '"a)b"'), `<${dest}> (["a)b"])`)
})

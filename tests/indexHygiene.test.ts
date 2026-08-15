// Pins the pure half of the TODO 3.6 index/probe hygiene fixes:
// (a) the persisted index snapshot is slimmed (content-probe tags dropped, the
//     fields the fingerprint + debug fallback need are kept), and
// (d) a malformed PROPFIND href must not abort the whole index build.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slimIndexForPersistence, stripBasePath, computeIndexFingerprint } from '../src/lib/metadataReader'
import type { WebdavFileEntry } from '../src/lib/db'

function entry(over: Partial<WebdavFileEntry> = {}): WebdavFileEntry {
  return {
    path: '/dav/files/user/Song.flac',
    filename: 'Song.flac',
    size: 12345,
    lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
    tags: { title: 'Song', artist: 'Artist', album: 'Album', trackNumber: 1 },
    ...over,
  }
}

test('slimIndexForPersistence drops the content-probe tags but keeps the rest', () => {
  const slim = slimIndexForPersistence([entry()])
  assert.deepEqual(slim[0], {
    path: '/dav/files/user/Song.flac',
    filename: 'Song.flac',
    size: 12345,
    lastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
  })
  assert.equal('tags' in slim[0], false)
})

test('slimIndexForPersistence returns a new array and never mutates the input', () => {
  const original = [entry(), entry({ path: '/other/B.flac', filename: 'B.flac' })]
  const slim = slimIndexForPersistence(original)
  assert.notEqual(slim, original)
  assert.equal(original[0].tags?.title, 'Song', 'input tags untouched')
})

test('slimming does not change the fingerprint (it hashes only path+size)', () => {
  const index = [entry(), entry({ path: '/other/B.flac', filename: 'B.flac', size: 999 })]
  assert.equal(computeIndexFingerprint(slimIndexForPersistence(index)), computeIndexFingerprint(index))
})

test('stripBasePath decodes and strips a path-form href against the base path', () => {
  assert.equal(stripBasePath('https://srv/dav/files/user', '/dav/files/user/Song.flac'), 'Song.flac')
})

test('stripBasePath strips a full-URL href via the base fallback', () => {
  assert.equal(stripBasePath('https://srv/dav/files/user', 'https://srv/dav/files/user/Song.flac'), 'Song.flac')
})

test('stripBasePath survives a malformed href instead of aborting the index (3.6d)', () => {
  // decodeURIComponent('100%zzz') throws URIError; the fix falls back to the
  // raw href so one bad entry can't take down the whole PROPFIND walk.
  assert.doesNotThrow(() => stripBasePath('https://srv/dav', '100%zzz'))
  assert.equal(stripBasePath('https://srv/dav', '100%zzz'), '100%zzz')
})

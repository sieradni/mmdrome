// Pins the single WebDAV server-identity key (TODO 3.5): the scan stamps rows
// with `webdavBase` and Push compares against the current server using the SAME
// derivation, so stray whitespace can never make the two sides diverge and
// flag the whole library "Server URL updated".

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webdavBaseKey, normalizeUrl } from '../src/lib/webdavUtils'

test('trims whitespace from both the URL and the username', () => {
  assert.equal(webdavBaseKey('  https://srv/dav  ', '  user  '), 'https://srv/dav|user')
})

test('the trailing slash is preserved to match how existing rows were stamped', () => {
  // The stamp predates this fix and kept the trailing slash (the Settings
  // placeholder is a trailing-slash URL); normalizing it away here would flag
  // every already-stamped row wrongServer. The key must stay trim-only.
  assert.equal(webdavBaseKey('https://srv/dav/', 'user'), 'https://srv/dav/|user')
})

test('case is preserved (paths can be case-sensitive; both sides still agree)', () => {
  assert.equal(webdavBaseKey('HTTPS://Srv/Dav', 'User'), 'HTTPS://Srv/Dav|User')
})

test('the derivation is a pure, stable function of its inputs (stamp = check)', () => {
  // The property Push relies on: the same url|user string in produces the same
  // key out, no matter which side (stamp vs current-server check) computes it.
  const a = webdavBaseKey('https://srv/dav/', 'user')
  const b = webdavBaseKey('https://srv/dav/', 'user')
  assert.equal(a, b)
})

test('normalizeUrl strips trailing slashes but leaves the interior path intact', () => {
  assert.equal(normalizeUrl(' https://srv/dav/files/// '), 'https://srv/dav/files')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isCurrentWebdavSession,
  normalizeWebdavCredentials,
  sameWebdavCredentials,
  type WebdavSession,
} from '../src/lib/webdavSession'

test('WebDAV credentials normalize URL and username for idempotent updates', () => {
  const first = normalizeWebdavCredentials(' https://dav.example/music/ ', ' alice ', 'token')
  const repeated = normalizeWebdavCredentials('https://dav.example/music/', 'alice', 'token')

  assert.deepEqual(first, repeated)
  assert.equal(sameWebdavCredentials(first, repeated), true)
})

test('a token change invalidates the WebDAV session even when the server is unchanged', () => {
  const current = normalizeWebdavCredentials('https://dav.example/music', 'alice', 'old')
  const changed = normalizeWebdavCredentials('https://dav.example/music', 'alice', 'new')

  assert.equal(sameWebdavCredentials(current, changed), false)
})

test('stale WebDAV session generations cannot publish after a credential swap', () => {
  const session: WebdavSession = {
    ...normalizeWebdavCredentials('https://old.example/music', 'alice', 'token'),
    baseKey: 'https://old.example/music|alice',
    generation: 4,
  }
  const current = normalizeWebdavCredentials('https://new.example/music', 'alice', 'token')

  assert.equal(isCurrentWebdavSession(session, current, 5), false)
  assert.equal(isCurrentWebdavSession(session, session, 4), true)
})

// Pins the secure credential storage (2026-09-17): secret-key classification,
// native Keychain routing through the _bridge seam (writes keep IndexedDB
// clean, migrate-on-read, delete clears BOTH stores, bridge failures fall
// back to IndexedDB so a credential never becomes unreadable), and the web
// pass-through. The Dexie `userSettings` table is stubbed like
// tests/persistedStore.test.ts stubs it — Node has no IndexedDB.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/lib/db'
import {
  SECRET_SETTING_KEYS,
  isSecretSettingKey,
  secureGet,
  secureSet,
  secureDelete,
  _bridge
} from '../src/lib/secureStore'

// ── Dexie userSettings stub (same pattern as persistedStore.test.ts) ──────
const rows = new Map<string, string | number | boolean | object>()

Object.getPrototypeOf(db.userSettings).get = (async (key: string) => {
  const value = rows.get(key)
  return value === undefined ? undefined : { key, value }
}) as never
Object.getPrototypeOf(db.userSettings).put = (async (entry: {
  key: string
  value: string | number | boolean | object
}) => {
  rows.set(entry.key, entry.value)
}) as never
Object.getPrototypeOf(db.userSettings).delete = (async (key: string) => {
  rows.delete(key)
}) as never

// ── Fake Keychain behind the bridge seam ──────────────────────────────────
let native = false
let failNative = false
const keychain = new Map<string, string>()

_bridge.native = () => native
_bridge.get = async (key: string) => {
  if (failNative) throw new Error('bridge down')
  return { value: keychain.get(key) ?? '' }
}
_bridge.set = async (key: string, value: string) => {
  if (failNative) throw new Error('bridge down')
  keychain.set(key, value)
}
_bridge.del = async (key: string) => {
  if (failNative) throw new Error('bridge down')
  keychain.delete(key)
}

test('isSecretSettingKey classifies the four credential keys and nothing else', () => {
  assert.deepEqual([...SECRET_SETTING_KEYS].sort(), [
    'lastfmSession',
    'listenbrainzToken',
    'navidromePassword',
    'webdavToken'
  ])
  for (const k of SECRET_SETTING_KEYS) assert.equal(isSecretSettingKey(k), true, k)
  for (const k of ['navidromeUrl', 'navidromeUser', 'webdavUser', 'crossfadeDuration', 'lastfmScrobbling']) {
    assert.equal(isSecretSettingKey(k), false, k)
  }
})

test('native secureSet writes the Keychain and leaves IndexedDB clean', async () => {
  native = true
  keychain.clear()
  rows.clear()
  await secureSet('navidromePassword', 'hunter2')
  assert.equal(keychain.get('navidromePassword'), '"hunter2"')
  assert.equal(rows.has('navidromePassword'), false, 'secret must never enter IndexedDB')
  assert.equal(await secureGet('navidromePassword'), 'hunter2')
})

test('native secureGet round-trs JSON types', async () => {
  native = true
  keychain.clear()
  await secureSet('lastfmSession', { key: 'abc', subscriber: 1 })
  const session = await secureGet<{ key: string; subscriber: number }>('lastfmSession')
  assert.deepEqual(session, { key: 'abc', subscriber: 1 })
})

test('migrate-on-read: native read of an IndexedDB-only secret moves it to the Keychain', async () => {
  native = true
  keychain.clear()
  rows.clear()
  rows.set('listenbrainzToken', 'tok-old-install')
  assert.equal(await secureGet('listenbrainzToken'), 'tok-old-install')
  assert.equal(keychain.get('listenbrainzToken'), '"tok-old-install"', 'migrated into Keychain')
  assert.equal(rows.has('listenbrainzToken'), false, 'IndexedDB row deleted after migration')
})

test('bridge failure on read falls back to IndexedDB without a destructive migration', async () => {
  native = true
  keychain.clear()
  rows.clear()
  rows.set('webdavToken', 'tok-fallback')
  failNative = true
  try {
    assert.equal(await secureGet('webdavToken'), 'tok-fallback')
    assert.equal(rows.has('webdavToken'), true, 'fallback must keep the IndexedDB copy')
  } finally {
    failNative = false
  }
})

test('bridge failure on write degrades to IndexedDB so the credential is not lost', async () => {
  native = true
  keychain.clear()
  rows.clear()
  failNative = true
  try {
    await secureSet('navidromePassword', 'p@ss')
    assert.equal(rows.get('navidromePassword'), 'p@ss', 'degraded write lands in IndexedDB')
    assert.equal(keychain.has('navidromePassword'), false)
  } finally {
    failNative = false
  }
})

test('secureDelete clears BOTH stores on native', async () => {
  native = true
  keychain.clear()
  rows.clear()
  await secureSet('navidromePassword', 'gone-soon')
  rows.set('navidromePassword', 'stale-idb-copy')
  await secureDelete('navidromePassword')
  assert.equal(keychain.has('navidromePassword'), false)
  assert.equal(rows.has('navidromePassword'), false)
  assert.equal(await secureGet('navidromePassword'), undefined)
})

test('web pass-through: values stay in IndexedDB, Keychain never touched', async () => {
  native = false
  keychain.clear()
  rows.clear()
  await secureSet('webdavToken', 'web-token')
  assert.equal(rows.get('webdavToken'), 'web-token')
  assert.equal(keychain.size, 0, 'no Keychain traffic on web')
  assert.equal(await secureGet('webdavToken'), 'web-token')
  await secureDelete('webdavToken')
  assert.equal(await secureGet('webdavToken'), undefined)
})

test('missing secret reads as undefined on both platforms', async () => {
  native = true
  keychain.clear()
  rows.clear()
  assert.equal(await secureGet('navidromePassword'), undefined)
  native = false
  assert.equal(await secureGet('navidromePassword'), undefined)
})

test('db.ts choke point diverts secret keys and leaves plain keys on the row path', async () => {
  const { getSetting, setSetting, deleteSetting } = await import('../src/lib/db')
  native = true
  keychain.clear()
  rows.clear()
  // Secret key: routes through the secure store (Keychain on native).
  await setSetting('navidromePassword', 'via-choke-point')
  assert.equal(keychain.get('navidromePassword'), '"via-choke-point"')
  assert.equal(rows.has('navidromePassword'), false, 'choke point must not write the secret row')
  assert.equal(await getSetting('navidromePassword'), 'via-choke-point')
  await deleteSetting('navidromePassword')
  assert.equal(await getSetting('navidromePassword'), undefined)
  // Plain key: the ordinary userSettings row path even on native.
  await setSetting('navidromeUser', 'Michael')
  assert.equal(rows.get('navidromeUser'), 'Michael')
  assert.equal(keychain.has('navidromeUser'), false, 'plain keys must not touch the Keychain')
})

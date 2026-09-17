// Pins the session-stable salt (the 2026-09-17 cache-key rework of
// `buildAuthParams`). Contract: the salt minted once is REUSED for the life
// of the credential pair and across page loads (localStorage), so every URL
// that bakes auth params (covers, streams, the SW cache key, the preload
// Cache-API keys, the native snapshot) survives a restart — the server
// accepts ANY salt (it validates t === md5(password + s-as-sent)), so
// stability is purely a cache-key concern. The salt is not a secret: Subsonic
// auth sends it cleartext in every request URL by protocol.
//
// Module-level auth cache caveat: `buildAuthParams` re-derives only when the
// (username, password) pair changes, so each test uses a DISTINCT username to
// force a fresh derivation through the storage path.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCoverArtUrl, type NavidromeConfig } from '../src/lib/navidromeApi'
import { md5 } from '../src/lib/md5'

/** Installs a Map-backed localStorage stub and returns it (plus restore). */
function stubStorage(): { store: Map<string, string>; restore: () => void } {
  const store = new Map<string, string>()
  const original = (globalThis as any).localStorage
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
  return { store, restore: () => { (globalThis as any).localStorage = original } }
}

function saltOf(url: string): string {
  return new URL(url).searchParams.get('s') ?? ''
}

function tokenOf(url: string): string {
  return new URL(url).searchParams.get('t') ?? ''
}

test('the salt is stable within a session and persisted for the next one', async (t) => {
  const { store, restore } = stubStorage()
  t.after(restore)

  const config: NavidromeConfig = { baseUrl: 'https://srv.example', username: 'u-stable', password: 'p' }
  const salt1 = saltOf(buildCoverArtUrl(config, 'al-1', 128))
  const salt2 = saltOf(buildCoverArtUrl(config, 'al-2', 256))
  assert.equal(salt1, salt2, 'same credential pair ⇒ same salt within the session')
  assert.equal(salt1.length, 16, '16 chars, the historical generateSalt length')
  assert.equal(store.get('mmdrome:authSalt'), salt1, 'the minted salt is persisted for the next session')
})

test('a restart reuses the stored salt — URLs (and every cache key) survive', async (t) => {
  const { store, restore } = stubStorage()
  t.after(restore)

  // Simulate the previous session having minted and stored a salt.
  store.set('mmdrome:authSalt', 'PREVIOUSSALT1234')

  const config: NavidromeConfig = { baseUrl: 'https://srv.example', username: 'u-restart', password: 'p' }
  const url = buildCoverArtUrl(config, 'al-9', 128)
  assert.equal(saltOf(url), 'PREVIOUSSALT1234', 're-derivation reads storage instead of minting fresh')

  // A different credential pair also reuses the stored salt (storage is
  // global, not per-credential) — and auth stays VALID under it: the server
  // contract is t === md5(password + s), which the fresh token satisfies.
  const other = buildCoverArtUrl({ ...config, username: 'u-restart-2', password: 'p2' }, 'al-9', 128)
  assert.equal(saltOf(other), 'PREVIOUSSALT1234')
  assert.equal(tokenOf(other), md5('p2' + 'PREVIOUSSALT1234'))
})

test('a credential change mints a new token over the SAME salt', async (t) => {
  const { store, restore } = stubStorage()
  t.after(restore)

  const base: NavidromeConfig = { baseUrl: 'https://srv.example', username: 'u-rotate', password: 'p' }
  const url1 = buildCoverArtUrl(base, 'al-1', 128)
  const url2 = buildCoverArtUrl({ ...base, password: 'changed' }, 'al-1', 128)

  assert.equal(saltOf(url1), saltOf(url2), 'the salt is a cache-key concern, not a credential — unchanged')
  assert.equal(tokenOf(url1), md5('p' + saltOf(url1)))
  assert.equal(tokenOf(url2), md5('changed' + saltOf(url2)), 'the token is re-derived from the new password')
  assert.equal(store.get('mmdrome:authSalt'), saltOf(url2), 'the persisted salt is untouched')
})

test('without storage, the salt still mints and auth stays valid (in-memory fallback)', async (t) => {
  const original = (globalThis as any).localStorage
  ;(globalThis as any).localStorage = undefined
  t.after(() => { (globalThis as any).localStorage = original })

  const config: NavidromeConfig = { baseUrl: 'https://srv.example', username: 'u-nostorage', password: 'p' }
  const url = buildCoverArtUrl(config, 'al-1', 128)
  const salt = saltOf(url)
  assert.equal(salt.length, 16, 'a fresh salt was minted despite no storage')
  assert.equal(tokenOf(url), md5('p' + salt), 'auth remains valid')
})

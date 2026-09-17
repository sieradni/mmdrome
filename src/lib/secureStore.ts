/**
 * Secure credential storage (2026-09-17).
 *
 * Secrets (see SECRET_SETTING_KEYS) never persist into IndexedDB on native:
 * `db.getSetting/setSetting/deleteSetting` divert them to the iOS Keychain
 * through the BackgroundAudio bridge (BackgroundAudioPlugin secureGet/
 * secureSet/secureDelete → KeychainStore, kSecClassGenericPassword under the
 * `com.mmdrome.player.credentials` service,
 * kSecAttrAccessibleAfterFirstUnlock so the scrobble flush engine can read
 * while locked). On web there is no platform secure store for secrets an
 * app must read back (HttpOnly cookies can't be read; Subsonic needs the
 * plaintext password for md5(password+salt)) — IndexedDB stays, guarded by
 * the CSP; the Android equivalent (Keystore) would slot in here.
 *
 * Migration is lazy per key: the first read that finds the secret only in
 * IndexedDB (pre-update install) writes it to the Keychain and deletes the
 * row; a failed bridge call falls back to IndexedDB so a credential never
 * becomes unreadable. On logout-style `deleteSetting` both stores clear.
 * Values are JSON-encoded so types round-trip exactly.
 */

import { Capacitor } from '@capacitor/core'
import { BackgroundAudio } from './nativePlugin'
import { db } from './db'
import { SECRET_SETTING_KEYS, isSecretSettingKey } from './secretKeys'

export { SECRET_SETTING_KEYS, isSecretSettingKey }

const isNative = (): boolean => Capacitor.isNativePlatform()

/** The secure* bridge methods RESOLVE their errors (`{ error: string }`)
 *  instead of rejecting: the Capacitor 8.5.0 binary xcframework gates
 *  `CAPPluginCall.reject` behind `$NonescapableTypes`, which CI's macos-14
 *  compiler does not define — `reject` literally does not exist at that
 *  compilation site (a local Mac with current Xcode compiles it fine; only
 *  CI catches the difference). This treats error results exactly like
 *  rejected promises so the fallback paths stay one code path. Exported for
 *  the contract test. */
export async function bridgeCall<T>(p: Promise<T>): Promise<T> {
  const res = (await p) as T & { error?: string }
  if (res && typeof res === 'object' && typeof res.error === 'string') {
    throw new Error(res.error)
  }
  return res
}

/** Bridge seam (default = the real Capacitor binding). Overridable in tests
 *  — the same injectable-adapter pattern as the transport/manager deps. */
export const _bridge = {
  native: isNative,
  get: (key: string) => bridgeCall(BackgroundAudio.secureGet({ key })),
  set: (key: string, value: string) => bridgeCall(BackgroundAudio.secureSet({ key, value })),
  del: (key: string) => bridgeCall(BackgroundAudio.secureDelete({ key }))
}

/**
 * Unified get for SECRET keys. Order: Keychain → IndexedDB (migrate-on-read:
 * on native a hit in IndexedDB means a pre-update install — move it into the
 * Keychain and delete the row) → undefined. A failed Keychain read falls
 * back to IndexedDB.
 */
export async function secureGet<T = string>(key: string): Promise<T | undefined> {
  if (_bridge.native()) {
    try {
      const { value } = await _bridge.get(key)
      if (value !== '') return JSON.parse(value) as T
      // Keychain miss: fall through to IndexedDB for the migration path.
    } catch {
      // Bridge failure — IndexedDB below is the fallback.
    }
  }
  const idb = (await db.userSettings.get(key))?.value
  if (idb === undefined) return undefined
  if (_bridge.native()) {
    try {
      await _bridge.set(key, JSON.stringify(idb))
      await db.userSettings.delete(key)
    } catch {
      // Migration failed; the IndexedDB copy stays authoritative.
    }
  }
  return idb as T
}

/**
 * Unified set for SECRET keys: Keychain first on native; on success the
 * IndexedDB row is deleted (not written), so the secret never re-enters
 * IndexedDB. On bridge failure the write lands in IndexedDB — a degraded
 * store beats a lost credential.
 */
export async function secureSet(key: string, value: string | number | boolean | object): Promise<void> {
  if (_bridge.native()) {
    try {
      await _bridge.set(key, JSON.stringify(value))
      await db.userSettings.delete(key)
      return
    } catch {
      // fall through to IndexedDB
    }
  }
  await db.userSettings.put({ key, value })
}

/**
 * Unified delete for SECRET keys: clears BOTH stores (idempotent), so a
 * disconnect/logout wipes the Keychain copy too, not just IndexedDB.
 */
export async function secureDelete(key: string): Promise<void> {
  if (_bridge.native()) {
    try {
      await _bridge.del(key)
    } catch {
      // still clear IndexedDB below
    }
  }
  await db.userSettings.delete(key)
}

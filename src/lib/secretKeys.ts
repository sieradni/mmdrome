/**
 * Pure key classification for the secure credential store (2026-09-17).
 *
 * Lives in its own module so `db.ts` can classify a settings key WITHOUT
 * importing `secureStore.ts` — db → secureStore → db is a circular
 * dependency and the bundler hard-fails on it. secureStore re-exports these
 * for its consumers; nothing here imports anything.
 */

/** Settings keys whose values must not sit in IndexedDB on native. */
export const SECRET_SETTING_KEYS = [
  'navidromePassword',
  'webdavToken',
  'lastfmSession',
  'listenbrainzToken'
] as const

/** True when `key` is one of the secret settings keys — the db.ts
 *  get/set/delete choke point diverts these to secureGet/secureSet/
 *  secureDelete (Keychain on native, IndexedDB on web). */
export function isSecretSettingKey(key: string): boolean {
  return (SECRET_SETTING_KEYS as readonly string[]).includes(key)
}

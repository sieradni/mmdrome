import { writable, type Writable } from 'svelte/store'
import { getSetting, setSetting } from './db'

/** Values that can round-trip through the Dexie `userSettings` table. */
export type PersistedValue = string | number | boolean | object

export interface PersistedStore<T extends PersistedValue> {
  store: Writable<T>
  /** Loads the saved value into the store. Idempotent; persistence only starts
   *  once this resolves, so a store written before/while restoring can never be
   *  clobbered by the initial value or a re-read. */
  restore: () => Promise<void>
}

/**
 * A writable store backed by a Dexie `userSettings` row. The store is the
 * single source of truth for the value; persistence is a store-layer concern
 * (subscribers persist on change) and engine side-effects stay in the
 * playback manager, which reads `get(store)` when it needs to push the value.
 *
 * `restore()` must be awaited once (initStores does it) before the value is
 * trusted: the subscription fires immediately on module load with `initial`,
 * and without the `restored` flag that fire would persist the default over a
 * saved value.
 */
export function persisted<T extends PersistedValue>(key: string, initial: T): PersistedStore<T> {
  const store = writable(initial)
  let restored = false
  store.subscribe((v) => {
    if (!restored) return
    // Fire-and-forget persistence, but never silently: a rejecting IndexedDB
    // write must not surface as an unhandled rejection, and a lost setting is
    // worse than a visible warning.
    setSetting(key, v).catch((err) => {
      console.warn(`[persisted] failed to save "${key}":`, err)
    })
  })
  return {
    store,
    async restore() {
      if (restored) return
      const saved = await getSetting<T>(key)
      if (saved !== undefined) store.set(saved)
      restored = true
    },
  }
}

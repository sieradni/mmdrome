import { writable, get } from 'svelte/store'
import { db, getSetting, setSetting } from '../db'
import { persisted } from '../persistedStore'
import { BUILTIN_PRESETS } from './builtInPresets'
import type { EqPreset } from './eqTypes'

const USER_PRESET_PREFIX = 'eq_user_preset_'
const ACTIVE_PRESET_KEY = 'active_eq_preset'
const CURRENT_EQ_STATE_KEY = 'current_eq_state'

export const activePresetId = writable<string>('flat')
export const userPresets = writable<EqPreset[]>([])
export const currentEqState = writable<EqPreset>(BUILTIN_PRESETS[0])
export const draftState = writable<EqPreset>(BUILTIN_PRESETS[0])
// Bypass is an engine-bound scalar — store-layer persistence via `persisted`,
// restored in `initEqStore` (the eq module owns its init).
const _eqBypassed = persisted<boolean>('eq_bypassed', false)
export const eqBypassed = _eqBypassed.store

export async function initEqStore(): Promise<void> {
  // Load user presets from IndexedDB
  try {
    const entries = await db.userSettings
      .filter((s) => s.key.startsWith(USER_PRESET_PREFIX))
      .toArray()

    const loadedUserPresets: EqPreset[] = []
    for (const e of entries) {
      if (e.value && typeof e.value === 'object') {
        loadedUserPresets.push(e.value as EqPreset)
      }
    }
    userPresets.set(loadedUserPresets)

    // Load last active state or default to Flat
    const savedState = await getSetting<EqPreset>(CURRENT_EQ_STATE_KEY)
    const savedPresetId = await getSetting<string>(ACTIVE_PRESET_KEY)

    if (savedState) {
      currentEqState.set(savedState)
      if (savedPresetId) activePresetId.set(savedPresetId)
    } else if (savedPresetId) {
      const preset = findPresetById(savedPresetId, loadedUserPresets)
      if (preset) {
        currentEqState.set(preset)
        activePresetId.set(savedPresetId)
      }
    }

    draftState.set(get(currentEqState))

    // Bypass is a `persisted` store — restore it (idempotent) before any write.
    await _eqBypassed.restore()
  } catch (err) {
    console.error('Failed to initialize EQ store:', err)
  }
}

export function findPresetById(id: string, customPresets?: EqPreset[]): EqPreset | undefined {
  const custom = customPresets ?? get(userPresets)
  return BUILTIN_PRESETS.find((p) => p.id === id) || custom.find((p) => p.id === id)
}

export async function saveUserPreset(preset: EqPreset): Promise<void> {
  const isBuiltin = BUILTIN_PRESETS.some((p) => p.id === preset.id)
  const cleanPreset: EqPreset = {
    ...preset,
    id: isBuiltin ? `custom_${Date.now()}` : preset.id,
    isBuiltin: false,
  }

  await setSetting(`${USER_PRESET_PREFIX}${cleanPreset.id}`, cleanPreset)

  userPresets.update((list) => {
    const idx = list.findIndex((p) => p.id === cleanPreset.id)
    if (idx >= 0) {
      const updated = [...list]
      updated[idx] = cleanPreset
      return updated
    }
    return [...list, cleanPreset]
  })

  activePresetId.set(cleanPreset.id)
  currentEqState.set(cleanPreset)
  draftState.set(cleanPreset)
  await persistEqState(cleanPreset, cleanPreset.id)
}

export async function deleteUserPreset(id: string): Promise<void> {
  if (BUILTIN_PRESETS.some((p) => p.id === id)) return // cannot delete built-in

  await db.userSettings.delete(`${USER_PRESET_PREFIX}${id}`)

  userPresets.update((list) => list.filter((p) => p.id !== id))

  if (get(activePresetId) === id) {
    const defaultPreset = BUILTIN_PRESETS[0]
    activePresetId.set(defaultPreset.id)
    currentEqState.set(defaultPreset)
    draftState.set(defaultPreset)
    await persistEqState(defaultPreset, defaultPreset.id)
  }
}

export async function applyPreset(id: string): Promise<EqPreset | undefined> {
  const preset = findPresetById(id)
  if (!preset) return undefined

  activePresetId.set(id)
  currentEqState.set(preset)
  draftState.set(preset)
  await persistEqState(preset, id)
  return preset
}

export async function saveAsCurrentPreset(draft: EqPreset): Promise<EqPreset> {
  const activeId = get(activePresetId)
  const preset = findPresetById(activeId)

  let committed: EqPreset

  if (preset && !preset.isBuiltin) {
    committed = {
      ...preset,
      mode: draft.mode,
      preampDb: draft.preampDb,
      filters: draft.filters.map((f) => ({ ...f })),
    }
    await setSetting(`${USER_PRESET_PREFIX}${committed.id}`, committed)

    userPresets.update((list) => {
      const idx = list.findIndex((p) => p.id === committed.id)
      if (idx >= 0) {
        const updated = [...list]
        updated[idx] = committed
        return updated
      }
      return list
    })
  } else {
    const name = preset ? `${preset.name} (modified)` : `User Preset ${Date.now()}`
    committed = {
      id: `user_${Date.now()}`,
      name,
      mode: draft.mode,
      preampDb: draft.preampDb,
      filters: draft.filters.map((f) => ({ ...f })),
      isBuiltin: false,
    }
    await setSetting(`${USER_PRESET_PREFIX}${committed.id}`, committed)
    userPresets.update((list) => [...list, committed])
    activePresetId.set(committed.id)
  }

  currentEqState.set(committed)
  draftState.set(committed)
  await persistEqState(committed, get(activePresetId))
  return committed
}

export async function persistEqState(state: EqPreset, presetId: string): Promise<void> {
  await setSetting(CURRENT_EQ_STATE_KEY, state)
  await setSetting(ACTIVE_PRESET_KEY, presetId)
}

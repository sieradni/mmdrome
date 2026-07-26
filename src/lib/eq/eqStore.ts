import { writable, get } from 'svelte/store'
import { db, getSetting, setSetting } from '../db'
import { BUILTIN_PRESETS } from './builtInPresets'
import type { EqPreset, EqFilterConfig } from './eqTypes'

const USER_PRESET_PREFIX = 'eq_user_preset_'
const ACTIVE_PRESET_KEY = 'active_eq_preset'
const CURRENT_EQ_STATE_KEY = 'current_eq_state'
const EQ_BYPASSED_KEY = 'eq_bypassed'

export const activePresetId = writable<string>('flat')
export const userPresets = writable<EqPreset[]>([])
export const currentEqState = writable<EqPreset>(BUILTIN_PRESETS[0])
export const eqBypassed = writable<boolean>(false)

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

    // Load bypass state
    const savedBypass = await getSetting<boolean>(EQ_BYPASSED_KEY)
    if (savedBypass !== undefined) {
      eqBypassed.set(savedBypass)
    }
  } catch (err) {
    console.error('Failed to initialize EQ store:', err)
  }
}

export async function persistEqBypass(bypassed: boolean): Promise<void> {
  eqBypassed.set(bypassed)
  await setSetting(EQ_BYPASSED_KEY, bypassed)
}

export function getAllPresets(): EqPreset[] {
  return [...BUILTIN_PRESETS, ...get(userPresets)]
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
    await persistEqState(defaultPreset, defaultPreset.id)
  }
}

export async function applyPreset(id: string): Promise<EqPreset | undefined> {
  const preset = findPresetById(id)
  if (!preset) return undefined

  activePresetId.set(id)
  currentEqState.set(preset)
  await persistEqState(preset, id)
  return preset
}

export async function updateCurrentState(
  updater: (state: EqPreset) => EqPreset
): Promise<EqPreset> {
  const current = get(currentEqState)
  const updated = updater(current)

  // Check if modified from active preset
  const activeId = get(activePresetId)
  const activePreset = findPresetById(activeId)

  let newActiveId = activeId
  if (activePreset && isPresetModified(activePreset, updated)) {
    newActiveId = 'custom'
    activePresetId.set('custom')
  }

  currentEqState.set(updated)
  await persistEqState(updated, newActiveId)
  return updated
}

function isPresetModified(a: EqPreset, b: EqPreset): boolean {
  if (a.preampDb !== b.preampDb) return true
  if (a.mode !== b.mode) return true
  if (a.filters.length !== b.filters.length) return true
  for (let i = 0; i < a.filters.length; i++) {
    const f1 = a.filters[i]
    const f2 = b.filters[i]
    if (
      f1.type !== f2.type ||
      f1.frequency !== f2.frequency ||
      f1.gain !== f2.gain ||
      f1.q !== f2.q ||
      f1.enabled !== f2.enabled
    ) {
      return true
    }
  }
  return false
}

export async function persistEqState(state: EqPreset, presetId: string): Promise<void> {
  await setSetting(CURRENT_EQ_STATE_KEY, state)
  await setSetting(ACTIVE_PRESET_KEY, presetId)
}

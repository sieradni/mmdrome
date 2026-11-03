/**
 * Saved library filter/sort presets ("smart views") — pure core (TODO Phase 3A).
 *
 * A preset is a NAME plus a snapshot of the shared filter/sort state. It is
 * deliberately independent of both queue rule sets: applying a preset rewrites
 * `libraryFilters` only, so a library view change can never silently re-rank or
 * refill the auto queue (the 2026-09-29 decoupling; see QUEUE-INVARIANTS E9 and
 * `FilterSortBar`'s explicit apply-to-auto-queue button for the deliberate path).
 *
 * Persistence, DOM and Dexie stay out of this module so every rule here is
 * table-testable in Node: the store layer decodes untrusted saved JSON through
 * `decodeFilterPresets`, and the view calls `planSavePreset`/`applyPreset`.
 */

import type { LibraryFilterState } from './libraryFilters'
import {
  cloneFilterRuleSet,
  decodeFilterRuleSet,
  filterRuleSetsEqual,
  type FilterRuleSet,
} from './filterCore'
import { normalizeSort, sortSignature, type SortState } from './sortCore'

/** Longest accepted preset name (after whitespace normalization). */
export const PRESET_NAME_MAX = 40

/** Most presets a library may hold — a chip strip, not a filing cabinet. */
export const PRESET_MAX_COUNT = 30

/** The filter RULE SET a preset stores — never the popup open/close flags. */
export type PresetFilters = FilterRuleSet

export interface FilterPreset {
  id: string
  name: string
  filters: PresetFilters
  /** The whole two-tier sort stack, seed included (a preset restores its own
   *  random order — "Random" in a saved view is the same random view). */
  sort: SortState
}

export type SavePresetResult =
  | { ok: true; presets: FilterPreset[] }
  | { ok: false; reason: 'empty-name' | 'limit' }

/** The part of the shared state a preset snapshots. */
export function filtersFromState(state: LibraryFilterState): PresetFilters {
  return cloneFilterRuleSet(state)
}

function sanitizeName(raw: string): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PRESET_NAME_MAX)
    .trim()
}

function nameKey(name: string): string {
  return name.toLocaleLowerCase()
}

/**
 * Saves the CURRENT view under `rawName`.
 *
 * - the name is whitespace-normalized and trimmed (an all-space name is
 *   `empty-name`, never a nameless chip);
 * - a name that already exists (case-insensitively) REPLACES that preset in
 *   place, keeping its id and position — saving "Late night" twice updates one
 *   chip instead of growing a pile of near-duplicates;
 * - adding a genuinely new preset at `PRESET_MAX_COUNT` is refused (`limit`)
 *   rather than silently evicting a saved view.
 */
export function planSavePreset(
  presets: readonly FilterPreset[],
  rawName: string,
  state: LibraryFilterState,
  id: string,
): SavePresetResult {
  const name = sanitizeName(rawName)
  if (!name) return { ok: false, reason: 'empty-name' }

  const filter = filtersFromState(state)
  const sort = normalizeSort(state.sort)

  const key = nameKey(name)
  const existing = presets.findIndex((p) => nameKey(p.name) === key)
  if (existing >= 0) {
    // Keep the STORED display name: retyping "focus" must not restyle an
    // existing "Focus" chip just because the save box was filled in lowercase.
    return {
      ok: true,
      presets: presets.map((p, i) =>
        i === existing ? { ...p, filters: filter, sort } : p,
      ),
    }
  }

  if (presets.length >= PRESET_MAX_COUNT) return { ok: false, reason: 'limit' }

  return { ok: true, presets: [...presets, { id, name, filters: filter, sort }] }
}

/** Removes one preset by id; unknown ids are a no-op. */
export function removePreset(presets: readonly FilterPreset[], id: string): FilterPreset[] {
  return presets.filter((p) => p.id !== id)
}

/**
 * Applies a preset to the shared state. Both popups are closed by the result:
 * a preset is an applied view, not a dialog opening.
 */
export function applyPreset(state: LibraryFilterState, preset: FilterPreset): LibraryFilterState {
  return {
    ...state,
    ...preset.filters,
    sort: normalizeSort(preset.sort),
    filterOpen: false,
    sortOpen: false,
  }
}

/**
 * Applies the saved view named by `id` — the ONE apply path shared by the chip
 * strip and the manager list, so both resolve an id the same way. Returns
 * `null` for an unknown id (a stale chip must not write anything).
 */
export function applyPresetById(
  state: LibraryFilterState,
  presets: readonly FilterPreset[],
  id: string,
): LibraryFilterState | null {
  const preset = presets.find((p) => p.id === id)
  return preset ? applyPreset(state, preset) : null
}

/**
 * True when the live state already equals the preset (drives the chip
 * highlight). The random SEED is ignored: re-rolling a random view is the same
 * view in a new order, and the chip must stay lit.
 */
export function presetIsActive(preset: FilterPreset, state: LibraryFilterState): boolean {
  if (sortSignature(state.sort) !== sortSignature(preset.sort)) return false
  return filterRuleSetsEqual(preset.filters, state)
}

/**
 * Validates a saved preset row from IndexedDB — the ONLY trust boundary for
 * this store. Malformed rows are dropped (not repaired into nonsense), a
 * duplicated name keeps its first occurrence, an unknown sort key becomes "no
 * sort", and the list is capped. A missing/old value yields `[]`.
 *
 * Legacy rows (a top-level `sortBy`/`sortAsc` pair) decode through the shared
 * `normalizeSort`, so a preset saved before 2026-11-01 keeps its sort.
 */
export function decodeFilterPresets(raw: unknown): FilterPreset[] {
  if (!Array.isArray(raw)) return []
  const out: FilterPreset[] = []
  const seen = new Set<string>()
  for (const row of raw) {
    if (out.length >= PRESET_MAX_COUNT) break
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id.trim() : ''
    const name = sanitizeName(typeof r.name === 'string' ? r.name : '')
    if (!id || !name) continue
    const key = nameKey(name)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      id,
      name,
      // Legacy scalar filter fields inside a saved preset migrate to clauses
      // through the shared decoder — a view saved before 2026-11-03 restores
      // as the view it described, not as an empty filter.
      filters: decodeFilterRuleSet(r.filters),
      sort: normalizeSort(r.sort ?? r),
    })
  }
  return out
}

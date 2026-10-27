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

import type { LibraryFilterState, LibrarySortKey } from './libraryFilters'

/** Longest accepted preset name (after whitespace normalization). */
export const PRESET_NAME_MAX = 40

/** Most presets a library may hold — a chip strip, not a filing cabinet. */
export const PRESET_MAX_COUNT = 30

/** The sort keys a preset may name. Anything else decodes to "no sort"
 *  (mirrors `libraryFilters`' keys; `libraryFilters` cannot be imported here at
 *  runtime because this module is loaded by Node-only store tests). */
const PRESET_SORT_KEYS: readonly LibrarySortKey[] = ['rating', 'loved', 'year', 'length', 'added']

/** The filter fields a preset stores — never the popup open/close flags. */
export interface PresetFilters {
  minRating: number
  maxRating: number
  lovedOnly: boolean
  genre: string
  fromYear: number | ''
  toYear: number | ''
  minLength: number | ''
  maxLength: number | ''
}

export interface FilterPreset {
  id: string
  name: string
  filters: PresetFilters
  sortBy: LibrarySortKey | null
  sortAsc: boolean
}

export type SavePresetResult =
  | { ok: true; presets: FilterPreset[] }
  | { ok: false; reason: 'empty-name' | 'limit' }

/** The part of the shared state a preset snapshots. */
export function filtersFromState(state: LibraryFilterState): PresetFilters {
  return {
    minRating: state.minRating,
    maxRating: state.maxRating,
    lovedOnly: state.lovedOnly,
    genre: state.genre,
    fromYear: state.fromYear,
    toYear: state.toYear,
    minLength: state.minLength,
    maxLength: state.maxLength,
  }
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
  const sortBy = state.sortBy
  const sortAsc = state.sortAsc

  const key = nameKey(name)
  const existing = presets.findIndex((p) => nameKey(p.name) === key)
  if (existing >= 0) {
    // Keep the STORED display name: retyping "focus" must not restyle an
    // existing "Focus" chip just because the save box was filled in lowercase.
    return {
      ok: true,
      presets: presets.map((p, i) =>
        i === existing ? { ...p, filters: filter, sortBy, sortAsc } : p,
      ),
    }
  }

  if (presets.length >= PRESET_MAX_COUNT) return { ok: false, reason: 'limit' }

  return { ok: true, presets: [...presets, { id, name, filters: filter, sortBy, sortAsc }] }
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
    sortBy: preset.sortBy,
    sortAsc: preset.sortAsc,
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

/** True when the live state already equals the preset (drives the chip highlight). */
export function presetIsActive(preset: FilterPreset, state: LibraryFilterState): boolean {
  if (state.sortBy !== preset.sortBy || state.sortAsc !== preset.sortAsc) return false
  const live = filtersFromState(state)
  const saved = preset.filters
  return (
    live.minRating === saved.minRating
    && live.maxRating === saved.maxRating
    && live.lovedOnly === saved.lovedOnly
    && live.genre === saved.genre
    && live.fromYear === saved.fromYear
    && live.toYear === saved.toYear
    && live.minLength === saved.minLength
    && live.maxLength === saved.maxLength
  )
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function numOrEmpty(v: unknown): number | '' {
  if (v === '') return ''
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : ''
}

function decodeFilters(raw: unknown): PresetFilters {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    minRating: clamp(num(f.minRating, 0), 0, 100),
    maxRating: clamp(num(f.maxRating, 100), 0, 100),
    lovedOnly: f.lovedOnly === true,
    genre: typeof f.genre === 'string' ? f.genre : '',
    fromYear: numOrEmpty(f.fromYear),
    toYear: numOrEmpty(f.toYear),
    minLength: numOrEmpty(f.minLength),
    maxLength: numOrEmpty(f.maxLength),
  }
}

/**
 * Validates a saved preset row from IndexedDB — the ONLY trust boundary for
 * this store. Malformed rows are dropped (not repaired into nonsense), a
 * duplicated name keeps its first occurrence, an unknown sort key becomes "no
 * sort", and the list is capped. A missing/old value yields `[]`.
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
    const sortBy =
      typeof r.sortBy === 'string' && (PRESET_SORT_KEYS as readonly string[]).includes(r.sortBy)
        ? (r.sortBy as LibrarySortKey)
        : null
    out.push({
      id,
      name,
      filters: decodeFilters(r.filters),
      sortBy,
      sortAsc: r.sortAsc !== false,
    })
  }
  return out
}

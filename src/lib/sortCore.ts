/**
 * The ONE sort model for the whole app (2026-11-01, two-tier sort plan).
 *
 * Before this module, "sort" was a scalar `{sortBy, sortAsc}` pair duplicated
 * in five comparators (SongsView's inline switch, `libraryFilters.applyFilterSort`,
 * `autoQueuePlan.buildOrderRank`, QueueView's editor, FilterSortBar's menu) and
 * three persistence decoders. Adding a second tier there would have rotted
 * immediately, so the model, the comparator, the labels, the legacy decode and
 * the random rules live HERE and every surface is a thin caller.
 *
 * Model:
 *  - a sort is a STACK of 0..2 tiers (`SORT_MAX_TIERS`), primary first;
 *  - `random` is a sort VALUE, not a separate mode. It is legal only as the
 *    primary (and therefore only) tier — a random order has nothing for a
 *    secondary key to break ties on;
 *  - a random order is SEEDED (`randomSeed`). Library lists re-derive on every
 *    store write, so an unseeded shuffle would reshuffle mid-scroll; the rank
 *    is a per-id hash, so it also survives relaunch and does not scramble the
 *    whole list when one track is added. `reRollRandom` gives a new order.
 *
 * DOM/Dexie-free by design: `appState`, `libraryFilters`, `queueManager` and
 * the views all import from here, and Node tests pin every rule.
 */

export type SortKey = 'rating' | 'loved' | 'year' | 'length' | 'added' | 'random'

export interface SortTier {
  key: SortKey
  asc: boolean
}

export interface SortState {
  /** Normalized: 0, 1 or 2 tiers, no duplicate keys, `random` alone-first. */
  tiers: SortTier[]
  /** Seed for the `random` tier's hash order. 0 = not yet chosen. */
  randomSeed: number
  /**
   * The tiers to return to when random is switched off. Written on the edge
   * INTO random (never on a re-entry), so turning shuffle on cannot lose the
   * sort that was in place before it — across sessions too, since it lives in
   * the same persisted object as the sort itself.
   */
  restore?: SortTier[]
}

/** The legacy scalar shape every persisted row/state used before 2026-11-01. */
export interface LegacySort {
  sortBy?: SortKey | null
  sortAsc?: boolean
  tiers?: unknown
  randomSeed?: unknown
  restore?: unknown
}

/** Anything a caller may hand us: a normalized state, a legacy pair, junk. */
export type SortInput = SortState | LegacySort | null | undefined

export const SORT_MAX_TIERS = 2

/** Every key the sort editor offers, in display order. */
export const SORT_KEYS: readonly SortKey[] = ['rating', 'loved', 'year', 'length', 'added', 'random']

/** Keys a SECONDARY tier may use — random is primary-only by construction. */
export const SORT_TIER_KEYS: readonly SortKey[] = ['rating', 'loved', 'year', 'length', 'added']

export const sortLabels: Record<SortKey, string> = {
  rating: 'Rating',
  loved: 'Loved',
  year: 'Year',
  length: 'Length',
  added: 'Added',
  random: 'Random',
}

/** No sort at all (library order). A fresh object per call, never shared. */
export const EMPTY_SORT: SortState = { tiers: [], randomSeed: 0 }

/**
 * Default direction for a freshly picked key: rating/loved/added read
 * best-first (descending), year/length read naturally ascending. Random has
 * no direction (the field is kept for shape uniformity and ignored).
 */
export function defaultDirection(key: SortKey): boolean {
  return key === 'length' || key === 'year' || key === 'random'
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isSortKey(v: unknown): v is SortKey {
  return typeof v === 'string' && (SORT_KEYS as readonly string[]).includes(v)
}

/**
 * Seed for a new random order. Injectable-free (Math.random) because only the
 * VALUE matters; every consumer reads it back through `normalizeSort`.
 */
export function newSeed(): number {
  return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1
}

function decodeTiers(raw: unknown): SortTier[] {
  if (!Array.isArray(raw)) return []
  const out: SortTier[] = []
  const seen = new Set<SortKey>()
  for (const row of raw) {
    if (!isRecord(row)) continue
    const key = row.key
    if (!isSortKey(key) || seen.has(key)) continue
    seen.add(key)
    out.push({
      key,
      asc: typeof row.asc === 'boolean' ? row.asc : defaultDirection(key),
    })
    if (key === 'random' || out.length >= SORT_MAX_TIERS) break
  }
  // Random is legal ONLY as the sole, first tier: nothing breaks its ties.
  if (out.some((t) => t.key === 'random')) return [{ key: 'random', asc: true }]
  return out
}

/**
 * The single decoder + rule enforcer. Accepts a normalized state, the legacy
 * `{sortBy, sortAsc}` pair (a persisted row from before 2026-11-01), or junk,
 * and always answers a valid state. Pure and deterministic (a missing seed
 * stays 0 — picking random assigns one).
 */
export function normalizeSort(raw: unknown): SortState {
  const r = isRecord(raw) ? raw : {}
  let tiers = decodeTiers(r.tiers)
  if (tiers.length === 0 && 'sortBy' in r) {
    const key = r.sortBy
    if (isSortKey(key)) {
      tiers = decodeTiers([{ key, asc: typeof r.sortAsc === 'boolean' ? r.sortAsc : defaultDirection(key) }])
    }
  }
  const seeded =
    typeof r.randomSeed === 'number' && Number.isFinite(r.randomSeed) && r.randomSeed >= 0
      ? Math.floor(r.randomSeed)
      : 0
  const restore = decodeTiers(r.restore).filter((t) => t.key !== 'random')
  const next: SortState = { tiers, randomSeed: seeded }
  if (restore.length > 0) next.restore = restore
  return next
}

/** True when the stack orders by random. */
export function isRandomSort(sort: SortInput): boolean {
  const s = normalizeSort(sort)
  return s.tiers[0]?.key === 'random'
}

/**
 * Change-detection signature. The SEED is deliberately excluded: re-rolling a
 * library random order must not count as an auto-queue rule change (the queue
 * samples its own pool and has no seed).
 */
export function sortSignature(sort: SortInput): string {
  const s = normalizeSort(sort)
  if (s.tiers.length === 0) return ''
  return s.tiers
    .map((t) => (t.key === 'random' ? 'random' : `${t.key}${t.asc ? '+' : '-'}`))
    .join('|')
}

const ARROW = { asc: '↑', desc: '↓' } as const

/** Human label for the pill / summary lines — the ONE source of that text. */
export function describeSort(sort: SortInput): string {
  const s = normalizeSort(sort)
  if (s.tiers.length === 0) return ''
  return s.tiers
    .map((t) => (t.key === 'random' ? sortLabels.random : `${sortLabels[t.key]} ${t.asc ? ARROW.asc : ARROW.desc}`))
    .join(' · ')
}

/** Label for one tier's chip ('Rating ↑'). */
export function tierLabel(tier: SortTier): string {
  if (tier.key === 'random') return sortLabels.random
  return `${sortLabels[tier.key]} ${tier.asc ? ARROW.asc : ARROW.desc}`
}

export type SortSlot = 0 | 1

/**
 * Pick / flip / clear for the sort editor (2026-11-01).
 *
 *  - `key === null` removes that tier. Clearing random falls back to the
 *    remembered `restore` stack (the "shuffle off returns to what it was"
 *    contract); clearing a plain tier shifts the secondary up.
 *  - picking `random` collapses the stack to random alone and remembers the
 *    previous tiers in `restore`;
 *  - picking the key already at that slot FLIPS its direction;
 *  - picking a key that lives in the other slot MOVES it here.
 */
export function setTier(sort: SortInput, slot: SortSlot, key: SortKey | null): SortState {
  const s = normalizeSort(sort)
  const tiers = s.tiers.map((t) => ({ ...t }))
  if (key === null) {
    if (tiers.length === 0) return s
    tiers.splice(Math.min(slot, tiers.length - 1), 1)
    if (tiers.length === 0 && s.restore?.length) return { ...s, tiers: s.restore.map((t) => ({ ...t })) }
    return { ...s, tiers }
  }

  if (key === 'random') {
    if (isRandomSort(s)) return s
    return {
      tiers: [{ key: 'random', asc: true }],
      randomSeed: s.randomSeed || newSeed(),
      restore: tiers.length > 0 ? tiers : (s.restore ?? []).map((t) => ({ ...t })),
    }
  }

  // Random -> a real key is an explicit pick: it wins over the memory.
  const existing = tiers.findIndex((t) => t.key === key)
  // Tapping the chip AT this slot flips it. `at` clamps to the last EXISTING
  // tier, so picking at slot 1 on a one-tier stack still addresses the key
  // already there (a duplicate can never be created).
  const at = Math.min(slot, Math.max(0, tiers.length - 1))
  if (existing >= 0 && existing === at) {
    tiers[existing] = { ...tiers[existing], asc: !tiers[existing].asc }
    return { ...s, tiers }
  }
  // Placing a real key always drops a random tier: random is primary-only and
  // can never sit under another key.
  const without = tiers.filter((t) => t.key !== key && t.key !== 'random')
  const placed: SortTier = { key, asc: defaultDirection(key) }
  // INSERTION clamps to the array LENGTH: a second pick appends at slot 1
  // instead of overwriting the primary.
  without.splice(Math.min(slot, without.length), 0, placed)
  return { ...s, tiers: without.slice(0, SORT_MAX_TIERS) }
}

/** Clears both tiers (the "Clear sort" action). */
export function clearSort(sort: SortInput): SortState {
  const s = normalizeSort(sort)
  return { tiers: [], randomSeed: s.randomSeed }
}

/**
 * The shuffle button's ONE write (2026-11-01): shuffle IS "sort = random".
 * Turning it on remembers the current tiers; turning it on again is a no-op
 * (never overwrites that memory); turning it off returns to the memory, or to
 * no sort when there is none. One object in, one object out — one store write,
 * one subscriber fire.
 */
export function planRandomToggle(sort: SortInput, on: boolean): SortState {
  const s = normalizeSort(sort)
  const random = isRandomSort(s)
  if (on) {
    if (random) return s
    return {
      tiers: [{ key: 'random', asc: true }],
      randomSeed: s.randomSeed || newSeed(),
      restore: s.tiers.length > 0 ? s.tiers.map((t) => ({ ...t })) : (s.restore ?? []).map((t) => ({ ...t })),
    }
  }
  if (!random) return s
  return {
    tiers: (s.restore ?? []).map((t) => ({ ...t })),
    randomSeed: s.randomSeed,
    ...(s.restore ? { restore: s.restore.map((t) => ({ ...t })) } : {}),
  }
}

/** A NEW random order (the "New random order" action). No-op off random. */
export function reRollRandom(sort: SortInput, seed: number = newSeed()): SortState {
  const s = normalizeSort(sort)
  if (!isRandomSort(s)) return s
  return { ...s, randomSeed: seed }
}

export type SortChangeKind = 'none' | 'random' | 'rule'

/**
 * What a sort edit MEANS for the auto queue (2026-11-01):
 *  - `none`: nothing ordering-relevant changed (a seed re-roll, a subscribe
 *    fire) — do nothing;
 *  - `random`: the edit crossed the random boundary (shuffle on/off). It
 *    reorders the same rule set, so the queue REBUILDS without resetting the
 *    anti-repeat window (the documented shuffle-toggle semantics, D6a);
 *  - `rule`: any other tier/direction change — a FRESH CONTEXT (D7): promote
 *    the audible row, reset the window, rebuild.
 */
export function classifySortChange(prev: SortInput, next: SortInput): SortChangeKind {
  if (sortSignature(prev) === sortSignature(next)) return 'none'
  return isRandomSort(prev) !== isRandomSort(next) ? 'random' : 'rule'
}

/** FNV-1a over the id, seed-mixed and avalanche-finished. Pure. */
export function hash32(seed: number, str: string): number {
  let h = (2166136261 ^ (seed | 0)) >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  h ^= h >>> 15
  h = Math.imul(h, 2246822507) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 3266489909) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

/**
 * Deterministic per-id rank: the same (seed, id) always lands in the same
 * place, and a different seed is a different permutation. Stable across
 * renders, navigation and relaunch; adding one track leaves the others' order
 * untouched (unlike a whole-list Fisher–Yates).
 */
export function randomRank(seed: number, ids: Iterable<string>): Map<string, number> {
  const out = new Map<string, number>()
  for (const id of ids) {
    if (out.has(id)) continue
    out.set(id, hash32(seed, id))
  }
  return out
}

/** Structural row shape the track comparator understands (no store import). */
export interface SortableTrack {
  trackId: string
  year?: number | null
  duration: number
  createdAt?: number
}

export interface TrackSortContext {
  ratingOf: (trackId: string) => number
  lovedOf: (trackId: string) => boolean
}

/**
 * The track key comparator used by BOTH the Songs list and the auto-queue
 * rank map. `random` is never asked for here — the random order is a rank map,
 * resolved in `sortWithTiers` before any key comparison runs.
 */
export function trackSortCmp(
  key: SortKey,
  a: SortableTrack,
  b: SortableTrack,
  ctx: TrackSortContext,
): number {
  switch (key) {
    case 'rating':
      return ctx.ratingOf(a.trackId) - ctx.ratingOf(b.trackId)
    case 'loved':
      return Number(ctx.lovedOf(a.trackId)) - Number(ctx.lovedOf(b.trackId))
    case 'year':
      return (a.year ?? 0) - (b.year ?? 0)
    case 'length':
      return a.duration - b.duration
    case 'added':
      return (a.createdAt ?? 0) - (b.createdAt ?? 0)
    default:
      return 0
  }
}

export interface TierSortOptions<T> {
  sort: SortInput
  /** Key comparator. Only non-random keys are ever passed. */
  cmp: (key: SortKey, a: T, b: T) => number
  /** Stable identity for the seeded random order. */
  idOf: (row: T) => string
  /**
   * `natural` (lists): ties keep their incoming order — a two-tier sort falls
   * back to the library order, never to a reversed one.
   * `mirror` (the auto-queue rank): ties mirror the last tier's arrow, so a
   * fully-tied library still answers a direction flip (QUEUE-INVARIANTS E6).
   */
  tie?: 'natural' | 'mirror'
}

/** The ONE two-tier comparator entry point. Never mutates its input. */
export function sortWithTiers<T>(rows: readonly T[], opts: TierSortOptions<T>): T[] {
  const sort = normalizeSort(opts.sort)
  if (sort.tiers.length === 0) return [...rows]
  const decorated = rows.map((row, index) => ({ row, index }))
  const rank = isRandomSort(sort) ? randomRank(sort.randomSeed, rows.map(opts.idOf)) : null
  const last = sort.tiers[sort.tiers.length - 1]
  const mirror = (opts.tie ?? 'natural') === 'mirror'
  decorated.sort((a, b) => {
    if (rank) {
      const d = (rank.get(opts.idOf(a.row)) ?? 0) - (rank.get(opts.idOf(b.row)) ?? 0)
      return d !== 0 ? d : a.index - b.index
    }
    for (const tier of sort.tiers) {
      const c = opts.cmp(tier.key, a.row, b.row)
      if (c !== 0) return tier.asc ? c : -c
    }
    if (!mirror) return a.index - b.index
    return last.asc ? a.index - b.index : b.index - a.index
  })
  return decorated.map((d) => d.row)
}

/**
 * Convenience builder for tests and callers that hold no state: an explicit
 * (primary, secondary) pair run through the same rules.
 */
export function sortOf(
  primary?: SortKey | null,
  primaryAsc?: boolean,
  secondary?: SortKey | null,
  secondaryAsc?: boolean,
): SortState {
  const tiers: SortTier[] = []
  if (primary) tiers.push({ key: primary, asc: primaryAsc ?? defaultDirection(primary) })
  if (secondary && secondary !== primary) {
    tiers.push({ key: secondary, asc: secondaryAsc ?? defaultDirection(secondary) })
  }
  return normalizeSort({ tiers, randomSeed: 0 })
}

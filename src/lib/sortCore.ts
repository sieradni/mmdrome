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
 *  - `random` is a sort VALUE, not a separate mode, and it means the same
 *    thing in either slot: "this level is a shuffle". As the PRIMARY it is the
 *    whole order, so it stands ALONE (a secondary could never break a random
 *    order's ties). As the SECONDARY it is the tie-break — every group the
 *    primary ties on is scrambled by the same seeded hash, which is how "same
 *    year → shuffle that level" works;
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
  /** Normalized: 0, 1 or 2 tiers, no duplicate keys, `random` alone when first. */
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

/**
 * Keys a SECONDARY tier may use. Random belongs here: as a secondary it is the
 * seeded TIE-BREAK (each group the primary ties on is scrambled) — a real
 * order, unlike a random primary, which leaves no ties to break. It is derived
 * from `SORT_KEYS` on purpose: every key is legal in both rows, and keeping one
 * list means a new key cannot appear in one editor and be missing from the
 * other (an EMPTY difference is the invariant, not an oversight).
 */
export const SORT_TIER_KEYS: readonly SortKey[] = SORT_KEYS

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
    if (out.length >= SORT_MAX_TIERS) break
  }
  // A random PRIMARY is the whole order, so it stands alone — a secondary could
  // never break a random order's ties. A random SECONDARY is legal and is the
  // seeded tie-break for the primary.
  if (out[0]?.key === 'random') return [{ key: 'random', asc: true }]
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
 *  - picking `random` as the PRIMARY collapses the stack to random alone and
 *    remembers the previous tiers in `restore`; picking it as the SECONDARY
 *    keeps the primary and makes random its tie-break (a seed is assigned if
 *    it had none, and a random tie-break SURVIVES a new primary pick);
 *  - picking the key already at that slot FLIPS its direction (random has none
 *    to flip);
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

  // Tapping the chip AT this slot flips its direction. `at` clamps to the last
  // EXISTING tier, so picking at slot 1 on a one-tier stack still addresses the
  // key already there (a duplicate can never be created). Random has no
  // direction, so re-tapping it is a no-op.
  const at = Math.min(slot, Math.max(0, tiers.length - 1))
  if (tiers[at]?.key === key) {
    if (key === 'random') return s
    return { ...s, tiers: tiers.map((t, i) => (i === at ? { ...t, asc: !t.asc } : t)) }
  }

  // PRIMARY random IS shuffle: the whole order, so it collapses the stack
  // (nothing can break its ties) and remembers what it replaced.
  if (key === 'random' && slot === 0) {
    if (isRandomSort(s)) return s
    return {
      tiers: [{ key: 'random', asc: true }],
      randomSeed: s.randomSeed || newSeed(),
      restore: randomlessRestore(tiers, s.restore),
    }
  }

  // SECONDARY random is the tie-break: the primary keeps the order and every
  // group it ties on is scrambled by the seeded hash.
  if (key === 'random') {
    const primary = tiers[0]
    if (!primary) {
      return { tiers: [{ key: 'random', asc: true }], randomSeed: s.randomSeed || newSeed(), ...restoreOf(s) }
    }
    return { tiers: [primary, { key: 'random', asc: true }], randomSeed: s.randomSeed || newSeed(), ...restoreOf(s) }
  }

  // A real key is an explicit pick, so it wins over a random PRIMARY.
  const placed: SortTier = { key, asc: defaultDirection(key) }
  const primary = tiers[0]

  if (slot === 0) {
    if (primary?.key === key) return { ...s, tiers: tiers.map((t, i) => (i === 0 ? placed : t)) }
    // MOVE the secondary up (a random secondary included: random can never sit
    // above another key).
    if (tiers[1]?.key === key) return { ...s, tiers: [placed, { ...tiers[0] }] }
    // A new primary KEEPS a random tie-break — the user picked that scramble
    // deliberately, and replacing the key above it does not unmake it.
    const keepRandom = tiers[1]?.key === 'random'
    return { ...s, tiers: keepRandom ? [placed, { key: 'random', asc: true }] : [placed] }
  }

  // Slot 1. Random primary + a real key = replace random (an explicit pick
  // beats shuffle); otherwise the pick becomes the secondary.
  if (!primary || primary.key === 'random') return { ...s, tiers: [placed] }
  // MOVE the primary DOWN into the slot you picked: the picked key takes slot 1
  // and the old secondary shifts up (the documented swap — never a duplicate).
  if (primary.key === key) {
    const other = tiers[1]
    return { ...s, tiers: other ? [{ ...other }, placed] : [placed] }
  }
  return { ...s, tiers: [primary, placed] }
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
    // The memory is the REAL stack: a restore carrying a random secondary would
    // be a stack the toggle cannot produce, so random never enters it.
    return {
      tiers: [{ key: 'random', asc: true }],
      randomSeed: s.randomSeed || newSeed(),
      restore: randomlessRestore(s.tiers, s.restore),
    }
  }
  if (!random) return s
  return {
    tiers: (s.restore ?? []).map((t) => ({ ...t })),
    randomSeed: s.randomSeed,
    ...(s.restore ? { restore: s.restore.map((t) => ({ ...t })) } : {}),
  }
}

/**
 * A NEW random order (the "New random order" action). Applies to a random tier
 * in EITHER slot — re-sampling a secondary scramble is a real order change too
 * — and is a no-op when no tier is random.
 */
export function reRollRandom(sort: SortInput, seed: number = newSeed()): SortState {
  const s = normalizeSort(sort)
  if (!s.tiers.some((t) => t.key === 'random')) return s
  return { ...s, randomSeed: seed }
}

/**
 * The stack remembered as "what random replaced": the current tiers minus any
 * random one, or the previous memory when there is nothing to remember. A
 * `restore` containing random would be unreachable — turning shuffle off
 * cannot produce a random secondary — so random never enters the memory.
 */
function randomlessRestore(tiers: readonly SortTier[], previous?: readonly SortTier[]): SortTier[] {
  const fromTiers = tiers.filter((t) => t.key !== 'random').map((t) => ({ ...t }))
  if (fromTiers.length > 0) return fromTiers
  return (previous ?? []).filter((t) => t.key !== 'random').map((t) => ({ ...t }))
}

/** Carries an existing `restore` memory through an edit that does not own it. */
function restoreOf(s: SortState): { restore?: SortTier[] } {
  return s.restore ? { restore: s.restore.map((t) => ({ ...t })) } : {}
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
  // One seeded rank map serves a random tier in EITHER slot: as the primary it
  // IS the order, as the secondary it breaks the primary's ties (the same rank,
  // read only once the tiers above it compare equal).
  const rank = sort.tiers.some((t) => t.key === 'random') ? randomRank(sort.randomSeed, rows.map(opts.idOf)) : null
  const last = sort.tiers[sort.tiers.length - 1]
  const mirror = (opts.tie ?? 'natural') === 'mirror'
  decorated.sort((a, b) => {
    for (const tier of sort.tiers) {
      const c =
        tier.key === 'random'
          ? (rank?.get(opts.idOf(a.row)) ?? 0) - (rank?.get(opts.idOf(b.row)) ?? 0)
          : opts.cmp(tier.key, a.row, b.row)
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

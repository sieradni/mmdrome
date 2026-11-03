/**
 * The ONE filter model for the library views and the auto queue (2026-11-03).
 *
 * Before this module, "filter" was a fixed bag of scalar fields (`genre`,
 * `fromYear`/`toYear`, `minLength`/`maxLength`) duplicated in four predicates
 * (SongsView, `libraryFilters.applyFilterSort`, `autoQueuePlan.matchesAutoQueueFilters`,
 * and the two dialogs' markup). Adding a field meant touching all of them, and
 * every field had exactly one editor shape. That is what this module replaces:
 *
 *  - a filter is a RULE SET — the always-visible rating range + loved switch,
 *    plus a list of CLAUSES ANDed together;
 *  - a clause is typed by its field: `range` (dual-handle slider bounds, either
 *    side may be open), `boolean`, or `text` (fuzzy, with `"quotes"` = exact);
 *  - the field registry below is the single place a new filterable field is
 *    described, so the Add-filter picker, the clause editor, the track
 *    predicate and the album/artist group predicate can never disagree;
 *  - decoding is the trust boundary for localStorage, Dexie and preset rows,
 *    including the LEGACY scalar fields (a row written before 2026-11-03 turns
 *    into the equivalent clauses so no saved view is lost).
 *
 * DOM/Dexie-free by design: `appState`, `libraryFilters`, `filterPresets`,
 * `autoQueuePlan`, the views and the components all import from here, and Node
 * tests pin every rule.
 */

import { normalizeForSearch } from './matchNormalize'
import type { Track } from '../stores/appState'

// ── Fields ────────────────────────────────────────────────────────────

export type RangeFilterField = 'rating' | 'year' | 'length' | 'added'
export type BooleanFilterField = 'loved'
export type TextFilterField = 'title' | 'artist' | 'album' | 'albumArtist' | 'composer' | 'genre'
export type FilterFieldKey = RangeFilterField | BooleanFilterField | TextFilterField
export type FilterFieldKind = 'range' | 'boolean' | 'text'

export interface FilterFieldSpec {
  key: FilterFieldKey
  label: string
  kind: FilterFieldKind
  /** Short type description shown in the Add-filter picker. */
  hint: string
  /** Placeholder used by the text clause editor. */
  example?: string
}

/**
 * Every filterable field, in Add-filter display order. `rating` and `loved`
 * are here for completeness (they are legal clauses and a saved row may carry
 * them) but they are NOT in `ADDABLE_FILTER_FIELDS`: the editor always shows
 * them at the top, so offering them again in the picker would create a second
 * control for one value.
 */
export const FILTER_FIELD_SPECS: Record<FilterFieldKey, FilterFieldSpec> = {
  genre: { key: 'genre', label: 'Genre', kind: 'text', hint: 'Fuzzy text', example: 'indie' },
  artist: { key: 'artist', label: 'Artist', kind: 'text', hint: 'Fuzzy text', example: 'beatles' },
  album: { key: 'album', label: 'Album', kind: 'text', hint: 'Fuzzy text', example: 'abbey' },
  title: { key: 'title', label: 'Title', kind: 'text', hint: 'Fuzzy text', example: 'hey jude' },
  albumArtist: { key: 'albumArtist', label: 'Album artist', kind: 'text', hint: 'Fuzzy text', example: 'various' },
  composer: { key: 'composer', label: 'Composer', kind: 'text', hint: 'Fuzzy text', example: 'lennon' },
  year: { key: 'year', label: 'Year', kind: 'range', hint: 'Range' },
  length: { key: 'length', label: 'Length', kind: 'range', hint: 'Range' },
  added: { key: 'added', label: 'Date added', kind: 'range', hint: 'Date range' },
  rating: { key: 'rating', label: 'Rating', kind: 'range', hint: 'Range' },
  loved: { key: 'loved', label: 'Loved', kind: 'boolean', hint: 'On / off' },
}

/** Fields offered by the Add-filter picker (rating and loved are permanent). */
export const ADDABLE_FILTER_FIELDS: readonly FilterFieldKey[] = [
  'genre',
  'artist',
  'album',
  'title',
  'albumArtist',
  'composer',
  'year',
  'length',
  'added',
]

export const MAX_FILTER_CLAUSES = 12

export const RATING_MIN = 0
export const RATING_MAX = 100
export const RATING_STEP = 10

export const DAY_MS = 86_400_000

// ── Range domains ─────────────────────────────────────────────────────

export interface RangeDomain {
  min: number
  max: number
  step: number
}

export interface RangeDomainContext {
  /** "Now" for the date-added domain; injectable for tests. */
  now?: number
  /** Earliest / latest `createdAt` in the library (both optional). */
  addedMin?: number
  addedMax?: number
}

/**
 * The slider's FULL domain for a field — "the maximum possible", not the range
 * of the current result set. Rating and year/length are fixed; date-added is
 * anchored to the library's real dates (a 1970-to-today slider would make both
 * handles impossible to place), widened to include today so a brand-new track
 * is always reachable.
 */
export function rangeDomain(field: RangeFilterField, ctx: RangeDomainContext = {}): RangeDomain {
  switch (field) {
    case 'rating':
      return { min: RATING_MIN, max: RATING_MAX, step: RATING_STEP }
    case 'year':
      return { min: 1900, max: 2100, step: 1 }
    case 'length':
      // 6 hours — longer than any normal track, so nothing is unfilterable.
      return { min: 0, max: 21600, step: 5 }
    case 'added': {
      const now = ctx.now ?? Date.now()
      let lo = ctx.addedMin ?? now - 5 * 365 * DAY_MS
      let hi = Math.max(ctx.addedMax ?? now, now)
      if (!Number.isFinite(lo) || lo <= 0) lo = now - 5 * 365 * DAY_MS
      lo = Math.floor(lo / DAY_MS) * DAY_MS
      hi = Math.ceil(hi / DAY_MS) * DAY_MS
      if (hi <= lo) hi = lo + DAY_MS
      return { min: lo, max: hi, step: DAY_MS }
    }
  }
}

/** Earliest/latest `createdAt` in a library (0 when nothing is dated). */
export function addedBoundsOf(tracks: readonly Track[]): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY
  let max = 0
  for (const t of tracks) {
    const v = t.createdAt ?? 0
    if (!(v > 0)) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!Number.isFinite(min) || max <= 0) return { min: 0, max: 0 }
  return { min, max }
}

/** `1:05:03` / `4:12` — the length display used by the legend and inputs. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

/** `2024-02-15` in UTC — stable across locales (a filter value, not prose). */
export function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function formatRangeValue(field: RangeFilterField, v: number): string {
  switch (field) {
    case 'length':
      return formatDuration(v)
    case 'added':
      return formatDate(v)
    case 'year':
      return String(Math.round(v))
    case 'rating':
      return String(Math.round(v))
  }
}

// ── Clauses ───────────────────────────────────────────────────────────

export interface RangeFilterClause {
  id: string
  kind: 'range'
  field: RangeFilterField
  /** Open (unbounded) side is `null` — the slider's full domain means "any". */
  min: number | null
  max: number | null
}

export interface BooleanFilterClause {
  id: string
  kind: 'boolean'
  field: BooleanFilterField
  value: boolean
}

export interface TextFilterClause {
  id: string
  kind: 'text'
  field: TextFilterField
  query: string
}

export type FilterClause = RangeFilterClause | BooleanFilterClause | TextFilterClause

export interface FilterRuleSet {
  /** The permanently visible rating range (0–100). */
  minRating: number
  maxRating: number
  /** The permanently visible loved switch. */
  lovedOnly: boolean
  /** Additional clauses, ALL of them must match (elemental AND). */
  clauses: FilterClause[]
}

/** A fresh, valid empty rule set (never a shared object). */
export function emptyFilterRuleSet(): FilterRuleSet {
  return { minRating: RATING_MIN, maxRating: RATING_MAX, lovedOnly: false, clauses: [] }
}

/** A deep-enough copy: clauses are plain data, arrays are replaced on edit. */
export function cloneFilterRuleSet(rules: FilterRuleSet): FilterRuleSet {
  return {
    minRating: rules.minRating,
    maxRating: rules.maxRating,
    lovedOnly: rules.lovedOnly,
    clauses: rules.clauses.map((c) => ({ ...c })),
  }
}

/** True when the rule set narrows anything (drives the pill's active dot). */
export function filterRuleSetActive(rules: Pick<FilterRuleSet, 'minRating' | 'maxRating' | 'lovedOnly' | 'clauses'>): boolean {
  return (
    rules.minRating > RATING_MIN ||
    rules.maxRating < RATING_MAX ||
    rules.lovedOnly ||
    rules.clauses.length > 0
  )
}

/**
 * Canonical identity of a rule set. Clause ORDER is ignored (the clauses are
 * ANDed, so `[genre, year]` and `[year, genre]` are the same filter) — the
 * apply-to-queue diff and the preset active-mark must not flip on a reorder.
 */
export function filterRuleSetSignature(rules: Pick<FilterRuleSet, 'minRating' | 'maxRating' | 'lovedOnly' | 'clauses'>): string {
  // Each clause is its own JSON tuple before sorting, so a query containing
  // JSON-ish punctuation (`"`, `,`, `:`) cannot make two different filters
  // share a signature.
  const clauses = rules.clauses
    .map((c) =>
      JSON.stringify(
        c.kind === 'range'
          ? ['range', c.field, c.min, c.max]
          : c.kind === 'text'
            ? ['text', c.field, c.query]
            : ['boolean', c.field, c.value],
      ),
    )
    .sort()
  return JSON.stringify([rules.minRating, rules.maxRating, rules.lovedOnly, clauses])
}

export function filterRuleSetsEqual(a: FilterRuleSet, b: FilterRuleSet): boolean {
  return filterRuleSetSignature(a) === filterRuleSetSignature(b)
}

// ── Text matching (fuzzy, quotes = exact) ─────────────────────────────

export interface FilterTextToken {
  /** Folded (normalizeForSearch) token text. */
  text: string
  /** True when the user wrapped it in `"…"` — literal substring, no fuzz. */
  exact: boolean
}

const QUERY_TOKEN_RE = /"([^"]*)"|(\S+)/g

/**
 * Splits a field query into folded tokens. `"quoted spans"` are ONE exact
 * token (a phrase, matched verbatim); bare runs are fuzzy tokens. Tokens that
 * fold to nothing (`!!!`) are dropped — `.includes('')` would match everything.
 *
 * MEMOIZED by query text: a filter pass asks the same clause once per track,
 * and the interactive path re-runs on every keystroke. The returned array is
 * shared — callers must never mutate it (every caller here only reads).
 */
export function parseFilterText(query: string): FilterTextToken[] {
  const key = query ?? ''
  const cached = parseFilterTextCache.get(key)
  if (cached) return cached
  const tokens: FilterTextToken[] = []
  for (const m of key.matchAll(QUERY_TOKEN_RE)) {
    const exact = m[1] !== undefined
    const norm = normalizeForSearch(m[1] ?? m[2] ?? '')
    if (norm) tokens.push({ text: norm, exact })
  }
  // Transient typing produces many short-lived queries; bound the cache so a
  // long editing session cannot hold every prefix forever.
  if (parseFilterTextCache.size >= 64) parseFilterTextCache.clear()
  parseFilterTextCache.set(key, tokens)
  return tokens
}

const parseFilterTextCache = new Map<string, FilterTextToken[]>()

/** Edit distance ≤ 1 (insert/delete/substitute) — a typo, not a different word. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  let i = 0
  let j = 0
  let edits = 0
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++
      j++
      continue
    }
    if (++edits > 1) return false
    if (short.length === long.length) {
      i++
      j++
    } else {
      j++
    }
  }
  return edits + (long.length - j) + (short.length - i) <= 1
}

/** Does `needle` appear in `hay` as an in-order subsequence within `maxSpan` chars? */
function subsequenceWithin(hay: string, needle: string, maxSpan: number): boolean {
  if (!needle) return true
  for (let start = 0; start < hay.length; start++) {
    if (hay[start] !== needle[0]) continue
    let i = start + 1
    let matched = 1
    while (i < hay.length && matched < needle.length) {
      if (hay[i] === needle[matched]) matched++
      i++
    }
    if (matched === needle.length && i - start <= maxSpan) return true
  }
  return false
}

/**
 * ONE folded field against ONE token. Exact tokens are plain substring hits;
 * fuzzy tokens also accept a per-word typo (≥4 chars, edit distance 1) and an
 * in-order subsequence with a bounded span (≥3 chars — this is what makes
 * "inro" find "Indie Rock" and gives acronym-style hits). CJK tokens are short
 * by nature, so the exact substring path carries them unchanged.
 */
export function filterTokenMatches(foldedField: string, token: FilterTextToken): boolean {
  const t = token.text
  if (!t) return true
  const field = foldedField ?? ''
  if (!field) return false
  if (field.includes(t)) return true
  if (token.exact) return false
  const words = field.split(/\s+/).filter(Boolean)
  // Initials work for even a two-letter token ("ir" → Indie Rock) and are
  // cheap + unambiguous; the looser subsequence only applies from 3 chars.
  if (t.length >= 2) {
    const initials = words.map((w) => w[0] ?? '').join('')
    if (initials.includes(t)) return true
  }
  if (t.length >= 4) {
    for (const w of words) if (w.length >= 3 && withinOneEdit(w, t)) return true
  } else if (t.length === 3) {
    // Short token typos are too permissive across words; only the whole field.
    if (withinOneEdit(field, t)) return true
  }
  if (t.length >= 3 && subsequenceWithin(field, t, t.length * 3)) return true
  return false
}

/**
 * AND across tokens, OR inside one field value. Empty queries match
 * everything. Tokens are pre-parsed by `parseFilterText` (one parse per
 * clause per filter pass, not per track).
 */
export function filterTextMatches(foldedField: string, tokens: readonly FilterTextToken[]): boolean {
  if (tokens.length === 0) return true
  return tokens.every((t) => filterTokenMatches(foldedField, t))
}

/** Convenience for UI suggestions: does one raw field value match a query? */
export function textValueMatches(query: string, value: string): boolean {
  return filterTextMatches(normalizeForSearch(value ?? ''), parseFilterText(query))
}

// ── Track predicate ───────────────────────────────────────────────────

export interface TrackFilterContext {
  ratingOf: (trackId: string) => number
  lovedOf: (trackId: string) => boolean
}

/** Raw text value of a text field — context-free by construction. */
function rawTextField(track: Track, field: TextFilterField): string {
  switch (field) {
    case 'title':
      return track.title ?? ''
    case 'artist':
      return track.artist ?? ''
    case 'album':
      return track.album ?? ''
    case 'albumArtist':
      return track.albumArtist ?? ''
    case 'composer':
      return track.composer ?? ''
    case 'genre':
      return track.genre ?? ''
  }
}

/**
 * Folded text fields memoized per track OBJECT (WeakMap — a library reload
 * produces new objects and the old entries collect with them). Without this,
 * every keystroke re-folded each text field of every candidate track for every
 * text clause; with it, folding happens once per track per field. Safe because
 * Track objects are treated as immutable by the stores.
 */
const foldedTextFieldCache = new WeakMap<Track, Partial<Record<TextFilterField, string>>>()

function foldedTextField(track: Track, field: TextFilterField): string {
  let row = foldedTextFieldCache.get(track)
  if (!row) {
    row = {}
    foldedTextFieldCache.set(track, row)
  }
  let folded = row[field]
  if (folded === undefined) {
    folded = normalizeForSearch(rawTextField(track, field))
    row[field] = folded
  }
  return folded
}

function trackFieldValue(track: Track, field: FilterFieldKey, ctx: TrackFilterContext): string | number | boolean | null {
  switch (field) {
    case 'title':
    case 'artist':
    case 'album':
    case 'albumArtist':
    case 'composer':
    case 'genre':
      return rawTextField(track, field)
    case 'rating':
      return ctx.ratingOf(track.trackId)
    case 'loved':
      return ctx.lovedOf(track.trackId)
    case 'year':
      return track.year ?? null
    case 'length':
      return track.duration
    case 'added':
      return track.createdAt ?? null
  }
}

/**
 * A range bound. Both open = pass everything (this is what makes a freshly
 * added slider a no-op). A track whose value is MISSING (no year, no
 * `createdAt`) fails as soon as EITHER side is set — the documented behavior
 * from the old fromYear/toYear fields, kept because "unknown year" cannot
 * honestly satisfy a year range.
 */
export function rangeValueMatches(value: number | null | undefined, min: number | null, max: number | null): boolean {
  if (min === null && max === null) return true
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return false
  const v = Number(value)
  if (min !== null && v < min) return false
  if (max !== null && v > max) return false
  return true
}

function clauseMatchesTrack(
  track: Track,
  clause: FilterClause,
  ctx: TrackFilterContext,
  tokens: readonly FilterTextToken[] | null,
): boolean {
  if (clause.kind === 'range') {
    const v = trackFieldValue(track, clause.field, ctx)
    return rangeValueMatches(typeof v === 'number' ? v : v === null ? null : Number(v), clause.min, clause.max)
  }
  if (clause.kind === 'boolean') {
    return ctx.lovedOf(track.trackId) === clause.value
  }
  return filterTextMatches(foldedTextField(track, clause.field), tokens ?? [])
}

/** ALL clauses must match (the elemental AND). */
export function matchesFilterClauses(track: Track, clauses: readonly FilterClause[], ctx: TrackFilterContext): boolean {
  for (const clause of clauses) {
    const tokens = clause.kind === 'text' ? parseFilterText(clause.query) : null
    if (!clauseMatchesTrack(track, clause, ctx, tokens)) return false
  }
  return true
}

/** The full rule set: rating range, loved switch, then every clause. */
export function matchesFilterRuleSet(
  track: Track,
  rules: Pick<FilterRuleSet, 'minRating' | 'maxRating' | 'lovedOnly' | 'clauses'>,
  ctx: TrackFilterContext,
): boolean {
  const rating = ctx.ratingOf(track.trackId)
  if (rating < rules.minRating || rating > rules.maxRating) return false
  if (rules.lovedOnly && !ctx.lovedOf(track.trackId)) return false
  return matchesFilterClauses(track, rules.clauses, ctx)
}

// ── Album/artist group predicate ──────────────────────────────────────

/** The aggregate values `libraryFilters.makeGroupAggregates` produces. */
export interface GroupFilterAggregates {
  avgRating: number
  lovedCount: number
  year: number | null
  length: number
  latestAdded: number
  tracks: readonly Track[]
}

/**
 * A clause against an album/artist group. Rating is ANY-TRACK (one track in
 * range keeps the group); text fields are ANY-TRACK too (the group's album /
 * artist name lives on its tracks, so a title search surfaces the album that
 * holds the song); year uses the group's earliest year, length its total,
 * added its newest track — the same aggregates the sort uses.
 */
export function filterClauseMatchesGroup(
  group: GroupFilterAggregates,
  clause: FilterClause,
  ctx: TrackFilterContext,
): boolean {
  if (clause.kind === 'text') {
    const tokens = parseFilterText(clause.query)
    return group.tracks.some((t) => clauseMatchesTrack(t, clause, ctx, tokens))
  }
  if (clause.kind === 'boolean') {
    return clause.value ? group.lovedCount > 0 : group.lovedCount === 0
  }
  switch (clause.field) {
    case 'rating':
      return group.tracks.some((t) => rangeValueMatches(ctx.ratingOf(t.trackId), clause.min, clause.max))
    case 'year':
      return rangeValueMatches(group.year, clause.min, clause.max)
    case 'length':
      return rangeValueMatches(group.length, clause.min, clause.max)
    case 'added':
      return rangeValueMatches(group.latestAdded > 0 ? group.latestAdded : null, clause.min, clause.max)
  }
}

export function matchesFilterRuleSetGroup(
  group: GroupFilterAggregates,
  rules: Pick<FilterRuleSet, 'minRating' | 'maxRating' | 'lovedOnly' | 'clauses'>,
  ctx: TrackFilterContext,
): boolean {
  if (rules.minRating > RATING_MIN || rules.maxRating < RATING_MAX) {
    const anyInRange = group.tracks.some((t) => {
      const r = ctx.ratingOf(t.trackId)
      return r >= rules.minRating && r <= rules.maxRating
    })
    if (!anyInRange) return false
  }
  if (rules.lovedOnly && group.lovedCount <= 0) return false
  return rules.clauses.every((c) => filterClauseMatchesGroup(group, c, ctx))
}

// ── Mutation reducers ─────────────────────────────────────────────────

function nextClauseId(rules: FilterRuleSet, field: FilterFieldKey): string {
  let n = 1
  const used = new Set(rules.clauses.map((c) => c.id))
  while (used.has(`clause-${field}-${n}`)) n++
  return `clause-${field}-${n}`
}

export function newFilterClause(field: FilterFieldKey, id: string): FilterClause | null {
  const spec = FILTER_FIELD_SPECS[field]
  if (!spec) return null
  if (spec.kind === 'range') {
    return { id, kind: 'range', field: field as RangeFilterField, min: null, max: null }
  }
  if (spec.kind === 'boolean') {
    return { id, kind: 'boolean', field: field as BooleanFilterField, value: true }
  }
  return { id, kind: 'text', field: field as TextFilterField, query: '' }
}

/**
 * Adds one clause for `field`. A field is filtered at most once (its clause
 * already ANDs multiple tokens, and two sliders for one value is ambiguous);
 * unknown fields and a full list are no-ops.
 */
export function addFilterClause(rules: FilterRuleSet, field: FilterFieldKey): FilterRuleSet {
  if (!FILTER_FIELD_SPECS[field]) return rules
  if (rules.clauses.length >= MAX_FILTER_CLAUSES) return rules
  if (rules.clauses.some((c) => c.field === field)) return rules
  const clause = newFilterClause(field, nextClauseId(rules, field))
  if (!clause) return rules
  return { ...rules, clauses: [...rules.clauses, clause] }
}

export function removeFilterClause(rules: FilterRuleSet, id: string): FilterRuleSet {
  if (!rules.clauses.some((c) => c.id === id)) return rules
  return { ...rules, clauses: rules.clauses.filter((c) => c.id !== id) }
}

/** Replaces a clause by id (the clause's own id wins — it cannot be renamed). */
export function replaceFilterClause(rules: FilterRuleSet, clause: FilterClause): FilterRuleSet {
  let found = false
  const clauses = rules.clauses.map((c) => {
    if (c.id !== clause.id) return c
    found = true
    return clause
  })
  return found ? { ...rules, clauses } : rules
}

function patchRangeClause(clause: RangeFilterClause, patch: Partial<Pick<RangeFilterClause, 'min' | 'max'>>): RangeFilterClause {
  let min = patch.min !== undefined ? patch.min : clause.min
  let max = patch.max !== undefined ? patch.max : clause.max
  if (min !== null) min = Number(min)
  if (max !== null) max = Number(max)
  if (!Number.isFinite(min as number)) min = null
  if (!Number.isFinite(max as number)) max = null
  if (min !== null && max !== null && min > max) {
    // Never store an inverted range — the callers' handles cross over, and an
    // inverted pair is a silently-empty filter (the old E12 warning).
    if (patch.min !== undefined && patch.max === undefined) min = max
    else max = min
  }
  return { ...clause, min, max }
}

export function setRangeClause(rules: FilterRuleSet, id: string, patch: Partial<Pick<RangeFilterClause, 'min' | 'max'>>): FilterRuleSet {
  const clauses = rules.clauses.map((c) => (c.id === id && c.kind === 'range' ? patchRangeClause(c, patch) : c))
  return { ...rules, clauses }
}

export function setTextClause(rules: FilterRuleSet, id: string, query: string): FilterRuleSet {
  const clauses = rules.clauses.map((c) => (c.id === id && c.kind === 'text' ? { ...c, query } : c))
  return { ...rules, clauses }
}

export function setBooleanClause(rules: FilterRuleSet, id: string, value: boolean): FilterRuleSet {
  const clauses = rules.clauses.map((c) => (c.id === id && c.kind === 'boolean' ? { ...c, value } : c))
  return { ...rules, clauses }
}

/** Empty everything — the Clear-all control and a fresh "no filters" state. */
export function clearFilterRuleSet(): FilterRuleSet {
  return emptyFilterRuleSet()
}

// ── Decoding (the trust boundary) ─────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function finiteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function clampRating(v: unknown, fallback: number): number {
  const n = finiteNumber(v)
  if (n === null) return fallback
  return Math.min(RATING_MAX, Math.max(RATING_MIN, Math.round(n)))
}

function inKind(field: unknown): field is FilterFieldKey {
  return typeof field === 'string' && field in FILTER_FIELD_SPECS
}

function clampBound(field: RangeFilterField, v: number | null): number | null {
  if (v === null) return null
  // Date-added bounds are absolute timestamps with a library-dependent domain,
  // so they are only sanity-clamped; the fixed fields clamp to their domain.
  if (field === 'added') return Math.min(8.64e15, Math.max(0, v))
  const dom = rangeDomain(field)
  return Math.min(dom.max, Math.max(dom.min, v))
}

function decodeClause(raw: unknown, id: string): FilterClause | null {
  if (!isRecord(raw)) return null
  const field = raw.field
  if (!inKind(field)) return null
  const spec = FILTER_FIELD_SPECS[field]
  // `kind` may be absent (an older/looser writer) — the registry is the truth.
  const kind = raw.kind === 'range' || raw.kind === 'text' || raw.kind === 'boolean' ? raw.kind : spec.kind
  if (kind !== spec.kind) return null
  if (kind === 'range') {
    const min = clampBound(field as RangeFilterField, finiteNumber(raw.min))
    let max = clampBound(field as RangeFilterField, finiteNumber(raw.max))
    let lo = min
    if (lo !== null && max !== null && lo > max) {
      const t = lo
      lo = max
      max = t
    }
    return { id, kind: 'range', field: field as RangeFilterField, min: lo, max }
  }
  if (kind === 'boolean') {
    return { id, kind: 'boolean', field: field as BooleanFilterField, value: raw.value === true }
  }
  const query = typeof raw.query === 'string' ? raw.query.slice(0, 200) : ''
  return { id, kind: 'text', field: field as TextFilterField, query }
}

/**
 * Validates a clause array: unknown fields and mistyped rows are dropped (not
 * repaired into nonsense), a field appears at most once (first wins), ranges
 * are clamped/swapped and ids are stable (a missing id derives from the field
 * so the DOM key does not churn between boots).
 */
export function decodeFilterClauses(raw: unknown): FilterClause[] {
  if (!Array.isArray(raw)) return []
  const out: FilterClause[] = []
  const seenFields = new Set<FilterFieldKey>()
  const usedIds = new Set<string>()
  for (const row of raw) {
    if (out.length >= MAX_FILTER_CLAUSES) break
    if (!isRecord(row) || !inKind(row.field) || seenFields.has(row.field)) continue
    const fallbackId = `clause-${row.field}-${out.length + 1}`
    const baseId = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : fallbackId
    // Clause ids are Svelte keys AND the handle every edit addresses. A
    // duplicated id (a corrupt row, or a fallback colliding with an explicit
    // id) would make one row shadow the other, so suffixes keep them unique.
    let id = baseId
    let n = 2
    while (usedIds.has(id)) id = `${baseId}-${n++}`
    const clause = decodeClause(row, id)
    if (!clause) continue
    seenFields.add(clause.field)
    usedIds.add(id)
    out.push(clause)
  }
  return out
}

/**
 * The ONE decoder for a persisted / preset rule set. Accepts the current
 * shape, a LEGACY row (the pre-2026-11-03 scalar `genre` / `fromYear` /
 * `toYear` / `minLength` / `maxLength`), or junk, and always answers a valid
 * rule set. Legacy fields are migrated into equivalent clauses, so a saved
 * view written yesterday still describes the view it saved.
 */
export function decodeFilterRuleSet(raw: unknown): FilterRuleSet {
  const r = isRecord(raw) ? raw : {}
  let minRating = clampRating(r.minRating, RATING_MIN)
  let maxRating = clampRating(r.maxRating, RATING_MAX)
  if (minRating > maxRating) [minRating, maxRating] = [maxRating, minRating]

  const clauses = Array.isArray(r.clauses) ? decodeFilterClauses(r.clauses) : migrateLegacyClauses(r)
  return {
    minRating,
    maxRating,
    lovedOnly: r.lovedOnly === true,
    clauses,
  }
}

/**
 * The pre-2026-11-03 scalar fields → clauses. Only used when the row has no
 * `clauses` array at all; old empty strings mean "no bound" and produce no
 * clause, exactly as they meant "pass" before.
 */
function migrateLegacyClauses(r: Record<string, unknown>): FilterClause[] {
  const out: FilterClause[] = []
  if (typeof r.genre === 'string' && r.genre.trim()) {
    out.push({ id: 'clause-genre-1', kind: 'text', field: 'genre', query: r.genre.trim() })
  }
  const fromYear = finiteNumber(r.fromYear)
  const toYear = finiteNumber(r.toYear)
  if (fromYear !== null || toYear !== null) {
    out.push({
      id: 'clause-year-1',
      kind: 'range',
      field: 'year',
      min: fromYear === null ? null : clampBound('year', fromYear),
      max: toYear === null ? null : clampBound('year', toYear),
    })
  }
  const minLength = finiteNumber(r.minLength)
  const maxLength = finiteNumber(r.maxLength)
  if (minLength !== null || maxLength !== null) {
    out.push({
      id: 'clause-length-1',
      kind: 'range',
      field: 'length',
      min: minLength === null ? null : clampBound('length', minLength),
      max: maxLength === null ? null : clampBound('length', maxLength),
    })
  }
  return out
}

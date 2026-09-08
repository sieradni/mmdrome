/**
 * Pure keyword search core shared by the Songs/Albums/Artists views and the
 * auto-queue filter predicate (B5 `searchQuery`). DOM/Dexie-free so the node
 * suite can import it directly (same pattern as autoQueuePlan/metadataCore).
 *
 * Semantics (keyword-token search): the query is split into normalized
 * tokens — whitespace-separated, with a quoted `"multi word"` span kept as
 * ONE token. EVERY token must substring-match at least ONE searchable field
 * (AND across tokens, OR across fields). Order-independent and forgiving:
 * "hey beat" matches "Hey Jude" by The Beatles, and "beat" alone matches
 * "The Beatles". Both sides fold case, punctuation, and diacritics via
 * `normalizeForSearch` (matchNormalize.ts — the canonical folding, CJK-safe).
 */

import type { Track } from '../stores/appState'
import { normalizeForSearch } from './matchNormalize'

/**
 * Quoted `"phrase"` spans win over bare runs; an unbalanced quote degrades
 * gracefully (the opening quote rides along with the bare run and is
 * stripped by normalization).
 */
const QUERY_TOKEN_RE = /"([^"]*)"|(\S+)/g

/**
 * Splits a raw search-box value into normalized, non-empty tokens.
 * Tokens that fold to the empty string (all-symbol input like `!!!`) are
 * DROPPED — `.includes("")` is always true, so an empty token would widen
 * the match to the whole library instead of matching nothing.
 */
export function parseSearchQuery(query: string): string[] {
  const tokens: string[] = []
  for (const m of (query ?? '').matchAll(QUERY_TOKEN_RE)) {
    const norm = normalizeForSearch(m[1] ?? m[2] ?? '')
    if (norm) tokens.push(norm)
  }
  return tokens
}

/**
 * AND-across-tokens, OR-across-fields: every token must be a substring of at
 * least one folded field. Tokens are PRE-NORMALIZED (parseSearchQuery output)
 * — they are taken literally, not re-folded. An empty token list (empty
 * query, or an all-symbol query whose tokens were all dropped at parse)
 * passes everything. Empty-string tokens are dropped defensively — direct
 * callers may hand-build token arrays, and an empty token can never narrow
 * a match.
 */
export function fieldsMatchQuery(
  fields: readonly (string | null | undefined)[],
  tokens: readonly string[],
): boolean {
  const toks = tokens.filter((t) => t.length > 0)
  if (toks.length === 0) return true
  const folded = fields.map((f) => normalizeForSearch(f ?? ''))
  return toks.every((tok) => folded.some((f) => f.includes(tok)))
}

/**
 * The track-level field set: title, artist, album, composer, albumArtist
 * (compilations grouped under a various-artists name were previously
 * unreachable by search).
 */
export function trackMatchesQuery(track: Track, tokens: readonly string[]): boolean {
  return fieldsMatchQuery(
    [track.title, track.artist, track.album, track.composer, track.albumArtist],
    tokens,
  )
}

// ── Perf: memoized per-track field folding ────────────────────────────

/**
 * Folded (normalized) search fields per track, memoized by track OBJECT
 * identity (WeakMap — no eviction needed; a library reload produces new
 * objects and the old entries collect with them). The folding pipeline is
 * the expensive half of every keystroke's filter pass; without the memo
 * each keystroke re-normalized every field of every candidate.
 */
const foldedFieldsCache = new WeakMap<Track, string[]>()

/** Memoized folded fields — exported for ranking/reuse and tests. */
export function foldTrackFields(track: Track): string[] {
  let folded = foldedFieldsCache.get(track)
  if (!folded) {
    folded = [track.title, track.artist, track.album, track.composer, track.albumArtist].map(
      (f) => normalizeForSearch(f ?? ''),
    )
    foldedFieldsCache.set(track, folded)
  }
  return folded
}

/**
 * Match against PRE-FOLDED fields (foldTrackFields output) — the memoized
 * fast path used by the per-keystroke filters. Same AND/OR semantics as
 * `fieldsMatchQuery`, minus the re-folding.
 */
export function foldedFieldsMatchQuery(
  foldedFields: readonly string[],
  tokens: readonly string[],
): boolean {
  const toks = tokens.filter((t) => t.length > 0)
  if (toks.length === 0) return true
  return toks.every((tok) => foldedFields.some((f) => f.includes(tok)))
}

/**
 * Memoized fast path for the track predicate (the per-keystroke hot loop).
 * Semantically identical to `trackMatchesQuery`.
 */
export function trackMatchesQueryFast(track: Track, tokens: readonly string[]): boolean {
  return foldedFieldsMatchQuery(foldTrackFields(track), tokens)
}

// ── Relevance ranking ─────────────────────────────────────────────────

/**
 * Field importance for ranking: a title hit outranks an artist hit, which
 * outranks album; composer/albumArtist are supporting evidence. Indexes
 * align with the foldTrackFields order.
 */
const FIELD_WEIGHTS = [4, 3, 2, 1, 1] as const

/** Match-quality multipliers: exact field > word-start > plain substring. */
const QUALITY_EXACT = 3
const QUALITY_WORD_START = 2
const QUALITY_SUBSTRING = 1

/**
 * Relevance score for ONE track against PRE-NORMALIZED tokens; 0 means
 * no match (identical verdict to `trackMatchesQueryFast`). Per token the
 * BEST field hit counts (weight × quality); the track's score is the sum
 * over tokens, so more matching tokens always outrank fewer. Higher is
 * better; ties fall back to the caller's input order (stable sort) — i.e.
 * library order, same as the unfiltered view.
 */
export function rankTrackMatch(track: Track, tokens: readonly string[]): number {
  const fields = foldTrackFields(track)
  let total = 0
  for (const tok of tokens) {
    if (!tok) continue
    let best = 0
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i]
      if (!f.includes(tok)) continue
      const w = FIELD_WEIGHTS[i]
      const quality = f === tok ? QUALITY_EXACT : f.split(' ').some((word) => word.startsWith(tok)) ? QUALITY_WORD_START : QUALITY_SUBSTRING
      const score = w * quality
      if (score > best) best = score
    }
    if (best === 0) return 0
    total += best
  }
  return total
}

// ── Match highlighting ────────────────────────────────────────────────

export interface HighlightSegment {
  text: string
  match: boolean
}

/**
 * Splits `raw` into plain/highlighted segments: a raw range is highlighted
 * when it overlaps any folded-field occurrence of any token, mapped back
 * through `foldMapForSearch`'s index map (matchNormalize.ts — the folded→raw
 * alignment for the SAME pipeline `normalizeForSearch` runs). `folded` must
 * equal `normalizeForSearch(raw)` — on ANY mismatch (or a map of the wrong
 * length) the whole string is returned as one plain segment: highlighting
 * is best-effort, never wrong.
 */
export function highlightSegments(
  raw: string,
  folded: string,
  tokens: readonly string[],
  mapStart: readonly number[],
  mapEnd: readonly number[],
): HighlightSegment[] {
  if (!raw) return []
  if (
    folded !== normalizeForSearch(raw) ||
    mapStart.length !== folded.length ||
    mapEnd.length !== folded.length
  ) {
    return [{ text: raw, match: false }]
  }
  const marks = new Uint8Array(raw.length)
  for (const tok of tokens) {
    if (!tok) continue
    let from = 0
    for (;;) {
      const at = folded.indexOf(tok, from)
      if (at < 0) break
      const s = mapStart[at] ?? 0
      const e = mapEnd[at + tok.length - 1] ?? raw.length
      for (let i = Math.max(0, Math.min(s, raw.length)); i < Math.min(e, raw.length); i++) marks[i] = 1
      from = at + 1
    }
  }
  const segments: HighlightSegment[] = []
  let start = 0
  for (let i = 1; i <= raw.length; i++) {
    if (i === raw.length || marks[i] !== marks[i - 1]) {
      segments.push({ text: raw.slice(start, i), match: marks[i - 1] === 1 })
      start = i
    }
  }
  return segments
}

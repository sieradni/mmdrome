/**
 * Pure keyword search core shared by the Songs/Albums/Artists views, the
 * auto-queue filter predicate (B5 `searchQuery`) and File Matching.
 * DOM/Dexie-free so the node suite can import it directly (same pattern as
 * autoQueuePlan/metadataCore).
 *
 * Semantics (keyword-token search): the query is split into normalized
 * tokens — whitespace-separated, with a quoted `"multi word"` span kept as
 * ONE token. EVERY token must match at least ONE searchable field (AND across
 * tokens, OR across fields). Order-independent and forgiving: "hey beat"
 * matches "Hey Jude" by The Beatles, and "beat" alone matches "The Beatles".
 *
 * SCRIPT BRIDGING (2026-11-16): a field that contains kana is also compared
 * through its canonical romaji, so a romaji query reaches a Japanese title
 * (`tuyu`/`tsuyu`/`TUYU` → ツユ) and a kana query reaches a Latin one (`つゆ`
 * → "Tsuyu"). The comparison lives in `textMatchCore.ts` — the ONE model both
 * this module and `filterCore`'s text clauses use — and the kana table in
 * `romanizeCore.ts`. Nothing here folds kana into the primary `folded` key:
 * highlighting and "did the user type these characters" stay literal.
 */

import type { Track } from '../stores/appState'
import { normalizeForSearch } from './matchNormalize'
import { formMatchesToken, searchTextForm, searchToken, type SearchTextForm } from './textMatchCore'

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
 * AND-across-tokens, OR-across-fields: every token must match at least one
 * field. Tokens are PRE-NORMALIZED (parseSearchQuery output) — they are taken
 * literally, not re-folded. An empty token list (empty query, or an all-symbol
 * query whose tokens were all dropped at parse) passes everything. Empty-string
 * tokens are dropped defensively — direct callers may hand-build token arrays,
 * and an empty token can never narrow a match.
 */
export function fieldsMatchQuery(
  fields: readonly (string | null | undefined)[],
  tokens: readonly string[],
): boolean {
  const toks = tokens.filter((t) => t.length > 0).map(searchToken)
  if (toks.length === 0) return true
  const forms = fields.map((f) => searchTextForm(f ?? ''))
  return forms.length > 0 && toks.every((tok) => forms.some((form) => formMatchesToken(form, tok)))
}

/**
 * The track-level field set: title, artist, album, composer, albumArtist
 * (compilations grouped under a various-artists name were previously
 * unreachable by search).
 */
export function trackMatchesQuery(track: Track, tokens: readonly string[]): boolean {
  return fieldsMatchQuery(trackSearchFields(track), tokens)
}

/** The five searchable fields, in ranking order (`FIELD_WEIGHTS`). */
function trackSearchFields(track: Track): (string | null | undefined)[] {
  return [track.title, track.artist, track.album, track.composer, track.albumArtist]
}

// ── Perf: memoized per-track folding ──────────────────────────────────

/**
 * Folded (normalized) search fields per track, memoized by track OBJECT
 * identity (WeakMap — no eviction needed; a library reload produces new
 * objects and the old entries collect with them). The folding pipeline is
 * the expensive half of every keystroke's filter pass; without the memo
 * each keystroke re-normalized every field of every candidate.
 */
const foldedFieldsCache = new WeakMap<Track, string[]>()

/**
 * Memoized folded fields — the FOLDED LANE ONLY (no romaji), kept for callers
 * that need the folded text itself. Do NOT build a matcher on it: a manual
 * `.includes()` over these silently drops romaji search. Use
 * `trackMatchesQueryFast` / `fieldsMatchQuery`.
 */
export function foldTrackFields(track: Track): string[] {
  let folded = foldedFieldsCache.get(track)
  if (!folded) {
    folded = trackSearchFields(track).map((f) => normalizeForSearch(f ?? ''))
    foldedFieldsCache.set(track, folded)
  }
  return folded
}

/**
 * The FULL comparable forms per track (folded + romaji lane), memoized by track
 * object identity like `foldTrackFields`. One WeakMap lookup per track per
 * keystroke; romanization itself is memoized per field STRING inside
 * `textMatchCore`, so a library of repeated artist/album names romanizes each
 * distinct value once.
 */
const formFieldsCache = new WeakMap<Track, SearchTextForm[]>()

export function foldTrackSearchForms(track: Track): SearchTextForm[] {
  let forms = formFieldsCache.get(track)
  if (!forms) {
    forms = trackSearchFields(track).map((f) => searchTextForm(f ?? ''))
    formFieldsCache.set(track, forms)
  }
  return forms
}

/**
 * Match against PRE-FOLDED fields (foldTrackFields output) — the memoized
 * fast path used by the per-keystroke filters. Same AND/OR semantics AND the
 * same lanes (it re-derives each form, so a kana value keeps its romaji lane)
 * as `fieldsMatchQuery`, minus the re-folding.
 */
export function foldedFieldsMatchQuery(
  foldedFields: readonly string[],
  tokens: readonly string[],
): boolean {
  const toks = tokens.filter((t) => t.length > 0).map(searchToken)
  if (toks.length === 0) return true
  const forms = foldedFields.map(searchTextForm)
  return forms.length > 0 && toks.every((tok) => forms.some((form) => formMatchesToken(form, tok)))
}

/**
 * Memoized fast path for the track predicate (the per-keystroke hot loop).
 * Semantically identical to `trackMatchesQuery`.
 */
export function trackMatchesQueryFast(track: Track, tokens: readonly string[]): boolean {
  const toks = tokens.filter((t) => t.length > 0).map(searchToken)
  if (toks.length === 0) return true
  const forms = foldTrackSearchForms(track)
  return toks.every((tok) => forms.some((form) => formMatchesToken(form, tok)))
}

// ── Relevance ranking ─────────────────────────────────────────────────

/**
 * Field importance for ranking: a title hit outranks an artist hit, which
 * outranks album; composer/albumArtist are supporting evidence. Indexes
 * align with the foldTrackSearchForms order.
 */
const FIELD_WEIGHTS = [4, 3, 2, 1, 1] as const

/** Match-quality multipliers: exact field > word-start > plain substring. */
const QUALITY_EXACT = 3
const QUALITY_WORD_START = 2
const QUALITY_SUBSTRING = 1

/**
 * Match quality of one needle inside one haystack; 0 = no hit. The same ladder
 * on both lanes, so a romaji hit on a kana title is scored exactly like the
 * literal hit it stands in for.
 */
function laneQuality(hay: string, needle: string): number {
  if (!hay || !needle || !hay.includes(needle)) return 0
  if (hay === needle) return QUALITY_EXACT
  return hay.split(' ').some((word) => word.startsWith(needle)) ? QUALITY_WORD_START : QUALITY_SUBSTRING
}

/**
 * Relevance score for ONE track against PRE-NORMALIZED tokens; 0 means
 * no match (identical verdict to `trackMatchesQueryFast`). Per token the
 * BEST field hit counts (weight × quality); the track's score is the sum
 * over tokens, so more matching tokens always outrank fewer. Higher is
 * better; ties fall back to the caller's input order (stable sort) — i.e.
 * library order, same as the unfiltered view.
 */
export function rankTrackMatch(track: Track, tokens: readonly string[]): number {
  const forms = foldTrackSearchForms(track)
  let total = 0
  for (const tok of tokens) {
    if (!tok) continue
    const token = searchToken(tok)
    let best = 0
    for (let i = 0; i < forms.length; i++) {
      const form = forms[i]
      const w = FIELD_WEIGHTS[i]
      let quality = laneQuality(form.folded, token.text)
      // The romaji lanes of `formMatchesToken`, so a positive rank is exactly
      // "the predicate says yes".
      if (token.romaji) {
        if (form.romaji !== null) quality = Math.max(quality, laneQuality(form.romaji, token.romaji))
        if (token.kana) quality = Math.max(quality, laneQuality(form.folded, token.romaji))
      }
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
 *
 * This is the FOLDED lane only. A romaji match (ツユ for `tuyu`) has no raw
 * characters to mark — the matched text is a reading, not a substring — so it
 * renders unhighlighted rather than highlighting an arbitrary kana span.
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

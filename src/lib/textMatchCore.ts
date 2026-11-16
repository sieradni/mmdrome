/**
 * The ONE text-comparison model behind every search surface (2026-11-16).
 *
 * `searchCore` (Songs/Albums/Artists, the auto-queue `searchQuery`, File
 * Matching) and `filterCore` (the typed filter clauses + genre suggestions)
 * both compare "a field value" against "a query token". That comparison used to
 * live twice — the same folding, two implementations — so a change to one could
 * silently not reach the other. This module is the comparison; the callers only
 * choose how FORGIVING it is:
 *
 *   - `'substring'` — literal, order-free tokens (the search box and File
 *     Matching: what you type is what you mean, minus case/punctuation);
 *   - `'fuzzy'` — the filter clause ladder (one-edit typo per word ≥4 chars,
 *     word initials ≥2, bounded in-order subsequence ≥3).
 *
 * A comparison has three LANES, because Japanese and Latin text can describe the
 * same song in scripts that share no characters:
 *
 *   1. `form.folded` ⊃ `token.text`            — the folded lane (unchanged).
 *   2. `form.romaji` ⊃ `token.romaji`          — romaji query → kana field:
 *      `tuyu`/`tsuyu` → ツユ.
 *   3. `form.folded` ⊃ `token.romaji`          — kana query → Latin field:
 *      つゆ → "Tsuyu". Restricted to KANA tokens on purpose: a Latin token's
 *      canonical romaji is a lossy rewrite (`good`→`god`), and letting it hit
 *      the folded key would silently widen ordinary English search.
 *
 * Lane 2 only exists for a field that CONTAINS kana (`form.romaji !== null`), so
 * the canonicalizer never touches a Latin-only comparison. The romaji spellings
 * themselves live in `romanizeCore.ts`.
 *
 * Both sides of lane 2/3 are canonicalized by the same function, so the lanes
 * are symmetric: `tuyu`, `tsuyu`, `ツユ`, `つゆ`, `Tōkyō`/`toukyou`/`tokyo` all
 * agree. Romanized matches are not highlighted — highlighting stays the
 * folded-lane literal evidence (`searchCore.highlightSegments`), exactly like
 * the fuzzy clause lane; it degrades to plain text rather than guessing.
 *
 * Pure and DOM/Dexie-free. Every export is memoized (see the caches below)
 * because these run per track, per field, per keystroke.
 *
 * EXTENSION POINT: a second script (Hangul, Cyrillic, …) joins as its own form
 * key plus its own lane in `formMatchesToken` — never by widening `folded`, for
 * the same reason the romaji key is separate: a script-specific rewrite is
 * lossy on the text a user actually typed.
 */

import { normalizeForSearch } from './matchNormalize'
import { canonicalRomajiKey, containsKana, romajiSearchKey } from './romanizeCore'

// ── Field forms ───────────────────────────────────────────────────────

export interface SearchTextForm {
  /** `normalizeForSearch(raw)` — the script-preserving key (highlightable). */
  readonly folded: string
  /**
   * Canonical romaji, present ONLY when `folded` contains kana. `null` is
   * meaningful: it switches lanes 2/3 off for a Latin-only value.
   */
  readonly romaji: string | null
}

const FORM_CACHE_MAX = 4096
const formCache = new Map<string, SearchTextForm>()

/**
 * The comparable forms of one field value. Memoized by the RAW string (a
 * library reload re-folds new values; a keystroke re-reads the same ones),
 * bounded so a long session cannot hold every value it ever saw.
 */
export function searchTextForm(raw: string | null | undefined): SearchTextForm {
  const text = raw ?? ''
  const cached = formCache.get(text)
  if (cached) return cached
  const folded = normalizeForSearch(text)
  // `romajiSearchKey('')` would be '', and `.includes('')` is always true — a
  // keyless field must answer `null`, never an empty string.
  const romaji = folded && containsKana(folded) ? romajiSearchKey(folded) || null : null
  const form: SearchTextForm = { folded, romaji }
  if (formCache.size >= FORM_CACHE_MAX) formCache.clear()
  formCache.set(text, form)
  return form
}

// ── Query tokens ──────────────────────────────────────────────────────

export interface SearchToken {
  /** The folded token (kana preserved) — compared against `form.folded`. */
  readonly text: string
  /** Canonical romaji of the token; `''` when it has none. */
  readonly romaji: string
  /** The token itself contains kana, which enables lane 3. */
  readonly kana: boolean
}

const TOKEN_CACHE_MAX = 256
const tokenCache = new Map<string, SearchToken>()

/**
 * The comparable forms of one PRE-FOLDED query token (the output of
 * `parseSearchQuery` / `parseFilterText`; tokens are taken literally, never
 * re-folded). Memoized because the same token is compared against every
 * candidate field of every track.
 */
export function searchToken(text: string): SearchToken {
  const key = text ?? ''
  const cached = tokenCache.get(key)
  if (cached) return cached
  const kana = containsKana(key)
  const token: SearchToken = {
    text: key,
    // A kana token romanizes its reading; a Latin token is only canonicalized,
    // which is what folds `tuyu` → `tsuyu` on the query side.
    romaji: key ? (kana ? romajiSearchKey(key) : canonicalRomajiKey(key)) : '',
    kana,
  }
  if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear()
  tokenCache.set(key, token)
  return token
}

// ── Matching ──────────────────────────────────────────────────────────

export type TextMatchMode = 'substring' | 'fuzzy'

/** Edit distance ≤ 1 (insert/delete/substitute) — a typo, not a new word. */
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
 * The fuzzy ladder, on ONE haystack/needle pair: substring, then word initials
 * (≥2 chars — `ir` → "Indie Rock"), then a one-edit typo inside a word (≥4
 * chars, so short tokens cannot drift onto unrelated words), then an in-order
 * subsequence with a bounded span (≥3 — `inro` → "Indie Rock"). CJK tokens are
 * short by nature, so their exact substring lane carries them.
 */
function fuzzyLadder(hay: string, needle: string): boolean {
  const words = hay.split(/\s+/).filter(Boolean)
  if (needle.length >= 2) {
    const initials = words.map((w) => w[0] ?? '').join('')
    if (initials.includes(needle)) return true
  }
  if (needle.length >= 4) {
    for (const w of words) if (w.length >= 3 && withinOneEdit(w, needle)) return true
  } else if (needle.length === 3) {
    // Short token typos are too permissive across words; only the whole field.
    if (withinOneEdit(hay, needle)) return true
  }
  return needle.length >= 3 && subsequenceWithin(hay, needle, needle.length * 3)
}

function laneMatches(hay: string, needle: string, mode: TextMatchMode): boolean {
  if (!needle) return true
  if (!hay) return false
  if (hay.includes(needle)) return true
  return mode === 'fuzzy' && fuzzyLadder(hay, needle)
}

/**
 * Does one field form carry one query token? An empty token matches everything
 * (callers drop empty tokens at parse; this is the defensive floor that also
 * keeps `.includes('')` from widening or narrowing a match).
 *
 * `mode` is the SURFACE's forgiveness, not the field's: `'substring'` for the
 * library search box and File Matching, `'fuzzy'` for filter clauses. Both modes
 * use the same three lanes, so a surface can never support romaji in one mode
 * and not the other.
 */
export function formMatchesToken(
  form: SearchTextForm,
  token: SearchToken,
  mode: TextMatchMode = 'substring',
): boolean {
  if (!token.text) return true
  if (laneMatches(form.folded, token.text, mode)) return true
  if (!token.romaji) return false
  if (form.romaji !== null && laneMatches(form.romaji, token.romaji, mode)) return true
  return token.kana && laneMatches(form.folded, token.romaji, mode)
}

/**
 * Case/punctuation folding for title comparisons — the repo-wide canonical
 * normalization, in a DOM/Dexie-free module so the node test suite can import
 * it (metadataScanner/metadataReader both import from here; the two can never
 * drift apart again).
 *
 * MUST use unicode property escapes with the `u` flag: plain `\w` is
 * ASCII-only, so Japanese/CJK titles (a large share of this library)
 * normalized to the empty string — every CJK track scored as a near-match to
 * ANY filename (`.includes("")` is always true) and `verifyEntryAgainstTrack`
 * could never reach 'verified'. Letters/numbers of any script survive.
 */

export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim()
}

/**
 * Search-box folding: extends the canonical `normalizeForMatch` with
 * diacritic folding so "Beyoncé" matches a `beyonce` query. NFD-decompose,
 * strip ONLY the U+0300–U+036F Combining Diacritical Marks block, then NFC
 * recompose, then the canonical pipeline. Range-limited + recomposed on
 * purpose: NFD decomposes the katakana/hiragana voicing marks too
 * (ガ→カ+U+3099), and both an unrestricted `\p{M}` strip and
 * `normalizeForMatch`'s own punctuation strip would eat the mark and fold
 * バ→ハ / ガ→カ — degrading CJK search precision, the exact class of bug the
 * unicode-escape rule above exists to prevent. NFC recombines what the
 * range-limited strip left behind.
 */
export function normalizeForSearch(s: string): string {
  return normalizeForMatch(s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").normalize("NFC"))
}

/**
 * Per-folded-character alignment for search highlighting: `folded` equals
 * `normalizeForSearch(raw)` (callers VERIFY this and degrade to no-highlight
 * on mismatch; pinned equal by test over a nasty corpus), and
 * `mapStart[k]`/`mapEnd[k]` bracket the RAW code-unit range that produced
 * folded character k. The map is built by simulating the pipeline per raw
 * code point — NFD, the range-limited mark strip, NFC merges (Hangul jamo
 * and stray combining marks merge with the folded tail and attribute to the
 * EARLIER constituent), lowercase (expansions like İ/ﬁ attribute all their
 * output chars to the one raw char), the L/N/space strip, whitespace
 * collapse (the run's first char owns the collapsed space), and trim.
 * Characters CONSUMED by the pipeline (stripped punctuation, collapsed
 * whitespace) never appear in the map but fall INSIDE any span bracketed by
 * their neighbors — so a folded match maps back to the raw substring a user
 * recognizes ("Don't" highlights for the token `dont`).
 */
export function foldMapForSearch(raw: string): { folded: string; mapStart: number[]; mapEnd: number[] } {
  const chars: string[] = []
  const ownerStart: number[] = []
  const ownerEnd: number[] = []
  let i = 0
  for (const pt of raw) {
    const width = (pt.codePointAt(0) ?? 0) > 0xffff ? 2 : 1
    const piece = pt.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    for (const ch of piece) {
      if (chars.length > 0) {
        const tail = chars[chars.length - 1]
        const merged = (tail + ch).normalize("NFC")
        if (merged.length === 1 && merged !== tail + ch) {
          chars[chars.length - 1] = merged
          ownerEnd[ownerEnd.length - 1] = i + width
          continue
        }
      }
      chars.push(ch)
      ownerStart.push(i)
      ownerEnd.push(i + width)
    }
    i += width
  }
  const out: string[] = []
  const mapStart: number[] = []
  const mapEnd: number[] = []
  for (let j = 0; j < chars.length; j++) {
    for (const lc of chars[j].toLowerCase()) {
      if (/[\p{L}\p{N}\s]/u.test(lc)) {
        out.push(lc)
        mapStart.push(ownerStart[j])
        mapEnd.push(ownerEnd[j])
      }
    }
  }
  const out2: string[] = []
  const start2: number[] = []
  const end2: number[] = []
  for (let k = 0; k < out.length; k++) {
    if (/\s/u.test(out[k])) {
      if (out2.length > 0 && /\s/u.test(out2[out2.length - 1])) continue
      out2.push(" ")
      start2.push(mapStart[k])
      end2.push(mapEnd[k])
    } else {
      out2.push(out[k])
      start2.push(mapStart[k])
      end2.push(mapEnd[k])
    }
  }
  let lo = 0
  let hi = out2.length
  while (lo < hi && out2[lo] === " ") lo++
  while (hi > lo && out2[hi - 1] === " ") hi--
  return {
    folded: out2.slice(lo, hi).join(""),
    mapStart: start2.slice(lo, hi),
    mapEnd: end2.slice(lo, hi),
  }
}

/** Same folding used for filename- and title-hints in the tag probe
 *  selection (`ensureTagProbe`). An alias of `normalizeForMatch` so the hint
 *  path inherits the CJK-safe behavior. */
export function normalizeForHint(s: string): string {
  return normalizeForMatch(s)
}

/** A filename "hints" at an unclaimed track when its base (minus track
 *  numbers/separators) matches or contains a normalized unclaimed title. An
 *  empty normalized title (`""`, or an all-symbol title like `"!!!"` that
 *  folds to nothing) can never match — `.includes("")` is always true, which
 *  used to rank every file against the empty entry and degrade the probe's
 *  "never sweep the server" guard to a near-sweep. */
export function filenameHintsTitle(filename: string, titles: Set<string>): boolean {
  const dot = filename.lastIndexOf(".")
  const base = dot > 0 ? filename.slice(0, dot) : filename
  const cleaned = normalizeForHint(base).replace(/^[\d\s._-]+/, "")
  if (!cleaned) return false
  for (const title of titles) {
    if (!title) continue
    if (cleaned === title || cleaned.includes(title) || title.includes(cleaned)) return true
  }
  return false
}
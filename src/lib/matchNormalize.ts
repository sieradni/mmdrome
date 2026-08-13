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
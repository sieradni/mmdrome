/**
 * Japanese romanization — the kana → romaji half of the search model
 * (2026-11-16). `textMatchCore.ts` owns the comparison; this module owns the
 * script bridge; neither touches the DOM or Dexie.
 *
 * Why: a library full of Japanese titles is unusable from a romaji keyboard if
 * search only substring-matches the literal characters — `ツユ` was reachable
 * only by typing kana. So a romaji query reaches a kana field (`tuyu`,
 * `tsuyu`, `ツユ` and `つゆ` all meet at `tsuyu`) and a kana query reaches a
 * Latin one (`つゆ` finds "Tsuyu").
 *
 * Two stages, both pure and table-driven:
 *
 *  1. `romanizeKana` — katakana and halfwidth katakana fold to hiragana, then
 *     each CLUSTER emits canonical Hepburn romaji: two-character youon
 *     (`きゃ` → kya), foreign clusters (`ふぁ` → fa, `てぃ` → ti), `っ`
 *     geminates the next syllable's consonant (`まっちゃ` → matcha, `がっこう`
 *     → gakkou), `ー` repeats the previous vowel (`ラーメン` → raamen), `ん`
 *     is `n`, `を`/`ゐ`/`ゑ` are `o`/`i`/`e`. Anything that is not kana passes
 *     through untouched, so a mixed field (`ツユ TUYU`) keeps its Latin half
 *     and kanji act as separators — kanji CANNOT be romanized without a
 *     reading dictionary, and guessing readings would invent matches. That
 *     limitation is deliberate and documented: this is a kana bridge.
 *
 *  2. `canonicalRomajiKey` — ONE spelling for the whole romaji lane, applied to
 *     the romanized FIELD and to the typed QUERY alike, so the spelling
 *     variants of the same reading meet: Kunrei-shiki → Hepburn (`tu`→tsu,
 *     `si`→shi, `ti`→chi, `hu`→fu, `zi`/`di`→ji, `du`→zu, `sy`/`ty`/`zy`/`dy`/
 *     `jy`→sh/ch/j), old-Hepburn `m` before b/p/m (`shimbun`→shinbun),
 *     `wo`→o, long `ou` and doubled vowels → one vowel (`toukyou`→tokyo,
 *     `raamen`→ramen, `yuuki`→yuki). Macron input never reaches stage 2:
 *     `normalizeForSearch` already strips U+0300–U+036F, so `Tōkyō` arrives as
 *     `tokyo`.
 *
 * The canonicalizer is ONLY applied inside the romaji lane — i.e. to a
 * comparison where at least one side contains kana (see `textMatchCore.ts`).
 * Applying it to the script-preserving folded key would mangle ordinary Latin
 * search: `good`→`god`, `two`→`to`, `si`→`shi` inside English words. That
 * separation IS the design: script bridging is per-field and opt-in, never a
 * global rewrite of the text the user sees.
 *
 * Deliberate non-goals (each would need data this module refuses to invent):
 * kanji/kana readings from a dictionary, pitch/length normalization of names
 * that only match phonetically (`は` ha vs `わ` wa as a particle), and Latin
 * fields being re-spelled (`TUYU` the Latin title is matched as typed; a field
 * that ALSO carries kana gets its Latin half canonicalized with the rest).
 * Fullwidth Latin (`ＡＢＣ`) is NOT folded here either: that is compatibility
 * normalization for the canonical fold (`normalizeForSearch`), not a reading,
 * and doing it in this module would give search a second, divergent fold.
 * Halfwidth katakana IS in scope — it normalizes to fullwidth kana (NFKC).
 */

// ── Script detection ──────────────────────────────────────────────────

/**
 * Any kana: hiragana, katakana (including the prolonged-sound mark `ー`),
 * katakana phonetic extensions and halfwidth katakana. The katakana middle dot
 * `・` (U+30FB) is deliberately NOT kana — it is punctuation, and a field of
 * only punctuation must never claim a romaji lane.
 */
const KANA_RE = /[\u3041-\u309f\u30a0-\u30fa\u30fc-\u30ff\u31f0-\u31ff\uff66-\uff9f]/

export function containsKana(text: string): boolean {
  return KANA_RE.test(text ?? '')
}

// ── Kana → romaji table (hiragana keys, canonical Hepburn output) ─────

/**
 * One-character readings. Small vowels are listed on their own so a stray
 * small kana at a cluster boundary is still readable, and `を`/`ゐ`/`ゑ` emit
 * their canonical (Hepburn) readings directly — `wo` survives only as a
 * QUERY spelling, which stage 2 folds back to `o`.
 */
const SINGLE: Readonly<Record<string, string>> = {
  ぁ: 'a', あ: 'a', ぃ: 'i', い: 'i', ぅ: 'u', う: 'u', ぇ: 'e', え: 'e', ぉ: 'o', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo', ゃ: 'ya', ゅ: 'yu', ょ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o', ん: 'n',
  ゔ: 'vu', ゕ: 'ka', ゖ: 'ke',
}

/**
 * Two-character clusters: youon (`きゃ`), and the foreign-sound clusters that
 * katakana loanwords are built from (`ファ`, `ティ`, `ウィ`, `シェ`). The
 * loanword readings are intentionally the LATIN ones (`てぃ` → ti), even
 * though stage 2 also maps a typed `ti` to `chi` — both `ち` and `ティ` end up
 * reachable from `ti`, and the collision only widens a fuzzy match (see the
 * `canonicalRomajiKey` note).
 */
const COMBO: Readonly<Record<string, string>> = {
  きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo',
  ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo',
  しゃ: 'sha', しゅ: 'shu', しょ: 'sho',
  じゃ: 'ja', じゅ: 'ju', じょ: 'jo',
  ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho',
  ぢゃ: 'ja', ぢゅ: 'ju', ぢょ: 'jo',
  にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo',
  ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo',
  びゃ: 'bya', びゅ: 'byu', びょ: 'byo',
  ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo',
  みゃ: 'mya', みゅ: 'myu', みょ: 'myo',
  りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo',
  ふぁ: 'fa', ふぃ: 'fi', ふぇ: 'fe', ふぉ: 'fo', ふゅ: 'fyu',
  うぁ: 'wa', うぃ: 'wi', うぇ: 'we', うぉ: 'wo',
  ゔぁ: 'va', ゔぃ: 'vi', ゔぇ: 've', ゔぉ: 'vo',
  てぃ: 'ti', てゅ: 'tyu', でぃ: 'di', でゅ: 'dyu',
  とぅ: 'tu', どぅ: 'du',
  つぁ: 'tsa', つぃ: 'tsi', つぇ: 'tse', つぉ: 'tso',
  しぇ: 'she', じぇ: 'je', ちぇ: 'che',
  すぃ: 'si', ずぃ: 'zi',
}

const SMALL_TSU = 'っ'
const LONG_VOWEL = 'ー'
const VOWEL_RE = /[aeiouy]/
const CONSONANT_RE = /^[bcdfghjklmpqrstvwxyz]/

/**
 * Katakana → hiragana. NFKC first, so halfwidth katakana (`ﾂﾕ`, `ｰ`) and the
 * squared katakana shorthand (`㍿`) arrive as their fullwidth forms; then the
 * block offset (0x60) maps katakana onto hiragana, which is where the single
 * table lives. Everything else is untouched.
 */
function toHiragana(text: string): string {
  const normalized = text.normalize('NFKC')
  let out = ''
  for (const ch of normalized) {
    const cp = ch.codePointAt(0) ?? 0
    out += cp >= 0x30a1 && cp <= 0x30f6 ? String.fromCodePoint(cp - 0x60) : ch
  }
  return out
}

/** Last vowel of an emitted romaji chunk ('' when the chunk has none, e.g. `n`). */
function trailingVowel(romaji: string): string {
  for (let i = romaji.length - 1; i >= 0; i--) {
    if (VOWEL_RE.test(romaji[i])) return romaji[i]
  }
  return ''
}

/**
 * Kana runs → canonical Hepburn romaji; non-kana characters pass through
 * unchanged. Kana-ONLY concerns are resolved here (gemination, long vowels,
 * cluster parsing); spelling variance is `canonicalRomajiKey`'s job.
 */
export function romanizeKana(text: string): string {
  const chars = Array.from(toHiragana(text ?? ''))
  let out = ''
  let geminate = false
  let lastVowel = ''
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (ch === SMALL_TSU) {
      // `っ` carries into the NEXT cluster — it has no sound of its own.
      geminate = true
      continue
    }
    if (ch === LONG_VOWEL) {
      // `ー` lengthens the preceding vowel (`コーヒー` → koohii); with no
      // preceding vowel there is nothing to lengthen.
      if (lastVowel) out += lastVowel
      continue
    }
    const pair = chars[i + 1] !== undefined ? ch + chars[i + 1] : ''
    let romaji: string | undefined
    if (pair && COMBO[pair] !== undefined) {
      romaji = COMBO[pair]
      i++
    } else {
      romaji = SINGLE[ch]
    }
    if (romaji === undefined) {
      // Not kana: keep the character where it was. Kanji stay as separators,
      // so a romaji token can only match a contiguous kana run — never splice
      // across a kanji it cannot read.
      out += ch
      geminate = false
      continue
    }
    if (geminate) {
      // Hepburn gemination doubles the consonant, except `ch` → `tch`
      // (`まっちゃ` → matcha). A cluster with no consonant to double (a vowel,
      // `n`, `y`) simply drops the small tsu, as Japanese transcription does.
      romaji = romaji.startsWith('ch')
        ? `t${romaji}`
        : CONSONANT_RE.test(romaji) && romaji[0] !== 'n'
          ? romaji[0] + romaji
          : romaji
      geminate = false
    }
    out += romaji
    const vowel = trailingVowel(romaji)
    if (vowel) lastVowel = vowel
  }
  return out
}

// ── Spelling canonicalization (the romaji lane's one key) ─────────────

/**
 * Kunrei-shiki / wapuro → Hepburn. Applied in ONE left-to-right pass with a
 * fixed alternation, so a replacement can never feed another rule: the outputs
 * (`sh`, `ch`, `j`, `shi`, `chi`, `tsu`, `fu`, `ji`, `zu`) contain none of the
 * rule inputs, which is what makes `canonicalRomajiKey` idempotent.
 */
const VARIANT: Readonly<Record<string, string>> = {
  sy: 'sh', ty: 'ch', zy: 'j', dy: 'j', jy: 'j',
  si: 'shi', ti: 'chi', tu: 'tsu', hu: 'fu', zi: 'ji', di: 'ji', du: 'zu',
}
const VARIANT_RE = /sy|ty|zy|dy|jy|si|ti|tu|hu|zi|di|du/g

/**
 * ONE canonical spelling for the romaji lane. Apply it to BOTH sides of a
 * romaji comparison or not at all — a one-sided call makes `tuyu` match while
 * `tsuyu` does not.
 *
 * Folding rules (all measured against real-world romanization, not invented):
 *  - Kunrei → Hepburn (above).
 *  - Old-Hepburn syllabic `m` before b/p/m → `n` (`shimbun` → shinbun).
 *  - `を` typed as `wo` → `o`.
 *  - Long o/u/a/i/e → ONE vowel: `ou` (`toukyou`→tokyo) and any doubled vowel
 *    (`raamen`→ramen, `yuuki`→yuki, `oishii`→oishi). This is why `ー`,
 *    `おう`/`おお` and a macron all land on the same key.
 *
 * Only ever used for comparisons that involve kana (textMatchCore's romaji
 * lane). On plain English these rules are lossy by design (`good`→`god`), which
 * is exactly why they are fenced off from the folded key.
 */
export function canonicalRomajiKey(text: string): string {
  let key = (text ?? '').toLowerCase()
  key = key.replace(VARIANT_RE, (m) => VARIANT[m] ?? m)
  key = key.replace(/m(?=[bmp])/g, 'n')
  key = key.replace(/wo/g, 'o')
  key = key.replace(/ou/g, 'o')
  key = key.replace(/([aeiou])\1+/g, '$1')
  return key
}

/**
 * The romaji-lane key of any text: romanize its kana, then canonicalize the
 * spelling. Latin/digit/kanji characters pass through stage 1, so a mixed field
 * yields one comparable key (`"ツユ TUYU"` → `"tsuyu tsuyu"`) — a Japanese
 * title and its Latin transliteration meet each other.
 *
 * Answers `''` when the text has no letters at all (e.g. a lone `ー`); callers
 * must treat `''` as "no romaji key", because `.includes('')` is always true.
 */
export function romajiSearchKey(text: string): string {
  return canonicalRomajiKey(romanizeKana(text ?? ''))
}

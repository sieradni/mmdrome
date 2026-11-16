// Pins the kana → canonical romaji core (romanizeCore.ts) that every search
// surface routes through — searchCore for the search box, the auto-queue
// `searchQuery` and File Matching, filterCore for text clauses. The contract
// the rest of the model relies on: hiragana/katakana/halfwidth agree, the
// spelling variants (Kunrei-shiki, wapuro, macron, long vowels, gemination)
// all land on ONE key, and the key is idempotent.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalRomajiKey,
  containsKana,
  romajiSearchKey,
  romanizeKana,
} from '../src/lib/romanizeCore'

// ── Script detection ───────────────────────────────────────────────────

test('containsKana: every kana script is detected; kanji and Latin are not', () => {
  assert.equal(containsKana('ツユ'), true)
  assert.equal(containsKana('つゆ'), true)
  assert.equal(containsKana('ﾂﾕ'), true, 'halfwidth katakana')
  assert.equal(containsKana('ー'), true, 'prolonged sound mark')
  assert.equal(containsKana('日本語'), false, 'kanji alone is not kana — there is no reading dictionary')
  assert.equal(containsKana('TUYU'), false)
  assert.equal(containsKana('・'), false, 'the katakana middle dot is punctuation, not a reading')
  assert.equal(containsKana(''), false)
})

// ── Kana → romaji ──────────────────────────────────────────────────────

test('romanizeKana: katakana, hiragana and halfwidth give the same reading', () => {
  assert.equal(romanizeKana('ツユ'), 'tsuyu')
  assert.equal(romanizeKana('つゆ'), 'tsuyu')
  assert.equal(romanizeKana('ﾂﾕ'), 'tsuyu', 'halfwidth folds through NFKC first')
  assert.equal(romanizeKana('ビートルズ'), 'biitoruzu')
  assert.equal(romanizeKana('バビロン'), 'babiron')
})

test('romanizeKana: youon and foreign clusters are one sound', () => {
  assert.equal(romanizeKana('きゃりー'), 'kyarii')
  assert.equal(romanizeKana('しゃしん'), 'shashin')
  assert.equal(romanizeKana('ちゃ'), 'cha')
  assert.equal(romanizeKana('ふぁん'), 'fan')
  assert.equal(romanizeKana('てぃ'), 'ti')
  assert.equal(romanizeKana('ゔぁ'), 'va')
})

test('romanizeKana: small tsu geminates, except ch → tch', () => {
  assert.equal(romanizeKana('まっちゃ'), 'matcha')
  assert.equal(romanizeKana('がっこう'), 'gakkou')
  assert.equal(romanizeKana('いっしょ'), 'issho')
  assert.equal(romanizeKana('きって'), 'kitte')
  assert.equal(romanizeKana('あっ'), 'a', 'nothing to geminate at a kana boundary')
})

test('romanizeKana: ー lengthens the preceding vowel', () => {
  assert.equal(romanizeKana('ラーメン'), 'raamen')
  assert.equal(romanizeKana('コーヒー'), 'koohii')
  assert.equal(romanizeKana('メー'), 'mee')
})

test('romanizeKana: particles and ん keep their readings', () => {
  assert.equal(romanizeKana('を'), 'o')
  assert.equal(romanizeKana('しんぶん'), 'shinbun')
  assert.equal(romanizeKana('にほん'), 'nihon')
})

test('romanizeKana: non-kana passes through in place (kanji act as separators)', () => {
  assert.equal(romanizeKana('日本語のタイトル'), '日本語notaitoru')
  assert.equal(romanizeKana('ツユ - くらべられっ子'), 'tsuyu - kuraberare子')
  assert.equal(romanizeKana('TUYU'), 'TUYU', 'Latin is not re-spelled by the romanizer')
})

// ── Spelling canonicalization ──────────────────────────────────────────

test('canonicalRomajiKey: Kunrei-shiki and wapuro spellings meet Hepburn', () => {
  assert.equal(canonicalRomajiKey('tuyu'), 'tsuyu')
  assert.equal(canonicalRomajiKey('tsuyu'), 'tsuyu', 'Hepburn is a fixed point')
  assert.equal(canonicalRomajiKey('si'), canonicalRomajiKey('shi'))
  assert.equal(canonicalRomajiKey('ti'), canonicalRomajiKey('chi'))
  assert.equal(canonicalRomajiKey('hu'), canonicalRomajiKey('fu'))
  assert.equal(canonicalRomajiKey('zi'), canonicalRomajiKey('ji'))
  assert.equal(canonicalRomajiKey('di'), canonicalRomajiKey('ji'))
  assert.equal(canonicalRomajiKey('du'), canonicalRomajiKey('zu'))
  assert.equal(canonicalRomajiKey('sya'), 'sha')
  assert.equal(canonicalRomajiKey('zya'), 'ja')
  assert.equal(canonicalRomajiKey('jy'), 'j')
})

test('canonicalRomajiKey: long vowels collapse — ー, おう and a macron land together', () => {
  assert.equal(canonicalRomajiKey('raamen'), 'ramen')
  assert.equal(canonicalRomajiKey('toukyou'), 'tokyo')
  assert.equal(canonicalRomajiKey('yuuki'), 'yuki')
  assert.equal(canonicalRomajiKey('oishii'), 'oishi')
  assert.equal(canonicalRomajiKey('shimbun'), 'shinbun', 'old-Hepburn syllabic m before b')
  assert.equal(canonicalRomajiKey('wo'), 'o')
})

test('canonicalRomajiKey is idempotent (the lane compares key against key)', () => {
  const corpus = ['tuyu', 'tsuyu', 'raamen', 'toukyou', 'shimbun', 'sya', 'zya', 'ti', 'wo', 'matcha', '']
  for (const s of corpus) {
    const once = canonicalRomajiKey(s)
    assert.equal(canonicalRomajiKey(once), once, s)
  }
})

test('canonicalRomajiKey is LOSSY on plain English — the fence the lanes depend on', () => {
  // The canonicalizer is only ever applied where at least one side contains
  // kana (textMatchCore's romaji lane), because unlike the folded key it does
  // NOT preserve Latin words. These assertions document the fence, not a
  // feature: Latin↔Latin comparisons never reach this function.
  assert.equal(canonicalRomajiKey('good'), 'god')
  assert.equal(canonicalRomajiKey('two'), 'to')
})

// ── The composed key ──────────────────────────────────────────────────

test('romajiSearchKey: a whole title romanizes to one comparable key', () => {
  assert.equal(romajiSearchKey('ツユ'), 'tsuyu')
  assert.equal(romajiSearchKey('TUYU'), 'tsuyu')
  assert.equal(romajiSearchKey('ツユ TUYU'), 'tsuyu tsuyu', 'a mixed title and its transliteration meet')
  assert.equal(romajiSearchKey('ラーメン'), 'ramen')
  assert.equal(romajiSearchKey('とうきょう'), 'tokyo')
  assert.equal(romajiSearchKey('ー'), '', 'no letters → no key (callers treat "" as absent)')
})

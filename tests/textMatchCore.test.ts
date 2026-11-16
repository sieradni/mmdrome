// Pins the ONE text-comparison model (textMatchCore.ts) shared by searchCore
// and filterCore: the field form (folded + optional romaji lane), the token
// form, the three lanes, and the two forgiveness modes. A surface may choose
// `'substring'` or `'fuzzy'`; it can never gain a lane the other lacks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formMatchesToken, searchTextForm, searchToken } from '../src/lib/textMatchCore'

// ── Forms ──────────────────────────────────────────────────────────────

test('searchTextForm: folded key always, romaji lane only for kana values', () => {
  assert.deepEqual(searchTextForm('Hey Jude'), { folded: 'hey jude', romaji: null })
  assert.deepEqual(searchTextForm('ツユ'), { folded: 'ツユ', romaji: 'tsuyu' })
  assert.deepEqual(searchTextForm('!!!'), { folded: '', romaji: null })
  assert.equal(searchTextForm('ー').romaji, null, 'a keyless kana string must not answer an always-matching empty key')
  assert.equal(searchTextForm(null).folded, '')
})

test('searchToken: canonical romaji for Latin and kana tokens alike', () => {
  assert.deepEqual(searchToken('tuyu'), { text: 'tuyu', romaji: 'tsuyu', kana: false })
  assert.deepEqual(searchToken('つゆ'), { text: 'つゆ', romaji: 'tsuyu', kana: true })
  assert.equal(searchToken('').romaji, '')
})

// ── Lanes ──────────────────────────────────────────────────────────────

test('lane 1 (folded) is unchanged: Latin and kana still match literally', () => {
  assert.equal(formMatchesToken(searchTextForm('Hey Jude'), searchToken('hey')), true)
  assert.equal(formMatchesToken(searchTextForm('Hey Jude'), searchToken('stones')), false)
  assert.equal(formMatchesToken(searchTextForm('ツユ'), searchToken('ツユ')), true)
  assert.equal(formMatchesToken(searchTextForm('ツユ くらべられっ子'), searchToken('ツユ くらべ')), true, 'a phrase token may span within one field')
})

test('lane 2: a romaji query reaches a kana field — any romanization scheme', () => {
  const form = searchTextForm('ツユ')
  for (const q of ['tuyu', 'tsuyu', 'TUYU', 'tuyuu']) {
    assert.equal(formMatchesToken(form, searchToken(q)), true, q)
  }
  assert.equal(formMatchesToken(searchTextForm('ラーメン'), searchToken('ramen')), true)
  assert.equal(formMatchesToken(searchTextForm('とうきょう'), searchToken('tokyo')), true)
  assert.equal(formMatchesToken(searchTextForm('がっこう'), searchToken('gakko')), true)
})

test('lane 3: a kana query reaches a Latin field through its reading', () => {
  assert.equal(formMatchesToken(searchTextForm('Tsuyu'), searchToken('つゆ')), true)
  assert.equal(formMatchesToken(searchTextForm('Tsuyu'), searchToken('ツユ')), true)
  // The bridge is one-way by design: a Latin-only field is matched as typed, so
  // its own romanization scheme cannot drift onto unrelated Latin words.
  assert.equal(formMatchesToken(searchTextForm('TUYU'), searchToken('tsuyu')), false)
})

test('voicing stays exact through the romaji lane (dakuten is a different sound)', () => {
  assert.equal(formMatchesToken(searchTextForm('バビロン'), searchToken('babiron')), true)
  assert.equal(formMatchesToken(searchTextForm('バビロン'), searchToken('habiron')), false)
  assert.equal(formMatchesToken(searchTextForm('ハビロン'), searchToken('babiron')), false)
})

// ── Modes ──────────────────────────────────────────────────────────────

test('fuzzy mode adds the typo/subsequence ladder on BOTH lanes; substring mode does not', () => {
  const form = searchTextForm('ツユ')
  assert.equal(formMatchesToken(form, searchToken('tuyo'), 'substring'), false)
  assert.equal(formMatchesToken(form, searchToken('tuyo'), 'fuzzy'), true, 'one edit away in the romaji lane')
  assert.equal(formMatchesToken(searchTextForm('Symbol'), searchToken('smbl'), 'fuzzy'), true, 'bounded subsequence')
  assert.equal(formMatchesToken(searchTextForm('Symbol'), searchToken('smbl'), 'substring'), false)
  assert.equal(formMatchesToken(searchTextForm('Indie Rock'), searchToken('ir'), 'fuzzy'), true, 'initials')
})

test('an empty token matches everything; an empty field matches nothing real', () => {
  assert.equal(formMatchesToken(searchTextForm('Anything'), searchToken('')), true)
  assert.equal(formMatchesToken(searchTextForm(''), searchToken('x')), false)
})

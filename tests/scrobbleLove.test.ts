// Pins the ONE definition of "should this track be scrobbled as loved"
// (2026-10-21): the signal matrix, threshold normalization, and the flip-path
// change plan that both heart producers share. Pure — no stores, no Dexie.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LOVE_POLICY,
  loveSignalsOf,
  normalizeLoveRatingThreshold,
  planLoveChange,
  resolveLovePolicy,
  shouldScrobbleAsLoved,
  type LovePolicy,
} from '../src/lib/scrobbleLove'

const policy = (over: Partial<LovePolicy> = {}): LovePolicy => ({ ...DEFAULT_LOVE_POLICY, ...over })

test('default policy = the historical ♥ flag only', () => {
  assert.equal(shouldScrobbleAsLoved({ loved: true, rating: 0 }, DEFAULT_LOVE_POLICY), true)
  assert.equal(shouldScrobbleAsLoved({ loved: false, rating: 100 }, DEFAULT_LOVE_POLICY), false, 'a rating alone never loved')
  assert.equal(shouldScrobbleAsLoved({ loved: false, rating: 0 }, DEFAULT_LOVE_POLICY), false)
})

test('rating signal is inclusive at the threshold and refuses an unrated track', () => {
  const p = policy({ fromLovedFlag: false, fromRating: true, ratingThreshold: 80 })
  assert.equal(shouldScrobbleAsLoved({ loved: false, rating: 80 }, p), true)
  assert.equal(shouldScrobbleAsLoved({ loved: false, rating: 79 }, p), false)
  assert.equal(shouldScrobbleAsLoved({ loved: true, rating: 10 }, p), false, '♥ is ignored when its signal is off')
  assert.equal(shouldScrobbleAsLoved({ loved: false, rating: 0 }, policy({ fromRating: true, ratingThreshold: 10 })), false, 'unrated is never loved')
})

test('both signals = either one qualifies; neither = never', () => {
  const both = policy({ fromRating: true })
  assert.equal(shouldScrobbleAsLoved({ loved: true, rating: 0 }, both), true)
  assert.equal(shouldScrobbleAsLoved({ loved: false, rating: 95 }, both), true)
  assert.equal(shouldScrobbleAsLoved({ loved: false, rating: 10 }, both), false)

  const none = policy({ fromLovedFlag: false, fromRating: false })
  assert.equal(shouldScrobbleAsLoved({ loved: true, rating: 100 }, none), false)
})

test('a missing metadata row is never loved (no row = no signal)', () => {
  assert.equal(loveSignalsOf(undefined), null)
  assert.equal(loveSignalsOf(null), null)
  assert.equal(shouldScrobbleAsLoved(null, policy({ fromRating: true })), false)
  assert.deepEqual(loveSignalsOf({ loved: true, rating: 42 }), { loved: true, rating: 42 })
  assert.deepEqual(loveSignalsOf({ loved: false, rating: Number.NaN }), { loved: false, rating: 0 })
})

test('threshold normalization tolerates legacy/noisy values', () => {
  assert.equal(normalizeLoveRatingThreshold(undefined), DEFAULT_LOVE_POLICY.ratingThreshold)
  assert.equal(normalizeLoveRatingThreshold(Number.NaN), DEFAULT_LOVE_POLICY.ratingThreshold)
  // The rating scale is 0–100 in steps of 10, so the cutoff floor is 10 — the
  // settings slider's own minimum, i.e. the policy can never hold a value the
  // UI cannot show.
  assert.equal(normalizeLoveRatingThreshold(0), 10)
  assert.equal(normalizeLoveRatingThreshold(5), 10)
  assert.equal(normalizeLoveRatingThreshold(-20), 10)
  assert.equal(normalizeLoveRatingThreshold(150), 100)
  assert.equal(normalizeLoveRatingThreshold(79.6), 80)
  assert.equal(resolveLovePolicy({ scrobbleLoveRatingThreshold: Number.NaN }).ratingThreshold, 80)
})

test('resolveLovePolicy reads the settings keys and defaults absent ones', () => {
  assert.deepEqual(resolveLovePolicy(undefined), DEFAULT_LOVE_POLICY)
  assert.deepEqual(resolveLovePolicy({}), DEFAULT_LOVE_POLICY)
  assert.deepEqual(
    resolveLovePolicy({ scrobbleLoveFromLoved: false, scrobbleLoveFromRating: true, scrobbleLoveRatingThreshold: 60 }),
    { fromLovedFlag: false, fromRating: true, ratingThreshold: 60 },
  )
  assert.deepEqual(resolveLovePolicy({ scrobbleLoveFromLoved: false }), { ...DEFAULT_LOVE_POLICY, fromLovedFlag: false })
})

test('planLoveChange delivers only when the effective state moves', () => {
  const tagOnly = DEFAULT_LOVE_POLICY
  assert.deepEqual(planLoveChange({ loved: false, rating: 0 }, { loved: true, rating: 0 }, tagOnly), { deliver: true, loved: true })
  assert.deepEqual(planLoveChange({ loved: true, rating: 0 }, { loved: false, rating: 0 }, tagOnly), { deliver: true, loved: false })
  assert.deepEqual(planLoveChange({ loved: true, rating: 50 }, { loved: true, rating: 90 }, tagOnly), { deliver: false, loved: true }, 'a rating edit with an unchanged heart re-delivers nothing')
  assert.deepEqual(planLoveChange(null, { loved: false, rating: 0 }, tagOnly), { deliver: false, loved: false })
  assert.deepEqual(planLoveChange(null, { loved: true, rating: 0 }, tagOnly), { deliver: true, loved: true }, 'first sight of a loved row still delivers')
})

test('planLoveChange honors the rating signal across both directions', () => {
  const both = policy({ fromRating: true })
  // Un-hearting a track that still clears the rating threshold is NOT an
  // effective change — services must keep the love.
  assert.deepEqual(planLoveChange({ loved: true, rating: 90 }, { loved: false, rating: 90 }, both), { deliver: false, loved: true })
  // A rating crossing the threshold delivers even though the ♥ flag never moved.
  assert.deepEqual(planLoveChange({ loved: false, rating: 50 }, { loved: false, rating: 90 }, both), { deliver: true, loved: true })
  // …and dropping back under it un-loves.
  assert.deepEqual(planLoveChange({ loved: false, rating: 90 }, { loved: false, rating: 40 }, both), { deliver: true, loved: false })
})

test('planLoveChange with neither signal never delivers', () => {
  const none = policy({ fromLovedFlag: false, fromRating: false })
  assert.deepEqual(planLoveChange({ loved: false, rating: 0 }, { loved: true, rating: 100 }, none), { deliver: false, loved: false })
  assert.deepEqual(planLoveChange({ loved: true, rating: 100 }, { loved: false, rating: 0 }, none), { deliver: false, loved: false })
})

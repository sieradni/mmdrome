// Pins the scrobbleManager destination fan-out (2026-08-25): ONE accrued
// listen event dispatches to every enabled destination; the manager itself
// stays gate-free beyond the shared accrual threshold - each default leg
// re-checks its own toggle/credentials at fire time. Spies prove the
// dispatch contract; the per-destination gates live in their own modules.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { settings, currentTrack, currentTime, metadataCache, type Track } from '../src/stores/appState'
import type { LocalMetadataStore } from '../src/lib/db'
import {
  ScrobbleManager,
  shouldNavidromeScrobble,
  shouldLastfmScrobble,
  shouldListenbrainzScrobble,
  type ScrobbleDestinations,
  type ListenEvent,
} from '../src/lib/scrobbleManager'

function trackFixture(over: Partial<Track> = {}): Track {
  return {
    trackId: 'navidrome-1',
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    duration: 300,
    fileType: 'mp3',
    ...over,
  }
}

function spyDestinations() {
  const calls: string[] = []
  const events: ListenEvent[] = []
  const dests: ScrobbleDestinations = {
    navidromeScrobble: (track) => { calls.push(`nav-scrobble:${track.trackId}`) },
    navidromeNowPlaying: () => { calls.push('nav-np') },
    lastfmScrobble: (event) => { calls.push('lfm'); events.push(event) },
    lastfmNowPlaying: () => { calls.push('lfm-np') },
    listenbrainzScrobble: (event) => { calls.push('lb'); events.push(event) },
    listenbrainzNowPlaying: () => { calls.push('lb-np') },
    lastfmLove: () => { calls.push('lfm-love') },
    listenbrainzLove: () => { calls.push('lb-love') },
  }
  return { calls, events, dests }
}

function metadataRow(trackId: string, over: Partial<LocalMetadataStore> = {}): LocalMetadataStore {
  return {
    trackId,
    rating: 0,
    loved: false,
    fileType: 'mp3',
    syncStatus: 'synced',
    lastModifiedLocally: Date.now(),
    ...over,
  }
}

/** Drives the shared stores past the 4-minute floor in <=5 s ticks so the
 *  accrual never mistakes playback for a seek. */
async function playThrough(track: Track) {
  currentTrack.set(track)
  for (let pos = 4; pos <= 244; pos += 4) currentTime.set(pos)
  currentTrack.set(null)
  await new Promise((r) => setTimeout(r, 0))
}

test('a completed listen fans out to all three destinations with the start time', async () => {
  const { calls, events, dests } = spyDestinations()
  settings.set({ scrobbling: true })
  const manager = new ScrobbleManager(dests)
  manager.init()
  manager.enable()

  await playThrough(trackFixture())

  assert.ok(calls.includes('nav-scrobble:navidrome-1'), 'navidrome leg fired')
  assert.ok(calls.includes('lfm'), 'lastfm leg fired')
  assert.ok(calls.includes('lb'), 'listenbrainz leg fired')
  assert.equal(events.length >= 2, true)
  assert.equal(events[0].artist, 'Artist')
  assert.equal(events[0].title, 'Song')
  assert.equal(events[0].album, 'Album')
  assert.equal(typeof events[0].startedAtMs, 'number')
  assert.ok(events[0].startedAtMs <= Date.now())
  assert.equal(events[0].duration, 300)
  manager.disable()
})

test('now-playing fires on track start for every destination', async () => {
  const { calls, dests } = spyDestinations()
  settings.set({ scrobbling: true })
  const manager = new ScrobbleManager(dests)
  manager.init()
  manager.enable()

  currentTrack.set(trackFixture())
  await new Promise((r) => setTimeout(r, 0))

  assert.ok(calls.includes('nav-np'))
  assert.ok(calls.includes('lfm-np'))
  assert.ok(calls.includes('lb-np'))
  manager.disable()
})

test('the manager dispatches unconditionally — gating is per-destination, not master-gated', async () => {
  // Regression pin (2026-08-25 review): the old code gated ALL legs on the
  // "Scrobble to Navidrome" toggle, so direct-only users never scrobbled.
  const { calls, dests } = spyDestinations()
  settings.set({ scrobbling: false, lastfmScrobbling: true })
  const manager = new ScrobbleManager(dests)
  manager.init()
  manager.enable()

  await playThrough(trackFixture())
  assert.ok(calls.includes('lfm') && calls.includes('lb'), 'direct legs fire with the navidrome toggle OFF')
  manager.disable()
})

test('per-destination gates (pure): navidrome requires its own toggle + prefix', () => {
  assert.equal(shouldNavidromeScrobble('navidrome-x', { scrobbling: true }), true)
  assert.equal(shouldNavidromeScrobble('navidrome-x', { scrobbling: false }), false)
  assert.equal(shouldNavidromeScrobble('webdav-y', { scrobbling: true }), false)
})

test('per-destination gates (pure): direct legs need their own toggle + identity', () => {
  const session = { key: 'k', name: 'n' }
  assert.equal(shouldLastfmScrobble({ lastfmScrobbling: true }, session, 'A', 'T'), true)
  assert.equal(shouldLastfmScrobble({ lastfmScrobbling: false }, session, 'A', 'T'), false)
  assert.equal(shouldLastfmScrobble({ lastfmScrobbling: true }, null, 'A', 'T'), false)
  assert.equal(shouldLastfmScrobble({ lastfmScrobbling: true }, session, '', ''), false)
  assert.equal(shouldListenbrainzScrobble({ listenbrainzScrobbling: true, listenbrainzToken: 't' }, 'A', 'T'), true)
  assert.equal(shouldListenbrainzScrobble({ listenbrainzScrobbling: true, listenbrainzToken: undefined }, 'A', 'T'), false)
})

test('a short listen under the threshold dispatches nothing', async () => {
  const { calls, dests } = spyDestinations()
  settings.set({ scrobbling: true })
  const manager = new ScrobbleManager(dests)
  manager.init()
  manager.enable()

  currentTrack.set(trackFixture())
  currentTime.set(60) // well under both the 50% mark and the 4-min floor
  currentTrack.set(null)
  await new Promise((r) => setTimeout(r, 0))
  assert.ok(!calls.includes('lfm') && !calls.includes('lb') && !calls.some((c) => c.startsWith('nav-scrobble')))
  manager.disable()
})

test('a track that was ALREADY loved reports as loved when its listen completes', async (t) => {
  // The 2026-10-21 field report: hearts only ever reached the services on a
  // local ♥ flip, so a library loved before the service was connected (or via
  // tags / another device) never arrived as loved. The policy is read from the
  // live metadata row at listen completion, not from a change event.
  const { calls, dests } = spyDestinations()
  settings.set({ scrobbling: true })
  metadataCache.set(new Map([['navidrome-loved', metadataRow('navidrome-loved', { loved: true })]]))
  t.after(() => metadataCache.set(new Map()))
  const manager = new ScrobbleManager(dests)
  manager.init()
  manager.enable()

  await playThrough(trackFixture({ trackId: 'navidrome-loved' }))

  assert.ok(calls.includes('lfm') && calls.includes('lb'), 'listens still dispatched')
  assert.ok(calls.includes('lfm-love'), 'Last.fm love delivered for an already-loved track')
  assert.ok(calls.includes('lb-love'), 'ListenBrainz love delivered for an already-loved track')
  manager.disable()
})

test('an unloved track delivers no heart (a play never invents love)', async (t) => {
  const { calls, dests } = spyDestinations()
  settings.set({ scrobbling: true })
  metadataCache.set(new Map([['navidrome-plain', metadataRow('navidrome-plain', { rating: 100 })]]))
  t.after(() => metadataCache.set(new Map()))
  const manager = new ScrobbleManager(dests)
  manager.init()
  manager.enable()

  await playThrough(trackFixture({ trackId: 'navidrome-plain' }))

  // rating-only love is OFF by default, so a high rating alone must not send.
  assert.ok(!calls.includes('lfm-love') && !calls.includes('lb-love'))
  manager.disable()
})

test('the rating signal drives hearts when enabled, independently of the ♥ flag', async (t) => {
  const { calls, dests } = spyDestinations()
  settings.set({
    scrobbling: true,
    scrobbleLoveFromLoved: false,
    scrobbleLoveFromRating: true,
    scrobbleLoveRatingThreshold: 80,
  })
  metadataCache.set(new Map([
    ['navidrome-high', metadataRow('navidrome-high', { rating: 90 })],
    ['navidrome-heart-only', metadataRow('navidrome-heart-only', { loved: true, rating: 10 })],
  ]))
  t.after(() => metadataCache.set(new Map()))
  const manager = new ScrobbleManager(dests)
  manager.init()
  manager.enable()

  await playThrough(trackFixture({ trackId: 'navidrome-high' }))
  assert.ok(calls.includes('lfm-love') && calls.includes('lb-love'), 'rating ≥ threshold loves')

  const before = calls.filter((c) => c.endsWith('-love')).length
  calls.length = 0
  await playThrough(trackFixture({ trackId: 'navidrome-heart-only' }))
  assert.equal(calls.filter((c) => c.endsWith('-love')).length, 0, '♥ alone must not love when the ♥ signal is off')
  assert.ok(before > 0)
  manager.disable()
})

test('the Off mode silences hearts even for a loved, highly rated track', async (t) => {
  // The settings UI's explicit "neither" state must reach the scrobble path —
  // plays still scrobble, but no heart is ever sent.
  const { calls, dests } = spyDestinations()
  settings.set({ scrobbling: true, scrobbleLoveFromLoved: false, scrobbleLoveFromRating: false })
  metadataCache.set(new Map([['navidrome-none', metadataRow('navidrome-none', { loved: true, rating: 100 })]]))
  t.after(() => metadataCache.set(new Map()))
  const manager = new ScrobbleManager(dests)
  manager.init()
  manager.enable()

  await playThrough(trackFixture({ trackId: 'navidrome-none' }))

  assert.ok(calls.includes('lfm') && calls.includes('lb'), 'plays are unaffected')
  assert.ok(!calls.includes('lfm-love') && !calls.includes('lb-love'))
  manager.disable()
})

test('a non-navidrome track still reaches the direct legs (spy level)', async () => {
  const { calls, events, dests } = spyDestinations()
  settings.set({ scrobbling: true })
  const manager = new ScrobbleManager(dests)
  manager.init()
  manager.enable()

  // The manager dispatches regardless of prefix; the NAVIDROME destination's
  // own prefix gate is part of its default impl, not the fan-out.
  await playThrough(trackFixture({ trackId: 'webdav-future-id' }))
  assert.ok(events.length >= 2)
  assert.ok(calls.includes('nav-scrobble:webdav-future-id'), 'dispatch is prefix-blind; gating belongs to destinations')
  manager.disable()
})

test('track transition setting currentTrack BEFORE currentTime(0) preserves previous track scrobble', async () => {
  const { calls, dests } = spyDestinations()
  settings.set({ scrobbling: true })
  const manager = new ScrobbleManager(dests)
  manager.init()
  manager.enable()

  const t1 = trackFixture({ trackId: 'navidrome-1', title: 'Song 1', duration: 200 })
  const t2 = trackFixture({ trackId: 'navidrome-2', title: 'Song 2', duration: 200 })

  // Play t1 past the 50% threshold (200s duration -> 100s)
  currentTrack.set(t1)
  for (let pos = 4; pos <= 120; pos += 4) currentTime.set(pos)

  // Transition to t2 in correct order: currentTrack set first, then position reset to 0
  currentTrack.set(t2)
  currentTime.set(0)

  await new Promise((r) => setTimeout(r, 0))

  assert.ok(calls.includes('nav-scrobble:navidrome-1'), 't1 was scrobbled upon track change')

  manager.disable()
})

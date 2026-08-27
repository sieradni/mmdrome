// Pins the scrobbleManager destination fan-out (2026-08-25): ONE accrued
// listen event dispatches to every enabled destination; the manager itself
// stays gate-free beyond the shared accrual threshold - each default leg
// re-checks its own toggle/credentials at fire time. Spies prove the
// dispatch contract; the per-destination gates live in their own modules.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { settings, currentTrack, currentTime, type Track } from '../src/stores/appState'
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
  }
  return { calls, events, dests }
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

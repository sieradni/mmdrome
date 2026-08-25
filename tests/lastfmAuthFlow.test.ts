// Pins the Last.fm connect-flow orchestration (desktop auth): token → open
// approval page → poll getSession until authorized (error 14) or the window
// closes; denial and timeout are terminal; a superseded flow resolves
// silently. The Dexie userSettings table is patched per the F3 pattern
// (ALL tables share one prototype — dispatch on table name).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'

import { db } from '../src/lib/db'
import { connectLfm, disconnectLfm, restoreLfmSession, getCachedLfmSession, lastfmAuthPhase, pendingAuthUrl } from '../src/lib/lastfmAuth'
import { setSetting, getSetting, deleteSetting } from '../src/lib/db'
import { LastfmError } from '../src/lib/lastfmApi'

const settingsTable = new Map<string, unknown>()

// Patch once for this file: only the userSettings table is touched here.
const proto = Object.getPrototypeOf(db.userSettings) as Record<string, unknown>
if (!('__authFlowPatched' in proto)) {
  ;(proto as { __authFlowPatched?: boolean }).__authFlowPatched = true
  proto.put = async function (this: { name: string }, value: { key: string }) {
    if (this.name === 'userSettings') { settingsTable.set(value.key, value); return }
    throw new Error(`unexpected table put: ${this.name}`)
  }
  proto.get = async function (this: { name: string }, key: string) {
    if (this.name === 'userSettings') return settingsTable.get(key)
    throw new Error(`unexpected table get: ${this.name}`)
  }
  proto.delete = async function (this: { name: string }, key: string) {
    if (this.name === 'userSettings') { settingsTable.delete(key); return }
    throw new Error(`unexpected table delete: ${this.name}`)
  }
}

function happyDeps(over: Partial<Parameters<typeof connectLfm>[0]> = {}) {
  return {
    delay: async () => {},
    openUrl: () => {},
    getToken: async () => 'tok-1',
    getSession: async () => ({ key: 'sk-1', name: 'alice' }),
    ...over,
  }
}

test('connect polls through error 14 then stores the session and flips to connected', async () => {
  let polls = 0
  let opened = ''
  await connectLfm(happyDeps({
    openUrl: (url) => { opened = url },
    getSession: async () => {
      polls++
      if (polls === 1) throw new LastfmError(14)
      return { key: 'sk-1', name: 'alice' }
    },
  }))
  assert.equal(polls, 2)
  assert.ok(opened.includes('api_key='))
  assert.ok(opened.includes('token=tok-1'))
  assert.equal(get(lastfmAuthPhase), 'connected')
  assert.equal(get(pendingAuthUrl), null, 'approval URL cleared on success')
  assert.deepEqual(getCachedLfmSession(), { key: 'sk-1', name: 'alice' })
  const stored = await getSetting<{ key: string }>('lastfmSession')
  assert.equal(stored?.key, 'sk-1')
})

test('restore brings back a persisted session without network', async () => {
  await disconnectLfm()
  await setSetting('lastfmSession', { key: 'sk-2', name: 'bob' })
  await restoreLfmSession()
  assert.equal(get(lastfmAuthPhase), 'connected')
  assert.deepEqual(getCachedLfmSession(), { key: 'sk-2', name: 'bob' })
  await deleteSetting('lastfmSession')
})

test('authorization denial is terminal with a human-facing reason', async () => {
  await disconnectLfm()
  await assert.rejects(
    connectLfm(happyDeps({ getSession: async () => { throw new LastfmError(15) } })),
    /denied/,
  )
  assert.equal(get(lastfmAuthPhase), 'idle')
  assert.equal(getCachedLfmSession(), null)
})

test('error 14 forever times out of the polling window', async () => {
  await disconnectLfm()
  let clock = 0
  await assert.rejects(
    connectLfm(happyDeps({
      now: () => clock,
      delay: async () => { clock += 3000 },
      getSession: async () => { throw new LastfmError(14) },
    })),
    /Timed out/,
  )
  assert.equal(get(lastfmAuthPhase), 'idle')
})

test('a disconnect mid-await supersedes the in-flight connect silently', async () => {
  await disconnectLfm()
  const release: (() => void)[] = []
  const pending = connectLfm(happyDeps({
    delay: () => new Promise<void>((resolve) => { release.push(resolve) }),
  }))
  // Let the loop reach its first (blocked) delay tick.
  await new Promise((r) => setTimeout(r, 0))
  await disconnectLfm()
  release[release.length - 1]?.()
  await pending
  assert.equal(get(lastfmAuthPhase), 'idle')
  assert.equal(getCachedLfmSession(), null)
})

test('a disconnect landing DURING the getSession await cannot resurrect the session', async () => {
  await disconnectLfm()
  let releasePoll!: (s: { key: string; name: string }) => void
  const pending = connectLfm(happyDeps({
    getSession: () => new Promise((resolve) => { releasePoll = resolve }),
  }))
  await new Promise((r) => setTimeout(r, 0))
  await disconnectLfm() // lands while getSession is in flight
  releasePoll({ key: 'sk-late', name: 'late' }) // the poll succeeds AFTER the disconnect
  await pending
  assert.equal(get(lastfmAuthPhase), 'idle', 'superseded flow never flips the phase')
  assert.equal(getCachedLfmSession(), null, 'the late session is discarded, not resurrected')
})

// Pins the fire-and-forget queue persistence helper (A3, 2026-10-09): a failed
// Dexie write must never throw into the store updater, and it must be NAMED
// once per call site per session — the 2026-10-08 dump had 20 unhandled
// AbortError rejections and no line to attribute them to.

import './stub-audio-worklet-node'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/lib/db'
import { persistQueue } from '../src/lib/queuePersistence'
import { clearJsDebugEvents, jsDebugEventsSnapshot } from '../src/lib/debugLog'

// Dexie tables share one prototype (the tests/seekEpochsKillSwitch.test.ts
// pattern): patching `put` once makes every `saveQueue` in this file fail while
// `fail` is true. Node runs each test FILE in its own process, so nothing else
// is affected.
let fail = true
Object.getPrototypeOf(db.playQueue).put = (async () => {
  if (fail) throw Object.assign(new Error('the transaction was aborted'), { name: 'AbortError' })
}) as never

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const queueRow = { userQueue: ['a'], autoQueue: [], recentTrackIds: [], activeIndex: 0 }
const failures = () =>
  jsDebugEventsSnapshot().filter((e) => e.domain === 'sync' && e.msg.includes('queue persist failed'))

test('persistQueue names the first failure per source, once, and never throws', async () => {
  clearJsDebugEvents()
  assert.doesNotThrow(() => persistQueue('markRecent', queueRow), 'a failed write is not a playback failure')
  assert.doesNotThrow(() => persistQueue('markRecent', queueRow))
  await settle()
  await settle()
  const entries = failures()
  assert.equal(entries.length, 1, 'one failure line per source per session')
  assert.match(entries[0].msg, /queue persist failed \(markRecent\): AbortError/)
  assert.match(entries[0].msg, /in-memory queue unchanged/)
  assert.match(entries[0].msg, /further markRecent failures suppressed this session/)

  assert.doesNotThrow(() => persistQueue('playAll', queueRow))
  await settle()
  await settle()
  const both = failures()
  assert.equal(both.length, 2, 'a different call site still reports its own first failure')
  assert.match(both[1].msg, /queue persist failed \(playAll\)/)
})

test('persistQueue stays silent when the write succeeds', async () => {
  fail = false
  clearJsDebugEvents()
  persistQueue('selectTrack', queueRow)
  await settle()
  await settle()
  assert.equal(failures().length, 0)
})

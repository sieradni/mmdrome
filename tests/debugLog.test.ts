import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dbg,
  dbgAlways,
  dbgDanger,
  jsDebugEventsSnapshot,
  clearJsDebugEvents,
  setEnabledDomains,
  isDebugEnabled,
  enabledDomainsList,
} from '../src/lib/debugLog'

const hasLocalStorage = typeof localStorage !== 'undefined'

test('debug entries are recorded only for enabled domains', () => {
  clearJsDebugEvents()
  setEnabledDomains([])
  dbg('tags', 'silent — domain off')
  assert.equal(jsDebugEventsSnapshot().length, 0)
  setEnabledDomains(['tags'])
  assert.equal(isDebugEnabled('tags'), true)
  dbg('tags', 'now recorded')
  const events = jsDebugEventsSnapshot()
  assert.equal(events.length, 1)
  assert.equal(events[0].domain, 'tags')
  assert.equal(events[0].level, 'debug')
  assert.equal(events[0].msg, 'now recorded')
})

test('info and danger entries always record regardless of domains', () => {
  clearJsDebugEvents()
  setEnabledDomains([])
  dbgAlways('sync', 'plan transition')
  dbgDanger('tags', 'heal eviction')
  assert.deepEqual(jsDebugEventsSnapshot().map((e) => e.level), ['info', 'danger'])
  assert.equal(isDebugEnabled('engine'), false, 'danger/info record WITHOUT enabling the domain')
})

test('the ring is hard-capped from the oldest side', () => {
  clearJsDebugEvents()
  setEnabledDomains(['tags'])
  for (let i = 0; i < 450; i++) dbg('tags', `e${i}`)
  const events = jsDebugEventsSnapshot()
  assert.ok(events.length <= 400)
  assert.equal(events[events.length - 1].msg, 'e449')
})

if (hasLocalStorage) {
  test('setEnabledDomains persists and reads back', () => {
    const effective = setEnabledDomains(['loader', 'crossfade', 'tags'])
    assert.deepEqual(enabledDomainsList(), effective)
    assert.equal(isDebugEnabled('loader'), true)
    assert.equal(isDebugEnabled('engine'), false)
    setEnabledDomains([])
  })
}

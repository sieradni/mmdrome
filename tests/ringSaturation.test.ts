import test from 'node:test'
import assert from 'node:assert/strict'
import { formatRingSaturationLine, coalescedDebugOf, debugEvictedForHeadroomOf } from '../src/lib/ringSaturation'

test('D-03: ring saturation line carries the coalesce + headroom counters', () => {
  assert.equal(
    formatRingSaturationLine({ dropped: 3, coalescedDebug: 12, debugEvictedForHeadroom: 4 }),
    'ring dropped 3 · coalesced 12 · headroom-evict 4',
  )
})

test('D-03: counters default to 0 when the native fields are absent', () => {
  assert.equal(coalescedDebugOf({ dropped: 1 }), 0)
  assert.equal(debugEvictedForHeadroomOf({ dropped: 1 }), 0)
  assert.equal(
    formatRingSaturationLine({ dropped: 1, coalescedDebug: 0, debugEvictedForHeadroom: 0 }),
    'ring dropped 1 · coalesced 0 · headroom-evict 0',
  )
})

test('D-03: both counters are included when either is present', () => {
  const line = formatRingSaturationLine({ dropped: 2, coalescedDebug: 5 })
  assert.match(line, /coalesced 5/)
  assert.match(line, /headroom-evict 0/)
})

test('D-03: line degrades to dropped-only on older native builds', () => {
  assert.equal(formatRingSaturationLine({ dropped: 7 }), 'ring dropped 7')
})

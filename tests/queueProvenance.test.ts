// Pins the pure fill-provenance mirror (queueProvenance.ts): fresh fill wins,
// kept rows retain their tier, non-fill rows are `unknown`, departed ids are
// pruned, and the dump groups render in QUEUE order. The map is module state —
// every test resets it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  syncFillProvenance,
  fillTierOf,
  fillProvenanceGroups,
  resetFillProvenance,
  type FillTiers,
} from '../src/lib/queueProvenance'

const tiers = (t1: string[] = [], t2: string[] = [], t3: string[] = []): FillTiers => ({ 1: t1, 2: t2, 3: t3 })

test('a fill assigns each sliced row its tier', () => {
  resetFillProvenance()
  syncFillProvenance(['f1', 'c1', 'r1'], tiers(['f1'], ['c1'], ['r1']))
  assert.equal(fillTierOf('f1'), 1)
  assert.equal(fillTierOf('c1'), 2)
  assert.equal(fillTierOf('r1'), 3)
})

test('a kept-prefix row retains its older tier; a re-admitted row takes the LATEST tier', () => {
  resetFillProvenance()
  // First fill: t was fresh (tier 1).
  syncFillProvenance(['t', 'f1'], tiers(['t', 'f1']))
  assert.equal(fillTierOf('t'), 1)
  // Later fill: t survives as kept (not in the fresh stages) — tier stays 1.
  syncFillProvenance(['t', 'c2'], tiers([], ['c2']))
  assert.equal(fillTierOf('t'), 1, 'kept row keeps its original tier')
  assert.equal(fillTierOf('c2'), 2)
  // t leaves the queue (plays out), comes back via tier 3 later — LATEST wins.
  syncFillProvenance(['c2'], tiers())
  assert.equal(fillTierOf('t'), null, 'a departed id is pruned')
  syncFillProvenance(['c2', 't'], tiers([], [], ['t']))
  assert.equal(fillTierOf('t'), 3, 're-admission re-tiers')
})

test('ids no longer queued are dropped (the map never outlives the queue)', () => {
  resetFillProvenance()
  syncFillProvenance(['a', 'b'], tiers(['a', 'b']))
  syncFillProvenance(['a'], tiers())
  assert.equal(fillTierOf('a'), 1)
  assert.equal(fillTierOf('b'), null, 'removed row pruned at the next sync')
})

test('dump groups render in QUEUE order with unknown for non-fill rows', () => {
  resetFillProvenance()
  syncFillProvenance(['f', 'c', 'r'], tiers(['f'], ['c'], ['r']))
  // 'x' entered the auto section without a fill (restore / drag-convert).
  const groups = fillProvenanceGroups(['r', 'x', 'f', 'y', 'c'])
  assert.deepEqual(groups[3], ['r'])
  assert.deepEqual(groups.unknown, ['x', 'y'])
  assert.deepEqual(groups[1], ['f'])
  assert.deepEqual(groups[2], ['c'])
})

test('unknown rows are honestly unknown: no entry is ever invented', () => {
  resetFillProvenance()
  const groups = fillProvenanceGroups(['never', 'filled'])
  assert.deepEqual(groups.unknown, ['never', 'filled'])
  assert.deepEqual(groups[1], [])
  assert.deepEqual(groups[2], [])
  assert.deepEqual(groups[3], [])
})

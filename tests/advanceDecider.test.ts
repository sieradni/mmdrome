import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideAdvance, type AdvanceDecision, type AdvanceDecisionInput } from '../src/lib/playbackCore/advanceDecider'

function input(over: Partial<AdvanceDecisionInput> = {}): AdvanceDecisionInput {
  return { fromError: false, parkArmed: false, loopMode: 'none', hasNext: false, hasUserQueue: false, ...over }
}

interface Row {
  name: string
  input: AdvanceDecisionInput
  expected: AdvanceDecision
}

const rows: Row[] = [
  // Park beats everything when armed and not error-driven (loop mode and queue
  // state are irrelevant — 12 combos collapse to one behavior).
  { name: 'park beats loop-one', input: input({ parkArmed: true, loopMode: 'one', hasNext: true }), expected: 'park' },
  { name: 'park beats advance', input: input({ parkArmed: true, loopMode: 'none', hasNext: true }), expected: 'park' },
  { name: 'park beats wrap', input: input({ parkArmed: true, loopMode: 'all', hasNext: false, hasUserQueue: true }), expected: 'park' },
  { name: 'park beats stop', input: input({ parkArmed: true, loopMode: 'none', hasNext: false }), expected: 'park' },

  // fromError skips the park entirely.
  { name: 'error-driven park is skipped — advances', input: input({ fromError: true, parkArmed: true, loopMode: 'none', hasNext: true }), expected: 'advance' },
  { name: 'error-driven park is skipped — loop-one restarts', input: input({ fromError: true, parkArmed: true, loopMode: 'one', hasNext: false }), expected: 'restart' },
  { name: 'error-driven park is skipped — stop at end', input: input({ fromError: true, parkArmed: true, loopMode: 'none', hasNext: false }), expected: 'stop' },

  // Loop-one restarts regardless of queue state (park already excluded above).
  { name: 'loop-one restarts with a next row', input: input({ loopMode: 'one', hasNext: true }), expected: 'restart' },
  { name: 'loop-one restarts at the queue end', input: input({ loopMode: 'one', hasNext: false }), expected: 'restart' },

  // Advance when a next row exists.
  { name: 'loop-none advances', input: input({ loopMode: 'none', hasNext: true }), expected: 'advance' },
  { name: 'loop-all advances while rows remain', input: input({ loopMode: 'all', hasNext: true, hasUserQueue: true }), expected: 'advance' },

  // Wrap only when loop-all AND a user queue exists.
  { name: 'loop-all wraps to the first user row', input: input({ loopMode: 'all', hasNext: false, hasUserQueue: true }), expected: 'wrap' },
  { name: 'loop-all stops on an empty user queue', input: input({ loopMode: 'all', hasNext: false, hasUserQueue: false }), expected: 'stop' },

  // Stop when nothing follows.
  { name: 'loop-none stops at the queue end', input: input({ loopMode: 'none', hasNext: false }), expected: 'stop' },
  { name: 'loop-none stops with hasUserQueue (wrap needs loop-all)', input: input({ loopMode: 'none', hasNext: false, hasUserQueue: true }), expected: 'stop' },
]

for (const r of rows) {
  test(`advanceDecider: ${r.name}`, () => {
    assert.equal(decideAdvance(r.input), r.expected)
  })
}

test('advanceDecider: input object is never mutated', () => {
  const before = input({ parkArmed: true, loopMode: 'all', hasNext: true, hasUserQueue: true })
  const snapshot = { ...before }
  decideAdvance(before)
  assert.deepEqual(before, snapshot)
})

test('advanceDecider: full cross-product never throws and stays in the ADT', () => {
  const loopModes: AdvanceDecisionInput['loopMode'][] = ['none', 'one', 'all']
  const booleans = [true, false]
  const valid = new Set<AdvanceDecision>(['park', 'restart', 'advance', 'wrap', 'stop'])
  for (const fromError of booleans) {
    for (const parkArmed of booleans) {
      for (const loopMode of loopModes) {
        for (const hasNext of booleans) {
          for (const hasUserQueue of booleans) {
            const d = decideAdvance({ fromError, parkArmed, loopMode, hasNext, hasUserQueue })
            assert.ok(valid.has(d), `unexpected decision ${d} for ${JSON.stringify({ fromError, parkArmed, loopMode, hasNext, hasUserQueue })}`)
          }
        }
      }
    }
  }
})
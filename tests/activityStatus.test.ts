import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveActivityStatus, type ActivityStatusInput } from '../src/lib/activityStatus'

function baseInput(over: Partial<ActivityStatusInput> = {}): ActivityStatusInput {
  return {
    navChecking: false,
    navLoading: false,
    navCached: false,
    navError: undefined,
    scanStatus: 'idle',
    scanScanned: 0,
    scanTotal: 0,
    probeActive: false,
    probeDone: 0,
    probeRemaining: 0,
    pushActive: false,
    pushDone: 0,
    pushTotal: 0,
    ...over,
  }
}

test('deriveActivityStatus: returns null when idle and healthy', () => {
  assert.equal(deriveActivityStatus(baseInput()), null)
})

test('deriveActivityStatus: pushActive takes highest precedence with progress', () => {
  const res = deriveActivityStatus(baseInput({
    pushActive: true,
    pushDone: 3,
    pushTotal: 10,
    scanStatus: 'scanning',
    scanScanned: 5,
    scanTotal: 20,
  }))
  assert.deepEqual(res, {
    kind: 'pushing',
    label: 'Writing tags to files (3/10)…',
    progressPct: 30,
    targetTab: 'library',
  })
})

test('deriveActivityStatus: navChecking and navLoading report server/library loading', () => {
  assert.deepEqual(
    deriveActivityStatus(baseInput({ navChecking: true })),
    {
      kind: 'loading-library',
      label: 'Connecting to server…',
      progressPct: null,
      targetTab: 'sources',
    },
  )
  assert.deepEqual(
    deriveActivityStatus(baseInput({ navLoading: true })),
    {
      kind: 'loading-library',
      label: 'Loading library…',
      progressPct: null,
      targetTab: 'sources',
    },
  )
})

test('deriveActivityStatus: scanning reports progress and percentage', () => {
  assert.deepEqual(
    deriveActivityStatus(baseInput({ scanStatus: 'scanning', scanScanned: 25, scanTotal: 100 })),
    {
      kind: 'scanning',
      label: 'Scanning file tags (25/100)…',
      progressPct: 25,
      targetTab: 'library',
    },
  )
})

test('deriveActivityStatus: background tag probe reports done / total', () => {
  assert.deepEqual(
    deriveActivityStatus(baseInput({ probeActive: true, probeDone: 15, probeRemaining: 45 })),
    {
      kind: 'probing',
      label: 'Reading file tags (15/60)…',
      progressPct: 25,
      targetTab: 'library',
    },
  )
})

test('deriveActivityStatus: cached fallback with connection error reports offline cached state', () => {
  assert.deepEqual(
    deriveActivityStatus(baseInput({ navCached: true, navError: 'Network error' })),
    {
      kind: 'cached-offline',
      label: 'Offline — browsing cached library',
      progressPct: null,
      targetTab: 'sources',
    },
  )
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compareVersions,
  manifestBackfillState,
  findVersionEntry,
  manifestHasSize,
  planBackfill,
  planDeploy,
  deriveReleasePhase,
  stateRecordValid,
  PHASE_ORDER,
} from '../scripts/releasePhaseCore.mjs'
import type { ReleaseFacts } from '../scripts/releasePhaseCore.mjs'

// ── compareVersions (NUMERIC — string-compare calls 1.2.10 < 1.2.9) ────────

test('compareVersions: numeric compare, not string compare', () => {
  assert.equal(compareVersions('1.2.9', '1.2.10'), 'greater')
  assert.equal(compareVersions('1.2.35', '1.2.36'), 'greater')
  assert.equal(compareVersions('1.2.36', '1.2.36'), 'equal')
  assert.equal(compareVersions('1.3.0', '1.2.36'), 'lower')
})

// ── manifestBackfillState (SideStore hard-fails sizeless/wrong entries) ────

test('manifestBackfillState: the four states', () => {
  assert.equal(manifestBackfillState(undefined, '1.2.36', 100), 'absent')
  assert.equal(manifestBackfillState({ version: '1.2.35', size: 99 }, '1.2.36', 100), 'absent')
  assert.equal(manifestBackfillState({ version: '1.2.36' }, '1.2.36', 100), 'sizeless')
  assert.equal(manifestBackfillState({ version: '1.2.36', size: 99 }, '1.2.36', 100), 'wrong-size')
  assert.equal(manifestBackfillState({ version: '1.2.36', size: 100 }, '1.2.36', 100), 'correct')
})

// ── findVersionEntry / manifestHasSize (shape-tolerant remote-JSON read) ────

const manifest = (versions: unknown[]) => ({ apps: [{ versions }] })

test('findVersionEntry: picks the right entry, tolerates malformed shapes', () => {
  const m = manifest([{ version: '1.2.36', size: 100 }, { version: '1.2.35', size: 90 }])
  assert.deepEqual(findVersionEntry(m, '1.2.36'), { version: '1.2.36', size: 100 })
  assert.equal(findVersionEntry(m, '9.9.9'), undefined)
  // Foreign / truncated JSON must read as "no entry", never throw.
  assert.equal(findVersionEntry(null, '1.2.36'), undefined)
  assert.equal(findVersionEntry({}, '1.2.36'), undefined)
  assert.equal(findVersionEntry({ apps: [] }, '1.2.36'), undefined)
  assert.equal(findVersionEntry({ apps: [{ versions: null }] }, '1.2.36'), undefined)
  assert.equal(findVersionEntry(manifest([null, { version: '1.2.36', size: 1 }]), '1.2.36')?.size, 1)
})

test('manifestHasSize: only the exact published size counts', () => {
  assert.equal(manifestHasSize(manifest([{ version: '1.2.36', size: 100 }]), '1.2.36', 100), true)
  assert.equal(manifestHasSize(manifest([{ version: '1.2.36', size: 99 }]), '1.2.36', 100), false)
  assert.equal(manifestHasSize(manifest([{ version: '1.2.36' }]), '1.2.36', 100), false)
  assert.equal(manifestHasSize(manifest([{ version: '1.2.35', size: 100 }]), '1.2.36', 100), false)
})

// ── planBackfill / planDeploy (E11a: CI's finalize job owns the post-tag work)

test('planBackfill: CI already stamped the size → reconcile, never duplicate', () => {
  // The race that aborted 1.2.46/1.2.47/1.2.53: the local backfill pushed a
  // commit CI had already pushed, and the non-fast-forward killed the run.
  assert.equal(planBackfill({ originHasSize: true }), 'reconcile')
  // CI did NOT stamp it → the local fallback (which rebases before pushing).
  assert.equal(planBackfill({ originHasSize: false }), 'local-backfill')
})

test('planDeploy: skip the redundant deploy when the mirror already serves it', () => {
  assert.equal(planDeploy({ mirrorServes: true }), 'skip')
  assert.equal(planDeploy({ mirrorServes: false }), 'deploy')
})

// ── stateRecordValid (the state file accelerates, never overrides) ─────────

test('stateRecordValid: sha must match exactly', () => {
  assert.equal(stateRecordValid(undefined, 'abc'), false)
  assert.equal(stateRecordValid({ sha: 'abc' }, 'abc'), true)
  assert.equal(stateRecordValid({ sha: 'abd' }, 'abc'), false)
})

// ── deriveReleasePhase ─────────────────────────────────────────────────────

const base = (over: Partial<ReleaseFacts> = {}): ReleaseFacts => ({
  cleanTree: true,
  pkgVersion: '1.2.36',
  targetVersion: '1.2.36',
  tagExists: false,
  headPushed: true,
  branchCiGreen: true,
  tagRunGreen: null,
  releasePublished: false,
  assetSize: null,
  manifestState: 'absent',
  surfacesCurrent: false,
  gatesRanForHead: true,
  ...over,
})

test('dirty tree is ignored post-tag, honored pre-tag', () => {
  // Post-tag, a dirty tree is NORMAL (verify-phase scratch, leftover logs):
  // the tag branch dominates and converged surfaces are simply done.
  const d = deriveReleasePhase(base({ cleanTree: false, pkgVersion: '1.2.36', tagExists: true, releasePublished: true, assetSize: 500, manifestState: 'correct', surfacesCurrent: true }))
  assert.equal(d.phase, 'done')
  // Pre-tag: dirty tree is the FIRST answer — a bump must never be cut on a
  // dirty tree (release-full's Phase 0).
  const d2 = deriveReleasePhase(base({ cleanTree: false, tagExists: false }))
  assert.equal(d2.phase, 'preflight')
})

test('lower target version aborts at preflight', () => {
  const d = deriveReleasePhase(base({ pkgVersion: '1.2.36', targetVersion: '1.2.35' }))
  assert.equal(d.phase, 'preflight')
})

test('fresh release: gates → bump → branch-ci → tag, in order', () => {
  // Unapplied version + gates not recorded → gates first.
  const g = deriveReleasePhase(base({ pkgVersion: '1.2.35', headPushed: true, gatesRanForHead: false }))
  assert.equal(g.phase, 'gates')
  // Gates recorded → bump (version not yet applied).
  const b = deriveReleasePhase(base({ pkgVersion: '1.2.35', headPushed: true }))
  assert.equal(b.phase, 'bump')
  // Bumped but unpushed → still bump (push leg).
  const p = deriveReleasePhase(base({ headPushed: false }))
  assert.equal(p.phase, 'bump')
  // Pushed, green → tag.
  const t = deriveReleasePhase(base({}))
  assert.equal(t.phase, 'tag')
  assert.match(t.reason, /tag solo/)
})

test('CRITICAL: a pushed, CI-green HEAD at the OLD version cannot be tagged', () => {
  // The 1.2.36 mid-build trap: every world fact looks ready, but package.json
  // is still at the previous version — tagging here would tag the wrong tree.
  const d = deriveReleasePhase(base({ pkgVersion: '1.2.35', targetVersion: '1.2.36', headPushed: true, branchCiGreen: true }))
  assert.equal(d.phase, 'bump')
})

test('branch CI states map correctly', () => {
  const red = deriveReleasePhase(base({ branchCiGreen: false }))
  assert.equal(red.phase, 'branch-ci')
  const pending = deriveReleasePhase(base({ branchCiGreen: null }))
  assert.equal(pending.phase, 'branch-ci')
})

test('tag exists dominates: poll the tag run pre-publish', () => {
  const d = deriveReleasePhase(base({ tagExists: true, releasePublished: false }))
  assert.equal(d.phase, 'tag')
})

test('published but surfaces not converged → verify (the finalize-wait)', () => {
  const sizeless = deriveReleasePhase(base({ tagExists: true, releasePublished: true, assetSize: 500, manifestState: 'sizeless', surfacesCurrent: false }))
  assert.equal(sizeless.phase, 'verify')
  const staleSurf = deriveReleasePhase(base({ tagExists: true, releasePublished: true, assetSize: 500, manifestState: 'correct', surfacesCurrent: false }))
  assert.equal(staleSurf.phase, 'verify')
})

test('done requires EVERY surface: manifest correct AND both CDNs current', () => {
  const d = deriveReleasePhase(base({ tagExists: true, releasePublished: true, assetSize: 500, manifestState: 'correct', surfacesCurrent: true }))
  assert.equal(d.phase, 'done')
  // A correct manifest with one stale CDN is NOT done.
  const half = deriveReleasePhase(base({ tagExists: true, releasePublished: true, assetSize: 500, manifestState: 'correct', surfacesCurrent: false }))
  assert.equal(half.phase, 'verify')
})

test('PHASE_ORDER is the documented execution order', () => {
  assert.deepEqual(PHASE_ORDER, ['preflight', 'gates', 'bump', 'branch-ci', 'tag', 'verify'])
})

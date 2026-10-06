/**
 * Pure release-phase derivation (F2: no I/O, no side effects — pinned by
 * tests/releasePhaseCore.test.ts). The driver (scripts/release-phases.mjs)
 * reads the world (git, gh, the live surfaces), turns it into ReleaseFacts,
 * and this core decides WHICH phase runs next. Resumability lives here: the
 * same world state always derives the same next action, so an interrupted
 * release resumes by re-deriving — no imperative playback of steps, no
 * reliance on a state file being truthful.
 *
 * Ground rules encoded from AGENTS.md E11/E11a (each carries its why):
 * - The tag gates everything downstream: once it exists, branch CI and the
 *   bump are finished concerns even if a state file was lost.
 * - A published release means the tag run (build + publish + finalize)
 *   completed; the only remaining work is independent verification.
 * - The release is DONE only when all four surfaces agree (E11a contract):
 *   GitHub Release asset, manifest on origin/main, jsDelivr, Pages mirror.
 * - Version bumps are idempotent (release-ios.mjs same-version re-run
 *   preserves build/date), so "bump" is the right answer whenever HEAD is
 *   not on origin — re-running it is safe and commits nothing when clean.
 */

/** The phases in execution order. A release drives these top to bottom;
 *  deriveReleasePhase jumps straight to wherever the world says we are. */
export const PHASE_ORDER = ['preflight', 'gates', 'bump', 'branch-ci', 'tag', 'verify']

/**
 * @param {string} pkgVersion   version currently in package.json
 * @param {string} targetVersion  the version being released
 * @returns {'greater'|'equal'|'lower'} NUMERIC comparison (string-compare
 *  would call 1.2.10 lower than 1.2.9). Equal is allowed: the bump step is
 *  idempotent (re-run tolerance, 2026-09-15).
 */
export function compareVersions(pkgVersion, targetVersion) {
  const cmp = (v) => v.split('.').map(Number)
  const [pn, pj, pk] = cmp(pkgVersion)
  const [tn, tj, tk] = cmp(targetVersion)
  if (tn > pn || (tn === pn && tj > pj) || (tn === pn && tj === pj && tk > pk)) return 'greater'
  if (tn === pn && tj === pj && tk === pk) return 'equal'
  return 'lower'
}

/**
 * @param {{version: string, size?: number}|undefined} entry  the manifest's
 *        newest versions[] entry (parsed apps.json)
 * @param {string} version  the version being released
 * @param {number} assetSize  the published mmdrome.ipa byte size
 * @returns {'correct'|'absent'|'sizeless'|'wrong-size'}
 *   SideStore hard-fails a sizeless or wrong-size entry (E11 2026-09-10), so
 *   only 'correct' counts as shipped.
 */
export function manifestBackfillState(entry, version, assetSize) {
  if (!entry || entry.version !== version) return 'absent'
  if (typeof entry.size !== 'number') return 'sizeless'
  return entry.size === assetSize ? 'correct' : 'wrong-size'
}

/**
 * @param {any} manifest  a parsed `sidestore/apps.json`
 * @param {string} version
 * @returns {object|undefined} the `apps[0].versions[]` entry for `version`.
 *   Shape-tolerant: a malformed/foreign manifest reads as "no entry" instead
 *   of throwing — the driver inspects remote JSON it did not write.
 */
export function findVersionEntry(manifest, version) {
  return (manifest?.apps?.[0]?.versions ?? []).find((v) => v?.version === version)
}

/**
 * Does a parsed manifest already carry `version` at the EXACT published size?
 * Composes `manifestBackfillState`, so "the manifest is correct" has ONE
 * definition across both drivers.
 */
export function manifestHasSize(manifest, version, assetSize) {
  return manifestBackfillState(findVersionEntry(manifest, version), version, assetSize) === 'correct'
}

/**
 * Phase-6 write plan (release-full). E11a: the tag run's `finalize-release`
 * job OWNS the manifest backfill — it stamps the size, commits to main,
 * deploys gh-pages, purges jsDelivr and verifies the surfaces. When
 * origin/main already carries the finalized size the local driver must
 * RECONCILE (fast-forward onto CI's commit), never run its own backfill +
 * push: two writers to one branch is the documented 1.2.32 bug shape, and the
 * rejected push aborted every release before 2026-10-04 (1.2.46, 1.2.47,
 * 1.2.53). `local-backfill` is the fallback for when CI did NOT stamp it
 * (older CI, a skipped job, a step that failed without failing the run).
 *
 * @param {{originHasSize: boolean}} f
 * @returns {'reconcile'|'local-backfill'}
 */
export function planBackfill({ originHasSize }) {
  return originHasSize ? 'reconcile' : 'local-backfill'
}

/**
 * Phase-7 deploy plan (release-full). The finalize job already ran the SAME
 * `npm run deploy`; re-running it is an identical gh-pages push. Skip it when
 * the mirror already serves version + size, and fall back to the local deploy
 * otherwise (mirror unreachable or stale).
 *
 * @param {{mirrorServes: boolean}} f
 * @returns {'skip'|'deploy'}
 */
export function planDeploy({ mirrorServes }) {
  return mirrorServes ? 'skip' : 'deploy'
}

/**
 * The world facts the driver gathered. Every field is derived from git/gh/
 * live HTTP — never from a state file — except `gatesRanForHead`, which the
 * state file provides (there is no world artifact for "tests already ran").
 * `null` means "not yet determinable / nothing observed" (no run found).
 *
 * @typedef {object} ReleaseFacts
 * @property {boolean} cleanTree
 * @property {string} pkgVersion
 * @property {string} targetVersion
 * @property {boolean} tagExists         local OR remote (preflight fetches)
 * @property {boolean} headPushed        origin/main contains HEAD
 * @property {boolean|null} branchCiGreen  both workflows succeeded on HEAD
 * @property {boolean|null} tagRunGreen    the tag's iOS run succeeded
 * @property {boolean} releasePublished  not draft, mmdrome.ipa asset present
 * @property {number|null} assetSize
 * @property {'correct'|'absent'|'sizeless'|'wrong-size'} manifestState
 * @property {boolean} surfacesCurrent   jsDelivr AND Pages mirror serve
 *                                       version + the asset size
 * @property {boolean} gatesRanForHead   state-file record for THIS head sha
 */

/**
 * Derive the next phase to run.
 *
 * @param {ReleaseFacts} f
 * @returns {{phase: string, reason: string}} phase is one of PHASE_ORDER or
 *   'done'; reason is a human-readable justification for the decision.
 */
export function deriveReleasePhase(f) {
  const verCmp = compareVersions(f.pkgVersion, f.targetVersion)
  if (verCmp === 'lower') {
    return { phase: 'preflight', reason: `${f.targetVersion} is lower than the current ${f.pkgVersion}` }
  }
  // The tag is the point of no return: everything after it exists on the
  // remote regardless of local state — including local tree dirt, which is
  // normal during the verify phase and must not block surface checking.
  if (f.tagExists) {
    if (!f.releasePublished) {
      return { phase: 'tag', reason: 'tag exists but the release has not published — poll the tag run' }
    }
    if (f.manifestState !== 'correct' || !f.surfacesCurrent) {
      return { phase: 'verify', reason: 'release published — verifying the four surfaces (finalize backfill/deploy may still be running)' }
    }
    return { phase: 'done', reason: `all surfaces serve ${f.targetVersion} with the published asset size` }
  }
  if (!f.cleanTree) {
    return { phase: 'preflight', reason: 'working tree is dirty — commit or stash first' }
  }
  // Gates run before anything mutable leaves the machine (release-full's
  // order). Keyed to the CURRENT head: the first invocation gates the
  // pre-bump tree; after the bump commit, the sha differs and gates re-run
  // on the exact tree that will be tagged (cheap, and stricter).
  if (!f.gatesRanForHead) {
    return { phase: 'gates', reason: 'gates (check + test + smoke) have not run for this head' }
  }
  // An unapplied version (pkg still at the previous release) must force the
  // bump — otherwise a pushed, CI-green HEAD with no release commit would
  // fall through to 'tag' and tag the WRONG tree.
  if (verCmp !== 'equal') {
    return { phase: 'bump', reason: `${f.targetVersion} is not applied to the tree (package.json at ${f.pkgVersion})` }
  }
  if (!f.headPushed) {
    // The release commit exists locally but is not on origin — the bump
    // phase's push leg finishes it (idempotent: nothing to re-commit).
    return { phase: 'bump', reason: 'release commit is not on origin/main' }
  }
  if (f.branchCiGreen !== true) {
    return { phase: 'branch-ci', reason: f.branchCiGreen === false ? 'branch CI concluded non-success' : 'branch CI not yet green' }
  }
  // Tag only after branch CI is green (E11: the concurrency group would
  // cancel a tag run that rides along with a branch push; a red branch run
  // must never be promoted by tagging).
  return { phase: 'tag', reason: 'branch CI green — tag solo and wait for the tag run' }
}

/**
 * Which recorded-phase entries are still valid for the CURRENT run. A state
 * file accelerates re-runs (skip gates) but never overrides the world: the
 * sha it recorded must match, and world-derived phases above always win.
 *
 * @param {{sha?: string}|undefined} record
 * @param {string} currentSha
 * @returns {boolean}
 */
export function stateRecordValid(record, currentSha) {
  return !!record && record.sha === currentSha
}

// ── SideStore surface verification (2026-10-06) ────────────────────────────
//
// The finalize job used to sample the CDN surfaces for a fixed 10 × 15 s. A
// queued GitHub Pages deployment routinely outlasts that: 1.2.55's mirror
// build sat QUEUED for 25+ minutes and the finalize failed a release that was
// in fact complete. The wait now keys on the Pages build for the deployed
// gh-pages commit, so "the CDN has not caught up yet" is a WAIT and only "the
// deployment is done (or stuck) and the surface still serves the old release"
// is a FAIL. Both states stay bounded, and the fail reasons stay loud.

/**
 * The Pages build state for one commit, from a `repos/{o}/{r}/pages/builds`
 * list. `pending` also covers "the build is not listed yet" and a malformed
 * payload — both mean "keep waiting, bounded", never "assume success".
 *
 * @param {unknown} builds  the parsed pages/builds response
 * @param {string|undefined} commit  the deployed gh-pages commit
 * @returns {'pending'|'built'|'errored'}
 */
export function pagesStateForCommit(builds, commit) {
  if (!Array.isArray(builds) || !commit) return 'pending'
  const build = builds.find((b) => b && b.commit === commit)
  if (!build) return 'pending'
  if (build.status === 'built') return 'built'
  if (build.status === 'errored') return 'errored'
  return 'pending'
}

/**
 * The next action for the surface wait, from one poll tick's observations.
 *
 * @param {{pendingSurfaces: string[], pagesState: string, elapsedMs: number,
 *   pagesBuiltElapsedMs: number|null, pagesTimeoutMs: number,
 *   convergeTimeoutMs: number}} obs
 * @returns {{action: 'pass'|'wait'|'fail', reason: string}}
 */
export function decideSurfaceVerification(obs) {
  const pending = obs.pendingSurfaces ?? []
  if (pending.length === 0) return { action: 'pass', reason: 'every surface serves the release' }
  const names = pending.join(', ')
  if (obs.pagesState === 'errored') {
    return { action: 'fail', reason: `the Pages deployment errored and ${names} still serve the old release` }
  }
  if (obs.pagesState === 'built') {
    // The deployment finished — only the CDN-propagation window applies now.
    // Past it the deployment is not the story any more: the surface is stale.
    const since = obs.pagesBuiltElapsedMs == null ? 0 : obs.elapsedMs - obs.pagesBuiltElapsedMs
    if (since >= obs.convergeTimeoutMs) {
      return {
        action: 'fail',
        reason: `the Pages deployment finished ${Math.round(since / 1000)}s ago but ${names} still serve the old release`,
      }
    }
    return { action: 'wait', reason: `${names} pending; the Pages deployment is built — waiting for CDN propagation` }
  }
  // pending: the deployment itself may still be queued (the 1.2.55 shape).
  if (obs.elapsedMs >= obs.pagesTimeoutMs) {
    return {
      action: 'fail',
      reason: `the Pages deployment never completed within ${Math.round(obs.pagesTimeoutMs / 1000)}s and ${names} still serve the old release`,
    }
  }
  return { action: 'wait', reason: `${names} pending; waiting for the Pages deployment` }
}

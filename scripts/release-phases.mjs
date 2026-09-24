#!/usr/bin/env node
/**
 * release-phases <x.y.z> [notes...] [--skip-gates] — the resumable,
 * phase-based release driver (the environment-portable form of
 * release-full.mjs, 2026-09-24).
 *
 * Why: release-full.mjs holds the whole pipeline in ONE process, whose CI
 * waits (12+ min) exceed terminals that cap command duration (~10 min) —
 * an interruption there kills the run and loses all progress. This driver
 * runs at most ONE phase per invocation, bounded well under that cap, and
 * is fully resumable: run it repeatedly until it prints PHASE=done.
 *
 * Resumability is DERIVED, not replayed: each invocation re-reads the world
 * (git refs, gh runs, the GitHub release, the manifest on origin/main, the
 * live CDN/mirror surfaces) and the pure core (releasePhaseCore.mjs)
 * decides the next phase from facts, not from a recorded step index. The
 * only thing a state file records is "gates already ran for this head sha"
 * (there is no world artifact for that), and even it is ignored when the
 * world disagrees (--skip-gates exists for explicit local override only).
 *
 * Phases (one per invocation, each exits 0 on success):
 *   preflight  — clean tree + version sanity (derivation also lands here on
 *                a dirty tree: fix the tree, re-run)
 *   gates      — npm run check + npm test + the bundle smoke e2e
 *   bump       — release-ios.mjs (idempotent) → commit → push main
 *   branch-ci  — poll both workflows on HEAD; verify iOS gating steps by
 *                NAME (a fast green proves nothing, §3.5)
 *   tag        — tag SOLO + push, then poll the tag run
 *   verify     — confirm the four E11a surfaces agree; CI's finalize job
 *                does the backfill/deploy work, this phase never duplicates
 *                it — it polls until the surfaces converge (or times out)
 *   done       — all surfaces serve <version> with the published asset size
 *
 * Convergence with CI: a pushed tag is sufficient for a complete release
 * (E11a) — the finalize job backfills the manifest size, commits to main,
 * deploys the mirror and purges jsDelivr. This driver therefore never runs
 * `npm run deploy` or a local backfill; it VERIFIES those surfaces.
 */

import { execSync, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { deriveReleasePhase, manifestBackfillState, stateRecordValid, PHASE_ORDER } from './releasePhaseCore.mjs'

const args = process.argv.slice(2)
const skipGates = args.includes('--skip-gates')
if (skipGates) args.splice(args.indexOf('--skip-gates'), 1)
const [version, ...noteWords] = args
const notes = noteWords.join(' ')
const STATE_PATH = '.release-phase-state.json'

const log = (m) => console.log(m)
const die = (m) => { console.error(`✗ ${m}`); process.exit(1) }
const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts })
const out = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim()
/** GitHub API via the gh CLI (handles auth; short-lived, no token handling). */
const ghApi = (path) => JSON.parse(out(`gh api ${JSON.stringify(path)}`))

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) die('usage: node scripts/release-phases.mjs <x.y.z> [notes...] [--skip-gates]')

// ── Gather world facts ─────────────────────────────────────────────────────
// Every fact is observed fresh. `null` = nothing observed yet.

function facts() {
  const f = { targetVersion: version }
  f.cleanTree = out('git status --porcelain') === ''
  f.pkgVersion = JSON.parse(readFileSync('package.json', 'utf8')).version
  out('git fetch origin --tags --quiet') // tag check must see remote-only tags
  // execSync THROWS on non-zero exit — a missing tag / not-ancestor is a
  // FALSE, not a crash. Both checks must catch.
  let localTag = false
  try { execSync(`git rev-parse -q --verify refs/tags/ios-v${version}`, { stdio: 'ignore' }); localTag = true } catch { /* absent */ }
  const remoteTag = out(`git ls-remote --tags origin refs/tags/ios-v${version}`) !== ''
  f.tagExists = localTag || remoteTag
  const localSha = out('git rev-parse HEAD')
  out('git fetch origin main --quiet')
  let headPushed = true
  try { execSync('git merge-base --is-ancestor HEAD origin/main', { stdio: 'ignore' }) } catch { headPushed = false }
  f.headPushed = headPushed

  const branchRuns = f.headPushed
    ? ghApi(`/repos/{owner}/{repo}/actions/runs?head_sha=${localSha}&per_page=20`).workflow_runs ?? []
    : []
  const tests = branchRuns.find((r) => /test/i.test(r.name) && r.head_branch !== `ios-v${version}`)
  const ios = branchRuns.find((r) => /ios/i.test(r.name) && r.head_branch !== `ios-v${version}`)
  const done = (r) => r && r.status === 'completed'
  f.branchCiGreen = done(tests) && done(ios)
    ? tests.conclusion === 'success' && ios.conclusion === 'success'
    : done(tests) || done(ios) ? false : null

  if (f.tagExists) {
    const tagRuns = ghApi(`/repos/{owner}/{repo}/actions/runs?branch=ios-v${version}&per_page=10`).workflow_runs ?? []
    const tagIos = tagRuns.find((r) => /ios/i.test(r.name))
    f.tagRunGreen = done(tagIos) ? tagIos.conclusion === 'success' : null
    let release = null
    try { release = ghApi(`/repos/{owner}/{repo}/releases/tags/ios-v${version}`) } catch { /* 404 pre-publish */ }
    const asset = release?.assets?.find((a) => a.name === 'mmdrome.ipa')
    f.releasePublished = !!asset && release.draft === false
    f.assetSize = asset ? asset.size : null
    // The manifest must be checked on ORIGIN (CI's finalize commit may be
    // ahead of local). Truth lives on main, not in the working tree.
    let manifest = null
    try { manifest = JSON.parse(out(`git show origin/main:sidestore/apps.json`)) } catch { /* unreachable */ }
    f.manifestState = manifestBackfillState(manifest?.apps?.[0]?.versions?.[0], version, f.assetSize ?? 0)
    f.surfacesCurrent = false
  } else {
    f.tagRunGreen = null
    f.releasePublished = false
    f.assetSize = null
    f.manifestState = 'absent'
    f.surfacesCurrent = false
  }

  const record = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : null
  f.gatesRanForHead = stateRecordValid(record, localSha) && !!record.gatesRan
  f.localSha = localSha
  return f
}

// ── Phase implementations (each bounded; CI waits poll with deadlines) ─────

const pollRuns = async (label, queryFn, okFn) => {
  const deadline = Date.now() + 8 * 60 * 1000 // stays under the env's ~10 min cap
  while (Date.now() < deadline) {
    const value = await queryFn().catch((e) => { console.warn(`  ⚠ poll error (retrying): ${e?.message ?? e}`); return null })
    if (value !== null && okFn(value) !== undefined) return okFn(value)
    process.stdout.write('.')
    await new Promise((r) => setTimeout(r, 25_000))
  }
  die(`${label} timed out after 8 min — re-run the driver to resume`)
}

// NOTE ON POLL RESULT CONVENTIONS: each poller returns undefined to keep
// waiting, a string verdict to stop. Timeouts DIE (non-zero exit) — the
// caller re-runs the driver, which re-derives; nothing is lost.

async function phaseBranchCi(f) {
  log('polling branch CI on ' + f.localSha.slice(0, 7))
  const verdict = await pollRuns('branch CI', async () => {
    const runs = ghApi(`/repos/{owner}/{repo}/actions/runs?head_sha=${f.localSha}&per_page=20`).workflow_runs ?? []
    const tests = runs.find((r) => /test/i.test(r.name) && r.head_branch !== `ios-v${version}`)
    const ios = runs.find((r) => /ios/i.test(r.name) && r.head_branch !== `ios-v${version}`)
    if (tests?.status !== 'completed' || ios?.status !== 'completed') return undefined
    return tests.conclusion === 'success' && ios.conclusion === 'success' ? 'green' : `red (tests=${tests.conclusion} ios=${ios.conclusion})`
  }, (v) => v)
  if (verdict !== 'green') die(`branch CI ${verdict} — fix and re-run`)
  // Verify the iOS gating steps BY NAME (E11/§3.5): a green run with a
  // skipped/failed critical step must not promote a tag.
  const runs = ghApi(`/repos/{owner}/{repo}/actions/runs?head_sha=${f.localSha}&per_page=20`).workflow_runs ?? []
  const iosRun = runs.find((r) => /ios/i.test(r.name) && r.head_branch !== `ios-v${version}`)
  const jobs = ghApi(`/repos/{owner}/{repo}/actions/runs/${iosRun.id}/jobs?per_page=20`).jobs ?? []
  const steps = new Map()
  for (const j of jobs) for (const s of j.steps ?? []) steps.set(s.name, s.conclusion)
  for (const name of ['Swift package tests (pure core, macOS host)', 'Build unsigned app']) {
    if (steps.get(name) !== 'success') die(`iOS gating step not green: "${name}" (${steps.get(name) ?? 'missing'})`)
  }
  log(`  ✓ branch CI green, gating steps verified (${iosRun.id})`)
}

async function phaseTag() {
  log('tagging ios-v' + version + ' (solo push, E11)')
  // Idempotent: a resume after an interrupted tag phase finds the tag
  // already existing (locally or remote) — never re-create, just converge.
  let tagPushed = false
  try { execSync(`git rev-parse -q --verify refs/tags/ios-v${version}`, { stdio: 'ignore' }); tagPushed = true } catch { /* absent */ }
  if (!tagPushed) run(`git tag ios-v${version}`)
  if (out(`git ls-remote --tags origin refs/tags/ios-v${version}`) === '') run(`git push origin ios-v${version}`)
  else log('  tag already on origin — polling the run')
  const verdict = await pollRuns('tag run', async () => {
    const runs = ghApi(`/repos/{owner}/{repo}/actions/runs?branch=ios-v${version}&per_page=10`).workflow_runs ?? []
    const tagIos = runs.find((r) => /ios/i.test(r.name))
    if (!tagIos) return undefined
    if (tagIos.status !== 'completed') return undefined
    return tagIos.conclusion === 'success' ? 'green' : `concluded "${tagIos.conclusion}"`
  }, (v) => v)
  if (verdict !== 'green') die(`tag run ${verdict} — retry path: fix, delete + re-push the tag (E11)`)
  log('  ✓ tag run green — CI publish + finalize are now in charge')
}

async function phaseVerify(f) {
  // CI's finalize job owns backfill + deploy + purge. Poll the SURFACES;
  // never duplicate the work (E11a: two writers is the 1.2.32 bug shape).
  const deadline = Date.now() + 6 * 60 * 1000
  let assetSize = f.assetSize
  if (!assetSize) {
    const rel = await pollRuns('release', async () => {
      try {
        const r = ghApi(`/repos/{owner}/{repo}/releases/tags/ios-v${version}`)
        const a = r.assets?.find((x) => x.name === 'mmdrome.ipa')
        if (r.draft === false && a) return a.size
      } catch { /* 404 while publishing */ }
      return undefined
    }, (v) => v)
    assetSize = rel
  }
  log(`release published, mmdrome.ipa = ${assetSize} bytes — polling surfaces`)
  while (Date.now() < deadline) {
    // The finalize commit lands on origin/main WHILE we poll — re-fetch
    // every cycle or `git show origin/main:...` reads a stale manifest.
    out('git fetch origin main --quiet')
    const manifest = JSON.parse(out(`git show origin/main:sidestore/apps.json`))
    const mState = manifestBackfillState(manifest.apps[0].versions[0], version, assetSize)
    const bust = `?t=${Date.now()}`
    const served = await Promise.all([
      fetch(`https://cdn.jsdelivr.net/gh/sieradni/mmdrome@main/sidestore/apps.json${bust}`, { headers: { 'Cache-Control': 'no-cache' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`https://sieradni.github.io/mmdrome/sidestore/apps.json${bust}`, { headers: { 'Cache-Control': 'no-cache' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
    const surf = served.map((j) => j?.apps?.[0]?.versions?.[0])
    const okSurf = surf.filter((v) => v?.version === version && v?.size === assetSize).length
    log(`  manifest=${mState} jsdelivr=${surf[0]?.version ?? 'none'}/${surf[0]?.size ?? '-'} mirror=${surf[1]?.version ?? 'none'}/${surf[1]?.size ?? '-'} (${okSurf}/2 surfaces)`)
    if (mState === 'correct' && okSurf === 2) {
      log(`\nPHASE=done — ${version} shipped: release + manifest + CDN + mirror all verified (asset ${assetSize} bytes)`)
      return
    }
    await new Promise((r) => setTimeout(r, 30_000))
  }
  die('surfaces did not converge in 6 min — check the finalize job, then re-run the driver')
}

// ── Dispatch ───────────────────────────────────────────────────────────────

const f = facts()
const decision = deriveReleasePhase(f)
log(`release-phases ${version}: phase=${decision.phase} (${decision.reason})`)

switch (decision.phase) {
  case 'preflight': die(`${decision.reason} — resolve, then re-run`); break
  case 'gates': {
    if (f.gatesRanForHead && !skipGates) { log('  ✓ gates already ran for this head (state file)'); break }
    if (skipGates) log('  ⚠ --skip-gates: skipping check/test/smoke (explicit override)')
    else {
      run('npm run check')
      run('npm test')
      run('npx playwright test tests/e2e/smoke.spec.ts')
    }
    writeFileSync(STATE_PATH, JSON.stringify({ sha: f.localSha, gatesRan: true, version, at: new Date().toISOString() }))
    log('  ✓ gates green')
    break
  }
  case 'bump': {
    if (!notes) die('release notes are required for the bump phase (they land in three description fields + news)')
    if (!f.cleanTree) die('working tree is dirty — commit or stash first')
    runFileSafe(['scripts/release-ios.mjs', version, notes])
    run(`git add package.json ios/App/App.xcodeproj/project.pbxproj sidestore/apps.json`)
    if (out('git status --porcelain') !== '') {
      run(`git commit -m ${JSON.stringify(`Release ${version}: ${notes.slice(0, 72)}`)}`)
      run('git push origin main')
      log('  ✓ bump committed and pushed')
    } else {
      log('  ✓ nothing to commit (bump already committed — re-run tolerance)')
      if (!f.headPushed) { run('git push origin main'); log('  ✓ pushed') }
    }
    break
  }
  case 'branch-ci': await phaseBranchCi(f); break
  case 'tag': await phaseTag(); break
  case 'verify': await phaseVerify(f); break
  case 'done': log(`nothing to do — ${decision.reason}`); break
  default: die(`unknown phase ${decision.phase} (known: ${PHASE_ORDER.join(', ')})`)
}

function runFileSafe(argv) {
  // execFileSync — NO shell at all: release notes are user text and must
  // never be interpreted by bash (the release-full.mjs lesson).
  execFileSync('node', argv, { stdio: 'inherit' })
}

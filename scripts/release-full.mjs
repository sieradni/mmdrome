#!/usr/bin/env node
/**
 * release:full <x.y.z> [notes...] — the ENTIRE two-phase release pipeline in
 * one command, with its own waits and verifications (2026-09-14).
 *
 * Why: the manual choreography (bump → commit → push → wait CI → tag solo →
 * wait tag run → verify release → --size backfill → commit → push → deploy →
 * purge/verify CDN) produced ordering bugs three releases running — the
 * sizeless gh-pages mirror (1.2.10's "data couldn't be read" report) was the
 * worst: the deploy ran between the release commit and the backfill commit.
 *
 * Phases (each aborts the run on failure):
 *   0. preflight: clean tree, valid new version, tag unused, repo derived
 *   1. gates: npm run check + npm test
 *   2. bump: release:ios → commit → push main
 *   3. branch CI: BOTH workflows green on the release SHA (iOS gating steps
 *      verified individually — a fast wall clock proves nothing, §3.5)
 *   4. tag solo (E11) + wait for the tag run
 *   5. release published: not draft, mmdrome.ipa asset present → size read
 *   6. backfill: --size re-run → diff verified → commit → push main
 *   7. deploy web (the deploy script's own manifest guard runs here)
 *   8. CDN verify: gh-pages mirror must serve <ver> with the size; jsDelivr
 *      is purged and polled (a stale jsDelivr WARNS — the mirror is primary)
 */

import { execSync, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
if (args.length < 1) {
  console.error('usage: node scripts/release-full.mjs <x.y.z> [notes...]')
  process.exit(1)
}
const [version, ...noteWords] = args
const notes = noteWords.join(' ')
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`✗ version "${version}" is not x.y.z`)
  process.exit(1)
}
if (!notes) {
  console.error('✗ release notes are required (they land in three description fields + news)')
  process.exit(1)
}

const step = (msg) => console.log(`\n▶ ${msg}`)
const ok = (msg) => console.log(`  ✓ ${msg}`)
const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts })
/** execFileSync — NO shell: release notes are user text and must never be
 *  interpreted by bash. */
const runFile = (file, argv) => execFileSync(file, argv, { stdio: 'inherit' })
const runOut = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim()

// ── GitHub API (auth via gh if available — higher rate limits) ────────────
let ghToken = process.env.GITHUB_TOKEN ?? ''
if (!ghToken) {
  try {
    ghToken = runOut('gh auth token')
  } catch {
    /* unauthenticated works for a public repo, just rate-limited */
  }
}
const headers = ghToken ? { Authorization: `Bearer ${ghToken}` } : {}
async function api(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers })
  if (res.status === 404) return null // polling surfaces (release not yet published)
  if (!res.ok) throw new Error(`API ${path} → HTTP ${res.status}`)
  return res.json()
}

const repoUrl = runOut('git remote get-url origin')
const repo = /github\.com[/:](.+?\/.+?)(?:\.git)?$/.exec(repoUrl)?.[1]
if (!repo) {
  console.error(`✗ cannot parse owner/repo from origin: ${repoUrl}`)
  process.exit(1)
}
// The gh-pages mirror URL (Phase 8) derives from the repo — never hardcoded.
const [owner, name] = repo.split('/')
const pagesUrl = `https://${owner}.github.io/${name}/sidestore/apps.json`

// ── Phase 0: preflight ────────────────────────────────────────────────────
step('Preflight')
if (runOut('git status --porcelain') !== '') {
  console.error('✗ working tree is dirty — commit or stash first (the script stages only its own files)')
  process.exit(1)
}
const pkgVersion = JSON.parse(readFileSync('package.json', 'utf8')).version
const cmp = (v) => v.split('.').map(Number)
const [pn, pj, pk] = cmp(pkgVersion)
const [vn, vj, vk] = cmp(version)
// NUMERIC compare (string-comparing "1,2,10" < "1,2,9" would reject a valid
// double-digit patch bump). Equal is allowed: the bump step is idempotent.
const lower = vn < pn || (vn === pn && (vj < pj || (vj === pj && vk < pk)))
if (lower) {
  console.error(`✗ ${version} is lower than the current ${pkgVersion}`)
  process.exit(1)
}
runOut('git fetch origin --tags --quiet') // BEFORE the tag check: a tag existing only on the remote must abort too
try {
  execSync(`git rev-parse -q --verify refs/tags/ios-v${version}`, { stdio: 'ignore' })
  console.error(`✗ tag ios-v${version} already exists (locally or on origin)`)
  process.exit(1)
} catch {
  /* good — unused tag */
}
ok(`clean tree, ${version} > ${pkgVersion}, tag unused, repo ${repo}`)

// ── Phase 1: gates ────────────────────────────────────────────────────────
step('Gates (check + test + boot smoke)')
run('npm run check')
run('npm test')
// The smoke e2e is the ONLY gate that executes the BUILT bundle — unit tests
// run source ESM and `npm run build` never runs the app. The 1.2.21 CSP
// attempt passed check+test+build locally and broke boot in CI (taglib-wasm
// embind eval under a strict CSP); this gate exists so bundle-level breakage
// dies on the dev box instead of on the release commit.
run('npx playwright test tests/e2e/smoke.spec.ts')
ok('gates green')

// ── CI polling helpers ────────────────────────────────────────────────────
const CI_TIMEOUT_MS = 12 * 60 * 1000
const POLL_MS = 20 * 1000
async function waitForRuns(label, makePromise) {
  const deadline = Date.now() + CI_TIMEOUT_MS
  process.stdout.write(`  waiting for ${label}`)
  while (Date.now() < deadline) {
    // A transient network error must not kill a 12-minute wait — log, retry.
    const value = await makePromise().catch((e) => {
      console.warn(`\n  ⚠ poll error (retrying): ${e?.message ?? e}`)
      return undefined
    })
    if (value !== undefined) {
      process.stdout.write('\n')
      return value
    }
    process.stdout.write('.')
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  process.stdout.write('\n')
  throw new Error(`timed out waiting for ${label}`)
}

async function workflowConclusion(workflow, sha, branch) {
  const query = branch ? `branch=${encodeURIComponent(branch)}` : `head_sha=${sha}`
  const runs = await api(`/repos/${repo}/actions/workflows/${workflow}/runs?${query}&per_page=1`)
  const r = runs.workflow_runs?.[0]
  if (!r) return undefined
  return r.status === 'completed' ? r.conclusion : undefined
}

async function verifyIosGatingSteps(runId) {
  const jobs = await api(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=20`)
  const steps = new Map()
  for (const j of jobs.jobs ?? []) for (const s of j.steps ?? []) steps.set(s.name, s.conclusion)
  for (const name of ['Swift package tests (pure core, macOS host)', 'Build unsigned app']) {
    if (steps.get(name) !== 'success') throw new Error(`iOS gating step not green: "${name}" (${steps.get(name) ?? 'missing'})`)
  }
}

// ── Phase 2: bump, commit, push main ─────────────────────────────────
step(`Bump ${version} (release:ios)`)
// execFileSync — NO shell: release notes are user text and must never be
// interpreted by bash (execSync cannot take an argv array).
runFile('node', ['scripts/release-ios.mjs', version, notes])
run(`git add package.json ios/App/App.xcodeproj/project.pbxproj sidestore/apps.json`)
// Re-run tolerance (2026-09-15: the first 1.2.11 attempt aborted in Phase 3
// on the manifest tests' in-flight window — after fixing THAT, the re-run
// finds no diff to commit). A no-op bump commit is fine; any OTHER failure
// (index lock, identity) still aborts via the command's non-zero exit.
const staged = runOut('git diff --cached --name-only')
if (staged) {
  run(`git commit -m "release: ${version}"`)
} else {
  ok('bump already committed (re-run)')
}
run('git push origin main')
const sha = runOut('git rev-parse HEAD')
ok(`release commit ${sha.slice(0, 7)} pushed`)

// ── Phase 3: branch CI ────────────────────────────────────────────────────
step('Branch CI on the release commit')
const testsConc = await waitForRuns('Tests workflow', () => workflowConclusion('test.yml', sha))
if (testsConc !== 'success') throw new Error(`Tests concluded "${testsConc}"`)
ok(`Tests: ${testsConc}`)

let iosRunId
const iosConc = await waitForRuns('iOS workflow', async () => {
  const query = `head_sha=${sha}&per_page=1`
  const runs = await api(`/repos/${repo}/actions/workflows/ios.yml/runs?${query}`)
  const r = runs.workflow_runs?.[0]
  if (r?.status === 'completed') {
    iosRunId = r.id
    return r.conclusion
  }
  return undefined
})
if (iosConc !== 'success') throw new Error(`iOS build concluded "${iosConc}"`)
await verifyIosGatingSteps(iosRunId)
ok(`iOS Build: ${iosConc} (gating steps verified)`)

// ── Phase 4: tag solo, wait for the tag run ───────────────────────────────
step(`Tag ios-v${version} (solo push, E11)`)
run(`git tag ios-v${version}`)
run(`git push origin ios-v${version}`)
const tagConc = await waitForRuns(`tag run for ios-v${version}`, () => workflowConclusion('ios.yml', '', `ios-v${version}`))
if (tagConc !== 'success') throw new Error(`tag run concluded "${tagConc}"`)
ok(`tag run: ${tagConc}`)

// ── Phase 5: release published, read the IPA size ────────────────────────
step('Release published')
const release = await waitForRuns('release to appear', async () => {
  const rel = await api(`/repos/${repo}/releases/tags/ios-v${version}`) // null while 404
  return rel && rel.draft === false && (rel.assets ?? []).some((a) => a.name === 'mmdrome.ipa') ? rel : undefined
})
const asset = release.assets.find((a) => a.name === 'mmdrome.ipa')
ok(`release published, mmdrome.ipa = ${asset.size} bytes`)

// ── Phase 6: size backfill, verify the diff, commit, push ────────────────
step(`Size backfill (${asset.size})`)
const manifestBefore = JSON.stringify(JSON.parse(readFileSync('sidestore/apps.json', 'utf8')))
runFile('node', ['scripts/release-ios.mjs', version, notes, '--size', String(asset.size)])
const manifestAfter = JSON.parse(readFileSync('sidestore/apps.json', 'utf8'))
const newest = manifestAfter.apps[0].versions[0]
if (newest.version !== version || newest.size !== asset.size) {
  throw new Error(`backfill produced ${newest.version}/size=${newest.size} — expected ${version}/${asset.size}`)
}
if (JSON.stringify(manifestAfter) === manifestBefore) {
  throw new Error('backfill changed nothing — wrong --size?')
}
run('git add sidestore/apps.json')
run(`git commit -m "sidestore: backfill ${version} IPA size (${asset.size})"`)
run('git push origin main')
ok('backfill committed and pushed')

// ── Phase 7: deploy web (its script validates the manifest itself) ───────
step('Deploy web (gh-pages + source mirror)')
run('npm run deploy')

// ── Phase 8: CDN verify ───────────────────────────────────────────────────
step('CDN verification')
const bust = `?t=${Date.now()}`
async function servedManifest(url) {
  const res = await fetch(url + bust, { headers: { 'Cache-Control': 'no-cache' } })
  return res.ok ? res.json() : null
}

// Mirror (primary): MUST be correct — version AND size.
const mirrorDeadline = Date.now() + 5 * 60 * 1000
let mirror = null
while (Date.now() < mirrorDeadline) {
  // Transient fetch failures (DNS blip, edge hiccup) retry like CI polls do.
  mirror = await servedManifest(pagesUrl).catch(() => null)
  const v = mirror?.apps?.[0]?.versions?.[0]
  if (v?.version === version && v?.size === asset.size) break
  process.stdout.write('.')
  await new Promise((r) => setTimeout(r, 15 * 1000))
}
process.stdout.write('\n')
if (mirror?.apps?.[0]?.versions?.[0]?.version !== version) {
  throw new Error('gh-pages mirror did not converge to the new version (Pages cache?)')
}
if (mirror.apps[0].versions[0].size !== asset.size) {
  throw new Error(`gh-pages mirror serves ${version} WITHOUT the right size — SideStore will reject it`)
}
ok(`mirror: ${version} / size ${asset.size}`)

// jsDelivr: purge + poll; a stale edge is a WARNING (the mirror is primary).
let jsdelivrVersion = ''
for (let i = 0; i < 6; i++) {
  await fetch(`https://purge.jsdelivr.net/gh/${repo}@main/sidestore/apps.json`).catch(() => {})
  await new Promise((r) => setTimeout(r, 10 * 1000))
  jsdelivrVersion = (await servedManifest(`https://cdn.jsdelivr.net/gh/${repo}@main/sidestore/apps.json`))?.apps?.[0]?.version ?? ''
  if (jsdelivrVersion === version) break
}
if (jsdelivrVersion === version) {
  ok(`jsDelivr: ${version}`)
} else {
  console.warn(`  ⚠ jsDelivr still serves "${jsdelivrVersion || '(unreachable)'}" after 6 purge cycles — known edge staleness. The Pages mirror (primary) is correct; consider re-purging later.`)
}

console.log(`\n✅ ${version} fully released — CI green, release published, backfill landed, web + sources verified.`)
console.log('   SideStore: refresh the Pages source (primary) or jsDelivr; the new version should appear.')

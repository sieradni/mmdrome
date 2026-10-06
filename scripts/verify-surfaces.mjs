#!/usr/bin/env node
/**
 * Verify the SideStore source surfaces serve the just-published release.
 *
 * This REPLACES the finalize job's fixed 10 × 15 s CDN sample. That window is
 * shorter than a queued GitHub Pages deployment — 1.2.55's mirror build sat
 * queued for 25+ minutes, so the gate failed a release that was in fact
 * complete. The wait now keys on the PAGES BUILD for the deployed gh-pages
 * commit:
 *
 *   - deployment still queued/building  → keep waiting (bounded by
 *     --pages-timeout-sec, generous because queueing is normal — 1.2.55's
 *     deploy sat queued 25+ min, so the default leaves real margin)
 *   - deployment errored                → fail loudly, immediately
 *   - deployment built                  → only the short CDN-propagation
 *     window applies (--converge-timeout-sec); past it the surface is
 *     genuinely stale and the run fails loudly
 *
 * It never passes vacuously: a surface passes only when its manifest carries
 * the exact released version AND its published byte size (`manifestHasSize` —
 * the same "the manifest is correct" definition the release drivers use).
 *
 * Usage:
 *   node scripts/verify-surfaces.mjs --version 1.2.56 --size 5120090 \
 *     [--repo owner/name] [--surface name=url]... \
 *     [--pages-timeout-sec N] [--converge-timeout-sec N] [--poll-sec N]
 */
import { execFileSync } from 'node:child_process'
import { decideSurfaceVerification, manifestHasSize, pagesStateForCommit } from './releasePhaseCore.mjs'

const die = (msg) => {
  console.error(`✗ ${msg}`)
  process.exit(1)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── args ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const opt = {
  version: null,
  size: null,
  repo: null,
  surfaces: [],
  pagesTimeoutSec: 2700,
  convergeTimeoutSec: 300,
  pollSec: 15,
}
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  const value = () => {
    const v = argv[++i]
    if (v === undefined) die(`missing value for ${arg}`)
    return v
  }
  if (arg === '--version') opt.version = value()
  else if (arg === '--size') opt.size = Number(value())
  else if (arg === '--repo') opt.repo = value()
  else if (arg === '--surface') opt.surfaces.push(value())
  else if (arg === '--pages-timeout-sec') opt.pagesTimeoutSec = Number(value())
  else if (arg === '--converge-timeout-sec') opt.convergeTimeoutSec = Number(value())
  else if (arg === '--poll-sec') opt.pollSec = Number(value())
  else die(`unknown argument "${arg}"`)
}
if (!opt.version || !/^\d+\.\d+\.\d+$/.test(opt.version)) die('--version x.y.z is required')
if (!Number.isInteger(opt.size) || opt.size <= 0) die('--size <published IPA bytes> is required')

const repo = opt.repo ?? process.env.GITHUB_REPOSITORY ?? null
if (!repo || !repo.includes('/')) die('--repo owner/name is required (or GITHUB_REPOSITORY)')
const [owner, name] = repo.split('/')

const surfaces = opt.surfaces.length
  ? opt.surfaces.map((s) => {
      const eq = s.indexOf('=')
      if (eq <= 0) die(`--surface expects name=url, got "${s}"`)
      return { name: s.slice(0, eq), url: s.slice(eq + 1) }
    })
  : [
      { name: 'jsDelivr CDN', url: `https://cdn.jsdelivr.net/gh/${repo}@main/sidestore/apps.json` },
      { name: 'gh-pages mirror', url: `https://${owner}.github.io/${name}/sidestore/apps.json` },
    ]

// ── GitHub observations (the Pages build for the deployed gh-pages commit) ──
/** `gh api` JSON, or null when the call fails (an absent signal = "pending"). */
function ghApi(path) {
  try {
    return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }))
  } catch {
    return null
  }
}
function ghPagesTip() {
  const ref = ghApi(`repos/${repo}/git/ref/heads/gh-pages`)
  return ref?.object?.sha ?? undefined
}

/** One surface read: does its manifest carry the exact version + byte size? */
async function surfaceCheck(url) {
  try {
    const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`, {
      headers: { 'Cache-Control': 'no-cache' },
    })
    if (!res.ok) return { ok: false, label: `HTTP ${res.status}` }
    const manifest = await res.json()
    const newest = manifest?.apps?.[0]?.versions?.[0]
    return { ok: manifestHasSize(manifest, opt.version, opt.size), label: `${newest?.version ?? 'none'}/${newest?.size ?? '-'}` }
  } catch (err) {
    return { ok: false, label: `unreachable (${err?.message ?? err})` }
  }
}

// ── wait loop ──────────────────────────────────────────────────────────────
const started = Date.now()
let pagesBuiltElapsedMs = null
console.log(
  `verify-surfaces: ${opt.version} (${opt.size} bytes) on ${surfaces.map((s) => s.name).join(' + ')}` +
    ` — pages-timeout ${opt.pagesTimeoutSec}s, converge ${opt.convergeTimeoutSec}s`,
)

for (;;) {
  const pending = []
  const seen = []
  for (const surface of surfaces) {
    const { ok, label } = await surfaceCheck(surface.url)
    seen.push(`${surface.name}=${label}`)
    if (!ok) pending.push(surface.name)
  }

  const pagesState = pagesStateForCommit(ghApi(`repos/${repo}/pages/builds?per_page=30`), ghPagesTip())
  if (pagesState === 'built' && pagesBuiltElapsedMs === null) pagesBuiltElapsedMs = Date.now() - started
  const elapsedMs = Date.now() - started

  const decision = decideSurfaceVerification({
    pendingSurfaces: pending,
    pagesState,
    elapsedMs,
    pagesBuiltElapsedMs,
    pagesTimeoutMs: opt.pagesTimeoutSec * 1000,
    convergeTimeoutMs: opt.convergeTimeoutSec * 1000,
  })
  console.log(`[verify] ${Math.round(elapsedMs / 1000)}s pages=${pagesState} ${seen.join('  ')} → ${decision.action}: ${decision.reason}`)

  if (decision.action === 'pass') {
    console.log(`✓ every surface serves ${opt.version} (${opt.size} bytes)`)
    process.exit(0)
  }
  if (decision.action === 'fail') {
    console.error(`::error::${decision.reason}`)
    die(decision.reason)
  }
  await sleep(opt.pollSec * 1000)
}

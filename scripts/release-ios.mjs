#!/usr/bin/env node
// iOS SideStore release prep (see AGENTS.md §3.5).
//
//   node scripts/release-ios.mjs <version> [notes...] [--build N]
//
// Bumps the version in every place that must agree for SideStore updates to
// work, then regenerates sidestore/apps.json:
//
//   - package.json `version` (feeds __APP_VERSION__ in the web About screen)
//   - ios/App/App.xcodeproj/project.pbxproj MARKETING_VERSION (every config)
//     + CURRENT_PROJECT_VERSION (max+1, or --build N) — the installed app's
//     CFBundleShortVersionString/CFBundleVersion is what SideStore compares
//   - sidestore/apps.json (flat version fields + versions history + news),
//     whose downloadURL points at the GitHub Release asset the ios.yml
//     release job publishes when the ios-v<version> tag is pushed.
//
// After running: commit, push the branch, then tag + push the tag SEPARATELY
// (a joint `git push origin main <tag>` fires two ios.yml runs into one
// concurrency group and cancels the tag run before it publishes), e.g.
//   git add -A && git commit -m "..." && git push origin main
//   git tag ios-v1.1.0 && git push origin ios-v1.1.0

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'sieradni/mmdrome'
const TAG_PREFIX = 'ios-v'
const BUNDLE_ID = 'com.mmdrome.player'
const SOURCE_ID = 'com.mmdrome.sidestore'
const SITE = 'https://sieradni.github.io/mmdrome'
const ICON_URL = `${SITE}/icon-512.png`
const TINT = '8E8E93'

function usage() {
  console.error('usage: node scripts/release-ios.mjs <x.y.z> [notes...] [--build N] [--size N]')
  process.exit(1)
}

const rawArgs = process.argv.slice(2)
let buildOverride = null
const buildFlag = rawArgs.indexOf('--build')
if (buildFlag !== -1) {
  buildOverride = rawArgs[buildFlag + 1]
  if (!buildOverride || !/^\d+$/.test(buildOverride)) usage()
  rawArgs.splice(buildFlag, 2)
}
// --size N stamps the IPA byte size into the version entry. The size is
// known only AFTER CI publishes the release, so cut the release without it
// and backfill afterwards with a second run for the SAME version —
// SideStore hard-fails on a missing size ("no value associated with key
// size"), so a release without it can never be installed. Re-running for the
// same version is idempotent: build number and date are preserved from the
// existing entry (only size, which the first run cannot know, is added).
let sizeOverride = null
const sizeFlag = rawArgs.indexOf('--size')
if (sizeFlag !== -1) {
  sizeOverride = rawArgs[sizeFlag + 1]
  if (!sizeOverride || !/^\d+$/.test(sizeOverride)) usage()
  rawArgs.splice(sizeFlag, 2)
}
const [version, ...noteParts] = rawArgs
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) usage()
const notes = noteParts.join(' ').trim() || 'Bug fixes and improvements.'
const tag = `${TAG_PREFIX}${version}`
const versionDate = new Date().toISOString()
const downloadURL = `https://github.com/${REPO}/releases/download/${tag}/mmdrome.ipa`

// 1. package.json
const pkgPath = join(ROOT, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.version = version
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log(`package.json version -> ${version}`)

// Read the source early: a same-version re-run (the post-publish --size
// backfill) must preserve the original build number and date everywhere.
const dir = join(ROOT, 'sidestore')
mkdirSync(dir, { recursive: true })
const appsPath = join(dir, 'apps.json')
let source = null
if (existsSync(appsPath)) source = JSON.parse(readFileSync(appsPath, 'utf8'))
const prior = (source?.apps?.[0]?.versions ?? []).find((v) => v.version === version) ?? null
const entryDate = (prior && typeof prior.date === 'string' && prior.date) || versionDate

// 2. Xcode project versions
const pbxPath = join(ROOT, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj')
let pbx = readFileSync(pbxPath, 'utf8')
const marketingHits = (pbx.match(/MARKETING_VERSION = [^;]+;/g) ?? []).length
if (marketingHits === 0) throw new Error('no MARKETING_VERSION lines found in project.pbxproj')
pbx = pbx.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`)
const builds = [...pbx.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map((m) => Number(m[1]))
if (builds.length === 0) throw new Error('no CURRENT_PROJECT_VERSION lines found in project.pbxproj')
// Same-version re-run keeps the published build (never max+1 past it).
const build = buildOverride ? Number(buildOverride) : prior && /^\d+$/.test(String(prior.buildVersion ?? '')) ? Number(prior.buildVersion) : Math.max(...builds) + 1
pbx = pbx.replace(/CURRENT_PROJECT_VERSION = \d+;/g, `CURRENT_PROJECT_VERSION = ${build};`)
writeFileSync(pbxPath, pbx)
console.log(`project.pbxproj MARKETING_VERSION -> ${version} (${marketingHits} configs), CURRENT_PROJECT_VERSION -> ${build}`)

// 3. sidestore/apps.json (source object already read above for `prior`)
// versions[] entries use the NEW key names (date, localizedDescription,
// buildVersion) — NOT the legacy flat-app keys (versionDate,
// versionDescription). SideStore's decoder requires `date` AND `size` and
// throws "no value associated with key ..." otherwise (2026-09-09 for date,
// 2026-09-10 for size — a sizeless 1.1.1 entry failed source refresh). The
// flat legacy keys stay on the app object for old clients.
const versionEntry = {
  version,
  buildVersion: String(build),
  date: entryDate,
  localizedDescription: notes,
  downloadURL,
  minOSVersion: '15.0',
  ...(sizeOverride ? { size: Number(sizeOverride) } : {}),
}
const versions = [versionEntry, ...((source?.apps?.[0]?.versions ?? []).filter((v) => v.version !== version))]
const news = [
  { title: `mmdrome ${version}`, identifier: tag, caption: notes.slice(0, 140), date: entryDate, tintColor: TINT, imageURL: ICON_URL },
  ...((source?.news ?? []).filter((n) => n.identifier !== tag)),
].slice(0, 5)
source = {
  name: 'mmdrome',
  identifier: SOURCE_ID,
  subtitle: 'Self-hosted music player releases',
  description: 'SideStore source for mmdrome — install and update without manual sideloading. SideStore signs the app with your own Apple ID and refreshes it automatically.',
  iconURL: ICON_URL,
  website: `https://github.com/${REPO}`,
  tintColor: TINT,
  apps: [
    {
      name: 'mmdrome',
      bundleIdentifier: BUNDLE_ID,
      developerName: 'sieradni',
      subtitle: 'Minimalist music player for Navidrome / WebDAV',
      localizedDescription: 'Self-hosted, mobile-first music player. Streams from Navidrome, writes ratings back via WebDAV, works in the iOS background.',
      iconURL: ICON_URL,
      tintColor: TINT,
      category: 'music',
      version,
      versionDate: entryDate,
      versionDescription: notes,
      downloadURL,
      versions,
    },
  ],
  news,
}
writeFileSync(appsPath, JSON.stringify(source, null, 2) + '\n')
console.log(`sidestore/apps.json -> ${version} (build ${build}), ${versions.length} version(s) in history`)

// 4. Next steps
console.log('\nnext:')
console.log('  npm run check && npm test')
console.log(`  git add -A && git commit -m "<msg>" && git push origin main`)
console.log(`  (tag separately, AFTER the branch CI is green — never together:`)
console.log(`  a joint push fires two ios.yml runs into one concurrency group`)
console.log(`  and cancels the tag run: git tag ${tag} && git push origin ${tag})`)
console.log('  ios.yml builds the unsigned IPA and publishes the GitHub Release.')
console.log('  SideStore source URL: https://cdn.jsdelivr.net/gh/sieradni/mmdrome@main/sidestore/apps.json')
console.log('  AFTER the release publishes: re-run this script for the same')
console.log('  version with --size <asset bytes> (SideStore hard-fails without')
console.log('  size), commit, push, then purge the CDN:')
console.log('  https://purge.jsdelivr.net/gh/sieradni/mmdrome@main/sidestore/apps.json')

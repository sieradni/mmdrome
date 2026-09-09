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
// After running: commit, tag, push, e.g.
//   git add -A && git commit -m "..." && git tag ios-v1.1.0 && git push origin main ios-v1.1.0

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
  console.error('usage: node scripts/release-ios.mjs <x.y.z> [notes...] [--build N]')
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

// 2. Xcode project versions
const pbxPath = join(ROOT, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj')
let pbx = readFileSync(pbxPath, 'utf8')
const marketingHits = (pbx.match(/MARKETING_VERSION = [^;]+;/g) ?? []).length
if (marketingHits === 0) throw new Error('no MARKETING_VERSION lines found in project.pbxproj')
pbx = pbx.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`)
const builds = [...pbx.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map((m) => Number(m[1]))
if (builds.length === 0) throw new Error('no CURRENT_PROJECT_VERSION lines found in project.pbxproj')
const build = buildOverride ? Number(buildOverride) : Math.max(...builds) + 1
pbx = pbx.replace(/CURRENT_PROJECT_VERSION = \d+;/g, `CURRENT_PROJECT_VERSION = ${build};`)
writeFileSync(pbxPath, pbx)
console.log(`project.pbxproj MARKETING_VERSION -> ${version} (${marketingHits} configs), CURRENT_PROJECT_VERSION -> ${build}`)

// 3. sidestore/apps.json
const dir = join(ROOT, 'sidestore')
mkdirSync(dir, { recursive: true })
const appsPath = join(dir, 'apps.json')
let source = null
if (existsSync(appsPath)) source = JSON.parse(readFileSync(appsPath, 'utf8'))
const versionEntry = { version, versionDate, versionDescription: notes, downloadURL }
const versions = [versionEntry, ...((source?.apps?.[0]?.versions ?? []).filter((v) => v.version !== version))]
const news = [
  { title: `mmdrome ${version}`, identifier: tag, caption: notes.slice(0, 140), date: versionDate, tintColor: TINT, imageURL: ICON_URL },
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
      versionDate,
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
console.log(`  git add -A && git commit -m "<msg>" && git tag ${tag} && git push origin main ${tag}`)
console.log('  ios.yml builds the unsigned IPA and publishes the GitHub Release.')
console.log('  SideStore source URL: https://cdn.jsdelivr.net/gh/sieradni/mmdrome@main/sidestore/apps.json')

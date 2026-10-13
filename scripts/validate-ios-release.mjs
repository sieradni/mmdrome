#!/usr/bin/env node
/** Validate the complete source tree before an iOS release tag is built. */
import { readFileSync } from 'node:fs'

const [version] = process.argv.slice(2)
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: node scripts/validate-ios-release.mjs <x.y.z>')
  process.exit(2)
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8')).version
const pbx = readFileSync('ios/App/App.xcodeproj/project.pbxproj', 'utf8')
const marketing = [...pbx.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((m) => m[1])
const builds = [...pbx.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map((m) => m[1])
const plist = readFileSync('ios/App/App/Info.plist', 'utf8')
const shortVersion = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1]
const buildVersion = plist.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1]
const source = JSON.parse(readFileSync('sidestore/apps.json', 'utf8'))
const app = source.apps?.[0]
const entries = app?.versions
const entry = entries?.find((candidate) => candidate?.version === version)
const problems = []

if (pkg !== version) problems.push(`package.json=${pkg}, release=${version}`)
if (!marketing.length || marketing.some((v) => v !== version)) problems.push(`MARKETING_VERSION values=${marketing.join(',')}`)
if (!builds.length || builds.some((v) => v !== builds[0])) problems.push(`CURRENT_PROJECT_VERSION values=${builds.join(',')}`)
if (shortVersion !== '$(MARKETING_VERSION)') problems.push(`Info.plist CFBundleShortVersionString must use $(MARKETING_VERSION), got ${shortVersion}`)
if (buildVersion !== '$(CURRENT_PROJECT_VERSION)') problems.push(`Info.plist CFBundleVersion must use $(CURRENT_PROJECT_VERSION), got ${buildVersion}`)
if (!app || app.version !== version) problems.push(`SideStore flat version=${app?.version}, release=${version}`)
if (!entry) problems.push(`SideStore versions[] has no ${version} release entry`)
if (entry && entry !== entries[0]) problems.push(`${version} is not the newest SideStore version entry`)
if (entry && entry.buildVersion !== builds[0]) problems.push(`SideStore buildVersion=${entry.buildVersion}, Xcode build=${builds[0]}`)
if (entry && !entry.downloadURL?.endsWith(`/ios-v${version}/mmdrome.ipa`)) problems.push(`SideStore downloadURL does not target ios-v${version}/mmdrome.ipa`)
if (entry && 'size' in entry) problems.push('pre-tag manifest entry unexpectedly has size; only finalize may stamp the published IPA byte size')
if (source.apps?.length !== 1) problems.push(`expected exactly one SideStore app, got ${source.apps?.length ?? 0}`)
if (problems.length) {
  for (const problem of problems) console.error(`✗ ${problem}`)
  process.exit(1)
}
console.log(`✓ release tree is consistent: ios-v${version}, build ${builds[0]}, manifest awaits CI IPA size finalize`)

#!/usr/bin/env node
/**
 * ONE command to get mmdrome onto a real host, launch it, and see what it did.
 *
 * Per-platform differences are handled HERE, never by dropping a host the app
 * supports:
 *
 *   web  — any OS. Builds the real bundle, serves it on the LAN so a phone can
 *          open the PWA, and can start the same local Navidrome + WebDAV
 *          fixture servers the e2e suite uses (`--fixtures`). `--drive` runs
 *          the scripted real-server exercise and prints its report.
 *   ios  — macOS with Xcode only. Builds with the relative base the webview
 *          needs, syncs Capacitor, installs and launches on a booted simulator
 *          (default) or a connected device, streaming the app's console.
 *
 * Logs and the push report come from surfaces that already exist — the Debug
 * HUD's Copy dump (`window.__debugHudText`, carrying `lastPushReport` and the
 * JS event ring) and the native console. Nothing new is rendered for this tool.
 *
 * Usage (short version: docs/ON-DEVICE.md):
 *   npm run device                     # auto-pick the host this machine can drive
 *   npm run device -- --web            # build + serve on the LAN, print the URLs
 *   npm run device -- --web --fixtures # …plus local Navidrome + WebDAV servers
 *   npm run device -- --web --drive    # run the real-server exercise, print logs + report
 *   npm run device -- --ios            # build + install + launch on an iOS simulator
 *   npm run device -- --ios --device <udid>   # a physical iPhone (needs a signed build)
 *
 * `--drive` and `--fixtures` are alternatives: `--drive` runs a spec that builds
 * and serves its own bundle (Playwright owns the port), `--fixtures` is for a
 * phone you are holding.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE_ID = 'com.mmdrome.player'
const DEFAULT_PORT = 4173
const REPORT_DIR = resolve(ROOT, 'test-results')
const REPORT_PREFIX = 'on-device-'

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const valueOf = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

if (has('--help') || has('-h')) {
  const header = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]
  const body = header.replace(/^#![^\n]*\n/, '').replace(/^\/\*\*\n/, '').replace(/\n ?\*\/? ?/g, '\n')
  process.stdout.write(`${body.trim()}\n`)
  process.exit(0)
}

const options = {
  host: has('--ios') ? 'ios' : has('--web') ? 'web' : null,
  device: valueOf('--device') ?? null,
  fixtures: has('--fixtures'),
  drive: has('--drive'),
  port: Number(valueOf('--port') ?? DEFAULT_PORT),
  build: !has('--no-build'),
}

if (options.drive && options.fixtures) {
  fail(
    [
      '--drive and --fixtures are alternatives — pass one.',
      '--drive runs the specs, which start and serve their own fixture servers and build their own bundle;',
      '--fixtures starts those servers for a real device you then point at them.',
    ].join('\n'),
  )
}

function log(message) {
  process.stdout.write(`[device] ${message}\n`)
}
function fail(message) {
  process.stderr.write(`[device] ${message}\n`)
  process.exit(1)
}
function run(command, args, opts = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32', ...opts })
  if (result.status !== 0) fail(`\`${command} ${args.join(' ')}\` exited ${result.status}`)
  return result
}
function hasTool(command, args = ['--version']) {
  const probe = spawnSync(command, args, { cwd: ROOT, stdio: 'ignore', shell: process.platform === 'win32' })
  return probe.status === 0
}
function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return null
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Host selection ─────────────────────────────────────────────────────────

const isMac = process.platform === 'darwin'
const hasXcode = isMac && hasTool('xcrun', ['-f', 'xcodebuild'])
const host = options.host ?? (hasXcode ? 'ios' : 'web')

if (host === 'ios' && !hasXcode) {
  fail(
    [
      'iOS needs macOS with Xcode — this machine cannot build or install the native app.',
      `detected: ${process.platform}${isMac ? ' (Xcode/xcrun not found)' : ''}`,
      '',
      'The iOS host is NOT dropped: it is built and verified by CI (.github/workflows/ios.yml,',
      'per AGENTS.md E5), and a phone installs it from the SideStore source:',
      '  https://sieradni.github.io/mmdrome/sidestore/apps.json',
      '',
      'On this machine use the host the app also supports:',
      '  npm run device -- --web            # build + serve the PWA on the LAN',
      '  npm run device -- --web --fixtures # …with a local Navidrome + WebDAV to talk to',
      '  npm run device -- --web --drive    # run the real-server exercise and print the report',
      '',
      'iOS-specific behaviour (background audio, lock screen, Keychain) can only be judged on a',
      'device; that run is documented in docs/ON-DEVICE.md and has NOT happened from here.',
    ].join('\n'),
  )
}

log(`host=${host} platform=${process.platform} port=${options.port}`)

/** Every report the driven specs wrote — the app's own dump, the captured
 *  console, and a plain-language summary of what the real servers observed. */
function printReports() {
  if (!existsSync(REPORT_DIR)) {
    log(`no ${REPORT_PREFIX}*.json in test-results — the exercise did not reach its assertions`)
    return
  }
  const files = readdirSync(REPORT_DIR).filter((name) => name.startsWith(REPORT_PREFIX) && name.endsWith('.json'))
  if (files.length === 0) {
    log(`no ${REPORT_PREFIX}*.json in test-results — the exercise did not reach its assertions`)
    return
  }
  for (const file of files) {
    try {
      const report = JSON.parse(readFileSync(resolve(REPORT_DIR, file), 'utf8'))
      log('')
      log(`report · ${report.name ?? file}  (test-results/${file})`)
      for (const line of report.summary ?? []) log(`  ${line}`)
    } catch (err) {
      log(`could not read test-results/${file}: ${err.message}`)
    }
  }
  log('')
  log('each report carries the app\'s captured console and its Debug HUD dump (lastPushReport included).')
}

/** The machine-checkable leg: drive the real UI against the local real servers. */
function runDrive() {
  if (existsSync(REPORT_DIR)) {
    for (const name of readdirSync(REPORT_DIR)) {
      if (name.startsWith(REPORT_PREFIX)) rmSync(resolve(REPORT_DIR, name), { force: true })
    }
  }
  log('running tests/e2e/realservers.spec.ts — the app against LOCAL, REAL Subsonic + WebDAV servers…')
  log('(Playwright builds and serves its own bundle, so nothing else may hold port 4173)')
  const result = spawnSync('npx', ['playwright', 'test', 'tests/e2e/realservers.spec.ts', '--reporter=line'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  printReports()
  return result.status === 0 ? 0 : 1
}

// ── Shared: build the artifact the chosen host needs ───────────────────────

if (options.build && !(host === 'web' && options.drive)) {
  log(host === 'ios' ? 'building for the webview (relative base) + syncing Capacitor…' : 'building the web bundle…')
  run('npm', ['run', host === 'ios' ? 'sync:ios' : 'build'])
}

// ── web host ───────────────────────────────────────────────────────────────

if (host === 'web') {
  if (options.drive) process.exit(runDrive())

  const lan = lanAddress()
  const pagePath = 'mmdrome/?debug'
  const loopback = `http://127.0.0.1:${options.port}/${pagePath}`
  const lanUrl = lan ? `http://${lan}:${options.port}/${pagePath}` : null

  // A foreign server on this port would answer the readiness check below while
  // OUR build never started, and the run would report a bundle it did not make
  // (the failure mode playwright.config.ts guards against with
  // `reuseExistingServer: false`). Refuse rather than lie.
  const occupied = await fetch(loopback).then((r) => r.ok, () => false)
  if (occupied) {
    fail(`something is already serving ${loopback} — stop it, or pass --port <other>, so this run serves the build it just made.`)
  }

  const children = []
  const stopAll = () => {
    for (const child of children) child.kill('SIGTERM')
  }
  process.on('SIGINT', () => {
    stopAll()
    process.exit(0)
  })

  if (options.fixtures) {
    // The SAME servers the real-server e2e spec uses, so a device pointed at
    // them is exercising the same code path — just from real hardware.
    const fixtureScript = resolve(ROOT, 'scripts/serve-fixtures.mjs')
    const fixtures = spawn(process.execPath, ['--import', './scripts/test-loader.mjs', fixtureScript], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    children.push(fixtures)
    const urls = await new Promise((resolveUrls) => {
      let buffered = ''
      fixtures.stdout.on('data', (chunk) => {
        buffered += String(chunk)
        const match = /FIXTURE_URLS (\{.*\})/.exec(buffered)
        if (match) resolveUrls(JSON.parse(match[1]))
      })
      setTimeout(() => resolveUrls(null), 15_000)
    })
    if (!urls) fail('the local fixture servers did not report their URLs')
    // The URLs come back already addressed to the LAN (serve-fixtures does that
    // for exactly this case), so they are printed as they arrived.
    log(`local servers (real Subsonic + WebDAV, CORS-enabled for the LAN):`)
    log(`  Navidrome URL : ${urls.subsonicUrl}`)
    log(`  WebDAV URL    : ${urls.webdavBaseUrl}`)
    log(`  user/pass     : demo / demo   (any credentials are accepted)`)
  }

  const preview = spawn('npm', ['run', 'preview', '--', '--host', '0.0.0.0', '--port', String(options.port), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
  })
  children.push(preview)

  // The port was free a moment ago, so an answer here is this server's. Fail the
  // instant the child dies instead of waiting out the readiness timeout.
  let previewExit = null
  preview.on('exit', (code) => {
    previewExit = code ?? 0
  })
  const ready = await (async () => {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (previewExit !== null) return false
      try {
        if ((await fetch(loopback)).ok) return true
      } catch { /* not up yet */ }
      await sleep(500)
    }
    return false
  })()
  if (!ready) {
    stopAll()
    fail(
      previewExit !== null
        ? `the preview server exited (${previewExit}) — see its output above`
        : `the preview server did not answer ${loopback} — see its output above`,
    )
  }
  const current = await fetch(loopback).then((r) => r.text())
  if (!current.includes('<script')) {
    stopAll()
    fail('the served page has no script tag — the bundle did not build')
  }

  log('')
  log(`mmdrome is running:   ${loopback}${lanUrl ? `\n                      ${lanUrl}   (same Wi-Fi: open this on the phone)` : ''}`)
  log('logs + push report, without a cable:')
  log('  1. open the URL above (add ?debug=tags,sync for the scan/push verbose domains)')
  log('  2. Settings → About → Debug HUD → Copy — that dump holds lastPushReport, the scan')
  log('     state and the JS event ring, and it is also on window.__debugHudText')
  log(`  3. or run it for you:  npm run device -- --web --drive`)
  log('')
  log('serving until Ctrl+C (a phone on the same Wi-Fi stays connected)…')
} else {
  // ── ios host ─────────────────────────────────────────────────────────────

  const appPath = resolve(ROOT, 'ios/App/build/Build/Products/Debug-iphonesimulator/App.app')
  const deviceId = options.device

  if (deviceId) {
    // A physical device needs a SIGNED build. The honest path is one Xcode Run
    // (or SideStore, which signs with the user's Apple ID), then this command
    // installs and streams the console.
    log(`installing on device ${deviceId}…`)
    if (!existsSync(appPath)) {
      fail(
        [
          `no build to install at ${appPath}`,
          'A physical iPhone also needs a SIGNING identity, which this tool must not invent.',
          'Do this once: open ios/App/App.xcodeproj in Xcode, select your team, Run on the device.',
          'After that, `npm run device -- --ios --device <udid>` reinstalls and streams the console,',
          'and `--simulator` needs no signing at all.',
          'A phone without a Mac installs the release instead:',
          '  https://sieradni.github.io/mmdrome/sidestore/apps.json (SideStore source, README §iOS app).',
        ].join('\n'),
      )
    }
    run('xcrun', ['devicectl', 'device', 'install', 'app', '--device', deviceId, appPath])
    log('launching with the console attached (Ctrl+C to stop)…')
    run('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', deviceId, '--console', BUNDLE_ID])
    process.exit(0)
  }

  const listJson = spawnSync('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], { cwd: ROOT, encoding: 'utf8' })
  if (listJson.status !== 0) fail('`xcrun simctl list devices` failed — is Xcode installed and selected?')
  const devices = JSON.parse(listJson.stdout).devices ?? {}
  const booted = Object.values(devices).flat().find((d) => d.state === 'Booted' && String(d.name).startsWith('iPhone'))
  const available = Object.values(devices).flat().find((d) => d.isAvailable !== false && String(d.name).startsWith('iPhone'))
  const simulator = booted ?? available
  if (!simulator) fail('no iPhone simulator is installed — add one in Xcode → Settings → Platforms.')

  if (simulator.state !== 'Booted') {
    log(`booting ${simulator.name} (${simulator.udid})…`)
    run('xcrun', ['simctl', 'boot', simulator.udid])
  }

  log(`building for ${simulator.name}…`)
  run('xcodebuild', [
    '-project', 'ios/App/App.xcodeproj',
    '-scheme', 'App',
    '-configuration', 'Debug',
    '-sdk', 'iphonesimulator',
    '-destination', `id=${simulator.udid}`,
    '-derivedDataPath', 'ios/App/build',
    'build',
  ])
  if (!existsSync(appPath)) fail(`the build produced no app at ${appPath}`)

  run('xcrun', ['simctl', 'install', simulator.udid, appPath])
  log('')
  log('launching with the console attached — native + JS logs stream here (Ctrl+C to stop)…')
  log('the push report rides the same dump as everywhere: Settings → About → Debug HUD → Copy')
  log('')
  run('xcrun', ['simctl', 'launch', '--console-pty', simulator.udid, BUNDLE_ID])
  process.exit(0)
}

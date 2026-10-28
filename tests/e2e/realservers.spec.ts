import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { bootApp } from './boot'
import { openSources, openSettingsSection } from './libraryHarness'
import { startLocalServers, type LocalServers } from './localServers'

// ── REAL SERVERS, not route mocks (2026-10-28) ─────────────────────────────
// The two passes before this one shipped with correctness 6 for one reason:
// every WebDAV/Navidrome assertion ran against a Playwright route mock, so
// nothing had been exercised against a server that speaks HTTP, evaluates
// preconditions and stores bytes. These specs run the production bundle
// against the `node:http` servers in `localServers.ts` — real sockets, real
// `PROPFIND` XML, real Range reads, real conditional MOVE — and they read the
// bytes the server actually stored afterwards.
//
// They are also the machine-checkable half of `npm run device -- --drive`:
// each spec writes `test-results/on-device-<name>.json` with a plain-language
// summary, the app's captured console, and its own Debug HUD Copy dump
// (`window.__debugHudText`, which carries `lastPushReport`).

const REPORT_DIR = resolve(process.cwd(), 'test-results')

interface DeviceReport {
  name: string
  summary: string[]
  logs: string[]
  dump: unknown
}

function writeReport(report: DeviceReport): string {
  mkdirSync(REPORT_DIR, { recursive: true })
  const path = resolve(REPORT_DIR, `on-device-${report.name}.json`)
  rmSync(path, { force: true })
  writeFileSync(path, JSON.stringify(report, null, 2))
  return path
}

/** Point the app at the REAL local servers (the harness helpers hardcode the
 *  mocked URLs, so the three fields are filled here instead). */
async function connectTo(page: Page, servers: LocalServers): Promise<void> {
  await openSources(page)
  await page.getByTestId('navidrome-url').fill(servers.subsonicUrl)
  await page.getByTestId('navidrome-user').fill('demo')
  await page.getByTestId('navidrome-password').fill('demo')
  await page.getByRole('button', { name: 'Connect & Load Songs' }).click()
  await expect(page.getByText(/Loaded 2 song\(s\), 0 failed/)).toBeVisible({ timeout: 30_000 })
  await page.getByPlaceholder('https://example.com/remote.php/dav/files/user/').fill(servers.webdavBaseUrl)
  await page.getByPlaceholder('Username').nth(1).fill('demo')
  await page.getByPlaceholder('Password / Token').fill('demo')
}

/** Rate a song through the real UI (the single commit path). */
async function rateSong(page: Page, trackId: string): Promise<void> {
  await page.getByRole('button', { name: 'Songs', exact: true }).click()
  const songRow = page.locator(`[data-track-id="${trackId}"]`)
  await expect(songRow).toBeVisible()
  await songRow.getByRole('button', { name: 'More options' }).click()
  await songRow.getByRole('button', { name: 'Details' }).click()
  await expect(page.getByRole('button', { name: 'Set rating to 100' })).toBeVisible()
  await page.getByRole('button', { name: 'Set rating to 100' }).click()
  await page.getByRole('button', { name: 'Close' }).click()
}

interface PushReportRow {
  title?: string
  disposition?: string
  stage?: string
  precondition?: string
  attempts?: number
  remoteState?: string
}

interface PushReport {
  runId?: string
  status?: string
  rows?: PushReportRow[]
  counts?: Record<string, number>
}

/** The app's OWN push report, read out of the Debug HUD dump rather than
 *  reconstructed from the UI — this is what `npm run device -- --drive`
 *  surfaces, and it names the rung the server accepted per row. */
function pushFacts(dump: unknown): string {
  const report = (dump as { lastPushReport?: PushReport })?.lastPushReport
  if (!report) return 'push report: absent from the dump'
  const counts = report.counts ?? {}
  const rows = (report.rows ?? [])
    .map((r) => `${r.title ?? '?'} → ${r.disposition ?? r.stage ?? '?'} (guard ${r.precondition ?? 'none'}, ${r.attempts ?? '?'} attempt(s))`)
    .join('; ')
  return (
    `push report: ${report.runId ?? '?'} ${report.status ?? '?'} — ${rows}; ` +
    `remote commits ${counts.remoteCommitted ?? 0}, server-enforced guards ${counts.guardedWriteCount ?? 0}, ` +
    `blind overwrites ${counts.blindOverwrite ?? 0}, failed ${counts.failed ?? 0}, still pending ${counts.remainingPending ?? 0}`
  )
}

/** The HUD's own Copy dump — the same payload a user pastes into a report. */
async function hudDump(page: Page): Promise<unknown> {
  await page.getByRole('button', { name: 'Copy' }).first().click()
  await page.waitForFunction(() => Boolean((window as unknown as { __debugHudText?: string }).__debugHudText))
  const text = await page.evaluate(() => (window as unknown as { __debugHudText?: string }).__debugHudText ?? '')
  try {
    return JSON.parse(text)
  } catch {
    return { unparsed: text.slice(0, 4000) }
  }
}

test('a pending song with no file is linked by a scan, and the edit pushes to the real server', async ({ page }) => {
  const servers = await startLocalServers()
  const logs: string[] = []
  page.on('console', (msg) => logs.push(`${msg.type()}: ${msg.text()}`))
  try {
    await bootApp(page)
    // Verbose scan/push domains + the HUD, via the app's own support URL.
    await page.goto('/mmdrome/?debug=tags,sync')
    await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })

    await connectTo(page, servers)

    // ── The reported bug, in its real shape: rate a song BEFORE anything is
    // bound, so the edit is a pending row with no file. Before the 2026-10-27
    // fix a scan skipped it outright and only a manual pick could link it.
    await rateSong(page, 'navidrome-s1')

    await openSettingsSection(page, 'library')
    await page.getByRole('button', { name: /Rescan All Metadata \(re-reads all tags\)/ }).click()
    await expect(page.getByText(/Scan complete/)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('fm-audit-summary')).toContainText('2 verified')

    const dirListing = servers.storedPaths().sort()
    expect(dirListing, 'both fixture files still on the server').toEqual([
      `${servers.dir}/Song One.mp3`,
      `${servers.dir}/Song Two.mp3`,
    ])

    // ── Push: only reachable because the scan linked the pending edit.
    await page.getByRole('button', { name: 'Push Changes', exact: true }).click()
    await expect(page.getByText('1 file will be updated:')).toBeVisible()
    await page.getByRole('button', { name: 'Write to files' }).click()
    await expect(page.getByText(/Pushed 1 track/)).toBeVisible({ timeout: 30_000 })

    // ── What the SERVER holds now (not what a mock was told to answer).
    const pushed = servers.fileBytes(`${servers.dir}/Song One.mp3`)
    expect(pushed, 'the destination exists').toBeTruthy()
    expect(pushed!.indexOf(Buffer.from('POPM')), 'the rating reached the real file').toBeGreaterThan(-1)
    const untouched = servers.fileBytes(`${servers.dir}/Song Two.mp3`)
    expect(untouched!.indexOf(Buffer.from('POPM')), 'the unpushed song was not written').toBe(-1)
    expect(servers.storedPaths(), 'no temp orphan after an atomic write').not.toContain(
      `${servers.dir}/Song One.mp3.mmdrome-tmp`,
    )

    const counts = servers.counts()
    const dump = await hudDump(page)
    const report = {
      name: 'scan-links-pending-and-push',
      summary: [
        `scan: linked a song whose edit had no file — "2 verified" from real PROPFIND + real Range GET`,
        `push: 1 row written; server bytes now carry a POPM frame; the unpushed song is byte-identical`,
        pushFacts(dump),
        `server counters: propfind=${counts.propfind} get=${counts.get} put=${counts.put} move=${counts.move} delete=${counts.delete} precondition412=${counts.preconditionRejects}`,
        `stored paths: ${servers.storedPaths().join(', ')}`,
        `app log lines captured: ${logs.length}`,
      ],
      logs,
      dump,
    }
    const path = writeReport(report)
    expect(path).toContain('on-device-')
  } finally {
    await servers.close()
  }
})

test('a server that refuses the tagged-If dialect still commits, without re-uploading', async ({ page }) => {
  // The 2026-10-27 field shape, on a real server: the tagged `If` is refused
  // (412) and `If-Match` is scoped to the request URI, so a destination etag
  // there can never pass. The push ladder must walk tagged-if → if-match →
  // if-unmodified-since, keep the temp (ONE upload per row), and still land
  // the bytes. TWO rows, so the rung it learned on the first one is also
  // proven to carry to the rest of the run.
  const servers = await startLocalServers({ dialect: 'sabre-like' })
  const logs: string[] = []
  page.on('console', (msg) => logs.push(`${msg.type()}: ${msg.text()}`))
  try {
    await bootApp(page)
    await page.goto('/mmdrome/?debug=tags,sync')
    await expect(page.locator('[data-app-ready]')).toBeAttached({ timeout: 15_000 })

    await connectTo(page, servers)
    // Bind first (a clean scan), then rate, so this spec isolates the WRITE
    // path: the row has a file and the dialect is what the push must survive.
    await openSettingsSection(page, 'library')
    await page.getByRole('button', { name: /Rescan All Metadata \(re-reads all tags\)/ }).click()
    await expect(page.getByTestId('fm-audit-summary')).toContainText('2 verified', { timeout: 30_000 })
    await rateSong(page, 'navidrome-s1')
    await rateSong(page, 'navidrome-s2')

    await openSettingsSection(page, 'library')
    await page.getByRole('button', { name: 'Push Changes', exact: true }).click()
    await expect(page.getByText('2 files will be updated:')).toBeVisible()
    await page.getByRole('button', { name: 'Write to files' }).click()
    await expect(page.getByText(/Pushed 2 track\(s\)/)).toBeVisible({ timeout: 30_000 })

    const counts = servers.counts()
    expect(counts.put, 'each row was uploaded EXACTLY once (the ladder re-materializes no bytes)').toBe(2)
    expect(
      counts.move,
      'row 1 walks rungs 1→2→3 (tagged-if refused, if-match scoped to the source, date accepted); row 2 resumes at the learned rung',
    ).toBe(4)
    expect(counts.preconditionRejects, 'the server really did refuse two rungs, once').toBe(2)
    expect(counts.delete, 'no temp cleanup: the temp was reused across rungs').toBe(0)
    for (const title of ['Song One', 'Song Two']) {
      expect(
        servers.fileBytes(`${servers.dir}/${title}.mp3`)!.indexOf(Buffer.from('POPM')),
        `the write landed despite the dialect: ${title}`,
      ).toBeGreaterThan(-1)
    }

    const dump = await hudDump(page)
    writeReport({
      name: 'dialect-ladder',
      summary: [
        `dialect: the server refuses the tagged If and scopes If-Match to the source (the field shape)`,
        `ladder: put=${counts.put} move=${counts.move} precondition412=${counts.preconditionRejects} delete=${counts.delete} → committed without a second upload`,
        pushFacts(dump),
        `server bytes carry POPM: yes`,
        `app log lines captured: ${logs.length}`,
      ],
      logs,
      dump,
    })
  } finally {
    await servers.close()
  }
})

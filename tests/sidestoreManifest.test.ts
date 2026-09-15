// Pins the SideStore source manifest (sidestore/apps.json) — the E11 format
// rules that SideStore hard-fails on violation:
//   - every version entry needs version/buildVersion/date/downloadURL and
//     SIZE (2026-09-10: a sizeless entry failed source refresh; 2026-09-14
//     1.2.10: the gh-pages mirror published a sizeless manifest from the
//     two-phase release window and users got "data couldn't be read because
//     it's missing"),
//   - news items carry appID so the card links to the app page,
//   - the newest entry matches the newest ios-v* git tag (the release
//     pipeline's two-phase contract: cut → publish → backfill → commit).
// Pure JSON checks — no mocks needed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const source = JSON.parse(readFileSync(new URL('../sidestore/apps.json', import.meta.url), 'utf8'))

/** The two-phase release has an IN-FLIGHT window: the release commit adds a
 *  sizeless newest entry whose tag doesn't exist yet (Phase 2 of
 *  release:full), then the --size backfill + solo tag complete the
 *  contract (Phases 6/4). Detecting the in-flight state is cheaper and
 *  more honest than teaching CI about phases: the entry is in-flight iff
 *  its version equals the working package.json version (the bump already
 *  happened) — a COMPLETED release always has pkg == manifest == newest
 *  tag. (2026-09-15: release:full's Phase 3 correctly hard-failed on the
 *  release commit because these tests asserted the final-state invariant
 *  unconditionally — the pipeline did its job, the tests had no notion of
 *  the window.) */
function isInFlightRelease(v: { version?: string }): boolean {
  if (typeof v.version !== 'string') return false
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
    return v.version === pkg.version
  } catch {
    return false
  }
}

test('manifest: every app carries the identity + versions SideStore requires', () => {
  assert.ok(Array.isArray(source.apps) && source.apps.length > 0, 'apps[] non-empty')
  for (const app of source.apps) {
    assert.ok(app.bundleIdentifier, 'bundleIdentifier present')
    assert.ok(Array.isArray(app.versions) && app.versions.length > 0, 'versions[] non-empty')
  }
})

test('manifest: every version entry has the required keys — size is MANDATORY', () => {
  for (const app of source.apps) {
    for (const v of app.versions) {
      const label = `${app.bundleIdentifier} ${v.version}`
      assert.equal(typeof v.version, 'string', `${label}: version`)
      assert.equal(typeof v.buildVersion, 'string', `${label}: buildVersion`)
      assert.ok(v.date, `${label}: date (SideStore decoder requires it)`)
      assert.ok(v.downloadURL, `${label}: downloadURL`)
      // In-flight two-phase window: size arrives with the backfill commit.
      if (isInFlightRelease(v)) continue
      assert.equal(typeof v.size, 'number', `${label}: size (SideStore hard-fails a sizeless entry)`)
      assert.ok(v.size > 0, `${label}: size positive`)
    }
  }
})

test('manifest: news items carry appID (the card must open the app page)', () => {
  for (const n of source.news ?? []) {
    assert.ok(n.appID, `news "${n.identifier}" missing appID — the card is inert without it`)
  }
})

function listTags(args: string): string[] {
  try {
    return execSync(`git tag --list "ios-v*" ${args}`, { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
  } catch {
    return [] // no git / no tags in this environment (CI must fetch-tags)
  }
}

test('manifest: newest version entry matches the newest ios-v* tag (two-phase contract held)', () => {
  const tags = listTags('--sort=-v:refname')
  if (tags.length === 0) return // environment without tags — nothing to pin against
  const newestTag = tags[0] // e.g. ios-v1.2.10
  const expectedVersion = newestTag.replace(/^ios-v/, '')
  const newest = source.apps[0].versions[0]
  // In-flight two-phase window: the newest entry legitimately precedes its
  // tag (the solo tag push is Phase 4, after these tests gate Phase 3).
  if (isInFlightRelease(newest)) return
  assert.equal(
    newest.version,
    expectedVersion,
    `newest manifest entry (${newest.version}) must match newest tag (${expectedVersion}) — the --size backfill commit is missing`
  )
  assert.ok(newest.size > 0, 'newest entry has its size backfilled')
})

test('manifest: every downloadURL points at an existing release tag', () => {
  const tags = new Set(listTags(''))
  if (tags.size === 0) return // environment without tags — nothing to pin against
  for (const app of source.apps) {
    for (const v of app.versions) {
      const match = /releases\/download\/(ios-v[\d.]+)\//.exec(v.downloadURL ?? '')
      assert.ok(match, `${v.version}: downloadURL is a release-asset URL`)
      // In-flight two-phase window: the newest entry's tag is cut in Phase 4.
      if (isInFlightRelease(v)) continue
      assert.ok(tags.has(match![1]), `${v.version}: tag ${match![1]} exists in git`)
    }
  }
})

# E11a — Automated release finalize (2026-09-22, ios-v1.2.32 post-mortem)

## What went wrong

1.2.32 was shipped by hand-rolling the release (version bump, DEVLOG, tag) instead of
running the sanctioned `npm run release:full` pipeline. The tag built and the GitHub
Release published — **and SideStore kept serving 1.2.31**, because the manual path
skipped every post-publish step:

1. `sidestore/apps.json` never got its `--size` backfill (SideStore hard-fails a
   sizeless version entry — it cannot even display the release, let alone offer it).
2. The gh-pages mirror (the fallback source URL) was never re-deployed, so it kept
   serving the 1.2.31 manifest with its own independent cache.
3. Nothing surfaced any of this: a published tag *looks* like a shipped release.

The E11 documentation was already exhaustive — the failure was procedural: a session
that doesn't read E11 end-to-end (or believes the release is done at the tag) has no
guardrail. The fix is structural: the steps that were skippable are no longer steps.

## What is automated now (`.github/workflows/ios.yml` `finalize-release` job)

Every `ios-v*` tag run now finishes the release itself, after `release-ios` publishes:

1. **Size backfill** — reads the published `mmdrome.ipa` asset's byte size (ground
   truth, not a local zip) and re-runs `scripts/release-ios.mjs <version> <notes>
   --size N` for the SAME version (idempotent: preserves build + date, adds only
   size; notes are re-passed from the manifest itself so descriptions can never
   reset to the default — E11 2026-09-11 lesson).
2. **Commit + push to main** — rebase-onto-main (tag state never merges); the
   default-token push does not re-trigger workflows, so the manifest commit cannot
   re-enter the build queue.3. **gh-pages mirror deploy** — `npm run deploy -- --git-config-extraheader <auth>` (pure branch push, never tags, so it cannot collide with the tag in the concurrency group). The extraheader is REQUIRED in CI (added 2026-09-22, the 1.2.33 finalize failure): deploy-web.mjs pushes from gh-pages' OWN cache clone, which lives outside the workspace and inherits no credentials from actions/checkout — locally the ambient credential helper fills the gap, in CI the push died with `could not read Username for 'https://github.com'`. The header value comes from the checkout's own `http.https://github.com/.extraheader` git config; deploy-web.mjs applies it via `git -c` to the cache-clone push only (no credential material written to disk).
4. **jsDelivr purge** — plain GET on `purge.jsdelivr.net` (`-X PURGE` 400s at
   Cloudflare).
5. **Surface verification (hard gate)** — polls BOTH the jsDelivr CDN and the
   gh-pages mirror until each serves the new version AND the stamped size (10 tries
   × 15 s), and verifies the release asset's byte size equals the stamped size. A
   red step here means SideStore cannot see the release — the release run fails.

## What remains manual (deliberately)

- **The version bump itself** (`release:full` or hand bump via the script) — it
  produces the release notes and the commit CI builds from.
- **Tag discipline**: tag in its own push, tag only after branch CI is green
  (unchanged E11 rules — the concurrency group would still cancel a tag run that
  rides along with a branch push).
- **DEVLOG entry** per release.

`npm run release:full` is still the recommended driver for the pre-tag phases; the
finalize job now covers the post-tag phases even when the manual path is used. The
two paths converge: **a pushed tag is now sufficient for a complete release.**

## Verification contract (what "shipped" means)

A release is not shipped until all four surfaces agree:

| Surface | URL | Check |
| --- | --- | --- |
| GitHub Release | `releases/tag/ios-v<x.y.z>` | `mmdrome.ipa` asset exists |
| Repo manifest | `sidestore/apps.json` on main | version + size + buildVersion stamped |
| jsDelivr CDN | `cdn.jsdelivr.net/gh/sieradni/mmdrome@main/sidestore/apps.json` | serves new version + size |
| gh-pages mirror | `sieradni.github.io/mmdrome/sidestore/apps.json` | serves new version + size |

The finalize job enforces all of them on every tag push. For a release cut before
this automation (e.g. 1.2.32), verify by hand:

```sh
gh release view ios-v1.2.32 --json assets -q '.assets[].size'
curl -s https://cdn.jsdelivr.net/gh/sieradni/mmdrome@main/sidestore/apps.json | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const a=JSON.parse(d).apps[0];console.log(a.version,a.versions[0].size)})"
curl -s https://sieradni.github.io/mmdrome/sidestore/apps.json | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const a=JSON.parse(d).apps[0];console.log(a.version,a.versions[0].size)})"
```

Plus the ground-truth check that the stamped build matches the published IPA
(Info.plist `CFBundleVersion` vs manifest `buildVersion`).

# Releasing mmdrome for iOS / SideStore

This is the operator guide for a **phone-installable** release. A version bump, Git commit, tag, green build, or GitHub Release by itself is not a completed release. Use the release driver and verify the artifact and distribution surfaces before announcing it.

## Fast path

From a clean checkout on `main`, with Node/npm, GitHub CLI (`gh`) authenticated for this repository, and the required Git push permission:

Before the first release, confirm the account can push `main` and `ios-v*`, create/edit GitHub Releases, and write the `gh-pages` branch. The `release:full` driver performs these pushes; it is not a dry-run command.

```sh
npm ci
npm run release:full -- 1.2.60 "Short user-facing release notes"
```

Replace the example version with the intended next semantic version. The command runs local checks, uses the canonical version writer, commits and pushes the release source, waits for branch CI, then pushes the **iOS-triggering** `ios-vX.Y.Z` tag by itself and waits for the IPA and automated SideStore finalize. It is intentionally allowed to push refs: inspect the clean-tree preflight and target version before running it.

If the terminal cannot remain attached for the full CI wait, use the resumable driver. Re-run it after each phase until it reports `PHASE=done`:

```sh
npm run release:phases -- 1.2.60 "Short user-facing release notes"
```

The resumable driver is intentionally a separate alternative, not a follow-up to `release:full`. Do not invoke both for the same release. The one-shot driver should be used only where the terminal can remain attached for its bounded CI waits.

The phases are derived from GitHub and live release state, not from a remembered sequence. Do not run both drivers concurrently.

## What the pipeline does

1. **Preflight and local gates:** require a clean tree, a valid newer version, and an unused `ios-vX.Y.Z` tag; run typecheck, unit tests, and bundle smoke test.
2. **Versioned source commit:** `scripts/release-ios.mjs` updates `package.json`, every Xcode `MARKETING_VERSION` and build number, and the SideStore manifest's release metadata. `release:validate` checks those values and that the new manifest entry is intentionally awaiting its IPA size. The manifest entry is temporarily sizeless because the IPA does not exist yet; it must not be deployed or announced as installable in this state.
3. **Branch CI:** wait for Tests and iOS Build on the exact release commit. The iOS Swift tests and unsigned app build must succeed.
4. **Solo iOS tag:** push `ios-vX.Y.Z` after branch CI is green. The workflow now scopes concurrency by Git ref, so a `main` build cannot cancel a tag build; separate pushes are still recommended because the tag must name the exact, already-validated release commit and is the deliberate publication trigger.
5. **Build and publish:** `ios.yml` builds `mmdrome-unsigned.ipa`, publishes it as `mmdrome.ipa` on the `ios-vX.Y.Z` GitHub Release, and then runs `finalize-release`.
6. **Finalize and verify:** the workflow reads the published IPA's actual byte size, stamps it into the manifest, commits the manifest to `main`, deploys the Pages mirror, purges jsDelivr, then checks all distribution surfaces.

## The exact completion check

A release is **shipped** only when all are true:

- The remote `ios-vX.Y.Z` tag points to the intended release commit.
- The iOS workflow for that tag succeeded, including build, publish, and finalize jobs.
- GitHub Release `ios-vX.Y.Z` is published and contains `mmdrome.ipa` with a nonzero size.
- `sidestore/apps.json` on `main` has version `X.Y.Z`, the matching build number, and `size` equal to the published asset's bytes.
- Both the Pages manifest and jsDelivr manifest serve that same version and exact byte size.

A failed or still-running finalize job means the release is **not complete**, even if an IPA exists. The README's Pages source is preferred; jsDelivr can lag independently.

Useful read-only checks after the driver finishes:

```sh
gh release view ios-v1.2.60 --json tagName,isDraft,assets
gh run list --workflow ios.yml --limit 10
git ls-remote --tags origin 'refs/tags/ios-v1.2.60*'
```

Then open these JSON URLs and inspect `apps[0].versions[0]`:

- `https://sieradni.github.io/mmdrome/sidestore/apps.json`
- `https://cdn.jsdelivr.net/gh/sieradni/mmdrome@main/sidestore/apps.json`

The finalized `size` must exactly match the GitHub Release asset size. Refresh the Pages source in SideStore to see the update.

## Recovery and common mistakes

- **Do not use `vX.Y.Z` for an iOS build.** The workflow is triggered by `ios-v*`; a generic version tag does not publish an IPA. A `v*` tag is not proof of an iOS release.
- **Do not tag before the release commit is pushed and branch CI is green.** A tag builds exactly the tree it names; the ref-scoped concurrency guard prevents cross-ref cancellation but is not a substitute for validating the release source first.
- **Do not hand-edit only one version file.** Run the release script/driver; marketing version, build number, manifest entry, download URL, and tag must agree.
- **Do not manually advertise a sizeless manifest entry.** The CI finalize job is the owner of size backfill, main manifest commit, mirror deployment, CDN purge, and verification.
- **If the driver is interrupted, re-run it.** Do not improvise from the last printed phase; it re-derives the next action from remote state. Never run a duplicate local backfill while CI finalize may still be working.
- **If a tag build fails:** fix the cause first. Follow the repository's tag-retry policy in `AGENTS.md` E11 and ensure the replacement tag points at the corrected commit; do not report success from a green branch run alone.

## Documentation map

- [README](../README.md): user installation and project overview.
- [Automated finalize design and invariants](plans/2026-09-22-release-finalize.md): why CI owns the post-tag steps.
- [Developer rules](../AGENTS.md#E11): repository-specific release constraints and test pins.
- [Release workflow](../.github/workflows/ios.yml): build, publish, finalize, and hard verification.

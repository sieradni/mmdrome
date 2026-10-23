# Documentation

Use this index to find the right guide without needing to know the repository layout.

## Using mmdrome

- [Install and update the iOS app with SideStore](../README.md#ios-app-sidestore)
- [Project overview and setup](../README.md)

## Shipping and operating releases

- **[Release operator guide](RELEASING.md)** — recommended command, required permissions, what CI does, objective shipped criteria, and how to recover an interrupted release.
- [Automated finalize design](plans/2026-09-22-release-finalize.md) — the incident history and invariants behind IPA-size backfill, Pages deployment, CDN propagation, and release verification.
- [iOS build and publish workflow](../.github/workflows/ios.yml) — executable CI source of truth.

## Engineering and maintenance

- **[Current field-reliability register](plans/2026-10-22-field-reliability-and-push-diagnostics.md)** - reopened lock-screen/AirPods controls, pause-intent races, WebDAV push outcomes/write safety, transfer diagnostics, and the tests/device evidence required to close them. Bluetooth hardware issues are excluded.
- [Developer knowledge base](../AGENTS.md) — architecture map, design rules, and test-enforced invariants.
- [Queue & playback invariant matrix](QUEUE-INVARIANTS.md) — every intended queue/playback behavior with the test that pins it, the known gaps, and the Phase 3 playlist boundary decisions.
- [Queue & playlist target design](QUEUE-DESIGN.md) — the agreed (not yet implemented) queue rules, the decision ledger, the implementation order, and the playlist/format contract.
- [Developer log](DEVLOG.md) — dated implementation rationale and field findings.
- [Plans](plans/) — active and historical engineering plans.

## Release source-of-truth notes

The SideStore manifest is not installable while the newest entry is missing its `size`. CI stamps the exact published IPA byte size and verifies the GitHub Release, GitHub Pages manifest, and jsDelivr mirror. GitHub Pages is the recommended SideStore source; jsDelivr is a secondary mirror and may lag.

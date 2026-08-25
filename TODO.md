# mmdrome — Technical Debt & Refactor Plan

**Status: All phases 0–7 CLOSED as of 2026-08-25. No open items.**

History is in git log and `docs/DEVLOG.md`. This file is the live plan — cleared for future work.

Legend: `[ ]` open · `[x]` done · HIGH/MED/LOW impact · anchors are file + symbol (grep the symbol). **[DECISION]** needs a product call before implementation. **Verification per item = `npm run check` AND `npm test`** (`npm run build` before CI pushes); suites go in `tests/` (zero-dep, per F3).

---

## No open tasks

_No open debt items. Add new phases below as needed._

---

## Closed phases (navigation summary)

- **Phase 0 — Foundations & test foundation** (closed 2026-08-12): sleep-timer lifetime (0.2), CJK-safe normalization (0.3), credential-swap invariant (0.4), the node `--test` harness + seed suites + tsconfig.test.json + test.yml (0.5).
- **Phase 1 — PlaybackCore** (closed 2026-08-13/14): one orchestration, three transports (policy modules, WebTransport, WebBgTransport, NativeTransport + reload reconcile); native crossfade/scheduler Swift package (1.1/1.8), JS↔engine contract (1.4–1.7), media session (1.11).
- **Phase 2 — Queue model** (closed 2026-08-10/14): `_mutateQueue` id re-anchor, recency window, active-row removal semantics + advance corollary, unbounded user queue, native divergence skip.
- **Phase 3 — Sync/metadata hardening** (closed 2026-08-14/15): push re-validation (3.1/3.9), seed gating (3.2), pagination (3.3), config cache (3.4), baseKey (3.5), index/probe hygiene (3.6), pure matching core (3.6t), comments/mtime (3.7), write hardening (3.8), scrobble policy (3.10), cache policy (3.11), sleep timer web (3.12), load planner (3.13).
- **Phase 4 — UI & state** (closed 2026-08-11/15): credential write-through, scroll restore, dead-code sweep, native artwork race + resource polish, EQ store suite, e2e depth.
- **Phase 5 — Docs** (closed 2026-08-15): AGENTS.md corrections/decisions documented.
- **Phase 6 — WebDAV tag-first matching overhaul** (closed 2026-08-20/25): inline probe as scan phase, tag-aware re-queue, honest result line, unified probe triggers, probe-time auto-binding, adaptive sweep (6.1–6.14; 6.13 field-verified 2026-08-25 on real PWA library — `failed` shrinks as expected; false-match rate has no automated oracle without manual audit, accepted residual risk).
- **Phase 7 — Probe & scan UX robustness** (closed 2026-08-21): rotating unhinted window, `probeStatus` annotation & honest `read-failed` reason, partial-index honesty, dead `while(queue)` removal, two-phase scan progress, lightweight scan-complete summary (7.1–7.7).

---

## Verification gates

- Every item: `npm run check` **and** `npm test`; `npm run build` before CI pushes.
- JS CI: `.github/workflows/test.yml` (node 24, push + PR).
- Swift: push to `main` → `ios.yml` (`xcodebuild` + `swift test` for the XCTest target).
- Deliberately NOT unit-tested (documented scope): Svelte component/DOM behavior (would need vitest+jsdom; contradicts the zero-dep ethos) — the decision logic behind it IS tested; components stay thin.

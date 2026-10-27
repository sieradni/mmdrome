# mmdrome — Technical Debt & Refactor Plan

**Status: Historical refactor phases 0-8 are CLOSED. Current field-reliability work is OPEN (2026-10-22); see the active register below.**

History is in git log and `docs/DEVLOG.md`. Detailed current work lives in the linked plans; this file provides entry points without duplicating their checklists.

Legend: `[ ]` open · `[x]` done · HIGH/MED/LOW impact · anchors are file + symbol (grep the symbol). **[DECISION]** needs a product call before implementation. **Verification per item = `npm run check` AND `npm test`** (`npm run build` before CI pushes); suites go in `tests/` (zero-dep, per F3).

---

## Active work

- [ ] **Field reliability and push diagnostics (2026-10-22):** [investigation and implementation register](docs/plans/2026-10-22-field-reliability-and-push-diagnostics.md). Reopened lock-screen/AirPods stale play/pause state, authoritative pause intent across recovery/download callbacks, accurate WebDAV outcomes and write boundaries, retained diagnostics, and recurring audio transfer failures. Bluetooth hardware repair is excluded. Native intent/command/publication implementation (`80d6adc`, 1.2.65+) and unconditional user-Pause output-graph pause (`ba94fb8`, 1.2.67+) are committed, shipped, verified by iOS CI (`swift test` + `xcodebuild` green through 1.2.71), and confirmed on hardware — **closed for development purposes** (L-01…L-06). Push/transfer/shared diagnostics (`W-01`…`W-10`, `N-01`…`N-04`, `D-01`…`D-04`) are implemented and pinned row by row in that register — nothing there is open. What remains is device-only evidence (physical iOS playback, Safari/VoiceOver review, the `-1017` root cause) plus D-03's ring counters, which are core-tested but not published to a dump.
- [ ] **Existing queue/UI/feature roadmap:** [holistic roadmap](docs/plans/2026-10-18-holistic-polish-and-roadmap.md), [queue target design](docs/QUEUE-DESIGN.md), and [as-built invariant matrix](docs/QUEUE-INVARIANTS.md). Preserve their individual completion states; the old refactor-phase closure is not an app-wide "nothing outstanding" claim. **Queue design steps 1–6 are LANDED** (occurrence identity, press semantics, skip exactness, fresh-context rebuild, D8/D9 tail rules + auto-off, D6 repeat pass; G4 CLOSED — 2026-10-26). **3A saved filter presets LANDED 2026-10-27** (`src/lib/filterPresets.ts` + the `filterPresets` store + FilterSortBar chips; pinned by `tests/filterPresets.test.ts` incl. the boot restore and `tests/e2e/filterpresets.spec.ts`). Still open there: playlists (§7 — server playlists + queue export), D2's optional auto-copy drop on `+`, and the roadmap's 2B (shared rating editor/display) and 2C (Settings decomposition). G6 stays a documented, pinned limitation.

---

## Closed phases (navigation summary)

- **Phase 8 — Direct scrobbling: Last.fm + ListenBrainz client-side integration** (closed 2026-08-25): mmdrome now authenticates with Last.fm directly (desktop auth flow) and submits scrobbles/hearts itself, independent of Navidrome's server-side forwarding. Design + decisions:
  - 8.1 `[x]` `src/lib/md5.ts` extracted from navidromeApi (UTF-8 TextEncoder path pinned by RFC 1321 + CJK vectors).
  - 8.2 `[x]` Pure protocol core `src/lib/lastfmCore.ts`: LEXICOGRAPHIC `apiSig` (the `artist[10]` < `artist[2]` sort trap, test-pinned), `buildScrobbleParams` `[i]` flattening, `chunkScrobbles`, `planFlush` (13-day expiry for time-sensitive kinds, poison drop at `FLUSH_MAX_ATTEMPTS`=8), `nextAuthStep` poll machine (error 14 keeps polling; 15/fatal stop). `format`/`callback` are transport-only and never signed.
  - 8.3 `[x]` Transport choke point `src/lib/lastfmTransport.ts`: POST form-urlencoded on BOTH platforms — field finding 2026-08-25: Last.fm rejects GET writes with error 4 "You must use POST method" (the legacy GET+JSONP client pattern is dead), and ws.audioscrobbler.com sends `Access-Control-Allow-Origin: *`, so web = plain fetch POST (CORS simple request, no preflight), native = CapacitorHttp. Body-first parsing keeps typed `{error:n}` codes that ride non-2xx statuses. Batch ≤50 on both (POST bodies have no URL limits).
  - 8.4 `[x]` Method layers: `lastfmApi.ts` (`{error:n}` → typed `LastfmError`) and `listenbrainzApi.ts` (plain fetch, CORS-native, token header; hearts via `/1/metadata/lookup` → `/1/feedback/submit-log`; no-MBID matches skip gracefully).
  - 8.5 `[x]` Dexie v6 table `pendingScrobbles` with unique compound index `&[kind+artist+track+timestamp]` — DB-enforced dedupe of re-evaluated plays / double heart events.
  - 8.6 `[x]` Flush engine `scrobbleFlushEngine` (`src/lib/scrobbleFlush.ts`): injectable store + submit deps (Node-tested), one kind per cycle, backoff 30 s→2^n capped 8 min (rate-limit → 15 min), status store `{pending, dropped, skippedNoMbid}`.
  - 8.7 `[x]` `scrobbleManager` destination fan-out: ONE accrued listen event (A9 accrual untouched) dispatches to navidrome (drop-on-fail, unchanged) + lastfm/listenbrainz legs (durable enqueue); each DEFAULT leg re-checks its own toggle/session/token at fire time. Now-playing fans out fire-and-forget.
  - 8.8 `[x]` Auth orchestration `lastfmAuth.ts`: desktop flow (getToken → `window.open` approval page → poll getSession 3 s up to 10 min; `@capacitor/browser` was removed after it failed to compile on CI's Xcode 15.4 — `pendingAuthUrl` manual fallback link covers popup-blocker cases), session persisted under userSettings key `lastfmSession`; BYO key/secret override compiled defaults.
  - 8.9 `[x]` Outward-only heart mirror: `feedbackService.commitFeedback` diffs the loved flag and enqueues `lfm-love`/`lfm-unlove`/`lb-love`/`lb-unlove` (heart polarity lives in the kind — the row shape has no score column) — rating edits with unchanged hearts never re-deliver. Deliberately NO reverse import (Last.fm exposes no love timestamps → no merge basis).
  - 8.10 `[x]` Settings → Sources: Last.fm card (connect/disconnect/awaiting states, toggle, BYO credentials details block), ListenBrainz card (token + validate + toggle), queue-status line, double-scrobble warning when Navidrome forwarding may also be on.
  - Decisions recorded: repo-owned default API key shipped in bundle (+ BYO override) — OSS-client convention, secret only signs; ListenBrainz included v1 (no OAuth, CORS-native); worker proxy NOT required (transport seam keeps it a swappable future option).

---

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

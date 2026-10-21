# Holistic UI Polish, Queue Boundary Hardening & Feature Roadmap

Date: 2026-10-18 (Phase 2A closed 2026-10-21)
Status: Active roadmap. Phase 1 is implemented and design-approved (real-device review still outstanding). **Phase 2A is CLOSED (2026-10-21)** — deliverable: [docs/QUEUE-INVARIANTS.md](../QUEUE-INVARIANTS.md); it found five gaps, registered in its §13. **Phase 2D (queue semantics redesign) is AGREED and NOT implemented (2026-10-21b)** — contract: [docs/QUEUE-DESIGN.md](../QUEUE-DESIGN.md). Phases 2B, 2C and 3 are NOT complete.

## 1. Guiding Principles & Guardrails

1. **Minimalist, High-Signal Design Language (Rule C8 strictly enforced)**:
   - **No visual bloat**: Every element in a row or modal must earn its pixels. No decorative badges, no heavy box-shadows or multi-colored pills, no duplicate labels, and no permanent clutter when a state is idle/default (mirroring the C5 rule where unrated rows render zero stars).
   - **Hierarchy through typography and contrast, not chrome**: Primary text (`text-primary`), secondary context (`text-muted`), and quiet metadata (`text-muted/60`, `tabular-nums`) with flat `1px` hairline dividers (`border-white/10`) and solid surfaces (`#000000` background, `#121212` surface, `#1e1e1e` hover).
   - **Accent is strictly for STATE**: `--app-accent` marks active state only (playing row, active tab, enabled toggle, seek fill). Hover states brighten (`text-muted` → `text-primary`, `bg-white/5`) and never re-color.

2. **Preview & Demo-First Workflow**:
   - UI changes must be verifiable in the live Browser preview without requiring a live Navidrome/WebDAV backend or manual multi-step setup.
   - A lightweight, non-invasive dev/preview harness (`?uiPreview=...` or window hook in dev/preview) can seed representative states (e.g. Push Changes confirmation with diffs, loading/cached status bar, tooltips) so both human and agent can inspect, screenshot, and refine the exact layout before finalizing.
   - Production behavior and existing e2e selectors (`data-testid`, role labels, exact copy pinned by Playwright specs) must remain 100% compatible.

3. **Queue & Playback Pool Isolation (High-Risk Boundary)**:
   - `queueMutation.ts`, `autoQueuePlan.ts`, `queueManager.ts`, and `playbackManager.ts` have hard-won invariants (B1–B8, section-scoped uniqueness `u-${id}` / `a-${id}`, `promoteActiveTrack`, `recentTrackIds` cooldown, native `queueRefreshDecision`).
   - **Rule for Playlists & Presets**: Playlists and filter presets must NEVER introduce a third queue section, alter `userQueue`/`autoQueue` keyspaces, or wire a side-channel into `planAutoQueueFill`.
   - Instead, playlists act strictly as **boundary inputs** into the existing primitives:
     - *Playing a playlist* = existing `queueManager.playAll(trackIds)` bulk entry (identical to playing an Album or Artist).
     - *Queueing a playlist* = existing `addToUserQueue` (dedupe-preserving).
     - *Saving the queue as a playlist* = pure read of `userQueue` (or combined queue) → Subsonic `createPlaylist` / local store.
     - *Smart Filter Presets* = pure read/write snapshots of `LibraryFilterState` / `AutoQueueFilterFields` + `AutoQueueSort`.

---

## 2. Prioritized Roadmap

### Phase 1: High-Value UI Clarity & Immediate Feedback (Current Sprint)

#### 1A. Scannable Push Changes Confirmation Modal with Explicit Diffs
- **Problem**: The Push confirmation dialog (`SettingsView.svelte`) is constrained to `max-w-sm` with a cramped `max-h-40` bulleted `<ul>` (`Title — Artist → path`). It hides *what* changed (`rating`, `loved`) and what the previous value was.
- **Design (Minimal & Clean)**:
  - Widen the modal container (`max-w-lg`) and give the track list comfortable vertical room (`max-h-[55vh]`), replacing `list-disc` bullets with clean, hairline-divided rows (`divide-y divide-white/8`).
  - Keep `<li>` semantics and all existing `data-testid="push-discard-..."` and copy (`1 file will be updated:`, `Title — Artist`, `→ path`) intact so `pushchanges.spec.ts` and `idmigration.spec.ts` pass unmodified.
  - **Pure diff model (`pushReconcile.ts`)**:
    - Extend `PushableTrackInfo` with `rating: number`, `loved: boolean`, `prevRating?: number`, `prevLoved?: boolean`, and the pure `describePushDiff(row)` helper.
    - Baseline (`prevRating`, `prevLoved`) resolves ONLY from successfully probed WebDAV file tags. Navidrome values may already mirror the pending edit and cannot establish the previous file value. Explain that probe values are last-known, not a fresh pre-write read; absent evidence shows only the value to write.
    - Render compact, unboxed tabular-nums changes below the track identity (wrap safely on mobile), rather than right-side badges (e.g. `★ 60 → 100`, `★ 80`, `♡ → ♥`, `♥ → ♡`) — only showing fields that are non-default or changed.

#### 1B. Quiet Connection, Sync & Scan Status Strip
- **Problem**: When the app is connecting to Navidrome, paginating the library on boot, serving a cached library while offline, or running a WebDAV metadata scan in the background, the main library views (`Songs`, `Albums`, `Artists`) show no indicator (or briefly flash "Your library is empty").
- **Design (Minimal & Clean)**:
  - Derived pure status selector `deriveActivityStatus` (`src/lib/activityStatus.ts`) reading `navidromeConnection`, `navidromeLoadStatus`, `metadataScanState`, `tagProbeState`, and `pushState`.
  - **Zero-height when idle**: When connected and no background op is running, nothing renders—zero extra chrome.
  - **Subtle single-line status bar**: Under the header search bar, render a compact single-line strip (`text-xs text-muted`) with a tiny 1.5px progress/activity indicator when:
    1. *Loading library*: `Loading library…` (and in `SongsView` empty state, show `Loading library…` instead of `Your library is empty`).
    2. *Offline / Cached fallback*: `Offline — showing cached library` (clickable to jump to `Settings → Sources`).
    3. *Background WebDAV Scan / Probe / Push*: `Scanning tags (42/180)…` or `Pushing changes (3/12)…` (clickable to jump to `Settings → Library`).

#### 1C. Lightweight Universal Tooltips (`use:tooltip`)
- **Problem**: Icon-only buttons across the header, FilterSortBar (`Apply to auto queue`), Now Playing utility row (`Loop`, `Volume`, `Sleep timer`, `Shuffle`, `Options`), and Queue dock have `aria-label`s but no visual hint on desktop hover or mobile long-press.
- **Design (Minimal & Clean)**:
  - A single Svelte action `src/lib/tooltip.ts` (`use:tooltip`) that reads `node.getAttribute('aria-label')` (or an explicit string parameter).
  - **Desktop**: Appears after 400ms pointer hover / keyboard focus-visible in a clean, minimal pill (`#1e1e1e`, `1px solid rgb(255 255 255 / 0.14)`, `text-xs text-primary`).
  - **Mobile / Touch**: Long-press (450ms) displays the tooltip briefly without triggering the button's click action.

---

### Phase 2: Queue Pool Hardening & View-Layer Deduplication

#### 2A. Playback & Queue Pool Reliability Audit & Consolidation
- **Problem**: Filter/sort predicate logic is currently split across `SongsView.svelte` (inline filter/sort), `libraryFilters.ts` (`applyFilterSort` for album/artist groups), and `autoQueuePlan.ts` (`trackMatchesFilter` + `buildOrderRank`). Subtle divergences between what the user sees in `SongsView` and what `autoQueuePlan` admits can feel flaky.
- **Solution**:
  - First characterize the intended differences: library sort is view-only, auto-queue sort is independently persisted, and auto fill rotates after the anchor. Share only semantics proven equivalent by characterization tests; do NOT merge predicates/comparators just because they look duplicated or re-couple library sorting to queue rebuilding.
  - Add invariant diagnostics for auto-queue pool starvation / filter exhaustion so QueueView always explains *why* a pool is small or wrapped.

#### 2B. Shared Rating & Star Display Extraction
- **Problem**: `starSegments(r)`, half-star SVG linearGradients, and the C4 rating-slider drag guard (`dragging`, `dragCommitted`, `onRatingInput`, `onRatingRelease`) are duplicated across `TrackRow.svelte`, `DetailView.svelte`, `TrackDetailsModal.svelte`, and `TrackOptionsView.svelte`.
- **Solution**:
  - Extract pure `starSegments(rating)` + `StarRatingDisplay.svelte` and `RatingEditor.svelte` (encapsulating the C4 scanner-race lock), cutting ~200 lines of duplicated view code.

#### 2D. Queue Semantics Redesign (AGREED 2026-10-21b — not implemented)
- **Contract:** [docs/QUEUE-DESIGN.md](../QUEUE-DESIGN.md). The matrix stays the as-built truth until each rule lands with its test.
- **Premises that changed:** pressing a song starts that song (no jump to an old copy); duplicates are legal in the user queue and in auto only on pool exhaustion; a filter/sort edit is a fresh context (promote the audible row, reset the cooldown, rebuild).
- **Consequences:** occurrence identity replaces id identity (keys, remove, drag, native entry ids, restore); G1/G2 close structurally; G3 closes with an explicit skip fact; G5 closes with occurrence drag; G4 becomes the import contract; repeat-all gains a real meaning once the auto queue can be switched off.
- **Order:** identity → press semantics → skip exactness → fresh-context rebuild → tail rules + auto-off → repeat pass → playlists. Steps 1–2 are the foundation; do not start playlists before step 6.

#### 2C. Modularize `SettingsView.svelte`
- **Problem**: `SettingsView.svelte` is 2,606 lines containing 6 distinct tabs plus the File Matching workbench and Push modal.
- **Solution**:
  - Extract `PushConfirmModal.svelte`, `FileMatchingSection.svelte`, and tab sub-views while keeping C1 (`updateSetting` direct writes) and C2 (`sessionStorage` scroll/tab restore) pinned by `tests/e2e/viewstate.spec.ts`.

---

### Phase 3: Playlists & Saved Filter Presets (Boundary-Safe)

**v1 scope (agreed 2026-10-21b): server playlists + queue export only.** No local playlist store; M3U/PLS/XSPF file import is a later increment, because it needs the path-matching table and the unresolved-entry review UI. Full contract, format research and import rules: [docs/QUEUE-DESIGN.md](../QUEUE-DESIGN.md) §7.

#### 3A. Saved Filter/Sort Presets ("Smart Views")
- Pure persisted store `filterPresets` (`id`, `name`, `filters`, `sortBy`, `sortAsc`).
- Minimal chip strip in `FilterSortBar` / Queue filter modal to save/apply a preset in one tap—zero changes to `queueMutation` or `autoQueuePlan` internals.

#### 3B. Navidrome Server Playlists + Queue Export
- Stateless Subsonic endpoints in `navidromeApi.ts`: `getPlaylists`, `getPlaylist`, `createPlaylist`, `updatePlaylist`, `deletePlaylist`.
- "Save Queue as Playlist" in `QueueView` and "Play / Add to Queue" from a clean Playlists sheet, feeding directly into the existing `queueManager` bulk methods.
- Import preserves server order **and duplicates** (the queue can represent them after 2D); unresolved ids are dropped with a count and a review list; zero resolved never starts playback; the source playlist is never mutated.
- Play vs. Add copy states the auto-queue consequence: with auto off the playlist ends at its last row; with auto on suggestions continue.

---

## 3. Delivery ledger and next-session handoff (2026-10-20)

This is a completion ledger, not a promise that all phases are done. Update it after each increment; do not silently mark design review or native verification complete.

### Implemented — awaiting user visual approval
- [x] 1A: Wider push confirmation with flat divided rows, album/format/path, and old → new rating/loved presentation. `PushTrackSummary.svelte` is shared with the review fixtures; no boxed diff badges.
- [x] 1B: Pure `deriveActivityStatus`, shared `ActivityStrip.svelte`, zero rendered strip when healthy/idle, loading-aware Songs empty state, and navigation to the relevant Settings section.
- [x] 1C partial: `use:tooltip` on selected playback, queue, filter, and navigation controls. Hover, focus-visible, Escape, and long-press behavior; movement cancels long-press. **Not yet an app-wide coverage claim.**
- [x] Isolated, development-only UI review entry: `/mmdrome/?uiPreview`. Fixture rows cannot write files. Activity selector covers idle/connecting/loading/scanning/pushing/cached.
- [x] User accepted the design direction, requesting responsive centering/edge padding, outside-click dismissal, realistic fixture changes, and per-row removal. Implemented in the follow-up below.
- [ ] Complete keyboard/modal focus management and real-device iOS touch/VoiceOver review before declaring polish release-ready.
- [x] Durable review coverage added in `tests/ui-review/push-review.spec.ts`, using `playwright.ui-review.config.ts`; covers responsive geometry, dismissal/focus return, fixture discard, idle status, and hover tooltip dismissal. Touch-specific tooltip regressions remain to be added.

### Verification evidence
- `npm run check`: 0 errors, 0 warnings after the current tooltip and entrypoint edits.
- `node --test --import ./scripts/test-loader.mjs tests/activityStatus.test.ts tests/pushReconcile.test.ts`: 41 passing tests.
- Final production-bundle browser rerun after entrypoint isolation: **8 passed** (`smoke.spec.ts`, `pushchanges.spec.ts`, `idmigration.spec.ts`, 23.5 s). Covers app boot, atomic writes, conflict retry, cancellation, migration and discard.
- `git diff --check`: passing after normalizing the edited test file's line endings; its 35 tests reran successfully. No commits or deployments made.
- Browser review: narrow viewport 390×844 has no horizontal page overflow; disabled demo write action, idle strip absence, hover tooltip, Escape dismissal, long-press click suppression, next normal click, and movement cancellation exercised.
- Build emits taglib browser-externalization, large-chunk, and ineffective dynamic-import warnings; they are not resolved by this UI pass.

### Next highest-value work — strict order
1. **Review this UI prototype**, refine, then pin agreed behavior with browser tests. Do not start a broad visual rewrite before this feedback.
2. **[DONE 2026-10-21] Queue/playback reliability characterization** (2A), before playlist implementation. Invariant matrix + characterization tests landed; no refactor was performed, and the gaps it exposed are registered rather than patched. See "Phase 2A closure" at the end of this file and [docs/QUEUE-INVARIANTS.md](../QUEUE-INVARIANTS.md).
3. **Queue semantics redesign (2D)** — [QUEUE-DESIGN.md](../QUEUE-DESIGN.md) §6 order, starting with row identity + duplicates. Every step updates its matrix row and test in the same commit.
4. **Small, test-backed reliability extractions**, only where the matrix proves duplication or drift. Keep queue mutations in their existing choke point and playback transport ownership unchanged.
5. Shared rating editor/display and Settings decomposition in separately reviewable, behavior-preserving increments.
6. Saved view/filter presets, with separate explicit apply-to-auto-queue action. No hidden queue changes when selecting a library preset.
7. Server playlists + queue export (3B) after 2D step 6; file import after the review UI exists.

### Reliability gate before playlists — ALL 8 CLOSED 2026-10-21
- [x] Document intended behavior for user vs auto queue, promotion/history, active anchor, recent cooldown, tier exhaustion/wrap, shuffle, loop-one/all, and independent auto sort/filter settings. → [docs/QUEUE-INVARIANTS.md](../QUEUE-INVARIANTS.md) §1–§11 (76 invariants, every row pointing at a passing test).
- [x] Characterize bulk play/enqueue with empty input, missing library IDs, repeated IDs, a track present in both sections, and active track within the imported list. → `tests/queueBulkImport.test.ts` (7 tests); the unguarded cases are registered as matrix gap **G4**.
- [x] Preserve within-section unique IDs, section-prefixed keys, active identity across mutations, and existing refill/anchor rotation. → pinned by `tests/queueMutation.test.ts` (incl. the 10k×6 fuzz), `tests/queueContinuation.test.ts`, `tests/queueManagerFill.test.ts`. The as-built uniqueness rule is now superseded by the 2D decision (duplicates legal); the matrix row rewrite lands with that change. Playlist duplicate/order semantics are registered in [QUEUE-DESIGN.md](../QUEUE-DESIGN.md) §7.3: import preserves both.
- [x] Test restore with stale IDs/duplicates, clear/remove/drag around active, rapid Next/Previous, and sort/filter changes while playing. → `tests/queueRestore.test.ts`, `tests/queueRestoreAnchor.test.ts`, `tests/queueMutation.test.ts` (4 new drag/remove cases), `tests/playbackManagerNav.test.ts` (6), `tests/queueManagerFill.test.ts` (4).
- [x] Cover native snapshot/refresh/trackChanged identity reconciliation, stale events, and web/native advance parity. → `tests/queueContinuation.test.ts`, `tests/nativeTransport.test.ts`, `tests/playbackManagerNative.test.ts`, `tests/nativeReconcile.test.ts`, plus the new same-tick web nav suite. A passing Node suite still does NOT verify the native engine on a phone — the 2026-10-17 physical acceptance item remains open.
- [x] Run relevant queue mutation/fill/manager/transport suites plus queue drag/row browser tests. → `npm test` 1382/1382; `npx playwright test` queueRows + queuedragdup + queueContinuation + queueflood = 12/12 passing. No assertions were weakened and no queue/playback behavior was changed.
- [x] Define export scope (user queue versus combined queue), playlist ownership/read-only behavior, missing tracks, server unavailable, and playlist-ID migration handling. → matrix §15 registers all seven decisions with a recommended default and rationale.
- [x] Verify Navidrome/Subsonic playlist endpoint behavior and permissions against the configured server/docs. → matrix §15 records the doc/source verification (Subsonic API docs + Navidrome `server/subsonic/playlists.go`, `persistence/playlist_repository.go`, `core/playlists/playlists.go`): create-with-id REPLACES tracks, update is incremental (0-based remove indexes), repeated `songId` keeps order AND duplicates, non-admins see own+public, mutations need owner-or-admin, missing = code 70, forbidden = code 50, both inside HTTP 200 bodies. NO live server was contacted in this environment — the server-instance check is a Phase 3 field task, not a claim made here.

### Deferred quality backlog — retain for later prioritization
- [ ] Consistent empty/error/retry states for Albums/Artists and source failures; distinguish authentication failures from offline rather than labeling every cached fallback offline.
- [ ] Accessibility sweep: meaningful labels and state-specific tooltips, keyboard navigation/focus return, touch targets, reduced motion, and readable contrast.
- [ ] Remove unnecessary framing/duplicate affordances across library, queue, player, and Settings using one surface-at-a-time demos.
- [ ] Connection recovery and progress consistency: avoid busy spinners for parked operations; preserve useful work on retry and explain what is waiting.
- [ ] Queue pool explanation: expose filter exhaustion/cooldown/wrap reasons quietly when relevant, not as permanent debug chrome.
- [ ] Evaluate library search/discovery and playlist organization after core browsing and queue behavior are dependable.

### Responsive review follow-up (2026-10-20)
- Production and fixtures now share `PushConfirmShell.svelte`: native `showModal()`, explicit auto margins (fixing the left-floated native dialog), viewport-constrained width/height with 16 px edge space, scrollable body, Escape/outside-click dismissal, modal focus containment and focus return. No push policy or write behavior changed.
- The fictional “New discovery” title was a fixture for an unknown baseline, NOT an app state. Replaced with an explicit Reckoner rating change (40 → 80). Unknown baselines remain supported without inventing previous file values.
- Review rows now expose × → Keep/Discard and update their count, without any file writes. Production retains its existing confirmed per-row discard path; narrow confirmation/footer controls can wrap.
- Verification after final source edits: `npm run check` passed (0 errors/warnings); 41 activity/push unit tests passed; `git diff --check` passed. Six durable development browser tests passed across 320×568, 390×844, 844×390, 1280×800 and 1920×1080; all eight production smoke/push/migration tests passed (including real mocked atomic writes and per-row discard).
- Preview remains at `http://127.0.0.1:5179/mmdrome/?uiPreview`. Native iOS/VoiceOver and non-Chromium browser verification remain outstanding. Existing build warnings remain unchanged. No commit or deployment performed.

### Final push-dialog design review (2026-10-20)
- User approved the tinted-change design. Final rows use 64 px covers, title alone, structured artist · album metadata, yellow rating tags and red loved tags; paths span the full row below. Artwork uses the existing LazyThumb loader for live library tracks and a neutral fallback for orphan rows. Review artwork is synthetic and offline.
- Final copy: “Updates only rating and loved tags. A wrong file link applies these tags to the wrong file. Tags can be corrected later if you know the previous values. Verify the paths below.” The audio re-encoding clause, intended-track clause, and previous-values paragraph were removed at the user's request. Baseline derivation remains probe-only; removing explanatory copy does not change data semantics.
- Review assessment: clearer hierarchy and less repeated explanation; tag tint separates rating versus loved without relying solely on color (symbols, values, and arrows remain). Full-width paths and confirmed per-row discard preserve the safety review. Unknown baselines still render target values without invented arrows. A 64 px cover aligns with the ordinary three-row block; long metadata and wrapped tags deliberately grow the text block rather than clipping it.
- Final verification after copy cuts: `npm run check` 0 errors/warnings; six development browser tests across five phone/landscape/desktop sizes passed; eight production push/migration/smoke tests passed. Browser checks include thumbnails, new hierarchy, removed copy, centering/padding, no horizontal dialog overflow, outside/Escape dismissal, focus return, and fixture discard. Existing build warnings remain. iOS/Safari/VoiceOver checks and broader accessibility/touch-target audit remain outstanding; do not describe this as a completed device review.

### Push-dialog accessibility hardening (2026-10-20)
- Shared `PushDiscardButton` now provides a 44×44 CSS-pixel square hit target, 24 px × SVG, explicit focus outline, track-specific name, and expanded state. Production and fixture use the same control; Keep/Discard and footer controls have ≥44 px height.
- Dialog receives initial focus (not a discard action), exposes the warning as its accessible description, wraps Tab/Shift+Tab within enabled controls, and recovers focus to the dialog after a removed row. Native showModal retains background inertness and Escape/outside dismissal with focus return. File count updates are polite status announcements; rating/loved tags carry explicit spoken old/new labels rather than relying on glyph pronunciation or color.
- Production Write is disabled while a discard is in flight, preventing the confirm/discard race from starting a write. Discard confirmation now mentions both rating and loved changes.
- Verification: eight development browser tests passed, including square target geometry, accessible names/description, focus containment/removal recovery, enlarged-text (200% root size) narrow reflow, plus existing five viewport layouts. Eight production browser tests passed; strengthened production focus/44px geometry assertions then passed in all five push tests. Typechecks pass with 0 warnings/errors. Existing build warnings remain.
- Readiness: this dialog is locally verified in Chromium, not a blanket app release certification. Safari/iOS real-touch + VoiceOver, other screen readers, and a comprehensive app-wide accessibility audit remain unverified. No commit, release, or deployment authorized/performed.

### Discard target size refinement (2026-10-20)
- At the user's request, the shared × control is now a 32×32 CSS-pixel square (`h-8 w-8`), retaining the 24 px icon, accessible name/expanded state, and visible keyboard focus. This supersedes the earlier 44 px discard geometry; Keep/Discard/footer controls retain ≥44 px height. The smaller target exceeds WCAG 2.2's 24 px minimum but does not meet the enhanced 44 px target recommendation.
- Updated geometry assertions in review and production tests. Typechecks, eight review/accessibility tests and five production push tests passed after the change.

### Resume instructions
- Working tree contains this session's uncommitted UI changes. Do not commit, deploy, discard, or stage other work without authorization.
- Start/reuse Vite on a free local port (last used 5179), then open `/mmdrome/?uiPreview`. Persistent services may be gone after a session restart.
- `src/main.ts` loads the review root instead of App in dev preview mode; it must not import App statically or boot playback merely to show fixtures.
- The **row and activity strip** are shared production components; the surrounding review dialog is a fixture shell, not proof of production modal accessibility or discard interactions. Push/migration e2e tests cover the actual write/discard surface.
- File baselines come only from successful probes, can be stale, and are explicitly labeled last-probed. Do not reintroduce Navidrome values as previous WebDAV values.
- Roadmap descriptions above are proposals, not permission to unify intentionally independent queue/library semantics. No playlist or queue-policy changes were made in this increment.

### Phase 2A closure — queue/playback reliability characterization (2026-10-21)

**Deliverable:** [docs/QUEUE-INVARIANTS.md](../QUEUE-INVARIANTS.md) — 76 invariants across sections/uniqueness, the active anchor, promotion/history, the recency cooldown, fill tiers/exhaustion/wrap, shuffle, loop mode & manual navigation, persistence/restore, the native bridge, the bulk-import boundary, and the browser-level pins. Every row names a real passing test (H7's reload proof is `tests/e2e/persistence.spec.ts` — it snapshots the rendered sections and anchor, reloads, and compares); §13 registers the five gaps; §15 registers the Phase 3 boundary decisions; §16 states what is out of scope; §17 records the one behavior whose intent is undecided (manual Next at the tail) as an open product question, not an intent.

**Tests added (+27; suite 1355 → 1382):**
- `tests/queueBulkImport.test.ts` (7) — `playAll` shape: empty import, duplicate ids, unknown-library ids (and the stall on them), the actively-playing track inside the import, cross-section duplicate on enqueue + promote collapse, `playNext` on an empty queue, recency reset.
- `tests/queueRestore.test.ts` (3) + `tests/queueRestoreAnchor.test.ts` (1) — persisted-row dedupe (first occurrence), active re-anchor by id, out-of-range anchor → −1, legacy `historyQueue`, and the first full library sync dropping stale ids / re-anchoring.
- `tests/queueMutation.test.ts` (+4) — dragging the active user row with an auto duplicate, drag identity resolving to the user occurrence, rapid removals above the active row, and removal being section-scoped.
- `tests/playbackManagerNav.test.ts` (6) — the same-tick Next gap, Next at the tail never wrapping, Previous restart/wrap, Next-then-Previous ordering, and the natural-end wrap/stop matrix on the web path.
- `tests/queueManagerFill.test.ts` (+4) — filter change mid-play (kept row vs excluded row vs last row) and sort change mid-play.
- `tests/playbackManagerRestore.test.ts` (+2) — the shuffle-toggle rebuild subscription and the loop-one fade-cancel subscription.

**Gaps found (characterized, NOT repaired — behavior changes were out of scope):**
- **G1/G2** — a filter or sort change while an AUTO row plays rewrites `autoQueue` without re-anchoring `activeIndex`; the anchor can name a different row, or sit past the end. This breaks B1 and contaminates the native refresh payload. Highest-value queue fix before playlists.
- **G3** — a second Next press inside the load window (anchor advanced, `currentTrack` not yet written) is read as "the active row was removed" and re-targets the SAME row; a quick double-tap skips one row instead of two.
- **G4** — `playAll` is an unguarded bulk boundary: no dedupe, no library validation, `activeIndex 0` even for an empty array (an unknown id can stall the advance chain). Exactly the shape a server playlist import can produce (the server retains duplicates and order).
- **G5** — drag identity is id-only, so the auto occurrence of a cross-section duplicate cannot be dragged independently.

**Verification:** `npm run check` 0 errors / 0 warnings; `npm test` 1382/1382; `npx playwright test tests/e2e/{queueRows,queuedragdup,queueContinuation,queueflood}.spec.ts` 12/12. No queue or playback behavior changed for this increment. On-device native verification remains outstanding (2026-10-17 plan), and the playlist endpoint check is docs/source-level only — no live server was available.

### Phase 2A audit closure + 2D design agreement (2026-10-21b)

**Audit pass committed** as `3f4bb61` ("Close the queue matrix's audit holes"): H7 now has a real reload proof in `tests/e2e/persistence.spec.ts` (rendered sections + anchor snapshotted, reloaded, compared); B1/E9 carry their G1/G2 caveat inline; L2 is an open product question (Q1) rather than an invented intent; the citation/status-vocabulary defects are fixed. Verification: `npm run check` 0/0, `npm test` 1382/1382.

**2D decisions (recorded in full in [docs/QUEUE-DESIGN.md](../QUEUE-DESIGN.md)):**
- Pressing a song starts that song: drop its auto copy, append a user occurrence, play. Only the active row is an exemption (resume, no clone). Auto-row presses consume the skipped prefix; user-row presses stay positional.
- User-queue duplicates are legal; + always appends. Auto duplicates appear only when a refill can add no new id (unique pass first, then cycle the existing suggestions).
- Row identity is the occurrence: occurrence-scoped keys, row-scoped removal, occurrence drag payload, occurrence-aware native entry ids, restore/reconcile without dedupe.
- Any filter/sort edit (including the library→auto apply) promotes the audible auto row, clears `recentTrackIds`, discards the kept prefix and rebuilds. Shuffle rebuilds but does NOT reset recents. This closes G1/G2 structurally.
- Skip exactness via an explicit pending-target fact (two presses = two rows).
- Auto queue can be switched off; off clears the tail. Auto-off is defined as the direct form of a filter matching nothing, so repeat-all has one definition: loop-all wraps to `userQueue[0]`, loop-none stops, loop-one loops the song, Previous at the first row is a no-op.
- The played pile grows intentionally; no automatic cap (clear-above/below/all remain).
- Playlist v1 = server playlists + queue export; file import deferred (formats researched in QUEUE-DESIGN §7.5).

**Next:** implement 2D in the order listed above (row identity and duplicates first); 2B (rating editor/display extraction) and 2C (Settings decomposition) remain open and independent. The native pause bug is tracked separately in QUEUE-DESIGN §8 and needs a physical device run.

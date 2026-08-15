# mmdrome — Technical Debt & Refactor Plan

Prioritized plan from the 2026-08-10 audit, re-verified item-by-item against the
code on 2026-08-11 (verdicts and evidence below — every open item is a CONFIRMED
issue; stale items were closed or rewritten).

Design principles:
1. **Clean models for the intended behavior** — a correct abstraction beats the
   straightforward patch (PlaybackCore over per-path patches; a recency
   window over plain caps).
2. **Logic lives in pure, injectable modules** — every new decision (retry, park,
   loop, state transitions, trim, scoring) is a pure function/class over plain
   data with injected callbacks/clock. Thin adapters bind it to DOM/Swift. This
   is what makes testing possible and is enforced per item, not aspirational.

The test foundation (0.5) lands BEFORE any refactor so every change is
regression-checked. **Verification per item = `npm run check` AND `npm test`**;
Swift items additionally via `ios.yml` (`xcodebuild` + `swift test`).

Legend: `[ ]` open · `[x]` done · HIGH/MED/LOW impact · anchors are file +
symbol (line numbers drift — grep the symbol). **[DECISION]** needs a product
call before implementation.

---

## Phase 0 — Foundations, invariants & test foundation

Fixes that establish invariants the later phases rely on. Ship these first.

- [x] **0.1** Native: audio scheduling on the main thread — closed 2026-08-12:
      `TrackFileLoader` rewritten over a pure `LoaderState` (claim/chain/
      complete/evict; cache now stores `URL` directly, the `LoadedFile`
      wrapper is gone) in a NEW dependency-free `BackgroundAudioCore` package
      (`native/BackgroundAudioCore/Sources/Core` — its own SPM root, so
      `swift test` on the macOS host never builds the Capacitor-bound plugin,
      whose XCFrameworks carry no macOS slices), and the URLSession
      downloadTask completion now hops to `DispatchQueue.main.async` — the
      loader dicts, AVFoundation graph mutation and `RunLoop.main` timers are
      all main-thread-only (matching `handleSegmentCompletion`). The
      chained-pendingCompletion behavior is preserved 1:1 (including the
      stale-fire parity case: an evicted in-flight task's late completion is
      a no-op via the generation guard). **Test**: XCTest target
      `BackgroundAudioTests` (6 cases: claim-refuses-duplicates, chain/
      complete single-fire + chain order, store/cached, evict-all, full
      cycle) with `swift test` added to `ios.yml` — it runs the Core+Tests
      closure on the macOS host (Capacitor never enters that build; the
      manifest declares `.macOS(.v13)` so the host build is unambiguously
      legal). `AudioEngine.swift` `TrackFileLoader`/`loadAndStart` — HIGH
- [x] **0.2** Native: sleep-timer lifetime invariant — closed 2026-08-12 via
      the recommended re-arm-from-JS path (JS owns the authoritative armed
      state): new pure `src/lib/sleepTimerMirror.ts` — `rearmDecision`
      (inactive → no re-arm; minutes → exact remaining minutes recomputed
      from `endsAt`, sub-minute precision, ~1s floor when already expired so
      the pause still arrives; endOfTrack → re-arm the flag with minutes
      passed through). `sleepTimerManager.rearmAfterSnapshot()` re-sends
      `BackgroundAudio.setSleepTimer` after every queue snapshot, invoked
      from `_nativeLoadPlay` — the ONLY `setQueue` call site (covers
      next/prev/select/retry and queue-end wraps); `refreshQueue` needs no
      re-arm (no `stopPlayback`). No Swift change. **Test**: seed suite
      `tests/sleepTimerMirror.test.ts` (6 cases, fake clock: inactive,
      exact-remaining, sub-minute, expired-floor, endOfTrack passthrough,
      idempotence). `AudioEngine.swift` `setQueue`/`stopPlayback`,
      `src/lib/sleepTimer.ts` `set` — HIGH
- [x] **0.3** Normalize CJK-safe everywhere — closed 2026-08-12: the two
      normalization sites consolidated into the pure `src/lib/matchNormalize.ts`
      — `normalizeForMatch` (the existing `/[^\p{L}\p{N}\s]/gu` version) plus
      `normalizeForHint` as an alias (cannot drift again) and
      `filenameHintsTitle`, which now also skips empty normalized titles
      (`if (!title) continue`) so a symbol-only title (`"!!!"` → `""`) can
      never `.includes("")`-match every file. metadataScanner's ASCII-only
      copy deleted; metadataReader/metadataScanner import the single source.
      **Test**: seed suite `tests/matchNormalize.test.ts` (table: CJK/emoji/
      diacritics/symbols → stable tokens, alias-cannot-drift, empty-title
      never matches, leading-track-number stripping, CJK filename matching,
      empty-base no-match). NOTE: title-scoring changes only affect FUTURE
      scoring — already-unmatched CJK rows heal via force rescan or the File
      Matching picker (fingerprint-gated retry).
      `src/lib/metadataScanner.ts` `normalizeForHint` — HIGH
- [x] **0.4** Credential-swap invariant — closed 2026-08-12:
      `refreshIndex`/`rebuildIndex` capture `currentIndexKey()` BEFORE the
      probe await — a mid-probe swap can no longer stamp a foreign index
      (in-memory AND the persisted Dexie snapshot) with the new baseKey; and
      `setWebdavCredentials` now bumps `scanGen` + sets `cancelled = true`
      alongside the existing `tagProbeGen` bump, so in-flight `processItem`s
      abort at their next guard and the drain loop stops re-dispatching the
      old run. Previously the swap (which clears `index = []`) let
      post-swap-dispatched items match against the empty index and mass-clear
      every binding via the vanished-clear branch, and pre-swap items with an
      in-flight fetch re-stamped foreign paths with the new baseKey.
      `src/lib/metadataScanner.ts` `refreshIndex`/`rebuildIndex`/`setWebdavCredentials` — HIGH
- [x] **0.5** **[TEST FOUNDATION — closed 2026-08-12; every refactor item is gated on it]**:
      - **Harness, zero new deps**: `scripts/test-loader.mjs` — a ~20-line ESM
        `resolve` hook (self-registers via `module.register` — `--import` alone
        only evaluates the module; candidate appending: plain specifier →
        `.ts` → `.js` → `/index.ts` → `/index.js`, extensioned + bare
        specifiers delegated) + `node --test` (Node 24 type stripping is
        default-on; `npm test` uses default test discovery — `**/*.test.ts` —
        because `node --test tests/` fails with `ERR_UNSUPPORTED_DIR_IMPORT`).
        `package.json`: `"test": "node --test --import ./scripts/test-loader.mjs"`.
      - **Seed suites** (`tests/`, 46 tests, permanent-ize the deleted scratch
        scripts): `recentWindow.test.ts` (LRU dedupe/move-to-end/cap-oldest,
        sanitize-keep-newest, 10k-transition bound/unique/recency-order sim),
        `queueMutation.test.ts` (targeted scenarios for every builder incl.
        tier-3 cross-section collapse + transition-window promote + the
        10k×6-seed fuzz: anchor invariant, section uniqueness, drag
        row-count preservation, null = no-write), `libraryFilters.test.ts`
        (aggregates rated-only, any-track rating semantics, genre token
        matching, year/length bounds, sort matrix, input immutability),
        `tagWriter.test.ts` (POPM round-trip property on the 10-step grid,
        off-grid landing, MusicBee-calibrated write-map + read-boundary spot
        checks, the asymmetric-maps drift asserted so nobody "aligns" them).
      - **Type safety**: `tsconfig.test.json` (module/moduleResolution
        `esnext`/`bundler` for Vite-style extensionless imports, noEmit +
        `allowImportingTsExtensions`, `erasableSyntaxOnly` — suites stay
        Node-strip-compatible, `strict`, noUnusedLocals/Parameters,
        `paths` `$lib/*` WITHOUT `baseUrl` — TS6 deprecates it, relative
        `./src/lib/*` targets) folded into `npm run check` (chained after
        tsconfig.node.json). First tsc pass caught a real dead import —
        `PlayQueueState` removed from appState.ts.
      - **CI**: `.github/workflows/test.yml` — ubuntu, `actions/setup-node@v4`
        node-24, `npm ci && npm test && npm run check`, on push + PR.
      - Verified in CI: taglib-wasm's Node entry (`dist/index.js`) loads under
        plain Node 24 (no `--experimental-wasm-exnref` needed); the
        `localStorage` guards in libraryFilters.ts make it Node-safe; each
        test file runs in its own child process and inherits `--import`.
      - **Fallback** (documented, not chosen): vitest as the single added
        devDependency if the loader proves fragile. — HIGH

## Phase 1 — Playback architecture (the centerpiece)

### 1.0 PlaybackCore — one orchestration, three transports (NEW, HIGH)

`playbackManager.ts` (1130 lines) runs the same orchestration three times over:
3 load paths (`_loadAndPlay`/`_loadAndPlayInBg`/`_nativeLoadPlay`), 3 retry
machines (web `_handlePlaybackError` 3 attempts, native `_onNativeError` 2,
bg zero), 4 copies of the park→loop-one→advance→loop-all→stop chain
(`_onTrackEnded`, `_onBgTrackEnd`, `_handleExitBackground`,
`_handleCrossfadeEnd`), and 3-way routing in `next`/`prev`/`playTrackAt` — the
docs/DEVLOG.md log's parity-fix tax ("prev parity", "pause parity", …) is the
symptom. Replace with a transport abstraction, **test-first at every step**:

- **Step 1 — Policy modules (pure, LANDED 2026-08-13)**: `src/lib/playbackCore/`
  holds three pure, store/DOM-free modules with table-driven suites
  (`tests/{advanceDecider,retryPolicy,bgStateMachine}.test.ts`, 65 cases):
  `AdvanceDecider` (park → loop-one → advance → loop-all → stop, `fromError`
  aware — pins the guard order of the four advance sites), `RetryPolicy` (ONE
  exponential-backoff machine, configurable cap — web 3×1s/2s/4s, native 2×,
  bg max 0), `BgStateMachine` (`foreground · handoff{enter|load} · bg-playing ·
  bg-paused · park-pending · resuming`, `exitBg{ended,atEnd,wasPlaying,
  position,trackId,parkArmed,loopMode,hasNext,hasUserQueue}` events, `load{
  target,decision}`/`pause`/`play`/`resumeFg`/`carryPaused`/`stop` commands;
  fake clock N/A — pure reducer). Deliberate fixes pinned by tests (three
  exit-behavior + same-day re-review): exit-bg park gated on
  `parkArmed && (ended || atEnd)` (was: paused mid-track playback on unlock),
  `bg-paused`/paused exits carry the bg position (`carryPaused`), exit-bg ended
  chain routes loop-one → RESTART, a re-hide during the fg resume re-engages
  the swap (`resuming + enterBg → handoff{enter}`), lock-screen pause during a
  handoff parks immediately (`handoff + pauseCmd → bg-paused`), a superseding
  load during an enter-swap re-routes to the fg load path on exit
  (`handoff{superseded}`). `pendingStop`
  deliberately OUT of the machine (load-time guard, stays with sleep-timer).
  **Deferred to Step 2**: the `PlaybackTransport` interface/types.ts — no dead
  code before the adapters land.
- **Step 2 — WebTransport (LANDED 2026-08-13)**: extracts the audioManager a/b +
  crossfade + preloader orchestration into `src/lib/playbackCore/webTransport.ts`
  (injected `WebTransportEngine`/`WebTransportTimers`); the crossfade
  rescue/reconcile block (`_handleCrossfadeEnd` 858-899) is now a pure
  `reconcileCrossfadeTarget` (`crossfadeReconcile.ts` — wrap > rescue >
  repoint; rescue is anchor-CHANGING → applied via direct `queue.update`, NOT
  `_mutateQueue`); retry ownership moved into the adapter (1.2 checkpoint);
  1.10's three sub-items done (standby `play().catch`, `cancelNext` on
  stop/loop-one branches, armed-RG refresh on switch). **Tests**:
  `tests/{crossfadeReconcile,replayGain,webTransport}.test.ts` (42 cases)
  against a fake engine — crossfade target reconcile (still queued / removed
  mid-fade / loop-all wrap), replay-gain field refresh BEFORE the ended event
  (1.10's third sub-item), retry schedule + give-up → natural+fromError.
- **Step 3 — WebBgTransport (LANDED 2026-08-13)**: `src/lib/playbackCore/
  webBgTransport.ts` owns the bg element, visibilitychange (wired only when
  `engine.isIOS`), settle token, 250 ms watchdog + position tick, swap, park
  nudge; the interlock soup (`_inBgMode`, `_enterBgSeq`, `_handlingEnd`,
  `parkedAtEnd`, `pendingStop`, mediaSession watchdog) became BgStateMachine
  transitions. Retry (1.2) rides `RetryPolicy` with the bg cap (0). Policy
  exits: `onLoad`/`onStop`/`onParked`/`onTick` — the transport NEVER touches
  queue/stores/sleepTimer. Rewired `playbackManager` (bg machinery deleted
  from `audioManager`; `_onBgTrackEnd`/`_handleExitBackground` gone; 1.11
  closed in the mediaSession rewrite: seekto routes through the manager —
  clamp + `clearPendingStop`); A4's decideAdvance adopted by `_onTrackEnded`.
  **Tests**: `tests/webBgTransport.test.ts` (50 cases, fake engine/element/
  timers/`document` stub) — full transition graph incl. the exit-bg park gate
  reporting `onParked`; 236 total pass. Review round 2 added the manager-glue
  suite (`tests/playbackManagerBg.test.ts`, 17 cases) — `PlaybackManager` takes
  injectable deps (audioManager/queueManager/sleepTimerManager/transports),
  `AudioManager`'s a/b elements are lazy (Node-safe ctor), and the suite pins
  the settle-safe `_bgLoad` store ordering + decision resolution + fg/bg
  routing.
- **Step 4 — NativeTransport (JS-only; no Swift round-trip)**: the native
  adapter — a SIBLING of `WebBgTransport`, NOT a `PlaybackTransport`: that
  contract is element-shaped (`playLoaded`/`prepareNext`/`playbackElement`),
  the native engine is command/event-shaped (it owns the clock) — the bg
  adapter's policy-event-callback precedent wins over a forced shared
  interface. Shape: injected `NativeEngineClient` (structural — the real
  `nativeEngine` satisfies it) + injectable timers (deterministic node tests).
  - **Owns** (A6 boundary — never touches queue/stores/sleepTimer): plugin
    listeners; `engage(snapshot, activeIndex, loopMode)` = `setQueue` +
    `playTrackAt` with **fail-fast** (1.6: active url empty → reject, no
    plugin calls — no more fake 'playing' over a dead engine); **engage
    serialization** (NEW — pre-existing race found in review: two rapid
    `_nativeLoadPlay` calls interleave at their awaits →
    `setQueue(A)→setQueue(B)→playTrackAt(B)→playTrackAt(A)` leaves the engine
    on queue B, index A; adapter gets a settle-style in-flight guard +
    pending-latest-request, like the bg settle token); queue-sync coalescing
    (`scheduleSync(lazyFactory)` — microtask collapse; snapshot built only
    when a refresh actually fires, fresh at fire time); 250 ms position poll
    → `onTick`; `RetryPolicy` native `{maxAttempts: 2, baseDelayMs: 1000}`
    (exact 1s/2s parity), track-keyed validity, give-up →
    `onTrackEnded({kind:'natural', fromError:true})`; seek-retry memory (1.7:
    remember the clamped target, re-issue `seek` after the retry's engage
    resolves, cleared on engage/trackChanged/user-seek); reload reconcile
    (1.5 JS side, below); `play`/`pause`/`seek`/`setLoopMode` routing.
  - **Stays in the manager**: `_buildSnapshot` (needs config + queueManager),
    `_onNativeTrackChanged` (queue re-anchor/adopt — the B1 exemption),
    store writes + promote/replenish/rearmAfterSnapshot (0.2) after a
    successful engage, `_handlingNativeEnd` guard, `loopMode`/`settings`
    subscriptions (forward to transport methods).
  - **`_onNativeEnd` → the A4 chain**: the last hand-rolled
    park→loop-one→advance→loop-all→stop copy (besides `_handleCrossfadeEnd`)
    becomes `decideAdvance({fromError, parkArmed: false, loopMode, hasNext,
    hasUserQueue})` — park stays native-side on iOS (`sleepTimerFired` pauses
    at the natural end). advance → `advanceQueue()` + engage; wrap →
    `setActiveQueueIndex(0)` + engage; restart → re-engage current; stop →
    clear stores + `disengage()`. Retry give-up enters the same chain.
  - **1.5 JS side — reload reconcile**: pure `nativeReconcile.ts`
    `reconcileReload(state, combined, isKnown)` → `{kind:'idle'} |
    {kind:'resync', trackId, index, position} | {kind:'stop'}` — by trackId,
    NEVER state.index (E7: the engine's index refers to the last-sent
    snapshot; the combined queue's own indexOf is the truth); `index: -1` =
    re-adopt (the `_onNativeTrackChanged` idx<0 branch). NO deferral needed:
    App.svelte awaits `loadLibraryFromNavidrome()` before
    `playbackManager.init()` (verified 2026-08-13) — library + restored
    queue are populated before `_initNative` runs. Unknown trackId → 'stop'
    (warn + stop, the honest signal).
  - **Tests**: `tests/nativeReconcile.test.ts` (pure — lands first),
    `tests/nativeTransport.test.ts` (fake plugin + timers: engage happy path
    + fail-fast, retry 1s/2s → give-up natural/fromError, stale-retry
    validity, seek memory, engage serialization with out-of-order
    resolutions, coalescing burst → ONE refreshQueue with the final
    snapshot, poll start/stop, event forwarding, command routing),
    `tests/playbackManagerNative.test.ts` (glue via the DI seam: native
    `ended` → A4 advance/wrap/stop/restart, engage fail-fast → stopped,
    trackChanged re-adopt, rearmAfterSnapshot after engage).
  - **Not in this step**: 1.4's Swift half (emit `ended` on `refreshQueue`
    divergence) — batches with the 1.1/1.8 crossfade CI round-trip.
- **Step 5 — Deletion**: `playbackManager` shrinks to policy + queue wiring;
  delete the dual paths. **Absorbed items: 1.2, 1.9, 1.10, 1.12, 1.13** — each
  is a verification checkpoint in the steps above, not a separate patch.
- **Sequencing/risk**: never a big-bang — each step ends with `npm run check` +
  `npm test` + the behavior-parity checklist (loop-one/park/sleep/retry/
  crossfade) run manually on the PWA; the deletion step is last. Step 4 itself
  lands in five sub-steps, each gated: (a) pure `nativeReconcile.ts` + suite
  — LANDED 2026-08-13; (b) NativeTransport skeleton (init/listeners/poll/
  coalescing/engaged) + suite — LANDED 2026-08-13 (self-review added the
  stale-settle guard: a disengage/destroy mid-engage drops the settle via an
  engagement generation, plus a compile-time shape test pinning the real
  `nativeEngine` against `NativeEngineClient`); (c) retry + seek memory +
  fail-fast + engage serialization + suite — LANDED 2026-08-13;
  (d) manager rewiring (DI + `isNative` seam, `_initNative` shrink,
  `_onNativeEnd` → A4 `decideAdvance`, routing) + glue suite — LANDED
  2026-08-13 (299 tests); (e) deletion + `npm run build` + doc updates —
  LANDED 2026-08-13 (AGENTS.md E9, DEVLOG; manual PWA/device parity checks
  remain).
  Native-path verification limits: `ios.yml` stays green but cannot exercise
  the JS bridge — manual device testing for snapshot/advance/retry under real
  queue mutations.

### Native crossfade/scheduler package (Swift, one CI round-trip)

> **NOT DEFERRED** — 1.1/1.4/1.8 are Swift-only and cannot be compiled on the
> Windows dev box, but they are REQUIRED work and are verified via
> `.github/workflows/ios.yml` (`xcodebuild` + `swift test`) on push to `main`.
> Do NOT skip or indefinitely defer them on the "no local toolchain" excuse —
> each lands as: write the Swift + XCTest → push → read CI output → iterate.

- [x] **1.1** Crossfade fade-out is dead — closed 2026-08-14 (commit
      `3b99419`, ios.yml run 51 green): `startCrossfade` called `rampVolume`
      twice; the second call invalidated the shared `volumeRampTimer` before
      its first tick, so the fade-out gain stayed pinned until
      `finalizeCrossfadeSwitch` snapped it. Fix: pure `RampPlan` + `RampCurve`
      in `BackgroundAudioCore` drive ONE 40-step timer (`rampCrossfade`)
      ramping BOTH gains in lockstep (identical linear/t²/sigmoid math; the
      per-node `rampVolume` is deleted). **Test**: `CrossfadeTests.swift`
      dual-ramp profile (monotonic, endpoints, invalidation) — passed in CI.
      `AudioEngine.swift` `startCrossfade`/`rampCrossfade` — HIGH
- [x] **1.8** `pause()` mid-crossfade leaves `volumeRampTimer`/
      `crossfadeActive`/`crossfadeTargetIndex` live (the ramp closure never
      checks `isPlaying`; the minutes sleep timer can pause mid-fade →
      wrong-volume/wrong-track switch on resume) — closed 2026-08-14 (same
      commit/CI): `pause()` now tears the trio down (ramp stop +
      `standbyScheduleGeneration` bump + standby stop + `refreshActiveGain`
      restore, mirroring `refreshQueue`/`setLoopMode`/endOfTrack-sleep); the
      engine's three fields collapsed into one `CrossfadeState` value (phase +
      target index) with the pure transition model in Core, so they can never
      drift. **Test**: `CrossfadeTests.swift` state transitions
      (armed/in-flight/paused/resumed) — passed in CI.
      `AudioEngine.swift` `pause()` — MED
  (Bundled: same state, one CI build; 0.1's `LoaderState` is the shared half.)

### Native JS↔engine contract package (Swift + plugin, one CI round-trip)

- [x] **1.4** `refreshQueue` divergence fallback stops with no `ended`/`error`
      — closed 2026-08-14 (commit `48af3aa`, ios.yml run 54 + test.yml run 14
      green): JS kept stale indexes and the next `play()` restarted a different
      track than JS believed current. The divergence branch now fires
      `onQueueEnded?()` after the reset (mirroring `handleTrackEnd`) — the
      honest `ended` signal flows through the already-pinned JS path (transport
      `onQueueEnded → onTrackEnded(natural)`; manager `_onNativeTrackEnded →
      decideAdvance → advance re-engages with a FRESH snapshot / stop →
      disengage), so no JS change was needed. Decision is the pure
      `queueDivergence(snapshotActiveId:engineCurrentId:)` in Core (empty/empty
      → synced; one empty → divergent; equality check; out-of-range snapshot
      index modelled as an empty id). **Test**: `QueueDivergenceTests.swift`
      (5-case matrix) — passed in CI. `AudioEngine.swift` `refreshQueue` — MED
- [x] **1.5** Webview-reload reconciliation — closed 2026-08-14. The pure
      `reconcileReload` (step 4a) is now WIRED: `_initNative` calls
      `_reconcileNativeReload()` after `transport.init()`, mapping
      `NativeTransport.getState()` through `reconcileReload` (trackId +
      combined `indexOf` + library `findTrack`, NEVER `state.index`).
      `resync` → `transport.adopt(trackId)` (marks engaged + `_lastTrackId`
      + starts the 250 ms poll WITHOUT `setQueue`/`playTrackAt` — re-sending
      the snapshot would kill the engine's live playback) then re-anchors via
      `_onNativeTrackChanged` + sets `currentTime`/`playbackState`; `stop`
      (unknown trackId) → warn + `_stopPlayback()`; `idle` → no-op. A
      `getState` rejection skips gracefully. Pinned by 5 cases in
      `tests/playbackManagerNative.test.ts`.
      `src/lib/playbackManager.ts` `_reconcileNativeReload`,
      `src/lib/playbackCore/nativeTransport.ts` `adopt` — MED
- [x] **1.6** Empty/url-less snapshot — closed 2026-08-13 (absorbed into
      PlaybackCore step 4c): `NativeTransport._doEngage` fail-fast rejects an
      active row with no url BEFORE any plugin call (`no playable track at
      index`), and `_nativeLoadPlay` maps `engage() === false` → `setCurrentTrack(null)` +
      `setPlaybackState('stopped')` — no more fake "playing" over a dead engine.
      The Swift nil-URL guard already drops the track; the fix was the JS side
      surfacing it. **Test**: `tests/nativeTransport.test.ts` (engage rejection
      paths) + `tests/playbackManagerNative.test.ts` (engage fail → stopped).
      `src/lib/playbackCore/nativeTransport.ts` `_doEngage`,
      `src/lib/playbackManager.ts` `_nativeLoadPlay` — MED
- [x] **1.7** Seek position lost on the "Track not ready" retry — closed
      2026-08-13 (absorbed into PlaybackCore step 4c): `NativeTransport.seek`
      remembers `{trackId, position}` (`_seekMemory`) and the retry's reload
      engage of the SAME track re-issues the clamped seek after `playTrackAt`
      resolves (`positionBias` is wiped by Swift's `loadAndStart`); consumed on
      re-apply, cleared on disengage/give-up, and only an ACTIVE retry's
      engage re-seeks (plain re-engages never do). **Test**:
      `tests/nativeTransport.test.ts` (seek-retry memory cases).
      `src/lib/playbackCore/nativeTransport.ts` `seek`/`_doEngage` — MED

### Media session (independent, LOW)

- [x] **1.11** Lock-screen seeks — closed 2026-08-13 by the mediaSession
      rewrite (Step 3): `seekto` routes through the manager's `seek()`, which
      clamps to metadata duration AND clears `pendingStop` (bg included —
      `sessionElement`). — LOW
- [x] **1.3** Web bg-mode end-of-track sleep — closed 2026-08-11 by the
      advance-hook park guard at all four advance sites; the residual
      failed-`playBg`-never-fires case folds into 1.0's RetryPolicy. — HIGH

## Phase 2 — Queue model

- [x] **2.1** One owner for all queue math — closed 2026-08-11 (concrete
      methods over the private `_mutateQueue` choke point; pure builders in
      `src/lib/queueMutation.ts`, fuzz-verified; `setActiveQueueIndex` stays in
      appState by design; `removeFromUserQueue` the documented position-
      semantics exception). See docs/DEVLOG.md 2026-08-11 entry. — MED
- [x] **2.2** `playNext` off-by-one family — closed 2026-08-11 by the
      `_mutateQueue` id-based re-anchor. — MED
- [x] **2.3** `historyQueue` → `recentTrackIds` LRU window — closed 2026-08-10. — MED
- [x] **2.4** **[DECIDED 2026-08-14 — option b]** `removeFromUserQueue` when
      removing the *active* track — the pure reducer
      `queueMutation.removeFromUserQueue` now KEEPS `activeIndex` so the
      highlight slides to the next playable row (never the already-played
      predecessor). Preceding-row removal decrements (the active id slid down);
      following-row removal is a no-op anchor; removing the active LAST row
      lands the anchor past the new end (out of range, bounds-checked like −1).
      Removed id cools in the recency window regardless. **Advance-chain
      corollary (review finding, fixed)**: the playing track is not in the
      queue after an active-row removal, so the advance paths target
      `activeIndex` itself via the pure `advanceTargetIndex(q, combined,
      playingId)` (`_hasNextQueued`/`advanceQueue`/`next`) — otherwise
      end-of-track stopped/wrapped and `next()` no-op'd with the next row
      right there. **Test**: `tests/queueMutation.test.ts`
      (preceding/active/following/last-active × auto depths, recency
      inscription, out-of-range null no-op, advanceTargetIndex matrix),
      `tests/playbackManagerAdvance.test.ts` (end-of-track + next() after
      active-row removal advance to the next row; control unchanged).
      `src/lib/queueMutation.ts` `removeFromUserQueue`/`advanceTargetIndex`,
      `src/lib/queueManager.ts` `removeFromUserQueue`
- [x] **2.5** **[DECIDED 2026-08-14 — do NOT bound]** `userQueue` growth: the
      user queue is left UNBOUNDED. Promotion stays the intended behavior
      (played tracks stay listed; they ARE the anti-repeat context). The
      played-prefix trim (`trimPlayedPrefix`) is rejected — no cap is applied.
      The recency window (`recentTrackIds`, `RECENT_LIMIT`) already bounds
      anti-repeat memory separately, so queue growth costs only UI list length,
      not correctness. Revisit only if list rendering becomes a measured
      problem.
- [x] **2.6** `queueWrapNotice` lifecycle — closed 2026-08-10. — LOW
- [x] **2.7** Native interplay of 1.4's ended-on-divergence with active-row
      removal (2.4 option b) — CLOSED 2026-08-14 as **"removing the current
      track skips to the next row, on both platforms"** (the user's original
      2.4 intent; the 1.4 review surfaced that web had quietly implemented
      play-out instead). Native already skips: the engaged tail sync sends a
      snapshot whose `combined[activeIndex]` is the NEXT row ≠ the engine's
      `currentTrackId` → 1.4's divergence branch emits `ended` → `decideAdvance`
      (playing-track-aware, 2.4) advances immediately — even under loop-one,
      the 'restart' engage targets `activeIndex`, which post-removal IS the
      next row, so the engine plays the next row and `trackChanged` syncs JS.
      Web now matches: `QueueView` reports the removed id (manager
      `removeFromUserQueue` returns it) → `playbackManager.handleQueueRowRemoved`
      runs the SAME A4 chain NOW, with the park skipped (the skip supersedes
      the end-of-track sleep park, matching the engine's divergence stop
      cancelling its timer) and loop-one disabled (a removed track is
      unloopable). `removeFromUserQueue` no longer returns void.
      **Edge pinned during the parity review (same commit)**: NO successor
      (the removed row was the active LAST one, or the queue emptied) → BOTH
      platforms play the track out to its natural end, then stop/wrap —
      `handleQueueRowRemoved` early-returns when `_hasNextQueued()` is false,
      mirroring the native sync guard (bails on the out-of-range index) and
      the Swift empty-snapshot guard (no-op), so web must not cut the audio.
      The loop-one natural-end RESTART is also made removal-proof on both
      platforms: `_onTrackEnded` (web) and `_onNativeTrackEnded` stop when the
      current track has left the combined queue — a removed track is
      unloopable and its out-of-range index can't re-engage. A future "stop
      now for the last row" would require relaxing the native sync guard + the
      Swift empty-snapshot guard (a CI round-trip); deliberately not done.
      **Tests**: `tests/playbackManagerAdvance.test.ts` (immediate skip,
      loop-one still advances, non-active removal no-op, native handler no-op,
      last-row play-out, loop-one removed-track stop) +
      `tests/playbackManagerNative.test.ts` (loop-one restart-guard stop).
      Pre-1.4 the same divergence silently STOPPED playback, so this is a
      strict improvement over both prior behaviors.

## Phase 3 — Sync / metadata pipeline hardening

- [x] **3.1** Push flatten vs concurrent re-bind — closed 2026-08-14: the
      post-PUT re-pend is now a pure `shouldKeepPushPending(stale, live)` in
      `src/lib/pushReconcile.ts`, diffing `rating`/`loved` AND
      `webdavPath`/`webdavBase`/`comments`/`matchSource`/`ignored` — a mid-push
      File Matching re-bind (the PUT went to the OLD file, the NEW file was
      never written), a comments change, a manual-bind marker flip, or a
      dismissal is kept `pending_sync` instead of flattened to `synced` with
      the stale values (flattening writes the whole snapshot back). **Test**:
      `tests/pushReconcile.test.ts` (no live row, not-pending, identical, each
      diverging field incl. cleared/set matchSource + ignored, syncStatus-only
      no-op).
      `src/lib/syncEngine.ts` `runManualWebDAVSync`,
      `src/lib/pushReconcile.ts` `shouldKeepPushPending` — MED
- [x] **3.2** Navidrome-mode stale seeds — closed 2026-08-14: the song cache
      stores raw `NavidromeSong[]` incl. `starred`/`userRating`;
      `seedNavidromeFeedback` ran unconditionally on cached connects → in
      `ratingSource:'navidrome'` mode an offline/lastScan-matching start
      re-applied stale server values over local `synced` edits (which commit
      straight to the server, never `pending_sync`, so the pending-skip guard
      couldn't protect them). Fix: pure `shouldSeedFeedback(loadResult)` in
      `syncCachePolicy.ts` (`cached !== true` → seed), gating the seed in
      `loadLibraryFromNavidrome` — a cached connect carries no fresh server
      data, so the persisted Dexie metadata cache is authoritative. The
      per-row source/pending logic in `seedNavidromeFeedback` is untouched.
      **Test**: `tests/syncCachePolicy.test.ts` (cached skip is
      source-independent + offline-fallback skip; live/undefined-cached seed;
      per-row guards remain pinned by metadataWriters).
      `src/lib/syncEngine.ts` `loadLibraryFromNavidrome`,
      `src/lib/syncCachePolicy.ts` `shouldSeedFeedback` — MED
- [x] **3.3** Pagination guard — closed 2026-08-14: the search3 loop is now a
      pure `paginateSearch3(fetchPage, { pageSize, maxPages })` driver in
      `navidromeApi.ts` — it caps pages (default 200×500), stops on a
      short/empty tail, AND stops on a repeated first id (an offset-ignoring
      server returns the same page forever; the dedupe halts after one repeat
      instead of accumulating duplicates up to the cap).
      `loadNavidromeSongs` is a thin wrapper passing a `callSubsonic` closure.
      **Test**: `tests/navidromeApi.test.ts` — repeat-page dedupe (2 fetches,
      one page accumulated), fresh-pages cap (200 pages, 100k songs),
      partial-tail early stop.
      `src/lib/navidromeApi.ts` `paginateSearch3` — MED
- [x] **3.4** Stale cached config — closed 2026-08-14: `setCachedConfig` was
      never called with `null`; clearing the Navidrome fields (no dedicated
      "disconnect" — credentials are cleared by committing empty fields via
      `commitCredentials`) left `_cachedConfig`/`coverConfig` serving stale
      URLs until restart. Fix: pure `cachedConfigMatches(cached, baseUrl,
      username)` in `navidromeApi.ts` (identity = trimmed url + user; password
      change is ignored); `commitCredentials` clears the cache when the
      committed identity no longer matches, and `connectNavidrome` clears it
      on the no-config (disconnect) path and on any identity mismatch before
      the connect attempt (success re-sets it via `loadNavidromeSongs`, the
      offline fallback re-sets it from the fresh config). **Test**:
      `tests/navidromeApi.test.ts` (null/identity-match/url-swap/user-swap/
      whitespace-normalization/password-change matrix).
      `src/lib/navidromeApi.ts` `cachedConfigMatches`,
      `src/views/SettingsView.svelte` `commitCredentials`,
      `src/lib/syncEngine.ts` `connectNavidrome` — MED
- [x] **3.13** **[TEST]** load-pipeline orchestration planner + browser e2e —
      closed 2026-08-14: the inline decisions in `loadLibraryFromNavidrome`
      (bail rule, cached-connect seed skip, WebDAV auto-scan gating) were
      untested glue — a future "simplification" could drop a gate and every
      pure test would still pass. Extracted into pure `planNavidromeLoad`
      (`src/lib/navidromeLoadPlan.ts`): apply iff songs present OR
      (connected && !error); seed iff applying AND songs present AND
      `shouldSeedFeedback`; `configureWebdav`/`scanWebdav` gated on creds +
      `navigator.onLine`. The async glue is now a thin interpreter.
      **Test**: `tests/navidromeLoadPlan.test.ts` (9-case matrix: fresh apply,
      cached no-seed, disconnected/failed bail, empty-server truth, cached
      fallback applies, scan online/offline/bail) + `tests/e2e/sync.spec.ts`
      (route-mocked Subsonic: fresh connect seeds; scan-timestamp-matching
      reconnect serves "(from cache)" and does NOT re-paginate search3).
      `src/lib/navidromeLoadPlan.ts` `planNavidromeLoad`,
      `src/lib/syncEngine.ts` `loadLibraryFromNavidrome` — MED
- [x] **3.5** Normalize `webdavBase` keys — closed 2026-08-14: rows were
      stamped with the TRIMMED key but Push compared a raw
      `getSetting("webdavUrl")` build, so stray whitespace flagged the whole
      library "Server URL updated" (only masked by `commitCredentials`
      trimming first; pre-trim persisted rows never re-stamp). Fix: ONE pure
      `webdavBaseKey(url, user)` in `webdavUtils.ts` (trim url + trim user;
      trailing slash AND case preserved deliberately — the stamp predates the
      fix and kept the trailing slash, so normalizing it away would flag every
      existing row `wrongServer`) now feeds BOTH
      `metadataScanner.currentIndexKey` (the stamp) and
      `runManualWebDAVSync`'s current-server check; `setWebdavCredentials`'
      change-detection normalizes through the same key. **Test**:
      `tests/webdavBaseKey.test.ts` (trim, trailing-slash-preserved, case
      preserved, pure/deterministic, `normalizeUrl` interior-path check).
      `src/lib/webdavUtils.ts` `webdavBaseKey`,
      `src/lib/metadataScanner.ts` `currentIndexKey`,
      `src/lib/syncEngine.ts` `runManualWebDAVSync` — MED
- [x] **3.6** Index/probe hygiene — closed 2026-08-14:
      (a) the persisted index snapshot now goes through pure
      `slimIndexForPersistence` (content-probe `tags` dropped — they live in
      the `webdavFileTags` cache; `path`/`filename`/`size`/`lastModified` kept;
      the fingerprint still hashes `path|size`, so the prior-fingerprint diff
      is unaffected) in both `refreshIndex` and `rebuildIndex`;
      (b) the manual-bind re-READ (`processItem`'s manual path) now re-checks
      `pending_sync` AND `ignored` after its fetch and carries `ignored`
      through the `updateMetadata` full-row replace — a mid-fetch dismissal is
      no longer dropped (aligned with the auto-match branch);
      (c) `processItem`'s `!track` guard (mid-scan library replacement) now
      counts `scannedCount++` + `updateScanProgress()` instead of returning
      silently, so the drain loop can still reach `done === total` and complete
      instead of stalling at "Scanning X/Y";
      (d) `stripBasePath` now falls back to the raw href when
      `decodeURIComponent` throws, so one malformed PROPFIND href can't abort
      the whole index build.
      Also removed the dead `newIndex` parameter from `findChangedTracks`
      (surfaced once the new suite type-checked `metadataReader` under the
      strict test tsconfig). **Test**: `tests/indexHygiene.test.ts` (slim keeps
      fields/drops tags/doesn't mutate/keeps the fingerprint; stripBasePath
      path + full-URL strip + malformed-href survival). (b)/(c) are
      scanner-glue, `[not test-pinned]`.
      `src/lib/metadataScanner.ts` `processItem`/`refreshIndex`/`rebuildIndex`,
      `src/lib/metadataReader.ts` `slimIndexForPersistence`/`stripBasePath` — LOW
- [x] **3.6t** **[TEST]** pure matching/scoring core — closed 2026-08-15:
      extracted into `src/lib/metadataCore.ts` (DOM/Dexie-free; only
      `matchNormalize` + type imports): `matchTrackToWebdav` +
      `matchTrackToWebdavCandidates` (scoring, evidence gate, ambiguity ties,
      tag-led-uncertain), `verifyEntryAgainstTrack`, `computeIndexFingerprint`
      (FNV), `slimIndexForPersistence`, `buildPathTimestamps`, and the mtime
      diff (`findChangedTracks` via the new single comparison point
      `mtimeChanged` — raw-string semantics preserved today; 3.7b normalizes
      both sides to epoch INSIDE it, callers untouched). `metadataReader`
      (network/taglib adapter) and `metadataScanner` (glue) import from the
      core; `debugTrackData` too; `stripBasePath` moved to `webdavUtils` so
      `indexHygiene.test.ts` is fully taglib-free. **Test**:
      `tests/metadataCore.test.ts` (16 cases — exact-filename bind,
      size-only-never-binds + picker near-miss + size-only-tie parity,
      probe-contradiction suppression, duplicate-title ambiguity,
      tag-led-uncertain in BOTH views, certain-tag bind, CJK match + CJK
      never-near-matches-ASCII (0.3 in the scoring path), substring bind,
      excludePaths, fingerprint order-stability/mtime-blindness/add-rename-
      resize, mtimeChanged matrix, findChangedTracks split,
      verifyEntryAgainstTrack matrix). POPM round-trip was ALREADY pinned by
      `tests/tagWriter.test.ts` — no port needed. Feeds 3.7's mtime tests.
      `src/lib/metadataCore.ts` — LOW
- [ ] **3.7** Comments/mtime — (a) the webdav-mode scan writes file comments,
      wiping a cached comment when the file has none (file is authoritative by
      design, but preserve the cached value when the file lacks the tag);
      (b) mtime comparison is raw-string inequality — servers omitting
      `getlastmodified` re-read every such row per scan, and format variance
      after a server switch mass-flags unchanged files. Normalize both sides to
      epoch. **Test**: mtime compare matrix (RFC1123/ISO/absent ×
      changed/unchanged) via the 3.6t module.
      `src/lib/metadataScanner.ts` `findChangedTracks`/`processItem` — LOW
- [ ] **3.8** WebDAV write hardening — (a) orphan `.mmdrome-tmp` cleanup on
      startup (DELETE exists only on failure paths); (b) the push confirmation
      never surfaces missing-ETag ("blind overwrite"); (c) the dialog count
      includes `ignored` rows that Push skips → overstated count.
      `src/lib/syncEngine.ts` `webdavPutAtomic`,
      `src/views/SettingsView.svelte` `safeCount` — LOW
- [x] **3.9** Pre-PUT live-row re-validation — closed 2026-08-15: pure
      `shouldSkipBeforePut(stale, live, currentBaseKey)` in `pushReconcile.ts`
      (skip when `!live.webdavPath || live.ignored || live.webdavPath !==
      stale.webdavPath || live.webdavBase !== currentBaseKey`), re-checked
      before BOTH the initial PUT and the conflict retry's re-PUT in
      `runManualWebDAVSync` — a skipped row un-marks its `pushedPaths` entry
      (so a later same-path row can still push) and counts skipped, never
      synced. Pinned in `tests/pushReconcile.test.ts`. OUT OF SCOPE kept: a
      full mid-push credential swap that has not yet re-stamped rows (would
      need re-reading url/user/token, not just baseKey; self-heals via 3.1's
      `webdavBase` diff on the next scan). `src/lib/syncEngine.ts`
      `runManualWebDAVSync` — MED
- [x] **3.10** **[TEST]** scrobble accrual policy suite — closed 2026-08-15:
      pure `advancePlayhead(played, lastPos, pos, duration)` + exported
      `canScrobble` in `scrobbleManager.ts` (manager's `onTick` now consumes
      the step), pinned by `tests/scrobbleAccrual.test.ts` — forward seeks ≥
      5 s never credited, backward ≥ 5 s resets `played`, positive deltas
      accrue, clamp to duration, 50 % / 4-min listen rule. A9 tag updated to
      `[test-enforced: tests/scrobbleAccrual.test.ts]`. — HIGH
- [x] **3.11** **[TEST]** syncEngine connect/load policy extraction — closed
      2026-08-15: pure `cachedLibraryUsable(cached, baseKey, opts)` in the new
      `src/lib/syncCachePolicy.ts` (baseKey validation, non-empty, fresh-path
      forceRefresh + scan-freshness gating, offline fallback deliberately NOT
      gated by forceRefresh — matches the original semantics exactly), wired
      into `connectNavidrome`'s fresh/offline paths, pinned by
      `tests/syncCachePolicy.test.ts`. D14 tag updated to
      `[test-enforced: tests/syncCachePolicy.test.ts]`. `src/lib/syncEngine.ts`
      `connectNavidrome` — MED
- [x] **3.12** **[TEST]** web `sleepTimerManager` suite — closed 2026-08-15:
      pure `webCountdownStep` in `src/lib/sleepTimer.ts` (tick/expire/stop
      transitions; manager's `tick`/`stop` now consume it), pinned by
      `tests/sleepTimerWeb.test.ts` — countdown expiry → pause via the
      registered handler, `parkAtEnd`/`isParkedAtEnd`/`parkedTrackId` carry,
      `consumePendingStop`/`clearPendingStop`. `src/lib/sleepTimer.ts` — MED

## Phase 4 — UI & state layer

- [x] **4.1** Settings credential fields debounce — CLOSED 2026-08-11 by
      store-write-through (every input calls `updateSetting` directly;
      `commitCredentials` guarantees persistence before network calls —
      strictly better than the proposed per-field debounce; do not re-open;
      the AGENTS.md §4 C1 "never reintroduce a mirror" gotcha stands). — MED
- [ ] **4.2** SettingsView mount-time scroll restore — CONFIRMED: the save
      `$effect`'s first run sees scrollTop 0, writes `scrollTops[tab] = 0` to
      sessionStorage before `onMount`'s `await tick()` applies the restore →
      restore defeated AND the session corrupted. Guard the first save (skip
      writes until after the onMount restore). (Component-level — manual
      verification + `npm run check`; too DOM-bound for the node suite.)
      `src/views/SettingsView.svelte` — MED
- [ ] **4.3** Dead code removal — `readFileMetadataWithIndex`, `clearCoverCache`,
      `formatEqText`, `getAllPresets`, `createSingleCurveEqAudioBuffer`,
      LazyThumb `size` prop, `updateNowPlaying` (TS interface + Swift
      registration/handler — remove in lockstep), `destroy()` (3 impls, zero
      callers; note sleepTimer's listener cleanup if teardown is ever needed).
      Confidence via seeded suites + grep; `npm run check` catches dangling
      references. — LOW
- [ ] **4.4** Native lock-screen artwork race — `fetchArtwork`'s completion
      unconditionally re-applies art; an out-of-order completion (older fetch
      finishing last) stamps stale art over the current track. Guard against
      the current trackId (needs a "last updated trackId" field — doesn't exist
      yet). **Test**: artwork-cache decision as a pure struct (request/
      completion ordering × current-trackId) + XCTest.
      `NowPlayingController.swift` `fetchArtwork` — LOW
- [ ] **4.5** Native resource polish — (a) cache filenames via `String.hashValue`
      (process-seeded → full re-download per launch + orphaned files) → FNV /
      sanitized id; (b) `state()` opens `AVAudioFile` for zero-duration tracks
      even while stopped (the 250 ms poll + `refreshNowPlaying`); (c)
      SessionController's block-observer tokens are discarded → registrations
      unremovable. (CapacitorHttp `status:-1` REFUTED for the v8 iOS stack —
      network errors reject, never resolve with −1; dropped.)
      `AudioEngine.swift` `destinationURL`/`state()`, `SessionController.swift` — LOW
- [x] **4.6** **[TEST]** eqStore suite — closed 2026-08-15:
      `tests/eqStore.test.ts` pins `initEqStore` restore (saved-state preset
      fallback, bypass via `persisted`), `saveUserPreset`'s builtin-name →
      `custom_` re-id, `deleteUserPreset`'s active-preset fallback to flat,
      `saveAsCurrentPreset` branching — row-shaped Dexie stubs per F3 (filter
      + get/put on ONE shared Table prototype). `src/lib/eq/eqStore.ts` — MED
- [x] **4.7** **[TEST]** e2e depth — closed 2026-08-15: `tests/e2e/persistence.spec.ts`
      (a) QueueView filter panel: clear maxRating/minRating, assert the inputs
      snap to 100/0 (pins the 2026-08-15 rating-clear fix in the real bundle);
      (b) round-trips: minRating set to 40 and the shuffle toggle both survive
      a reload (persisted-store restore in the bundle; the loop toggle sits in
      a currentTrack-only region and was swapped for shuffle — the Controls-row
      toggle reachable on the empty app). No library/server needed. — LOW

## Phase 5 — Documentation & knowledge base

- [ ] **5.1** AGENTS.md corrections — `_bgTrackEndHandled` does not exist (§3;
      actual: `_handlingEnd` + sleep-park trackId + `_enterBgSeq`);
      `effectiveDuration` is still exported and used; the CJK fix was applied
      only to `normalizeForMatch`, not `normalizeForHint`; "prompt arrays kept
      only for capped rows" is false (retained on every row; the cap is
      client-side — the function's own docstring repeated the falsehood, fixed
      2026-08-11); "`deriveFileType` in `navidrome.ts`" → `navidromeApi.ts`;
      the "native setSpeed doesn't echo to the store" note is stale
      (`engineFacade.ts:51/61` write stores since 2026-08-05). All sub-claims
      re-verified; corrections applied in the docs/DEVLOG.md 2026-08-11 entry.
- [ ] **5.2** Document the decided invariants: sleep-timer lifetime vs queue
      resets (0.2), webview-reload behavior (1.5), `refreshQueue` divergence
      policy (1.4), the PlaybackCore transport contract + bg state machine
      (1.0), queue semantics (2.4 option b, 2.5 unbounded), and the test
      harness (0.5) conventions — where suites live, the purity rule.
- [ ] **5.3** Add a "Verification" note to AGENTS.md (`npm run check` + `npm
      test` + `ios.yml` as the only native compile gate) and reference this
      TODO file. — applied 2026-08-11 (§5 of AGENTS.md now carries the gates).

---

## Verification gates

- Every item: `npm run check` **and** `npm test`; `npm run build` before CI pushes.
- JS CI: `.github/workflows/test.yml` (node 24, push + PR) — new (0.5).
- Swift: push to `main` → `ios.yml` (`xcodebuild` + `swift test` for the new
  XCTest target).
- Manual PWA checks for bg-mode items (1.0 step 3 and survivors): lock the
  screen mid-track, verify advancement, sleep timer, crossfade.
- Deliberately NOT unit-tested (documented scope): Svelte component/DOM
  behavior (would need vitest+jsdom; contradicts the zero-dep ethos) — the
  decision logic behind it IS tested; components stay thin.
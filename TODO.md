# mmdrome — Technical Debt & Refactor Plan

Prioritized plan from the 2026-08-10 audit, re-verified item-by-item against the
code on 2026-08-11 (verdicts and evidence below — every open item is a CONFIRMED
issue; stale items were closed or rewritten).

Design principles:
1. **Clean models for the intended behavior** — a correct abstraction beats the
   straightforward patch (PlaybackCore over per-path patches; a bounded
   played-prefix over plain caps).
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
- **Step 4 — NativeTransport**: owns `setQueue`/`refreshQueue`/`playTrackAt`,
  the 250 ms position poll, `_hasNativeEngaged`, queue-sync coalescing, getState
  reconcile (1.5 JS side), fail-fast empty snapshot (1.6 JS side), seek-position
  retry memory (1.7 JS side). **Test**: fake `BackgroundAudio` plugin object —
  snapshot build, coalescing (burst of queue writes → one refresh), divergence
  handling, reload-reconcile outcomes.
- **Step 5 — Deletion**: `playbackManager` shrinks to policy + queue wiring;
  delete the dual paths. **Absorbed items: 1.2, 1.9, 1.10, 1.12, 1.13** — each
  is a verification checkpoint in the steps above, not a separate patch.
- **Sequencing/risk**: never a big-bang — each step ends with `npm run check` +
  `npm test` + the behavior-parity checklist (loop-one/park/sleep/retry/
  crossfade) run manually on the PWA; the deletion step is last.

### Native crossfade/scheduler package (Swift, one CI round-trip)

- [ ] **1.1** Crossfade fade-out is dead — `startCrossfade` calls `rampVolume`
      twice back-to-back; the second call invalidates the shared
      `volumeRampTimer` before its first tick, so the fade-out gain stays pinned
      until `finalizeCrossfadeSwitch` snaps it. Fix: ONE 40-step timer ramping
      both gains (matches `rampStepCount`). **Test**: extract `RampPlan`
      (start/end/target per node, step count) as a pure struct + XCTest
      (dual-ramp profile, invalidation-on-pause).
      `AudioEngine.swift` `startCrossfade`/`rampVolume` — HIGH
- [ ] **1.8** `pause()` mid-crossfade leaves `volumeRampTimer`/
      `crossfadeActive`/`crossfadeTargetIndex` live (the ramp closure never
      checks `isPlaying`; the minutes sleep timer can pause mid-fade →
      wrong-volume/wrong-track switch on resume). Tear down the trio like
      `cancelScheduled`, minus the node stops. **Test**: `CrossfadeState`
      struct transitions (armed/in-flight/paused/resumed) + XCTest.
      `AudioEngine.swift` `pause()` — MED
  (Bundled: same state, one CI build; 0.1's `LoaderState` is the shared half.)

### Native JS↔engine contract package (Swift + plugin, one CI round-trip)

- [ ] **1.4** `refreshQueue` divergence fallback stops with no `ended`/`error` —
      JS keeps stale indexes and the next `play()` restarts a different track
      than JS believes current. Emit `ended` on divergence (the honest signal;
      JS re-snapshots on it). **Test**: divergence decision as a pure function
      (snapshot activeId vs engine currentId → action) + XCTest +
      NativeTransport test. `AudioEngine.swift` `refreshQueue` — MED
- [ ] **1.5** Webview-reload reconciliation — `_initNative` never calls
      `getState()`; after a reload the engine keeps playing while JS shows
      nothing, and the first `play()` kills it via `setQueue`. Resync
      `currentTrack`/`playbackState`/`activeIndex` by trackId when playing;
      warn + stop when the trackId is unknown to the library. API exists —
      pure wiring (JS side inside NativeTransport, tested in step 4).
      `src/lib/playbackManager.ts` `_initNative`,
      `src/lib/nativePlugin.ts` `getState` — MED
- [ ] **1.6** Empty/url-less snapshot — `_buildSnapshot` yields `url:''`
      without a Navidrome config, yet `_nativeLoadPlay` still sets
      `setPlaybackState('playing')` while native drops every track (nil-URL
      guard) and `playTrackAt` silently returns → UI "playing" over a dead
      engine. Fail fast: reject the call, surface the error.
      `src/lib/playbackManager.ts` `_buildSnapshot`/`_nativeLoadPlay`,
      `AudioEngine.swift` track init — MED
- [ ] **1.7** Seek position lost on the "Track not ready" retry — the retry
      replays from 0 (`positionBias` wiped by `loadAndStart`). Retry the same
      position (transport remembers the clamped target and re-issues `seek`
      after the retry's load resolves, or add an optional start position to
      `playTrackAt`). `AudioEngine.swift` `seek`/`loadAndStart` — MED

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
- [ ] **2.4** **[DECISION]** `removeFromUserQueue` when removing the *active*
      track — pick: (a) stop playback, (b) keep `activeIndex` so the highlight
      slides to the next playable row (one-line change; UI already tolerates
      −1), or (c) current behavior (decrement; correct continuation, wrong
      highlight). Implement + document. Removed id cools in the recency window
      regardless. **Test**: behavior matrix — remove active/preceding/last user
      row × auto depths × each choice; pure builder updated + fuzz-extended.
      `src/lib/queueManager.ts` `removeFromUserQueue`
- [ ] **2.5** **[DECISION]** `userQueue` growth — promotion is the INTENDED
      behavior (played tracks stay listed; auto rows promote and remain; the
      played rows ARE the anti-repeat context). Model the queue as `played
      prefix (rows < activeIndex) | deliberate tail (rows ≥ activeIndex)` and
      bound ONLY the played prefix: new pure builder `trimPlayedPrefix(q, cap)`
      (oldest-drop, cap aligned with `RECENT_LIMIT`, id re-anchor), folded into
      the same `queue.update` as `advanceQueue`/`promoteActiveTrack`. Deliberate
      rows are never dropped; dropped prefix ids need no extra cooling (already
      in `recentTrackIds` via `advanceTo`); no provenance marker needed. Cap +
      interplay with 2.4's choice documented. **Test**: trim boundary cases
      (cap < activeIndex+1, empty queue, all-deliberate, all-promoted), id
      re-anchor after trim, trim-enabled fuzz runs.
      `src/lib/queueMutation.ts` `promoteActiveTrack`,
      `src/lib/queueManager.ts` `advanceQueue`
- [x] **2.6** `queueWrapNotice` lifecycle — closed 2026-08-10. — LOW

## Phase 3 — Sync / metadata pipeline hardening

- [ ] **3.1** Push flatten vs concurrent re-bind — the post-PUT re-pend exists
      but compares only `rating`/`loved`; a mid-push File Matching re-bind
      (path/base change) or comments-only edit is flattened to `synced` with
      the OLD path/base. Widen the re-pend comparison to
      `webdavPath`/`webdavBase`/`comments`. **Test**: re-pend decision as a pure
      function (stale snapshot × live row variants).
      `src/lib/syncEngine.ts` `runManualWebDAVSync` — MED
- [ ] **3.2** Navidrome-mode stale seeds — the song cache stores raw
      `NavidromeSong[]` incl. `starred`/`userRating`; `seedNavidromeFeedback`
      runs unconditionally on cached connects → in `ratingSource:'navidrome'`
      mode an offline/lastScan-matching start re-applies stale server values.
      Skip seeding when `loadResult.cached === true` (or mark cache rows).
      **Test**: seed-decision matrix (cached × ratingSource × pending_sync
      rows). `src/lib/syncEngine.ts` cached-return paths,
      `src/stores/appState.ts` `seedNavidromeFeedback` — MED
- [ ] **3.3** Pagination guard — `loadNavidromeSongs`' `while(true)` loop has no
      max-page cap/dedupe; a server ignoring `songOffset` fetches forever.
      Cap pages + dedupe (reject a page whose first id repeats). **Test**:
      pagination driver as a pure generator over a fake fetch — offset-ignoring
      server terminates within the cap; dedupe stops repeat pages.
      `src/lib/navidromeApi.ts` `loadNavidromeSongs` — MED
- [ ] **3.4** Stale cached config — `setCachedConfig` is never called with
      `null`; removing credentials leaves `_cachedConfig`/`coverConfig` serving
      stale URLs until restart. Clear on credential removal.
      `src/lib/navidromeApi.ts` `setCachedConfig` — MED
- [ ] **3.5** Normalize `webdavBase` keys — rows are stamped with the TRIMMED
      key, but Push compares the raw `getSetting("webdavUrl")` build → a
      trailing slash/whitespace flags the whole library "Server URL updated"
      (only masked by `commitCredentials` trimming first; pre-trim persisted
      rows never re-stamp). Derive both sides from one normalized URL (trim in
      `runManualWebDAVSync` as the cheap fix). **Test**: key derivation ×
      trailing-slash/whitespace/case variants (property: stamp-key and push-key
      always equal for the same URL). `src/lib/metadataScanner.ts`
      `currentIndexKey`, `src/lib/syncEngine.ts` `runManualWebDAVSync` — MED
- [ ] **3.6** Index/probe hygiene — (a) `refreshIndex`/`rebuildIndex` persist
      the full TAGGED index to Dexie on every probe (the prior-fingerprint diff
      depends on it — slim the persisted shape, don't stop persisting);
      (b) the manual-bind fetch path re-checks `pending_sync` but NOT `ignored`,
      and the `updateMetadata` full-row replace DROPS the ignored flag (the
      auto-match branch re-checks it — align both); (c) `processItem`'s mid-scan
      library-replacement guard returns without `scannedCount++` → progress
      stalls forever (count, don't stall); (d) `stripBasePath`'s
      `decodeURIComponent` sits outside the try/catch — one malformed href
      aborts the whole index. `src/lib/metadataScanner.ts` `processItem`,
      `src/lib/metadataReader.ts` `stripBasePath` — LOW
- [ ] **3.6t** **[TEST]** extract the pure matching/scoring core
      (`matchTrackToWebdav`, candidates, evidence gate, fingerprint FNV,
      mtime-epoch compare) into a DOM/Dexie-free module; port the empirical
      scenarios as permanent suites — ambiguity ties, tag-led-uncertain rule,
      size-only never auto-binds, CJK normalization (0.3), fingerprint
      change-gating, POPM round-trip. Feeds 3.7's mtime tests. — LOW
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
      (1.0), queue semantics (2.4, 2.5 played-prefix policy), and the test
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
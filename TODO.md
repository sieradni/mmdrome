# mmdrome — Technical Debt & Refactor Plan

A prioritized, phase-ordered plan produced from the holistic codebase audit (2026-08-10).
Each phase ends with a coherent, buildable, verifiable state (`npm run check`; Swift changes
verified via the `ios.yml` CI workflow, which is the only place the native engine compiles).
Items marked **[DECISION]** need a product/design decision before implementation.

Legend: `[ ]` open · `[x]` done · `HIGH/MED/LOW` impact · `#ref` file:line

---

## Phase 0 — Foundations & invariants

Fixes that establish invariants the later phases rely on. Ship these first.

- [ ] **0.1** Native: run audio scheduling on the main thread — hop the `TrackFileLoader.prefetch`
      completion to `DispatchQueue.main.async` (generation guard preserved), and make the loader's
      `cache`/`activeTasks`/`pendingCompletions` dicts main-thread-only. Fixes data races + AVFoundation
      graph mutation + `RunLoop.main` timer scheduling from the URLSession delegate queue.
      `native/BackgroundAudio/ios/AudioEngine.swift:135-157,693-705` — HIGH
- [ ] **0.2** Native: sleep-timer lifetime invariant — a JS-driven queue snapshot (`setQueue` via
      `_nativeLoadPlay`: next/prev/select/retry) must NOT cancel an armed sleep timer. Decide:
      re-arm from JS after `setQueue`, or stop cancelling in `stopPlayback()` when the reset is a
      queue snapshot. `AudioEngine.swift:340,853-857` + `src/lib/sleepTimer.ts:69-104` — HIGH
- [ ] **0.3** Normalize CJK-safe everywhere — port the `\p{L}\p{N}` normalization from
      `metadataReader.normalizeForMatch` into the scanner's `normalizeForHint` (and any other
      `[^\w\s]` pattern). Restores the documented "never sweep the server" probe guard.
      `src/lib/metadataScanner.ts:181-195` — HIGH
- [ ] **0.4** Credential-swap invariant — a foreign index must never be stamped with a new baseKey:
      capture `currentIndexKey()` BEFORE the probe await in `refreshIndex`/`rebuildIndex`, and bump
      `scanGen` (not just `tagProbeGen`) in `setWebdavCredentials` so an in-flight scan aborts.
      Gate SettingsView's `testWebdav` auto-scan on `status !== 'scanning'`.
      `src/lib/metadataScanner.ts:66-110`, `src/views/SettingsView.svelte:200-220` — HIGH

## Phase 1 — Playback correctness (web + native)

- [ ] **1.1** Native: crossfade fade-out is dead — the second `rampVolume` call invalidates the first
      ramp's timer before its first tick. Run both ramps from ONE 40-step timer (or two independent
      timers with a shared invalidation guard). `AudioEngine.swift:948-995` — HIGH
- [ ] **1.2** Web bg-mode: failed `playBg` skips tracks with zero retry and loop-one can wedge.
      Mirror the foreground retry policy (exponential backoff) or surface the failure via
      `onBgError` instead of routing it to the advance handler.
      `src/lib/playbackManager.ts:94,658-662,683-689` — HIGH
- [x] **1.3** Web bg-mode end-of-track sleep: watch paused 1-2 s into the next track or never
      fired. **Closed 2026-08-11 by the advance-hook** — the park guard fires at the advance
      decision itself (all four advance sites, incl. the bg watchdog path), so the pause lands at
      the natural end and the full track plays; the failed-`playBg`-never-fires sub-case remains
      tracked under **1.2**'s retry-then-advance.
      `src/lib/sleepTimer.ts:56-78,122-127`, `src/lib/playbackManager.ts:610-628`,
      `src/lib/mediaSession.ts:76-80` — HIGH
- [ ] **1.4** Native: `refreshQueue` divergence fallback must notify JS (`ended` or `error`) instead
      of silently `stopPlayback()`-ing with stale JS indexes. `AudioEngine.swift:360-368` — MED
- [ ] **1.5** Native: reload reconciliation — `_initNative` should call `getState()` and resync
      `currentTrack`/`playbackState`/`activeIndex` when the engine is still playing after a
      webview reload (and warn + stop if the playing trackId is no longer in the library).
      `src/lib/nativePlugin.ts:107-134`, `src/lib/playbackManager.ts:137-181` — MED
- [ ] **1.6** Native: empty/url-less snapshot deadlock — when `_buildSnapshot` yields `url:''`
      (no Navidrome config), fail fast with an error event instead of "playing" with zero tracks.
      `src/lib/playbackManager.ts:305-325`, `AudioEngine.swift:96-117,346-355` — MED
- [ ] **1.7** Native: preserve seek position across the "Track not ready" retry — retry the same
      position instead of a full `setQueue`+`playTrackAt` restart.
      `AudioEngine.swift:451-461,718-721`, `src/lib/playbackManager.ts:448-471` — MED
- [ ] **1.8** Native: `pause()` mid-crossfade must tear down ramp + crossfade flags (or the minutes
      sleep timer can leave wrong-volume/state corruption on resume).
      `AudioEngine.swift:437-445` — MED
- [ ] **1.9** Web: `_handleExitBackground` is the only track-end path missing the loop-one branch.
      `src/lib/playbackManager.ts:709-742` — LOW
- [ ] **1.10** Web: crossfade hygiene — catch `standbyEl.play()` rejection; teardown the crossfade
      monitor on end-of-queue stop; refresh `_currentTrackGainDb/_currentAlbumGainDb` after a
      crossfade switch. `src/lib/audioManager.ts:534-552,758-776,807-809` — LOW
- [ ] **1.11** Media session: clamp lock-screen seeks to metadata duration + clear `pendingStop`.
      `src/lib/mediaSession.ts:124-129` — LOW
- [ ] **1.12** Web: `play()` in bg mode resumes the silent foreground element — route through
      `playbackElement` like `pause()` does. `src/lib/playbackManager.ts:880-905` — LOW
- [ ] **1.13** Verify/fix `playbackState:'buffering'` stall recovery (timeout → pause/stop).
      `src/lib/playbackManager.ts:273-275` — LOW

## Phase 2 — Queue model refactor (the "clean refactor" centerpiece)

Goal: **one owner for all queue math.** Today mutation logic is split across `appState.ts`
(store + `playNext`/`removeFromUserQueue`/`removeFromAutoQueue`/`clearQueue`/`pushHistory`),
`queueManager.ts` (advance/replenish/rotate), and `QueueView.svelte` (inline duplicates of
`playNext` and reorder math). Consolidate:

- [x] **2.1** One owner for all queue math — closed 2026-08-11, but by a different design than
      proposed: concrete methods (`addToUserQueue`/`playNext`/`promoteToUser`/`promoteToUserNext`/
      `moveToNext`/`moveToEnd`/`removeFromAutoQueue`/`promoteActiveTrack`/`clearQueue`/`reorderAll`)
      over a private `_mutateQueue` choke point (`QueueMutation` sections + `null` no-op + id
      re-anchor), not the named-DSL API (`insertNext`/`insertAt`/`removeAt`/`moveTo`/`setActive`).
      The builder bodies live in the pure, store-free `src/lib/queueMutation.ts`
      (`applyQueueMutation` owns the re-anchor + DEV invariant assert; `_mutateQueue` is a thin
      shell) — fuzz-verified duplicate-free (manufacture-free rule: an id may enter a section only
      when the section is empty of it) with a scratch script (deleted after passing).
      `setActiveQueueIndex` remains in appState by design (explicit index setter, not a
      length-changing mutation); `removeFromUserQueue` stays the documented position-semantics
      exception. See AGENTS.md 2026-08-11 entry. — MED
- [x] **2.2** `playNext` off-by-one family — closed 2026-08-11 by the `_mutateQueue` id-based
      re-anchor (capture `activeId` pre-mutation → `indexOf` on the rebuilt combined queue; no
      active id → −1): the `adjustedIndex` dead ternary removed, in-auto inserts clamp to the user
      tail, and every length-changing edit (incl. removing a preceding auto row while the active
      sits at `auto[j>0]`, reorders, clears) keeps `activeIndex` on the playing trackId. — MED
- [x] **2.3** `historyQueue`: removed and replaced by the `recentTrackIds` LRU window (2026-08-10) —
      persisted in the playQueue row (`RECENT_LIMIT=100`), single writer `queueManager.markRecent`/
      `advanceTo`, dedupe+move-to-end inscription, cap drops the OLDEST. Clear-Queue case proved the
      played inscriptions are load-bearing (anti-repeat after trims), so the audit's "session-scoped
      ~5 ids" + "subsumed by promotion" framing was wrong. `replenishAutoQueue`/`rebuildAutoQueue`
      exclude the window via `_buildPool` tiers: fresh -> cooling top-up -> full rotation (never the
      active track, filters always gate). Scrubbed with `node` type-stripping scratch assertions
      (deleted) + `npm run check`. See AGENTS.md 2026-08-10 entry.
- [ ] **2.4** **[DECISION]** `removeFromUserQueue` when removing the *active* track — pick a
      semantic: (a) stop playback, (b) marker stays on the sliding next track (highlight matches
      what plays next), or (c) current behavior (decrement; correct continuation, wrong highlight).
      Implement + document. Behavior unchanged by 2.3 (still (c)); removed id now cools down.
      `queueManager.ts:111-124`
- [ ] **2.5** **[DECISION]** `userQueue` growth policy — promotion is append-only, so long sessions
      drain the eligible pool. The functional freeze is MITIGATED (not solved) by 2.3's rotation
      tier (`_buildPool`), which recycles heard tracks instead of letting the queue die; the
      remaining concern is memory/unbounded growth of the persisted row + native snapshot size.
      Options: trim promoted (non-user-pinned) entries behind the active track, or cap with
      oldest-drop. Must not drop user pins silently. Note (2026-08-11): a tier-3-admitted copy of
      a user-queued track now collapses out of the tail when it plays (dedupe-append promote), so
      duplicates no longer cycle in the tail. `queueManager.ts:29-46`
- [x] **2.6** `queueWrapNotice` lifecycle — cleared on every `replenishAutoQueue` early-return
      (`needed === 0` and unchanged-pool paths, 2026-08-10); `_rotateAfterAnchor` set/clear
      contract unchanged; rebuild path re-derives it per fill. `queueManager.ts:143-157`

## Phase 3 — Sync / metadata pipeline hardening

- [ ] **3.1** Push re-pend race — re-check the live `metadataCache` row AFTER the write completes
      (not before) and never flatten a stale snapshot over a concurrent re-bind.
      `src/lib/syncEngine.ts:342-364` — MED
- [ ] **3.2** Navidrome-mode stale seeds — `seedNavidromeFeedback` on a *cached* connect re-applies
      cached `starred`/`userRating`; either drop rating/loved from the song cache or mark cached
      rows so a refresh is requested. `src/lib/navidromeApi.ts:342-374`, `appState.ts:372-418` — MED
- [ ] **3.3** Pagination guard — cap `loadNavidromeSongs`'s `while(true)` loop (max pages / dedupe /
      progress stall) for servers that ignore `songOffset`. `src/lib/navidromeApi.ts:353-367` — MED
- [ ] **3.4** Stale cached config — clear `_cachedConfig`/`coverConfig` when credentials are removed
      (add the `setCachedConfig(null)` call site on settings change). `navidromeApi.ts:330-340` — MED
- [ ] **3.5** Normalize `webdavBase` keys — derive from the same normalized URL used for requests
      so a trailing slash doesn't flag the whole library as "Server URL updated".
      `metadataScanner.ts:62-64`, `syncEngine.ts:265`, `webdavUtils.ts:106-108` — MED
- [ ] **3.6** Index/probe hygiene — do not persist the full tagged index to Dexie on every probe;
      re-check `ignored` in the manual-bind fetch path; guard `processItem` against mid-scan
      library replacement (count, don't stall); make PROPFIND href decoding fault-tolerant.
      `metadataScanner.ts:98-110,481,530-537`, `metadataReader.ts:22-32` — LOW
- [ ] **3.7** Preserve cached `comments` when a scanned file has none; normalize mtime comparison
      (RFC1123 vs ISO) to avoid full-library re-read bursts.
      `metadataScanner.ts:655`, `metadataReader.ts:166-223` — LOW
- [ ] **3.8** WebDAV write hardening — orphan `.mmdrome-tmp` cleanup on startup; surface "no ETag"
      (blind overwrite) in the push confirmation; exclude `ignored` rows from the dialog count.
      `syncEngine.ts:57-111`, `SettingsView.svelte:296-310` — LOW

## Phase 4 — UI & state layer

- [ ] **4.1** Settings credential fields — per-field debounce timers (one shared timer drops earlier
      fields' pending writes, and the mirror `$effect` reverts the typed text).
      `src/views/SettingsView.svelte:163-177,74-91` — MED
- [ ] **4.2** Verify SettingsView mount-time scroll restore — the save `$effect` may clobber the
      session-restored scrollTop (writes 0) before `onMount` applies it. If confirmed, guard the
      first save. `SettingsView.svelte:54-63` — MED (verification first)
- [ ] **4.3** Dead code removal — `readFileMetadataWithIndex`, `clearCoverCache`, `formatEqText`,
      `getAllPresets`, `createSingleCurveEqAudioBuffer`, `LazyThumb` `size` prop, `updateNowPlaying`
      (TS+Swift), `destroy()` (half-implemented, no callers) — remove or finish. — LOW
- [ ] **4.4** Native lock-screen artwork race — guard the fetch completion against the current
      trackId before re-applying art. `NowPlayingController.swift:91-106` — LOW
- [ ] **4.5** Native resource polish — stable cache filenames (FNV/sanitized id instead of
      `hashValue`, which re-downloads everything per launch), skip `state()` file opens for
      zero-duration tracks while stopped, retain/remove `SessionController` observer tokens,
      handle `CapacitorHttp` `status:-1` as a distinct network error. — LOW

## Phase 5 — Documentation & knowledge base

- [ ] **5.1** AGENTS.md corrections — `_bgTrackEndHandled` does not exist (§3); `effectiveDuration`
      is still exported; the CJK fix was applied only to `metadataReader.normalizeForMatch`, not
      the scanner's `normalizeForHint`; "prompt arrays kept only for capped rows" is false;
      "`deriveFileType` in `navidrome.ts`" → `navidromeApi.ts`; the "native setSpeed doesn't echo
      to the store" note is stale (`engineFacade.ts:46-56` writes stores since 2026-08-05).
- [ ] **5.2** Document the open invariants (once decided): sleep-timer lifetime vs queue resets,
      webview-reload behavior, `refreshQueue` divergence policy, `ended`-only wrapper design,
      `idle`-never-re-entered scan states, `playNext`/`removeFromUserQueue` semantics (2.3-2.5).
- [ ] **5.3** Add a "Verification" note to AGENTS.md pointing at `npm run check` + the `ios.yml`
      workflow as the only native compile gate, and reference this TODO file.

---

## Verification gates

- After each phase: `npm run check` (svelte-check + tsc) — the only test gate in the repo.
- Swift changes (Phase 0-1, 4.4-4.5): push to `main` → `ios.yml` CI build, or `workflow_dispatch`.
- Manual PWA checks for bg-mode items (1.2, 1.3, 1.9-1.12): lock the screen mid-track,
  verify advancement, sleep timer, crossfade.

# mmdrome — Technical Debt & Refactor Plan

**Status: Phases 0–5 are CLOSED** (2026-08-10 → 2026-08-19: foundations/test harness,
PlaybackCore + native transports, queue model, sync/metadata hardening, UI/state,
docs — see git history and `docs/DEVLOG.md` for the record). This plan supersedes
the old content: it is the **WebDAV tag-first matching overhaul** designed
2026-08-20 (post-mortem of "fresh scan said 11 failed, File Matching shows 111
file not found + 5 multiple matches, correct file suggested everywhere" — full
analysis and decisions in the DEVLOG entry of that date).

Design principles (unchanged):
1. **Clean models for the intended behavior** — a correct abstraction beats the
   straightforward patch.
2. **Logic lives in pure, injectable modules** — every new decision (scoring,
   evidence, fingerprints, reverse-matching, sweep planning) is a pure
   function/module over plain data with injected boundaries; thin adapters bind
   it to DOM/Dexie. Enforced per item.

Legend: `[ ]` open · `[x]` done · HIGH/MED/LOW impact · anchors are file +
symbol (grep the symbol). **[DECISION]** needs a product call before
implementation. **Verification per item = `npm run check` AND `npm test`**
(`npm run build` before CI pushes); suites go in `tests/` (zero-dep, per F3).

---

## Phase 6 — WebDAV tag-first matching overhaul

**The shape**: make the tag probe the primary *evidence and binding* engine
(tags are the strongest identity signal; filename is the fallback), run it
*inside* the scan so the first scan binds with tag identity, let it *auto-bind*
confident reverse-matches outside scans, adapt its sweep breadth to "the server
is the library", and make the scan result line + File Matching view honest
consumers of probe state.

### 6.0 Decisions (SETTLED 2026-08-20 — record, not open questions)

- **6.0a — contradiction-blocks-filename: YES.** Navidrome-side edits are out of
      scope (confirmed: "don't worry about navidrome changes to filename or
      others"). Probed tags that disagree with the track block filename binds
      too, not just the size fallback (extends `tagsContradictSize`). Unblocks
      6.5(b).
- **6.0b — the probe's fetch is THE read (one pass).** The probe cache carries
      the FULL `FileMetadata` (identity + rating/loved/comments); probe-time
      binds stamp from it, and the scan's drain consumes a fresh cache entry
      instead of re-reading — no redundant probe/bind reads. Unblocks 6.11 and
      refines 6.7.
- **6.0c — tag-aware re-queue: KEEP** (belt-and-braces for rows the probe can't
      reach on orphan-heavy servers). Unblocks 6.8.
- **6.0d — values: duration tolerance ±2 s** (absent/null → no penalty, never a
      hard block); **sweep threshold confined — sweep-all iff
      `unclaimedFiles <= max(unclaimedTracks, 50)`, automatic** (no setting).
      Rationale: bound files LEAVE the probe pool (claimedPaths filter), so a
      healthy library's unclaimed ratio is naturally ~1:1 — the 2–3× slack was
      wrong. Documented tradeoff: a library with legitimately >1 file per track
      (FLAC+MP3 duplicates) may hint-gate; raise the constant only if measured
      (named, tested constant). Unblocks 6.4/6.12.
- **6.0f — boot/restore probe: online-gated (mandatory, not a choice).** An
      offline boot probe would cache every failed read as `'unreadable'` and
      permanently blind the library. Confirmed.
- **6.0e — DROPPED (moot):** probe-time auto-binding was approved, so the
      "Bind all confident suggestions" button fallback is not needed.

### 6.1 Pure-core groundwork (test-first, all in `src/lib/metadataCore.ts` unless noted)

- [x] **6.1** `computeTagCacheFingerprint(entries: FileTagCacheEntry[]): string` —
      FNV-1a over sorted `path\0size\0mtime\0status\0probedAt` (same hashing
      as `computeIndexFingerprint`; mtime catches same-size edits and
      `probedAt` is the new-evidence signal). **Test**:
      `tests/metadataCore.test.ts` — order-stability, path/size/mtime/status/
      probedAt sensitivity (each field flip changes the hash; probedAt-only
      flip changes it), deterministic. — MED — **closed 2026-08-20** (`metadataCore.ts`
      `computeTagCacheFingerprint`; 1 test).
- [x] **6.2** Reverse-match core: `buildTrackTitleIndex(tracks)` +
      `matchFileToTracks(entry, index, excludeTrackIds?)` — a
      `normalizedTitle → Track[]` index (empty + "Unknown Title" titles
      excluded) + an exact-title lookup, fileType-filtered, scored via the
      existing `scoreAgainstTags` `certain` flag. Verdicts: `'certain'` (exact
      title+artist, one track), `'unique-title'` (exact title, one candidate —
      the 6.5a relaxation), `'ambiguous'` (shared title), `'none'`.
      `excludeTrackIds` drops tracks bound elsewhere (the bindable-filter
      applied by the caller; row-level eligibility is 6.3's `canAutoBind`).
      **Test**: exact, unique-title, same-title-different-artist (ambiguous),
      duplicate-tracks-with-one-bound (binds the unbound), two-identical
      (ambiguous), fileType mismatch (none), CJK, missing/empty tags (none),
      empty/Unknown Title excluded. — HIGH — **closed 2026-08-20**
      (`metadataCore.ts` `buildTrackTitleIndex`/`matchFileToTracks`; 9 tests).
- [x] **6.3** Bind-eligibility DECISION as a pure helper — `canAutoBind(track,
      existing)` (exported as `AutoBindDecision`): eligible iff unbound AND not
      `pending_sync`/`ignored`/manual AND the track still exists (a Navidrome
      re-connect mid-probe can replace the library — 'track-missing' refuses the
      write). Stale-base rows are folded into 'already-bound' (they carry a
      `webdavPath`); a vanished binding (no path) IS bindable to a new file.
      The WRITE (the shared `maybeAutoBind` glue: mid-flight re-check, claim,
      navidrome-mode preserve, updateMetadata) lands with 6.11. **Test**:
      eligibility matrix — track-missing/already-bound/manual/pending-sync/
      ignored, bindable. — HIGH — **closed 2026-08-20** (`metadataCore.ts`
      `canAutoBind`; 1 test).
- [x] **6.4** Year + duration corroboration in `scoreAgainstTags` (and the
      `FileTags`/cache fields): year +5 exact (±1 tolerance — reissues); duration
      +10 exact within **±2 s** (settled 6.0d); a duration difference beyond ±2 s
      DEMOTES certainty (a `certain` verdict becomes `tagLedUncertain` →
      ambiguous — never a hard block). Absent/null duration on either side (0,
      `getAudioProperties()` null — some formats/short buffers) is treated as
      NO SIGNAL: no bonus, no demotion, no contradiction. **Test**: matrix —
      VBR tolerance, ±2 s boundary (2 s still corroborates, 2.1 s demotes),
      reissue-year, missing-on-one-side, null-audioProperties no-penalty,
      exact-pin, contradiction-demotion. — MED — **closed 2026-08-20**
      (`metadataCore.ts` `scoreAgainstTags` `durationConflict`/year bonus;
      `db.ts` `FileTags.year`/`duration`; 6 tests).
- [x] **6.5** Evidence-gate evolution: (a) unique exact-title tag match
      auto-binds WITHOUT artist certainty (artist becomes a tiebreaker — the
      refined rule is both more permissive for title-only-tagged files and
      SAFER than today for same-title-with-competition: File1 "Song" [no
      artist] vs File2 "Song" [artist B] currently binds File2 to track-artist A
      with no certainty; the new rule makes that ambiguous); (b)
      contradiction-blocks-filename — APPROVED (6.0a): probed identity tags that
      disagree with the track suppress filename evidence too (the
      `tagsContradictSize` check — renamed `tagsContradictTrack` — extends from
      the size fallback to all evidence; a file with NO identity tags is not a
      contradiction and still binds on filename). **Updates the pinned behavior
      in `tests/metadataCore.test.ts`** (tag-led-uncertain cases) — the old
      `certain`-only rule was pinned by the 3.6t suite; re-pin deliberately.
      `matchFileToTracks`' unique-title verdict is also gated on duration
      agreement (6.4). — HIGH — **closed 2026-08-20** (`metadataCore.ts`
      `classifyScoredTrackMatch` + `tagsContradictTrack`; 5 gate tests + 2
      `matchFileToTracks` duration-gate tests).
- [x] **6.6** Cache pipeline — **NO probeVersion** (settled: local data is
      disposable — a cache-shape change is handled by a ONE-TIME brute-force
      `clear()` of `webdavFileTags` at the migration point; no version field,
      no per-entry bookkeeping); `'unreadable'` TTL re-probe (hours) so a
      transient failure doesn't poison forever — and network-class failures
      (fetch throw) are classified separately from parse failures (short
      TTL vs longer) — the TTL is LOAD-BEARING for the online-gated boot probe
      (6.0f): a boundary online/offline flip must not blind files for the
      session; per-baseKey `webdavFileTags` cleanup on credential swap. The
      probe cache now also carries rating/loved/comments (6.0b — the "1 pass"
      payload; `FileTagCacheEntry` grows the full `FileMetadata`). Freshness is
      invalidated by either size or WebDAV mtime, so same-size tag edits are
      re-probed; missing mtimes retain the safe size-only behavior. **Test**:
      `metadataCore.test.ts` pins size/mtime invalidation, success/empty
      freshness, and the separate network/parse TTL boundaries. **Closed
      2026-08-20**: `db.ts` v5 clears the old identity-only payload once;
      `metadataReader.ts` classifies transport vs parse errors and extracts
      year/duration; the scanner serializes cache writes, prunes vanished paths
      only after complete indexes, and removes old-base rows across rapid
      credential swaps. — MED

### 6.2 Scanner pipeline (`src/lib/metadataScanner.ts`)

- [x] **6.7** Inline probe as a scan phase: in `scanAllInternal`, after
      `refreshIndex`/`rebuildIndex` and before queueing the drain, `await ensureTagProbe().catch(() => {})`
      BEFORE the existing `if (scanGen !== myGen) return false` guard (a
      mid-probe credential swap must not let the drain run with foreign tags —
      the guard catches it; the `.catch` means a probe failure degrades to
      filename matching, never aborts the scan). Also track the previous tail
      probe's promise and await it next to `previousDrain` (belt-and-braces vs
      `tagProbeActive`). **The drain consumes the fresh probe cache (6.0b)**: the
      auto-match bind path reads rating/loved/comments from the size/mtime-fresh
      cache entry instead of a second GET; only filename-matched rows without a
      fresh cache entry read the file. Fresh cache entries are invalidated by size or
      WebDAV mtime. Set the scan annotation to "Reading file tags…" during the
      probe phase (progress line honesty). **Test**: pure cache reuse/freshness is covered; the scanner
      glue is `[not test-pinned]` because its WebDAV/Dexie boundary has no
      injectable harness yet.      **Closed 2026-08-20**: the prior tail probe is
      awaited, the inline phase runs before queue/drain,      fresh cached entries are revisited, cached full metadata (including
      fresh failure entries for filename matches) is consumed by auto-binds
      without an immediate duplicate GET, and the post-probe fingerprint is
      persisted after the cache writes settle. Partial recursive indexes allow
      probe-driven auto-binds but block vanished-path clearing (a bound path
      in an unreadable directory must not be deleted).
      — HIGH
- [x] **6.8** Tag-aware unmatched re-queue **[gated on 6.0c]**: persist
      `tagFingerprint` on the snapshot (`queueIndexWrite` gains it; computed in
      `refreshIndex`/`rebuildIndex` from the cache they already load); read the
      prior tag fp with the prior file fp BEFORE the probe; re-queue unmatched
      rows when EITHER changed (`setUnchanged = fileFpMatch && !tagFpChanged`).
      **Test**: tag-fp delta → re-queue; stable → skip; convergence over two
      scans; the `listUnresolvedMatches`-triggered `refreshIndex` overwrite edge
      documented (acceptable — File Matching surfaces those rows itself).
      **Closed 2026-08-20**: `WebdavFileIndex.tagFingerprint` is persisted and
      refreshed again after the probe writes new cache evidence, so convergence
      does not depend on an avoidable extra scan. — MED

- [x] **6.9** No-match counter: add `notFound` to `MetadataScanProgress` +
      `processItem`'s no-entry/no-ambiguous/no-vanished branch; result line
      "N scanned, M not found, F failed, A ambiguous" (SettingsView both spots).
      Wording matches the File Matching badge ("file not found") so the numbers
      read consistently — but document that the two counts are different
      populations (File Matching also includes failed + skipped rows).
      **Closed 2026-08-20**: progress and both Settings result lines now expose
      the separate `notFound` count; the UI labels it "no safe match" because
      the file may exist as a suggestion. — LOW

### 6.3 Probe lifecycle & auto-binding

- [x] **6.10** Unified probe triggers: drop the fire-and-forget
      `ensureTagProbe()` in `refreshUnresolved`; run the probe at (a) library
      restore/boot **[online-gated — 6.0f]**, (b) post-scan (existing tail), (c)
      post-connect, (d) the explicit File Matching Refresh button. Add a
      revision; defer one refresh while scanning, loading, or an open picker,
      then consume it when the blocker clears. **Test**: the view glue is
      `[not test-pinned]`; lifecycle behavior is guarded by the single shared
      probe promise/generation. **Closed 2026-08-20**: automatic list refresh no
      longer starts a fire-and-forget probe; explicit Refresh awaits it, the App
      boot trigger waits behind any scheduled scan/tail, all boot/scan probing
      is online-gated, and completion uses a monotonic revision so a completion
      cannot be lost while the first list is loading. — MED
- [x] **6.11** Probe-time auto-binding (APPROVED, 6.0b): after the probe reads a
      file with identity, `matchFileToTracks` (6.2) → on a certain/unique-title
      verdict bind via the shared `maybeAutoBind` (6.3) — either during the
      pre-drain probe phase or when no scan is in flight; stamp path/base AND
      rating/loved/comments from the SAME fetch (the "1 pass" — no second
      read), with the processItem guards incl. the navidrome-mode preserve
      (6.3). **Eligible-filter-before-verdict (wiring requirement, review
      2026-08-20)**: build the FULL non-bindable trackId set ONCE per probe run
      (bound-elsewhere + pending + ignored + manual, via `canAutoBind` over the
      metadata cache) and pass it as `excludeTrackIds` — otherwise a same-title
      pending/ignored/manual sibling forces a false 'ambiguous' (safe, but
      misses the bind). The file's claim lives in metadataCache
      (`excludePaths`/`allBoundPaths` read it fresh, so later scans and
      candidate lists exclude it automatically). **Test**: reverse-bind happy
      path (identity + rating/loved stamped from one read), ambiguous no-bind,
      pending/ignored/manual skip, duplicate-tracks-with-one-bound (binds the
      unbound), a same-title ignored sibling does NOT force ambiguity, bind
      visible to the next scan's excludePaths, navidrome-mode preserve,
      track-gone skip.      **Closed 2026-08-20**: `maybeAutoBindFromProbe` performs
      the live eligibility/track/session re-check, eligible-filter-before-
      verdict, claim, and one-pass metadata stamp. The pre-drain scan probe
      also applies the binder and returns claimed ids so the drain skips those
      rows; fresh cached entries are revisited without another GET. Glue is
      `[not test-pinned]`. — HIGH
- [x] **6.12** Adaptive sweep (AUTOMATIC — settled 6.0d): sweep-all iff
      `unclaimedFiles <= max(unclaimedTracks, 50)` — the confined 1:1 threshold
      (the floor covers tiny libraries for free). Rationale: bound files LEAVE
      the probe pool, so a healthy library's unclaimed ratio is naturally ~1:1;
      orphan forests (files ≫ tracks) stay hint-gated. Pure planner
      (`planProbeSweep` — pool + counts → 'sweep-all' | 'hint-gated', with the
      size-hint/filename-hint ordering preserved inside sweep-all) so the
      threshold is a named, tested constant (the only knob; raise it only for
      libraries with >1 file per track). **Test**: `metadataCore.test.ts`
      pins the ratio boundary, 1:1 behavior, and floor; scanner ordering and
      convergence are `[not test-pinned]`. **Closed 2026-08-20**: the planner
      is the only sweep decision and the scanner preserves size/filename rank
      within a sweep. — MED

### 6.4 Rollout, verification & docs

- [ ] **6.13** Rollout checks: manual PWA pass on a real WebDAV library —
      measure first-scan latency with the inline probe (expect one-time per-file
      cost; validate the sweep ratio 6.0d against real file/track counts); the
      "11 failed vs 111 not found" scenario should now report honestly and
      resolve most rows on the first scan; File Matching should clear rows in
      the background as the probe resolves them. Side-effect expectation: the
      `failed` class shrinks (the bind read mostly disappears — the probe's read
      is the read — so fewer read-failure points).
- [x] **6.14** AGENTS.md §4 updates: D8 now records the unique-exact-title
      rule and contradiction-blocks-filename; D9 records both fingerprints,
      inline full-metadata consumption, TTLs, and base-key cleanup; D10 records
      the full probe payload boundary. §2.4 names the Phase-6 pure core. The
      remaining WebDAV/DOM glue is explicitly `[not test-pinned]` in TODO and
      the DEVLOG. **Closed 2026-08-20**. DEVLOG 2026-08-20 entries are the
      historical record.
      record.

---

## Closed phases 0–5 (navigation summary)

- **Phase 0 — Foundations & test foundation** (closed 2026-08-12): sleep-timer
  lifetime (0.2), CJK-safe normalization (0.3), credential-swap invariant (0.4),
  the node `--test` harness + seed suites + tsconfig.test.json + test.yml (0.5).
- **Phase 1 — PlaybackCore** (closed 2026-08-13/14): one orchestration, three
  transports (policy modules, WebTransport, WebBgTransport, NativeTransport +
  reload reconcile); native crossfade/scheduler Swift package (1.1/1.8),
  JS↔engine contract (1.4–1.7), media session (1.11).
- **Phase 2 — Queue model** (closed 2026-08-10/14): `_mutateQueue` id re-anchor,
  recency window, active-row removal semantics + advance corollary, unbounded
  user queue, native divergence skip.
- **Phase 3 — Sync/metadata hardening** (closed 2026-08-14/15): push
  re-validation (3.1/3.9), seed gating (3.2), pagination (3.3), config cache
  (3.4), baseKey (3.5), index/probe hygiene (3.6), pure matching core (3.6t),
  comments/mtime (3.7), write hardening (3.8), scrobble policy (3.10), cache
  policy (3.11), sleep timer web (3.12), load planner (3.13).
- **Phase 4 — UI & state** (closed 2026-08-11/15): credential write-through,
  scroll restore, dead-code sweep, native artwork race + resource polish, EQ
  store suite, e2e depth.
- **Phase 5 — Docs** (closed 2026-08-15): AGENTS.md corrections/decisions
  documented.

---

## Verification gates

- Every item: `npm run check` **and** `npm test`; `npm run build` before CI pushes.
- JS CI: `.github/workflows/test.yml` (node 24, push + PR).
- Swift: push to `main` → `ios.yml` (`xcodebuild` + `swift test` for the XCTest
  target) — Phase 6 is JS-only, no Swift round-trip expected.
- Deliberately NOT unit-tested (documented scope): Svelte component/DOM behavior
  (would need vitest+jsdom; contradicts the zero-dep ethos) — the decision logic
  behind it IS tested; components stay thin.

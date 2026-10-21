# Queue & Playback Invariant Matrix

Date: 2026-10-21
Phase: 2A of [2026-10-18-holistic-polish-and-roadmap.md](plans/2026-10-18-holistic-polish-and-roadmap.md) — "Queue Pool Hardening & View-Layer Deduplication".
Status: **partly implemented**. §2 (A1–A9), §3 B2/B10 and §10 N1 now describe the OCCURRENCE model that
step 1 of [QUEUE-DESIGN.md](QUEUE-DESIGN.md) §6 shipped (2026-10-21c): a row is `(section, id, ordinal)`,
duplicates are legal in both sections, every mutation path moves/removes/drags an occurrence, restore is a
raw pass-through, and the native snapshot carries per-occurrence entry ids. Everything else still describes
the code as it was, and every remaining known gap is real.

> **Still not implemented (steps 2–4):** pressing a song still jumps to an old copy (D1), a filter/sort edit
> still rewrites the fill in place without promoting the audible row or resetting `recentTrackIds` (D7),
> manual Next at the tail is still a no-op under loop-all (D8), the auto queue cannot be switched off (D9),
> and a same-tick Next/Previous still loses a press (D12). Those rows say so; do not pre-fix them.

## 0. What this file is

The intended behavior of the queue/playback system, one row per invariant, each row naming the test that
actually pins it. It exists because the playlist work in Phase 3 is gated on knowing which behaviors are
load-bearing, which are deliberate tradeoffs, and which are accidental.

**Maintenance rule (anti-rot, mirrors `AGENTS.md`):**

1. Every row points at a real, passing test. A row with no test is either a **known gap** (§13), an
   **open product question** (§17), or a **scope note** (§16) — never a silent assertion.
2. If you change behavior, change the test AND the row in the same commit. A row whose test no longer exists
   is worse than no row.
3. A `known gap G#` row's test pins the CURRENT behavior on purpose. Fixing the gap means rewriting that
   test with a name that states the new rule — never deleting the row. A `current behavior (open question
   Q#)` row is the same discipline for an UNDECIDED behavior: the test pins what the code does, and the
   question (not an intent) is written down in §17.
4. `pinned (JS half)` / `pinned (JS half — device-unverified)` mean the JS/pure half is pinned here and the
   native/on-device half is not; see E5 in `AGENTS.md` (no local Swift toolchain) and the physical-iOS
   ledger item in the 2026-10-17 streaming plan.

Verification for this document (2026-10-21c, step 1 landed): `npm test` (1406 passing), `npm run check`
(0 errors / 0 warnings), the full e2e suite (64 passing) and the ui-review suite (8 passing), including the
rows' browser specs — `queueRows` (9), `queuedragdup` (1), `queueContinuation` (1), `queueflood` (2),
`persistence` (3).

**Status vocabulary (closed set — every row carries exactly one of these):**

| Status | Means |
| --- | --- |
| `pinned` | Every cited test exists and passes, and the row states exactly what they assert. |
| `pinned †` | As `pinned`, and the 2026-10-21 pass ADDED a pin for a limb that was previously asserted without a test (the added pins are itemized in §14). |
| `new` | Every pin is from the 2026-10-21 pass; the behavior had no durable test before it. |
| `pinned (browser)` | Pinned by a real-bundle Playwright spec (production build), not a Node suite. |
| `pinned (browser — native mocked)` | A real-bundle browser spec with the native plugin mocked; the wiring is proven, the Swift engine is not. |
| `pinned (JS half)` | The native bridge's JS side is pinned; the Swift engine / on-device half is not (E5, §16). |
| `pinned (JS half — device-unverified)` | As above, and the behavior also depends on engine timing only a device run can confirm. |
| `pinned — G1/G2 exception` | The row holds for the cited cases; §13's G1/G2 fill-rewrite gap is a known exception, stated inline in the row. |
| `pinned — G1/G2 mechanism` | The row is true, and it is the mechanism by which §13's G1/G2 gap happens. |
| `known gap G#` | The cited test pins CURRENT behavior that §13 records as wrong (fix = rewrite the test with the new rule). |
| `known limitation G#` | As above, where the gap is a constraint of the current design rather than a defect. |
| `current behavior (open question Q#)` | The test pins what the code does; no product decision is recorded. The question is open in §17. |

## 1. Vocabulary

| Term | Meaning |
| --- | --- |
| user section | `queue.userQueue` — the explicit listening list; rendered above auto; rows survive across advances. |
| auto section | `queue.autoQueue` — the replenished suggestion tail (max 50). |
| combined | `[...userQueue, ...autoQueue]` — the only order playback walks. |
| anchor | `queue.activeIndex`, an index into **combined**. |
| audible row | the track `currentTrack` names — normally `combined[activeIndex]`. |
| occurrence | one queue ROW: `(section, id, ordinal)`; the same id may appear any number of times in either section and each copy is its own row. |
| tier 3 | the rotation stage of the fill that re-admits user-queued / cooled rows (B4 tradeoff). |

## 2. Sections & duplicates (occurrence identity)

| # | Invariant | Pinned by | Status |
| --- | --- | --- | --- |
| A1 | The user section may hold the same id any number of times; `addToUserQueue` ALWAYS appends a new occurrence (D2/D3). | `tests/queueMutation.test.ts` — "addToUserQueue appends a NEW occurrence even when the id is already queued (D2)"; `tests/queueBulkImport.test.ts` — "playAll preserves duplicate ids verbatim…" (+ appends a third copy); `tests/e2e/queueRows.spec.ts` — "duplicate songs render as independent occurrence rows" | pinned |
| A2 | No mutation builder dedupes either section. Auto duplicates can arise from a drag/convert, a restore or a bulk import; the fill's unique-first selection is a planner rule (D6, repeat pass not implemented yet), never an identity constraint. | `tests/queueMutation.test.ts` — duplicates exercised by the planner/removal tests; `tests/queueRestore.test.ts` — restored auto duplicates survive | pinned |
| A3 | The same id in both sections is TWO independent rows. Promoting the auto occurrence appends a new user occurrence and drops that auto row; an older user copy stays where it is as history. | `tests/queueBulkImport.test.ts` — "a cross-section duplicate is two rows; promoting the auto occurrence appends a user occurrence"; `tests/queueMutation.test.ts` — "promoteToUser appends a new user occurrence…", "promoteToUserNext appends…" | pinned |
| A4 | Row identity is the OCCURRENCE. QueueView keys rows `u-<id>#<n>` / `a-<id>#<n>` (position-free): a duplicate is legal and addressable, and a row's key changes only when a same-id copy above it is added/removed — never on an advance. | `tests/queueOccurrence.test.ts` — "row keys are occurrence-scoped and never contain the row position"; `tests/e2e/queuedragdup.spec.ts` — "three copies of one song are independent rows"; `tests/e2e/queueRows.spec.ts` — duplicate-rows spec | pinned (browser for the key/render half) |
| A5 | Restore is a RAW PASS-THROUGH: persisted rows are kept verbatim (duplicates included) and the stored anchor is kept, bounds-checked, because nothing shifted. | `tests/queueRestore.test.ts` — "restore keeps persisted rows VERBATIM (duplicates included), the exact stored anchor…" | pinned |
| A6 | A drag moves the OCCURRENCE the user grabbed (entry id), never a same-id neighbour. No drag path dedupes or normalizes a section; a same-id auto row converted into user is its own row. | `tests/queueMutation.test.ts` — "an auto copy of an id already in user is a SEPARATE row (no dedupe)", "…conversion keeps a duplicated auto row in the converted prefix", "applyDragDrop: a cross-section duplicate resolves to the dragged AUTO occurrence (G5 closed)", "…with two user copies the dragged one moves and the other stays" | pinned |
| A7 | Drop reconciliation budgets by PER-ID OCCURRENCE COUNTS against the live queue: a planned row is kept while a live occurrence of its origin id remains; live rows the plan never consumed (joined mid-drag) are appended in live order to their own section; a removed dragged occurrence voids the drop. | `tests/queueMutation.test.ts` — "reconciliation budgets by per-id COUNT…", "…reorder still lands when rows joined mid-drag", "…a row that joined the USER section mid-drag stays…", "…a mid-drag removal of the SAME id above voids the drop" | pinned |
| A8 | Removal is occurrence-scoped AND section-scoped: a row ⨯ removes exactly the indexed copy (one occurrence), never `indexOf(id)`, and never purges the other section's copy. | `tests/queueMutation.test.ts` — "removeFromAutoQueue removes exactly the indexed occurrence…", "one duplicate can be removed without touching the other", "removing the PLAYING user row leaves its auto occurrence queued"; `tests/e2e/queueRows.spec.ts` — duplicate-rows spec (removes the second copy) | pinned |
| A9 | A bulk import (`playAll`) preserves the source order and duplicates verbatim. The remaining bulk gap is LIBRARY VALIDATION (unknown ids can stall playback), not dedupe. | `tests/queueBulkImport.test.ts` — "playAll preserves duplicate ids verbatim…", "playAll keeps ids missing from the library queued…" | known gap **G4** (validation half) |

## 3. Active anchor & advancement

| # | Invariant | Pinned by | Status |
| --- | --- | --- | --- |
| B1 | `combined[activeIndex]` names the playing track through every mutation EXCEPT an auto-fill rewrite. A filter or sort change mid-play is the known exception: the fill moves/prunes the auto rows and leaves the index where it was (G1/G2, §13). | `tests/queueMutation.test.ts` — fuzz "anchor invariant…" (6 seeds × 10k ops); `tests/queueContinuation.test.ts` — "native field shape: row 104 never re-anchors to history row 50"; `tests/playbackManagerAdvance.test.ts` — "control: end-of-track advance is unchanged when the active row is queued" | pinned — G1/G2 exception |
| B2 | An unrelated mutation preserves the active OCCURRENCE, not merely the id: an auto row must not re-anchor onto an earlier user copy of the same song. | `tests/queueContinuation.test.ts` — "unrelated mutation preserves the active auto occurrence, not its history duplicate" | pinned |
| B3 | Removing a row ABOVE the active row decrements the index; removing a row BELOW it leaves the index alone; removing the ACTIVE row keeps the index so the highlight slides to the next playable row (2.4 option b). | `tests/queueMutation.test.ts` — "removeFromUserQueue: removing a preceding row decrements…", "…removing the active row keeps the index…", "…removing a following row leaves the anchor untouched", "rapid removals above the active row keep the anchor on the playing id each time" | pinned |
| B4 | Removing the active LAST row leaves the anchor past the new end — an honest stop, never a phantom row. | `tests/queueMutation.test.ts` — "removeFromUserQueue: removing the active LAST row lands the anchor past the new end"; `tests/playbackManagerAdvance.test.ts` — "removing the active LAST row lets it play out (native parity, 2.7)" | pinned |
| B5 | Once the playing row is unqueued, advance targets `activeIndex` (the highlighted next row), not `activeIndex + 1`. | `tests/queueMutation.test.ts` — "advanceTargetIndex: after an active-row removal the next row is AT activeIndex (2.4 option b)"; `tests/playbackManagerAdvance.test.ts` — "end-of-track after removing the ACTIVE row advances to the next row (not stop/wrap)", "next() after removing the ACTIVE row plays the highlighted row" | pinned |
| B6 | With no playing track, advance uses the plain `activeIndex + 1` (the end-of-queue refill path). | `tests/queueMutation.test.ts` — "advanceTargetIndex: no playing track keeps the plain +1 target" | pinned |
| B7 | Promotion puts the audible song at the user boundary with the untouched auto continuation immediately after it — never at an old history slot. | `tests/queueMutation.test.ts` — "recycled auto promotion moves the audible song to the boundary (native history-replay regression)", "recycled promotion with no surviving auto tail keeps the audible song queued", "a repeat play never rewinds…", "long hands-off auto session with interleaved duplicates never replays history" | pinned |
| B8 | Moving the PLAYING row (drag / move-to-end) re-anchors by id and re-arms the crossfade target onto the NEW next row. | `tests/playbackManagerAdvance.test.ts` — "end-of-track after moving the PLAYING row down advances to the NEW next row", "moving the playing row re-arms the web crossfade target onto the NEW next row"; `tests/queueMutation.test.ts` — "dragging the active USER row keeps the anchor on the moved user occurrence" | pinned † |
| B9 | A queue mutation never leaves a stale armed crossfade target; removal of the armed row re-arms or disarms. | `tests/playbackManagerAdvance.test.ts` — "removing the ARMED next row re-arms the crossfade target past the removal", "…tail next row disarms the arm", "…stale re-arm whose target was removed mid-resolve is dropped", "queue-write bursts coalesce into ONE re-arm" | pinned |
| B10 | A drag carries the source occurrence (`queueEntryId`); a cross-section duplicate drag moves the occurrence the user grabbed — the auto copy when the user grabbed that one — never a same-id neighbour. | `tests/queueMutation.test.ts` — "applyDragDrop: a cross-section duplicate resolves to the dragged AUTO occurrence (G5 closed)", "…with two user copies the dragged one moves and the other stays"; `tests/e2e/queuedragdup.spec.ts` — "three copies of one song are independent rows" | pinned (G5 closed) |
| B11 | A filter/sort change while an AUTO row plays must keep the anchor on that row. | `tests/queueManagerFill.test.ts` — "a filter change that still matches the playing auto row keeps it queued AND anchored" / "…EXCLUDES the playing auto row… (KNOWN GAP)" / "a sort change mid-play rebuilds the auto order without re-anchoring… (KNOWN GAP)" / "…drops the LAST playing auto row leaves activeIndex past the end (KNOWN GAP)" | known gap **G1/G2** |
| B12 | Two Next presses in the same tick must skip two rows. | `tests/playbackManagerNav.test.ts` — "two Next presses in the same tick skip only ONE row (KNOWN GAP…)" | known gap **G3** |
| B13 | Next then Previous in the same tick returns to the starting row, with both left rows cooled. | `tests/playbackManagerNav.test.ts` — "Next then Previous in the same tick returns to the starting row" | new |
| B14 | On web, removing the PLAYING row skips to its successor immediately; removing a different OCCURRENCE of the same song does not (id equality alone is not enough once duplicates exist). | `tests/playbackManagerAdvance.test.ts` — "removing the PLAYING row skips to the next track immediately (2.7)", "removing a DUPLICATE of the playing row never skips playback (occurrence identity)"; `tests/e2e/queueRows.spec.ts` — duplicate-rows spec (the playing row survives the copy removal) | pinned |

## 4. Promotion & history

| # | Invariant | Pinned by | Status |
| --- | --- | --- | --- |
| C1 | Only an ACTIVE AUTO row promotes; an explicit user-row replay leaves its independent upcoming auto occurrence untouched. | `tests/queueMutation.test.ts` — "explicit USER replay never consumes its independent upcoming auto copy", "promoteActiveTrack is a no-op when the active row is not in auto" | pinned |
| C2 | The auto prefix consumed by the promotion cools down in the SAME write (the rows the user never played must not re-enter the fill at the head). | `tests/queueMutation.test.ts` — "promoteActiveTrack consumes the skipped prefix and cools it for the refill"; `tests/playbackManagerAdvance.test.ts` — "auto-row promotion cools the consumed skipped prefix so the refill cannot replay it" | pinned |
| C3 | Promotion never duplicates: an existing user copy is MOVED, not appended again. | `tests/queueMutation.test.ts` — "recycled auto promotion moves the audible song…", "promoteActiveTrack: active row in auto at auto[0] promotes to the user tail", "…works in the transition window" | pinned |
| C4 | A crossfade transition promotes the row that actually played (the reconciled target), not blindly the advanced index. | `tests/crossfadeReconcile.test.ts` — "target still queued at a different index → repoint", "target removed mid-fade → rescue…", "advance exhausted + loop-all → wrap…"; `tests/queueContinuation.test.ts` — "web crossfade reconciliation retains the chosen auto occurrence before promotion" | pinned |
| C5 | An early native bridge event that promotes before `engage` settles still gets a fresh snapshot afterwards. | `tests/queueContinuation.test.ts` — "initial native engage syncs a promotion made by an early bridge event even when later promotion is a no-op" | pinned (JS half — device-unverified) |
| C6 | User-section replay of a row that also sits in auto must not consume the auto tail. | `tests/queueContinuation.test.ts` — "native explicit history replay and Previous keep their selected occurrence and auto tail" | pinned |

## 5. Recency cooldown

| # | Invariant | Pinned by | Status |
| --- | --- | --- | --- |
| D1 | The window is a bounded LRU (100): new marks append as newest, re-marks move, the oldest are dropped at the cap. | `tests/recentWindow.test.ts` — "inscribeRecent appends…", "…moves an existing track to the newest slot", "…caps at the limit dropping the OLDEST entries", "…re-playing a cooled-down track refreshes recency without wasting cap", "10k transitions: bounded, duplicate-free, recency-ordered" | pinned |
| D2 | Load-time sanitize keeps the NEWEST occurrence (the queue restore keeps the first — opposite by design, each matching its own semantic). | `tests/recentWindow.test.ts` — "sanitizeRecent dedupes keeping the newest occurrence", "sanitizeRecent tolerates undefined/empty input"; `tests/queueRestore.test.ts` — "restore dedupes each section (first occurrence wins), re-anchors the active row by id, and sanitizes recents" (its recents assertion) | pinned |
| D3 | Every row that leaves the active slot cools: natural end, skip, removal (either section). | `tests/queueMutation.test.ts` — "removeFromAutoQueue filters the row and cools it down", "removeFromUserQueue: the removed id cools…"; `tests/playbackManagerNav.test.ts` — "Next then Previous in the same tick…" (recents assertion) | pinned |
| D4 | An explicit queue edit does NOT cool what it hides; `clearQueue`/`clearUserAbove/Below` preserve the window, `playAll` resets it. | `tests/queueMutation.test.ts` — "clearQueue keeps the active track at user[0] and preserves the recency window"; `tests/queueBulkImport.test.ts` — "playAll resets the anti-repeat window and drops the auto tail in the same flow" | pinned |
| D5 | Fresh fill excludes the window; the cooled rows are re-admitted only when the fresh pool is short (tier 2). | `tests/autoQueuePlan.test.ts` — "tier 2 admits cooling-down tracks when the fresh pool is short"; `tests/queueContinuation.test.ts` — "one vacancy plus one fresh candidate never admits cooldown/recycled candidates" | pinned |
| D6 | A row dropped by a tightened filter cannot re-enter any tier (every tier requires a filter match). | `tests/autoQueuePlan.test.ts` — "kept is pruned when filters tighten, and the queue-full early return skips the pool"; `tests/queueManagerFill.test.ts` — "a tightened filter prunes non-matching auto tracks and stops filling" | pinned |

## 6. Fill tiers, exhaustion & wrap

| # | Invariant | Pinned by | Status |
| --- | --- | --- | --- |
| E1 | Tier admission compares VACANCIES (`needed - kept`), not total capacity. | `tests/queueContinuation.test.ts` — "one vacancy plus one fresh candidate never admits cooldown/recycled candidates" | pinned |
| E2 | Tier 3 admits user-queued and cooled tracks (B4: recycle instead of starving) and excludes only the playing id. | `tests/autoQueuePlan.test.ts` — "tier 3 recycles user-queued + recent tracks and excludes the active id (B4)"; `tests/queueManagerFill.test.ts` — "a sort change mid-play…" (observes `u` re-admitted) | pinned |
| E3 | Selection priority is fresh → cool-down → recycling; shuffle samples uniformly WITHIN a full tier and never mixes tiers. | `tests/queueContinuation.test.ts` — "shuffle samples entire tiers without mixing priority or mutating the plan"; `tests/autoQueuePlan.test.ts` — "shuffle is reported as data, not applied" | pinned |
| E4 | A rebuild (`keepAuto: false`) admits the old auto rows as ordinary pool members and applies the new order wholesale. | `tests/autoQueuePlan.test.ts` — "rebuild (keepAuto false) admits the old auto tracks as ordinary pool members"; `tests/queueManagerFill.test.ts` — "a sort change rebuilds the whole auto queue in the auto-sort order (B7)" | pinned |
| E5 | Non-shuffle ordering sorts within each tier and rotates after the anchor (the last user-queue row), so the fill CONTINUES from the current position; a wrapped pool sets `wrapNotice`. | `tests/autoQueuePlan.test.ts` — "non-shuffle ordering follows the shared sort and rotates after the last user entry", "rotateAfterAnchor truth table"; `tests/queueManagerFill.test.ts` — "the autoQueueSort subscription continues the fill from the playing track (not the top)" | pinned |
| E6 | A fully-tied library still answers the sort arrow at the visible head (ties mirror the direction). | `tests/autoQueuePlan.test.ts` — "buildOrderRank: a fully-tied library mirrors the arrow"; `tests/queueManagerFill.test.ts` — "a fully-tied library still shows the flip at the queue head" | pinned |
| E7 | The fill follows its OWN sort; the shared library sort never re-ranks it (2026-09-29 decoupling). | `tests/queueManagerFill.test.ts` — "the auto queue follows its OWN sort, never the library sort" | pinned |
| E8 | The library sort/filter is copied into the auto settings only through the explicit apply plan, and only the differing store is written. | `tests/autoQueuePlan.test.ts` — "differ: identical settings → false…", "apply plan: copies only the store that differs; searchQuery preserved", "apply plan: identical settings plan nothing" | pinned |
| E9 | The fill writes ONLY `autoQueue` (plus provenance/wrap notice); the user section and the anchor are untouched. This is the G1/G2 mechanism, not a bug in itself: leaving `activeIndex` alone is correct for an append-only fill and wrong once the rewrite prunes or reorders the row it names. | `tests/queueManagerFill.test.ts` — "replenish fills the auto queue from fresh tracks, excluding the playing user track", "a filter change that EXCLUDES the playing auto row…" (asserts user length) | pinned — G1/G2 mechanism |
| E10 | The two no-op guards skip the Dexie write (a full queue, and nothing addable + nothing dropped). | `tests/queueManagerFill.test.ts` — "the no-op guards skip the Dexie write when nothing can change", "a queue already full of matching tracks takes the first no-op guard" | pinned |
| E11 | `wrapNotice` is false for an empty pool (a no-op guard can never leave a stale hint); `autoQueueEmptyNotice` tracks "nothing addable". | `tests/queueManagerFill.test.ts` — "the empty-fill notice fires when nothing can be added and clears on a successful fill"; `tests/autoQueuePlan.test.ts` — "kept is pruned when filters tighten, and the queue-full early return skips the pool" | pinned |
| E12 | Inverted filter ranges are rejected at the panel (they would silently empty the queue). | `tests/autoQueuePlan.test.ts` — "filterRangesValid: inverted ranges are invalid; one-sided bounds are fine" | pinned |
| E13 | Rating / loved / year / length / scope / genre / search filter semantics (unrated = 0; missing year fails either bound; empty bounds pass). | `tests/autoQueuePlan.test.ts` — "rating: within range passes; out of range fails; unrated passes the default 0..100", "lovedOnly requires the cached loved flag", "year bounds: out-of-range fails; a track without a year is excluded by EITHER bound", "length bounds: out-of-range fails; empty bounds pass", "album/artist scopes match exactly; absent scope passes", "genre uses the shared token matcher", "searchQuery matches title/artist/album/composer substrings, case- and trim-insensitive" (plus its two token/fold variants) | pinned |

## 7. Shuffle

| # | Invariant | Pinned by | Status |
| --- | --- | --- | --- |
| F1 | Shuffle ON samples within tiers; OFF returns to the sort order; the toggle rebuilds the fill. | `tests/queueManagerFill.test.ts` — "shuffle mode permutes the pool (set-preserving) and clears the wrap notice"; `tests/playbackManagerRestore.test.ts` — "_subscribeShared rebuilds the auto queue on a shuffle toggle, and unsubscribing stops it" | pinned † |
| F2 | Hands-off shuffle plays every eligible song before repeating, then recycles at the boundary. | `tests/queueContinuation.test.ts` — "real native manager: hands-off shuffle…" (sizes 2/7/49/50/51/105/160); `tests/e2e/queueContinuation.spec.ts` — "shuffle plays every eligible song before recycling and keeps the active row at the boundary" | pinned |
| F3 | The shuffle setting round-trips through a reload. | `tests/e2e/persistence.spec.ts` — "shuffle mode round-trips through a reload" | pinned (browser) |

## 8. Loop mode & manual navigation

| # | Invariant | Pinned by | Status |
| --- | --- | --- | --- |
| L1 | Natural end: advance normally; wrap to `userQueue[0]` under loop-all; restart in place under loop-one; stop at the tail under loop-none. | `tests/playbackManagerNav.test.ts` — "a natural end under loop-all wraps to user[0]; under loop-none at the tail it stops"; `tests/playbackManagerNative.test.ts` — "_onNativeTrackEnded wraps…", "…stops at the tail with no wrap", "…restarts the current track under loop-one" | pinned † |
| L2 | Manual Next does not wrap at the combined tail, even under loop-all. | `tests/playbackManagerNav.test.ts` — "Next at the queue tail is a no-op under loop-all" | current behavior (open question Q1) |
| L3 | Previous at the first row restarts that row under loop-none and wraps to the last combined row under loop-all. | `tests/playbackManagerNav.test.ts` — "Previous at the first row restarts that row under loop-none", "…under loop-all wraps to the LAST combined row" | new |
| L4 | A removed row is unloopable: loop-one stops or advances instead of restarting it. | `tests/playbackManagerAdvance.test.ts` — "loop-one stops instead of restarting a removed track at its natural end", "removal skip ignores loop-one"; `tests/playbackManagerNative.test.ts` — "_onNativeTrackEnded loop-one stops when the current track left the queue" | pinned |
| L5 | The loop-one error-restart bound is 3 give-ups for the SAME track; only a natural end (or a different track) resets it. | `tests/playbackManagerAdvance.test.ts` — "loop-one bounds the restart cycle of a track that starts then errors", "loop-one healthy loop is never affected by the bound", "an error advance outside loop-one is not blocked by a stale cycle count" | pinned |
| L6 | No crossfade is armed under loop-one, and selecting loop-one cancels an armed fade. | `tests/playbackManagerAdvance.test.ts` — "the re-arm is skipped under loop-one"; `tests/playbackManagerRestore.test.ts` — "_subscribeShared cancels the armed web fade exactly when loop-one is selected" | pinned † |

## 9. Persistence & restore

| # | Invariant | Pinned by | Status |
| --- | --- | --- | --- |
| H1 | Every queue write goes through `persistQueue`, which names the first failure per call site per session and never throws into the store updater. | `tests/queuePersistence.test.ts` — "persistQueue names the first failure per source, once, and never throws", "persistQueue stays silent when the write succeeds" | pinned |
| H2 | Restore re-anchors the active row BY ID after dedupe (a pasted index would name a different song). | `tests/queueRestore.test.ts` — "restore dedupes each section (first occurrence wins), re-anchors the active row by id, and sanitizes recents" (the active row shifts 4 → 3) | new |
| H3 | An anchor past the queue end becomes −1; the legacy `historyQueue` field is accepted. | `tests/queueRestoreAnchor.test.ts` — "restore clears an out-of-range anchor and reads the legacy historyQueue field" | new |
| H4 | A full library sync drops stale ids from both sections and re-anchors by id, or −1 when the playing row vanished. | `tests/queueRestore.test.ts` — "a library sync that no longer contains the active track drops it and clears the anchor (-1)", "…keeps the active track re-anchors it by id after rows above it are pruned" | new |
| H5 | Settings restore is restore-before-persist and idempotent; corrupt rows keep the initial value. | `tests/persistedStore.test.ts` — "restore loads a saved value into the store", "writes before restore are not persisted; writes after restore are", "restore is idempotent", "decode returning undefined keeps the initial (corrupt legacy value)"; `tests/autoQueueFiltersPersistence.test.ts` — "legacy JSON-string row migrates into the fields store on initStores", "decodeAutoQueueFilters falls back to defaults on corrupt or wrong-typed rows" | pinned |
| H6 | The persisted filter row carries only filter fields (session scopes never leak into Dexie). | `tests/autoQueueFiltersPersistence.test.ts` — "scopes never persist…", "scope set without a filter write persists nothing" | pinned |
| H7 | The queue survives a reload with its sections, order, combined indexes and anchor intact. | `tests/e2e/persistence.spec.ts` — "the queue survives a reload with its sections and anchor intact" (snapshots the RENDERED user/auto sections and the highlighted anchor, reloads, compares); `tests/e2e/queueContinuation.spec.ts` — "shuffle plays every eligible song before recycling and keeps the active row at the boundary" (the WRITE half: reads the IndexedDB `playQueue` row directly) | pinned (browser) |

## 10. Native bridge reconciliation

| # | Invariant | Pinned by | Status |
| --- | --- | --- | --- |
| N1 | `trackChanged` is resolved by id + optional section occurrence, never by a numeric index; a duplicate event is idempotent; lock-screen Previous wins over an upcoming duplicate. | `tests/queueContinuation.test.ts` — "occurrence resolver preserves selection, prefers forward auto, and supports wraps/missing rows", "native lock-screen Previous occurrence wins over an upcoming duplicate", "duplicate events are harmless"; `tests/nativeTransport.test.ts` — "track-change forwarding preserves section occurrence identity without numeric indexes" | pinned (JS half) |
| N2 | A reload re-adopts the engine's playing track by id (a divergent engine index is ignored) and stops on an unknown id. | `tests/nativeReconcile.test.ts` — "playing + known + in combined - resync with the QUEUE index (never state.index)", "a divergent engine index is ignored - indexOf wins (E7)", "playing + known + dropped from combined - resync with index -1 (re-adopt)", "playing + unknown to the library - stop (the honest signal)" (8 pins); `tests/playbackManagerNative.test.ts` — "_reconcileNativeReload resyncs a known playing track", "…re-adopts a track that left the combined queue", "…stops on an unknown trackId" | pinned (JS half) |
| N3 | Native queue refreshes are microtask-coalesced, serialized, evaluated at fire time, and cancelled by disengage/destroy. | `tests/nativeTransport.test.ts` — "a burst of scheduleSync calls collapses into ONE refresh with the LAST factory", "the factory is evaluated at FIRE time…", "disengage before the microtask fires cancels the pending refresh", "scheduleSync after destroy is ignored" | pinned (JS half) |
| N4 | The native ended chain matches web decisions (advance / wrap / restart / stop) and the retry ladder is bounded. | `tests/playbackManagerNative.test.ts` — "_onNativeTrackEnded advances to the next row through decideAdvance", "_onNativeTrackEnded stops at the tail with no wrap (uniform A4 stop)", "_onNativeTrackEnded wraps to the first user row under loop-all", "_onNativeTrackEnded restarts the current track under loop-one", "divergence-ended advances from the JS-authoritative queue (1.4 chain)"; `tests/nativeTransport.test.ts` — "give-up after 3 errors…", "a retry reload engage does NOT reset the policy" | pinned (JS half — device-unverified) |

## 11. Bulk import boundary (`playAll`)

| # | Invariant | Pinned by | Status |
| --- | --- | --- | --- |
| J1 | `playAll` replaces the user section, clears the auto tail, anchors row 0 and resets the recency window. | `tests/queueBulkImport.test.ts` — "playAll with the actively playing track inside the import anchors on row 0", "playAll resets the anti-repeat window and drops the auto tail in the same flow" | new |
| J2 | `playAll([])` leaves an empty queue with `activeIndex 0`; the next advance refills the auto tail and skips its head. | `tests/queueBulkImport.test.ts` — "playAll([]) clears the queue; the next advance refills the auto tail and skips its head (known gap)" | known gap **G4** |
| J3 | `playAll` does not dedupe and does not validate against the library; advancing onto an unknown id can stall on it. | `tests/queueBulkImport.test.ts` — "playAll writes duplicate ids verbatim (KNOWN GAP…)", "playAll keeps ids missing from the library queued; advancing onto one stalls until playback stops" | known gap **G4** |
| J4 | `playNext` on an empty queue appends without inventing an anchor (`-1` until playback selects one). | `tests/queueBulkImport.test.ts` — "playNext on an empty queue appends the row and keeps the anchor unset…" | new |

## 12. Browser-level pins (the surfaces the pure tests cannot see)

Two browser pins live in their home sections because the invariant they prove belongs there: **F3** (§7,
shuffle round-trip) and **H7** (§9, queue restore after a reload).

| # | Invariant | Pinned by | Status |
| --- | --- | --- | --- |
| V1 | Queue rows carry their true combined index under the virtual window (play taps, now-playing, drag identity, drop target). | `tests/e2e/queueRows.spec.ts` — "row data-combined-index equals the true combined index", "tapping a queue row plays THAT row", "the playing row shows the now-playing indicator" | pinned (browser) |
| V2 | A queue drag reorders the store and the preview follows the pointer. | `tests/e2e/queueRows.spec.ts` — "drag to reorder: the drop reorders the store", "drag preview appears over the dragged row" | pinned (browser) |
| V3 | Three copies of one song are independent rows, each keyed and removable by occurrence, and dragging the third copy moves THAT copy. | `tests/e2e/queuedragdup.spec.ts` — "three copies of one song are independent rows alongside their auto occurrence" | pinned (browser) |
| V4 | Long queues stay bounded and playback keeps advancing (40-advance album, 500-song flood). | `tests/e2e/queueflood.spec.ts` — "album play-through: 40 advances grow the queue and the queue view stays bounded", "mega-album flood: a 500-song queue scrolls bounded and its landing screen loads" | pinned (browser) |
| V5 | Offline advance + native progress behave through the real bundle. | `tests/e2e/offline-advance.spec.ts` — "a mid-track connection drop still plays the preloaded next track from the cache", "the full preload window fills in queue order and survives two offline advances"; `tests/e2e/nativeProgress.spec.ts` — "native percentage-first events fill the actual SeekBar before completion" | pinned (browser — native mocked) |

## 13. Known gaps (found by this pass — reported, NOT repaired)

Each is pinned by a passing test that asserts the CURRENT behavior. Do not "fix" a gap by deleting its row;
rewrite the row and the test with the new rule, and record the decision in `docs/DEVLOG.md`.

**Progress (2026-10-21c):** G5 is CLOSED — drags now carry the source occurrence (`queueEntryId`), so a
same-id duplicate can be dragged independently. G1/G2 (fill rewrite without promoting the audible row) and
G3 (same-tick Next) are still open and close in steps 2–4 of [QUEUE-DESIGN.md](QUEUE-DESIGN.md) §6. The
"each-key collision" limb of G4 is also gone: row keys are occurrence-scoped (A4), so a bulk import with
duplicates renders.

### G1 — A filter change mid-play does not re-anchor the playing AUTO row (OPEN — step 4)
- **Shape:** `replenishAutoQueue` writes `autoQueue = kept + fill` and never touches `activeIndex`. When the
  playing row stops matching the tightened filter, it is pruned; the index stays put and now names a
  different row (or a row past the end when the playing row was last).
- **Impact:** `activeIndex` is the native refresh payload's position. A mid-track filter edit can make the
  next engine sync position the engine on the wrong row — a skip/replay class of bug, not a cosmetic
  highlight. Also breaks B1 until the next advance.
- **Evidence:** `tests/queueManagerFill.test.ts` — "a filter change that EXCLUDES the playing auto row…",
  "a filter change that drops the LAST playing auto row leaves activeIndex past the end".
- **Decision needed:** (a) keep the playing row pinned through a filter change (treat it as exempt), (b) drop
  the anchor to −1 and stop/advance explicitly, or (c) re-anchor to the surviving occurrence and accept a
  load. (a) looks most literal ("what I'm hearing stays"), but it means the visible queue can contain a row
  that no longer matches the filter shown.

### G2 — A sort change mid-play rebuilds the auto order without re-anchoring (OPEN — step 4)
- **Shape:** same root as G1 on the rebuild path (`keepAuto: false` wipes and replaces the auto section). The
  playing row may be re-included at a different position, so the index points at a neighbor.
- **Evidence:** `tests/queueManagerFill.test.ts` — "a sort change mid-play rebuilds the auto order without
  re-anchoring the playing row".
- **Note:** a rebuild also re-admits the user-queued row through tier 3 (B4), so after a sort change the auto
  tail may hold a cross-section duplicate of a user row. Deliberate, but worth remembering when playlists
  write into these primitives.
- **Decision needed:** the same three options as G1, applied at the rebuild choke point. A shared
  "preserve the audible occurrence across a fill rewrite" helper would close G1+G2 together.

### G3 — A Next press inside the load window does not advance (OPEN — step 3)
- **Shape:** `next()` advances `activeIndex` synchronously, but `currentTrack` is only written after the new
  source resolves. A second press inside that window sees `combined[activeIndex] !== playingId`, which
  `advanceTargetIndex` interprets as "the active row was removed" (2.4 option b) and re-targets the SAME
  row. The second tap is lost and the row is re-loaded.
- **Impact:** a quick double-tap on Next during a slow load skips one row instead of two; the reload can also
  restart audio at 0:00. Not a queue-corruption bug — the anchor stays valid.
- **Evidence:** `tests/playbackManagerNav.test.ts` — "two Next presses in the same tick skip only ONE row".
- **Decision needed:** either write `currentTrack` optimistically at advance time, or carry an explicit
  "load in flight / expected row" fact so `advanceTargetIndex` can distinguish a transition from a removal.

### G4 — `playAll` is an unguarded bulk boundary
- **Shape:** no section dedupe, no library validation, `activeIndex: 0` even for an empty array. A duplicate
  id is a fatal each-key collision in QueueView; an unknown id stalls the advance chain on it (the stale
  `currentTrack` keeps re-targeting the same row until playback stops); an empty import plus a later advance
  refills the auto tail and skips its head.
- **Impact:** today every caller passes unique library ids, so this is a latent boundary. Phase 3 playlists are
  exactly the kind of caller that can violate it (server playlists may repeat tracks or contain ids the local
  library no longer knows).
- **Evidence:** `tests/queueBulkImport.test.ts` (four tests, J2/J3).
- **Decision needed:** duplicate/order semantics for an imported playlist (the roadmap already flags this), and
  whether `playAll` should dedupe (first occurrence), filter unknown ids, or reject the import. Whatever is
  chosen becomes the playlist contract.

### G5 — CLOSED (2026-10-21c): drag identity is the occurrence
- **Shape (was):** `applyDragDrop` received a track id, not an occurrence; `indexOf` found the user copy first,
  so dropping the auto occurrence moved the USER copy (or no-opped).
- **Fix (2026-10-21c):** the drag payload is a `queueEntryId` (`u-<id>#<n>` / `a-<id>#<n>`), the plan resolves
  the source occurrence in the drag-start arrays, and the drag-move reconciles per-id occurrence COUNTS
  against the live queue to find the dragged copy's live index. `planDragDrop`/`applyDragDrop` take either a
  legacy `{ trackId }` signature (section-agnostic, kept for callers that only have an id) or
  `{ entryId }`.
- **Evidence:** `tests/queueMutation.test.ts` — "applyDragDrop: a cross-section duplicate resolves to the
  dragged AUTO occurrence (G5 closed)", "…with two user copies the dragged one moves and the other stays";
  `tests/queueOccurrence.test.ts` — `resolveEntry` / `entryOccupancy`.
- **Remaining:** QueueView derives the drag entry from the row it rendered (V2/V3 pins in §12).

## 14. What was unpinned before this pass

These behaviors had no durable test before 2026-10-21 and are now pinned. Rows marked `new` had no pins at
all before this pass; rows marked `pinned †` already had some, and the items below name the limb this pass
added (L1's web natural-end pin, F1's and L6's subscription pins, B8's drag-identity pin).

1. Restore raw pass-through + anchor bounds (A5, H2, H3, H4).
2. Bulk `playAll` shape, empty import, duplicate ids, unknown ids, active-track-in-import (J1–J4).
3. Drag/remove around the active row with a cross-section duplicate (A8, B8, B10).
4. Rapid Next/Previous, manual Next at the tail, Previous restart/wrap, natural-end wrap/stop on the web
   path, and the same-tick ordering (B13, L1–L3).
5. Sort/filter changes while an AUTO row plays — including the two gaps they expose (B11).
6. The shuffle-toggle rebuild subscription and the loop-one fade-cancel subscription (F1, L6).

## 15. Phase 3 boundary decisions (registered 2026-10-21, NOT implemented)

The playlists gate asks for these decisions before any playlist code. They are recorded here so Phase 3
starts from a written contract; each is a proposal with a recommended default, not a shipped behavior.

Server capability facts (doc/source-verified against the Subsonic API docs and Navidrome's
`server/subsonic/playlists.go`, `persistence/playlist_repository.go`, `core/playlists/playlists.go` — no live
server was contacted):

- `getPlaylists` lists what the user may see; `getPlaylist` takes `id`; `deletePlaylist` takes `id`.
- `createPlaylist` WITHOUT `playlistId` creates (needs `name`); WITH `playlistId` it **replaces** that
  playlist's tracks wholesale (the `name` argument does not rename it). `updatePlaylist` is incremental:
  repeated `songIdToAdd` appends, `songIndexToRemove` removes (zero-based API indexes).
- `songId` is repeated (`songId=A&songId=B`), and Navidrome **retains order and duplicates** — a server
  playlist may legitimately repeat a track (so G4 is not hypothetical).
- Visibility: a non-admin sees their own + public playlists; an admin sees all. Mutations require ownership
  or admin. A private foreign playlist reads as **code 70** (not found); a mutation that is found but
  forbidden reads as **code 50**. Both are Subsonic error codes in an HTTP 200 body — check the body, never
  the status alone.
- Playlist IDs: Navidrome documents that playlists/ratings/stars survive a persistent-ID migration, and does
  not promise that a playlist id is stable beyond that. Treat an unknown id as gone; do not recreate.

| Decision | Registered default | Why |
| --- | --- | --- |
| **Export scope** | The USER queue, verbatim (the played pile included, as the queue view shows it), with an optional "from the current row" variant as a UI affordance. Never the auto tail. | The auto tail is a regenerated suggestion pool; exporting it would freeze arbitrary suggestions into the user's account. A second backend is out of scope. |
| **Overwrite semantics** | "Save queue" creates a playlist when no id is stored; later saves reuse the stored id. Offer an explicit "Replace playlist" (create+id) and an incremental "Update" (updatePlaylist) so a save can never silently drop a row the user added on the server. | create+id replaces wholesale; update is incremental. The choice must be the user's, mirrored in the confirm copy. |
| **Duplicate / order semantics** | Preserve the server order AND its duplicates on import/play (occurrence identity, A1/A9) — `playAll` already writes rows verbatim. Export writes the user section verbatim. | Since 2026-10-21c the local queue represents duplicates as independent occurrences, so the server's duplicates are no longer lossy. The old "collapse to first occurrence" clause was written against the uniqueness model and is void. |
| **Missing tracks** | Filter ids the local library does not know at play/enqueue time, keep the surviving order, and state the count. Never rewrite the server playlist to "fix" it. | Mirrors the library-sync reconcile (H4) and the autoplay contract: an unresolvable id must not stall the chain (G4). |
| **Server unavailable** | No local playlist cache in v1. Show the honest offline/error state with retry; the local queue keeps working. | A second local playlist backend is exactly the duplication the roadmap forbids; the queue already survives offline. |
| **Playlist-ID migration / not found** | Code 70 → the playlist is gone (or invisible): clear the stored id, tell the user, require an explicit re-create. Never auto-recreate. | Auto-recreate after a migration produces duplicate playlists; invisible-vs-missing is indistinguishable to a non-admin by design. |
| **Read-only playlists** | Render a playlist the user cannot mutate (public, not owned) without edit/delete affordances; mutations surface code 50 instead of pretending. | Matches the server's owner-or-admin rule; avoids offering an action that always fails. |

## 16. Deliberately out of scope / not verifiable here

- **Physical iOS playback.** Every native row above pins the JS-side contract only. The engine schedules,
  crossfades, and advances on-device, and E5 stands: this checkout has no Swift toolchain. The physical
  acceptance item in `docs/plans/2026-10-17-streaming-growth-and-progress.md` remains open.
- **Playlist semantics.** No playlist code exists yet. Phase 3 must consume the primitives above (bulk play =
  `playAll`, enqueue = `addToUserQueue`, save queue = a read of `userQueue`/combined) and answer G4's
  duplicate/order decision before writing any of it.
- **Cross-browser.** The browser rows ran in Chromium only; Safari/iOS touch behavior for queue dragging is
  unverified (see the outstanding device review in the roadmap ledger).
- **Playback clock / seek intent / stream epochs.** These have their own suites and plans
  (`2026-10-07-seek-intent-and-stream-epochs.md`); they are adjacent to this matrix but not part of it.

## 17. Open product questions (behavior pinned, intent NOT recorded)

Rows carry this status instead of `pinned` when the test proves what the code DOES but no product decision
exists anywhere. They are listed here, separately from §13, because they are not known-wrong — they are
undecided. Phase 3 should settle them before a playlist surface inherits them.

### Q1 — Should manual Next wrap at the combined tail under loop-all?

- **Decided 2026-10-21b (NOT implemented):** yes under loop-all (wrap to `userQueue[0]`), stop playback
  at the tail under loop-none, and loop the song under loop-one. Previous at the first row becomes a
  no-op in every mode (the current restart/wrap is removed as too inconsistent to promise). Auto-off
  is defined as the direct form of a filter matching nothing, so repeat-all behaves identically in
  both cases. See [QUEUE-DESIGN.md](QUEUE-DESIGN.md) D8. This row keeps pinning the CURRENT no-op
  until the implementing commit rewrites L2, L3 and this section together.
- **Current behavior:** row L2 — `next()` is a no-op at the tail under loop-all, the mode where a natural
  end DOES wrap (`tests/playbackManagerNav.test.ts` — "Next at the queue tail is a no-op under loop-all").
  The code path never reads `loopMode`, so the other modes behave the same, but only this case is pinned.
  Previous at the first row DOES wrap under loop-all (L3), so the asymmetry is user-visible.
- **Why it is open:** nothing in the repository records this as a decision. An earlier revision asserted
  the rationale ("wrapping is a natural-end decision") in row L2 AND in the test's name; the sentence was
  inferred from the code and was removed from both by the 2026-10-21 audit rather than promoted to intent.
- **Options:** (a) keep it — a manual Next is an explicit "forward" and the tail is the end; (b) wrap under
  loop-all so the control matches the mode's promise; (c) wrap only where a natural end at the same row
  would have wrapped.
- **Constraint:** whichever is chosen, manual Next and the natural-end decision stay separate code paths
  (L1/L2), and the decision is recorded in `docs/DEVLOG.md` with the test rewritten in the same commit.

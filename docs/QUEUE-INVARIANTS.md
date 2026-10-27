# Queue & Playback Invariant Matrix

Date: 2026-10-21
Phase: 2A of [2026-10-18-holistic-polish-and-roadmap.md](plans/2026-10-18-holistic-polish-and-roadmap.md) — "Queue Pool Hardening & View-Layer Deduplication".
Status: **partly implemented**. Step 1 (2026-10-21c) shipped the OCCURRENCE model — a row is
`(section, id, ordinal)`, duplicates are legal in both sections, every mutation path moves/removes/drags an
occurrence, restore is a raw pass-through, native snapshots carry per-occurrence entry ids (§2, B2/B10, N1).
Step 2 (2026-10-21d) shipped press semantics: a library press appends and plays its own row (C7), promotion
appends instead of moving (C3), "Play next" inserts a copy instead of reordering (C8), and the crossfade
reconcile resolves the ARMED occurrence (C4). Step 3 (2026-10-21e) made a skip exact: the anchor-ahead-of-
audio fact (D10) means two presses are two rows, duplicate copies included (B12) — G3 CLOSED. Step 4
(2026-10-21f) made a filter/sort edit a FRESH CONTEXT (D7): one write promotes the audible auto row, clears
the anti-repeat window and rebuilds the tail with `keepAuto: false` — **G1 and G2 CLOSED**. Step 5
(2026-10-26) shipped the tail rules and the auto on/off switch (D8/D9) plus `playAll`'s library validation
(D12) — **G4 CLOSED**. Step 6 (2026-10-26) shipped the unique-first repeat pass (D6).

> **Nothing in steps 1–6 is still pending.** The only open queue item left in the target contract is D2's
> optional auto-copy drop on `+` (a SHOULD the code deliberately does not guess) and the playlists of §7.
> G6 remains a documented, pinned `known limitation` — not a to-do.

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

Verification for this document (updated 2026-10-26; steps 1–4 landed in 21c–21f): `npm test`
(1514 passing), `npm run check` (0 errors / 0 warnings), the full e2e suite (69+ passing) and the ui-review
suite (8 passing), including the rows' browser specs — `queueRows` (11), `queuedragdup` (2),
`queueContinuation` (1), `queuefresh` (1), `queueflood` (2), `persistence` (3).

**Citation check:** a row's `tests/<path>` marker owns the quoted names that follow it up to the next
marker, and each name must PREFIX a real test title in THAT file (names are often truncated with an ellipsis
in prose). The 2026-10-21g audit checked every row mechanically — 210 cited names, 0 unresolved — after
repairing 7 that failed it (H2/H4 described the pre-occurrence restore, D2/D3/E2/J3/B7 cited renamed
titles). A row whose citation cannot be re-pointed is a row whose behavior no longer exists: rewrite it
against the code, never delete it.

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
| `known gap G#` | The cited test pins CURRENT behavior that §13 records as wrong (fix = rewrite the test with the new rule). |
| `known limitation G#` | As above, where the gap is a constraint of the current design rather than a defect. |
| `current behavior (open question Q#)` | The test pins what the code does; no product decision is recorded. The question is open in §17. |

Two statuses were RETIRED in 2026-10-21f — `pinned — G1/G2 exception` and `pinned — G1/G2 mechanism`. No
row carries them: the fill has no rule-change exception any more (D7 promotes the audible row first), so
B1 and E9 state the rule instead of naming a gap.

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
| rule change | An explicit edit of the auto filter fields, the auto sort, or the library→auto apply. It is a FRESH CONTEXT (D7): promote the audible row, reset the window, rebuild. A shuffle toggle and a per-advance replenish are NOT rule changes. |

## 2. Sections & duplicates (occurrence identity)

| # | Invariant | Pinned by | Status |
| --- | --- | --- | --- |
| A1 | The user section may hold the same id any number of times; `addToUserQueue` ALWAYS appends a new occurrence (D2/D3). | `tests/queueMutation.test.ts` — "addToUserQueue appends a NEW occurrence even when the id is already queued (D2)"; `tests/queueBulkImport.test.ts` — "playAll preserves duplicate ids verbatim…" (+ appends a third copy); `tests/e2e/queueRows.spec.ts` — "duplicate songs render as independent occurrence rows" | pinned |
| A2 | No mutation builder dedupes either section. Auto duplicates arise from a drag/convert, a restore, a bulk import AND the D6 repeat pass (an exhausted pool cycles); the fill's unique-FIRST selection is a planner rule, never an identity constraint. | `tests/queueMutation.test.ts` — duplicates exercised by the planner/removal tests; `tests/queueRestore.test.ts` — restored auto duplicates survive; `tests/queueManagerFill.test.ts` — "a tightened filter prunes non-matching auto tracks and repeats the surviving one (D6)" | pinned |
| A3 | The same id in both sections is TWO independent rows. Promoting the auto occurrence appends a new user occurrence and drops that auto row; an older user copy stays where it is as history. | `tests/queueBulkImport.test.ts` — "a cross-section duplicate is two rows; promoting the auto occurrence appends a user occurrence"; `tests/queueMutation.test.ts` — "promoteToUser appends a new user occurrence…", "promoteToUserNext appends…" | pinned |
| A4 | Row identity is the OCCURRENCE. QueueView keys rows `u-<id>#<n>` / `a-<id>#<n>` (position-free): a duplicate is legal and addressable, and a row's key changes only when a same-id copy above it is added/removed — never on an advance. | `tests/queueOccurrence.test.ts` — "row keys are occurrence-scoped and never contain the row position"; `tests/e2e/queuedragdup.spec.ts` — "three copies of one song are independent rows"; `tests/e2e/queueRows.spec.ts` — duplicate-rows spec | pinned (browser for the key/render half) |
| A5 | Restore is a RAW PASS-THROUGH: persisted rows are kept verbatim (duplicates included) and the stored anchor is kept, bounds-checked, because nothing shifted. | `tests/queueRestore.test.ts` — "restore keeps persisted rows VERBATIM (duplicates included), the exact stored anchor…" | pinned |
| A6 | A drag moves the OCCURRENCE the user grabbed (entry id), never a same-id neighbour. No drag path dedupes or normalizes a section; a same-id auto row converted into user is its own row. | `tests/queueMutation.test.ts` — "planDragDrop: an auto copy of an id already in user is a SEPARATE row (no dedupe)", "…conversion keeps a duplicated auto row in the converted prefix", "applyDragDrop: a cross-section duplicate resolves to the dragged AUTO occurrence (G5 closed)", "…with two user copies the dragged one moves and the other stays" | pinned |
| A7 | Drop reconciliation budgets by PER-ID OCCURRENCE COUNTS against the live queue: a planned row is kept while a live occurrence of its origin id remains; live rows the plan never consumed (joined mid-drag) are appended in live order to their own section; a removed dragged occurrence voids the drop. | `tests/queueMutation.test.ts` — "applyDragDrop: reconciliation budgets by per-id COUNT, so a duplicate is not a newcomer", "…reorder still lands when rows joined mid-drag", "…a row that joined the USER section mid-drag stays…", "…a mid-drag removal of the SAME id above voids the drop" | pinned |
| A8 | Removal is occurrence-scoped AND section-scoped: a row ⨯ removes exactly the indexed copy (one occurrence), never `indexOf(id)`, and never purges the other section's copy. | `tests/queueMutation.test.ts` — "removeFromAutoQueue removes exactly the indexed occurrence…", "removeFromUserQueue: one duplicate can be removed without touching the other", "removing the PLAYING user row leaves its auto occurrence queued"; `tests/e2e/queueRows.spec.ts` — duplicate-rows spec (removes the second copy) | pinned |
| A9 | A bulk import (`playAll`) preserves the source order and duplicates verbatim and validates ids against the library (G4 CLOSED): unknown ids are dropped and reported, and a deferral happens while the library is loading. | `tests/queueBulkImport.test.ts` — "playAll preserves duplicate ids verbatim…", "playAll validates against the library: unknown ids are dropped and REPORTED…" | pinned |

## 3. Active anchor & advancement

| # | Invariant | Pinned by | Status |
| --- | --- | --- | --- |
| B1 | `combined[activeIndex]` names the playing track through every mutation AND through a rule-change rewrite: a filter/sort edit promotes the audible auto row before the fill runs (D7), so the fill below can only move auto rows the anchor does not name. There is no exception left. | `tests/queueMutation.test.ts` — fuzz "fuzz: anchor identity, duplicate legality, drag row-count preservation (10k × 6 seeds)"; `tests/queueContinuation.test.ts` — "native field shape: row 104 never re-anchors to history row 50"; `tests/playbackManagerAdvance.test.ts` — "control: end-of-track advance is unchanged when the active row is queued"; `tests/queueManagerFill.test.ts` — "a filter edit PROMOTES the audible auto row first…", "a rule edit cannot leave the anchor past the end…" | pinned |
| B2 | An unrelated mutation preserves the active OCCURRENCE, not merely the id: an auto row must not re-anchor onto an earlier user copy of the same song. | `tests/queueContinuation.test.ts` — "unrelated mutation preserves the active auto occurrence, not its history duplicate" | pinned |
| B3 | Removing a row ABOVE the active row decrements the index; removing a row BELOW it leaves the index alone; removing the ACTIVE row keeps the index so the highlight slides to the next playable row (2.4 option b). | `tests/queueMutation.test.ts` — "removeFromUserQueue: removing a preceding row decrements…", "…removing the active row keeps the index…", "…removing a following row leaves the anchor untouched", "rapid removals above the active row keep the anchor on the playing id each time" | pinned |
| B4 | Removing the active LAST row leaves the anchor past the new end — an honest stop, never a phantom row. | `tests/queueMutation.test.ts` — "removeFromUserQueue: removing the active LAST row lands the anchor past the new end"; `tests/playbackManagerAdvance.test.ts` — "removing the active LAST row lets it play out (native parity, 2.7)" | pinned |
| B5 | Once the playing row is unqueued, advance targets `activeIndex` (the highlighted next row), not `activeIndex + 1`. | `tests/queueMutation.test.ts` — "advanceTargetIndex: after an active-row removal the next row is AT activeIndex (2.4 option b)"; `tests/playbackManagerAdvance.test.ts` — "end-of-track after removing the ACTIVE row advances to the next row (not stop/wrap)", "next() after removing the ACTIVE row plays the highlighted row" | pinned |
| B6 | With no playing track, advance uses the plain `activeIndex + 1` (the end-of-queue refill path). | `tests/queueMutation.test.ts` — "advanceTargetIndex: no playing track keeps the plain +1 target" | pinned |
| B7 | Promotion puts the audible song at the user boundary with the untouched auto continuation immediately after it — never at an old history slot, and never by moving an old copy (C3). | `tests/queueMutation.test.ts` — "recycled auto promotion APPENDS a new user occurrence and keeps the history copy" (the native history-replay regression), "recycled promotion with no surviving auto tail keeps the audible song queued", "a repeat play never rewinds…", "long hands-off auto session with interleaved duplicates never replays history" | pinned |
| B8 | Moving the PLAYING row (drag / move-to-end) re-anchors onto the moved OCCURRENCE (not onto the first copy of its id) and re-arms the crossfade target onto the NEW next row. | `tests/playbackManagerAdvance.test.ts` — "end-of-track after moving the PLAYING row down advances to the NEW next row", "moving the playing row re-arms the web crossfade target onto the NEW next row"; `tests/queueMutation.test.ts` — "dragging the active USER row keeps the anchor on the moved user occurrence" | pinned † |
| B9 | A queue mutation never leaves a stale armed crossfade target; removal of the armed row re-arms or disarms. | `tests/playbackManagerAdvance.test.ts` — "removing the ARMED next row re-arms the crossfade target past the removal", "…tail next row disarms the arm", "…stale re-arm whose target was removed mid-resolve is dropped", "queue-write bursts coalesce into ONE re-arm" | pinned |
| B10 | A drag carries the source occurrence (`queueEntryId`); a cross-section duplicate drag moves the occurrence the user grabbed — the auto copy when the user grabbed that one — never a same-id neighbour. | `tests/queueMutation.test.ts` — "applyDragDrop: a cross-section duplicate resolves to the dragged AUTO occurrence (G5 closed)", "…with two user copies the dragged one moves and the other stays"; `tests/e2e/queuedragdup.spec.ts` — "three copies of one song are independent rows" | pinned (G5 closed) |
| B11 | A filter/sort change while an AUTO row plays keeps the anchor ON that row: the rule change promotes the audible occurrence into the user section first, resets the window and rebuilds the tail in ONE write (D7). The rebuilt tail is the fresh order under the new rules — never the old prefix with new rows appended — and the promoted row is never suggested back to itself (tier 3 excludes the active id). | `tests/queueManagerFill.test.ts` — "a filter edit PROMOTES the audible auto row first, so the anchor still names the song playing (D7 / G1 closed)", "a sort edit re-derives the order after the PROMOTED anchor (D7 / G2 closed)", "a rule edit cannot leave the anchor past the end when the audible row was the LAST matching one", "the filter subscription drives the FRESH CONTEXT through the real reaction layer (D7 wiring)", "a filter edit and a sort pick in ONE task collapse into a single fresh-context write (D7)"; `tests/e2e/queuefresh.spec.ts` — "a filter edit REBUILDS the tail in the new order and never disturbs the audible row (D7 / G1+G2)" | pinned (browser for the rewrite half) |
| B12 | Two Next presses inside one load window skip TWO rows (D10): the anchor-ahead-of-audio fact is never read as a removal. Duplicate rows advance by ROW, so the second press leaves a sibling copy instead of stopping on it. | `tests/playbackManagerNav.test.ts` — "two Next presses in the same tick skip TWO rows (D10 / G3)", "two Next presses over duplicate copies land on the second COPY, then past it", "a stale pending advance never masks an active-row removal"; `tests/e2e/queueRows.spec.ts` — "two Next presses skip two rows (G3…)" | pinned (G3 closed) |
| B13 | Next then Previous in the same tick returns to the starting row, with both left rows cooled. | `tests/playbackManagerNav.test.ts` — "Next then Previous in the same tick returns to the starting row" | new |
| B14 | On web, removing the PLAYING row skips to its successor immediately; removing a different OCCURRENCE of the same song does not (id equality alone is not enough once duplicates exist). | `tests/playbackManagerAdvance.test.ts` — "removing the PLAYING row skips to the next track immediately (2.7)", "removing a DUPLICATE of the playing row never skips playback (occurrence identity)"; `tests/e2e/queueRows.spec.ts` — duplicate-rows spec (the playing row survives the copy removal) | pinned |

## 4. Promotion & history

| # | Invariant | Pinned by | Status |
| --- | --- | --- | --- |
| C1 | Only an ACTIVE AUTO row promotes; an explicit user-row replay leaves its independent upcoming auto occurrence untouched. | `tests/queueMutation.test.ts` — "explicit USER replay never consumes its independent upcoming auto copy", "promoteActiveTrack is a no-op when the active row is not in auto" | pinned |
| C2 | The auto prefix consumed by the promotion cools down in the SAME write (the rows the user never played must not re-enter the fill at the head). | `tests/queueMutation.test.ts` — "promoteActiveTrack consumes the skipped prefix and cools it for the refill"; `tests/playbackManagerAdvance.test.ts` — "auto-row promotion cools the consumed skipped prefix so the refill cannot replay it" | pinned |
| C3 | Promotion APPENDS a new user occurrence (D5, 2026-10-21d): an older user copy of the same id stays where it is as history — promotion never relocates it. The user section therefore grows by exactly one row per played auto row. | `tests/queueMutation.test.ts` — "recycled auto promotion APPENDS a new user occurrence and keeps the history copy", "promotion with TWO pre-existing user copies appends a THIRD and collapses neither", "promoteActiveTrack: active row in auto at auto[0] promotes to the user tail"; `tests/queueContinuation.test.ts` — "real native manager: hands-off shuffle…" (one row per play); `tests/e2e/queueContinuation.spec.ts` — "shuffle plays every eligible song…" (`userQueue.length` grows by one) | pinned |
| C4 | A crossfade transition promotes the row that actually played (the reconciled target), not blindly the advanced index — and the target is resolved by OCCURRENCE (`targetEntryId`), so a duplicate elsewhere in the queue cannot repoint the anchor onto a different copy of the same song. The one hole is a same-id copy INSERTED ABOVE the armed row mid-fade, which renames the armed row and hands its entry id to the newcomer (G6, §13, pinned by C9). | `tests/crossfadeReconcile.test.ts` — "duplicate target: the armed occurrence wins over the first forward copy" (+ its id-only control), "an entry id whose occurrence is gone falls back…", "target still queued at a different index → repoint", "target removed mid-fade → rescue…", "advance exhausted + loop-all → wrap…"; `tests/playbackManagerAdvance.test.ts` — "crossfade reconcile uses the ARMED occurrence, not the first copy of the song"; `tests/queueContinuation.test.ts` — "web crossfade reconciliation retains the chosen auto occurrence before promotion" | pinned |
| C5 | An early native bridge event that promotes before `engage` settles still gets a fresh snapshot afterwards. | `tests/queueContinuation.test.ts` — "initial native engage syncs a promotion made by an early bridge event even when later promotion is a no-op" | pinned (JS half — device-unverified) |
| C6 | User-section replay of a row that also sits in auto must not consume the auto tail. | `tests/queueContinuation.test.ts` — "native explicit history replay and Previous keep their selected occurrence and auto tail" | pinned |
| C7 | A press on a song OUTSIDE the queue (library/album/artist/detail) starts that song: it drops the id's auto occurrence(s), appends ONE new user occurrence at the tail, anchors it and cools the previous audible row. It never jumps to an older copy in the log or the auto tail. A press on the AUDIBLE row resumes/restarts it without cloning. | `tests/queueMutation.test.ts` — "pressTrack appends a new occurrence, drops auto copies, anchors it and cools the previous row (D1)", "pressTrack returns null for the audible occurrence (resume, never a clone)", "pressTrack on an empty queue appends row 0 and leaves recents alone"; `tests/playbackManagerAdvance.test.ts` — "a library press starts a NEW occurrence instead of jumping to a history copy (D1)", "a library press drops the id's auto occurrence (explicit play supersedes a suggestion)", "a library press on the AUDIBLE row resumes it without cloning"; `tests/e2e/queueRows.spec.ts` — "pressing a library song queues and plays a NEW row instead of jumping to an old copy (D1)" | pinned |
| C8 | "Play next" is a press-driven INSERT: it adds a new user occurrence right after the audible row and never relocates a copy that is already queued (dropping that copy next to the anchor would delete it from the log). Row-scoped reorders remain `moveUserRowToNext`/`moveUserRowToEnd` (the row index is the only reorder identity; the id-taking `moveToNext`/`moveToEnd` were deleted 2026-10-21h). | `tests/queueMutation.test.ts` — "playNext inserts a new track right after the active row", "playNext ADDS a copy even when that song already sits in the next slot", "playNext never relocates an existing copy", "playNext on an auto-active queue inserts at the user tail…", "moveUserRowToNext / moveUserRowToEnd address the ROW index" | pinned |
| C9 | KNOWN LIMITATION (G6): the reconcile answers with the copy the entry id names, and ordinal identity cannot tell an insert-above from the armed row itself. A same-id copy inserted above the armed row mid-fade (reachable: a fresh-context rebuild or a tier-3 duplicate) therefore repoints the anchor to that inserted copy with no signal — a silent SAME-SONG mis-anchor, not a fallback. Audio is unchanged; the anchor and the promotion's cooled prefix are not. | `tests/crossfadeReconcile.test.ts` — "LIMITATION (G6): a same-id copy inserted ABOVE the armed row mid-fade repoints to the inserted copy" (+ its unchanged-ordinal control) | known limitation **G6** |

## 5. Recency cooldown

| # | Invariant | Pinned by | Status |
| --- | --- | --- | --- |
| D1 | The window is a bounded LRU (100): new marks append as newest, re-marks move, the oldest are dropped at the cap. | `tests/recentWindow.test.ts` — "inscribeRecent appends…", "…moves an existing track to the newest slot", "…caps at the limit dropping the OLDEST entries", "…re-playing a cooled-down track refreshes recency without wasting cap", "10k transitions: bounded, duplicate-free, recency-ordered" | pinned |
| D2 | Load-time sanitize keeps the NEWEST occurrence. It is now the ONLY dedupe in the load path: the queue restore keeps every row (A5/H2), so the two no longer mirror each other. | `tests/recentWindow.test.ts` — "sanitizeRecent dedupes keeping the newest occurrence", "sanitizeRecent tolerates undefined/empty input"; `tests/queueRestore.test.ts` — "restore keeps persisted rows VERBATIM (duplicates included), the exact stored anchor, and sanitizes recents" (its recents assertion: the duplicate-laden queue keeps both copies while recents dedupe) | pinned |
| D3 | Every row that leaves the active slot cools: natural end, skip, removal (either section). | `tests/queueMutation.test.ts` — "removeFromAutoQueue removes exactly the indexed occurrence and cools the id", "removeFromUserQueue: the removed id cools…"; `tests/playbackManagerNav.test.ts` — "Next then Previous in the same tick returns to the starting row" (recents assertion) | pinned |
| D4 | An explicit queue edit does NOT cool what it hides; `clearQueue`/`clearUserAbove/Below` preserve the window, `playAll` resets it. | `tests/queueMutation.test.ts` — "clearQueue keeps the active track at user[0] and preserves the recency window"; `tests/queueBulkImport.test.ts` — "playAll resets the anti-repeat window and drops the auto tail in the same flow" | pinned |
| D5 | Fresh fill excludes the window; the cooled rows are re-admitted only when the fresh pool is short (tier 2). | `tests/autoQueuePlan.test.ts` — "tier 2 admits cooling-down tracks when the fresh pool is short"; `tests/queueContinuation.test.ts` — "one vacancy plus one fresh candidate never admits cooldown/recycled candidates" | pinned |
| D6 | A row dropped by a tightened filter cannot re-enter any tier (every tier requires a filter match). | `tests/autoQueuePlan.test.ts` — "kept is pruned when filters tighten, and a full queue keeps every row in place"; `tests/queueManagerFill.test.ts` — "a tightened filter prunes non-matching auto tracks and repeats the surviving one (D6)" | pinned |
| D6d | REPEAT PASS (D6): unique candidates are always admitted first; only when a fill can add NO new id does the tail cycle what it now holds until the target is reached (balanced from the head, one real row per copy). "Pool exhausted" therefore means exactly one thing — the filters match nothing — and the empty notice fires only then. | `tests/autoQueuePlan.test.ts` — "planRepeatPass cycles the section in order, balanced from its head", "planRepeatPass never invents a row…", "planRepeatPass is deterministic and does not mutate its input"; `tests/queueManagerFill.test.ts` — "a tightened filter prunes non-matching auto tracks and repeats the surviving one (D6)", "the empty-fill notice means NOTHING MATCHES — an exhausted pool repeats instead (D6)"; `tests/queueContinuation.test.ts` — "real native manager: hands-off shuffle…" (every eligible id is heard before any repeat) | pinned |
| D6e | AUTO-ON/OFF (D9): `autoQueueEnabled` is persisted and restored. OFF clears the auto section in ONE write (promoting the audible auto row first, so clearing can never delete the playing song), gates every fill entry point, and shows a quiet off-state — never the filter warning. ON is a fresh context (D7 reset rules). | `tests/queueManagerFill.test.ts` — "auto-off clears the tail in one write and never fills (D9)", "auto-off promotes the audible AUTO row first, so clearing cannot delete the playing song (D9)"; `tests/e2e/autoqueueoff.spec.ts` — "auto-off clears the suggestions, says so quietly, and persists across a reload (D9)" | pinned (unit + browser) |
| D6a | A RULE CHANGE resets the window (D7.2): something heard minutes ago can be suggested again immediately — the deliberate, user-visible consequence of "fresh context". A SHUFFLE toggle does not reset it (shuffle reorders the same rule set). | `tests/queueManagerFill.test.ts` — "a filter edit PROMOTES the audible auto row first…" (recents `[]`), "a sort edit re-derives the order after the PROMOTED anchor" (recents `[]`), "the filter subscription drives the FRESH CONTEXT…" (recents `[]`), "shuffle mode permutes the pool (set-preserving)…" (the window survives the toggle) | new |
| D6b | The rule-change reaction compares filter VALUES (and the sort key) before scheduling, so a subscription's subscribe-time fire is never a rule change — a restored tail and anti-repeat window survive app start. | `tests/playbackManagerRestore.test.ts` — "the subscribe-time filter fire never resets the anti-repeat window (D7 is destructive)" | new |

| D6c | A sort change is a rule change REGARDLESS of shuffle state: shuffle decides how a rebuilt pool is SAMPLED, not whether the rules changed, so the flip still clears the window and re-derives the tail (the older `if (shuffleEnabled) return` early-out would make the flip a silent no-op). Two rule writes in one task (the FilterSortBar apply) land as ONE fresh context. | `tests/queueManagerFill.test.ts` — "a sort flip is a rule change even while shuffling (never skipped)", "a filter edit and a sort pick in ONE task collapse into a single fresh-context write (D7)" | new |

## 6. Fill tiers, exhaustion & wrap

| # | Invariant | Pinned by | Status |
| --- | --- | --- | --- |
| E1 | In the SHUFFLE path (the one that keeps a sampled prefix) tier admission compares VACANCIES (`needed - kept`), not total capacity. The ordered path derives the continuation from scratch, so it admits against the full capacity and lets the kept run be computed afterwards. | `tests/queueContinuation.test.ts` — "one vacancy plus one fresh candidate never admits cooldown/recycled candidates" | pinned |
| E2 | Tier 3 admits user-queued and cooled tracks (B4: recycle instead of starving) and excludes only the playing id. | `tests/autoQueuePlan.test.ts` — "tier 3 recycles user-queued + recent tracks and excludes the active id (B4)"; `tests/queueManagerFill.test.ts` — "a sort edit re-derives the order after the PROMOTED anchor (D7 / G2 closed)" (observes the user-queued `u` re-admitted as an independent auto row while the active `a` stays excluded) | pinned |
| E3 | Selection priority is fresh → cool-down → recycling; shuffle samples uniformly WITHIN a full tier and never mixes tiers. | `tests/queueContinuation.test.ts` — "shuffle samples entire tiers without mixing priority or mutating the plan"; `tests/autoQueuePlan.test.ts` — "shuffle is reported as data, not applied" | pinned |
| E4 | A rebuild (`keepAuto: false`) admits the old auto rows as ordinary pool members and applies the new order wholesale. It has exactly two callers: a SHUFFLE toggle (`rebuildAutoQueue`) and a RULE CHANGE (`rebuildForFreshContext`, which promotes and resets the window first). | `tests/autoQueuePlan.test.ts` — "rebuild (keepAuto false) admits the old auto tracks as ordinary pool members"; `tests/queueManagerFill.test.ts` — "a sort change rebuilds the whole auto queue in the auto-sort order (B7)", "a sort edit re-derives the order after the PROMOTED anchor (D7 / G2 closed)" | pinned |
| E5 | Non-shuffle ordering is an ORDERED CONTINUATION: tiers are ranked and rotated after the anchor (the user-queue tail), the auto rows are ordinary candidates of that same set, and `kept` is only the leading run the order still starts with — so a moved anchor (press, jump, re-rank) re-derives the whole tail while a plain advance keeps it. A wrapped pool sets `wrapNotice`. | `tests/autoQueuePlan.test.ts` — "non-shuffle ordering follows the shared sort and rotates after the last user entry", "rotateAfterAnchor truth table", "a moved anchor re-derives the kept run instead of keeping the stale prefix", "a tail that still is the continuation is kept in place (no churn)"; `tests/queueManagerFill.test.ts` — "the autoQueueSort subscription continues the fill from the playing track (not the top)", "a library press re-derives the auto tail from the pressed row (ordered fill)", "a filter and sort applied mid-play keep holding as playback advances"; `tests/e2e/autoqueueadded.spec.ts` — "the auto tail re-anchors on a pressed song and keeps the sort across advances" | pinned |
| E5b | The audible AUTO occurrence (and the rows above it) is PINNED through an ordered replenish until its post-load promotion, and the continuation starts after it — re-deriving under it would drop the playing row and move the anchor off the audible song. | `tests/autoQueuePlan.test.ts` — "the audible auto occurrence is pinned until its promotion"; `tests/playbackManagerAdvance.test.ts` — "web crossfade completion of a recycled AUTO occurrence keeps audible identity and continuation" | pinned |
| E5c | A hand-ordered auto tail (a drag that changed the auto section) survives the next fill: the ordered replenish keeps the dragged sequence verbatim and only appends after its last row. The intent is DATA (`HandOrder {tail, rule}`) and its lifetime is resolved against the live queue: a filter/sort/shuffle change, an emptied tail (Play All/Clear) or a head the drop never placed voids it, and the fill retires it at the point of use. The one explicit ending is a PICK — the press (`selectTrack`) or a queue-row tap (`playTrackAt`) — after which the derived order wins; a plain advance/Next does not end it. Session-only: a reload re-derives from the rule. | `tests/autoQueuePlan.test.ts` — "a hand-ordered tail is kept verbatim and the sort only appends after it", "a hand order is void once the rule, the tail or a row stops being what the drop asserted"; `tests/queueManagerFill.test.ts` — "a dragged auto order survives the next advance, and a rule change re-derives it", "a press ends the hand-ordered tail and re-derives it from the pressed row"; `tests/playbackManagerAdvance.test.ts` — "picking a queue row ends a hand-ordered auto tail"; `tests/e2e/autoqueueadded.spec.ts` — "a dragged auto order survives the next advance and yields to a sort change", "a press drops a dragged auto order and re-derives from the pressed song" | pinned |
| E6 | A fully-tied library still answers the sort arrow at the visible head (ties mirror the direction). | `tests/autoQueuePlan.test.ts` — "buildOrderRank: a fully-tied library mirrors the arrow"; `tests/queueManagerFill.test.ts` — "a fully-tied library still shows the flip at the queue head" | pinned |
| E7 | The fill follows its OWN sort; the shared library sort never re-ranks it (2026-09-29 decoupling). | `tests/queueManagerFill.test.ts` — "the auto queue follows its OWN sort, never the library sort" | pinned |
| E8 | The library sort/filter is copied into the auto settings only through the explicit apply plan, and only the differing store is written. | `tests/autoQueuePlan.test.ts` — "differ: identical settings → false…", "apply plan: copies only the store that differs; searchQuery preserved", "apply plan: identical settings plan nothing" | pinned |
| E9 | Every fill path writes ONLY `autoQueue` (plus provenance/wrap notices) and never `activeIndex`. The one fill-family write that also touches the user section is the RULE-CHANGE promotion (B11/D7) — and that is what makes the guarantee safe rather than broken: it moves the audible row out of the section about to be rebuilt, so the anchor never names a row inside it. | `tests/queueManagerFill.test.ts` — "replenish fills the auto queue from fresh tracks, excluding the playing user track", "the filter subscription drives the FRESH CONTEXT through the real reaction layer" (the user section grows by exactly the promoted row, the auto section is replaced wholesale, and the whole rewrite is ONE persisted write) | pinned |
| E10 | The no-op guard compares the materialized section by CONTENT, so a full queue (and an unchanged tail) skips the Dexie write — and the repeat pass cannot be skipped by a length-only comparison. | `tests/queueManagerFill.test.ts` — "the no-op guards skip the Dexie write when nothing can change", "a queue already full of matching tracks takes the first no-op guard" | pinned |
| E11 | `wrapNotice` is false for an empty pool (a no-op guard can never leave a stale hint); `autoQueueEmptyNotice` means "the filters match nothing" — with D6 an exhausted pool repeats instead of raising it. | `tests/queueManagerFill.test.ts` — "the empty-fill notice means NOTHING MATCHES — an exhausted pool repeats instead (D6)"; `tests/autoQueuePlan.test.ts` — "kept is pruned when filters tighten, and a full queue keeps every row in place" | pinned |
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
| L2 | Manual Next at the combined tail obeys D8: loop-all wraps to `userQueue[0]`, loop-one restarts the song, loop-none STOPS playback. With the auto queue on and anything matching, D6 keeps the tail non-empty, so these cases are the auto-off / nothing-matches end. | `tests/playbackManagerNav.test.ts` — "Next at the queue tail wraps to the user head under loop-all (D8)", "Next at the queue tail STOPS under loop-none (D8)", "Next at the queue tail restarts the song under loop-one (D8)" | pinned |
| L3 | Previous at the FIRST row is a no-op in EVERY loop mode; more than 3 s into a track it restarts instead. The as-built restart/wrap split was removed (D8). | `tests/playbackManagerNav.test.ts` — "Previous at the first row is a NO-OP in every loop mode (D8)", "Previous >3 s into the first row restarts it instead of no-opping (D8)" | pinned |
| L4 | A removed row is unloopable: loop-one stops or advances instead of restarting it. | `tests/playbackManagerAdvance.test.ts` — "loop-one stops instead of restarting a removed track at its natural end", "removal skip ignores loop-one"; `tests/playbackManagerNative.test.ts` — "_onNativeTrackEnded loop-one stops when the current track left the queue" | pinned |
| L5 | The loop-one error-restart bound is 3 give-ups for the SAME track; only a natural end (or a different track) resets it. | `tests/playbackManagerAdvance.test.ts` — "loop-one bounds the restart cycle of a track that starts then errors", "loop-one healthy loop is never affected by the bound", "an error advance outside loop-one is not blocked by a stale cycle count" | pinned |
| L6 | No crossfade is armed under loop-one, and selecting loop-one cancels an armed fade. | `tests/playbackManagerAdvance.test.ts` — "the re-arm is skipped under loop-one"; `tests/playbackManagerRestore.test.ts` — "_subscribeShared cancels the armed web fade exactly when loop-one is selected" | pinned † |

## 9. Persistence & restore

| # | Invariant | Pinned by | Status |
| --- | --- | --- | --- |
| H1 | Every queue write goes through `persistQueue`, which names the first failure per call site per session and never throws into the store updater. | `tests/queuePersistence.test.ts` — "persistQueue names the first failure per source, once, and never throws", "persistQueue stays silent when the write succeeds" | pinned |
| H2 | Restore keeps the persisted rows and the stored anchor VERBATIM — no dedupe, no re-anchor (D13/A5). The stored index is exact precisely because nothing shifted, so only a bounds check applies (`clampStoredActiveIndex`); duplicates survive as independent rows. | `tests/queueRestore.test.ts` — "restore keeps persisted rows VERBATIM (duplicates included), the exact stored anchor, and sanitizes recents" (a legacy row with user `a,b,a,c` + auto `d,d,e` restores at index 4, still the audible `d`), "the restored duplicate rows have distinct occurrence entry ids" | new |
| H3 | An anchor past the queue end becomes −1; the legacy `historyQueue` field is accepted. | `tests/queueRestoreAnchor.test.ts` — "restore clears an out-of-range anchor and reads the legacy historyQueue field" | new |
| H4 | A full library sync prunes ids the library no longer has from both sections (every surviving copy kept) and re-anchors the audible occurrence BY COUNT — subtract exactly the rows removed above it, never `indexOf(id)`, which would land on an earlier copy (D13). When the audible row itself is gone, the anchor becomes −1. | `tests/queueRestore.test.ts` — "a library sync that loses the audible track clears the anchor and keeps the other copies", "a library sync that keeps the audible row re-anchors BY COUNT after pruning rows above it" (the second `a` wins over the first), "a library sync that keeps the active track re-anchors it by count after rows above it are pruned" | new |
| H5 | Settings restore is restore-before-persist and idempotent; corrupt rows keep the initial value. | `tests/persistedStore.test.ts` — "restore loads a saved value into the store", "writes before restore are not persisted; writes after restore are", "restore is idempotent", "decode returning undefined keeps the initial (corrupt legacy value)"; `tests/autoQueueFiltersPersistence.test.ts` — "legacy JSON-string row migrates into the fields store on initStores", "decodeAutoQueueFilters falls back to defaults on corrupt or wrong-typed rows" | pinned |
| H6 | The persisted filter row carries only filter fields (session scopes never leak into Dexie). | `tests/autoQueueFiltersPersistence.test.ts` — "scopes never persist…", "scope set without a filter write persists nothing" | pinned |
| H7 | The queue survives a reload with its sections, order, combined indexes and anchor intact. | `tests/e2e/persistence.spec.ts` — "the queue survives a reload with its sections and anchor intact" (snapshots the RENDERED user/auto sections and the highlighted anchor, reloads, compares); `tests/e2e/queueContinuation.spec.ts` — "shuffle plays every eligible song before recycling and keeps the active row at the boundary" (the WRITE half: reads the IndexedDB `playQueue` row directly) | pinned (browser) |

## 10. Native bridge reconciliation

| # | Invariant | Pinned by | Status |
| --- | --- | --- | --- |
| N1 | `trackChanged` is resolved by id + optional section occurrence, never by a numeric index; a duplicate event is idempotent; lock-screen Previous wins over an upcoming duplicate. | `tests/queueContinuation.test.ts` — "occurrence resolver preserves selection, prefers forward auto, and supports wraps/missing rows", "native lock-screen Previous occurrence wins over an upcoming duplicate", "…duplicate events are harmless"; `tests/nativeTransport.test.ts` — "track-change forwarding preserves section occurrence identity without numeric indexes" | pinned (JS half) |
| N2 | A reload re-adopts the engine's playing track by id (a divergent engine index is ignored) and stops on an unknown id. | `tests/nativeReconcile.test.ts` — "playing + known + in combined - resync with the QUEUE index (never state.index)", "a divergent engine index is ignored - indexOf wins (E7)", "playing + known + dropped from combined - resync with index -1 (re-adopt)", "playing + unknown to the library - stop (the honest signal)" (8 pins); `tests/playbackManagerNative.test.ts` — "_reconcileNativeReload resyncs a known playing track", "…re-adopts a track that left the combined queue", "…stops on an unknown trackId" | pinned (JS half) |
| N3 | Native queue refreshes are microtask-coalesced, serialized, evaluated at fire time, and cancelled by disengage/destroy. | `tests/nativeTransport.test.ts` — "a burst of scheduleSync calls collapses into ONE refresh with the LAST factory", "the factory is evaluated at FIRE time…", "disengage before the microtask fires cancels the pending refresh", "scheduleSync after destroy is ignored" | pinned (JS half) |
| N4 | The native ended chain matches web decisions (advance / wrap / restart / stop) and the retry ladder is bounded. | `tests/playbackManagerNative.test.ts` — "_onNativeTrackEnded advances to the next row through decideAdvance", "_onNativeTrackEnded stops at the tail with no wrap (uniform A4 stop)", "_onNativeTrackEnded wraps to the first user row under loop-all", "_onNativeTrackEnded restarts the current track under loop-one", "divergence-ended advances from the JS-authoritative queue (1.4 chain)"; `tests/nativeTransport.test.ts` — "give-up after 3 errors…", "a retry reload engage does NOT reset the policy" | pinned (JS half — device-unverified) |

## 11. Bulk import boundary (`playAll`)

| # | Invariant | Pinned by | Status |
| --- | --- | --- | --- |
| J1 | `playAll` replaces the user section, clears the auto tail, anchors row 0 and resets the recency window. | `tests/queueBulkImport.test.ts` — "playAll with the actively playing track inside the import anchors on row 0", "playAll resets the anti-repeat window and drops the auto tail in the same flow" | new |
| J2 | `playAll` with zero resolvable ids writes NOTHING: the live queue, its anchor and the recency window survive, and there is never an `activeIndex: 0` on an empty queue (G4 closed). | `tests/queueBulkImport.test.ts` — "playAll([]) writes NOTHING — an empty import never empties a live queue (G4 closed)" | pinned |
| J3 | `playAll` validates ids against the library: order and duplicates are preserved, unknown ids are dropped AND returned in the report, and a deferral happens while the library is loading (an unresolved id may only be unloaded). | `tests/queueBulkImport.test.ts` — "playAll preserves duplicate ids verbatim…", "playAll validates against the library: unknown ids are dropped and REPORTED, never queued (G4/D12)", "playAll DEFERS while the library is loading — an unresolved id may only be unloaded (D12)" | pinned |
| J4 | `playNext` on an empty queue appends without inventing an anchor (`-1` until playback selects one). | `tests/queueBulkImport.test.ts` — "playNext on an empty queue appends the row and keeps the anchor unset…" | new |

## 12. Browser-level pins (the surfaces the pure tests cannot see)

Two browser pins live in their home sections because the invariant they prove belongs there: **F3** (§7,
shuffle round-trip) and **H7** (§9, queue restore after a reload).

| # | Invariant | Pinned by | Status |
| --- | --- | --- | --- |
| V1 | Queue rows carry their true combined index under the virtual window (play taps, now-playing, drag identity, drop target). | `tests/e2e/queueRows.spec.ts` — "row data-combined-index equals the true combined index", "tapping a queue row plays THAT row", "the playing row shows the now-playing indicator" | pinned (browser) |
| V2 | A queue drag reorders the store and the preview follows the pointer. | `tests/e2e/queueRows.spec.ts` — "drag to reorder: the drop reorders the store", "drag preview appears over the dragged row" | pinned (browser) |
| V3 | Duplicates are independent rows through the real view: three user copies render/remove/drag by occurrence, AND dragging an AUTO copy of an already-queued song moves that AUTO occurrence (G5 through the pointer path). | `tests/e2e/queuedragdup.spec.ts` — "three copies of one song are independent rows; dragging one keeps all three", "dragging an AUTO copy of a queued song moves THAT occurrence into Up next (G5)" | pinned (browser) |
| V6 | A library press queues and plays a NEW row; a second press of an already-played song does not teleport back to the history copy. | `tests/e2e/queueRows.spec.ts` — "pressing a library song queues and plays a NEW row instead of jumping to an old copy (D1)" | pinned (browser) |
| V7 | A filter edit through the real filter modal RE-DERIVES the tail under the new rules (a widened year filter comes back in the rebuilt order, not the old prefix with new rows appended) and leaves the audible row, its anchor and the user section untouched. | `tests/e2e/queuefresh.spec.ts` — "a filter edit REBUILDS the tail in the new order and never disturbs the audible row (D7 / G1+G2)" | pinned (browser) |
| V4 | Long queues stay bounded and playback keeps advancing (40-advance album, 500-song flood). | `tests/e2e/queueflood.spec.ts` — "album play-through: 40 advances grow the queue and the queue view stays bounded", "mega-album flood: a 500-song queue scrolls bounded and its landing screen loads" | pinned (browser) |
| V5 | Offline advance + native progress behave through the real bundle. | `tests/e2e/offline-advance.spec.ts` — "a mid-track connection drop still plays the preloaded next track from the cache", "the full preload window fills in queue order and survives two offline advances"; `tests/e2e/nativeProgress.spec.ts` — "native percentage-first events fill the actual SeekBar before completion" | pinned (browser — native mocked) |

## 13. Known gaps (found by this pass)

Each open gap is pinned by a passing test that asserts the CURRENT behavior. Do not "fix" a gap by deleting
its row; rewrite the row and the test with the new rule, and record the decision in `docs/DEVLOG.md` — that
is what happened to G1, G2, G3 and G5, whose CLOSED sections are kept here with their replacement pins so
the history stays auditable. **NO OPEN GAP remains.** G6 is a `known limitation` in the same table (§13):
it is pinned as current behavior and is not scheduled.

**Progress:** G5 CLOSED 2026-10-21c (drags carry the source occurrence), G3 CLOSED 2026-10-21e (a skip is
exactly one row), G1 and G2 CLOSED 2026-10-21f (a rule change is a fresh context), **G4 CLOSED 2026-10-26**
(`playAll` validates against the library, reports what it dropped, defers while the library is loading, and
writes nothing when nothing resolves). The "each-key collision" limb of G4 was already gone: row keys are
occurrence-scoped (A4), so a bulk import with duplicates renders. G6 (2026-10-21) is the matrix's first
`known limitation`: a same-id insert above an armed row makes the crossfade reconcile repoint to the inserted
copy, which the ordinal identity model cannot distinguish from the armed row itself.

### G1 — CLOSED (2026-10-21f): a filter change mid-play keeps the anchor on the playing AUTO row
- **Shape (was):** `replenishAutoQueue` wrote `autoQueue = kept + fill` and never touched `activeIndex`. When
  the playing row stopped matching the tightened filter it was pruned; the index stayed put and named a
  different row (or a row past the end when the playing row was last).
- **Impact (was):** `activeIndex` is the native refresh payload's position, so a mid-track filter edit could
  make the next engine sync position the engine on the wrong row — a skip/replay class of bug. It also
  broke B1 until the next advance.
- **Fix:** the rule-change path no longer patches the tail. `queueManager.rebuildForFreshContext` (D7) runs
  as ONE write: promote the audible auto occurrence into the user section (the same pure reducer the
  post-load path uses, so the cooled consumed prefix matches by construction), clear `recentTrackIds`,
  rebuild the pool with `keepAuto: false`, and let the plan rotate after the anchor — which is now a USER
  row, so the rewrite below cannot move it. The reaction layer (`_scheduleRuleChange`) coalesces a filter
  edit and a sort pick from the same task into that single write and compares filter VALUES first, so a
  subscription's subscribe-time fire cannot wipe the restored window.
- **Evidence (the rows that replaced the three gap pins):** `tests/queueManagerFill.test.ts` — "a filter edit
  PROMOTES the audible auto row first, so the anchor still names the song playing (D7 / G1 closed)", "a
  rule edit cannot leave the anchor past the end when the audible row was the LAST matching one", "the
  filter subscription drives the FRESH CONTEXT through the real reaction layer (D7 wiring)";
  `tests/e2e/queuefresh.spec.ts` — the widened year filter re-derives the tail in order while the audible
  row stays the anchor.

### G2 — CLOSED (2026-10-21f): a sort change mid-play cannot re-anchor the playing row
- **Shape (was):** the rebuild path (`keepAuto: false`) wiped and replaced the auto section without touching
  the anchor, so the playing row could be re-included at a different position and the index named a
  neighbor.
- **Fix:** the same fresh-context write closes it — the audible row is a user row by the time the rebuild
  plans its pool, and the rotation anchor is that row (the user tail).
- **Evidence:** `tests/queueManagerFill.test.ts` — "a sort edit re-derives the order after the PROMOTED
  anchor (D7 / G2 closed)"; `tests/playbackManagerRestore.test.ts` — "the subscribe-time filter fire never
  resets the anti-repeat window (D7 is destructive)".
- **Note (unchanged):** a short pool still re-admits the user-queued row through tier 3 (B4), so the auto
  tail may hold a cross-section duplicate of a user row. Deliberate, and worth remembering when playlists
  write into these primitives.

### G3 — CLOSED (2026-10-21e): a skip is exactly one row, with or without a load in flight
- **Shape (was):** `next()` advanced `activeIndex` synchronously while `currentTrack` still named the old
  row. A second press inside that window saw `combined[activeIndex] !== playingId`, which
  `advanceTargetIndex` read as "the active row was removed" (2.4 option b) and re-targeted the SAME row —
  the second tap was lost.
- **Fix:** `appState.pendingAdvanceTrackId` records the row an advance (or a positional pick / library
  press) put the anchor on, and `advanceTargetIndex(q, combined, playingId, pendingTrackId)` treats a
  matching anchor as a TRANSITION → `activeIndex + 1`. The fact is validated against the live anchor, so
  a real removal (the anchor names a different row) still takes the positional rule, and
  `setCurrentTrack` clears it once the audio catches up.
- **Evidence:** `tests/playbackManagerNav.test.ts` — "two Next presses in the same tick skip TWO rows",
  "two Next presses over duplicate copies land on the second COPY, then past it", "a stale pending advance
  never masks an active-row removal"; `tests/e2e/queueRows.spec.ts` — "two Next presses skip two rows"
  (two clicks in ONE task, now-playing row asserted); `tests/queueMutation.test.ts` —
  `advanceTargetIndex` pins (now with the pending fact).
- **Side effect recorded:** an UNRESOLVABLE id no longer re-targets itself on the next advance (the
  pending fact is a transition, not a removal) — the first advance still resolves null and the caller
  stops. G4's remaining shape is the missing library validation, not a stall loop.

### G4 — CLOSED (2026-10-26): the bulk boundary validates against the library
- **Shape (was):** no library validation, `activeIndex: 0` even for an empty array; an unknown id stayed
  queued and its first advance resolved null (playback stopped — the caller's stop path was the only thing
  preventing a hang); an empty import plus a later advance refilled the auto tail and skipped its head. The
  duplicate half was already gone (occurrence keys render since step 1, D10 since step 3).
- **Impact (was):** every in-app caller passed library ids, so this was a latent boundary — but Phase 3
  playlists are exactly the kind of caller that can violate it (server playlists may repeat tracks or
  contain ids the local library no longer knows).
- **Fix (D12):** `queueManager.playAll` resolves every id against the library and returns a
  `BulkImportReport { accepted, dropped, deferred }`. Order and duplicates survive verbatim; unknown ids are
  dropped from the queue AND reported (never silently discarded); zero resolved ids writes NOTHING (the live
  queue, anchor and recency window survive — no `activeIndex: 0` on an empty queue); and while the library is
  still loading an unresolved id may merely be unloaded, so the import DEFERS without writing. Callers
  (`AlbumsView`, `ArtistsView`, and the future playlist import) refuse to start playback on a deferral or an
  empty result.
- **Evidence:** `tests/queueBulkImport.test.ts` — "playAll([]) writes NOTHING…", "playAll validates against
  the library: unknown ids are dropped and REPORTED…", "playAll DEFERS while the library is loading…",
  "playAll preserves duplicate ids verbatim…" (rows J2/J3).

### G5 — CLOSED (2026-10-21c): drag identity is the occurrence
- **Shape (was):** `applyDragDrop` received a track id, not an occurrence; `indexOf` found the user copy first,
  so dropping the auto occurrence moved the USER copy (or no-opped).
- **Fix (2026-10-21c):** the drag payload is the dragged row's OCCURRENCE entry id (`user:<id>` /
  `auto:<id>`, later copies `#<n>` — the `u-<id>#<n>` / `a-<id>#<n>` form is the Svelte row KEY, not the
  payload), the plan resolves the source occurrence in the drag-start arrays (`planDragDropRows` carries each
  row's ORIGIN section), and the drop reconciles per-id occurrence COUNTS against the live queue to find the
  dragged copy's live index. `applyDragDrop(q, entryId, targetIdx, dragStartUser, dragStartAuto)` is the only
  drop entry point — there is no id-only overload; the id view (`planDragDrop`) exists for the drag PREVIEW.
- **Evidence:** `tests/queueMutation.test.ts` — "applyDragDrop: a cross-section duplicate resolves to the
  dragged AUTO occurrence (G5 closed)", "…with two user copies the dragged one moves and the other stays";
  `tests/queueOccurrence.test.ts` — `findEntryIndex` / `occurrenceCounts`.
- **Real-surface proof (2026-10-21d):** `tests/e2e/queuedragdup.spec.ts` — "dragging an AUTO copy of a queued
  song moves THAT occurrence into Up next (G5)" restores the cross-section gesture through the pointer path
  (the step-1 rewrite had replaced it with a user-section gesture).

### G6 — KNOWN LIMITATION (2026-10-21): ordinal identity cannot survive a same-id insert ABOVE an armed row
- **Shape:** an entry id is `(section, id, ordinal)`. Inserting a copy of the SAME song above a row renames
  that row (its ordinal becomes n+1) and frees its old entry id for the newcomer. The crossfade arm captures
  the entry id at arm time, so the fade-end reconcile resolves the INSERTED copy: the anchor repoints to a
  row the user never armed, with no rescue and no mismatch signal. It is not a fallback — the entry id still
  "exists", it just names a different row of the same song.
- **Impact:** inaudible (the song is identical) but not harmless: the anchor sits one row early, and the
  post-load promotion appends THAT row and cools the rows before it, so the listening log and the cooled
  prefix describe a row that never played. Reachable mid-fade — a fresh-context rebuild (D7) re-derives the
  whole tail, and a tier-3 duplicate can land a same-id copy above the armed row.
- **Evidence:** `tests/crossfadeReconcile.test.ts` — "LIMITATION (G6): a same-id copy inserted ABOVE the armed
  row mid-fade repoints to the inserted copy", plus its unchanged-ordinal control (the same entry id resolves
  to the armed row itself when no copy was inserted above it).
- **Why this is a limitation, not a defect to patch:** an ordinal is positional by definition — the model has
  no row-born identity to fall back on. Closing it means giving every row a stable id assigned at INSERTION
  (a monotonic counter) and carrying that through the arm, the native snapshot and Swift; that is an
  identity-model change (D4 territory), not a reconcile fix. Not scheduled; matrix row C9 pins the current
  behavior so a future fix has a test to rewrite.

## 14. What was unpinned before this pass

These behaviors had no durable test before 2026-10-21 and are now pinned. Rows marked `new` had no pins at
all before this pass; rows marked `pinned †` already had some, and the items below name the limb this pass
added (L1's web natural-end pin, F1's and L6's subscription pins, B8's drag-identity pin).

1. Restore raw pass-through + anchor bounds (A5, H2, H3, H4).
2. Bulk `playAll` shape, empty import, duplicate ids, unknown ids, active-track-in-import (J1–J4).
3. Drag/remove around the active row with a cross-section duplicate (A8, B8, B10).
4. Rapid Next/Previous, manual Next at the tail, Previous restart/wrap, natural-end wrap/stop on the web
   path, and the same-tick ordering (B13, L1–L3).
5. Sort/filter changes while an AUTO row plays — originally pinned as the two gaps they exposed; the
  2026-10-21f pass rewrote those pins to the fresh-context rule (B11, E9, D6a) and added the
  subscribe-time-fire guard (D6b).
6. The shuffle-toggle rebuild subscription and the loop-one fade-cancel subscription (F1, L6).
7. That a RULE CHANGE is one write, that it resets the window while a shuffle toggle does not, that a
   filter+sort apply in one task coalesces into that single write, and that a sort flip under shuffle is
   still a rule change — the bundled-browser pin in `queuefresh` (B11, E9, D6a) plus the reaction-level
   pins in `tests/queueManagerFill.test.ts` (B11 coalescing, D6c).

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

## 17. Open product questions — none remain (Q1 CLOSED)

Rows carried this status when the test proved what the code DOES but no product decision existed anywhere.
Q1 has since been decided AND implemented, so this section is now a CLOSED record kept for audit, the same
way §13 keeps the closed gaps. Add a row here only if a genuinely undecided question appears.

### Q1 — CLOSED (2026-10-26): manual Next obeys D8 at the combined tail

- **Decision (2026-10-21b, implemented 2026-10-26):** loop-all wraps to `userQueue[0]`, loop-one restarts
  the song, loop-none STOPS playback; Previous at the first row is a no-op in every mode. Auto-off is the
  direct form of "the filter matches nothing", so repeat-all behaves identically either way. See
  [QUEUE-DESIGN.md](QUEUE-DESIGN.md) D8.
- **Pinned:** row L2 — `tests/playbackManagerNav.test.ts` — "Next at the queue tail wraps to the user head
  under loop-all (D8)", "Next at the queue tail STOPS under loop-none (D8)", "Next at the queue tail
  restarts the song under loop-one (D8)"; row L3 — "Previous at the first row is a NO-OP in every loop
  mode (D8)", "Previous >3 s into the first row restarts it instead of no-opping (D8)".
- **History:** this section previously pinned the old no-op and cited "Next at the queue tail is a no-op
  under loop-all", a title the D8 commit rewrote out of existence. That stale citation is why §17 exists
  now only as a closed record — a row may never point at a test that no longer carries its rule.

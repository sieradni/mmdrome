# Queue & Playlist Design — Agreed Target (2026-10-21b)

Status: **IMPLEMENTED through step 6 of §6 (steps 1–4 landed 2026-10-21c–f, steps 5–6 on 2026-10-26).**
This is the target contract; the as-built behavior — and the tests that pin it — live in
[QUEUE-INVARIANTS.md](QUEUE-INVARIANTS.md).
Landed: D3/D4/D5, D11, D13, D1's press semantics (+ the crossfade occurrence identity that D1 needs),
D10 (step 3), D7 (step 4 — the fresh-context rebuild, which closes G1/G2), **D8 + D9 (step 5: the tail
rules and the auto on/off switch)** and **D6 (step 6: the unique-first repeat pass)**. D12's library
validation landed with step 5 (`playAll` resolves against the library, reports drops, defers while the
library is loading) — G4 is CLOSED.
Still not landed: D2's optional auto-copy drop on `+` (a SHOULD the code deliberately does not guess),
the native `queueEntryId` refresh re-send note (step 1 leftover), and the playlists of §7. Until a rule's
row in the matrix says otherwise, do not cite it as shipped.

Date: 2026-10-21 (decisions taken across the 2026-10-21 review, follow-up to Phase 2A).
Supersedes: the duplicate/order half of QUEUE-INVARIANTS §15, and rows A1–A9, B11–B12, E2/E4, J2–J4,
G1–G5, Q1 once implemented.

## 0. Why this exists

Phase 2A characterized the queue and found five places where the code and the intended product
disagreed (G1–G5), plus one behavior nobody had decided (Q1). The review that followed settled the
product questions and changed three premises:

1. **Pressing a song should start that song, never teleport to an old copy of it.**
2. **Duplicates are legitimate.** The user queue is a listening log, not a set. The auto queue may
   repeat only when its pool is exhausted.
3. **A filter/sort edit is a fresh listening context**, not a patch applied to the tail.

Those three premises invalidate the uniqueness invariant the queue was built around, and they make
G1/G2 structurally impossible rather than "rare". They also give repeat-all a defined meaning once the
auto queue can be switched off.

## 1. Vocabulary

| Term | Meaning |
| --- | --- |
| user section | `queue.userQueue` — the listening list; rows above the anchor are history, rows below are upcoming. Duplicates allowed. |
| auto section | `queue.autoQueue` — the generated suggestion tail (max 50). Duplicates allowed only on pool exhaustion. |
| combined | `[...userQueue, ...autoQueue]` — the only order playback walks. |
| anchor | `queue.activeIndex`, an index into combined. |
| audible row | the track `currentTrack` names; normally `combined[activeIndex]`. |
| occurrence | one row: `(section, trackId, ordinal-within-that-id)`. This is the row's identity. |
| played pile | user rows above the anchor. Grows one row per play, by design. |
| fresh context | a rebuild triggered by an explicit rule change (see D7). |

## 2. Rules

Each rule is normative. "MUST" means the implementation is wrong if it does not hold.

### D1 — Pressing a song starts that song

- A press on a track row **outside the queue** (library, album, artist, detail modal) MUST NOT search
  the queue for the id. If the id is not the active row, the manager:
  1. removes that id's upcoming **auto** occurrences,
  2. appends ONE new user occurrence at the user tail,
  3. anchors that new row and starts playback.
- If the id IS the active combined row, the press is a resume/restart of that row — no new row.
- A press on a row in the **user** section is a positional play of that row (a deliberate jump within
  your own list; this is not the "jump" D1 removes).
- A press on a row in the **auto** section consumes every auto row above it (they are cooled and
  dropped), promotes the pressed row to the user boundary, and plays it. Playback resumes at the
  boundary; no unrelated row is targeted and no rows after the pressed row move.
- The previous audible row stays above the anchor as history and cools (unchanged).

### D2 — Add (+) appends; duplicates are allowed

- `addToUserQueue` MUST append a new occurrence even when the id is already in the user section.
- Pressing + on a track that also has an auto occurrence SHOULD drop that auto occurrence (a queued
  row supersedes the suggestion). `[open: default-drop, confirm at implementation]`
- `moveUserRowToNext` / `moveUserRowToEnd` remain **reorder** operations on the row the caller names
  (the row index — the id-taking `moveToNext`/`moveToEnd` and the bulk `reorderAll` write were deleted
  2026-10-21h: a bare id names several rows once duplicates exist, and the bulk write is exactly the
  drag path that reconciliation replaced). **Superseded 2026-10-21d:** the press-driven "Play next" (`playNext`) is an
  INSERT, not a reorder — it appends a new user occurrence right after the audible row and never
  relocates a queued copy (that copy may be history above the anchor; moving it would delete a log
  row). Decided during step 2 because turning the old reorder into an insert is the only version that
  honours "a press is an intent to hear this song next".

### D3 — The user section has no uniqueness invariant

- A within-section duplicate is legal and MUST NOT be deduped anywhere: mutation builders, drag
  normalization, DEV asserts, restore, or library reconcile.
- The old "duplicate = fatal each-key collision" premise is removed by D4 (row identity), not by
  forbidding duplicates.

### D4 — Row identity is the occurrence

- QueueView keys become occurrence-scoped: `u-<id>#<n>` / `a-<id>#<n>` (n = ordinal of that id in
  that section, 0-based). Position MUST NOT enter the key (the 2026-09-23 advance-churn lesson
  stands); the ordinal changes only when a same-id copy above it is added or removed.
- The row ⨯ removes exactly that row (index or occurrence id), never `indexOf(trackId)`.
- Drag carries the source occurrence (section + combined index at drag start), never just the id.
- Native `queueEntryId` becomes occurrence-unique: `user:<id>` for the first copy,
  `user:<id>#<n>` for later ones (same for `auto`). Swift only echoes the string; no Swift change.
- `resolveQueueOccurrence` resolves the exact entry id first, then the active row, then a forward
  occurrence — unchanged except the id format.

### D5 — Promotion appends

- Only the active AUTO occurrence promotes (`promoteActiveTrack`).
- It appends a new user occurrence at the boundary and removes the auto occurrence. An older user
  copy of the same id stays where it is as history (previously it was moved).
- The consumed auto prefix cools in the same write (existing behavior).
- After a successful load, the audible row is therefore a user row. D7 makes that true for every
  rewrite, not just after the load settles.

### D6 — Auto fill: unique first, repeat only on exhaustion

- Replenish/rebuild keep filling with **unique** candidates first (today's tiers 1–3).
- Only when a fill can add **no new id** does the repeat pass run: cycle the ids currently in the
  auto section (kept + just-added) in order until the vacancies are filled. Each repeat is a real row.
- This makes "the pool is exhausted" mean exactly one thing: the filter matches no track (or the
  library is empty). With any match, the auto tail can always be filled.
- Shuffle keeps its existing tier-local sampling; the repeat pass runs after selection and preserves
  the cycle order.
- `wrapNotice` / `autoQueueEmptyNotice` keep their meanings; the empty notice now only appears when
  nothing matches.

### D7 — A filter/sort edit is a fresh context

Any explicit change to the auto filter fields, the auto sort, or the library→auto apply MUST, as one
queue write:

1. promote the active auto occurrence if the anchor is in auto (so the audible row survives),
2. clear `recentTrackIds` (the anti-repeat window resets),
3. discard the kept auto prefix and rebuild the pool (`keepAuto: false`),
4. rotate the new order after the anchor (sort behavior, unchanged).

Consequences, all intended:
- Songs just played can be suggested again immediately.
- The "kept prefix is pruned by a tightened filter" path (the G1/G2 mechanism) no longer exists for
  rule changes. `keepAuto: true` remains only for the per-advance replenish.
- The active row is always a user row at the moment of the rewrite, so an auto rewrite cannot move
  the anchor. This is the structural close for G1 and G2.

Shuffle is **not** a rule change: it rebuilds the order (existing behavior) but does not reset
recents. The shared library filter/sort is likewise untouched (auto is decoupled; only the explicit
apply copies values in, and that apply IS a rule change).

### D8 — Loop modes and the queue tail

Loop mode describes what happens at the **end of the queue** and on an explicit Next at the end.
`'one'` means loop the song.

| Situation | loop-one | loop-all | loop-none |
| --- | --- | --- | --- |
| Natural end, a next row exists | restart the song | advance | advance |
| Natural end at the tail | restart the song | wrap to `userQueue[0]` | stop |
| Manual Next at the tail | restart the song | wrap to `userQueue[0]` | stop playback |
| Manual Previous at the first row | no-op | no-op | no-op |
| Previous >3 s into a track | restart the track (existing) | restart the track (existing) | restart the track (existing) |

- Manual Next/Previous stay separate code paths from the natural-end decision.
- With the auto queue ON and any filter match, the tail never ends (D6 repeats), so loop-all
  effectively never wraps: "repeat all" means "keep the suggestion session going".
- With the auto queue OFF, or with a filter matching nothing, the true tail is the last user row and
  loop-all replays the user queue from `userQueue[0]`. **Auto-off is the direct form of "the filter
  matches nothing"** and must behave identically.
- Previous at the first row is deliberately inert: restart-vs-wrap was judged too inconsistent to
  promise. This is a change from the as-built L3 (which restarted under none and wrapped under all).

### D9 — Auto queue on/off

- New persisted setting `autoQueueEnabled` (default ON), restored with the other queue settings.
- OFF: clear the auto section immediately (one write), suppress replenish and rebuild, and keep the
  queue exactly equal to the user section. Turning it back ON rebuilds the pool under D7's reset
  rules.
- The toggle lives in the Auto panel of the queue (optionally mirrored in Settings → Playback).
  With auto off and a non-empty user queue, the queue shows a quiet "Auto queue off" state instead
  of the suggestion header; it must not render an "empty because of filters" warning.

### D10 — A skip is exactly one row

- `next()`/`previous()` MUST advance exactly one row per press, independent of load timing.
- The manager carries an explicit "the anchor is ahead of the audio" fact (pending target id),
  set when an advance positions the anchor and cleared when `currentTrack` reaches that row.
  `advanceTargetIndex` treats the pending state as a normal advance, never as "the active row was
  removed". A real removal still uses the positional rule (B2/B5).
- `playTrackAt` resets the fact to its own target (a positional pick supersedes an in-flight skip).

### D11 — Drag moves the row you grabbed

- `planDragDrop` / `applyDragDrop` operate on the source occurrence (section + index at drag start).
- Reconciliation against a live queue that changed mid-drag uses per-id occurrence counts: a planned
  row is kept only while a live occurrence is available, and live rows the plan never saw are
  appended in live order. This subsumes the old id-based reconciliation.
- Closing this closes G5: no drop ever moves a different row than the one dragged.

### D12 — Bulk import contract (`playAll`)

- Preserve the source order and duplicates verbatim (the queue can represent both now).
- Resolve ids against the library; unresolved entries are dropped from the queue and reported
  (count + reviewable list), never silently discarded.
- Zero resolved entries → no playback, no `activeIndex: 0` on an empty queue; show the report.
- The import never mutates its source (server playlist, file).
- A partial local library (still loading) must warn or defer rather than silently drop ids that are
  merely not loaded yet.

### D13 — Restore and library reconcile keep occurrences

- Restore no longer dedupes either section. The stored anchor is kept (bounds-checked), because with
  no dedupe the stored index is exact.
- A library sync prunes unknown ids and recomputes the anchor by **count**: subtract the rows removed
  above the old index; if the audible occurrence itself vanished, anchor becomes −1. Re-anchoring by
  `indexOf(id)` would land on the wrong copy once duplicates exist.

### D14 — The played pile grows, intentionally

- The user section grows one row per play. No automatic cap or trimming.
- The user can clear it three ways (clear queue, clear above the anchor, clear below the anchor);
  those affordances stay.
- Accepted cost: the persisted queue and the native snapshot (`setQueue` ships every row) grow with
  session length. The queue view is virtualized, so rendering is unaffected.

## 3. Decision ledger

| # | Decision | Rationale |
| --- | --- | --- |
| 1 | Press a song = start that song; remove its auto copy; append a user row (2026-10-21) | Jumping to an old copy contradicts "play this"; auto copies are suggestions, and the fill cools played songs. |
| 2 | User-queue duplicates allowed; + always appends | The queue is a log of what was played/queued, not a set. |
| 3 | Auto duplicates only when a refill can add nothing new | Filling to 50 immediately would produce ~16 copies of each song in a 3-song pool. |
| 4 | Row identity = occurrence (keys, remove, drag, native entry id) | Duplicates make id-only identity ambiguous; G5 was the visible symptom. |
| 5 | Filter/sort edit = promote + reset recents + full rebuild | A rule change is a fresh context; the old kept-prefix update is what let G1/G2 exist. |
| 6 | Auto-off clears the tail immediately | Repeat-all and "end of queue" must mean what they say right away. |
| 7 | loop-one = loop the song; manual Next at the tail loops it too | "Loop one" is unambiguous; the mode should not depend on how the song ended. |
| 8 | Manual Next at the tail: wrap (all), stop (none), no-op for Previous at the first row | Matches user expectation for Next; Previous restart/wrap is too inconsistent to promise. |
| 9 | Auto-off ≈ a filter matching nothing | Both are "the suggestion source is empty", so repeat-all has one definition. |
| 10 | Played pile uncapped | Intentional log; clearing is a user action, and there are multiple affordances. |
| 11 | Shuffle does not reset recents | It reorders the same rule set; only filter/sort changes are fresh contexts. |
| 12 | Playlist v1 = server playlists + queue export; file import deferred | The server is cross-device and has no path-matching problem; files need the review UI first. |

## 4. Consequences and accepted trade-offs

- **Recents reset is user-visible.** After a filter or sort change, songs heard minutes ago can come
  straight back. That is the requested behavior ("fresh context"), not a regression.
- **The queue can show the same title several times** — in Up next (plays/replays) and in Auto
  (exhausted pool). The occurrence keys make this renderable and independently removable.
- **Native entry ids change shape.** Older JS snapshots cannot occur (JS supplies the ids); Swift
  treats them as opaque strings. No migration.
- **Restore is simpler but not backward-compatible with dedupe assumptions.** A legacy persisted row
  that already contains duplicates is now legal and will be restored as-is.
- **The auto queue can no longer be "starved" by filters.** It is either filled (unique or repeated)
  or the filter matches nothing — no third, half-full state caused by the cool-down window.
- **The matrix's uniqueness rows become obsolete.** A1–A9, A5/H2, E2/E4, J2–J3 and B11 must be
  rewritten (not deleted) in the implementing commits.

## 5. Code inventory (what will change; no code written yet)

| Area | File | Work |
| --- | --- | --- |
| Mutation algebra | `src/lib/queueMutation.ts` | Append semantics, occurrence ids, no dedupe/`uniqueFirst`, drag by occurrence, positional remove (already), remove the duplicate DEV assert |
| Manager | `src/lib/queueManager.ts` | `addToUserQueue` append, `playTrackById` no-jump path, promote-before-rewrite, fresh-context rebuild (reset recents), repeat pass, auto-off gate |
| Fill planner | `src/lib/autoQueuePlan.ts` | Repeat pass input (or manager-level cycling), keep tiers/shuffle/rotation semantics |
| State | `src/stores/appState.ts` | Restore without dedupe; count-based reconcile; `autoQueueEnabled` persisted store |
| Playback | `src/lib/playbackManager.ts` | Pending-target fact (D10), Next/Previous tail rules, auto-off interaction, snapshot entry ids, promotion timing |
| View | `src/views/QueueView.svelte` | Occurrence keys, row-scoped remove, drag source index, auto-off state + toggle |
| Transport | `src/lib/playbackCore/nativeTransport.ts`, `src/lib/nativePlugin.ts` | Entry-id format only (types already tolerate strings) |
| Docs | `docs/QUEUE-INVARIANTS.md`, `AGENTS.md`, `DEVLOG.md` | Rewrite affected rows, anchors and rules in the same commits |

No Swift change is expected for D1–D14. The native engine consumes snapshots and echoes entry ids.

## 6. Implementation order (each step gates on check + tests)

1. **Row identity + duplicates foundation — LANDED 2026-10-21c.** Occurrence ids (`src/lib/queueOccurrence.ts`),
   `u-<id>#<n>` keys, row-scoped remove/reorder/promote, drag by `queueEntryId` with per-id count
   reconciliation (G5 closed), raw-pass-through restore, count-based library reconcile, native
   `queueEntryId` per row, uniqueness asserts removed. Pins: `tests/queueOccurrence.test.ts` (new),
   `tests/queueMutation.test.ts`, `queueRestore`, `queueBulkImport`, `queueManagerFill`;
   browser `queueRows` (duplicate-rows spec), `queuedragdup` (three copies). Unit 1406, e2e 64,
   ui-review 8, `npm run check` 0/0 — all green.
   Two step-1 leftovers recorded on purpose: `promoteActiveTrack` still MOVES one existing user copy of
   the promoted id to the boundary (D5 removes that in step 2), and `refreshQueue` re-sends full rows, so
   Swift keeps entry ids it already had.
2. **Press semantics — LANDED 2026-10-21d.** `queueMutation.pressTrack` + `queueManager.selectTrack`:
   a library/album/artist/detail press drops the id's auto occurrence(s), appends ONE user occurrence,
   anchors it and cools the previous row; the audible row resumes without cloning. Promotion is
   append-only (D5) and "Play next" inserts a copy instead of relocating one. The crossfade reconcile
   now carries the armed row's `targetEntryId` (+ `userLength`) and resolves that exact occurrence;
   manager-level pin: "crossfade reconcile uses the ARMED occurrence, not the first copy of the song",
   pure pins in `tests/crossfadeReconcile.test.ts`. Browser: `queueRows` D1 press spec, `queuedragdup`
   cross-section drag restored. Deliberately NOT done: D2's SHOULD-drop of an auto copy on `+` (still
   open in the design, so the code does not guess).
3. **Skip exactness — LANDED 2026-10-21e (G3 CLOSED).** `appState.pendingAdvanceTrackId` carries the
   "anchor is ahead of the audio" fact (set by `advanceTo`, `playTrackAt`, `selectTrack`; cleared by
   `setCurrentTrack`), and `advanceTargetIndex` reads a matching anchor as a transition instead of a removal.
   Pins: `playbackManagerNav` (two presses = two rows; duplicate copies advance by ROW; a stale fact never
   masks a removal), the browser `queueRows` "two Next presses skip two rows", and the queueMutation resolver
   table. Recorded side effect: an unresolvable id no longer re-targets itself on the next advance (the first
   advance still resolves null and the caller stops) — G4's remaining shape is the missing validation.
4. **Fresh context — LANDED 2026-10-21f (G1/G2 CLOSED).** `queueManager.rebuildForFreshContext` is ONE
   write: promote the audible auto occurrence (the same reducer the post-load path uses), clear
   `recentTrackIds`, rebuild with `keepAuto: false`, rotate after the anchor (now a user row). The
   PlaybackManager's `_scheduleRuleChange` coalesces a filter edit and a sort pick from the same task into
   that one write (250 ms trailing for typing, 0 ms for a sort pick) and compares filter VALUES before
   scheduling, so the subscribe-time fire cannot wipe a restored window. `replenishAutoQueue` keeps its
   kept-prefix rule for the per-advance fill and `rebuildAutoQueue` remains the shuffle toggle.
   Pins: `queueManagerFill` (promote-first, last-row anchor, sort-after-promote, the real subscription
   path, the window surviving a shuffle toggle), `playbackManagerRestore` (subscribe-time guard), browser
   `queuefresh` (a widened filter re-derives the tail while the audible row stays the anchor).
   Rewritten matrix rows: B1, B11, E4, E9, D6a/D6b, V7; §13's G1/G2 are CLOSED sections.
5. **Tail rules + auto-off (D8/D9) — LANDED 2026-10-26.** `appState.autoQueueEnabled` (persisted,
   restored in `initStores`); `queueManager.setAutoQueueEnabled` clears the tail in ONE write (promoting
   the audible auto row first, so clearing can never delete the playing song), gates every fill entry
   point (`replenishAutoQueue`, `rebuildAutoQueue`, `rebuildForFreshContext`) and rebuilds on the
   off→on edge. `playbackManager.next()` at the tail wraps (all) / restarts (one) / stops (none);
   `prev()` at the first row is a no-op in every mode (>3 s still restarts). The QueueView carries the
   switch and the quiet off-state, and never the filter warning while off. `playAll` validates against
   the library and returns a `BulkImportReport` (D12/G4 CLOSED). Pins: `queueManagerFill` (off clears in
   one write, no entry point refills, on rebuilds fresh, the audible auto row is promoted first),
   `playbackManagerNav` (the three Next-at-tail cases + Previous no-op), `queueBulkImport` (drop +
   report, defer while loading, empty import is a no-op), browser `autoqueueoff`.
6. **Repeat pass (D6) — LANDED 2026-10-26.** Pure `autoQueuePlan.planRepeatPass` cycles the section a
   fill just built until the vacancies are filled (balanced from the head, never inventing a row);
   `QueueManager._materializeAuto` is the ONE place kept + unique fill + repeats is composed, so
   replenish, the shuffle rebuild and the fresh-context rebuild cannot disagree. `wrapNotice` is
   unchanged; `autoQueueEmptyNotice` now means exactly "the filters match nothing". Pins:
   `autoQueuePlan` (the pure cycle), `queueManagerFill` (kept+fill cycles, notice semantics, content-
   compared no-op guard), `queueContinuation` (a hands-off session still hears every eligible id before
   any repeat), browser `queuefresh` / `autoqueueadded` (unique head order).
7. **Playlists (§7)** — server API layer, sheet, Play/Add, save-as, report + review.
8. **Native pause bug (§8) — LANDED & CLOSED FOR DEVELOPMENT (2026-10-22/23, `80d6adc`, `ba94fb8`).** Authoritative intent, shared command/publication path, and unconditional user-Pause output-graph pause shipped in 1.2.65–1.2.67, passed iOS CI (`swift test` + `xcodebuild` through 1.2.71), and confirmed on hardware.

Steps 1–2 are the risky foundation: every later rule assumes occurrence identity. Do not start
playlists before step 6 lands.

## 7. Playlists — planned, boundary-safe

### 7.1 Scope

- **v1 (agreed):** Navidrome/Subsonic **server playlists** plus **queue export**. No local playlist
  store, no playlist cache, no file import yet.
- **Deferred:** M3U/M3U8/PLS file import (needs the path-matching table and the review UI), local
  offline playlists.
- **Independent:** saved filter/sort presets (Phase 3A) are a pure local store and never touch the
  queue.

### 7.2 Server facts (verified from docs/source, no live server contacted)

- `getPlaylists` lists visible playlists; `getPlaylist` takes `id`; `deletePlaylist` takes `id`.
- `createPlaylist` without `playlistId` creates (needs `name`); with `playlistId` it **replaces the
  playlist's tracks wholesale** (the `name` argument does not rename it).
- `updatePlaylist` is incremental: repeated `songIdToAdd` appends, `songIndexToRemove` removes
  zero-based indexes; it cannot reorder or replace.
- Repeated `songId` parameters are supported, and Navidrome **retains order and duplicates**
  (playlist entries carry a sequential position).
- Visibility: a non-admin sees their own + public playlists; admins see all. Mutations require
  ownership or admin. A private foreign playlist reads as **code 70** (not found); a found-but-
  forbidden mutation reads as **code 50**. Both are Subsonic error codes in an HTTP 200 body.
- No documented playlist size limit. Go's default 10,000 query-parameter cap can reject a very large
  repeated-`songId` request; batch or use `updatePlaylist` chunks for huge exports.
- Navidrome's own M3U support (`AutoImportPlaylists`, default on) is **file → server, one-way**; a
  synced playlist is read-only in Navidrome. It also has a CLI export. Useful as an interoperability
  fact, not as our import mechanism (a web client cannot write the server's music folder).

Sources consulted for this section (2026-10-21 review, no live server): the OpenSubsonic endpoint
pages for `getPlaylists` / `getPlaylist` / `createPlaylist` / `updatePlaylist` / `deletePlaylist` and
its error table (https://opensubsonic.netlify.app/docs/), Navidrome's playlist CLI docs
(https://www.navidrome.org/docs/usage/admin/cli/pls/), configuration options
(https://www.navidrome.org/docs/usage/configuration/options/), and
`persistence/playlist_repository.go` (https://github.com/navidrome/navidrome). Format facts: XSPF v0
(https://ftp.osuosl.org/pub/xiph/websites/xspf.org/xspf-v0.html), the M3U de-facto summary
(https://en.wikipedia.org/wiki/M3U), and Microsoft's legacy ASX/WPL pages. Navidrome's known M3U
matching failures (backslashes, percent-encoding, Unicode normalization) are tracked in its issues
#3511 and #4663.

### 7.3 Boundary decisions (updated for duplicates)

| Decision | Rule |
| --- | --- |
| Export scope | The user queue, verbatim (played pile included), optional "from the current row". Never the auto tail. |
| Overwrite semantics | Create when no id is stored; later saves reuse the id. Offer explicit **Replace** (create+id) and **Update** (updatePlaylist) so a save cannot silently drop server-side rows. |
| Duplicates / order | Import preserves both. (The old "collapse to first occurrence" rule existed only because the local queue could not represent duplicates; D3 removes that constraint.) Export writes the queue verbatim. |
| Missing tracks | Resolve against the library at play/enqueue time, keep the surviving order, drop unresolved entries, report the count and offer the review list. Never rewrite the server playlist. |
| Server unavailable | No local cache in v1; show the honest offline/error state with retry. The local queue keeps working. |
| Playlist-id migration / not found | Code 70 → clear the stored id, tell the user, require explicit re-create. Never auto-recreate. |
| Read-only playlists | Render without edit/delete affordances; a mutation surfaces code 50 instead of pretending. |
| Empty / partial import | Zero resolved → no playback and the report. Library still loading → warn or defer; do not drop ids that are merely not loaded. |
| Auto queue interaction | "Play playlist" replaces the user queue (existing `playAll`) and clears auto. With auto off, the playlist ends at its last row (repeat-all then repeats the playlist); with auto on, suggestions continue. State this in the Play action's copy. |

### 7.4 Import report UX

- Result line: `38 of 42 tracks added · 4 unavailable`, plus **Review**.
- Review modal lists each unresolved entry: raw reference (path or title/artist when known) and a
  reason (`not in library`, `ambiguous`, `library still loading`). Copyable. ModalShell pattern; no
  full-screen overlay.
- For a server playlist the raw reference is the server entry (title/artist/id); for a future file
  import it is the raw line from the file.

### 7.5 Playlist files (deferred, researched)

| Format | Fit | Plan |
| --- | --- | --- |
| M3U / M3U8 | Ordered paths/URLs, optional `#EXTINF` duration+title, duplicates by repeated lines. No formal general spec; `.m3u8` = UTF-8 | Primary import/export later; export as UTF-8 `.m3u8` with a chosen relative root |
| PLS | INI-style `FileN`/`TitleN`/`LengthN`, ordered | Compatibility import |
| XSPF | XML `<location>` URIs + title/duration (ms), explicit order | Optional import (VLC exports it) |
| ASX / WPL | Windows Media era; WPL proprietary; docs marked legacy | Skip |
| CUE | Tracks inside one long file (album image) | Out of scope |
| Apple XML | Ties to an iTunes library's own track ids | Skip |
| Navidrome `.nsp` | Rules for a dynamic playlist, not a list | Not our model |

Matching strategy for a file import: normalize separators (backslashes), percent-decode, Unicode
NFC/NFD and case-fold; try relative-to-playlist, configured library root, full path, then basename;
fall back to title/artist/album/duration scoring with the existing evidence threshold; report
ambiguous rather than guessing. Known real-world failures: different roots/mounts, Windows paths on
Linux, URL-encoded names, Unicode normalization mismatches, missing files — Navidrome's own importer
has documented issues for all of them.

Import path when it lands: read the local file → resolve → play or create a server playlist through
the API. The server stays the store of record; the file is transport.

## 8. Native iOS pause bug (CLOSED FOR DEVELOPMENT — shipped 1.2.65–1.2.67, CI & device confirmed)

The current report is more precise: app or AirPods Pause stops audio, but the system still displays
Pause; accessory resume does nothing; one lock-screen press repairs the displayed state and the
next starts audio. The earlier attempted fix did not resolve this. Bluetooth hardware trouble is
separate and excluded.

**Authoritative investigation, shipped implementation and device confirmation:**
[field-reliability register §3](plans/2026-10-22-field-reliability-and-push-diagnostics.md#3-native-control-investigation).

The 2026-10-22/23 implementation (`80d6adc`, `ba94fb8`) landed authoritative intent (`PlaybackControl.swift`),
source/timer ownership, shared bridge/remote publication (`NowPlayingPublication.swift`), and unconditional
output-graph pause on accepted user Pause (`AudioEngine.pause()`). It shipped in 1.2.65–1.2.67, passed all
iOS CI gates (`swift test` + `xcodebuild` green through 1.2.71), and was confirmed on hardware (both the
1.2.66 switch A/B and the 1.2.67 unconditional build). Closed for development purposes.

## 9. Non-goals

- A third queue section, a local playlist store, or playlist-driven queue filtering.
- Automatic history trimming or a queue-length cap.
- Bidirectional playlist file sync (Navidrome's own file sync is one-way).
- Changing the shared library sort/filter semantics; the auto queue stays decoupled.
- Reworking crossfade/native scheduling beyond the skip fact (D10).

## 10. Open items carried forward

1. `+` dropping the id's auto occurrence — default is drop, confirm with the first implementation.
2. Auto-off toggle placement (queue Auto panel vs. also Settings → Playback) — implement in the
   panel first; mirror only if it feels hidden.
3. Playlist "Replace" confirmation copy (destructive) — needed when the action lands.
4. M3U import scope (which formats in the first file-import cut) — after v1 playlists.
5. Native pause fix — **closed for development** (`80d6adc`, `ba94fb8`, shipped 1.2.65–1.2.67, iOS CI + on-device A/B & unconditional confirmation in the [October 22 register](plans/2026-10-22-field-reliability-and-push-diagnostics.md)).

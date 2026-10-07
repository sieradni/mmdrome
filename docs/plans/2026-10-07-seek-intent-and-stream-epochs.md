# Seek Intent & Stream Epochs (2026-10-07)

**Status**: Phases 0–2 implemented + pinned, plus the transfer-ladder HOLD half of the
deferred cross-row item (2026-10-07; JS suite 1262/1262 and svelte-check green, Swift
cores/engine await CI). Phases 3–4 not started; cross-row PREEMPTION and same-row
supersession remain deferred (§6). This document is the single source of truth for the
work; every phase below is independently shippable and every phase's failure mode
degrades into Phase 1 behavior.

**Origin**: two field reports, investigated and root-caused the same day.
1. Playing after seeking into an unloaded region sends playback back to 0:00.
2. The playhead is not prioritized when streaming: a forward seek waits for the entire
   prefix of the stream to arrive, so "play from the middle" means waiting the length
   of everything before it.

**Related**: A15 native streaming (`docs/plans/2026-09-21-native-streaming.md`),
A12/A14 web engines, A5 retry policy, A9/A11 scrobbling, E5 CI Swift tests.

---

## 1. Verified ground truth

Everything in this table was read out of the source during the investigation
(2026-10-07). When touching a referenced symbol, verify the anchor and fix this table —
a plan with dead anchors is worse than no plan.

### 1.1 The reset-to-0 chain (native, staged streaming)

| # | Fact | Anchor |
|---|---|---|
| 1 | `seek(to:)` calls `cancelScheduled()`, sets **`hasLiveSchedule = false`**, writes `positionBias`/`cachedPosition = target`, then re-schedules from the target. | `native/BackgroundAudio/ios/AudioEngine.swift` `seek(to:)` |
| 2 | The staged branch of `scheduleCurrentTrack` refuses a target past the delivered end (`StreamSchedule.canSchedule` = `endFrames > startFrame`), then sets `isStalled` / `stalledAtFrames` / `cachedPosition` / `setPlaying(false)` and **returns without restoring `hasLiveSchedule`**. | `scheduleCurrentTrack(from:autoPlay:)`, staged path |
| 3 | `play()` tests **`if !hasLiveSchedule { loadAndStart(...); return }` BEFORE** the staged-stall resume branch, so a play tap in the buffering state restarts the row. | `play()` |
| 4 | `loadAndStart` writes `positionBias = 0`, `cachedPosition = 0`, and calls `teardownStagedState()`. | `loadAndStart(currentIndex:autoPlay:)` |
| 5 | Consequence: the staged-stall resume branch is **dead code for seek-induced stalls** (it is reachable only for completion-induced stalls, which keep `hasLiveSchedule` true — `enterBufferingStall` does not clear it). | `enterBufferingStall(atSeconds:)` |
| 6 | A seek landing **before the first staged schedule exists** (`stagedSchedule == nil` or `stagedSourceURL == nil`) skips the staged branch entirely, takes the normal path, finds no `loader.localURL`, and calls `onError("Track not ready")` → JS retry → reload from 0. | `scheduleCurrentTrack`, normal path |

### 1.2 The same bug class in the JS layer

| # | Fact | Anchor |
|---|---|---|
| 7 | **No pending-seek memory exists anywhere in JS.** Three load paths unconditionally `currentTime.set(0)`. | `src/lib/playbackManager.ts` (`_nativeLoadPlay`, `_loadAndPlay`, `_bgLoad`) |
| 8 | Web `seek()` drops the requested time entirely when `el.src` is unset — it calls `play()` instead. | `playbackManager.seek()` |
| 9 | A native seek issued before `engage` resolves is lost; the only replay mechanism is the retry-reload `_seekMemory`, which is scoped to error retries, not to load latency. | `src/lib/playbackCore/nativeTransport.ts` |
| 10 | Native seeks are cadence-limited at 150 ms while a drag is held — `SEEK_THROTTLE_MS` in the pure core. | `src/lib/playbackCore/seekThrottle.ts` |

### 1.3 Why the seek is slow

| # | Fact | Anchor |
|---|---|---|
| 11 | The staged writer appends server bytes **head-first from byte 0**; the schedule may only promise up to the delivered end. A forward seek therefore waits `(targetByte − deliveredByte) / bandwidth`. | `TrackFileLoader.streamLoad`, `StreamSchedule.stagedEndFramesEstimate` |
| 12 | Only ONE writer runs at a time; `streamDecision` returns false whenever any writer is active. | `TrackFileLoader.streamDecision(for:)` |
| 13 | `prefetch` **chains onto an active writer for the same cache key** rather than racing a second transfer — which is why the restart bug does not duplicate bandwidth, it just restarts the row. | `TrackFileLoader.prefetch(_:completion:)` |
| 14 | Same-row supersession substrate already exists: deliberate-cancel flag, handler silencing, `.part` retention, `pendingParts` Range continuation. | `cancelActiveWriterRetainingScratch()`; `continuationEligible(writer:deliberateCancel:)` |
| 15 | Streaming policy constants: minimum lead 15 s, extension bar 5 s, stall resume margin 2 s, stall give-up 10 s, writer delivery rung 512 KB. | `StreamPolicy`, `StreamSchedule` (BackgroundAudioCore) |

### 1.4 Server capability (no offset for raw, offset for transcodes)

Verified against Navidrome master source, not from memory:

| # | Fact | Evidence |
|---|---|---|
| 16 | The Subsonic `stream` endpoint reads a **`timeOffset`** query parameter (integer seconds) and passes it as `Request.Offset`. | `server/subsonic/stream.go`; `core/stream/types.go` |
| 17 | A transcode job's cache key **includes the offset**, so each offset is its own cached job; a piped FLAC output gets its duration patched by `Duration − Offset`. | `core/stream/media_streamer.go` (`streamJob.Key()`, `patchFLACDuration`) |
| 18 | The offset is applied as a **pre-input seek** (`-ss <offset>` before `-i`) for both the default dynamic args and custom command templates (`%t` token or an injected pre-input `-ss`). | `core/ffmpeg/ffmpeg.go` (`buildDynamicArgs`, `createFFmpegCommand`) |
| 19 | **`format=raw` ignores the offset** — the raw path opens the file and serves `http.ServeContent` over the original bytes. | `media_streamer.go`, raw branch |
| 20 | **A request the decider resolves to direct play also ignores the offset**, including an explicit format equal to the source codec. | `core/stream/legacy_client.go` (`buildLegacyClientInfo` adds a direct-play profile when `reqFormat == mf.Suffix`; `resolve()` sets `req.Format = "raw"` on `CanDirectPlay`) |
| 21 | `estimateContentLength` is computed from the **full** duration regardless of offset, so an offset stream announces more bytes than its body carries. Epoch byte-ratio math must be epoch-relative. | `media_streamer.go` (`EstimatedContentLength`) |
| 22 | A **completed/cached** transcode is seekable and is served through `http.ServeContent`, i.e. it reports `Accept-Ranges: bytes`. The non-seekable branch sets `Accept-Ranges: none`. | `media_streamer.go` (`NewStream` sets `s.Seeker = r.Seeker`; `Serve()` branches on `Seekable()`) |
| 23 | `X-Content-Duration` is the **full** track duration on every response, including offset streams — useless as an offset verdict. | `stream.go` header set from `Stream.Duration()` |

### 1.5 Client container facts

| # | Fact |
|---|---|
| 24 | `AVAudioFile(forReading:)` cannot open a mid-file slice: the decoder needs the container's front matter (FLAC STREAMINFO, Ogg codec id/setup pages, MP4 `moov`). A byte-range slice is therefore not automatically schedulable. |
| 25 | FLAC frame header: 14-bit sync `0x3FFE`, then **reserved bit (must be 0)**, then blocking-strategy bit — so byte 1 after `0xFF` is `0xF8` or `0xF9` only. The coded number is the **frame number when blocking strategy = fixed**, the **sample number when variable**. CRC-8 covers the header. |
| 26 | FLAC STREAMINFO is a fixed 34-byte block carrying 36-bit `total_samples` and a 128-bit MD5 (zeroed ⇒ unset). Rewriting it preserves every downstream offset. |
| 27 | Ogg page `granule_position` is the time of the page's **last completed sample**; the first packet's anchor requires summing packet durations (Opus TOC / Vorbis mode blocks) plus Opus pre-skip. |
| 28 | MP3 (Xing/VBRI TOC): byte offsets exist, but the TOC's time axis is an approximate 1 % grid, so a locally counted frame anchor inherits up to ~0.5 % of the track as base error (~2.4 s on an 8-minute file). |
| 29 | `kAudioFileEndOfFileError = -39`; `kAudioFileFileNotFoundError = -43` (a fixture-path bug, NOT a parse verdict). Parse rejections surface as four-char OSStatus values (`'typ?'`, `'dta?'`, possibly `'chk?'`). |
| 30 | `Track.fileType` is the raw lowercased Subsonic `suffix` (i.e. Navidrome's `mf.Suffix`), and `Track.bitrate` is optional — both are the static capability-layer inputs. | `src/lib/navidromeApi.ts` (`deriveFileType`), `src/stores/appState.ts` |

---

## 2. Design

### 2.1 The one-sentence model

> A playback position is an **intent**; a stream is a **window around the playhead**,
> carried by a **source with a timeline base** — never a prefix fetched from byte 0.

### 2.2 The coordinate invariant

```
absoluteSeconds = timelineBase + localSeconds
```

- Local render coordinates (`AVAudioPlayerNode` sample time, `AVAudioFile` frame
  indices, epoch-relative byte positions) never leave the engine's schedule layer.
- **Assignment sites that must add the base** (the complete list):
  `scheduledSegmentSeconds` in `scheduleCurrentTrack`'s normal path, and
  `staged.scheduledEndFrames` / the staged end passed to `StreamSchedule` in the
  staged path.
- **Consumers that need no change** because both sides are already absolute:
  `deadAirAdvanceEligible`, `shouldResumeAfterStall`, `isStallImminent`,
  `DownloadSanity.completionEvidence`, the seek clamp. Do not "fix" them.

### 2.3 Playback intent (the Phase-1 fix)

One latch, `{ trackId, position, generation }`, latest-wins:

- JS owns the latch (`src/lib/playbackCore/seekIntent.ts`); it survives source
  assignment, engage latency, and bg handoff.
- Every load path consumes it instead of writing 0.
- The engine owns an equivalent `intentPosition` and a `pendingSeekSeconds` for seeks
  that arrive before any schedule can be made.
- **`play()` must consult the staged/epoch state BEFORE `!hasLiveSchedule`.** This is
  the literal root cause; the order is now pinned by a pure core so it cannot regress.
- `loadAndStart` is legitimate only when there is no source for the row at all. A
  same-row play with a live stalled/epoch state is a no-op plus a log line.

### 2.4 Epochs

Ephemeral, self-contained sources with a timeline base. Epoch 0 is the ordinary
head-first stream (base 0, unchanged behavior). A far seek opens epoch *n* at the
target.

```
SeekSource (descriptor only — the ENGINE owns every AVAudioFile open)
  url              local file for this epoch (the growing .part or a splice file)
  timelineBase     absolute seconds of this file's frame 0
  expectedFrames   honest end for the scheduler (epoch-local, plus base externally)
  isRaw            direct-play/raw source (affects promotion eligibility)
  cancel()         release the transfer; does NOT delete retained prefix state
```

Source kinds, in preference order:

| Kind | When | Timeline fidelity |
|---|---|---|
| `TimeOffsetSource` | The stream carries transcode params and the static/runtime capability says the server will re-encode from an offset. | ≈ T (pre-input `-ss` is frame-accurate in practice; document a tolerance) |
| `SplicedRangeSource` | Raw stream, Range-capable server, container has an **exact in-band anchor** (FLAC; Ogg after fixture proof). | Exact T (container-carried) |
| `WaitSource` | Everything else — including MP4/M4A, MP3, ADTS, offset-ignored responses, and short estimated waits. | Exact T (intent preserved; position-preserving buffering) |

### 2.5 Capability declaration (JS declares, native executes)

The snapshot carries a per-row capability derived from the SAME transcode decision
that built the URL. No new bridge method — it rides the existing
`setQueue`/`refreshQueue` payload, so there is no `pluginMethods` registration risk.

```ts
interface SeekCapability {
  canServerOffset: boolean          // server will re-encode from an offset
  clientSplice?: 'flac' | 'ogg'     // container proven splice-safe (fixture-gated)
  paramName?: 'timeOffset'
  sourceBitrate?: number            // for the direct-play prediction
  sourceFileType?: Track['fileType']
}
```

Static rule (must never cost correctness):

- `canServerOffset = false` when the prediction is **certain**: requested format
  equals the source suffix AND the requested bitrate cap is known to be ≥ the source
  bitrate (direct play ⇒ offset ignored).
- Otherwise `canServerOffset = true` and the runtime verdict is the authority.
- **Rationale**: a false "can" costs one wasted request that the runtime verdict
  demotes after a single header read; a false "cannot" costs latency on every seek of
  that row. `Track.bitrate` is optional, so a strict "err toward cannot" rule would
  silently disable epochs for every untagged row.

### 2.6 Runtime verdict (the direct-play trap)

Primary signal: **the epoch container's own claimed length** at the existing
first-schedule open boundary.

```
openedFrames ≈ duration − T   → offset HONORED      → timelineBase = T
openedFrames ≈ duration       → offset IGNORED      → rebase (below)
```

- CORS-immune, platform-agnostic, readable on both platforms, and lands **before
  audio enters the graph**.
- `Accept-Ranges` is **corroboration only**: a completed/cached transcode is served
  through `ServeContent` and reports `bytes` (fact 22), and the header is not
  CORS-safelisted, so the webview cannot read it (an established repo lesson). Never
  branch on it alone.
- **Fail-safe is a rebase, never a snap to 0**: `timelineBase = 0`, intent latch stays
  armed at T, audio continues linearly and the latch fires when the delivered window
  reaches T. The UI stays pinned at T in a buffering state.
- Optional refinement (only if byte accounting shows it matters): a rebased raw epoch
  is byte-identical to the row's own head-first transfer, so it may be *adopted* as
  the row's canonical transfer instead of discarded.

### 2.7 Cache quarantine (never promote an epoch artifact)

- Invariant: only contiguous transfers starting at byte 0 with a verified total
  length are eligible for promotion into the row's cache entry.
- Epoch transfers write to an isolated namespace
  (`<trackId>.<variant>.epoch-<epochId>.part`) and are **excluded from
  `servingURL`'s permissive variant matching** — otherwise a later normal play of the
  row could serve a stream that starts at T (silent wrong audio).
- Lifecycle: removed on epoch supersession, on `evict(trackId:variant:)`, at boot by
  `prunePhantomResumeState()`, and excluded from the 1 s sampler's row-progress feed
  (an epoch's bytes are the *tail* of a raw file; feeding them as row progress would
  drive the queue tint and seek-bar loaded layer with a meaningless percentage).

### 2.8 Same-row supersession (in scope) vs cross-row ladder (deferred)

- Starting an epoch on the current row supersedes that row's own writer, using the
  existing mechanism in the existing order: set `deliberatelyCancelledWriterKey` →
  nil the three handler closures → `task.cancel()` → let the delegate completion
  record `pendingParts`/`accumulatedBytes`. **Do not** record the resume offset by
  hand before cancelling; the delegate's count is authoritative.
- The epoch must NOT go through `streamDecision`/`streamLoad`'s single-writer guard
  (fact 12) — it needs its own entry point.
- The deferred cross-row ladder (prefetch preemption) is a separate plan; see §6.

### 2.9 Raw splice mechanics (Phase 3, fixture-gated)

Pipeline for an anchor-bearing container:

1. **Hint** (locality only): index-derived byte offset when available
   (FLAC SEEKTABLE), else mean-bitrate estimate; then
   `hint = max(hintFromIndex, endOfId3v2)` where `endOfId3v2` is the synchsafe size at
   the file start (already in the prefix). Fetch from a **hint behind T** by a safety
   margin so the anchor lands at or before T.
2. **Sync**: scan for a CRC-8-validated frame header — FLAC byte pattern is
   `0xFF` + (`0xF8`|`0xF9`), reserved bit zero.
3. **Anchor**: fixed blocksize ⇒ `frameNumber × blockSize`; variable ⇒ `sampleNumber`.
   `timelineBase = anchorSample / sampleRate`. Ogg: parse the page header and sum
   packet durations + pre-skip (Phase 3 stretch; fixture-gated).
4. **Splice**: original metadata blocks (with STREAMINFO `total_samples` rewritten to
   the frames actually present, MD5 zeroed) + the validated slice. Re-write the
   34-byte STREAMINFO at each maturation transition as the window grows.
5. **Window**: bounded Range request sized from the existing lead policy, extended as
   playback advances through the existing chained-segment path — never `bytes=X-` to
   EOF (a scrub multiplies transfers; a 4-hour file would re-download its tail).

Wait-only by definition: MP3 (TOC grid error, fact 28), ADTS/AAC, MP4/M4A (`moov`
describes the whole file's byte layout), anything unproven.

### 2.10 Web

- In scope: the intent latch only, so a seek dispatched before `loadedmetadata`
  (or while `readyState < HAVE_METADATA`) is **captured** and applied once the
  element can accept it; publish/consume the same coordinate the native side uses.
- **Honest limitation**: a mid-track seek into an *in-progress* transcode stays bound
  to server encode progress. No `el.src` re-pointing (breaks `duration`/`currentTime`/
  MediaSession timelines, forces transcodes, risks autoplay policy).
- The web virtual-timeline adapter is a deferred spike with a recorded justification
  (§6).

---

## 3. Phases

Each phase ships independently. Phase 1 fixes the reported bug on its own; Phases 2–3
each end in a state whose worst case is Phase-1 behavior.

### Phase 0 — Capability declaration & schema lockstep

Files: `src/lib/playbackCore/seekCapability.ts` (new, pure),
`src/lib/nativePlugin.ts` (snapshot type), native snapshot decoding in
`BackgroundAudioPlugin.swift`, `src/lib/playbackManager.ts` (`_buildSnapshot`).

Steps:
1. Add the pure capability derivation from `{transcode, fileType, bitrate}` per §2.5.
2. Extend `NativeTrackSnapshot` on **both** sides in one change (the plugin and the
   web bundle ship together; there is no version skew window).
3. Wire it in `_buildSnapshot` from the SAME `_activeTranscode()` decision that builds
   each row's URL.

Tests: `tests/seekCapability.test.ts` — direct-play prediction (format match, bitrate
cap below/above source, unknown bitrate), raw, disabled transcode.

### Phase 1 — Playback intent (fixes the reported bug)

Files:
- `src/lib/playbackCore/seekIntent.ts` (new, pure): latch, generation, latest-wins,
  clear on track change/end/stop.
- `src/lib/playbackManager.ts`: `seek()` latches first; the web `!el.src` branch
  latches instead of calling `play()`; the three `currentTime.set(0)` sites consume
  the latch; re-issue to the transport once the source exists.
- `src/lib/playbackCore/nativeTransport.ts`: generalize the retry-reload `_seekMemory`
  into "any pending intent for the engaged track", re-issued after `_doEngage`
  resolves.
- `native/BackgroundAudioCore/Sources/Core/PlayIntent.swift` (new, pure): the resume
  decision (`resumeStagedStall` before `restartTrack`) so the ordering is pinned.
- `native/BackgroundAudio/ios/AudioEngine.swift`: reorder `play()`; keep the stalled
  state's intent; add `pendingSeekSeconds` applied by `startFirstStagedSchedule` and
  by the normal-path schedule after a download completes; guard `loadAndStart`
  against same-row restarts (log `restart suppressed position=…`).
- Do NOT change: retry policy, prefetch, crossfade, sleep parks.

Tests: `tests/seekIntent.test.ts`; extend `tests/playbackManagerSeek.test.ts`,
`tests/playbackManagerNative.test.ts`, `tests/nativeTransport.test.ts`;
`PlayIntentTests.swift`; the acceptance test in §4.1.

**Implemented (2026-10-07)** — final wiring, and the one ownership call the plan left
open:
- `seekIntent.ts` is armed ONLY when the engine layer cannot take the position at
  issue time (native: the transport is not engaged on that row; web: no `el.src`). A
  deliverable seek is NOT latched, so a later fresh play of the same row still starts
  at 0. `consumeSeekIntent` is single-use and a consume against another row clears.
- The manager's latch is the JS-clock + web-element memory: the three load paths
  consume it (never `currentTime.set(0)`), `_applyWebStartPosition` gates the element
  write on `readyState >= 1`; `_stopPlayback` clears it.
- **Native seek delivery is owned by `NativeTransport`, not by a second manager
  re-issue.** `seek(pos, trackId)` forwards when it is deliverable and otherwise parks
  the latest intent row-scoped; `_replayPendingSeek` fires it after an engage cycle
  settles on ITS row (a non-matching settle leaves it parked — the transport never
  aims a parked seek at a row the user did not scrub). This avoids the plan's
  originally-implied double delivery (manager re-issue + transport replay). The
  manager clears the latch on engage failure so a failed load cannot pin the UI at a
  position no engine will honor.
- Engine side: `PlayIntent` decides resume order; `pendingSeekSeconds`
  (`pendingSeekTrackId`) is applied by `startFirstStagedSchedule`,
  `scheduleStagedFileWhole`, and the prefetch completion; `scheduleCurrentTrack` now
  returns whether the attempt was handled and parks instead of erroring only while
  `loadInFlight` (writer or this row's download); `loadAndStart` suppresses a
  same-row restart when staged state is live.

### Phase 2 — Epoch model + server-offset epochs

**Implemented (2026-10-07)** — the load-bearing decisions, recorded so a later
session cannot re-derive them wrongly:
- **One verdict site.** `resolveStagedPlacement(track:progress:containerFrames:sampleRate:)`
  is the ONLY reader of `StreamEpoch.offsetHonored` and the only writer of a
  timeline base; both first-schedule entry points (`startFirstStagedSchedule`,
  `scheduleStagedFileWhole`) call it before any schedule exists. An epoch that
  cannot demote itself therefore cannot start.
- **Three verdicts, not two.** A container claiming neither the expected epoch
  length nor the full track (`unknown`) is DISCARDED — never scheduled at a
  guessed base. The engine parks the intent at T and hands the row to
  `loadAndStart` (exactly the Phase-1 path).
- **The ignored verdict ADOPTS.** `timelineBaseFrames = 0` + full-track
  `metadataFrames` and the epoch file continues as the row's own source (its
  bytes ARE the head-first body), so the rebase wastes nothing and the intent
  reaches T linearly. The loader still never promotes it.
- **Delivery guards are the ACTIVE ROW, not `seekEpoch != nil`** — an adopted
  epoch's transfer keeps delivering after `seekEpoch` is cleared, and those
  deliveries must still grow the schedule.
- **The epoch flag rides every `StreamProgress`** (including the first-schedule
  retry refresh): losing it would schedule an offset file at base 0 — silent
  wrong-position audio.
- **Kill switch = facade call.** `engine.setSeekEpochs(mode)` is pushed at boot
  AND on the settings value change (the audio-mixing rule); the engine's
  `setSeekEpochsMode` logs the mode and discards a live epoch on `off`.
- **Positioning actor.** The engine emits a `streamEpoch` bridge event; JS
  writes it into the bridge trail via the pure `epochTrailLine`, so a dump can
  attribute a playhead move to the epoch rather than engage/refreshQueue. The
  self-test's `epoch` check FAILS when a first schedule carries a base > 0 with
  no honored verdict.
- **The quarantine key is DERIVED in the pure core** (`StreamEpoch.epochKey` /
  `isEpochKey`, used by the loader's `epochTransfer` and sweep), so "an epoch
  artifact is never the row's cache file" is test-pinned rather than a
  convention (acceptance 6).
- **Transfer ladder, HOLD half (2026-10-07 follow-up).** The pure
  `TransferLadder` (`ownsBandwidth` / `hold` / `mayIssueNextPrefetch`) is the ONE
  derivation for two previously-implicit rules: the prefetch walk never starts
  speculative bytes while a user transfer owns the link (staged stream, seek
  epoch — from the moment its request is on the wire — or the active row's own
  download), and the network re-arm's skip now names the EPOCH explicitly
  instead of leaning on `hasActiveWriter` happening to count epoch writers. A
  COMPLETE staged file is not a bandwidth owner (its writer settled, the file
  plays from disk) — which is why `completeStagedSchedule`'s own arm still
  lands. Every user transfer has a terminal settle edge that calls
  `rearmPrefetchIfIdle`, so a hold is never permanent; the self-test's
  `transfer-priority` check warns when a hold has no resume in the window. The
  settle edge and the network re-arm share ONE arm helper (`armPrefetchWalk`),
  which BUMPS `prefetchGeneration` first: a re-arm that lands while an older
  chain is still walking would otherwise run a SECOND concurrent chain (the
  2026-10-02 double-walk discipline), and the bump costs nothing because the
  loader chains a re-request onto an existing download task. PREEMPTION
  (cancelling an in-flight prefetch) is still deferred — see §6.

Files:
- `native/BackgroundAudioCore/Sources/Core/StreamEpoch.swift` (new, pure):
  `offsetURL(base:seconds:)`, `supportsServerOffset(url:)`, epoch-relative expected
  bytes (§ fact 21), `epochEndableFrames`, `offsetHonored(containerFrames:expectedEpochFrames:trackFrames:)`,
  `epochEndIsTrackEnd(...)`.
- `native/BackgroundAudio/ios/TrackFileLoader.swift`: epoch entry point (bypassing the
  single-writer guard), supersession in the mandated order, epoch scratch namespace,
  lifecycle hooks (§2.7), completion that never promotes.
- `native/BackgroundAudio/ios/AudioEngine.swift`: `StagedSchedule.timelineBaseFrames`;
  the coordinate enforcement clause (§2.2); epoch open/supersede; the runtime verdict
  and rebase; new `stream` events; `getDebugState` epoch fields.
- `src/lib/playbackCore/nativeBridgeTrail.ts`: record the epoch as a positioning actor
  (the trail currently knows only `engage` and `refreshQueue`); otherwise a future
  multi-skip dump will blame the wrong actor.
- `src/lib/playbackManager.ts`: read the new state for the HUD; no URL changes.

Steps:
1. Honor the global `seekEpochs` kill switch (§8): `off` skips every epoch open and
   takes the Phase-1 path, so Phases 2–3 can be disabled in the field without a
   release.
2. Land the runtime verdict and the rebase together with the epoch open — never an
   epoch that can start but cannot demote itself.

Tests: `StreamEpochTests.swift` (math, verdict, tolerance bounds, capability
decode, the derived epoch-key quarantine rule); the trail actor line is pinned in
`tests/nativeBridgeTrail.test.ts` (the transport suite owns delivery, not event
formatting — the plan originally filed it there); `tests/streamVerification.test.ts`
(the epoch verdict fold + the unverified-base FAIL); `tests/seekCapability.test.ts`
(Phase 0); `tests/seekEpochsKillSwitch.test.ts` (default + JS push).

### Phase 3 — Raw splice epochs (fixture-gated)

Files:
- `native/BackgroundAudioCore/Sources/Core/RawSeekIndex.swift` (new, pure): hint
  resolution (SEEKTABLE / mean bitrate / ID3 clamp), CRC-8-validated FLAC sync,
  anchor extraction (fixed vs variable), splice strategy enum, STREAMINFO rewrite.
- Fixture harness: `scripts/gen-seek-fixtures.mjs` (ffmpeg-generated, committed small
  fixtures) + Swift tests reading them.
- `TrackFileLoader.swift`: bounded-window Range epoch writer (no `bytes=X-` to EOF),
  atomic writes (temp + rename), generation-guarded callbacks.
- `AudioEngine.swift`: schedule the spliced source at `timelineBase`; base correction
  from the container anchor; no re-anchor of the UI.

Enablement gate: FLAC enabled when `test_flac_splice_*` passes; Ogg only when
`test_ogg_splice_feasibility` passes (may end permanent wait-only — acceptable).
MP3/ADTS/MP4 never open a splice epoch.

Tests: `RawSeekIndexTests.swift`, `config` and `id3-displacement` fixtures with 0 KB /
10 KB / 4 MB front metadata.

### Phase 4 — Verification, telemetry, docs

**Implemented (2026-10-07)** — item 3 (latency) full, items 1/2 for everything Phase 2
landed, item 4 (docs promotion) done:
- **One seek, one line**: `seek latency id=… target=…s strategy=… decision=…ms
  firstByte=…ms firstSchedule=…ms firstPlayback=…ms total=…ms`, accounted by the pure
  `BackgroundAudioCore/SeekLatency.swift`. NAMING, deliberate: the plan's "first audible
  sample" is realized as **`firstPlayback`** = the node began rendering the schedule
  that covers the target. The device's output buffer is outside the app; it is constant,
  so A/B comparisons still hold, and calling it "audible" would claim a measurement the
  app cannot make.
- **The byte leg can be `*`-inferred**: the plain downloadTask lane exposes no progress
  callback, so a schedule that exists without an observed byte marks the byte leg with
  the schedule time and a trailing `*` (a bound, labeled as one) rather than reporting 0.
- **Probe discipline**: opened in `seek(to:)` BEFORE the schedule attempt (a local seek
  completes its later legs inside that call), same-row only, 60 s lifetime, FIRST mark
  wins (a retry must not inflate a leg); superseded/expired probes log at debug level.
- **`getDebugState`** carries `seekLatency` (last complete line) + `seekLatencyReports`,
  so the field dump and the self-test bundle read the number without parsing events.
- **Self-test `seek-latency` check**: PASS on a complete report (evidence prints every
  leg + the strategy label), WARN when probes exist but none reached playback (a paused
  seek is legitimate), UNKNOWN with none — absence is never a pass.

1. `src/lib/streamVerification.ts`: new check ids (epoch offset honored, raw segment
   decodes, anchor delta) feeding the existing PASS/WARN/FAIL/UNKNOWN table;
   `docs/STREAMING-SELF-TEST.md` update. **Landed: `epoch`, `transfer-priority`,
   `seek-latency` (the T9 scenario in the guide). The raw-segment/anchor checks wait for
   Phase 3 — there is no splice to verify yet.**
2. `getDebugState`: `streamEpochActive/Base/ExpectedBytes/DeliveredBytes/AnchorDelta`.
   **Landed: active/base/target/verdict/count + `streamTimelineBaseSeconds` + the
   ladder (`prefetchLadderHeld`/`prefetchLadderHolds`/`userTransferActive`);
   `ExpectedBytes`/`DeliveredBytes`/`AnchorDelta` are Phase-3 splice fields.**
3. **Latency instrumentation** (serves the stated goal: minimize latency): measure
   seek → audible in four legs (decision, first byte, first schedule, first audible
   sample) and log as a `stream` event, so the improvement is a number, not a claim.
   **Landed — see the implemented block above (`decision`, `firstByte`,
   `firstSchedule`, `firstPlayback`).**
4. `docs/DEVLOG.md` entry; AGENTS.md §4 rules with anchors:
   - "A stalled staged position is a position, not an absence of schedule — do NOT
     reorder `play()` to test `!hasLiveSchedule` first."
   - "Epoch scratch is never promoted and never served by `servingURL`."
   - "Absolute playback coordinates only; epoch sources expose `timelineBase`."

---

## 4. Acceptance criteria

1. **The reported bug**: seek to ~60 % while a track is still loading, press play →
   the position stays at ~60 %; it never becomes 0; the staged/epoch resume path is
   taken (no `restart suppressed` for a same-row play).
2. A seek issued **before the first schedule exists** produces no "Track not ready" →
   reload; the intent position is honored by the first schedule.
3. Web: a seek dispatched before the source is assigned resumes at the requested time
   once metadata exists (no 0:00 restart, no dropped seek).
4. On a transcoded row, a far seek opens an epoch within ~150 ms (the existing seek
   cadence) and time-to-first-audio tracks the *lead*, not the prefix.
5. On an offset-ignored response (raw/direct-play), the verdict fires before audio
   enters the graph, the epoch rebases to base 0, the UI stays pinned at T, and audio
   continues — never a snap to 0.
6. An epoch artifact is never resolvable as the row's cache file; a later normal play
   of that row streams from 0 (pinned test).
7. Containers without a proven anchor never open a splice epoch (MP3/ADTS/MP4 assert
   wait-only).
8. No regression in the existing suites (below).

## 5. Verification

| Check | Command / venue |
|---|---|
| JS unit suite | `npm test` (node --test with the repo loader) |
| Types + Svelte | `npm run check` |
| Web e2e (playback-adjacent specs) | `npm run test:e2e` |
| Swift cores | `swift test` in CI (E5 hosts BackgroundAudioCore on macOS) |
| Spliced-container acceptance | fixture harness (§Phase 3) |
| Server behavior on the real deployment | the extended Stream Self-Test bundle + `docs/STREAMING-SELF-TEST.md` |
| Native runtime behavior | field-dump session (the established loop for engine-only behavior; no simulator audio e2e exists) |

Environment note: the local environment for this document's authoring can run the Node
suite and svelte-check; Swift compilation and the fixture harness run in CI/a macOS
host, and the server-capability checks require a real Navidrome.

## 6. Deferred register (recorded, with justification)

| Item | Why deferred | Prerequisite |
|---|---|---|
| **Cross-row transfer priority ladder** — the PREEMPTION half is still deferred; the HOLD half LANDED 2026-10-07 | Cancellation contaminates failure modes: a cancelled `downloadTask` reads as a row failure today (`gone` tint, retry-branch accounting, a 1.5 s park), so preemption needs the download lane's deliberate-cancel veto — and, per the measurement rule, a number showing the overlap costs first-audio latency. The HOLD half needs none of that and is done: `TransferLadder` (pure) + the walk's hold + the settle re-arm + the explicit epoch ownership for the network re-arm. Also: "one transfer at a time" is currently an intention, not an invariant — `streamDecision` guards per cache key while a prefetch `downloadTask` can run beside a writer. | Preemption: the hold's field data (a slow-link dump) + Phase 4's latency legs |
| **Web virtual-timeline adapter** | Optimization window is self-closing: once the server finishes encoding, the cached transcode is seekable and the browser ranges freely. Blast radius is app-wide (`activeLineIndex`, scrobble thresholds, sleep timer, MediaSession, SeekBar/`bufferMonitor`, preloader semantics) and Mobile Safari requires drag-release-only execution. | A measurement spike on the real deployment; the fixture harness could also settle whether mid-production cache items are seekable |
| **MP4/M4A `stco`/`co64` rewriting** | The `moov` describes the whole file's byte layout; a subset sample table is a real project, and the failing-header-probe case is already an A15 non-goal. | — |
| **Cache stitching** (gap prefix + fetched tail → one complete offline file) | Needed to restore the offline-advance contract after a bounded-window raw epoch. Byte-identical concatenation is feasible for raw, but must handle bounded windows and promotion timing. | Phase 3 |
| **Offset-ignored epoch adoption** (§2.6 refinement) | Avoids discarding a byte-identical head-first transfer, but only matters if the wasted-request cost shows up in measurement. | Phase 2 data |

## 7. Risks & limitations

| Risk | Mitigation |
|---|---|
| Epoch container opens late (header not yet landed) | Existing `firstScheduleRetryDue` cadence + deferral logging; epoch fallback after a bounded window |
| `timeOffset` epoch base accuracy (pre-input `-ss`) | Document a tolerance; the raw splice path is exact by construction; never re-anchor the UI from an approximation |
| Snapshot schema skew | The plugin and bundle ship together; both sides change in Phase 0 |
| Ogg splice may never be acceptable | Fixture gate; permanent wait-only is an acceptable outcome |
| Bounded-window extension interacts with the stall contract | Reuses the existing chained-segment + stall/resume machinery unchanged; the window only changes *where* bytes come from |
| A rebase acting on a false verdict | Verdict is container-primary and evaluated before audio; the rebase is lossless by design |
| **Direct play under an offset request with a HEADER-LESS source** (found 2026-10-07 while the first CI run reviewed the verdict bands) | The verdict judges a PARTIAL container's own claim. A head-first direct-play response (fact 20) of an Ogg/Opus ORIGINAL under-claims exactly like a young epoch, so the `honored` band can absorb it and schedule the head at base T — the silent-wrong-position class the verdict exists to prevent. FLAC/MP4 originals carry the full duration in their header and land correctly in `ignored`. Discriminator identified, NOT yet wired: the requested `format=` versus the SERVED container's codec family (fact 20 — a direct-play resolution serves the source codec, so a mismatch proves the offset was ignored regardless of the claim). | Wire the format-family corroboration where the engine already opens the file (`resolveStagedPlacement`); a field run on an opus-sourced library decides how reachable this is in practice |

## 8. Tunables (adaptability)

| Knob | Default | Where | Effect of change |
|---|---|---|---|
| **Global kill switch** (`seekEpochs: 'auto' \| 'off'`) | `auto` | persisted settings | `off` reproduces Phase-1 behavior exactly (position-preserving wait, no epochs, no extra requests) without a release — the field rollback for Phases 2–3 |
| Minimum wait before opening an epoch | derived from lead policy + observed rate | `StreamPolicy` | Lower = more epochs (more server work), higher = more waiting |
| Raw window size | lead-derived | new constant in `StreamPolicy` | Larger = fewer round trips, more data |
| Offset tolerance for the honored/ignored verdict | container-relative band | `StreamEpoch` | Wider = fewer false rebases, risk of acting on a lying container |
| Static capability strictness | optimistic unless certain (§2.5) | `seekCapability.ts` | Making it strict costs latency on untagged rows |
| Per-container splice enablement | FLAC on fixture pass; Ogg gated | `RawSeekIndex` strategy table | Turning a container off degrades to wait-only, never to wrong audio |

**Change protocol** (repo anti-rot contract): when a phase lands, update the anchors in
§1 and tag each new invariant with the test that enforces it; promote a rule to
AGENTS.md §4 only once it can be broken by a future session without a test catching it.

## 9. Anti-patterns (do not do)

- Do not reorder `play()` so `!hasLiveSchedule` is tested before the staged/epoch
  state. That ordering *is* the reported bug.
- Do not re-point `el.src` on web for a seek.
- Do not promote, rename, or serve an epoch artifact as a cache entry.
- Do not branch on `Accept-Ranges` alone (cached transcodes report `bytes`).
- Do not snap the UI to 0 on a dropped offset; rebase and keep the intent.
- Do not `bytes=X-` to EOF for a raw seek epoch.
- Do not hold an `AVAudioFile` across an append boundary (existing §2.6 discipline).
- Do not map time→byte for MP3 correctness; the TOC grid is approximate.
- Do not let `SeekSource` own decoder handles; the engine owns every open.

## 10. Review log

Corrections adopted during design review (2026-10-07), each traced to source:

1. `Accept-Ranges` demoted from verdict to corroboration — a completed transcode is
   served through `ServeContent` and reports `bytes` (fact 22).
2. Fail-safe changed from "reset UI to 0" to a base-0 rebase with the intent armed.
3. FLAC anchor corrected to `frameNumber × blockSize` for fixed-blocksize streams;
   STREAMINFO `total_samples` must come from the file's own frame numbers, not the
   metadata duration.
4. MP3 exclusion re-justified (TOC grid error) rather than "no anchor".
5. Ogg splice downgraded to fixture-gated (page-sequence discontinuity; manual
   packet-duration + pre-skip math).
6. ID3-displacement hint clamp added.
7. `SeekSource` stripped of `AVAudioFile` ownership.
8. Supersession ordering corrected to the existing deliberate-cancel sequence.
9. Epoch routed around `streamDecision`'s single-writer guard.
10. Cache-quarantine hooks extended (`evict`, boot sweep, sampler exclusion).
11. Web firing condition pinned to `readyState >= HAVE_METADATA`.
12. Fixture error expectations corrected (`-43` is file-not-found, not a parse verdict).
13. Phase 1 made explicit — the reported bug is not fixed by epochs alone.
14. Phase-1 implementation (2026-10-07): native seek delivery consolidated on
    `NativeTransport`'s pending intent instead of a manager-side post-engage
    re-issue (one deliverer per platform layer; the manager latch stays the JS-clock
    and web-element memory). The transport's parked intent is row-scoped and
    survives a non-matching settle — dropping it at the first foreign settle lost the
    seek that landed while the manager was still resolving the row's URL.
15. Phase-1 implementation: the native transport's parked intent is REPLAYED, never
    aimed at the outgoing row (the transport holds it when an engage cycle is in
    flight); the manager's load path consumes its latch for the clock only.
16. Phase-2 implementation: the runtime verdict gained a THIRD outcome (`unknown`)
    and it is a DISCARD, not a rebase — a container claiming neither shape has no
    credible base, and scheduling it would be the silent-wrong-audio failure the
    verdict exists to prevent. The fail-safe for `ignored` remains the base-0
    rebase with the intent kept.
17. Phase-2 implementation: §2.6's optional refinement ("a rebased raw epoch may be
    adopted as the row's canonical transfer") is the DEFAULT behaviour now — the
    rebased epoch file continues as the row's source, so the bytes are never
    wasted and the intent reaches T linearly. What stays quarantined forever is the
    epoch artifact's PROMOTION: it is never moved into the row's cache slot, so a
    later normal play still streams from 0 (acceptance 6).
18. Phase-2 implementation: the engine's epoch coordinates are enforced in exactly
    two places — `stagedSchedulableEndFrames` (local container numbers → absolute)
    and the scheduler's coordinate clause (absolute position → local frames) —
    plus `chainStagedSegment`'s segment start. Every other staged site keeps
    working in absolute frames unchanged.
19. Phase-2 implementation: the loader's epoch transfer is a `streamLoad` VARIANT
    (its own key/destination/request URL, `isEpoch: true`), not a parallel copy:
    the same writer machinery, delegate, and single-writer invariant serve it, and
    the completion path is a dedicated early block (no promotion, no cache entry,
    no maturation/preload feed, no Range continuation).
20. Phase-2 implementation: `estimateContentLength` makes the announced byte count
    describe the FULL track even on an offset stream (fact 21), so the staged
    estimate's denominator is rescaled to the epoch's expectation
    (`epochRelativeAnnouncedBytes`) — otherwise a far epoch's lead would be
    deflated by a denominator that describes a different window.
21. Follow-up (2026-10-07, the ladder's hold): the priority INVERSION that
    mattered was not the one the deferred register named. The walk is already
    serial (one `downloadTask` at a time) and already skipped during a staged
    load, so the cross-row competition is a single socket; the real duplicate is
    SAME-ROW — an epoch opens while the row's OWN download is still pushing the
    bytes it just seeked past (`loadInFlight` knows, the epoch path never asked).
    Both are recorded: the hold half shipped (no cancellation semantics), while
    same-row supersession and cross-row preemption wait for the download lane's
    deliberate-cancel veto plus a measurement.
22. Follow-up: the network re-arm's epoch hold was INCIDENTAL (`hasActiveWriter`
    happens to count ephemeral epoch writers). It is now the same pure predicate
    the walk's hold uses, and `TransferLadderTests` pins the case that would
    regress silently — an epoch with no writer yet (request on the wire, header
    not landed) must still hold.
23. Follow-up: holding the walk at the TOP of `prefetchUpcoming` would have
    silently cancelled `completeStagedSchedule`'s own arm (the schedule is still
    non-nil at that call site). The hold's staged flag therefore excludes a
    COMPLETE file — the walk owns the link again exactly when the bytes stop.
24. Phase-4 implementation: the latency legs are `decision`, `firstByte`,
    `firstSchedule`, `firstPlayback`. `firstPlayback` is the plan's "first audible
    sample" minus the device output buffer (outside the app, constant, so comparisons
    hold); the byte leg is `*`-inferred from the schedule leg when the download lane
    gives no callback; the probe is same-row, 60 s-bounded, first-mark-wins; and the
    self-test reports UNKNOWN — never a pass — when no complete report exists.
25. CI review (2026-10-07, the first `ios.yml` run on the branch — the local box has no
    Swift toolchain, so this is the gate that mattered): `swift test` caught three
    things. (a) The latency LINE shipped the inferred-byte star INSIDE the token
    (`firstByte=1200.0*ms`) while the JS fold parses a trailing star — the native
    test and the JS test each passed against their own assumption, which is exactly
    the emitter/parser contract a single canonical line is supposed to hold; the
    emitter now appends the star after `ms`, and the JS parser degrades a
    non-finite token to a MISSING leg instead of folding `NaN`. (b) The
    full-length-container test asserted `ignored` for a container 60 s short of a
    600 s track — the same between-bands shape its sibling test pins as `unknown`,
    and the design text (`openedFrames ≈ duration`) allows only the track within the
    tolerance. The TEST was corrected (not the rule) and both band EDGES are now
    pinned, so "≈" cannot drift into "roughly anywhere near". (c) Reviewing (b)
    surfaced the direct-play hazard recorded in §7: a partial, header-less ORIGINAL
    under-claims like a young epoch, so `honored` could absorb a head-first body.
26. Follow-up: the ladder's settle re-arm first shipped WITHOUT the generation bump,
    so a settle edge landing while an older speculative chain was still walking
    could run a SECOND concurrent chain — the exact double-walk the network re-arm
    has guarded against since 2026-10-02. Both re-arm paths now route through ONE
    arm helper (`armPrefetchWalk`), which bumps `prefetchGeneration` before the
    walk; the loader chains a re-request onto an existing download task, so an
    already-fetching row is a no-op rather than a duplicate.

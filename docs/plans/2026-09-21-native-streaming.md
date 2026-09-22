# A15 Design — Native Streaming (2026-09-21)

**Status**: design approved direction. **Phase 0 LANDED** (`a9c463b`): `StreamSchedule.swift` + `StreamPolicy.swift` pure cores pinned — inert. **Phase 1 LANDED** (2026-09-21): `Maturation.swift` pure core + loader-side staging wired in `AudioEngine.swift` (`loaderMaturation` state, `ensureProgress`, the 1 s sampler calls `tickMaturation` and emits `maturation: key stage=…` events, destination recorded via `destinationExtensions`, track lookup injected from `setQueue`/`refreshQueue`/`loadAndStart`; `streamMaturation` visible in `getDebugState`). Still inert playback-wise: `scheduleCurrentTrack` is unchanged and only reads COMPLETE cache entries, so behavior is byte-identical — but the maturation stage of every downloading row is now field-visible in the dump. Phases 3-4 (crossfade readiness on PLAYABLE targets) are NOT implemented — staged tracks keep crossfade automation off. **Phase 2 LANDED** (2026-09-21): loader dataTask streaming writer into `.part` (gate chain unchanged at promote; `prefetch` chains onto an active writer), staged-aware `scheduleCurrentTrack` (delivered-end schedule, chained-segment extension, generation-guarded segment/track completion discrimination), the buffering contract (stall = pause-never-evict, auto-resume at >=2 s new audio, 10 s no-progress give-up to the JS retry). **Fully integrated same day (user decision)**: the `nativeStreaming` off/slowLink/on setting was REMOVED — every eligible raw direct tap streams via the engine-side `streamDecision` gate; StreamPolicy's Mode/decision functions were deleted (eligibility is engine-side evidence, not policy math); crossfade does NOT fire on streamed boundaries until Phase 3 (accepted). **Design review pre-field** (2026-09-21) fixed seven findings F1-F7: download-path transfer-rate feed, per-byte arrival progress for stall resume, no-bar completion tail (`completionTailPlan`), crossfade-monitor re-arm guard on staged tracks, give-up writer cancel + Range substrate, stalled-latch clear on reschedule, and the slowLink decision rewritten as realtime-sustainability (`shouldStreamSlowLink`) after the original ratio was proven vacuous. Anchor A15 in AGENTS.md records the runtime truth.

**Problem**: on native, every track is download-then-play. On a slow link, tapping a track means waiting for the whole file before the first sample. Web streams (`HTMLAudioElement` over server URLs; a preload miss still streams via `resolveSrc`). The user asked the right question: can't playback *start* on the bytes that arrived and let the rest catch up?

**The one-sentence answer**: `AVAudioFile` cannot open an HTTP stream and cannot re-index a growing file, but a local file whose bytes arrive progressively is just a growing file — so streaming is a **staged maturation**: partial → complete file, with the *contract* (what the schedule promises) carried explicitly per stage. That staged model reuses 2026-09-21f's resume machinery (`.part` files, Range offsets, `Content-Range` verification) as its substrate.

---

## 0. Ground truth: why this is hard (verified anchors)

| Constraint | Anchor | What it blocks |
|---|---|---|
| `AVAudioFile(forReading:)` fails on a file whose container header hasn't landed; `file.length` reads the header once, then caches | `scheduleCurrentTrack` (2088): `totalFrames = file.length`, `frames = totalFrames - startFrame` | Cannot schedule from a file before its header exists; cannot see bytes that arrive after the open |
| The completion gate compares elapsed position vs `scheduledSegmentSeconds` (file truth) | `scheduledSegmentSeconds = Double(startFrame + frames) / sr` | A schedule made from a partial file's header promises audio the bytes don't contain — the exact poison class the premature-drop gates hunt |
| `AVAudioPlayerNode.scheduleSegment` consumes at most the frames the file had at open | 2171, and the standby schedule at 2630 | The "rest arrives later" does not extend a running schedule |
| Node params (speed/pitch/tape) are written ONLY while nodes are stopped (`paramsDirty` → debounced restart) | §3.4, `refreshPlaybackParams` | Any "re-schedule when more arrives" is a restart-shaped operation; naive per-chunk re-schedules wedge the time-pitch kernel |
| `refreshQueue`/fade teardown fire standby completions; `standbyScheduleGeneration` exists because of that | §3.4 standby crossfade generation | A stream maturing mid-fade must not look like a torn-down fade |
| `AVAudioFile` is the decoder for EVERYTHING: EQ branch, SoundTouch worklet input, ReplayGain, spectrum tap | §2.1, §3.4 graph | Any streaming side-channel that bypasses `AVAudioFile` loses EQ/pitch/RG on those tracks — a hard parity violation |
| `AVAudioFile(forReading:)` is how the store gate proves decodability before caching | loader trust boundary | A growing file is decodable *only after its header + enough frames land* |

Two things make it * tractable*: (a) MP4/FLAC/MP3/Ogg all keep their **container header at the front** (Navidrome's transcodes are progressive-friendly; MP4 written with `moov` at the end — "faststart" off — would NOT be), and (b) resume work already made "grow a file by Range-append" a first-class, gated operation (`DownloadResume.swift`, `.part` files).

---

## 1. The staged maturation model

A track's local representation is a **state machine over one file**, not a boolean cache flag:

```
EMPTY → HEADERED → PLAYABLE → COMPLETE
```

- **EMPTY** — no bytes. Scheduling not attempted; prefetch visible as progress only.
- **HEADERED** — the front-of-file container header has landed. The file *opens* (`AVAudioFile(forReading:)` succeeds) but `length` may claim more frames than bytes exist. Not yet schedulable — a schedule from here is the truncation poison.
- **PLAYABLE** — enough contiguous bytes exist that a schedule *ending inside the delivered region* is honest. Concretely: `deliveredBytes ≥ bytesNeededFor(durationLead: leadSeconds)` — a lead-time policy (§3).
- **COMPLETE** — the full announced length is on disk and passed the gate chain. Identical to today's cache entry; every existing gate applies unchanged.

Transitions are owned by the loader (main-thread, like all its state); each transition emits a structured event (`stream` domain: `maturation EMPTY→HEADERED→PLAYABLE(lead=15s)→COMPLETE track=… offset=…`). The schedule contract is:

> **A schedule may only be made from a PLAYABLE-or-better file, and its `scheduledSegmentSeconds` must end inside the delivered region at schedule time.**

This one rule keeps the premature-completion gate honest: the gate compares elapsed vs the *promised* segment; a promise never exceeds delivered bytes, so a completion that fires early is genuinely a network stall, not a lying header. The 2026-09-17/18 gates keep working **unchanged** for COMPLETE files; the stream-stage contract replaces the "waiting for full file" behavior for staged ones.

---

## 2. The engine side: schedule-what-exists, extend-what-runs

`scheduleCurrentTrack` gains a staged variant; the completion gate gains a *known* alias.

### 2.1 Loading (`loadAndStart`)

Today: `loader.prefetch` → completion → schedule. Staged: `loader.ensureProgress(track, minimumPlayable: lead)` returns a completion that fires at PLAYABLE (or COMPLETE — same shape) instead of only at COMPLETE. Then:

1. Open the file once at PLAYABLE; record `totalFramesClaimed = file.length` and `framesEndable = framesUnderBytes(deliveredBytes)` (the honest end).
2. Schedule `startFrame … framesEndable` with the SAME `scheduleSegment` call; set `scheduledSegmentSeconds` from `framesEndable` (file truth, staged truth — not header truth).
3. Tag the schedule `streamStage: .playable` alongside its identity (index/generation/trackId/node — the completion guard's existing capture pattern).

### 2.2 Maturing while playing (`streamMonitor` — a sibling of `crossfadeMonitorTick`)

The existing 100 ms crossfade monitor already runs during playback; a `streamMonitor` tick (same cadence, or shared tick) checks the *live schedule* for staged tracks:

- Bytes arrived that extend the schedulable end past `scheduledSegmentSeconds`? → **extend** (§2.4).
- Stall: the delivered end approaches the playhead (buffering window — the same `remaining`/buffered heuristic the web preloader uses, A14) without bytes arriving? → emit `stream stall` danger, and if the playhead is about to cross the delivered end, pause + `onError` (the bounded JS retry re-engages; **with resume, the re-engage continues from the offset** rather than restarting — 2026-09-21f already paid for this).
- File reached COMPLETE (gate chain passed)? → the staged schedule's *alias* is refreshed: the completion guard treats the track as complete; nothing else changes.

### 2.3 Completion semantics (the crux)

The completion handler's identity guard (index/generation/trackId/node) is untouched. What changes is the *verdict* input:

- A staged schedule completing **before** its `scheduledSegmentSeconds` while the file is **not yet COMPLETE** = **stream stall, not truncation** → pause, `onError("stream stall at X of Y")`, loader retains `.part` state (it already does). No evict (bytes are a prefix, not poison — they passed nothing because we never scheduled past them). The retry re-engages; `ensureProgress` resumes.
- A staged schedule completing at its `scheduledSegmentSeconds` (the delivered end) **is a normal advance** — but the *advance target* depends on whether the file COMPLETEd in the meantime: if yes, normal advance; if no, the engine takes the extension path below instead (this is the "fade target readiness" question — §2.4).
- A **COMPLETE** file's completion is judged exactly as today (all gates).

### 2.4 Extension: the honest way to grow a running schedule

You cannot extend a scheduled segment; you **chain** one. When the delivered end passes `scheduledSegmentSeconds` and more is schedulable:

```
oldNode (still rendering, ends at T_old_end)
     new segment scheduled on the SAME node? NO — AVAudioPlayerNode allows
     scheduling multiple segments; they render back-to-back. Chain:
     scheduleSegment(file, startingFrame: framesEndable_old, frameCount: newChunkFrames)
     on the SAME player node BEFORE the old segment completes.
```

The completion that was pending on the old segment fires at ITS end (data-consumed), but the node keeps rendering the chained segment — the `handleSegmentCompletion` guard must therefore discriminate *segment* completions from *track* completions on the same node: a chained-segment completion is consumed silently (the node has a successor scheduled); only a completion whose segment is the LAST on the node advances. This is the one genuinely new invariant, and it needs a pure core (`StreamSchedule.swift`: `shouldAdvance(completions:)`, `extendPlan(deliveredFrames:claimedFrames:playheadFrames:lead:)`) — testable without audio hardware, exactly like `DownloadResume`/`DecodeProbe`/`Crossfade`/`LoaderState`.

**Seek while staged**: a seek to a position inside delivered bytes = today's cancel-and-reschedule (file already open; reschedule from the new startFrame within delivered). A seek beyond delivered = pause + `onError` (resume machinery fetches the remainder; the user perceives a buffering blip, identical to web's behavior when the browser buffer is empty).

**Speed/pitch while staged**: `paramsDirty` → debounced restart already re-schedules from the current position; with staged schedules the restart re-derives the honest end from the *current* delivered bytes. No new rule — the existing restart IS the re-schedule path.

### 2.5 Crossfade implications (the user's specific question)

The crossfade targets `file.length` at standby-schedule time (2630). Staged changes:

1. **Readiness**: the monitor's `readiness=ready` gate requires the target file to exist and open today. Staged: readiness requires the target to be PLAYABLE with `lead ≥ crossfadeDuration` — a fade started from a target whose bytes end mid-fade would swap to a track that stalls seconds after the switch lands. The readiness event gains `stage=` in its message (`readiness=ready stage=playable lead=14.9`).
2. **The standby schedule** schedules `framesEndable` (delivered end), not `file.length`, with the same chained-extension machinery as the active node. If the standby matures past its fade window but stalls before COMPLETE, the extension stops and the post-finalize behavior is the *staged* natural end — which is §2.3's stall path, now on the standby-turned-active node.
3. **`finalizeCrossfadeSwitch`**: the former-standby becomes the advance trigger (the §3.4 invariant "after finalize the former-standby's completion IS the natural-end trigger"). With chained segments, the finalize must also carry the *last-segment* bookkeeping so the standby's chained tail keeps advancing — again a `StreamSchedule` decision, not new inline logic.
4. **The 1.2.31 re-entrancy lesson applies directly**: maturation events are engine-visible state changes; they MUST NOT run the crossfade monitor synchronously (the cache-hit sync-delivery re-entrancy taught this). Stream transitions are handled on the same deferred/generation-guarded pattern the prefetch chain uses.
5. **What does NOT change**: node roles (active/standby), gain ramping, `RampPlan`, the generation guards, the identity capture pattern. The fade machinery is file-source-agnostic — it never reads bytes; only the *scheduling layer* below it learns stages.

### 2.6 EQ / pitch / ReplayGain / spectrum

No changes. The whole graph sits on `AVAudioPlayerNode → mixer → timePitch → varispeed → eq → preamp`; the FILE is only read by the player node. Staged playback reads the same file the same way (a file whose header landed reads fine; the player consumes frames as scheduled). ReplayGain is a gain value from track metadata (unchanged); the spectrum tap reads the mixer (unchanged); SoundTouch consumes live buffers (unchanged). **This is the reason the staged model exists**: every existing graph feature works on staged tracks with zero graph edits.

The one real risk: `AVAudioFile` reading a file that is being **appended while open**. Verified behavior on Apple platforms: the file handle is opened once; a concurrent external append does NOT crash the reader, but the reader's cached length does not update, and reading past the original EOF returns fewer frames/EOF. The staged model therefore **re-opens** the file on each maturation transition (HEADERED→PLAYABLE, each extension) — open is cheap (no full decode; header parse) and keeps `length` honest per schedule. Never hold one `AVAudioFile` across an append boundary. This is the same "file truth" discipline the store gate uses.

---

## 3. Policy: when does native *use* streaming?

Streaming is not automatically better — a slow link that can't outrun realtime playback produces a stall-y experience *and* breaks the "COMPLETE files play offline" property. Policy (pure, `streamPolicy.swift`, testable):

- **Direct tap on a track** (user explicitly waiting): stream-start if `estimatedSecondsToPlayable < fullDownloadSeconds` (a bandwidth estimate from recent transfer rates; on fast links full-download wins — it's simpler and cache-warms for offline). This preserves today's behavior on good networks byte-for-byte.
- **Preload window rows**: NEVER stream — they download to COMPLETE via the existing chain (preload is the offline buffer; streaming preloads would break offline advance).
- **LDM**: streaming is LDM's friend (start sooner on the slow link), but the byte-exact gate only exists for COMPLETE; a staged schedule's honesty comes from the lead policy instead — acceptable, it's the same trade the web engine makes.
- **Fallback**: if the server refuses Range (the `rangeUnsupportedKeys` flag), streaming cannot guarantee forward progress → full-download mode (today's behavior).

Defaults: OFF behind a settings flag (`nativeStreaming: 'off' | 'slow-link' | 'on'`, default off) until field data says otherwise. The flag is the rollback; the staged gates are the safety.

---

## 4. Phased rollout

**Phase 0 — pure cores + tests (no behavior change).**
`StreamSchedule.swift` (extend/advance/stall decisions, chained-segment completion discrimination) + `StreamPolicy.swift` (when-to-stream decision) in `BackgroundAudioCore`, pinned in Swift tests. Ship with any release; inert.

**Phase 1 — loader staging.**
`.part` → staged transitions (EMPTY→HEADERED→PLAYABLE(lead)→COMPLETE) emitted as structured events; `ensureProgress` API; header-landed probe (the existing `AVAudioFile` decodability probe reused as the HEADERED→PLAYABLE boundary check); `streamPolicy` decides which loads opt in (still only COMPLETE under flag-off). The maturation events land in the event ring — field-visible even before the engine consumes them.

**Phase 2 — engine staged scheduling (flag on, 'slow-link').**
`scheduleCurrentTrack` staged variant; `streamMonitor` tick; stall path via `onError` + resume; seek-inside-delivered. The completion guard's staged alias. Behind `nativeStreaming: 'off'` default; the flag gates ONLY the direct-tap path.

**Phase 3 — crossfade readiness + standby staging.**
Fade target readiness requires `lead ≥ crossfadeDuration`; standby schedules the delivered end; chained-segment extension on the standby-turned-active path; `finalizeCrossfadeSwitch` bookkeeping via `StreamSchedule`. This phase has the highest interaction risk (the 1.2.28 wedge and 1.2.31 re-entrancy both lived here) — it ships only after Phase 2 has field dumps showing clean staged playback.

**Phase 4 — default flip.**
'off' → 'slow-link' default after a listening session's dumps show: zero premature-drop false positives on staged tracks, stall recoveries landing via resume (not restart), crossfade boundaries clean. The flag then becomes the escape hatch instead of the default.

---

## 5. Testing strategy

- **Pure cores** (Swift, no hardware): `StreamScheduleTests` (extension arithmetic, chained-completion discrimination, stall boundaries), `StreamPolicyTests` (bandwidth thresholds, LDM, fallback).
- **Loader staging** (Swift): transition matrix over synthetic byte arrivals (the `DownloadResumeTests` pattern — files assembled from byte slices, header/PLAYABLE boundaries asserted).
- **JS-side**: the manager already treats native errors uniformly (bounded retry); a `streamStall` error path is exercised by the existing retry pins. The debug dump gains `stream` domain events (maturation, stalls, extensions) — the field-verification contract every prior fix rode.
- **E2E honesty**: no simulator-based audio e2e for the engine; Phase 2+ validation is a **field-dump session** (the established loop for native-only behavior — the completion gates, crossfade generation, and premature-drop work were all validated this way).

## 6. Explicit non-goals

- No `AVSampleBuffer` pipeline (bypasses `AVAudioFile` → loses EQ/pitch parity; rejected).
- No `AVAssetResourceLoader` local proxy (equivalent complexity to staged files but opaque to the byte gates we just built; rejected).
- No streaming for preload rows, bg handoff, or transcode variants whose server-side encoder can't produce progressive output (MP4 with moov-at-end — detectable: HEADERED probe fails on a large delivered prefix → fall back to full download; logged, not guessed).
- No change to the web engine (it already streams).

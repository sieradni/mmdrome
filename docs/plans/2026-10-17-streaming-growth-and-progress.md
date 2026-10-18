# Native streaming growth, buffering, and progress recovery

Date: 2026-10-17 (America/Los_Angeles)
Status: implementation complete; physical iOS acceptance outstanding. Automated
verification of the final revision is tracked by draft PR #12:
https://github.com/sieradni/mmdrome/pull/12

Local evidence: 1,338 Node tests, clean type/Svelte checks, production build,
real SeekBar native-progress browser regression, production boot smoke, and
seven offline/preload compatibility regressions pass. Initial Apple CI run
39095447743 passed real Opus/FLAC reader tests, pure Swift tests, and unsigned
iOS app build; subsequent runs cover completion-ledger regressions and the
120-second Opus fixture. Exact final CI status and run links live on the PR.
No device playback claim follows from these automated results.

## Outcome

An uncached progressive track starts with a useful audio buffer, continues while bytes arrive at a sustainable rate, and resumes during downloading after a real shortage. Its loaded indicator advances while downloading. Completion preserves position, plays the final tail, and advances exactly once.

Scope includes native scheduling, native-to-JS progress, observability, automated coverage, and real iOS verification. Keep the existing audio graph, queue ownership, offline preload contract, and validated full-download fallback.

## Evidence and confidence

The supplied 2026-10-18T03:34:33.938Z dump shows DreamLand selected at 20:34:07 PDT, playing at 20:34:10, paused at 20:34:15, and resumed at 20:34:31. Native reports `stall cleared by completion` at 6.0 seconds. It was cellular Opus@128, with no recorded interruptions or retry decisions. Its 218 seconds of audio downloaded in about 23.5 seconds. This proves the completion-dependent recovery; the dump does not preserve the sequence of partial decoder lengths needed to prove every intermediate cause.

Source inspection identifies a strong matching defect: `AudioEngine.swift::extendStagedSchedule` uses `staged.headerClaimedFrames` without reopening the growing file before deciding to extend or resume. For an Opus partial whose reported length grows, the original length becomes a permanent ceiling until another scheduling operation or completion refreshes it.

The display defect is independently reproduced through the actual JS functions: native percentage-first updates at 10%, 50%, and 90% leave an absent entry absent, then `done` creates a 100% entry. `mapNativePreloadEvent` supplies no `start` for that sequence, while `applyPreloadEvent` requires an existing fetching entry. Existing tests pass because their native round trip starts with an indeterminate event.

Other gaps to address together:

- A fixed 524,288-byte scheduling delivery interval represents about 32.8 seconds of audio at 128 kbps, longer than the nominal 15-second startup lead.
- `startFirstStagedSchedule` accepts any positive schedulable end after the byte lead crossing; actual readable audio may still be much shorter than the intended lead.
- The self-test buffering verdict uses resume/give-up counts and can pass a stall that only completion unblocks.
- Existing pure tests validate supplied frame values, but do not establish that the production adapter refreshes those values as a file grows.

History: `c9cd1e1` (October 2) enabled transcode streaming and the container-capped estimate; `5710516` (October 4) starts earlier on byte arrivals. October 17 response/interruption changes do not match the observed failure path. Record this as the evidence-supported attribution, not proof of the installed binary's exact regression boundary.

## 1. Establish failing regressions and a testable production boundary

Targets: `native/BackgroundAudioCore/Sources/Core/StreamSchedule.swift`, `StreamPolicy.swift`, `native/BackgroundAudio/ios/AudioEngine.swift`, `TrackFileLoader.swift`, `src/lib/loadStatus.ts`, `src/lib/playbackManager.ts`, and their tests.

1. Add the percentage-first native sequence as a failing integration regression through the native event adapter and shared store. Include eviction followed by a new percentage-first fetch.
2. Extract only the staged growth coordination needed for testing: injectable monotonic clock, current-file probe, position/intent snapshot, and scheduling effects. Production must use this coordinator; tests must not duplicate its algorithm.
3. Drive the coordinator with successive file observations: first a readable 6-second prefix, then 25, 60, and full duration. Bytes grow independently of decoder length, with completion deliberately withheld. Assert extension and recovery before completion, using fresh observations.
4. Capture schedules and completions through a fake player, including generation and track identity. Assert positions, requested frame intervals, effect ordering, and one natural advance, rather than private method names.

Keep this boundary dependency-free and runnable under the existing Swift core tests. The AVAudioFile/player adapter remains thin. Add adapter-level Apple-platform coverage in step 5 so extracting a correct coordinator cannot hide incorrect wiring.

Exit: regressions fail for the current defects; the harness exercises the coordinator the app actually calls.

## 2. Correct readable growth, startup, extension, and stall recovery

### Fresh file evidence

- Reopen the current source at a bounded cadence when new bytes arrive; obtain a fresh container length before growth/resume decisions. Use one observation for both the decision and its scheduling effect where possible.
- Distinguish the current container observation from the scheduled end and metadata duration. Clarify misleading `headerClaimedFrames` comments/naming: a partial can report either a full-track claim or a growing prefix.
- Feed fresh observations into startup, running extension, stalled resume, and completion through shared logic. Preserve epoch-local versus absolute coordinates at the existing conversion boundary.
- A temporary failed open/zero-length observation during append defers safely; it must not evict valid bytes, rewind the schedule, or replace previously scheduled audio. A genuinely missing source remains an actionable failure.
- Check generation, active identity, and source identity before applying observations or delayed effects. Completion/teardown must invalidate pending probes.

### Audio-time scheduling

- Separate byte accounting from scheduling notifications: every arrival still updates exact byte counters and inactivity evidence. Schedule reevaluation must not wait for another 512 KiB.
- Use a bounded, coalesced reevaluation cadence (initial target: 200 ms), plus immediate completion handling. Keep at most one pending evaluation per active stream; cancel it on teardown.
- Measure the actual schedulable headroom relative to the requested position. Start only when it meets the intended lead, or the verified complete/short-file exception applies. Byte-derived lead is an estimate, not sufficient proof by itself.
- Keep normal extensions batched by meaningful audio duration. When scheduled headroom is low, permit a smaller safe extension so the normal 5-second churn threshold cannot force an avoidable stall.
- Evaluate headroom against effective playback consumption, including speed changes. Test source-frame and wall-time conversions explicitly.
- Resume an involuntary stall once the existing 2-second safe margin is available, before download completion. Preserve explicit user pause, interruption state, and parked seek intent.
- Retain last-byte-arrival-based inactivity timeout. Never confuse a held scheduling evaluation or unchanged decoder observation with network inactivity.
- Audit the `.dataConsumed` boundary: it may fire ahead of audible output. Preserve chain bookkeeping, and verify that stall handling neither cuts queued audible audio nor resumes from a guessed position. Do not globally switch callback types without proving extension/completion behavior.

Preserve raw header-high safety, transcode duration-based promotion, exact raw completion validation, unknown-total fallback, Range continuation validation, the transfer ladder, and crossfade eligibility only after completion. Estimated transcode totals must never independently authorize complete-file promotion, including the existing delivered-equals-announced stall-rescue path; carry variant/trust evidence into that decision if needed.

Exit: growing readable audio extends a running schedule and unblocks a stall without waiting for completion; startup honors real headroom; no new per-arrival scheduling churn or queue advance path.

## 3. Repair native progress initialization

- Give native percentage-bearing updates an explicit atomic start-or-update path when the entry is absent. Reuse shared clamping and state rules rather than teaching every caller to synthesize two events.
- Preserve rejection of stale progress after terminal cached/dead states. A new lifecycle after eviction may initialize normally. If asynchronous ordering requires attempt identity, add it narrowly and test it rather than allowing terminal entries to reopen indiscriminately.
- Continue to show indeterminate progress when no trustworthy byte total exists; never manufacture a percentage from playback position.
- Cover known-total-first, unknown-then-known, repeated events, completion-first, stale post-completion events, eviction/retry, and active track versus queued row. Verify the actual store-to-seek-bar path and web-preloader compatibility.
- Keep download fraction and playable audio headroom separate. A transcode's announced total is estimated; retain that provenance in diagnostics and avoid presenting download percentage as proof that the same fraction is seekable. Verify estimate under/overrun does not falsely mark the cache complete.

Exit: a known-total-first native download visibly fills before `done`, and stale events cannot undo completion.

## 4. Make the dump and self-test judge the failure correctly

Targets: `AudioEngine.swift::debugState`, existing native event log, `src/lib/streamVerification.ts`, `src/lib/streamVerifyRunner.ts`, `tests/streamVerification.test.ts`, and `docs/STREAMING-SELF-TEST.md`.

- Add bounded observations with track/attempt/generation identity, byte count and total provenance, fresh container end, schedulable end, scheduled end, playhead, headroom, and observation time.
- Record meaningful first-start, extension, stall, resume, completion, and give-up transitions, with reason. Distinguish resume from fresh partial data from resume caused by completion. Keep steady diagnostics bounded and avoid a bridge event per network chunk.
- Include stall count/duration, extension count, and progress lifecycle evidence in copied reports so a later snapshot cannot erase an earlier stall.
- Collect a bounded time series through completion or a declared observation deadline; the current single mid-stream sample and fixed 25-second watch cannot prove growth/recovery for longer downloads. Timeouts and incomplete traces yield unknown, not pass.
- Replace the resume-count-only buffering verdict with explicit checks: did the schedule grow while incomplete, did a forced stall recover while incomplete, and did readable/eligible headroom exist while the engine remained stalled beyond the evaluation allowance?
- Do not label every stall or completion-triggered resume defective: genuinely insufficient data can legitimately require completion. Use timestamped readable-headroom and intent evidence; account for speed, seeks, explicit pauses, and interruptions.
- Ensure HTTP probes do not compete with an active stream or contaminate throughput validation. Test observation remains passive until the user transfer settles.
- Add synthetic report regressions for the supplied pause-until-complete shape, healthy growth, legitimate starvation, explicit pause, stale track events, missing samples, and truncated observation windows.

Exit: the original failure shape cannot receive a healthy buffering verdict; a healthy run has enough evidence to demonstrate why it passed.

## 5. Verify the real decoder and complete the compatibility matrix

Automated coverage has three levels:

1. Pure deterministic state-machine tests: controlled arrivals, fake clocks, moving decoder ends, player callbacks, and user intent. Include callbacks racing extension, completion arriving during a stall/probe, teardown and new-track replacement, and byte counts exceeding a transcode estimate before actual completion.
2. Apple-platform adapter tests: checked-in small, reproducible audio fixtures appended in controlled prefixes to temporary files; reopen through the production AVAudioFile observation adapter and verify its reported growth feeds the production coordinator. Include Opus and raw header-high shapes, partial-open deferrals, and incomplete final pages. Use a separate macOS-testable AVFoundation support target/package if needed so Capacitor is not pulled into host tests. No timing-dependent live server in CI.
3. JS bridge/store integration plus a browser rendering regression: deliver native progress events through the real forwarding path and assert intermediate seek-bar loaded state. Existing web buffered-range behavior must continue to pass.

Run the existing suites for StreamSchedule, StreamPolicy, PlayIntent, StreamEpoch, TransferLadder, DownloadSanity, retry/interruption behavior, native transport, load status, and streaming verification after integration. Run `npm run check`, `npm test`, `npm run build`, the relevant browser regressions and production smoke. Require `ios.yml` core/adapter tests and plugin compilation before device validation; a successful build alone does not validate audio playback.

| Device scenario | Acceptance evidence |
| --- | --- |
| Uncached Opus@128; download lasting 60+ seconds at 1.25x and 2x effective audio consumption | Starts before completion once actual lead exists; multiple extensions while incomplete; no avoidable pause on a steady link |
| Initial readable prefix shorter than the startup lead | Waits for useful readable headroom rather than playing a brief prefix and immediately pausing |
| Burst delivery, then a pause shorter than the available buffer | Continues from scheduled audio; no false network failure |
| Force actual starvation, then restore sustainable delivery well before completion | Resumes within one evaluation interval plus measured decoder/player startup allowance after eligible headroom appears |
| Sustained delivery below consumption, then recovery | Legitimate buffering is reported; available data permits recovery; no retry loop while bytes keep arriving |
| User pauses during buffering; then bytes and completion arrive | Remains paused until explicit Play |
| Foreground/background, interruption, route change, speed change | Position and resume intent remain correct; no independent second retry owner |
| Raw header-high format; MP3/AAC transcodes; unknown-total/non-progressive output; short track | Safe schedules or declared full-download fallback; no false completeness claim |
| Seek within/beyond delivery, honored/ignored epoch, Range reconnect, track replacement | Correct absolute position and identity; no restart at zero or stale callback effects |
| Completion, final tail, crossfade, natural advance, cached/offline next track | Tail remains audible; one transition; offline cache contract holds |
| Known-total native first update, unknown-total update, completion | Intermediate fill, indeterminate state, then completed state, respectively |

For repeatable device tests, serve fixtures through a controllable test endpoint/proxy with rate, chunk, and interruption controls. Use actual iOS playback and uncached app variants; confirm server transcode cache state separately. Capture build SHA, codec, response shape, delivery profile, effective playback rate, and native trace. Prefer controlled Wi-Fi throttling for repeatability, then confirm the original cellular configuration. Test fixtures/endpoints must contain no production credentials and remain outside the production UI.

## Delivery order and definition of done

Implement in reviewable changes: (1) production coordinator seam plus failing growth regressions and scheduling fix, (2) progress lifecycle fix and regressions, (3) telemetry/self-test plus Apple adapter and device-test coverage. Tests that expose each defect belong with its fix. Each change follows repository verification gates; update this plan as evidence arrives.

Update the relevant A14/A15/A16 anchors in `AGENTS.md`, append implementation evidence and limitations to `docs/DEVLOG.md`, and revise the self-test instructions. Mark only invariants actually enforced by tests as test-enforced.

Done requires all automated gates and the device matrix, with explicit evidence of extension and stall recovery before completion and visible intermediate loaded progress. Record any unavailable device check as outstanding; do not substitute compile success or a passing arithmetic test. Release/version bump/deployment is a separate follow-up after validation.

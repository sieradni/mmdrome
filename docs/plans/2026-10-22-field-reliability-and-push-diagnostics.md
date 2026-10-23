# Field reliability: lock-screen state, push outcomes, and transfer evidence

Date: 2026-10-22
Status: **OPEN. Native control implementation is present in the working tree; Apple compilation/tests and physical-device closure remain outstanding. Push/transfer work is unchanged.**
Source review: `d2f27ba` (checkout package version 1.2.64). The user confirms the affected build is current; the dump itself does not contain an authoritative running version/commit.

This is the working register for the October 22 reports. Keep findings, proposed work, automated verification, and physical-device acceptance separate. A passing compile or a metadata assignment does not close a reported lock-screen failure.

## 1. Scope and user testimony

### Lock-screen report, clarified during this investigation

1. Pause through the app **or AirPods media controls** stops the audio.
2. The system transport still displays **Pause**, implying playback continues.
3. A subsequent AirPods press does nothing. The user recalls that previously two presses might have corrected the button and then resumed, but is uncertain about that older behavior.
4. Pressing the lock-screen control once changes it to the paused presentation; pressing it again starts the song.
5. The prior attempted fix did not visibly resolve this behavior.

Do not reduce this to "Pause does not stop audio" or "resume unexpectedly starts at zero." The current report is stopped audio plus stale system state and ineffective accessory resume. Record which button is displayed, not just the ambiguous phrase "shows paused."

The user separately experienced Bluetooth/earbud hardware trouble. **Exclude device disconnections, reconnect storms, and repairing Bluetooth from this app backlog.** AirPods command handling remains in scope because it is part of the clarified app-control failure. Existing route-loss privacy pauses must remain correct; route events alone are not evidence of an app defect.

### Push report

- User reports `0 pushed, 27 failed, 0 skipped`, despite most target files being valid; some files changed or were unlinked.
- Treat the current build as confirmed. Do not attribute this report to the old destination-ETag bug merely because that bug existed.
- "Valid file," "linked file," "pending edit," "attempted write," and "committed remote write" are different facts. The result must explain those distinctions without exposing implementation detail in the everyday UI.
- The available dump does not establish that every pending row failed at the same stage or that all users cannot push.

## 2. Preserved evidence from the supplied dump

The workspace `Pasted text.txt` was read completely, parsed as JSON, and deleted at the user's request. Do not recreate or retain the raw attachment in git. This section preserves the diagnostic facts needed to continue; later source findings are not retroactive log evidence.

Snapshot: `2026-10-22T21:51:54.961Z`; native iOS, reported OS major 27; manual Low Data Mode on; Opus@128; network noncellular with OS Low Data Mode off at capture.

| Evidence | What it establishes / limit |
| --- | --- |
| 708 native events, sequence 1–708, `eventLogDropped=0` | 5,416.86 monotonic seconds between first and last retained native events. No reported native ring eviction. This is not proof of complete instrumentation. |
| 8 JS events, beginning `21:16:24.278Z` | Much shorter JS history than native history; reload/reinitialization is plausible, not proven. Native uptime and JS epoch milliseconds are different clocks. |
| 15 failed download attempts across 15 track IDs | All report `NSURLErrorDomain(-1017)`, `cannotParseResponse`, HTTP 200, `audio/ogg`, `Accept-Ranges: none`, and Opus@128. These are audio prefetch downloads, not WebDAV writes. |
| Failure attribution | Eight precede any reported network transition; seven are outside the five-second transition window. `churnUnlikely` is the policy's attribution, not proof of a particular server/proxy fault. |
| 15 fresh-connection decisions, 10 enacted rotations | Recovery is active. The difference needs lifecycle accounting; it does not alone prove five retries were lost. |
| 10 of the 15 failed IDs later occur in completed crossfades | Failed attempts did not make all affected songs permanently unplayable. The remaining five were upcoming rows not demonstrated playing in this dump. |
| Native event 30 | One staged stream was promoted despite `cannot parse response` after duration corroboration. An error can coexist with usable delivered audio. |
| 15 fade starts, 12 completions, three pauses during fades | Starts minus completions is not sufficient evidence of a crossfade defect; pause tears down and later re-arms fades. |
| Events 465–481 | Five activation failures, a later route-loss pause decision at 469, continued retries, then `resuming current track after engine recovery` at 480. Preserve the ordering as an intent-race lead; do not reopen Bluetooth hardware diagnosis. |
| Final playback snapshot | JS/native track and active row 10 agree; both playing; native position 94.99 s, JS 95.22 s, duration 240 s; running engine, no active interruption, no engine-unavailable state. |
| Empty `lastError` / `errorLog` | Not an error-free session: native history contains ten danger entries (five failures plus five recovery decisions) and the recoverable transfer failures. |
| No push report or WebDAV request stages | Cannot identify the 27 failures, establish their interval, or count remote commits. `loaderCached=27` is an unrelated audio-cache count. |
| `CACHED fallback`, no accompanying error | Does not prove failed connectivity: this wording also labels ordinary successful cache reuse. Low Data Mode independently explains suppressing the automatic WebDAV scan. |
| Stored probe `__probedBy=1.2.33` | Codec-probe provenance, not running application version. Do not use it to contradict the user's current-build confirmation. |

The dump has no command-type/publish transcript around the reported stale icon. It cannot tell whether an AirPods gesture produced Play, Pause, Toggle, or no delivered command. Published dictionary values also cannot prove what iOS displayed.

## 3. Native control investigation

### 3.1 Earlier fixes and their actual reach

| Change | Verified current behavior | Remaining boundary |
| --- | --- | --- |
| `a9bc72e` (2026-08-05) | `NowPlayingController.setupRemoteCommands`: explicit Play invokes `onPlay`, Pause invokes `onPause`, Toggle invokes `onToggle`. | Correct separation remains present. Do not restore "both commands toggle" as a workaround for stale system state. |
| `24d9d36` (2026-08-06) | `BackgroundAudioPlugin` bridge `play`, `pause`, `toggle` handlers call `refreshNowPlaying()` unconditionally after the engine command. | Remote callback closures installed in `load()` call the engine directly and lack that unconditional refresh. A no-op remote Pause can leave stale presentation uncorrected. |
| Current normal state edge | `AudioEngine.setPlaying` writes `isPlaying` **before** invoking `onPlaybackStateChanged`; the plugin then refreshes Now Playing. `NowPlayingController.update` assigns rate 0 when paused and elapsed time in the same dictionary. | In-app Pause already has both this edge refresh and the bridge's forced refresh. Missing remote refresh alone does **not** explain the clarified in-app reproduction. |

These are the relevant fixes found in repository history, not proof which exact change the user had in mind. The report is reopened regardless of earlier source-completion claims.

### 3.2 Findings and hypotheses

**L1 — Engine output lifecycle is the leading device experiment, not a confirmed root cause.** Ordinary `AudioEngine.pause()` pauses `activeNode` and `standbyNode`, resets fade state, and sets logical playing false, but leaves `AVAudioEngine` running. `stopPlayback()` explicitly pauses the engine; ordinary Pause does not. This is a concrete lifecycle difference consistent with stopped player audio and stale system transport state. Establish on hardware whether the graph's continuing output activity matters even when the assigned Now Playing rate is zero. Do not ship a metadata-only repeat fix and declare success.

Proposed experiment: instrument the current path, reproduce with stable output, then compare a narrowly scoped authoritative user-Pause path that pauses the engine after freezing the position and nodes. On Play, use the existing guarded activation/start before resuming the saved schedule. Verify position, effects, both nodes, staged growth, pending callbacks, fades and background resume. Avoid a blanket stop/rebuild or session deactivation: those have different scheduling, routing and activation consequences. Audit session/graph reactivation while paused, including `SessionController.setMixingMode` (session activation) and `AudioEngine.rebuildAudioStack` (graph start); a rebuild can start the engine even when its restored track remains logically paused.

**L2 — Remote commands and app commands do not share their acknowledgement/publication boundary.** In `BackgroundAudioPlugin.load`, remote closures bypass the bridge handlers' unconditional refresh. `NowPlayingController.setupRemoteCommands` returns `.success` even when `self`/a callback is absent, or when off-main work has merely been queued. No command transcript distinguishes received, accepted, executed, no-op, deferred, unavailable, and published. Register/remove ownership is also not explicit: target tokens are discarded and setup has no idempotence guard. Duplicate handlers are an audit/test target, **not a demonstrated double delivery**.

**L3 — Explicit Pause does not invalidate engine-recovery play intent.** `pause(cancelRetries: true)` calls `cancelActiveLoadRetries`, but that cancels only the active-load timers. It does not cancel `engineRecoveryTimer` or clear `resumeAfterEngineRecovery`. `handleEngineStartFailure` sets resume intent; `resumeCurrentAfterRecovery` later calls Play. `stopPlayback` also does not explicitly clear those engine-recovery fields. Re-check track replacement and empty queue too. This is a separate code defect/risk from the stale icon; do not claim it explains the user's latest symptom.

**L4 — Full-download and retry completion can carry stale autoplay across Pause.** `loadAndStart` captures `autoPlay` in the `loader.prefetch` completion and passes it unchanged to `scheduleCurrentTrack`. Pause does not bump `scheduleGeneration`; setting `stagedAutoPlay=false` only protects staged paths. `retryActiveLoad` similarly schedules a successful non-staged retry with literal `autoPlay: true`. Cancelling a pending retry timer does not cancel an already-running attempt; a failure arriving after Pause can also re-enter retry ownership. Add a live user-intent check for these terminal callbacks, not just a new timer cancellation.

**L5 — Toggle reads observed playback, not necessarily the latest requested state.** `togglePlayPause()` uses `isPlaying`; a stalled/recovering/first-open stream can be logically false while a pending Play still exists. Repeated accessory toggles must invert accepted user intent coherently. Explicit Play/Pause remain idempotent. Determine the actual delivered command before inferring what an AirPods gesture means.

**Checked exclusions:** native initialization goes through `_initNative`, not `_initWeb`'s `setupMediaSession`; a competing JS Media Session is not established by this code path. `setPlaying`'s callback ordering is correct. The final playing snapshot cannot diagnose the paused UI. Existing `PlayIntentTests` cover resume selection and seek positioning; `EngineRecoveryPolicyTests` cover decisions; neither drives the remote command → graph → Now Playing publication chain. JS `NativeTransport` retry cancellation tests do not exercise Swift recovery timers.

### 3.3 Required control model and instrumentation

- [ ] **L-01: One command interpreter/publication path.** Both bridge and remote adapters issue semantic commands through one main-thread-owned path. Keep provenance as `app-bridge` vs `remote-command`; do not claim iOS exposes lock screen vs AirPods vs Control Center when the public event does not. Publish coherent rate/elapsed/identity after every accepted command, including no-ops and deferrals, plus state edges and seeks. Repairing presentation must not synthesize an audible transition.
- [ ] **L-02: One authoritative user-intent model.** Keep desired playing separate from rendering, buffering, interruption and engine availability. Tie pending recovery/load/first-open/growth/rebuild callbacks to the live intent revision and queue occurrence/session. Pause and teardown supersede older Play work; a later deliberate Play starts fresh. Interruption suspension preserves eligible intent without overriding a subsequent explicit Pause. Use a pure production-consumed core with fake clock/effects, not disconnected tests mirroring adapter code.
- [ ] **L-03: Graph lifecycle investigation and implementation.** Run L1's device comparison before selecting engine/session policy. Model ordinary explicit Pause separately from involuntary buffering/interruption. Preserve saved position and already-delivered bytes; no reset to zero, forced re-download, unintended queue advance or audible standby tail. Prevent recovery/parameter changes from silently restarting a paused output graph.
- [ ] **L-04: Honest remote acknowledgements and registration lifecycle.** Retain target tokens, unregister deterministically, make setup idempotent, install callbacks before enabling registration, and test missing owner/callback/no content/unavailable cases. Define when `.success` means command accepted versus actual rendering; asynchronous recovery remains explicitly pending in telemetry. Do not disable Pause while buffering solely because rendering is false.
- [ ] **L-05: Native command transcript and publication snapshot.** Always-on bounded command IDs with semantic command, receipt/execution times, acceptance/no-op reason, before/after intent and rendering, occurrence ID, generations, app lifecycle, graph/node running state, recovery pending/resume flag, and resulting publication revision. Capture assigned **and current readable dictionary** rate/elapsed/default rate/track, publisher, timestamp, timer state, target-registration count, and clear events. Reading back the dictionary proves assigned state, not the system's displayed button. Count suppressed/overflow events.
- [ ] **L-06: Prevent metadata overwrite races.** Track one publication revision through timers, artwork completion, track replacement, speed changes and clear. Current artwork completion patches the current dictionary rather than reapplying `lastInfo`; preserve that property. Ensure nil-track clear also resets the controller's cached publication state. Log publication changes, not every one-second tick.

### 3.3a Native implementation evidence (2026-10-22, uncommitted)

**Implementation is not device closure.** L-01/L-02/L-04/L-05/L-06 have source changes and production-consumed core regressions; their checkboxes remain open until the native gates run. L-03 is only partially addressed: paused rebuilds and mixing edits no longer deliberately activate output, but ordinary Pause still pauses player nodes without pausing the output graph. The L1 hardware comparison is NOT performed, and the original stale-button report is NOT certified fixed.

- `PlaybackControl.swift` owns desired playing, intent revision, occurrence/session ownership, source ownership and interruption permission. Byte callbacks survive Pause/Play, seek rescheduling and graph rebuild; a replacement load/epoch/session supersedes them. Recovery/active-retry timers require their live intent lease. Pause/teardown cancel recovery and active-load retries; late failures cannot recreate JS/native retry ownership while intent is paused.
- `AudioEngine.swift` consults live intent at every schedule start; Toggle uses desired intent. Full-download/retry success schedules paused bytes without autoplay after Pause; decoder/schedule errors discovered while doing so retain native evidence without arming a JS retry against paused intent. Paused position is frozen; dirty parameter resume reschedules from that position. Resume no longer plays a stopped standby. Rebuild preserves source/seek state and does not start output when paused. A rebuild returns control without letting an old caller play a retired graph node; retained staged state is marked stalled because its old node promises no longer exist. Empty tail refresh remains a no-op so removing the last queued row does not cut off its audible occurrence (queue invariant B2); explicit setQueue still owns teardown.
- `PlaybackCommandInterpreter` is shared by the app bridge and remote adapter. Accepted commands (including no-ops) publish rate/elapsed/identity; remote success means main-thread intent accepted, not audible playback completed. Missing owner/callback fails, missing content returns no-such-content, and invalid seek fails. Target removal closures are owned by `RemoteCommandRegistration`, with idempotent setup and deterministic teardown; callbacks are installed before registration.
- `NowPlayingPublication` owns revision/publisher/time and quiet timer accounting. Artwork patches the current dictionary rather than restoring an old rate/position; clear resets cached metadata/art state. The bounded 160-entry control transcript is independent of the noisy engine event ring and counts overflow. It contains receipt/execution/completion times, semantic command/provenance, before/after intent/rendering/graph/node/occurrence/generation state, publication revision and assigned/readable metadata. Native build/OS/session/clock context and JS version/commit/build time are included in the existing HUD Copy dump. No new tokens, URLs or auth data enter these fields.
- The native state event optionally includes `desiredPlaying` at semantic command/session/sleep boundaries, not transient internal rendering stops. `NativeTransport` remembers accepted intent, cancels timers for false intent (including no-op accessory Pause), and does not let late errors recreate retries/advance after Pause. Rendering-only events preserve the bounded retry history across a retry's own setQueue teardown. Timer revisions reject cancelled-but-queued JS callbacks; native recovery/retry callbacks check both intent lease and Timer identity before clearing shared handles. The legacy split setQueue/playTrackAt path reads live autoplay permission for its second command.
- Interruption recovery distinguishes explicit Play from automatic graph work through production `PlaybackControl.mayAttemptStart`. Configuration/growth callbacks cannot test session ownership mid-interruption. Explicit Play and an eligible interruption end reactivate even when AVAudioEngine still reports running. A truncated EOF queued across Pause evicts unusable bytes and parks the held position for later Play rather than plain-resuming an exhausted node.

Regression sources: `PlaybackControlTests.swift` (13 tests including automatic-vs-explicit start permission, fake-clock delayed effects and 256 short intent traces), `NowPlayingPublicationTests.swift` (6 tests), and six new `tests/nativeTransport.test.ts` regressions (including local/remote late failures, cancelled timer delivery, retry-reload budget and legacy split-engage Pause). These Swift tests are in the existing core package and will be discovered by the existing `ios.yml` pure-core gate; **they have not been executed here**. MediaPlayer/AVFoundation adapter behavior has not been run; pure tests do not substitute for it.

Local evidence after the release-readiness review: `npm run check` 0 errors/0 warnings; targeted native transport/manager/reconcile suites 146/146; final full `npm test` 1443/1443; fresh production build plus Chromium smoke 1/1. An initial typecheck found a missing discriminated-union narrowing in a new test; it was corrected to assert the complete expected event and the final checks rerun. Existing TagLib browser externalization, large-chunk and ineffective-dynamic-import warnings persist. `swift test --package-path native/BackgroundAudioCore` was attempted and blocked with exit 127 (`swift: command not found`); no Xcode executable is available either. `git diff --check` passes. File-change hooks are unavailable in SDK mode. No commit, CI dispatch, release or deployment was performed.

**Release recommendation: HOLD.** JS checks do not compile or execute these native adapters, and the original output-graph/system-button hypothesis remains unresolved. This review did not run or authorize a release.

**Outstanding closure gates:** (1) `swift test` in `native/BackgroundAudioCore`, (2) AVFoundation reader gate and plugin `xcodebuild` from `ios.yml` for this edited revision, (3) platform adapter tests/actual command-to-graph-to-publication exercise, (4) the complete physical-device matrix below, including the output-graph comparison. Do not check off L-03 or the reported stale icon based on the JS smoke test or dictionary equality.

### 3.4 Device protocol and closure criteria

Use stable speaker output first, then known-working AirPods. Hardware disconnection reproduction is not required. Record build, full OS version, intent/command transcript, actual audio, actual system button and elapsed display. The same user sequence must pass without a corrective extra tap.

| Case | Required outcome |
| --- | --- |
| App Pause → inspect lock screen → one accessory resume | Audio stops, system shows Play, one received Play/Toggle resumes from the held position. |
| Accessory Pause → inspect → one accessory resume | Same agreement without touching the lock screen to repair state. |
| Lock-screen and Control Center Play/Pause | One action produces one accepted command and the expected transition; explicit duplicates do not invert state. |
| Rapid Play/Pause/Play, app/remote mixed | Latest accepted intent wins across queued dispatch and recovery; no double toggles or ghost resume. |
| Pause before first schedule / during full download / during retry | Late success, failure or completion cannot start playback until a newer Play. Cached bytes remain usable. |
| Pause during recovery; stop/clear/new occurrence before recovery fires | Old retry cannot resume an obsolete track or publish stale metadata. |
| Pause during fade, resume after short and long lock | Both nodes quiet; correct gain/position on resume; no duplicate advance or restart at zero. |
| Paused seek, staged stall, epoch, speed/EQ change | Intended position and effect settings survive; background graph activity cannot silently restore Playing. |
| Sleep timer / real interruption then explicit Pause | Existing sleep policy holds; no later callback overrides the newer Pause. Preserve interruption-only recovery. |
| Another audio app takes and relinquishes ownership; exclusive/mix | No stealing playback, stale metadata resurrection or lost remote registration; define expected mixed-mode eligibility. |
| Next track, empty queue, reload/re-engage | Metadata identity clears/changes coherently; no need for Next to repair play/pause state. |

Before acceptance runs, use these provisional budgets (not measured results): receipt → main-thread acceptance/publication ≤250 ms for local controls; accepted Pause → silence ≤250 ms; accepted Play on an already-local schedule → audible resume ≤500 ms. Download/recovery-dependent Play is reported separately as pending and timed from readiness, never incorrectly scored as a cached resume. Collect at least 20 repetitions for the app/accessory sequences, recording median/p95/max, every extra tap and every failure; repeat in foreground, short lock and long lock. Revise budgets only explicitly before a new run, never to retroactively pass a result.

Closure requires deterministic core tests, adapter/publication tests, the iOS build gate, and physical iPhone lock-screen/Control Center/accessory evidence. Simulator controls, dictionary equality, or JS state alone are insufficient. Define measurable command-to-publication and command-to-audible-resume timings before collecting acceptance runs; record distributions, not an invented pass threshold after the fact.

## 4. WebDAV push: trustworthy outcomes and safe write boundaries

### 4.1 Source findings beyond the missing log

| ID | Verified source fact | Consequence / work |
| --- | --- | --- |
| W1 | `runManualWebDAVSync` catches per-row errors, increments `failed`, retains only `failureReason` for the first error; no structured failure event. | Mixed causes disappear. Record every terminal row and batch summary without verbose domains. |
| W2 | `synced++` follows remote MOVE and local `upsertMetadata`/cache update. | A committed remote change followed by DB failure is called failed. Preserve remote vs local outcomes. |
| W3 | `shouldSkipBeforePut` is called **before GET**, not again between awaited GET/tag editing and first PUT. Retry rechecks before its GET too. | Rebind/unlink/ignore can land during those awaits. Revalidate live file identity and credential/session revision at actual mutation boundaries. Existing comments overstate timing. |
| W4 | `pushedPaths.add(davPath)` happens before GET/write success; the path normally remains reserved after failure. | Later rows for the path can be skipped even when the first writer failed. Report attempted/reserved/committed distinctly and explicitly choose safe same-file conflict behavior. Do not silently let competing pending values overwrite each other. |
| W5 | Atomic helper cleans up on MOVE failure; PUT rejection/failure bypasses cleanup. DELETE HTTP status/rejection is swallowed. | Partial or orphan temp files are possible; "PUT failed before any temp exists" is not a valid remote guarantee. Track temp lifecycle and best-effort cleanup without masking the original failure. |
| W6 | Web transport clears timeout when fetch resolves headers; body reading occurs afterward. Native rejection can be converted to `String(err)`. | Body stalls can escape the intended timeout; native structured error evidence can be lost. Preserve phase and bounded cause details. |
| W7 | Deterministic `.mmdrome-tmp` names; the core helper has no run lock. | Audit overlap from separate runs/clients. A local single-flight guard does not protect against another client; select unique owned temp paths and ownership-safe cleanup if concurrency is supported. |
| W8 | `ConflictError` on MOVE 412/404 retries once with fresh GET/tag edit; missing GET file 404/410 counts skipped. | Distinguish changed/retried/recovered conflict, exhausted conflict, file gone, and unknown MOVE outcome. Keep destination-scoped `If`; never remove protection to make the count green. |
| W9 | A live newer edit can stay pending after remote success, while `synced` still increments. | "Written" and "all edits synchronized" are not equivalent. Surface remaining work honestly. |
| W10 | Follow-up Navidrome scan exception is swallowed; completed result only lives in the view's `syncResult`; `pushState` resets. | Remote success can coexist with stale catalog and no retained report. Separate refresh status and retain diagnostics outside view lifetime. |

Anchors: `src/lib/syncEngine.ts` `webdavGet` / `runManualWebDAVSync`; `src/lib/pushReconcile.ts` `classifyRowForPush` / `shouldSkipBeforePut` / `shouldKeepPushPending`; `src/lib/webdavAtomicWrite.ts` `webdavPutAtomic`; `src/lib/webdavUtils.ts` `webdavFetch` / `nativeWebdavFetch`; `src/views/SettingsView.svelte` `performPush`; `src/stores/appState.ts` `pushState`.

None of W1–W10 establishes which one caused this batch's 27 failures. The prior destination-precondition fix `724aeae` is present and must remain covered, not reused as the diagnosis of a current-build report.

### 4.2 Required outcome model and reporting

- [ ] **W-01: Structured run/row/stage results.** Pure outcome reducer with stable run ID, track ID, safe target identity, classification, attempt, stage, timestamp/duration, status and typed error/cause. Stages: classify → live validation → GET headers/body → TagLib init/open/edit/save/validation → PUT temp → pre-MOVE validation/MOVE → local DB/cache reconciliation → optional catalog refresh → cleanup. Do not label every stage "upload."
- [ ] **W-02: Exhaustive accounting.** Track remote state (`not-attempted`, `not-committed`, `committed`, `unknown`), local reconciliation (`not-needed`, `complete`, `failed`) and pending state independently; unknown stays unknown after timeout. Every input row has exactly one terminal disposition or is explicitly unprocessed after cancellation. Aggregate counts derive from those rows, with invariant tests. Preserve newer pending edits even when a previous snapshot was written.
- [ ] **W-03: Classify and explain changed/unlinked rows.** Reuse one classification for preview and execution; report initial no-path/ignored/no-base/wrong-server separately from disappeared file, live unlink/rebind/credential switch, duplicate target, file identity conflict, write conflict and failed write. Preview is a snapshot, not an executable authorization for a target that changed afterward. A changed mtime/ETag is not proof of a wrong song. Validate identity with the shared metadata evidence rules where appropriate; do not invent a new matching policy or silently auto-bind. Decide/record how genuine external rating/loved changes are resolved.
- [ ] **W-04: Revalidate at mutation boundaries.** Check current row, occurrence-independent track identity, target path/base, credentials revision, dismissal and pending edit snapshot after asynchronous read/edit work and before PUT, and again before destination replacement if work can interleave. Handle changes after temp upload by discarding only this run's temp and keeping the newer edit/link intent. Repeat the checks on retry. Define the final in-flight MOVE boundary honestly: once sent, a later unlink cannot retroactively prevent or undo the remote operation.
- [ ] **W-05: Transport error contract.** Instrument the shared choke point with method, native/browser transport, request/attempt/run IDs, elapsed time, headers/body phase, byte counts, status, retry-after, bounded sanitized DAV error and allowlisted server request ID. Preserve native NSError-like domain/code/underlying cause when exposed; do not infer reliable codes from localized strings. Timeout must cover body consumption as well as obtaining headers. Distinguish timeout/abort/network/auth/HTTP/body decode/tag format/local persistence.
- [ ] **W-06: Atomic write lifecycle and concurrency.** Keep destination ETag scope and URL encoding protections. Report absent ETag vs rejected/unsafe ETag vs guarded write. Protect temp ownership and same-file duplicate policy; settle cleanup after PUT and MOVE failures, including non-2xx DELETE, missing-temp and uncertain network results. Do not delete another run's temp. A missing MOVE response may mean the destination was replaced; cleanup does not prove rollback. Reconcile uncertain outcomes with fresh evidence rather than automatic blind retry.
- [ ] **W-07: User result and recovery UI.** Quiet summary of files written, edits remaining, skips, conflicts, unknown outcomes and failed local bookkeeping; expand to grouped causes and affected tracks with next action. Mixed valid/changed/unlinked input must never collapse into an unsupported all-failed implication. Separate no-write skips from failures; avoid double-counting retries or files targeted by multiple rows. Offer retry of eligible remaining work, File Matching for link problems, and refresh retry after remote success. Do not silently clear pending edits on failure. Keep progress monotonic: current `onProgress` is called both before row settlement and afterward, so distinguish work-in-flight from settled count.
- [ ] **W-08: Connection-test honesty.** Existing Test Connection's PROPFIND proves listing access, not PUT/MOVE permission. State that limit. If adding a write-capability test, make it an explicit user action with a unique harmless test resource and owned cleanup; never rewrite a music file as a connectivity test. Do not require this extra test for an already authorized real push.
- [ ] **W-09: Durable bounded report.** Retain last completed report plus active/interrupted run checkpoint outside the 1,000-entry event ring and view component; survive view navigation and, with a small persistence adapter, app restart. No audio bytes, auth headers, tokens, signed URLs or full unbounded responses. Record truncation/overflow and build/OS/transport/config-presence context. Diagnostic persistence failure must not change the file-write verdict or create an unhandled rejection. Define retention/reset behavior; update DB schema only if the chosen implementation needs it.
- [ ] **W-10: Catalog refresh and retry ownership.** Base refresh eligibility on known remote commits, including a remote success followed by local failure, rather than the legacy `synced` counter. Preserve successful writes when Navidrome refresh fails. Record it as a distinct follow-up task and make retry possible. Do not turn refresh failure into a reason to rewrite the file. Keep between-row cancellation and make unprocessed/pending totals explicit.

### 4.3 Required push regressions

- [ ] Mixed batch: success + unlinked + wrong server + ignored + changed/retry-success + conflict-exhausted + missing file; preview, report and durable pending state agree.
- [ ] GET failure/body timeout; TagLib init/open/edit/save failure; PUT 401/403/405/413/429/507/5xx; MOVE 403/404/405/409/412/423/5xx; malformed success bodies where relevant; native rejection/base64 conversion failure. Use representative grouped policy cases, not dozens of shallow assertions of strings.
- [ ] First and second attempts use fresh bytes/ETag; never send destination ETag as `If-Match` on temp. Assert actual destination contents and preserved unrelated tags, not just counters/request calls.
- [ ] Rebind/unlink/ignore/credential change during GET, tag processing, after PUT, and retry; newer rating/loved edits survive all completion orders.
- [ ] Remote MOVE success then DB failure; DB success/cache update failure; response lost after server commit; cleanup failure. Prove report fields and recovery do not fabricate rollback or erase newer edits.
- [ ] Duplicate destination after first success/failure, concurrent starts, unique temp ownership, cancellation during last row, and restart with an interrupted report.
- [ ] Browser tests drive production `SettingsView` against `tests/e2e/webdavMock.ts` with real tag bytes, assert the final file tags and pending rows, and inspect grouped results. Include long titles, narrow/reflow, keyboard/focus and screen-reader announcement behavior in the result-details UI.
- [ ] Native transport/device test for the real CapacitorHttp binary GET/PUT/MOVE path and error mapping. A browser mock or pure atomic helper pass does not validate native body encoding or server compatibility.

Existing anchors to extend: `tests/webdavAtomicWrite.test.ts`, `tests/webdavPaths.test.ts`, `tests/pushReconcile.test.ts`, `tests/tagWriter.test.ts`, `tests/e2e/pushchanges.spec.ts`, `tests/e2e/webdavMock.ts`. Add an injectable orchestration seam to test the real production push loop; do not test a duplicate implementation.

## 5. Audio transfer failures and shared diagnostics

- [ ] **N-01: Attempt lifecycle evidence.** Extend `TrackFileLoader` download and writer paths with correlation IDs, variant, start/end bytes on disk vs counters vs announced bytes, final decoder duration vs metadata, timing, HTTP protocol/connection metrics, safe response fingerprint, resume/fresh disposition, and terminal accepted/rejected/cache result. Capture URLSession metrics through a bounded adapter; no credential-bearing URLs. Existing maturation transitions are diagnostic and do not establish final cache availability.
- [ ] **N-02: Explain retry decisions vs effects.** Account for cache hit, in-flight coalescing, scheduled retry, enacted pool rotation, superseding generation, cancellation, success and final give-up. Do not count a delayed intent as an enacted network request; avoid retry storms and preserve the serial prefetch walk plus user-transfer priority.
- [ ] **N-03: Diagnose `-1017` with controlled evidence.** Compare repeat first-connection/fresh-connection requests for Opus@128, raw and another supported transcode; capture exact received/announced length, transfer end and decoder corroboration. Test suspect proxy path vs origin only when access is available. Missing range support and estimated transcode length complicate interpretation; never enforce source-size/raw byte rules on transcodes or weaken duration/response trust gates. A 200 response is not a completed transfer. No server/proxy/iOS root cause is confirmed by this dump.
- [ ] **N-04: Reproducible failure fixtures.** Extend existing slow-stream fixtures with early/overstated/understated length, malformed/truncated response, mid-body disconnect, clean EOF and full decodable body plus transport error. Verify no poisoned cache, no queue consumption on server-wide/auth/document failures, bounded recovery and no starvation behind a parked row. Confirm eventual cache/scheduling outcome, not merely a retry log line.
- [ ] **D-01: Shared diagnostic envelope.** `DebugHud` Copy includes explicit app version/commit/build time, full OS version, JS/native session IDs and clock samples, capture age for independently polled fields, enabled domains, ring drops and retained push/control reports. Native uptime is not directly an epoch timestamp; device suspension may affect cross-clock comparison. Report correlation uncertainty.
- [ ] **D-02: Error summary that matches evidence.** Summarize danger and recoverable failures across JS/native/push/control sources. Label the legacy HUD-only `errorLog` accurately. Quiet successful recovery should not become a permanent red global error, but must remain available for postmortem.
- [ ] **D-03: Ring hygiene.** 396/708 entries were `chain: prefetch row` debug messages. Aggregate repeated walks/readiness and publish counters/last transition so verbose preload cannot evict a rare failure in a longer run. Retained reports remain independent; do not silently truncate evidence to a small display slice.
- [ ] **D-04: Accurate cache/config explanations.** Replace unconditional `CACHED fallback` wording with explicit `cache-reuse`, `connection-fallback` and `load-fallback` reasons. Record the actual scan suppression reason. Probe-version provenance is labeled separately from app identity. No assumption that a restored `queueProvenance.unknown` row is a fill defect.

Anchors: `native/BackgroundAudio/ios/TrackFileLoader.swift` `prefetch` / `writerDidComplete`; `AudioEngine.swift` `prefetchUpcoming` / `retryBranchStats`; `native/BackgroundAudioCore/Sources/Core/DownloadResume.swift`; `src/components/DebugHud.svelte` `copy` / `scrubSettings`; `src/lib/debugLog.ts`; `src/lib/syncEngine.ts` `connectNavidrome` / `loadLibraryFromNavidrome`.

## 6. Delivery order, checks and outstanding gates

| Order | Deliverable | Completion evidence |
| --- | --- | --- |
| 1 | L-05/D-01 control/publication evidence; W-01/W-02/W-09 push report and accounting | Reproduction can distinguish received command, logical state, graph state, published state and visible system UI; one failed batch has attributable stages. |
| 2 | L-01/L-02/L-04 plus L1 graph experiment/L-03 | Exact user pause/resume sequence passes on physical iPhone and AirPods; pure and adapter race regressions fail against old behavior. |
| 3 | W-03–W-06/W-10 write boundaries and reconciliation | Mixed/concurrent/failure batch preserves destination safety and pending user intent; uncertain remote outcomes remain honest. |
| 4 | W-07/W-08 result/recovery UI | Real-bundle browser and real native write checks; accessible compact summaries and actionable detail. |
| 5 | N-01–N-04 transfer diagnosis; D-02–D-04 hygiene | Attributable `-1017` reproduction or explicitly unresolved environmental cause; no trust-boundary regression; retained diagnostic evidence survives noise. |

The order groups coherent increments, not permission to postpone an already-reproducible safe correction until every telemetry feature exists. Keep source fixes small; do not couple unrelated queue redesign or playlist work into this effort.

For implementation: `npm run check`, meaningful affected unit suites, full `npm test`, `npm run build` after source changes, relevant production browser tests. Native compile/core/reader gates use `.github/workflows/ios.yml` (E5); this Windows session does not claim a native build or device run. Do not release merely to call an unverified fix complete. User authorization for investigation/documentation is not a request to deploy.

### Existing work still open, not closed by this dump

- [ ] Physical-device slow-network/background acceptance from [streaming growth](2026-10-17-streaming-growth-and-progress.md), including incomplete-file growth and pause preservation. Fast transfers here do not certify slow-link behavior.
- [ ] Seek/epoch field protocol and remaining items in [seek intent](2026-10-07-seek-intent-and-stream-epochs.md) and [session verification](2026-10-08-session-resilience-and-field-verification.md). This dump has zero epoch/seek-latency reports, so it does not close those gates. Preserve each original register's status; no wholesale reopening of already-landed work.
- [ ] Remaining field work in [network/prefetch resilience](2026-10-02-network-churn-and-prefetch-resilience.md). Fresh rotations now occur, but causality and terminal accounting remain open here.
- [ ] Queue tail/auto-off and repeat pass (design steps 5–6), remaining bulk library-validation gap G4 and known occurrence-identity limit G6; see [queue design](../QUEUE-DESIGN.md) and [invariant matrix](../QUEUE-INVARIANTS.md). No queue corruption is established by this snapshot.
- [ ] UI touch/VoiceOver/device review, broader tooltip coverage, shared rating editor/display, Settings decomposition, saved presets and server-playlist work remain in [the holistic roadmap](2026-10-18-holistic-polish-and-roadmap.md). This document does not replace those feature decisions.
- [ ] Live credentialed Last.fm/ListenBrainz love-policy verification remains outstanding per DEVLOG 2026-10-21j; unrelated to the current push/control failures.

Before closing any row, write the implemented revision, exact regression/CI evidence, device result if required, and residual limitations. Update this register and its linked entry points together. Do not let a planned test name become a citation to a nonexistent test.

## 7. Platform references used in this investigation

- [Apple WWDC22: media metadata publishing and playback interactions](https://developer.apple.com/videos/play/wwdc2022/110338/), manual publishing around 12:59–13:25: rate/elapsed metadata must follow significant state changes; automatic `MPNowPlayingSession` publishing requires AVPlayer and is not a drop-in for this AVAudioEngine graph.
- [Apple: controlling background audio](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/MediaPlaybackGuide/Contents/Resources/en.lproj/RefiningTheUserExperience/RefiningTheUserExperience.html): remote handlers return command status; metadata publication and command execution are separate responsibilities.
- [Apple: AVAudioEngine.pause](https://developer.apple.com/documentation/avfaudio/avaudioengine/pause%28%29): graph pause is a separate operation from pausing its player nodes. This API description does not prove the system-icon hypothesis.
- [Apple: MPNowPlayingInfoCenter.playbackState](https://developer.apple.com/documentation/mediaplayer/mpnowplayinginfocenter/playbackstate): documented with macOS playback-state integration. Do not propose setting this property as an unverified iPhone fix.

No secondary report or anecdotal workaround is treated as proof of this device's root cause. Do not create a silent auxiliary AVPlayer or migrate the audio engine just to obtain a different Now Playing integration.

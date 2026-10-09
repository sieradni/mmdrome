# Session Resilience & Field Verification (2026-10-08)

**Status**: **A1, B1 and B2 LANDED 2026-10-08** (source complete; iOS behavior still
awaits the §8 field session — no local Swift toolchain, E5). A2/A3/A4 remain proposed.
This document is the single source of truth for the work; each item is independently
shippable, and every native item's runtime behavior is judged in the field (protocol:
`docs/STREAMING-SELF-TEST.md` S1–S6 + the new I-series below).

**Origin**: one HUD Copy dump (2026-10-08 22:32Z, native iOS, LDM opus@128, 1.2.56
build) analyzed in full. It landed three findings and one confirmation:

1. a route-change/interruption storm at the tail left playback paused with a **stale
   `interruptionActive` flag** (9 `.began`, 0 `.ended` delivered; playback provably
   continued for ~1 h after the first `.began`);
2. the long-standing Dexie `AbortError` rides **ordinary track advances** (20
   unhandled rejections across 13/17 advances), not just queue clears — and one
   producer (`enqueuePendingScrobble`) cannot tell an abort from a duplicate, so a
   Listen can be silently dropped;
3. cover `meanLoadMs` is an artifact of webview suspension (0 failures, 2 ms hot
   hits), so the diagnostic needs to stop averaging suspension spans;
4. **confirmation the 1.2.56 A16 work reached the phone but its field protocol has
   NOT been run** (`streamEpochCount: 0`, `seekLatencyReports: 0`), while the first
   real ladder evidence exists (`prefetchLadderHolds: 2`).

**Related**: `docs/plans/2026-10-07-seek-intent-and-stream-epochs.md` (A16; its §6
deferred register and §7 risk table are updated by this work), the network-churn plan
`docs/plans/2026-10-02-network-churn-and-prefetch-resilience.md` (one field item still
open), AGENTS.md A15/A16, E5 (no local Swift toolchain).

---

## 1. Verified ground truth

Read out of source during the dump analysis (2026-10-08). When touching a referenced
symbol, verify the anchor and fix this table — per the anti-rot contract.

| # | Fact | Anchor |
|---|---|---|
| 1 | SessionController logs **every** `.ended` (all three branches: re-activated / wasPlaying=false / shouldResume), so a field log with 9 `.began` and 0 `.ended` proves non-delivery by iOS, not a logging gap. | `native/BackgroundAudio/ios/SessionController.swift` `handleInterruption` |
| 2 | `setInterruptionActive` is the engine's ONLY writer of `interruptionActive`, fed by the `.began`/`.ended` edge. Nothing today clears it on a successful start. | `AudioEngine.swift` `setInterruptionActive` (~L863), `BackgroundAudioPlugin.swift` `session.onInterruptionStateChanged` |
| 3 | `noteEngineStartSucceeded()` clears the ladder run and `engineUnavailable` — **but not `interruptionActive`**. | `AudioEngine.swift` `noteEngineStartSucceeded` |
| 4 | While `interruptionActive` is true the pure policy returns `retryLater(1.0 s)` for EVERY failure kind and count — including `startFailed`, where session activation already succeeded (proof the interruption is over). No escalation, no surface. | `BackgroundAudioCore/Sources/Core/EngineRecoveryPolicy.swift` `decide` |
| 5 | `handleRouteChange` logs only `oldDeviceUnavailable` at info; every other reason is debug-level, and no line carries the output port identity (name/type) or the previous port. | `SessionController.swift` `handleRouteChange` |
| 6 | `saveQueue()` is fire-and-forget at every call site (store updaters, `markRecent`, `setActiveQueueIndex`, the manager's native-snapshot writes); its rejections are unhandled. | `src/lib/queueManager.ts` `_mutateQueue`/`markRecent`, `src/stores/appState.ts` `setActiveQueueIndex` |
| 7 | `enqueuePendingScrobble` catches ALL errors and returns `false`, which every consumer reads as "already queued" — an aborted `add` silently drops the Listen. | `src/lib/db.ts` (~L373–379), `src/lib/scrobbleFlush.ts` `dexieStore.enqueue`, `src/lib/scrobbleManager.ts` (`void ...enqueue`) |
| 8 | AbortError clusters sit in the first ~10–15 min after each JS-active start/resume (17:51–17:57, 20:57–21:13, 22:20–22:28) and land 10–400 ms after a `refreshQueue`; the existing backlog note guessed "the clear racing the live queue write". The correlation with bulk metadata writes at session start is the lead, NOT yet a verdict. | DEVLOG 2026-09-21b backlog #3; dump `jsEvents` |
| 9 | `coverStats` mean is `loadMsTotal / loaded`; `loadMs` is a raw `performance.now() − armedAt` per arm, with no suspension marking, so backgrounded spans dominate the mean. | `src/lib/coverStats.ts` `summarizeCoverStats`; `src/components/LazyThumb.svelte` `noteMainCover` |
| 10 | `seekEpochs` is hydrated, persisted, pushed to the engine at boot and on change, and scrubbed into the HUD dump — but no UI control writes it, so the §8 rollback cannot be reached on a phone and **S4 is blocked**. | `src/stores/appState.ts` (hydration list), `src/lib/playbackManager.ts` `setSeekEpochs` push sites, `docs/STREAMING-SELF-TEST.md` S4 |
| 11 | The dump carries A16 fields (`seekLatency`, `streamEpoch*`, `prefetchLadder*`), so the phone is on a build with the seek/epoch work; `streamEpochCount: 0` and `seekLatencyReports: 0` prove **no S-scenario ran**. | dump `nativeDebug` |
| 12 | `deriveSeekCapability` declares `canServerOffset = true` whenever direct play is not CERTAIN; "certain" requires a known source bitrate with `maxBitRate >= bitrate`. Unknown bitrate ⇒ optimistic. The plan's §7 hazard (a direct-played Ogg/Opus original under-claiming exactly like a young epoch) lives in exactly this optimistic band. | `src/lib/playbackCore/seekCapability.ts`; plan §2.5, §7 |
| 13 | One verdict site reads the container claim and writes a base, before any schedule exists. | `AudioEngine.swift` `resolveStagedPlacement` (~L3279, call sites ~L3540/L3606) |
| 14 | Also verified healthy in the same dump: 3/3 fresh-connection retries recovered (one row promoted whole +1.7 s later), 14 network flaps suppressed by the churn latch, 0 engine start failures, loader idle with 22 cached rows, maturation playable/headered as expected, settings scrub clean. | dump + DEVLOG 2026-10-02e/f |

---

## 2. Workstreams

> File-level edit plan for every item below: **§7**. Operator steps for the field
> session: **§8**.

### Phase A — local (JS) changes, fully verifiable here

**A1. HUD control for `seekEpochs` (unblocks S4 and the §8 rollback promise).**
Add a two-chip `auto | off` control in the HUD's STREAM SELF-TEST section that calls
`updateSetting('seekEpochs', …)`; the existing manager subscription does the live push,
so there is nothing new to wire. Placement rationale: the Settings surface would advertise
an internal rollback as a product feature; the HUD is debug-scoped, already reachable on
the phone (Settings → About), and is where the protocol is driven from.
Tests: extend `tests/seekEpochsKillSwitch.test.ts` (write-then-push, and that `off`
reaches the engine before the next engage). Acceptance: S4 becomes runnable.

**A2. Close the direct-play hazard band (decision + client-side rule).**
Two steps:
1. Verify against Navidrome source whether the direct-play resolution considers
   `maxBitRate` at all (fact 20 in the 2026-10-07 plan records the format equality
   only). If it does not, format-equality alone is the direct-play predicate and the
   optimistic band is unsafe whenever `requested === fileType`.
2. Depending on (1), tighten `deriveSeekCapability`: a row whose requested format
   equals its source suffix may only declare `canServerOffset` when a transcode is
   PROVEN (known cap strictly below a known source bitrate). Otherwise declare
   `false` — losing epochs on those rows costs latency, while the current behavior can
   schedule head-first audio at a seek target (silent wrong position).
3. Wire the runtime corroboration the plan's §7 already names ONLY if (1) shows the
   format/codec-family discriminator is actually decisive for reachable rows; for a
   same-codec opus library it is blind (both containers are Ogg/Opus), so the client
   rule is the load-bearing fix.
Tests: `tests/seekCapability.test.ts` gains the format-equality matrix (known/lower/
higher/unknown bitrate × equal/different format).

**A3. Dexie write hygiene (stop the silent drop, name the abort).**
1. Route queue persistence through one helper (`persistQueue(source)`) that catches,
   logs ONCE per session per source at info level, and never rejects unhandled; the
   in-memory store stays authoritative, so a failed write is a staleness bug, not a
   playback bug.
2. Split `enqueuePendingScrobble`'s catch: a `ConstraintError` is a duplicate →
   `false`; anything else (notably `AbortError`) retries once and, on a second
   failure, returns `false` WITH a danger log naming the error — never silently
   indistinguishable from a duplicate.
3. Instrument first, fix second: correlate the abort clusters with the bulk metadata
   writes (large `bulkUpsertMetadata` chunk transactions at session start / reconnect)
   before changing transaction shapes. The dump's timing makes "clear racing the live
   write" an insufficient explanation; do not enshrine it.
Tests: `tests/scrobbleFlush.test.ts` (abort-vs-duplicate), a db-helper test for the
catch, and whichever repro the instrumentation yields.

**A4. Suspension-aware cover stats.**
Keep a bounded latency SAMPLE (or derive it from the ring) and report median + p95
beside the mean; flag or exclude samples whose arm→onload span crosses a visibility
gap. The HUD line and the Copy payload both read the summary, so the fix is one pure
core change + one display change.
Tests: `tests/coverStats.test.ts` (median, exclusion of a marked suspension span).

### Phase B — native changes (CI compile + `swift test`; behavior in the field)

**B1. The interruption flag can no longer go stale.**
1. Clear `interruptionActive` (with a `.info` event line stating it was stale) on any
   successful `activateSessionAndStart` — a re-activated session is proof the
   interruption is over.
2. Feed the policy only `interruptionActive && failure == .sessionNotActive`: a
   `startFailed` failure means session activation SUCCEEDED, which is itself proof the
   interruption is over, so clear the flag before deciding and let the ladder
   escalate to rebuild. A `sessionNotActive` failure keeps the wait behavior — that is
   the legitimate interruption shape.
3. Cheapest observability: the engine's `getDebugState` carries interruption
   begin/end counters, so the next dump reads "9 begins / 0 ends" at a glance instead
   of mining the ring.
Tests: `EngineRecoveryPolicyTests.swift` (the wait branch only for `sessionNotActive`;
`startFailed` escalates) + a new pure-core pin if the clear decision moves into a core.

**B2. Route-change diagnostics that can name the flapping device.**
Log every route change at info with the reason, and carry the previous/current output
port name + type (the storm's 10 events were indistinguishable in the dump). Keep the
`oldDeviceUnavailable → pause` policy untouched.
Tests: compile-only (E5); the field evidence is the next storm's log lines.

### Phase C — the device session (the gate; nothing below is verifiable here)

One session, one build carrying A1–A4 + B1–B2, run in the order S1, S5, S2, S3, S4,
S6 (S4 now unlocked), plus:

- **I1 — interruption end-to-end.** Play; provoke a route change (unplug headphones /
  toggle BT); confirm the `.began` line, then confirm B1's clear line when playback
  resumes. The 9-begins/0-ends shape is the acceptance case: the flag must not stay
  true for the rest of the session.
- **I2 — the storm quiet path.** If the same route flapping recurs, the new B2 lines
  must name the port; paste them even if the session is otherwise healthy.
- **N1 — the still-open network item** from 2026-10-02: a `-1010`/`network lost`
  shape must show the resume path firing without a stale-`resumeData` loop.
- **D1 — the direct-play/opus question**: a far seek on an opus-sourced row under
  opus@128 either opens no epoch (A2 conservative) or shows a verdict that does not
  schedule a head-first body at base T.
- **L1 — latency legs** from S1/S2 are the input the PREEMPTION deferral names.

### Phase D — follow-ons (not started; listed so they are not silently lost)

- Cross-row PREEMPTION + same-row supersession: unblocked only by the download lane's
  deliberate-cancel veto plus L1 (the deferral's own prerequisite).
- Raw splice epochs (Phase 3 of the 2026-10-07 plan): fixture/CI-hosted, not
  device-blocked — but do not start before the Phase-2 field verdict lands, or the
  verdict will be re-litigated on a moving engine.
- Web virtual-timeline adapter: still a measurement spike first.

---

## 3. Device-verification gates (what is blocked, on what evidence)

| Gate | Blocks | Evidence required |
|---|---|---|
| S1 | A16 epoch acceptance (honored verdict, base, no 0:00 flash) | one pasted self-test bundle |
| S2 | the parked-seek/late-leg rule | one bundle |
| S3 | the offset floor actually applies | one bundle (negative control) |
| S4 | the kill switch's field rollback | one bundle — A1 landed, the HUD chip flips it |
| S5 | the ladder hold/resume contract (first holds already exist) | one bundle with `prefetchHoldCount ≥ 1`, resume ≥ 1 |
| S6 | same-row `activeLoad` overlap | one bundle |
| I1 | B1's stale-flag clear | an interruption + resume session |
| I2 | B2's device naming | any route-change storm |
| N1 | the 2026-10-02 resume loop item | a network-loss dump |
| D1 | A2's reachability/decision | one opus-sourced far-seek bundle |
| L1 | PREEMPTION go/no-go | S1/S2 latency legs |

Until the gates clear: A16's native adapters remain compile-verified only
(`[not test-pinned: …]` in AGENTS.md A16), and every Phase D item stays deferred for the
reason already recorded — do not re-derive a new reason.

---

## 4. Sequencing

1. **A1** — smallest change, unblocks the protocol and the promised rollback.
2. **B1 + B2** — small, high-severity; bundle into the same build so one field session
   verifies A16 + interruption behavior together.
3. **A3** — protects scrobble data; independent of the device session.
4. **A2** — needs one server-source verification first; ship conservative, revisit
   with D1.
5. **Field session C** — S1, S5, S2, S3, S4, S6 + I1/I2/N1/D1/L1.
6. **A4** — anytime; diagnostics-only.
7. Then Phase D decisions from the collected numbers.

## 5. Anti-patterns (do not do)

- Do not clear `interruptionActive` on a `sessionNotActive` failure — that is the one
  shape that must keep waiting.
- Do not fix the abort storm by swallowing errors silently or by removing the
  persistence; the failure must be visible once, and the queue stays in-memory-correct.
- Do not open epochs where the server may direct-play (A2) until a runtime
  discriminator for same-codec sources exists.
- Do not average suspension-spanning cover samples into a "network" number.
- Do not re-order/renumber the S protocol; append I/N/D items so old pasted bundles
  stay readable.

## 6. Register updates (when items land)

- 2026-10-07 plan §6: the "control for the global kill switch" row closes with A1;
  the §7 direct-play row is superseded by A2's verified rule.
- AGENTS.md A16's `[not test-pinned]` clause gains the S/I protocol result once a
  field session lands; new invariants (stale-flag clear, abort-vs-duplicate) get
  their tests in the same change.
- DEVLOG entry per landing item, dated, with the anchors it relied on.

---

## 7. Code change plan (file-level, implementation-ready)

Order: **A1 → B1+B2 → A3 → A2 → A4** (same as §4). Local checks on every step:
`npm run check` (svelte-check + `tsconfig.app/node/test`), and targeted tests via
`node --test --import ./scripts/test-loader.mjs tests/<file>.test.ts`. Native items
ride `.github/workflows/ios.yml` (plugin compile + `swift test` for
`BackgroundAudioCore`) — no local Swift toolchain (E5), so they are compile-verified
here and behavior-verified in Phase C.

### 7.1 A1 — HUD `seekEpochs` control — **LANDED 2026-10-08**

- `src/components/DebugHud.svelte`:
  1. add `updateSetting` to the existing `../stores/appState` import list, and declare
     `const seekEpochModes = ['auto', 'off'] as const` (`as const` is REQUIRED: a plain
     string array widens `mode` to `string` and `updateSetting('seekEpochs', mode)`
     fails `npm run check`);
  2. inside the open STREAM SELF-TEST block (above the Run/ Copy row at ~L604), add a
     two-chip row rendering `$settings.seekEpochs ?? 'auto'`:

     ```svelte
     <div class="mb-1 flex items-center gap-1 text-[10px]">
       <span class="text-white/50">seekEpochs</span>
       {#each seekEpochModes as mode}
         <button onclick={() => updateSetting('seekEpochs', mode)}
           class="rounded px-2 py-0.5 {($settings.seekEpochs ?? 'auto') === mode
             ? 'bg-cyan-500/40' : 'bg-white/10 hover:bg-white/20'}">{mode}</button>
       {/each}
     </div>
     ```

     `updateSetting` is already typed (`seekEpochs?: 'auto' | 'off'`, appState.ts:145);
     the live engine push already exists (`playbackManager` subscription L499 + boot
     push L363) — **no new wiring**.
- Test: extend `tests/seekEpochsKillSwitch.test.ts` with one case driving the exact
  control path — `updateSetting('seekEpochs', 'off')` → assert the FakeEngine received
  `setSeekEpochs:off` (the existing cases use `settings.set`; the control calls
  `updateSetting`, which also persists, so pin the real path).
- `docs/STREAMING-SELF-TEST.md` §S4: drop the “BLOCKED — no control in the UI” wording
  and point at the HUD chip (the anti-rot contract: the protocol must not claim a
  blocker that no longer exists).
- Acceptance: `npm run check` green; in the field, S4 becomes runnable (the chip value
  is what the Copy dump's scrubbed `seekEpochs` reports).

### 7.2 B1 — stale `interruptionActive` — **LANDED 2026-10-08**

- `native/BackgroundAudioCore/Sources/Core/EngineRecoveryPolicy.swift`:
  1. add a public rule + doc block stating the why (2026-10-08 dump: 9 begins / 0 ends,
     playback provably continued — the flag can go stale and the old unconditional
     branch disarmed the ladder):

     ```swift
     /// Only `sessionNotActive` is consistent with a genuinely active
     /// interruption. `startFailed` means session ACTIVATION succeeded (proof the
     /// interruption is over); `mediaServicesReset` wants a rebuild by definition.
     public static func interruptionBlocksRecovery(
         failure: EngineFailureKind, interruptionActive: Bool
     ) -> Bool { interruptionActive && failure == .sessionNotActive }
     ```

  2. in `decide`, replace `if interruptionActive { … }` with
     `if interruptionBlocksRecovery(failure: failure, interruptionActive: interruptionActive) { … }`.
- `native/BackgroundAudioCore/Tests/BackgroundAudioTests/EngineRecoveryPolicyTests.swift`
  — **two existing tests change meaning; this is a deliberate rule change, not an
  assertion weakening** (say so in the test comments):
  - `testInterruptionActiveAlwaysWaits` → split into
    `testInterruptionWaitsOnlyForSessionNotActive` and
    `testStartFailedEscalatesWhileTheInterruptionFlagIsStale` (retry → rebuild → surface);
  - `testInterruptionActiveOutranksMediaServicesReset` → **inverted**: a
    media-services reset rebuilds even with the flag true (an interruption cannot
    survive a services reset; waiting is the 2026-10-04 failure class).
- `native/BackgroundAudio/ios/AudioEngine.swift`:
  1. new public callback beside `onEngineRecovered` (~L133):
     `public var onStaleInterruptionCleared: (() -> Void)?`;
  2. new private `clearStaleInterruptionFlag(reason: String)`: clears
     `interruptionActive`, bumps `staleInterruptionClears`, emits
     `eventAdd(.info, "engine", "interruption flag cleared as STALE — \(reason); no ended edge was delivered")`,
     fires the callback;
  3. call it from `noteEngineStartSucceeded()` (a successful start is the same proof)
     and from `handleEngineStartFailure` before `EngineRecoveryPolicy.decide` when
     `interruptionActive && !interruptionBlocksRecovery(failure:…)`;
  4. counters in `setInterruptionActive` (edges only): `interruptionBeginCount`,
     `interruptionEndCount`; add `"interruptionBegins"`, `"interruptionEnds"`,
     `"staleInterruptionClears"` to `debugState()` (beside `interruptionActive`, ~L2220).
- `native/BackgroundAudio/ios/SessionController.swift`: new
  `func clearStaleInterruption()` — flips `isInterrupted = false`, resets
  `wasPlayingBeforeInterruption = false`, logs the same stale line, and **does not**
  fire `onInterruptionStateChanged`. This closes the divergence hole: without it a
  later genuine `.began` would see no edge (`setInterrupted`'s guard) and the engine
  would silently stop believing real interruptions.
- `native/BackgroundAudio/ios/BackgroundAudioPlugin.swift`: wire
  `engine.onStaleInterruptionCleared = { [weak self] in self?.session.clearStaleInterruption() }`
  beside the existing `onEngineRecovered` block (~L212).
- Acceptance: I1's bundle shows the stale-clear line (or simply a non-true flag after
  a resume) on the 9-begins/0-ends shape.

### 7.3 B2 — route diagnostics — **LANDED 2026-10-08**

- `native/BackgroundAudio/ios/SessionController.swift` `handleRouteChange`: log EVERY
  reason at `.info` with previous/current output-port identity; keep
  `oldDeviceUnavailable → pause` untouched:

  ```swift
  private func portTag(_ p: AVAudioSessionPortDescription?) -> String {
      p.map { "\($0.portName)[\($0.portType.rawValue)]" } ?? "none"
  }
  ```

  ```swift
  let prev = (info[AVAudioSessionRouteChangePreviousRouteKey]
              as? AVAudioSessionRouteDescription)?.outputs.first
  let now = AVAudioSession.sharedInstance().currentRoute.outputs.first
  let fate = reason == .oldDeviceUnavailable ? " → pause" : " (no action)"
  self.event(.info, "route change reason=\(reason.rawValue) prev=\(portTag(prev)) now=\(portTag(now))\(fate)")
  ```

- Tests: compile-only (E5); the field evidence is the next storm's lines (I2).

### 7.4 A3 — Dexie write hygiene

- **New** `src/lib/queuePersistence.ts` (keeps db.ts store-free and gives ONE
  once-per-source-per-session log):

  ```ts
  import { saveQueue, type PlayQueueState } from './db'
  import { dbgAlways } from './debugLog'

  const reported = new Set<string>()

  /** Fire-and-forget queue persistence, made visible once per source per session
   *  (2026-10-08 dump: 20 unhandled AbortError rejections across 13/17 advances).
   *  The in-memory store stays authoritative — a failed write is a staleness bug,
   *  never a playback bug, but it must be named. */
  export function persistQueue(source: string, q: Omit<PlayQueueState, 'id'>): void {
    saveQueue(q).catch((err: unknown) => {
      const name = (err as { name?: string })?.name ?? 'Error'
      if (reported.has(source)) return
      reported.add(source)
      dbgAlways('sync', `queue persist failed (${source}): ${name} — in-memory queue unchanged; further ${source} failures suppressed this session`)
    })
  }
  ```

  Replace every `saveQueue(...)` call site with `persistQueue('<site>', …)`, source
  labels by site: `queueManager.ts` L81 `mutateQueue`, L155 `markRecent`, L173
  `setActiveIndex`, L186 `resetRecentWindow`, L226 `removeFromUserQueue`, L286
  `playAll`, L353 `fillAutoQueue`, L374 `rebuildAutoQueue`; `appState.ts` L425
  `initReconcile`, L639 `setActiveQueueIndex`; `playbackManager.ts` L876
  `setQueueAndPlay`, L1507 `rescue`, L1546 `selectTrack`. Keep `saveQueue` exported.
- `src/lib/db.ts` `enqueuePendingScrobble`: stop collapsing every error into
  "duplicate". Put the predicate in a pure module so it is Node-testable without Dexie:
  **new** `src/lib/scrobbleEnqueuePolicy.ts` —

  ```ts
  export function isDuplicateEnqueueError(err: unknown): boolean {
    return (err as { name?: string })?.name === 'ConstraintError'
  }
  ```

  then `enqueuePendingScrobble`: ConstraintError → `false`; anything else → retry the
  `add` once; second failure → `dbgDanger('sync', 'pending scrobble enqueue failed: <name> — event NOT queued')`
  and `false` (return type unchanged — `FlushStore.enqueue` stays `Promise<boolean>`).
- **Instrument before reshaping transactions**: the dump correlates the abort clusters
  with session-start/reconnect bulk writes; do NOT change transaction shapes until a
  next dump shows the named source/error pattern. The helper IS the instrument.
- Tests: `tests/scrobbleEnqueuePolicy.test.ts` (new, pure: ConstraintError →
  duplicate; AbortError → retryable; unknown → retryable) + existing
  `tests/scrobbleFlush.test.ts` unchanged.

### 7.5 A2 — direct-play hazard band

- **Step 0 (server verification, before code)**: in Navidrome `core/stream/legacy_client.go`
  + the direct-play matcher it calls, answer whether an explicit `format` equal to the
  source suffix still direct-plays when `maxBitRate` is strictly below the source
  bitrate. Record the outcome in §1 (new row) either way:
  (i) bitrate cap honored → same-format + known cap < known source bitrate is a PROVEN
  transcode; (ii) format equality alone direct-plays → any same-format row may
  direct-play and never gets an epoch declared.
- `src/lib/playbackCore/seekCapability.ts` — replace the `directPlayCertain` block with
  a same-format split (keep `cap.paramName`/`sourceBitrate`/`sourceFileType` shape):

  ```ts
  const sameFormat = fileType != null && requested !== '' && requested === fileType
  if (!sameFormat) { cap.canServerOffset = true; return cap }  // forced transcode
  // Same-format: the server's direct-play profile can match on format alone and a
  // direct-play resolution IGNORES the offset (2026-10-07 plan fact 20) — the §7
  // silent-wrong-position band. Require a PROVEN forced transcode (outcome (i));
  // under outcome (ii) this is unconditionally false.
  cap.canServerOffset =
    input.bitrate != null && input.bitrate > 0 &&
    input.transcode.maxBitRate < input.bitrate
  ```

  Scope note: rows with an UNKNOWN `fileType` stay optimistic (2026-10-07 plan §2.5's
  untagged-row decision — the runtime verdict + D1 field evidence decide whether to
  tighten further). Cost statement for the opus@128 library: every same-format
  untagged row becomes wait-only — that is the accepted trade (latency vs silent wrong
  position).
- Tests: `tests/seekCapability.test.ts` matrix — same format × {cap below, cap equal,
  cap above, unknown bitrate}; different format → can; raw → false; no fileType →
  unchanged optimistic.

### 7.6 A4 — suspension-aware cover stats

- `src/lib/coverStats.ts` (update the header comment: pure core + one GUARDED lifecycle
  adapter, viewState.ts precedent):
  - `CoverEvent` gains `suspensionMs?: number`; `CoverStatsState` gains
    `latencies: number[]` (cap `COVER_LATENCY_SAMPLE_CAP = 200`) and `suspendedSamples`;
  - pure `suspensionOverlap(spans, from, to)` + module-level bounded `hiddenSpans`
    (`{start, end|null}[]`, cap ~50) updated by a `typeof document !== 'undefined'`
    guarded `visibilitychange` listener; exported `suspensionMsSince(armedAt, now)`;
  - `recordCoverEvent`: a main/ok sample with `suspensionMs < SUSPENSION_TOLERANCE_MS`
    (250 ms) appends to `latencies` and `loadMsTotal`; a span-crossing sample bumps
    `suspendedSamples` instead (it stays in the ring so the HUD row can show it);
  - `summarizeCoverStats`: `medianLoadMs` + `p95LoadMs` from `latencies` (sorted copy),
    `meanLoadMs` now over clean samples only, plus `suspendedSamples`.
- `src/components/LazyThumb.svelte` `onload` (~L355): `const now = performance.now();`
  pass `suspensionMs: suspensionMsSince(armedAt, now)` through `noteMainCover`; failure
  path unchanged.
- `src/components/DebugHud.svelte` COVERS section (~L657): show
  `median X ms · p95 Y ms · suspended N`; recent rows gain a `susp` marker when
  `ev.suspensionMs` is non-zero. The Copy payload flows from the summary (additive).
- Tests: `tests/coverStats.test.ts` — median/p95; a suspension-crossing sample excluded
  from every latency aggregate but counted; `suspensionOverlap` edges (arm before
  hidden, arm after resume, span fully hidden).

---

## 8. Operator checklist (the steps only you can run)

**Why one dump is not enough.** A Copy dump is a passive recorder: it can only show
what already happened. The dump did its job — it produced the diagnosis, proved the
phone is on the seek/epoch build, and surfaced the stale-interruption defect. But an
*epoch* only exists while a far seek is happening, a *kill switch* only proves itself
when flipped, and the *stale-flag clear* only exists when an interruption ends. The
A16 counters (`streamEpochCount`, `seekLatencyReports`) read `0` in the dump precisely
because no scenario was provoked. So the next round is: run the scenarios, paste one
bundle per scenario.

**You can start BEFORE new code lands.** S1, S2, S3, S5, S6, D1 and N1 run on the
1.2.56 build already on the phone. Only S4 (needs A1's chip) and I1/I2 (need B1/B2)
wait for the next build.

| Scenario | Needs new build? | One-line provocation |
|---|---|---|
| S1 far seek on a transcode | no | >8-min uncached track from the start; tap 60–70 % of the seek bar in ONE tap |
| S2 paused seek then play | no | seek while paused, then press play |
| S3 trivial scrub (negative control) | no | scrub ~2 s (below the 3 s offset floor) |
| S4 kill switch off | **yes (A1)** | flip `seekEpochs → off`, repeat S1, flip back |
| S5 ladder hold | no | start a big load/scan while playing; expect `prefetchHoldCount ≥ 1` |
| S6 same-row activeLoad overlap | no | rapid next/prev across one row's boundary |
| D1 opus far seek | no | exactly S1 on this opus-sourced library |
| N1 network loss | no | airplane mode on during play, then off |
| I1 interruption resume | **yes (B1)** | provoke an interruption (call/Siri/other app takes audio), let it end |
| I2 route storm | **yes (B2)** | unplug/toggle headphones or BT mid-play |

**Pre-flight (once per session):** Debug HUD on (Settings → About); open STREAM
SELF-TEST and tick **“+ watch 25s”**; switch the verbose domain `preload` on; keep
Transcoding on (opus 128) and LDM as you normally listen. Each scenario is ONE `Run
test` press and ONE pasted block — the epoch verdict, the ladder hold, and the seek
latency are judged together.

**Per scenario:** play / provoke as above, run STREAM SELF-TEST → “Run test”; the
report auto-copies to the clipboard. Paste it here labelled `S1`, `S4`, `I1`, … The
exact per-scenario taps and the failure signatures worth pasting verbatim live in
`docs/STREAMING-SELF-TEST.md` §S1–S6 (+ the I/N/D items above).

**Priority order if you only do a few:** S1 (unblocks the A16 acceptance and the
preemption decision) → I1 (proves B1) → S4 (proves the rollback) → S5/S2/S6/D1/N1.

**When idle:** nothing. The existing backlog needs no further passive dump until one
of the above produces a bundle.

# Design — Network-churn resilience + prefetch recovery (2026-10-02)

**Status**: Phase 1 LANDED (the retry dedupe fix). **Phase 2 LANDED** (2026-10-02:
`decideNetworkStability` asymmetric debounce + churn latch in `networkHysteresis.ts`,
wired in `networkMode.ts`, surfaced in the HUD `net:` line + Copy `lowData.stability`;
`tests/networkHysteresis.test.ts` rewritten, 11 cases; `npm run check` clean).
**Phase 3 LANDED** (2026-10-02: park-and-drain in `AudioEngine.swift::prefetchUpcoming`
via the pure `PrefetchChain` planner — `State`/`Parked`/`Action` + `nextAction` /
`applyDownload` / `applyRetry`; `PrefetchChainTests.swift` extended with the planner
matrix + the poisoning-row scenario; Swift compile/tests run in CI per E5).
**Phase 4 LANDED** (2026-10-02: pure `NetworkRearmDebounce` trailing debounce in
`BackgroundAudioCore` + `NetworkRearmDebounceTests`; the plugin's
`NetworkMonitor.onNetworkChanged` handler debounces and calls the new
`NativeAudioEngine.rearmPrefetchAfterNetworkChange()`, which skips while a staged stream
owns the bandwidth; `jsEvents`/native log carry `network re-arm:` lines).**Scope**: bug fixes only. Explicitly OUT of scope at the time: progressive playback for
transcoded variants (the "a song won't play until it's fully downloaded" hunch). That is
real and correct at the time — `TrackFileLoader.streamDecision` required
`requested == .raw`, so under LDM/transcode every tap was a full download by design. It is a
capability backlog item (extends A15), not a defect, and this plan deliberately did not
touch it. **FOLLOW-UP LANDED (2026-10-02, same session):** transcode streaming — see
`docs/plans/2026-09-21-native-streaming.md` for the design and the new anchors.

**Field evidence**: the 2026-10-02 HUD dump (`Aiyru - So Starry`, iOS, cellular +
`lowDataOnCellular` → `opus@128`). Preload stopped after rows 1–2; `prefetch FAILED row 3
… attempt 1/3: cannot parse response — retrying` with **no attempt 2**; four transfer
failures, each ~0.4–0.5 s after an `isExpensive` transition; `effectiveLowData: true`
engaged off a metered report while the user believed they were on Wi-Fi.

---

## 1. What the dump actually proves

1. **The prefetch retry never ran.** The chain died at its first failure, so
   `preloadCount: 5` settled at however many rows preceded it. This is the "stops on the
   3rd upcoming preload" report, exactly.
2. **The failures are interface-churn casualties.** `cannot parse response` (URLSession
   `-1017`) and `network connection was lost` cluster immediately after `isExpensive`
   flips. The OS tore the TCP transfers down; no app-side parser is implicated.
3. **The app amplifies the churn.** Every raw flip (before filtering) used to re-derive
   transcode URLs, preload economics, the native params push and `refreshQueue`
   fan-outs — and the classification still flips back eagerly (symmetric 3 s, no churn
   latch).

---

## 2. Prior art — "isn't Wi-Fi Assist solved already?"

Partly. Four mitigations exist; each covers a *different* layer, and one of them never
actually worked.

| Mitigation (landed) | Layer | What it covers | What it does NOT |
|---|---|---|---|
| Connectivity Assist confirmed as the churn source (`2026-09-21d/e` DEVLOG: with it off the log is clean) | diagnosis | — | app cannot toggle a device setting; only the user can |
| Resumable downloads — `resumeData` + `.part` Range-append (`DownloadResume.swift`) | transfer recovery | re-fetch does not restart from zero | the in-flight transfer still dies |
| Byte-exact announced gate (`isShortOfAnnouncedBytes`) + transcode duration corroboration (`transcodeDurationCorroborated`) | trust boundary | a cut transfer can no longer become a poisoned cache entry | does not prevent the cut |
| Cellular flap hysteresis (`networkHysteresis.ts`, `FLAP_CONFIRM_MS` 3 s) | JS store | suppresses sub-3 s blips from re-deriving consumers | symmetric, no churn latch; does not reach the native loaders |
| Prefetch retry, 3 × 1.5 s (`prefetchUpcoming`) | native chain | *intended* to recover the preload window | **was a silent no-op** until Phase 1 |

**Answer**: Wi-Fi Assist is *still an environmental trigger*. It is a device-global
Cellular setting (`Settings → Cellular → Wi-Fi Assist`) that silently routes traffic over
cellular when Wi-Fi looks poor; an app cannot detect it, disable it, or distinguish it
from a genuine handoff. The app-side job is therefore twofold: (a) do not amplify the
churn (Workstream B), and (b) recover quickly when the churn kills a transfer
(Workstream A, plus the re-arm trigger in Workstream C). Workstream B's new latch is the
piece the user is asking for: **when the connection keeps changing, hold the conservative
classification instead of flipping back instantly.**

---

## 3. Ground-truth anchors

| Fact | Anchor |
|---|---|
| Retry passes a dedupe set — must be the PRE-insert set | `AudioEngine.swift::prefetchUpcoming` (~3540); pure core `PrefetchChain.swift`; `PrefetchChainTests.swift` |
| Chain is serial, one download at a time (bandwidth discipline) | `prefetchUpcoming` doc comment (~3523) |
| Generation guard kills in-flight chains on queue replacement | `prefetchGeneration += 1` in `setQueue`/`setQueueAndPlay`/`refreshQueue`; re-arm sites call `prefetchUpcoming(from: activeIndex)` |
| Loader recovers on failure (in-flight cleared, error delivered) | `TrackFileLoader.prefetch` completion hop (~1600) |
| Staged streams own the bandwidth; a staged load deliberately skips the chain arm | `loadAndStart` staged note (~3508) |
| Raw network signal + no-op dedupe | `NetworkMonitor.swift`; `BackgroundAudioPlugin.swift::load` (~88) |
| Filtered classification + store-write gate | `networkHysteresis.ts::decideNetworkStability` (was `decideCellularFlap`; renamed in Phase 2); `networkMode.ts::wireNative` |
| `effectiveLowData` composition | `networkMode.ts` (~64) |
| LDM transition side-effects | `playbackManager.ts::_subscribeShared` (~584) |
| `osLowData` must ride live, never filtered | `networkMode.ts` comment; `tests/networkHysteresis.test.ts` |
| Prefetch re-arm follows the PATH bit only | `BackgroundAudioPlugin.swift` (`pathChanged` guard, 2026-10-02 review) |

---

## 4. Workstream A — prefetch chain recovery

### A1 — retry dedupe fix (LANDED, 2026-10-02)

`PrefetchChain.step(seen:next:)` returns **both** snapshots from one decision:
`advancedSet` (row marked seen) for walking on, `retrySet` (pre-insert) for re-attempting.
`prefetchUpcoming` consumes them explicitly. Test-pinned by `PrefetchChainTests.swift`
(incl. the exact regression: re-entry with `retrySet` re-attempts, with `advancedSet`
stops). Rationale and history in `docs/DEVLOG.md` (2026-10-02).

### A2 — retries must not head-of-line block the window

The retry still sleeps **inside** the serial walk: a row that fails 3× holds every row
behind it for ~4.5 s. On a churning link that is the difference between "the window
slightly lags" and "the window is empty".

Design — **park-and-drain**, keeping the one-download-at-a-time discipline:

- On a row failure (attempts remain), **park** the row (index + attempts used) and
  **advance the primary walk immediately** to the next row.
- When the primary walk reaches the end of the window, **drain** the parked rows
  sequentially, oldest first, with the existing 1.5 s backoff, up to
  `prefetchMaxAttempts` per row. A row that succeeds during the primary walk (cached or
  re-armed elsewhere) is dropped from the parked set by id.
- Parked state is **generation-scoped**: a queue replacement bumps `prefetchGeneration`
  and the parked set dies with the chain, like every other chain state.
- The whole decision is the pure `PrefetchChain` planner (`State` / `Parked` / `Action`
  with `nextAction` / `applyDownload` / `applyRetry`), and the engine is a thin
  interpreter — the F2 pattern the rest of the engine already follows.

Acceptance: a window of 5 with row 3 permanently failing still fills rows 1, 2, 4, 5
before the drain re-attempts row 3; a window of 5 with all rows failing still visits all
5 at least once before the first retry.

---

## 5. Workstream B — network classification (`networkHysteresis.ts`)

### B1 — asymmetric debounce + churn latch (pure core)

Replace the symmetric 3 s hold with two behaviours the user asked for: a change must be
*sustained* to commit, and a connection that keeps changing is **held in the
conservative (metered) state**.

Constants (a starting point to tune from dumps; all exported and test-pinned):

| Constant | Value | Meaning |
|---|---|---|
| `CONFIRM_TO_METERED_MS` | 2000 | entering metered — short; metered is the safe state |
| `HOLD_TO_UNMETERED_MS` | 12000 | leaving metered needs 12 s of *continuous* unmetered raw |
| `CHURN_WINDOW_MS` | 20000 | window over which raw flips are counted |
| `CHURN_MIN_TRANSITIONS` | 3 | flips within the window arm the latch |
| `CHURN_HOLD_MS` | 30000 | the latch duration, refreshed by each new flip |

State machine (`decideNetworkStability(raw, now, state) → verdict`):

```
if effective == null:              # boot — adopt the first snapshot immediately
    effective = raw; changed = true; return

# 1. record raw flips, bounded to CHURN_WINDOW_MS
if raw != lastRaw: transitions.push(now); lastRaw = raw
transitions = transitions.filter(t => now - t <= CHURN_WINDOW_MS)

# 2. churn latch (refreshed by continuing churn)
if transitions.length >= CHURN_MIN_TRANSITIONS: latchedUntil = now + CHURN_HOLD_MS
latched = latchedUntil != null && now < latchedUntil
if latchedUntil != null && now >= latchedUntil: latchedUntil = null   # released

# 3. while latched: pin metered; unmetered cannot commit
if latched: effective = true; candidate = null; return changed=(was not metered)

# 4. not latched: asymmetric confirm
if raw == effective: cancel candidate; return unchanged
window = raw ? CONFIRM_TO_METERED_MS : HOLD_TO_UNMETERED_MS
if candidate == raw && now - candidateAt >= window: commit raw
else: candidate = raw (keep the clock for a repeated same-value sample)
```

Why this shape:
- **Asymmetric** because entering metered is conservative and leaving it re-derives
  transcode/preload/queue economics — the costly direction must require more evidence.
- **Latch** because a burst of flips is a connectivity wobble, not two genuine handoffs;
  while it continues, the app should behave as if metered and stop thrashing.
- **Release** requires `CHURN_HOLD_MS` of quiet AND then `HOLD_TO_UNMETERED_MS` of
  sustained unmetered raw (the candidate clock starts at release) — so brief quiet gaps
  inside an ongoing wobble cannot sneak a flip through.

`osLowData` (the explicit user toggle) stays **live** and unfiltered — unchanged contract.

### B2 — wiring (`networkMode.ts`)

- `decideNetworkStability` replaces `decideCellularFlap`; the store-write gate stays as
  it is (compares the full `{isCellular, osLowData}` tuple — do not gate on
  `changed` alone; the `osLowData` drop bug is already recorded).
- Trail: keep the RAW line (`network exp=… ldm=…`) **and** add a filtered transition line
  (`network stability metered=… latched=… suppressed=…`) so a dump can tell OS churn from
  app-side decisions.
- Replace `networkFlapSuppressedCount()` with a snapshot accessor
  (`{ metered, latched, latchedUntil, suppressed, transitions }`) for the HUD/dump.

### B3 — observability

Debug HUD network block shows filtered `isCellular`, `latched` (+ remaining seconds),
`suppressed`, and recent transition count. This is the surface that lets the next dump
*prove* the latch is doing its job instead of inferring it.

### Acceptance

- A genuine Wi-Fi→cellular handoff commits metered within `CONFIRM_TO_METERED_MS`.
- A genuine cellular→Wi-Fi handoff commits unmetered after `HOLD_TO_UNMETERED_MS` of
  sustained unmetered.
- `exp=false→true→false→true` inside `CHURN_WINDOW_MS` never surfaces a flip; the store
  holds metered for `CHURN_HOLD_MS` past the last flip, then re-arms the unmetered window.
- The existing low-data composition and `osLowData`-lives-live tests still pass.

---

## 6. Workstream C — native resilience to a network change

The engine currently cannot know the network changed; it waits for the next advance or
the (now-fixed) 3-attempt retry. Add a **classification-free** recovery trigger so a
churned link self-heals within seconds, foreground or background.

**LANDED** implementation:
- `NetworkMonitor` already fires `onNetworkChanged` on every path update. The plugin
  feeds it to the pure trailing-debounce core `NetworkRearmDebounce`
  (`BackgroundAudioCore/NetworkRearmDebounce.swift`, `defaultWindowMs = 2500`), which
  collapses a burst of path updates into one re-arm (`noteChange(at:)` +
  `shouldFire(at:)` + `millisUntilEligible(at:)`; pinned by
  `NetworkRearmDebounceTests.swift`).
- On fire the plugin calls `NativeAudioEngine.rearmPrefetchAfterNetworkChange()` on main,
  which **bumps `prefetchGeneration`** (superseding any in-flight walk) and then runs
  `prefetchUpcoming(from: activeIndex)`. The bump does NOT cancel the loader's in-flight
  downloads — it only drops the older chain's bookkeeping — so the fresh walk re-requests
  the same rows and chains onto their existing tasks (cached rows are no-ops). Review
  correction (2026-10-02): the original design deliberately skipped the bump, but that
  lets a re-arm during an active walk spawn a SECOND concurrent chain that double-walks
  the window and amplifies event/tick churn; superseding is strictly cheaper. It is
  intentionally independent of LDM: the engine retries because the network changed, not
  because of a metered/cheap judgement — so no classification is mirrored into Swift, and
  it works backgrounded (no JS round trip).
- **Guard**: `rearmPrefetchAfterNetworkChange` returns early while a staged stream owns
  the bandwidth (`stagedSchedule != nil` or `loader.hasActiveWriter`) — the writer arms
  its own chain at completion (mirrors the `loadAndStart` staged note).
- Diagnostic: each fire logs `network re-arm: prefetchUpcoming from row N`; a skipped
  fire logs `network re-arm skipped (staged stream owns bandwidth)` at debug level.

Verification item (not a change): confirm the resumable path actually fires on the
`-1017`/`network lost` shape and that stale `resumeData` from a previous interface does
not loop. If dumps show a loop, clear `resumeDataByCacheKey` for the key on a network
change; record the finding either way.

**Adversarial review (2026-10-02, post-landing).** Findings: (a) the prefetch re-arm
fired on ANY deduped tuple change, including an `osLowData`-only toggle — an explicit
user setting is not a network change, so the plugin now gates the re-arm on the
`isExpensive` (path) bit alone; (b) the plan's own anchor table still named the removed
`decideCellularFlap` — fixed here per the anti-rot contract. No functional defects were
found in the pure cores or the engine wiring (the park-and-drain planner, the
generation-superseding re-arm, and the classifier state machine all hold under the
test matrix). Swift compile/run remains CI-only (E5).

---

## 7. Phasing & rollout

| Phase | Contents | Reversible? | Field signal |
|---|---|---|---|
| 1 (LANDED) | A1 retry dedupe fix | yes (pure core) | `prefetch FAILED … attempt 2/3` now appears |
| 2 (LANDED) | B1/B2/B3 classification redesign + tests | yes (JS only) | `network stability … latched=…` lines; no mid-wobble consumer re-derives |
| 3 (LANDED) | A2 park-and-drain via the pure `PrefetchChain` planner (`nextAction`/`applyDownload`/`applyRetry`) + tests | yes (native) | `preloadCount 5` fills even with a poisoning row; retries logged as `RETRY FAILED … reparked` |
| 4 (LANDED) | C debounce re-arm + resume verification | yes (native) | `network re-arm: prefetchUpcoming` lands seconds after a `network changed` cluster |
| 5 | Docs anti-rot + field-dump review | — | — |

Each phase ships alone and is field-verifiable; none depends on the transcode-streaming
work.

---

## 8. Testing strategy

- **Pure cores (Node)**: rewrite `tests/networkHysteresis.test.ts` for the asymmetric
  windows + latch + release + "quiet gap cannot sneak a flip", keeping the boot/`osLowData`
  contracts; extend `tests/lowDataMode.test.ts` for the wiring edges.
- **Pure cores (Swift, CI — no local toolchain, E5)**: `PrefetchChainTests.swift`
  (dedupe step + park/drain matrix + poisoning-row scenario, all landed) and
  `NetworkRearmDebounceTests.swift` (landed).
- **What cannot be tested here**: iOS `NWPathMonitor` churn and Wi-Fi Assist. These stay
  field-dump-verified, which is exactly why B3/C instrumentation is in scope and why the
  constants are exported and dump-visible for tuning.

---

## 9. Rejected alternatives

- **Instant fail-safe to metered on any report.** Too twitchy; the user explicitly asked
  for the opposite.
- **One long flat confirm (e.g. 30 s both directions).** Delays legitimate engagement and
  still has no answer for churn. Asymmetry + latch is strictly better.
- **Mirror the classification into Swift / drive native from the filtered bit.** Rejected
  for now: it duplicates semantics across two languages and breaks in background when JS
  is suspended. The Workstream C trigger is classification-free by design. Revisit only if
  background behaviour genuinely needs LDM semantics.
- **Act on the raw bit anywhere.** Defeats the filter; the raw value belongs only in the
  trail/HUD.
- **Trying to suppress Wi-Fi Assist from the app.** Not possible.
- **Parallel per-row prefetch retries.** Violates the serial bandwidth discipline that
  exists so the next track never waits behind track 5.
- **Adding more retry attempts to the current in-chain retry** instead of park-and-drain.
  Lengthens the head-of-line block; treats the symptom.

---

## 10. Risks & open questions

- **Sticky classification.** After a burst, LDM can linger up to ~`CHURN_HOLD_MS`. Cost is
  conservative (data saved, quality reduced). Mitigations: the Settings status line shows
  the engaged reason, and manual LDM already wins; if it proves annoying, add a "force
  off for this session" affordance (separate decision).
- **Constants are guesses until field-tuned.** Keep them exported, test-pinned for
  *behaviour*, and dump-visible for tuning.
- **Park-and-drain accounting.** Parked rows must be dropped by id when they succeed
  elsewhere, or the drain redownloads them; pin this explicitly.
- **Native re-arm frequency.** Without the debounce, a burst would re-arm repeatedly;
  with it, at most one per ~2.5 s quiet gap. Confirm via the bridge trail.
- **`resumeData` across an interface change** — open; see Workstream C verification.

---

## 11. Anti-rot

- Update the AGENTS.md P5 anchor (`networkHysteresis.ts` / `decideCellularFlap` →
  `decideNetworkStability`, asymmetric + latch constants, the new test tag) and the
  prefetch anchor (A1 landed; A2 park-and-drain once shipped).
- DEVLOG: one dated entry per phase with the field evidence that motivated it and the
  dump signal that confirms it.

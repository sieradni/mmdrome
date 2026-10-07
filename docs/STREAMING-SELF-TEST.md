# Streaming self-test — what to run and what to paste back

This is the **manual half** of transcode-streaming verification. The Debug HUD's
`STREAM SELF-TEST` button automates the evidence gathering; this checklist says
exactly which scenarios to run so the reports can be adjudicated.

## Pre-flight (once)

1. Settings → About → **Debug HUD** (ribbon appears).
2. Expand it → **STREAM SELF-TEST** → confirm **“+ watch 25s”** is ticked.
3. Know how to set the mode under test:
   - Settings → **Data & Network** → **Low data mode** (manual toggle is enough —
     you do NOT need cellular).
   - Settings → **Streaming Quality** → format (opus / mp3 / aac) + bitrate.
4. **A stream only happens for an UNCACHED track.** Pick tracks you have not
   played on this device recently (ideally a different album from what is
   currently queued). A cached track reports `variant: raw/…` but shows **no
   `staged load start`** — that is the cache path, not a failure.

## How to run each test

For every row below: get the track playing, press **Run test**, wait for
“running…” to clear (~25 s), then paste the auto-copied block. The block is
delimited by `=== MMDROME STREAM SELF-TEST ===` and includes the HTTP probe, the
server-probe matrix, the mid-stream state sample, the verdict table and the raw
events.

**If the report must be re-copied**, press **Copy** in the same section.

**The probe gathers server facts without stopping playback.** Two probes run:

- A **server-capability matrix** probes a few random, *unloaded* library tracks
  across the transcode formats in use (the configured format plus the lossy
  built-ins; the plain URL when transcoding is off). Those targets are
  different tracks from the one playing, so the requests cannot attach to a
  live transcode job — no playback state is needed, and the facts
  (Content-Length, Range, container-at-front) are server + format properties,
  not track ones.
- A **same-stream probe** still measures the current track's exact URL. If a
  staged stream owns that transcode when you press the button, the probe waits
  for the stream to settle (promote or teardown) and only then reads the
  server: a same-track GET during an active transcode attaches to Navidrome's
  *in-progress* output (served whole, `200`), so its Range verdict would
describe the moment, not the server. If the stream is still live after ~30 s
the same-stream probe is skipped and the report says so; the matrix above still
carries the server facts.

---

## The scenarios

### T1 — Raw baseline (control)
- Mode: **Low data mode OFF** (or Streaming Quality → no transcode).
- Play an uncached track, then **Run test**.
- Expected: `variant: raw`, `staged load start`, `first staged schedule …`,
  `promoted … cache entry complete`.
- Why: proves the streaming path itself still works after the transcode change.

### T2 — Transcode, healthy link (the headline test)
- Mode: **Low data mode ON**; Streaming Quality → **opus**, 128.
- Play an uncached track, then **Run test**.
- Read in the report: `content-length` present?, `container magic`, `first staged
  schedule`, the verdict table, and whether the promote line says
  `decodability+duration-gated`.
- Why: settles whether transcodes actually stream, whether the server announces a
  total, and whether the container is progressive.

### T3 — Transcode played to the END (completion + natural end)
- Same as T2, but let the track run to its end (or seek near the end first) and
  press **Run test** while it is finishing.
- Expected: a promote line, `staged schedule complete … natural end restored`,
  then a normal advance (no stall on the last seconds).
- Why: the completion verdict + tail are the riskiest part of the change.

### T4 — Mid-stream cut / recovery (the failure path)
- Mode: **Low data mode ON**, opus.
- Start an uncached transcoded track; once audio is playing, **turn on Airplane
  Mode** (or stop the Navidrome container), then press **Run test**.
- Expected: `writer failed` (or `clean early close`) with `scratch retained`, and
  — if the cut landed near the very end of the body — `promoted … despite writer
  error … duration-corroborated partial` instead, which is the recovery working
  (a body that already carries the full track promotes rather than re-downloading).
  A genuinely short body must still show NO `promoted` — that is the poison gate.
- The `writer failed` line now ends with a bracketed identity + attribution, e.g.
  `[err=NSURLErrorDomain(-1017) kind=cannotParseResponse cut=churnUnlikely (no
  transition within 5.0s; last was 42.0s earlier)]`, and the report grows a
  **Transfer cut attributed** row that prints it verbatim. Read it as: a
  `churnSuspected` cut means a *reported* network transition explains it (local
  churn — a resume recovers); a `churnUnlikely` cut means the local path was
  stable and points at the **server / reverse-proxy keep-alive** lead. It only
  sees transitions the OS reports, so repeat the test a few times if the answer
  matters — a run of `churnUnlikely` cuts is the actionable signal.
- Why: proves a cut transcode is not promoted as complete (the poison gate), and
  names the cut's cause instead of leaving it at “cannot parse response”.

### T5 — Alternate container (mp3)
- Mode: **Low data mode ON**; Streaming Quality → **mp3**.
- Play an uncached track, then **Run test**.
- Why: a different container exercises a different `container magic` and header
  honesty; the estimate math must hold for both.

### T6 — Alternate container (aac), if available
- Same as T5 with **aac**.
- Why: ADTS has no duration header (a third container shape).

### T7 — Stalls / estimate tuning
- Any transcode run that shows `stall resume` or `schedule target past delivered
  end` lines.
- Why: those lines are the estimate being wrong in one direction; the report
  gives the numbers to tune `slack` / the lead.

### T8 — Link churn (optional)
- Only if you can reproduce the Wi-Fi Assist / handoff churn: run a transcode,
  let the interface flip, then **Run test**.
- Why: exercises the network re-arm + resume paths around the stream.

### T9 — Seek latency (the measurement)

> For the seek/epoch/ladder work specifically, run the **S1–S6 protocol below** —
it is the same button, arranged so ONE session judges all three evidence streams
(epoch verdict, prefetch ladder, latency legs).
- Play a **transcode** (T2 mode), scrub far forward into a region the stream has
  not delivered yet, and let it reach audio. Then **Run test**.
- Read: the `seek-latency` check. A complete report reads
  `total=<ms>ms (decision=…, firstByte=…, firstSchedule=…) strategy=…`; the
  strategy label is the comparison (`parked+epoch` is the epoch path,
  `local`/`parked` is the Phase-1 wait). A `firstByte=…*` mark means the byte leg
  was INFERRED from the schedule (the plain download lane has no byte callback).
- Why: this is the number the seek work is judged by — request → audible, in
  four legs. Compare a `+epoch` report against a plain `parked` one on the same
  link; the engine logs one line per seek, so a longer session accumulates
  samples.
- A `WARN` (`probe(s) never reached playback`) is expected when you scrub while
  PAUSED and do not press play inside a minute — that probe expires by design
  rather than reporting a total that is really your own pause.

---

## Seek / epoch / ladder validation (S1–S6)

One session, five runnable scenarios (S4 is blocked — see below). Each scenario is
ONE `Run test` press and ONE pasted block, so the three new evidence streams are
judged together instead of from three separate hunts:

| Stream | Where it lands | Judged by |
|---|---|---|
| Epoch verdict | `stream` lines: `epoch open` / `epoch verdict …` | check `epoch` |
| Prefetch ladder | `preload` lines: `transfer ladder: prefetch walk held …` | check `transfer-priority` |
| Seek latency | ONE `stream` line per seek: `seek latency id=… target=…s …` | check `seek-latency` |

### Pre-flight (once per session)
- Build/install the branch under test.
- Debug HUD on (`?debug`, or Settings → About → Debug HUD). Open the **STREAM
  SELF-TEST** section and tick **“+ watch 25s”** — the press then probes the server
  AND keeps polling native events for ~25 s, and a stream already in flight is still
  picked up (the look-back prefers the current track's `staged load start`).
- **VERBOSE DOMAINS:** switch `preload` on. `info`/`danger` are ALWAYS recorded, so
  the ladder's hold/resume lines arrive without it; only the debug-level
  `network re-arm held (…)` line needs the chip.
- **Transcoding** on (Streaming Quality → opus 128) for S1/S2/S3/S5 — the epoch lane
  is transcode-only by construction. **Low data mode** ON if that is how you listen
  (it changes which rows are eligible, not the evidence).
- Use a track **longer than ~8 minutes**, played from the START so the region you
  seek into is genuinely undelivered, and keep the scenario on the row it concerns
  (the capture window follows the CURRENT track).

### S1 — Far seek on a transcode (the epoch path)
- Play the long uncached track until audio starts, then tap **~60–70 %** of the seek
  bar in ONE tap (do not drag), and let it reach audio.
- Expect, in order: `seek … → 480.0` (engine), `epoch open #1 row=… id=… base=480s
  target=480.0s autoplay=true`, then `epoch verdict honored #1 … base=480s container=…
  frames (expected …)`, then `first staged schedule id=… start=480.0s base=480.0s …`.
  The playhead must stay pinned at ~480 s — **never a flash of 0:00**.
- Checks: `epoch` PASS — its evidence reads `epoch honored (base=<seconds>s,
  schedules <n> epoch(s))` — and `seek-latency` PASS with a `strategy=` ending in
  `+epoch`.
- **Failure signatures to paste verbatim:**
  - `epoch verdict unknown … — discarded, Phase-1 wait` (DANGER) — the container
    matched neither band. This is the shape §7 of the plan warns about; the numbers
    in the line (`container … vs expected …, track …`) decide whether it is the
    direct-play hazard or a server duration quirk.
  - `epoch verdict ignored … — rebased to base 0, intent kept at 480.0s` with the
    playhead still at 480 s — the EXPECTED fallback (`epoch` reads WARN); still
    worth pasting, it is the adoption path working.
  - **A `first staged schedule … base=0.0s` after an `epoch open` with NO verdict
    line between them** — the forbidden shape (an epoch that started without
    demoting itself). `epoch` FAILS on this; paste immediately.

### S2 — Paused seek, then play (the late fourth leg)
- Any track: play, pause, scrub forward while paused, wait ~5 s, press play.
- Expect a `seek parked at …` (or `epoch open …`) and then playback; ONE
  `seek latency … strategy=… total=…ms` line once audio starts.
- If you instead wait **more than 60 s** before pressing play, NO complete line is
  correct (the probe expires rather than bill your own pause) — the bundle's
  `seek-latency` check then reads WARN (`probe(s) never reached playback`). Say which
  of the two you saw; both are valid outcomes, only one produces a number.

### S3 — Trivial scrub (negative control: NO epoch may open)
- On the same transcode, seek only ~2 s forward (below the 3 s offset floor).
- Expect `seek … → …` and **no** `epoch open`; `strategy=` reads `local` or `parked`,
  never `+epoch`. This falsifies a floor that is not applied.

### S4 — Kill switch off (BLOCKED — no control in the UI)
- `seekEpochs` is pushed by the manager from persisted settings, but there is **no
  Settings toggle** yet, so a phone-only session cannot flip it. Until that control
  exists (recorded in the plan's deferred register), run this only if you can write
  the setting (`seekEpochs: 'off'`) and reload: expect `seekEpochs → off` at boot and
  ZERO `epoch open` lines for the same far seek as S1.

### S5 — Ladder hold while a user transfer owns the link
- Queue a few UNCACHED tracks so the speculative walk starts (watch for `chain:
  prefetch row …` in the RAW EVENTS), then seek far into the CURRENT track (S1's
  action) and keep playing ~30 s.
- Expect (preload): `transfer ladder: prefetch walk held (seekEpoch) — user transfer
  owns the link`, and later `transfer ladder: prefetch walk resumed (was held:
  seekEpoch)`. A settle-edge arm also shows as `epoch closed: prefetchUpcoming from
  row … (gen …)`.
- Checks: `transfer-priority` PASS; PARSED FACTS `prefetchHoldCount` ≥ 1,
  `prefetchHoldReasons` contains `seekEpoch` / `stagedStream` / `activeLoad`,
  `prefetchResumeCount` ≥ 1.
- **Failure signature:** `transfer-priority` WARN (`a hold with NO resume: prefetch
  stayed stopped for the window`) — the starvation shape; paste it with everything
  after the hold line.

### S6 — Same-row overlap (`activeLoad`)
- Start a fresh long track and seek **within the first seconds**, while that row's own
  bytes are still arriving.
- Expect a hold whose reason is `activeLoad`, released on the same edges as S5. This
  is the overlap the deferred supersession work would cancel; today it is only held.

### Adjudicating a session
- Read the three checks in the pasted block's VERDICTS table first, then confirm each
  against the RAW EVENTS tail — the checks are the summary, the lines are the evidence.
- `UNKNOWN` means **absence of evidence**, not success (`epoch`: no epoch in the
  capture — usually a scrub that never crossed the floor; `transfer-priority`: no
  overlap happened; `seek-latency`: no seek reached playback).
- When a check reads UNKNOWN or WARN and the events look thin, also paste the **Copy**
  dump's `nativeState` — it carries `seekLatency`, `seekLatencyReports`,
  `streamEpochActive/Base/Target/Verdict/Count`, `prefetchLadderHeld/Holds` and
  `userTransferActive` as of the press.
- **Priority if time is short: S1, S5, S2.** S1 settles whether epochs work at all and
  whether a far seek is fast; S5 settles whether the ladder releases; S2 settles the
  probe's late-leg rule. S3 and S6 are cheap negative/overlap controls.

---

## What to paste

Paste the whole block for each test, one per message, labelled with the test id
(**T2**, **T4**, …, **S1**, **S5**). The block is self-describing; the raw events at
the bottom are what a wrong verdict gets re-adjudicated against, so do not trim them.

## Priority

If time is short, run **T1, T2, T4, T3** — in that order. They settle: does raw
still stream; does transcode stream at all; is a cut stream safe; does a streamed
track end cleanly. Add **T9** when the question is seek latency rather than
streaming health. For the seek/epoch/ladder branch, run the **S1–S6** track
instead and start with **S1, S5, S2**.

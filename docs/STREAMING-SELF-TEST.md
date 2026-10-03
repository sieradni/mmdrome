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
mid-stream state sample, the verdict table and the raw events.

**If the report must be re-copied**, press **Copy** in the same section.

**The HTTP probe waits for the stream.** If a staged stream owns the track's
transcode when you press the button, the probe is deferred until the capture
ends and only then reads the server — and if the stream is still live it is
skipped, with the report saying so. That is deliberate: probing during an
active transcode fires a second request at the stream it is measuring and reads
Navidrome's *in-progress* output (served whole, `200`), neither of which says
anything true about the server. Its Range verdict is only meaningful against a
settled transcode, so re-run with playback stopped if you specifically want the
server facts.

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

---

## What to paste

Paste the whole block for each test, one per message, labelled with the test id
(**T2**, **T4**, …). The block is self-describing; the raw events at the bottom
are what a wrong verdict gets re-adjudicated against, so do not trim them.

## Priority

If time is short, run **T1, T2, T4, T3** — in that order. They settle: does raw
still stream; does transcode stream at all; is a cut stream safe; does a streamed
track end cleanly.

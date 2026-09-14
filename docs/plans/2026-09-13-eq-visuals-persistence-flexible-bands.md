# EQ: slider visuals, working-state persistence, flexible bands/modes

Date: 2026-09-13
Status: **IMPLEMENTED (all four phases, 2026-09-13)** — 874 JS tests pass
(incl. new `tests/eqSession.test.ts`, `tests/eqCurveTopology.test.ts`,
extended `tests/eqStore.test.ts`), `npm run check` clean. Deviations from
the plan as written: §0.4's engine path landed as `hasGraphicBands` → whole-EQ
convolver branch inside `applyFiltersConfig` + `_shouldUseConvolverPath()` at
every routing site; `EqGraph` handles render BOTH kinds at (frequency, gain)
(round filled = parametric, square hollow = graphic — the hybrid renderer puts
the curve through each point's own gain, so one formula lands every handle on
the curve); the graph drag routes through the new live `setEqBandParams`
(no chain rebuild per pointermove) and the per-row Q slider shares it;
`_buildDefaultEq` now materializes STORED configs (the no-worklet fallback
used to collapse flexible/imported EQs to flat); `resetAll` on an imported EQ
is genuinely flat (zeroed filters + curves dropped — the old path left the
convolver curves un-zeroed); the preset `<select>`'s blur handler no longer
re-applies the preset (it silently discarded a dirty overlay); native
`NativeFilterSnapshot` carries `curve` forward (informational — Swift maps by
order onto the 24-band node, the documented approximation; no Swift change).

## 0.0 Decisions (user-confirmed 2026-09-13)
- **Slider fix**: custom `EqSlider` component (SeekBar pattern) + centralized
  app.css track fix. Not CSS-only.
- **Preset switch while dirty**: ASK first — confirm dialog offering
  Save / Discard / Cancel before the switch proceeds.
- **Band editor**: BOTH the graph (drag/add/remove points) and the band list
  (per-band gain/Q sliders) share one state.
- **Curve modes**: per-point smart rule AS DESIGNED, plus an explicit
  "flip all" control (convert every point ↔ parametric/graphic) for users who
  want the whole-EQ switch.

## 0. Findings (why things are the way they are)

### 0.1 The white outline on sliders
`src/app.css` styles every `input[type="range"]` with a **1px light border**
(`border: 1px solid rgb(255 255 255 / 0.15)`, comment says "dark track border
kept for contrast on black") plus `accent-color`. Two consequences:

1. The border draws a light **outline around the whole control**, including
   the transparent parts — visible as the "ugly white outline" the user sees
   on some devices/engines.
2. Once `appearance` is customized for the thumb (which this stylesheet does),
   the platform paints `accent-color`-driven track fills inconsistently; the
   border also wraps the unfilled portion, which reads as a second white ring.

Sliders are styled globally in ONE place (`app.css`) and every consumer relies
on that + `accent-*` utilities (SettingsView filter sliders, PitchSpeedView,
VolumeView, DetailView, TrackDetailsModal, FilterSortBar, QueueView filters,
EQView preamp/bands). Any fix must stay centralized — no per-view overrides.

**Fix (Phase A):** remove the border; keep the accent thumb. Style the webkit
track explicitly (thin translucent bar) so Chromium/WebView2/Android WebViews
paint identically everywhere instead of inheriting accent-driven chrome:
`::-webkit-slider-runnable-track` / `::-moz-range-track` = `h-1` translucent
white, `::-moz-range-progress` = accent fill (Firefox), thumb stays
accent-filled with its dark ring (needed on a white/silver accent). All
existing consumers keep working unchanged; no component changes.

### 0.2 EQ band sliders are upside-down
`EQView` line ~321: `class="h-32 w-1 accent-white/80 [writing-mode:vertical-lr]"`.

- **Chromium anchors `min` at the TOP** for a `writing-mode: vertical-lr`
  range input unless `direction: rtl` is ALSO set — the current CSS lacks
  `rtl`, so `min=-12` sits at the top and the fill grows downward: the exact
  reported symptom (values map correctly to the rotated control, but the
  visual is upside down). Not device flakiness — deterministic on every
  Chromium/WebView (Android WebView, iOS WKWebView's inner Blink layers,
  Windows WebView2). Older iOS Safari ignores writing-mode on range inputs
  entirely and renders a horizontal slider squeezed into a 128px column.
- Firefox uses `appearance: slider-vertical`-style behavior with min at the
  bottom — the divergence that makes one CSS rule unfixable across engines.

The app already solved this exact problem elsewhere: **`SeekBar.svelte` is a
custom pointer-driven bar** (hit-strip + fill div + playhead) — device-stable
by construction.

**Fix (Phase A):** replace the 10 `<input type=range>` columns with a small
custom `EqSlider.svelte` (pointer events, keyboard support, ARIA slider role,
`aria-orientation="vertical"`, double-tap-to-zero, drag anywhere on the
column). Values/sign flow is untouched: `gains[i] = -filter.gain` (inverted
sign, pre-existing convention), disabled while bypassed. This kills the
direction bug on every device and is the same pattern the codebase already
ships.

### 0.3 Unsaved EQ edits are lost on view exit (the main correctness gap)
`EQView` keeps its working state in **local `$state`** (`eqState`, `preampDb`,
`gains`). The durable stores exist — `currentEqState` (persisted to Dexie as
`current_eq_state` via `persistEqState`) and an unused `draftState` — but the
view only writes the engine and its local copies. Every mutation path
(`setGain`, `onPreampChange`, `handleImport`, `resetAll`) calls `syncDraft()`
→ `draftState.set(...)`, **but nothing ever persists `draftState`, and
`selectPreset` doesn't even call `syncDraft`**. Leaving the view discards all
uncommitted edits:

- Native: the engine keeps the audible EQ (plugin engine state) until app
  restart, while the UI reopens at the last *persisted* preset →
  **state divergence** (slider shows preset values, audio has edited values).
- Web: `playbackManager` re-applies `get(currentEqState)` on every
  `_loadAndPlay` (line ~842) → the next track **audibly reverts** mid-session.

The user's explicit rule: **working state must survive leaving the view,
without changing what "presets" mean.** Saving an edited draft on every slider
move would hijack the active preset (the preset system's semantics must stay
intact: presets are user-saved snapshots; `activePresetId` keeps pointing at
the base preset).

**Fix (Phase B) — "dirty overlay over the active preset":**

- New module `src/lib/eq/eqSession.ts` (pure, no DOM/Dexie — test-pinned):
  - `type EqSession = { basePresetId: string; state: EqPreset; dirty: boolean }`
    — the working copy + the preset it diverged from + whether it differs.
  - `startSession(basePreset)`, `editDraft(session, edit) → session`
    (immutable-ish reducer over filters/preamp; sets `dirty` by deep-compare
    against the base preset), `clearDirty`, `sessionEqualsPreset`.
  - Persistence policy lives here: dirty → **debounced (600 ms) Dexie write**
    of `current_eq_state` + `active_eq_preset` via a thin injected writer
    (the eqStore's existing `persistEqState`); non-dirty → no writes.
- `eqStore` gains:
  - `workingEq` store (`EqSession`) — the single source the view renders from;
  - `commitWorkingState(session)` — debounced-writes the session's state
    (NOT the preset rows) and updates `currentEqState`;
  - `selectPreset` starts a fresh clean session for the chosen preset;
  - `initEqStore` restores `current_eq_state` into `currentEqState` AND a
    clean `workingEq` (keyed to the persisted active id);
  - `saveAsCurrentPreset` and `saveUserPreset` consume the working session,
    then reset the session clean against the (new) active preset.
- `EQView` rewiring:
  - renders from `$workingEq` (sliders edit → `editDraft` → engine push →
    debounced commit). Engine push stays **immediate** on every input (the
    audible path must never wait on a 600 ms debounce);
  - the preset `<select>` shows `activePresetId` and a subtle
    "(edited)" marker when `dirty` (discoverability of the overlay state);
  - "Save as Current" = `saveAsCurrentPreset(workingEq.state)` (existing
    behavior), after which the session re-bases and the marker clears;
  - leaving the view needs **no unmount hook at all** — state is already
    durable by the time the user navigates away (worst case the debounce
    lands ~600 ms later; a `beforeunload`-class flush is unnecessary on
    mobile and Dexie writes are idempotent full-row puts).
- `playbackManager._loadAndPlay` keeps reading `currentEqState` — now always
  in sync with what the user hears, so the mid-session revert bug dies.
- Native stays consistent for free: the facade mirrors what the view pushes,
  and `currentEqState` (what a restart re-applies) now matches it.

Tests: `tests/eqSession.test.ts` (dirty flagging, deep-compare false
positives, debounced write batching, re-base on save, import → dirty), extend
`tests/eqStore.test.ts` (restore builds a clean working session; commit path
persists state but never mutates preset rows).

### 0.4 Locked 10-band parametric → flexible bands + per-point curve type
Current model (§2 above) hardcodes exactly 10 peaking bands on the
`DEFAULT_GRAPHIC_FREQUENCIES` grid; the view shows sliders for `filters[0..9]`
only. The engine layer is already variable-length everywhere:

- Web: `applyFiltersConfig` builds N biquads (or N worklet coefficient sets);
  `_buildDefaultEq` is the only 10-fixed site; `setEqBandGain` is index-based
  but generic.
- Native: `applyFilters` maps over `filters.prefix(bands.count)` against a
  **fixed 24-band `AVAudioUnitEQ`** — only a UI convention limits us to 10;
  the plumbing handles 24 today.
- The graphic curve machinery (`graphicEqEngine` FFT convolution,
  `EqPoint[][]`, `graphicEqResponseCalculator`) exists and is what imported
  GraphicEQ presets play through (`applyGraphicEQ` → convolver).

**Model (Phase C+D):** per-band `curve: 'parametric' | 'graphic'`
(optional field; absent/`'parametric'` = current behavior — every existing
preset and import path stays valid; old persisted states parse unchanged).

- `parametric` → a peaking **biquad** (current path).
- `graphic` → the band is a **curve point** in the graphic-EQ convolution:
  gain is interpolated to neighbors (existing `filtersToPoints` +
  `createGraphicEqAudioBuffer` path), the slider handle sits ON the curve at
  its frequency, and the slider **directly moves the curve** at that point.

**The user's "smart point" rule** (per-point, not a global mode switch): a
point is parametric when it sits **between two parametric points**
(consecutive neighbors on each side are parametric, i.e. inside a parametric
run); it is graphic when adjacent to the curve (inside/at the edge of a
graphic run). Explicitly:

- All-parametric EQ → every new point is parametric (current behavior).
- Introduce graphic points → parametric points that end up inside a graphic
  run **transition to graphic**; parametric points that remain in a run of ≥2
  parametrics stay parametric. (User's own phrasing: "if the two points
  around it are parametric, it transitions to non-parametric for that point.")
- A lone parametric point between graphic points follows the run logic above
  (it becomes graphic — it is inside a graphic run, there is no parametric
  run to belong to).
- Points are also **freely draggable in frequency** on the graph and
  add/remove (tap-to-add on the curve, long-press/right-click to remove, plus
  explicit +/- row controls in the band list for accessibility).

Implementation split:

- `eqCurveTopology.ts` (pure, test-pinned): given the ordered filter list,
  compute the effective per-index curve (`resolveCurveTypes(filters)`), the
  runs, and the transition after an insert/edit (`applyCurveRule`).
- Graph rendering/interaction: `EqGraph.svelte` gains an **editor mode** —
  draggable point handles (pointer capture, same pattern as SeekBar),
  frequency snapping to the musical grid (31…16k + fine positions), add/remove
  affordances, and the curve-type visual distinction (round solid handle =
  parametric biquad, square/hollow handle pinned to the interpolated curve =
  graphic point). Parametric bands keep showing their exact response bumps;
  graphic points show the interpolated curve passing through them (the
  response calculator already draws both correctly today via the mode
  branch).
- Sliders list: grows beyond 10 — each row = one band (freq label, gain
  slider, mini Q control for parametric rows, curve-type toggle for edge
  cases, remove button; add button appends at the musical midpoint of the
  largest frequency gap). The custom `EqSlider` from Phase A is reused.
- Engine path: `audioManager` learns a **hybrid push**: parametric bands →
  biquads/worklet coefficients as today; if ≥1 graphic band exists, ALSO
  rebuild the convolver from *all* bands mapped to points (parametric bands
  contribute their gain at their frequency as points; the FFT buffer is the
  sum-path). Cleanest correct shape: when any graphic band exists, render the
  **whole EQ through the convolver path** (it reproduces biquad responses
  accurately at 4096-tap resolution) and keep the biquad/worklet path for
  the all-parametric case — one engine branch, no per-band graph mixing.
- `engineFacade.applyFiltersConfig` unchanged (snapshot maps `curve` through
  or strips it for native).
- Native parity: `NativeFilterSnapshot` gains `curve`; Swift maps graphic
  bands to their nearest-band gain on the fixed grid (24 bands, straight
  interpolation) — documented, honest approximation. No CI-visible Swift
  change beyond the decode of one optional field.

Presets gain nothing new structurally (`EqPreset.filters` already holds
arbitrary `EqFilterConfig[]`) — a preset just persists whatever bands/curves
the user built. Built-in presets stay 10-band parametric.

### 0.5 Import paths (kept working, unchanged semantics)
- Parametric/AutoEQ imports keep `mergeFiltersIntoDefaultGrid` (base 10 +
  extras) — but now extras are **first-class bands** in the slider list
  instead of invisible `filters[10+]` (they were already audible; now they're
  editable/visible).
- GraphicEQ imports keep the raw curve stack; each curve point becomes a
  graphic band (dedup by frequency, sum stacked-line gains) → fully editable
  after import, instead of the current convolver-only frozen state.

## 1. Execution order & risk

| Phase | Scope | Risk |
|---|---|---|
| A | app.css slider restyle + `EqSlider.svelte` + EQView swap | Low — visual only, no state changes |
| B | `eqSession.ts` + eqStore working-state + EQView rewire + tests | Medium — touches persistence; tests pin the semantics |
| C | `curve` field + topology core + growable band list | Medium |
| D | Graph editor interaction + hybrid engine path + native snapshot field | Highest — engine-adjacent |

Each phase lands independently (A+B are shippable without C+D; the plan
stages them so a bad D can't regress A/B).

## 2. Explicit non-goals
- No preset-format migration: `curve` is optional; missing = parametric.
- No new subsystems: sliders stay hand-rolled (no component library —
  design rule §1).
- Native EQ stays the fixed 24-band node; no Swift graph rewrite.
- No auto-save of presets: presets change only via explicit Save actions.

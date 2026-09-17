# Thumbnail Pipeline Rework — Design (2026-09-16)

Status: **SHIPPED 2026-09-17; amended same day** — see §5 for the re-review that
fixed two defects in this design (the slow-drag regression and the URL-keyed
cache). §2/§3 retain the original text where still true; where this document and
the code disagree, the code and AGENTS.md §2.5/§3.6 win.

## 0. Problem statement

The existing pipeline (`LazyThumb.svelte` → `thumbLoader.ts` distance queue) already
prioritizes what's on screen: it re-sorts pending entries per frame by
distance-to-viewport-center and arms nearest-first. What breaks under a fast flick
is **arming is one-way**: once armed, a fetch runs to completion, nothing aborts or
de-prioritizes it, and the 8/frame cap limits *starts*, not in-flight requests. A
fast scroll leaves dozens of cover fetches in flight from rows the user already flew
past — they compete for connection slots and bandwidth with the rows now on screen,
so the visible rows load *last*.

Three verified supporting facts:

1. **The IntersectionObserver pre-roll is 800 px** (`rootMargin: '800px'`) — during a
   flick it queues rows several screens away continuously.
2. **`sw.js` bails on every `/rest/` path**, so cover art never touches any cache:
   fly-by fetches are burned, not banked. Navidrome serves real art with
   `Cache-Control: public, no-cache` + a strong `ETag` (pixel-hash validator,
   `server/imghttp/headers.go`) and placeholders with `no-store` — verified against
   Navidrome master. The HTTP cache *can* be banked; nothing does it for us when
   headers are stripped (see 3.1).
3. **No virtualization / `content-visibility`** anywhere: a 5,000-row library mounts
   5,000 components and renders the whole DOM every frame.

## 1. Verified contract inventory (what we must not break)

- **thumbLoader is the single scheduling owner** — `requestThumb(el, load)` /
  `cancelThumb(el)`; `LazyThumb` calls it from its IO callback (800 px pre-roll).
  No other caller exists. Changing the scheduling inside the tick loop touches no
  call site.
- **Zero-size entries** hold behind a retry counter (`MAX_ZERO_SIZE_RETRIES = 10`
  frames, sorted last) because the IO only re-fires on intersection *changes* —
  dropping them strands them forever.
- **A13/LDM**: LazyThumb steps the size down one canonical level under Low Data
  Mode. Velocity gating must NOT become a second LDM: it gates *timing*, not
  *bytes* — the same total set of covers downloads, ordered better.
- **Viewstate scroll restoration** (e2e `viewstate.spec.ts`) pins only the Settings
  container; the list views persist scrollTop through `saveViewState` on their own
  containers. `content-visibility` does not change scroll height (contain: size
  keeps the box), so restoration math is untouched.
- **TrackOptionsDropdown's ⋮ menu is absolutely positioned and OVERFLOWS the row**
  — `content-visibility: auto` applies **paint containment even while visible**,
  which clips overflowing descendants. It must therefore never be applied to
  TrackRow. Grid cells (Albums/Artists) render no popover — they're safe.
- **`decoding="async"` + no `loading="lazy"`** is deliberate: scheduling is owned by
  IO + thumbLoader; the browser's lazy threshold would fight the pre-roll. Keep.

## 2. Design

### 2.1 Velocity-gated arming (thumbLoader)

New pure core `src/lib/thumbFlow.ts` (F2: policy testable, adapter thin):

```ts
export interface ThumbFlowState { warmup: boolean; blocked: boolean }
export const SCROLL_HOLD_MS = 250        // release latency after the last scroll event
export const WARMUP_MS = 400             // initial grace on first engagement (fonts/Dexie restore)
export const MIN_ARM_INTERVAL_MS = 33    // min gap between armed batches (≤1 batch per frame)
```

- `thumbFlowSignal(now)` → `ThumbFlowState` — a pure function of the scroll-event
  bookkeeping: a scrolling marker (recent scroll events within `SCROLL_HOLD_MS`),
  a decay timer that forgets scroll activity, and a one-shot warmup grace fired at
  the first engagement. **Blocked = scrolling or warmup** — while blocked, the
  loader continues re-sorting its queue every frame but arms nothing, so the instant
  the flick ends the nearest batch arms first. No velocity *estimate* is computed:
  scroll-event timing IS the signal (a held slow drag emits events and holds too —
  the correct behavior, the view isn't resting).
- The adapter (`thumbLoader.tick`) consults the signal each frame: blocked → skip
  arming (still housekeep retries + the drop window); open → arm up to
  `MAX_PER_TICK` per batch, **min `MIN_ARM_INTERVAL_MS` between batches**. The old
  behavior of `MAX_PER_TICK=8`-per-frame only applied while a backlog exists; this
  also smooths the burst after a long block.
- `MIN_ARM_INTERVAL_MS` is wall-clock between *armed batches*, not frames: during
  steady open states it's equivalent to 8/frame, but it survives a backgrounded rAF
  (where 1 rAF ≫ 33 ms) without hammering.
- The scroll listener is wired at the ADAPTER, capture-phase on `document`
  (per-view scroll containers bubble not at all; `window` isn't the scroller).

Hold constant rationale: 250 ms is long enough that a flick (typically 150–300 ms of
events) doesn't re-open mid-glide, short enough that a scroll stop feels immediate.
Warmup 400 ms covers the library-mount burst (fonts, Dexie restore, layout) without
arming hundreds of offscreen cells.

### 2.2 `coverLru` — SW cover cache (public/sw.js)

- `isCoverArtRequest(url)`: GET whose path **ends with**
  `/rest/getCoverArt.view` (or the non-`.view` form) — **origin-agnostic and
  BASE-independent**. In production the Navidrome server is a DIFFERENT origin
  than the deployed PWA (gh-pages; servers are BYO), so a same-origin check
  would make the strategy dead code there; `.endsWith` also survives subpath
  self-hosted layouts (`https://host/navidrome/rest/…`). The app's own assets
  can never collide with that path.
  Covers are **immutable per (id, size)** — the auth params are baked into the
  URL (C5) as ACCESS CONTROL, not art identity. [AMENDED 2026-09-17: the original
  "auth token+salt" identity claim was wrong — see §5; the cache key now strips
  u/t/s.]
- **What is cached**: `response.type === 'opaque' || (response.ok &&
  !no-store)`. The `no-store` check is load-bearing (caught by the test
  harness): Navidrome serves PLACEHOLDER art as `200 + Cache-Control: no-store`
  (`server/imghttp/headers.go`) — a bare `ok` check would cache placeholders and
  freeze unresolved artwork. Cross-origin `<img>` fetches are `no-cors` →
  OPAQUE responses (status/body unreadable): stored as-is, undated, and the
  trim sorts undated entries OLDEST so opaque growth is bounded. Opaque also
  means Navidrome's 200-wrapped failure bodies are indistinguishable from art —
  visual outcome equals today's (`<img>` error → ladder → fallback icon),
  re-evaluated when the id's artwork resolves / the entry LRU-evicts.
- Strategy: **cache-first with stale-on-error** —
  `match → serve`, miss → `fetch` → ok+basic → `put` → serve; network failure →
  serve any stale match. The ETag revalidation is already optimal via HTTP; this
  layer makes it work even where the HTTP cache is hostile, and banks fly-by
  fetches so re-scrolls are instant and offline.
- Covers are `public, no-cache` revalidated and immutable per (id, size), so caching
  them client-side cannot serve stale art: the key is `(origin, path, id, size)` and
  only art bytes are ever stored — there is no credential-shaped content to go stale
  (§5 amendment; the original URL-key rationale is obsolete).
- **LRU cap 300 entries / 40 MB, whichever first** (covers at ≤ 512 px are
  typically 20–80 KB; 300 ≈ a whole large library's working set). Approximate LRU:
  `caches.open('mmdrome-cover-cache-v1')`, on each `put` re-`put` the matched old
  entry FIRST (refreshes `Date` header = recency), then trim the oldest
  `Date`-header entries past the caps. The `put`-before-trim order means the newest
  entry can never evict itself.
- **Placeholder/404 responses are never cached** — a mismatched id must re-hit the
  server (it may resolve later, e.g. artwork worker catches up). `no-store`
  placeholders: only `ok` + `type === 'basic'` responses get `put`.
- Storage pressure is not a real risk at these caps, and the browser quota-mayhem
  escape hatch (`navigator.storage.estimate` sweeps) is deliberately absent — an
  over-clever evictor that fights the browser's own quota heuristics is a bug class,
  not a feature.

### 2.3 `content-visibility` on grid cells (Albums/Artists)

- One utility class `.cv-cell` in `app.css`:
  ```css
  .cv-cell { content-visibility: auto; contain-intrinsic-size: auto 240px; }
  ```
  Applied to the album/artist grid cell `<button>`s (`data-album` cells in
  AlbumsView; the artist equivalent in ArtistsView). Their LazyThumb is the only
  layout-affecting child, and the IO still fires correctly because c-v keeps the
  box in layout — only paint is contained while offscreen.
- **Deliberately NOT on TrackRow** (the ⋮ popover overflow trap — see §1), and NOT
  on QueueView rows (drag-and-drop previews + drop targets complicate containment;
  the queue is bounded in practice and not the reported pain).
- `contain-intrinsic-size: auto 240px` — the `auto` keyword makes the browser
  remember the last-rendered size, so the estimate matters only until first render;
  240 px approximates the 2-col mobile cell (width ~45 vw + two text lines).

### 2.4 Debug instrumentation (`thumbLoader` + HUD)

- `thumbLoaderDebugSnapshot()` (new export on the same module): `pending`,
  `blocked`, `warmup`, `armedTotal`, `droppedTotal`, `lastArmedAt`. The module
  already owns its state; the snapshot is a plain read, no new machinery.
- Debug HUD gains a **Thumbnails** section (collapsed by default per the C8/§2.5
  HUD rule) showing the live counters, and the Copy payload gains a `thumbnails`
  block. No credential surface — counters only.

### 2.5 What is deliberately NOT done

- **No de-arm/abort-on-exit** in the loader: `<img>` fetches can't be aborted from
  the arm callback; de-mount churn fights the failure-ladder state machine; and §2.2
  makes fly-by fetches banked rather than wasted, which removes their main cost.
- **No virtualization**: c-v gives the layout/paint win with zero restructuring;
  virtualization is a per-view redesign with real e2e risk. Revisit if c-v
  measurement says it's still needed.
- **No queue-view/ListTrackRow containment** (drag preview / popover traps, §2.3).
- **No velocity ESTIMATE (px/s)**: scroll-event timing is a strictly better signal
  (see 2.1) — estimating adds state without adding decisions.

## 3. Failure modes & why they're closed

| Risk | Why it's closed |
|---|---|
| Blocked loader never re-opens (scroll event lost, timer wedged) | The hold decays on wall clock (`thumbFlowSignal` recomputes each tick; the adapter only stamps timestamps) — a lost event at worst re-opens `SCROLL_HOLD_MS` late. |
| Slow drag starves the visible screen (2026-09-17 amendment, §7) | The gate is TWO-TIER: rows within half a viewport of center arm even mid-gesture (`visibleCount` caps the batch so pre-roll rows never leak into the gesture); the far pre-roll stays held. |
| Viewport resize with no scroll event (mobile rotate) | The drop window is recomputed from the live viewport each tick, and the arming loop runs per-frame regardless of scroll state. |
| The loader stalls while scrolled-but-resting (throttle fires late) | `MIN_ARM_INTERVAL_MS` gates between BATCHES, not the tick loop; a resting page keeps its per-frame cadence. |
| SW caches a 404/placeholder → stuck wrong art | Only `ok && type==='basic'` is `put`. A later real-resolution (artwork worker) rotates the ETag — but the URL is the key, and the URL contains no artwork state, so a cached 200 stays correct: it IS that id's art at that size. The 404 case is the only stuck-art vector, and it's excluded. |
| Cover cache key staleness after re-auth | [AMENDED] The key strips `u/t/s` (`coverArtCacheKey`); art identity is `(origin, path, id, size)`, so re-auth re-fetches nothing, and only art bytes are stored — stale art is impossible by construction. The origin is part of the key (pinned by test). |
| Massive SW storage | LRU caps (300 entries / 40 MB) with put-before-trim ordering. |
| `.cv-cell` clipping a popover | No popover exists in those cells (verified per §2.3); the rule names the trap for future editors. |
| Restored scroll position lands offscreen-art rows (c-v) | contain:size keeps boxes at intrinsic size → scroll height identical → restoration math unchanged (e2e pin unaffected — it targets Settings anyway). |
| Node tests can't import the adapter (window/document) | Policy lives in the DOM-free `thumbFlow.ts`; `thumbLoader.ts` keeps its lazy `window`/`document` access. (Its globals were already only touched inside functions, so import safety is preserved.) |
| Double-arm (requestThumb while pending) | Pre-existing `pending.some(p => p.el === el)` guard kept. |

## 4. Tests (new `tests/thumbLoader.test.ts`)

The pure core is the pin target (`thumbFlow.ts`); the adapter's global-free parts
are pinned via the same file with tiny fakes where DOM is needed (none — the
adapter's tick uses `getBoundingClientRect`, which is not Node-testable; the
decision logic it consumes is).

1. **Velocity matrix**: engaged → warmup blocks → open after WARMUP_MS; scroll
   event → blocked for SCROLL_HOLD_MS → open after decay; scroll DURING hold → hold
   extends (re-arm); warmup fires once.
2. **Batch pacing**: `planArming(now, lastArmedAt, count)` — before interval → 0,
   after → min(MAX_PER_TICK, count).
3. **Eviction invariant**: `MAX_ZERO_SIZE_RETRIES`-deadline via the same wall clock
   the loader uses (pure `planDrops` decision).
4. **SW: `tests/swCoverCache.test.ts` — a VM-sandbox harness executing the
   REAL `public/sw.js`** (host globals injected; `self` = the sandbox global;
   dispatch through the registered fetch listener). CORRECTED during
   implementation: the earlier claim that the e2e smoke gate covers sw.js was
   WRONG — `main.ts` skips SW registration on localhost, so no Playwright boot
   ever executes the worker. Pins: endpoint discrimination (cross-origin,
   subpath), cache-first hits, URL-as-key staleness safety (salt rotation),
   ok/no-store/opaque caching predicate (caught the placeholder bug),
   stale-on-error, and the REAL 301→240 watermark trim incl. put-before-trim.

## 5. Files touched

| File | Change |
|---|---|
| `src/lib/thumbFlow.ts` | NEW — pure velocity/warmup/batch core |
| `src/lib/thumbLoader.ts` | Consults the flow in `tick`; debug snapshot export |
| `src/components/LazyThumb.svelte` | No scheduling change; still requestThumb/cancelThumb |
| `public/sw.js` | `isCoverArtUrl` + `COVER_CACHE` + cache-first handler + LRU |
| `src/app.css` | `.cv-cell` utility (with the popover trap comment) |
| `src/views/AlbumsView.svelte` | `cv-cell` on grid cells |
| `src/views/ArtistsView.svelte` | `cv-cell` on grid cells |
| `src/components/DebugHud.svelte` | Thumbnails section + copy payload |
| `tests/thumbLoader.test.ts` | NEW — velocity matrix + batch pacing + eviction |
| `tests/swCoverCache.test.ts` | NEW — VM-sandbox harness over the real `public/sw.js` |
| `AGENTS.md` | §2.5 thumbLoader entry update |
| `docs/DEVLOG.md` | Dated entry |

## 6. Rollout order

Single pass (they compose): velocity gate needs the SW change to be complete
(banked fly-bys), the HUD needs the loader counters, tests pin the core. All
gates: `npm run check` + `npm test` + e2e smoke (SW registration is exercised by
every e2e boot). [CORRECTION, carried from the implementation pass: e2e never
executes `sw.js` — `main.ts` skips SW registration on localhost — so the SW's
gate is the VM harness `tests/swCoverCache.test.ts`.]

## 7. Amendment 2026-09-17e — the re-review (slow scroll + the fake cross-session cache)

The user's pushback — "what if the user scrolls slowly? do thumbnails load when
it matters?" — exposed two defects in this design, both fixed same day:

1. **The binary scroll hold starved slow scrolling.** A slow continuous drag
   emits scroll events forever, so the 250 ms hold never opened and rows at the
   screen edge sat on placeholders until the finger lifted. Fix: the gate is
   two-tier (`thumbFlowSignal.visible`) — rows within half a viewport of center
   (`VISIBLE_HOLDOUT_RATIO = 0.5`) arm even mid-gesture; the far pre-roll stays
   held; `tick` caps the mid-gesture batch to the visible-tier count
   (`visibleCount`) so the nearest-8 splice cannot leak pre-roll rows into a
   live gesture. Net behavior at every speed: the reading position paints
   immediately, pre-rolling waits for stillness.
2. **The cross-session cache win was fake.** `buildAuthParams` minted a fresh
   random salt per process, so every getCoverArt URL rotated every boot and the
   URL-keyed cache started every session cold (the LRU also accumulated one
   near-duplicate set per session). Fixed in two layers: the SW key now strips
   auth params (`coverArtCacheKey` — art identity is `(origin, path, id, size)`,
   origin included so server B can never serve server A's art), and the salt is
   session-stable (localStorage `mmdrome:authSalt`, reused across restarts and
   credential changes — the Subsonic server validates `t === md5(password +
   s-as-sent)`, so ANY salt is valid; the token is re-derived from the new
   password over the same salt). The salt is not a secret: it rides every
   request URL cleartext by protocol. This also fixes the DEVLOG-903
   native-snapshot restart 401 and makes the server's `no-cache`+ETag
   revalidation actually hit on the web HTTP cache.

New/changed pins: `tests/thumbLoader.test.ts` (visible-tier matrix),
`tests/authSalt.test.ts` (persistence, rotation, no-storage fallback).
AGENTS.md §2.5 (two-tier gate) and §3.6 (session-stable salt) carry the
invariants.

### 7.1 Warmup removed (2026-09-17g)

The §2.1 400 ms mount warmup was removed (see the 2026-09-17g DEVLOG entry):
the visible tier already bounds what a mount can arm, so the warmup only
bought avoidable placeholder time. `WARMUP_MS`/`engagedAt` are gone from the
signal; a first tick arms the reading position immediately.

## 8. Amendment 2026-09-17f — the SW cover cache REMOVED

The §2.2/§5/§7 cover-cache layers (cache-first handler, LRU watermark,
normalized `coverArtCacheKey`, and the `tests/swCoverCache.test.ts` harness)
were REMOVED after the user challenged the storage/staleness trade — see the
2026-09-17f DEVLOG entry. Summary: once the stable salt (§7) made cover URLs
survive restarts, the browser's own HTTP cache does the job with correct
invalidation (ETag 304 revalidation, `no-store` placeholders never cached,
browser-managed eviction) at zero app code and zero extra app storage; the
app-level layer double-stored bytes, never revalidated, and could persist
placeholder bodies for opaque cross-origin servers. The velocity gate, the
distance queue, cv-cells, the HUD section, and the salt all stay. Do not
re-add an app-level cover cache without solving revalidation, opaque-entry
expiry, and storage accounting first.

## 9. Amendment 2026-09-17j — the scrollbar-firehose (field report from 1.2.23)

The user reported on 1.2.23: slow scroll fine; a scrollbar-style fast jump broke
cover loading entirely, and a restart at a far position took +5 s before covers
began. The e2e harness (tests/e2e/thumbflow.spec.ts, cover mock delayed 120 ms)
reproduced and measured both root causes:

1. **The visible tier was unthrottled mid-gesture.** A scrollbar teleport is a
   continuous stamped-event stream; every intermediate screen passes through
   the ±0.5 vh holdout for ≥1 tick, so the tier re-armed NEW rows at full
   cadence (8/33 ms) — ~140 stale fetches per 1.5 s drag. The §5 §7 fixes
   bounded WHICH rows and capped the batch, but nothing paced how OFTEN the
   tier could re-arm on new rows. Fix: `planArming` takes a pace; the blocked
   path uses (GESTURE_VISIBLE_BATCH=4, SCROLL_HOLD_MS), the open path (8,
   MIN_ARM_INTERVAL_MS). Stale arming: O(screens) → O(hold windows).
2. **LazyThumb latched loaded imgs forever.** 53 cover imgs mounted after one
   fling, 6 near the viewport. In-flight stale fetches cannot be aborted from
   JS while the element lives — the unmount IS the abort. Fix: a second IO
   (±2400 px ≈ 3 vh, matching the loader's drop zone) unmounts the img when
   the row leaves the far window; re-entry re-arms via the request observer;
   the stable salt makes re-requests HTTP-cache hits.

Measured after: mid-fling latched covers 29 → 0; post-fling mounted imgs
53 (6 near) → 9 (all near). Slow-scroll behavior (the §7 visible tier) is
unchanged — the gesture pace still paints the reading position within one
hold window. Restart-at-position latency was the same firehose shape: the
booted position queues while the previous session's bitmap memory is already
gone, and the first paint waits on the queue drain — bounded now by the same
pace fix.

Design law this amendment adds: **an arming policy must be paced in BOTH
states** — the open gate (batch pacing) and the blocked gate (tier pacing).
A cap without a pace re-arms unboundedly whenever the capped set is replaced
faster than the pace interval; a distance tier without an unlatch converts
every gesture into permanent memory.

## 10. Amendment 2026-09-17k — per-view + stress verification (the pipeline held; the assertions were the dishonest part)

Follow-up to §9: are the pacing + unlatch fixes correct on EVERY long-list
surface, not just Songs, and do they survive stress?

**Per-view matrix (tests/e2e/thumbflow-views.spec.ts).** Albums grid, Artists
grid, Queue view, view-switching — all pass against the same contract:
bounded mid-gesture arming, a loading landing screen, a viewport-sized mounted
set. The grids lean on the unlatch harder than Songs (chunking can mount the
whole 220-group library under a fling); QueueView is UNCHUNKED by design (its
drag/reorder reactivity needs the full list) and leans entirely on gate pacing
plus the unlatch window — that leaning is now pinned by test.

**Stress (tests/e2e/thumbflow-stress.spec.ts).** Compounding fling-and-settle
rounds stay flat (no unlatch leak across gestures); mid-gesture reversal
re-arms the landing; the grid slow-drag loads the reading position MID-gesture
(sampled in-page while scroll events still fire — sampling after the drag
proves nothing, the gate has re-opened); queue close/reopen mid-fling strands
nothing.

**Methodology corrections baked into tests/e2e/thumbflowHelpers.ts.** Two of
the first suite's failures were the TEST lying, not the app: landings must be
asserted as a near-band LOAD RATIO (absolute counts calibrated on Songs' 44 px
list rows lie on 240 px grid cells and at clamped list ends, where the band is
genuinely ~5 cells — a stuck band still fails: near=0 → ratio 0); queue
counters must be SCOPED to the overlay scroller (the library stays mounted
underneath the z-40 queue overlay); and the queue's real open path is mini
player → Now Playing → Open queue, with closeQueue() deliberately reopening
Now Playing when a track exists. The shared helpers are owned ONCE so the
counting rules cannot drift between specs.

Gates: 968 unit, 34/34 e2e.

## 11. Amendment 2026-09-17l — realistic queue accumulation (play-through + 500-song flood)

The §10 queue cases enqueued by button; the real long queue grows through
PLAY: each advance promotes the played auto row into the user queue
(promoteActiveTrack on the post-load path) while replenish refills the auto
side, so history accumulates ABOVE current. Two suites in
tests/e2e/queueflood.spec.ts drive exactly that:

- Play-through: 40 mini-bar Next presses (scoped as offline-advance.spec
  does) grow the user queue to 41 rows; mid-fling arming 4 (one pace batch);
  history-top landing 8/8 loaded; 8 mounted total.
- Mega-album flood: a 500-song single-album catalog + Play All renders 550
  UNCHUNKED queue rows; down-fling arms 0 mid-gesture; landing 8/8; 8
  mounted. The unchunked QueueView's reliance on gate pacing + the unlatch
  window survives its worst case.

Helpers generalized: bootSongLibrary(page, songs) takes a custom catalog
(the stream mock's 74-hour WAV keeps advances explicit — nothing ends on its
own). Test-authoring lessons: Play All does not open Now Playing (sanity =
scoped row count in the queue scroller), and the bottom nav is directly
reachable after playing from Songs.

Gates: 968 unit, 36/36 e2e.

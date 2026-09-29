<script lang="ts">
  import { onMount } from 'svelte'
  import { coverLadderUrls, microCoverUrl, hasCoverBeenLoaded, noteCoverLoaded } from '../lib/coverArtCache'
  import { coverConfig } from '../lib/navidromeApi'
  import { requestThumb, cancelThumb } from '../lib/thumbLoader'
  import { effectiveLowData } from '../lib/networkMode'
  import { effectiveThumbSize, shouldSwapThumbSize } from '../lib/transcodePolicy'
import { thumbFlowGestureActive } from '../lib/thumbFlow'
  import { coverStatsRecord } from '../lib/coverStats'
  import type { Track } from '../stores/appState'

  let { track, wrapperClass = '', size = 128, windowed = false }: { track: Track; wrapperClass?: string; size?: 96 | 128 | 256 | 512; windowed?: boolean } = $props()

  /** Blur the micro only when its 32 px source is genuinely UPSCALED into the
   *  target (grid cells 256/512 — the wash is the point there, and the upscale
   *  needs hiding). Row thumbs (96/128 → 40 px CSS) render the micro ~1:1 or
   *  downscaled: an unblurred 32 px upscale of a 40 px box reads as an
   *  intentional soft thumbnail, and the blur was a per-loading-row filter
   *  surface paid during exactly the landing bursts (P4, 2026-09-23). */
  let blurMicro = $derived(size >= 256)

  let visible = $state(false)
  /** The loader's cached-lane claim at arm time: the cover URL already loaded
   *  successfully this SESSION (coverArtCache's loaded-URL memory — component
   *  lifetime ended at the last virtual-window unmount, so component-lifetime
   *  memory could never claim a remounted row). Cached arms skip the micro
   *  wash REQUEST entirely and reveal on the main's own onload — on a fast
   *  connection that is decode-latency only. */
  let armedCached = $state(false)
  /** Reveal gate for the MAIN cover, flipped by the main img's OWN onload —
   *  never by the micro's. (The micro usually arrives first; the old shared
   *  flag started the crossfade before the main existed, washing out to a
   *  blank row — the "blurry for the last 0.05 s" report.) The wash persists
   *  statically under the pending main; the swap is instant. */
  let mainLoaded = $state(false)
  let container: HTMLDivElement

  // Far-window unlatch (2026-09-17j, the "scrollbar-style jump broke covers"
  // field report): once a row is FAR outside the viewport (~3 viewport
  // heights, matching the loader's 3×vh drop zone) its loaded cover UNMOUNTS.
  // The old latch kept every <img> the session ever armed mounted forever —
  // each flown-past fetch ran to completion, each decoded bitmap stayed
  // resident, and on a real network the in-flight stale fetches saturated the
  // connection pool so the landing screen's covers queued behind them
  // ("+5 seconds to load the current position"). Unmounting aborts the
  // in-flight fetch, frees the decode, and lets the element's src (and the
  // browser HTTP cache — the stable salt keeps URLs stable across sessions)
  // serve the re-request instantly when the user scrolls back. Re-entry
  // re-fires the request observer below (IO reports every crossing), so
  // nothing strands.

  // Cover failure ladder (fixes the latched fallback): failed URLs are
  // remembered PER URL — never per component lifetime — so a transient error
  // steps down to the next smaller rendition (and retries the SAME url after
  // the ladder wraps), while a track/config change starts the ladder fresh.
  let failedUrls = $state<ReadonlySet<string>>(new Set())
  let attemptIndex = $state(0)

  /** The gesture-time DOM freeze: drop the mounted img + reset the render
   *  identity. Invoked by the unlatch observer when the row leaves the far
   *  window OUTSIDE a gesture — mid-gesture the observer only sets
   *  `gesturePendingUnlatch` and this runs on the next settle re-check
   *  instead. The img unmounts — nothing is displayed anymore, so the render
   *  identity resets; the next arm re-derives the ladder at the wanted size
   *  (a deferred LDM downgrade lands here, costing nothing extra: the row was
   *  going to re-request anyway). */
  function unlatch(): void {
    visible = false
    renderedSize = 0
    gesturePendingUnlatch = false
    cancelThumb(container)
  }

  const fallbackIcon = `${import.meta.env.BASE_URL}icon-192.png`

  /** Cover-stats feed (P6): every LazyThumb is a cover render point, so it
   *  records outcomes into the pure ring (tests/coverStats.test.ts) — the
   *  "thumbnails don't load" reports become dump-visible numbers (failures,
   *  ladder step-downs, mean latency) instead of deduction. Module-level
   *  singleton state, tiny sync appends. */
  function noteMainCover(ladderStep: number, loadMs: number | null, outcome: 'ok' | 'failed'): void {
    coverStatsRecord({ role: 'main', size: renderTarget, ladderStep, loadMs, outcome })
  }

  // LDM steps the thumbnail down one canonical level (256→128, 128→96) — the
  // quantified data saving (~4 MB on a cold full-library browse; grids
  // dominate) with 512 EXEMPT (2026-09-23 decision: Now Playing hero art
  // never softens; row thumbs are 40 px CSS and grids downscale heavily, so
  // their step is invisible). The derived chain re-derives the URL when the
  // effective mode flips. A track/config change restarts the ladder (the
  // fallback icon must never outlive its failure — the stale-snapshot cover
  // bug); the FAILURE ladder still only steps down after a URL fails.
  let lowDataActive = $derived($effectiveLowData)
  let effectiveSize = $derived(effectiveThumbSize({ size, lowDataActive }))

  /** The size the row's cover was last RENDERED with — the render-derived
   *  variant of `displayedSize`. When LDM toggles, the wanted size changes;
   *  `shouldSwapThumbSize` decides whether that re-requests (an upsize always,
   *  a downgrade only on the next arm) and holding the old ladder keeps the
   *  loaded `<img>` mounted through the defer. Tracking it in $state (not a
   *  Map keyed by trackId) means it resets naturally on unmount and on the
   *  reset effect's identity change — no per-row bookkeeping to leak. */
  let renderedSize = $state(0)

  let coverCfg = $derived($coverConfig)

  // Downgrade-defer (shouldSwapThumbSize): while a size downgrade is deferred
  // for a loaded cover, the ladder keeps the RENDERED size — the loaded img
  // stays, no re-request. `renderTarget` is the size the ladder is actually
  // built with; the effect below records exactly that (recording the wanted
  // size on a defer would corrupt the baseline). On the next arm (re-entry
  // after unlatch) renderedSize is 0 again and the new size flows through.
  let renderTarget = $derived.by(() => {
    if (!track || !coverCfg) return 0
    const swap = shouldSwapThumbSize({ displayedSize: renderedSize, wantedSize: effectiveSize })
    return swap ? effectiveSize : renderedSize
  })
  let ladder = $derived.by(() => {
    if (!track || !coverCfg || !renderTarget) return [] as string[]
    return coverLadderUrls(track, coverCfg, renderTarget)
  })

  // Blurred micro-rendition placeholder: a ~1–2 KB `size=32` rendition painted
  // blurred+enlarged UNDER the real image, so an armed row shows the cover's
  // color wash immediately instead of a flat surface while the real rendition
  // downloads (slow LAN / cold server resize cache). The wash renders at a
  // STATIC opacity while the main img is pending and unmounts the moment the
  // main's own onload flips `mainLoaded` — a failed micro is simply not shown
  // (the failure ladder below still governs the real attempts).
  let microFailed = $state(false)
  let microUrl = $derived.by(() => {
    if (!track || !coverCfg) return null
    const url = microCoverUrl(track, coverCfg)
    return url === '' ? null : url
  })

  let currentUrl = $derived.by(() => {
    for (let i = attemptIndex; i < ladder.length; i++) {
      const url = ladder[i]
      if (!failedUrls.has(url)) return url
    }
    return null
  })

  $effect(() => {
    // Any identity change (track, config, LDM size) resets the ladder AND its
    // failure memory — old-URL failures must not suppress the new attempts.
    // Record exactly the size the ladder was built with: on a deferred
    // downgrade that is the OLD size (a no-op — the defer holds); on an
    // upsize/first-load it is the new wanted size.
    // READS ONLY ladder/renderTarget: this effect must NEVER read currentUrl —
    // reading it re-runs the wipe on every failure step-down (currentUrl is
    // derived from attemptIndex/failedUrls, which this effect writes), and the
    // wipe re-opens the step the error just closed — an infinite refetch loop
    // (2650 cover requests in 8 s against a failing-cover mock, 2026-09-29).
    void ladder
    renderedSize = renderTarget
    failedUrls = new Set()
    attemptIndex = 0
  })

  // The REVEAL state resets only on a genuine URL change, in its OWN effect:
  // the micro carries no onload of its own anymore (it is never the reveal
  // trigger), so a same-URL re-run — a config-store identity churn, a ladder
  // array rebuild — that wiped `mainLoaded` would leave a LOADED cover washed
  // forever (nothing would re-fire onload to re-reveal it). A URL change
  // (identity, LDM, or a failure step-down) re-arms the wash and the reveal
  // gate legitimately: the new src fires its own onload.
  $effect(() => {
    if (currentUrl !== lastRevealUrl) {
      lastRevealUrl = currentUrl
      microFailed = false
      armedCached = false
      mainLoaded = false
    }
  })

  /** The URL the reveal state was last reset for — the change-detector that
   *  keeps same-URL effect re-runs from washing a loaded cover. */
  let lastRevealUrl: string | null = null

  /** Arm timestamp for the cover-stats loadMs (set by EVERY arm callback —
   *  the IO path and the windowed loader path alike; NOT component init, or
   *  pre-roll time would count). */
  let armedAt = 0

  // Gesture-time DOM freeze (2026-09-28, the "songs tab lags when scrolling"
  // report): mid-gesture the unlatch observer used to unmount covers the
  // flick flew past and the loader re-armed them as fresh, so every glide
  // traded one DOM remove + one insert per row crossed — traced as 62 Paint
  // chunks/frame on a phone-class CPU (4× throttle), p50 frame ~150–190 ms.
  // Deferring the unmount until the gesture settles changes NOTHING about
  // what is fetched (the cached lane already arms at frame cadence when
  // settled) — it only stops the churn DURING the gesture, when frames are
  // most precious. The pooled imgs stay pooled; the pre-roll still prefetches
  // (fetching is network work, not main-thread work).
  let gesturePendingUnlatch = false

  function handleImgError(): void {
    const url = currentUrl
    if (!url) return
    const next = new Set(failedUrls)
    next.add(url)
    failedUrls = next
    // Jump straight past every URL known-failed (the exhausted last url is
    // re-attempted once the ladder wraps — transient errors deserve it).
    let idx = attemptIndex
    while (idx < ladder.length && failedUrls.has(ladder[idx])) idx++
    attemptIndex = idx
    // Ladder exhausted → the app-icon fallback renders. Recorded HERE (once,
    // per give-up — not per intermediate URL failure; the step that answered
    // is recorded by the eventual onload's ladderStep).
    if (idx >= ladder.length) noteMainCover(idx, null, 'failed')
  }

  onMount(() => {
    // WINDOWED mode (2026-09-28): the parent renders a virtual window (only
    // SongsView today), so visibility is DERIVED — a mounted row is by
    // definition near the viewport and an unmounted row cannot fire anything
    // (its component, observers, img and loader entry all cease to exist
    // together). No request/unlatch observers here; the thumbLoader's lane
    // pacing remains the fetch throttle, and its 6-vh rect drop zone still
    // bounds stray entries. Covers arm on mount, re-arm on any identity
    // change via the reset effect, and cancel on unmount below.
    if (windowed) {
      // Route the arm through the loader LANES (2026-09-28 ship review): the
      // parent window owns VISIBILITY (a mounted row is by definition in the
      // window), but the loader owns PACING — tier priority, the band
      // trickle, and the mid-gesture stability gate. The direct
      // `visible = true` arm bypassed all of it: every window mount fired its
      // requests immediately, mid-fling included, re-creating the landing
      // firehose one layer down (the >3 s cached-landing report). Cached
      // claims (session memory) ride the frame-cadence cached lane.
      const cached = hasCoverBeenLoaded(currentUrl)
      armedCached = cached
      requestThumb(container, () => { visible = true; armedAt = performance.now() }, cached)
      return () => cancelThumb(container)
    }
    const req = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !visible) {
          const cached = hasCoverBeenLoaded(currentUrl)
          armedCached = cached
          requestThumb(container, () => { visible = true; armedAt = performance.now() }, cached)
        }
      },
      // 2000px pre-roll (widened 2026-09-17 from 800px, the "far scroll takes
      // ~5 s to catch up / placeholders flash for a split second" report): the
      // pre-roll must exceed momentum travel (~3 viewports on a phone) so rows
      // the flick decelerates THROUGH fetch before they arrive. ~2 viewports
      // of lead ≈ several rows of list / one row of grid — paid only when the
      // gate opens (the pace gate holds the whole band mid-gesture), so the
      // widening costs bandwidth exactly when it buys lead time.
      { rootMargin: '2000px' }
    )
    req.observe(container)

    // The unlatch observer: a static ±4000px box ≈ 4 viewport heights on a
    // phone (widened 2026-09-17 from ±2400px in step with the pre-roll — the
    // unlatch is FREE bandwidth-wise, it only keeps fetched images alive, and
    // a wider window is what makes scroll-BACK instant). Crossing OUT of it
    // drops the mounted img (visible=false); the request observer above
    // re-arms on re-entry. Both observers live for the component's lifetime
    // — visibility is a cycle, not a latch.
    const far = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting && visible) {
          if (thumbFlowGestureActive()) {
            // Mid-gesture: DEFER the unmount. The arm request observer below
            // still runs, so a true re-entry (scrolled back within 2000 px)
            // re-arms normally; this flag only stops the pooled img from
            // being torn down while the user is moving.
            gesturePendingUnlatch = true
            return
          }
          unlatch()
        }
      },
      { rootMargin: '4000px' }
    )
    far.observe(container)

    // Settle re-check: a gesture deferred a pending unlatch; run it the
    // moment the gesture ends (the first rAF with no recent scroll event).
    // One rAF loop ONLY while a deferral is pending — this is not a polling
    // loop (the arm request observer below remains the arm driver).
    let settleRaf = 0
    const settleCheck = () => {
      settleRaf = 0
      if (!gesturePendingUnlatch) return
      if (thumbFlowGestureActive()) {
        settleRaf = requestAnimationFrame(settleCheck)
        return
      }
      if (!container.isConnected) return
      const r = container.getBoundingClientRect()
      // Same geometry as the unlatch observer's ±4000px box: if the row has
      // COME BACK (user reversed mid-gesture), the deferral is moot.
      if (r.top < window.innerHeight + 4000 && r.bottom > -4000) {
        gesturePendingUnlatch = false
        return
      }
      unlatch()
    }
    const armSettleCheck = () => {
      if (settleRaf === 0) settleRaf = requestAnimationFrame(settleCheck)
    }
    const stopSettleCheck = () => {
      if (settleRaf !== 0) {
        cancelAnimationFrame(settleRaf)
        settleRaf = 0
      }
    }
    const onScrollForSettle = () => armSettleCheck()
    document.addEventListener('scroll', onScrollForSettle, { capture: true, passive: true })

    return () => {
      req.disconnect()
      far.disconnect()
      cancelThumb(container)
      document.removeEventListener('scroll', onScrollForSettle, { capture: true } as EventListenerOptions)
      stopSettleCheck()
    }
  })
</script>

<div bind:this={container} class="{wrapperClass} relative overflow-hidden bg-surface-hover">
  {#if visible}
    {#if currentUrl && microUrl && !microFailed && !armedCached && !mainLoaded}
      <!-- Micro-rendition wash: sits BEHIND the pending main at a STATIC
           opacity — no fade either direction (the user's explicit call: the
           cover snaps in the moment its pixels exist; the wash IS the loading
           progression). Unmounts in the same frame the main's own onload
           flips mainLoaded — no crossfade, no blank gap between the two. -->
      <img
        src={microUrl}
        alt=""
        class="absolute inset-0 h-full w-full object-cover opacity-60 {blurMicro ? 'scale-110 blur-xl' : ''}"
        decoding="async"
        onerror={() => { microFailed = true; coverStatsRecord({ role: 'micro', size: 0, ladderStep: 0, loadMs: null, outcome: 'micro-failed' }) }}
      />
    {/if}
    {#if currentUrl}
      <!-- No loading="lazy": scheduling is OWNED by the thumbLoader lanes,
           and the browser's own lazy threshold (small on iOS Safari) would
           re-defer cells armed early — fighting the lane plan. NO opacity
           transition (2026-09-29 user call — do NOT reintroduce one): the
           reveal gate below IS the loading state. -->
      <img
        src={currentUrl}
        alt=""
        class="h-full w-full object-cover {mainLoaded ? 'opacity-100' : 'opacity-0'}"
        decoding="async"
        onerror={handleImgError}
        onload={() => {
          noteCoverLoaded(currentUrl)
          mainLoaded = true
          const loadMs = performance.now() - armedAt
          // armedAt is set in the SAME arm callback that flips `visible`, so
          // a pre-arm load is impossible; the floor guards a reset-order edge.
          if (loadMs >= 0) noteMainCover(attemptIndex, loadMs, 'ok')
        }}
      />
    {:else}
      <!-- No cover URL, the ladder exhausted, or no cover config: the app icon.
           A transient failure recovers on the next track/config change (the
           failure memory resets with the ladder). -->
      <img src={fallbackIcon} alt="" class="h-full w-full object-cover opacity-60" decoding="async" />
    {/if}
  {/if}
</div>
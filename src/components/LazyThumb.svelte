<script lang="ts">
  import { onMount } from 'svelte'
  import { coverLadderUrls, microCoverUrl } from '../lib/coverArtCache'
  import { coverConfig } from '../lib/navidromeApi'
  import { requestThumb, cancelThumb } from '../lib/thumbLoader'
  import { effectiveLowData } from '../lib/networkMode'
  import { effectiveThumbSize, shouldSwapThumbSize } from '../lib/transcodePolicy'
  import type { Track } from '../stores/appState'

  let { track, wrapperClass = '', size = 128 }: { track: Track; wrapperClass?: string; size?: 96 | 128 | 256 | 512 } = $props()

  let visible = $state(false)
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

  /** The URL whose <img> last fired a successful LOAD. The loader's cached
   *  lane claim is derived from it (currentUrl === lastLoadedUrl): a revisit
   *  after unlatch re-requests the SAME URL — an immutable-cover HTTP-cache
   *  hit, no network — so the loader arms it at frame cadence instead of
   *  pacing it behind fresh rows (paced free operations were the pop-in).
   *  Any identity change (track, config, LDM size) produces a different
   *  currentUrl, which invalidates the claim with zero bookkeeping; a FAILED
   *  url never sets it (onload only), so an error retry re-arms as fresh. */
  let lastLoadedUrl: string | null = null

  const fallbackIcon = `${import.meta.env.BASE_URL}icon-192.png`

  // LDM steps the thumbnail down one canonical level (512→256→128→96); the
  // derived chain re-derives the URL when the effective mode flips. A
  // track/config change restarts the ladder (the fallback icon must never
  // outlive its failure — the stale-snapshot cover bug).
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
  // downloads (slow LAN / cold server resize cache). Hidden once the real
  // image fires onload — a failed micro is simply not shown (the failure
  // ladder below still governs the real attempts).
  let microLoaded = $state(false)
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
    void ladder
    renderedSize = renderTarget
    failedUrls = new Set()
    attemptIndex = 0
    // The placeholder underlay belongs to the SAME identity — a new track's
    // micro rendition (or a failed one) must never bleed into the next row.
    microLoaded = false
    microFailed = false
  })

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
  }

  onMount(() => {
    const req = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !visible) {
          const cached = currentUrl !== null && currentUrl === lastLoadedUrl
          requestThumb(container, () => { visible = true }, cached)
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
          visible = false
          // The img unmounts — nothing is displayed anymore, so the render
          // identity resets. The next arm re-derives the ladder at the wanted
          // size (a deferred LDM downgrade lands here, costing nothing extra:
          // the row was going to re-request anyway).
          renderedSize = 0
          cancelThumb(container)
        }
      },
      { rootMargin: '4000px' }
    )
    far.observe(container)

    return () => {
      req.disconnect()
      far.disconnect()
      cancelThumb(container)
    }
  })
</script>

<div bind:this={container} class="{wrapperClass} relative overflow-hidden bg-surface-hover">
  {#if visible}
    <!-- Micro-rendition underlay: sits BEHIND the real image and fades OUT
         over the same 300 ms the real image fades IN — a crossfade, not a
         pop. Stays mounted for the identity's lifetime (removal would churn
         the DOM and cut the fade short). -->
    {#if microUrl && !microFailed}
      <img
        src={microUrl}
        alt=""
        class="absolute inset-0 h-full w-full scale-110 object-cover blur-xl transition-opacity duration-300 {microLoaded ? 'opacity-0' : 'opacity-60'}"
        decoding="async"
        onerror={() => { microFailed = true }}
        onload={() => { microLoaded = true }}
      />
    {/if}
    {#if currentUrl}
      <!-- No loading="lazy": scheduling is OWNED by the IO pre-roll + thumbLoader
           queue, and the browser's own lazy threshold (small on iOS Safari) would
           re-defer cells armed early — fighting the pre-roll. -->
      <img
        src={currentUrl}
        alt=""
        class="h-full w-full object-cover transition-opacity duration-300 {microUrl && !microLoaded ? 'opacity-0' : 'opacity-100'}"
        decoding="async"
        onerror={handleImgError}
        onload={() => { lastLoadedUrl = currentUrl; microLoaded = true }}
      />
    {:else}
      <!-- No cover URL, the ladder exhausted, or no cover config: the app icon.
           A transient failure recovers on the next track/config change (the
           failure memory resets with the ladder). -->
      <img src={fallbackIcon} alt="" class="h-full w-full object-cover opacity-60" decoding="async" />
    {/if}
  {/if}
</div>
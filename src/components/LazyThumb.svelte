<script lang="ts">
  import { onMount } from 'svelte'
  import { coverLadderUrls } from '../lib/coverArtCache'
  import { coverConfig } from '../lib/navidromeApi'
  import { requestThumb, cancelThumb } from '../lib/thumbLoader'
  import { effectiveLowData } from '../lib/networkMode'
  import { effectiveThumbSize } from '../lib/transcodePolicy'
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

  const fallbackIcon = `${import.meta.env.BASE_URL}icon-192.png`

  // LDM steps the thumbnail down one canonical level (512→256→128→96); the
  // derived chain re-derives the URL when the effective mode flips. A
  // track/config change restarts the ladder (the fallback icon must never
  // outlive its failure — the stale-snapshot cover bug).
  let lowDataActive = $derived($effectiveLowData)
  let effectiveSize = $derived(effectiveThumbSize({ size, lowDataActive }))

  let coverCfg = $derived($coverConfig)

  let ladder = $derived.by(() => {
    // lowDataActive is read through effectiveSize; track/config identity keys
    // the ladder so the reset effect below re-runs on any change.
    if (!track || !coverCfg) return [] as string[]
    return coverLadderUrls(track, coverCfg, effectiveSize)
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
    void ladder
    failedUrls = new Set()
    attemptIndex = 0
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
          requestThumb(container, () => { visible = true })
        }
      },
      // 800px pre-roll (2026-09-14, the "albums load slowly on a fast network"
      // report): at 100px a grid cell was queued when it was already nearly on
      // screen, so the user always watched the placeholder through queue +
      // fetch + decode. 800px arms a cell several rows early — enough scroll
      // time for a fast server to have the cover ready before it scrolls in.
      { rootMargin: '800px' }
    )
    req.observe(container)

    // The unlatch observer: a static ±2400px box ≈ 3 viewport heights on a
    // phone. Crossing OUT of it drops the mounted img (visible=false); the
    // request observer above re-arms on re-entry. Both observers live for the
    // component's lifetime — visibility is a cycle, not a latch.
    const far = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting && visible) {
          visible = false
          cancelThumb(container)
        }
      },
      { rootMargin: '2400px' }
    )
    far.observe(container)

    return () => {
      req.disconnect()
      far.disconnect()
      cancelThumb(container)
    }
  })
</script>

<div bind:this={container} class="{wrapperClass} overflow-hidden bg-surface-hover">
  {#if visible && currentUrl}
    <!-- No loading="lazy": scheduling is OWNED by the IO pre-roll + thumbLoader
         queue, and the browser's own lazy threshold (small on iOS Safari) would
         re-defer cells armed early — fighting the pre-roll. -->
    <img
      src={currentUrl}
      alt=""
      class="h-full w-full object-cover"
      decoding="async"
      onerror={handleImgError}
    />
  {:else if visible}
    <!-- No cover URL, the ladder exhausted, or no cover config: the app icon.
         A transient failure recovers on the next track/config change (the
         failure memory resets with the ladder). -->
    <img src={fallbackIcon} alt="" class="h-full w-full object-cover opacity-60" decoding="async" />
  {/if}
</div>
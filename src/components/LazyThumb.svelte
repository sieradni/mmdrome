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
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !visible) {
          requestThumb(container, () => { visible = true })
        }
      },
      { rootMargin: '100px' }
    )
    obs.observe(container)
    return () => {
      obs.disconnect()
      cancelThumb(container)
    }
  })
</script>

<div bind:this={container} class="{wrapperClass} overflow-hidden bg-surface-hover">
  {#if visible && currentUrl}
    <img
      src={currentUrl}
      alt=""
      class="h-full w-full object-cover"
      loading="lazy"
      decoding="async"
      onerror={handleImgError}
    />
  {:else if visible}
    <!-- No cover URL, the ladder exhausted, or no cover config: the app icon.
         A transient failure recovers on the next track/config change (the
         failure memory resets with the ladder). -->
    <img src={fallbackIcon} alt="" class="h-full w-full object-cover opacity-60" loading="lazy" decoding="async" />
  {/if}
</div>
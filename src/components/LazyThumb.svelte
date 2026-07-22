<script lang="ts">
  import { onMount } from 'svelte'
  import { getCoverUrl } from '../lib/coverArtCache'
  import type { Track } from '../stores/appState'

  let { track, wrapperClass = '' }: { track: Track; wrapperClass?: string } = $props()

  let visible = $state(false)
  let container: HTMLDivElement

  onMount(() => {
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          visible = true
          obs.disconnect()
        }
      },
      { rootMargin: '100px' }
    )
    obs.observe(container)
    return () => obs.disconnect()
  })
</script>

<div bind:this={container} class="{wrapperClass} overflow-hidden bg-surface-hover">
  {#if visible}
    <img src={getCoverUrl(track)} alt="" class="h-full w-full object-cover" loading="lazy" />
  {/if}
</div>

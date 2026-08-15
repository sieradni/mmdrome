<script lang="ts">
  import { onMount } from 'svelte'
  import { getCoverUrl } from '../lib/coverArtCache'
  import { coverConfig } from '../lib/navidromeApi'
  import { requestThumb, cancelThumb } from '../lib/thumbLoader'
  import type { Track } from '../stores/appState'

  let { track, wrapperClass = '' }: { track: Track; wrapperClass?: string } = $props()

  let visible = $state(false)
  let failed = $state(false)
  let container: HTMLDivElement

  const fallbackIcon = `${import.meta.env.BASE_URL}icon-192.png`

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
  {#if visible && $coverConfig && !failed}
    <img
      src={getCoverUrl(track, $coverConfig)}
      alt=""
      class="h-full w-full object-cover"
      loading="lazy"
      decoding="async"
      crossorigin="anonymous"
      onerror={() => (failed = true)}
    />
  {:else if visible && (failed || $coverConfig === null)}
    <img src={fallbackIcon} alt="" class="h-full w-full object-cover opacity-60" loading="lazy" decoding="async" />
  {/if}
</div>
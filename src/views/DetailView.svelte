<script lang="ts">
  import { currentTrack, metadataCache } from '../stores/appState'
  import { commitFeedback } from '../lib/feedbackService'
  import TrackDetailPanel from '../components/TrackDetailPanel.svelte'
  import LazyThumb from '../components/LazyThumb.svelte'

  let { onback, oncloseall }: { onback: () => void; oncloseall: () => void } = $props()

  let rating = $state(0)
  let loved = $state(false)

  $effect(() => {
    const meta = $metadataCache.get($currentTrack?.trackId ?? '')
    if (meta) {
      rating = meta.rating ?? 0
      loved = meta.loved ?? false
    }
  })

  function commit() {
    const track = $currentTrack
    if (!track) return
    commitFeedback(track, rating, loved)
  }

  function starSegments(r: number): ('full' | 'half' | 'empty')[] {
    const sv = Math.min(5, r / 20)
    const segs: ('full' | 'half' | 'empty')[] = []
    for (let i = 0; i < 5; i++) {
      const v = Math.max(0, Math.min(1, sv - i))
      if (v >= 0.75) segs.push('full')
      else if (v >= 0.25) segs.push('half')
      else segs.push('empty')
    }
    return segs
  }

  function toggleLoved() {
    loved = !loved
    commit()
  }
</script>

<div class="flex h-full flex-col bg-background">
  <div class="flex items-center justify-between px-4 py-3">
    <span class="text-sm font-medium text-primary">Details</span>
    <div class="flex items-center gap-2">
      <button onclick={oncloseall} class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Library">
        <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" /></svg>
      </button>
      <button onclick={onback} class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Close">
        <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6l-12 12" /></svg>
      </button>
    </div>
  </div>

  <div class="flex-1 overflow-y-auto px-4">
    {#if $currentTrack}
      {@const meta = $metadataCache.get($currentTrack.trackId)}
      <div class="flex flex-col items-center pt-2 pb-4">
        <div class="aspect-square w-40 overflow-hidden rounded-xl bg-surface-hover shadow-lg">
          <LazyThumb track={$currentTrack} wrapperClass="h-full w-full" />
        </div>
        <h2 class="mt-3 text-lg font-bold text-primary text-center truncate max-w-full">{$currentTrack.title}</h2>
        <p class="text-sm text-muted text-center truncate max-w-full">{$currentTrack.artist}</p>
      </div>

      <!-- Rating -->
      <div class="space-y-2">
        <p class="text-xs font-medium text-muted uppercase tracking-wider">Rating</p>
        <div class="flex items-center gap-3">
          <input
            type="range"
            min="0"
            max="100"
            step="10"
            bind:value={rating}
            onchange={commit}
            class="h-1 flex-1 accent-yellow-500"
          />
          <span class="w-8 text-right text-xs tabular-nums text-muted">{rating}</span>
        </div>
        <div class="flex items-center gap-1">
          {#each starSegments(rating) as seg, i}
            <svg class="h-5 w-5" viewBox="0 0 24 24">
              {#if seg === 'half'}
                <defs>
                  <linearGradient id="dv-{i}">
                    <stop offset="50%" stop-color="#facc15" />
                    <stop offset="50%" stop-color="transparent" />
                  </linearGradient>
                </defs>
              {/if}
              <path
                d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26Z"
                fill={seg === 'full' ? '#facc15' : seg === 'half' ? 'url(#dv-' + i + ')' : 'none'}
                stroke={seg === 'empty' ? '#555' : '#facc15'}
                stroke-width="1"
              />
            </svg>
          {/each}
        </div>
      </div>

      <!-- Loved -->
      <div class="mt-4 space-y-2 pb-6">
        <p class="text-xs font-medium text-muted uppercase tracking-wider">Loved</p>
        <button
          onclick={toggleLoved}
          class={loved
            ? 'flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-red-400 transition-colors'
            : 'flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover'}
        >
          {#if loved}
            <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
            </svg>
          {:else}
            <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
            </svg>
          {/if}
          <span>{loved ? 'Loved' : 'Not loved'}</span>
        </button>
      </div>

      <TrackDetailPanel track={$currentTrack} {meta} />
    {/if}

    <div class="h-8"></div>
  </div>
</div>

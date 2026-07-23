<script lang="ts">
  import { currentTrack, metadataCache, updateMetadata } from '../stores/appState'
  import type { Track } from '../stores/appState'
  import type { LocalMetadataStore } from '../lib/db'
  import LazyThumb from '../components/LazyThumb.svelte'

  let { onclose, onnavigate }: { onclose: () => void; onnavigate: (page: 'pitchSpeed' | 'eq' | 'volume' | 'detail' | 'settings') => void } = $props()

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
    const existing = $metadataCache.get(track.trackId)
    const meta: LocalMetadataStore = {
      trackId: track.trackId,
      rating,
      loved,
      filePath: existing?.filePath ?? track.filePath,
      fileType: existing?.fileType ?? track.fileType,
      syncStatus: 'pending_sync',
      lastModifiedLocally: Date.now(),
    }
    updateMetadata(meta)
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
</script>

<div class="flex h-full flex-col bg-background">
  <div class="flex items-center justify-end px-4 py-3">
    <button onclick={onclose} class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Close">
      <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6l-12 12" /></svg>
    </button>
  </div>

  <div class="flex-1 overflow-y-auto px-4">
    {#if $currentTrack}
      <div class="flex flex-col items-center">
        <div class="aspect-square w-48 overflow-hidden rounded-2xl bg-surface-hover shadow-xl">
          <LazyThumb track={$currentTrack} wrapperClass="h-full w-full" />
        </div>

        <h2 class="mt-4 text-lg font-bold text-primary text-center truncate max-w-full">{$currentTrack.title}</h2>
        <p class="text-sm text-muted text-center truncate max-w-full">{$currentTrack.artist}</p>
      </div>

      <!-- Rating -->
      <div class="mt-6 space-y-2">
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
                  <linearGradient id="tr-{i}">
                    <stop offset="50%" stop-color="#facc15" />
                    <stop offset="50%" stop-color="transparent" />
                  </linearGradient>
                </defs>
              {/if}
              <path
                d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26Z"
                fill={seg === 'full' ? '#facc15' : seg === 'half' ? 'url(#tr-' + i + ')' : 'none'}
                stroke={seg === 'empty' ? '#555' : '#facc15'}
                stroke-width="1"
              />
            </svg>
          {/each}
        </div>
      </div>

      <!-- Loved -->
      <div class="mt-6 space-y-2">
        <p class="text-xs font-medium text-muted uppercase tracking-wider">Loved</p>
        <button
          onclick={() => { loved = !loved; commit() }}
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

      <!-- Nav Buttons -->
      <div class="mt-6 space-y-1 border-t border-white/10 pt-6">
        <button onclick={() => onnavigate('pitchSpeed')} class="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-sm text-primary transition-colors hover:bg-surface-hover">
          <svg class="h-5 w-5 text-muted" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>
          <span>Pitch & Speed</span>
          <svg class="ml-auto h-4 w-4 text-muted/40" viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
        </button>
        <button onclick={() => onnavigate('eq')} class="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-sm text-primary transition-colors hover:bg-surface-hover">
          <svg class="h-5 w-5 text-muted" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/></svg>
          <span>Equalizer</span>
          <svg class="ml-auto h-4 w-4 text-muted/40" viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
        </button>
        <button onclick={() => onnavigate('volume')} class="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-sm text-primary transition-colors hover:bg-surface-hover">
          <svg class="h-5 w-5 text-muted" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
          <span>Volume</span>
          <svg class="ml-auto h-4 w-4 text-muted/40" viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
        </button>
        <button onclick={() => onnavigate('detail')} class="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-sm text-primary transition-colors hover:bg-surface-hover">
          <svg class="h-5 w-5 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
          <span>Details</span>
          <svg class="ml-auto h-4 w-4 text-muted/40" viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
        </button>
        <button onclick={() => onnavigate('settings')} class="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-sm text-primary transition-colors hover:bg-surface-hover">
          <svg class="h-5 w-5 text-muted" viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
          <span>Settings</span>
          <svg class="ml-auto h-4 w-4 text-muted/40" viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
        </button>
      </div>
    {/if}

    <div class="h-8"></div>
  </div>
</div>

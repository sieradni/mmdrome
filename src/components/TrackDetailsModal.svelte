<script lang="ts">
  import { metadataCache, updateMetadata } from '../stores/appState'
  import type { Track } from '../stores/appState'
  import type { LocalMetadataStore } from '../lib/db'

  let { track, onclose }: { track: Track; onclose: () => void } = $props()

  let rating = $state(0)
  let loved = $state(false)

  $effect(() => {
    const meta = $metadataCache.get(track.trackId)
    rating = meta?.rating ?? 0
    loved = meta?.loved ?? false
  })

  function commit() {
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

  function setStar(i: number) {
    const newRating = (i + 1) * 20
    rating = newRating === rating && rating > 0 ? 0 : newRating
    commit()
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

  function formatDate(ts?: number): string {
    if (ts == null) return '\u2014'
    return new Date(ts).toLocaleString()
  }

  function formatSize(bytes?: number): string {
    if (bytes == null) return '\u2014'
    const units = ['B', 'KB', 'MB', 'GB']
    let i = 0
    let s = bytes
    while (s >= 1024 && i < units.length - 1) { s /= 1024; i++ }
    return `${s.toFixed(1)} ${units[i]}`
  }

  function toggleLoved() {
    loved = !loved
    commit()
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
  onclick={onclose}
  onkeydown={(e) => { if (e.key === 'Escape') onclose() }}
>
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div
    class="mx-4 w-full max-w-lg rounded-xl border border-white/10 bg-surface shadow-2xl"
    onclick={(e) => e.stopPropagation()}
  >
    <!-- Header -->
    <div class="flex items-start justify-between border-b border-white/10 px-5 py-4">
      <div class="min-w-0 flex-1 pr-4">
        <h2 class="truncate text-base font-bold text-primary" title={track.title}>{track.title}</h2>
        <p class="truncate text-xs text-muted">{track.artist}</p>
      </div>
      <button
        onclick={onclose}
        class="flex-shrink-0 rounded-full p-1 text-muted transition-colors hover:text-primary"
        aria-label="Close"
      >
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M6 6l12 12M18 6l-12 12" />
        </svg>
      </button>
    </div>

    <!-- Metadata -->
    <div class="space-y-2 px-5 py-4">
      <div class="grid grid-cols-2 gap-x-4 gap-y-2">
        <div>
          <p class="text-xs font-medium text-muted">Artist</p>
          <p class="truncate text-sm text-primary" title={track.artist}>{track.artist}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-muted">Album</p>
          <p class="truncate text-sm text-primary" title={track.album}>{track.album}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-muted">Composer</p>
          <p class="truncate text-sm text-primary" title={track.composer || '\u2014'}>{track.composer || '\u2014'}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-muted">Year</p>
          <p class="text-sm text-primary">{track.year ?? '\u2014'}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-muted">Format</p>
          <p class="text-sm text-primary uppercase">{track.fileType}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-muted">Bitrate</p>
          <p class="text-sm text-primary">{track.bitrate != null ? `${track.bitrate} kbps` : '\u2014'}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-muted">Size</p>
          <p class="text-sm text-primary">{formatSize(track.size)}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-muted">Duration</p>
          <p class="text-sm text-primary">{Math.floor(track.duration / 60)}:{String(track.duration % 60).padStart(2, '0')}</p>
        </div>
      </div>

      <div>
        <p class="text-xs font-medium text-muted">File Path</p>
        <p class="truncate text-sm text-primary" title={track.filePath}>{track.filePath}</p>
      </div>

      <div class="grid grid-cols-2 gap-x-4 gap-y-2">
        <div>
          <p class="text-xs font-medium text-muted">Created</p>
          <p class="text-sm text-primary">{formatDate(track.createdAt)}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-muted">Modified</p>
          <p class="text-sm text-primary">{formatDate(track.modifiedAt)}</p>
        </div>
      </div>
    </div>

    <!-- Rating & Loved -->
    <div class="space-y-3 border-t border-white/10 px-5 py-4">
      <div>
        <p class="mb-1.5 text-xs font-medium text-muted">Rating</p>
        <div class="flex items-center gap-3">
          <div class="flex items-center gap-0.5">
            {#each starSegments(rating) as seg, i}
              <button
                onclick={() => setStar(i)}
                class="rounded p-0.5 transition-colors hover:scale-110"
                aria-label="Set rating to {(i + 1) * 20}"
              >
                <svg class="h-5 w-5" viewBox="0 0 24 24">
                  {#if seg === 'half'}
                    <defs>
                      <linearGradient id="mh-{track.trackId}-{i}">
                        <stop offset="50%" stop-color="#facc15" />
                        <stop offset="50%" stop-color="transparent" />
                      </linearGradient>
                    </defs>
                  {/if}
                  <path
                    d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26Z"
                    fill={seg === 'full' ? '#facc15' : seg === 'half' ? 'url(#mh-' + track.trackId + '-' + i + ')' : 'none'}
                    stroke={seg === 'empty' ? '#555' : '#facc15'}
                    stroke-width="1"
                  />
                </svg>
              </button>
            {/each}
          </div>
          <input
            type="range"
            min="0"
            max="100"
            bind:value={rating}
            onchange={commit}
            class="h-1 flex-1 accent-yellow-500"
          />
          <span class="w-8 text-right text-xs text-muted">{rating}</span>
        </div>
      </div>

      <div>
        <p class="mb-1.5 text-xs font-medium text-muted">Loved</p>
        <button
          onclick={toggleLoved}
          class={loved
            ? 'flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-1.5 text-sm text-red-400 transition-colors'
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
    </div>
  </div>
</div>


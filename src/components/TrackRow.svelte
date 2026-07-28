<script lang="ts">
  import { addToUserQueue, autoQueueFilters } from '../stores/appState'
  import { metadataCache } from '../stores/appState'
  import { playbackManager } from '../lib/playbackManager'
  import type { Track } from '../stores/appState'
  import LazyThumb from './LazyThumb.svelte'
  import TrackOptionsDropdown from './TrackOptionsDropdown.svelte'

  let { track, showAlbum = true, showDuration = false, showAlbumArtist = false, ondetails, onplay }: {
    track: Track
    showAlbum?: boolean
    showDuration?: boolean
    showAlbumArtist?: boolean
    ondetails?: () => void
    onplay?: (trackId: string) => void
  } = $props()

  function formatDuration(s: number): string {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${String(sec).padStart(2, '0')}`
  }

  function getRating(trackId: string): number {
    return $metadataCache.get(trackId)?.rating ?? 0
  }

  function getLoved(trackId: string): boolean {
    return $metadataCache.get(trackId)?.loved ?? false
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

  let added = $state(false)
  let addTimer: ReturnType<typeof setTimeout> | null = null

  function handleAdd(e: MouseEvent, trackId: string) {
    e.stopPropagation()
    addToUserQueue(trackId)
    added = true
    if (addTimer) clearTimeout(addTimer)
    addTimer = setTimeout(() => {
      added = false
    }, 1000)
  }

  function handlePlay(trackId: string) {
    if (onplay) {
      onplay(trackId)
    } else {
      autoQueueFilters.update((f) => ({ ...f, albumScope: undefined, artistScope: undefined }))
      playbackManager.playTrackById(trackId)
    }
  }
</script>

<div
  class="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-hover"
  role="button"
  tabindex="0"
  onclick={() => handlePlay(track.trackId)}
  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') handlePlay(track.trackId) }}
>
  <LazyThumb {track} wrapperClass="h-10 w-10 flex-shrink-0 rounded" />
  <div class="min-w-0 flex-1">
    <p class="truncate text-sm text-primary">{track.title}</p>
    <p class="truncate text-xs text-muted">
      {track.artist}
      {#if showAlbum} · {track.album}{/if}
      {#if showAlbum && track.year !== undefined && track.year !== null} · {track.year}{/if}
      {#if showDuration} · {formatDuration(track.duration)}{/if}
    </p>
  </div>

  <div class="flex flex-shrink-0 items-center gap-0.5">
    {#each starSegments(getRating(track.trackId)) as seg, si}
      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24">
        {#if seg === 'half'}
          <defs>
            <linearGradient id="tr-{track.trackId}-{si}">
              <stop offset="50%" stop-color="#facc15" />
              <stop offset="50%" stop-color="transparent" />
            </linearGradient>
          </defs>
        {/if}
        <path
          d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26Z"
          fill={seg === 'full' ? '#facc15' : seg === 'half' ? 'url(#tr-' + track.trackId + '-' + si + ')' : 'none'}
          stroke={seg === 'empty' ? '#555' : '#facc15'}
          stroke-width="1"
        />
      </svg>
    {/each}
    {#if getLoved(track.trackId)}
      <svg class="ml-0.5 h-3.5 w-3.5 text-red-400" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
      </svg>
    {:else}
      <svg class="ml-0.5 h-3.5 w-3.5 text-muted/50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
      </svg>
    {/if}
  </div>

  <button
    onclick={(e) => handleAdd(e, track.trackId)}
    class="flex-shrink-0 self-stretch rounded-none px-2.5 text-muted transition-colors hover:text-primary"
    aria-label="Add to queue"
  >
    {#if added}
      <svg class="h-5 w-5 text-green-400" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" /></svg>
    {:else}
      <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" /></svg>
    {/if}
  </button>

  {#if showAlbumArtist}
    <span class="flex-shrink-0 text-xs text-muted/60 max-w-[120px] truncate">{track.albumArtist ?? ''}</span>
  {/if}

  <TrackOptionsDropdown track={track} ondetails={ondetails} />
</div>
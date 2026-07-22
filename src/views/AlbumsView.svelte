<script lang="ts">
  import { library, metadataCache, addToUserQueue } from '../stores/appState'
  import { playbackManager } from '../lib/playbackManager'
  import type { Track } from '../stores/appState'
  import LazyThumb from '../components/LazyThumb.svelte'

  let { searchQuery = '' }: { searchQuery?: string } = $props()

  let selectedAlbum = $state<string | null>(null)

  type AlbumGroup = {
    album: string
    artist: string
    tracks: Track[]
    thumbnailTrackId: string
    rating: number
  }

  let albumGroups = $derived.by(() => {
    const groups = new Map<string, Track[]>()
    for (const track of $library) {
      const key = track.album
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(track)
    }

    const result: AlbumGroup[] = []
    for (const [album, tracks] of groups) {
      let bestTrack = tracks[0]
      let bestRating = -1
      for (const t of tracks) {
        const r = $metadataCache.get(t.trackId)?.rating ?? 0
        if (r > bestRating) { bestRating = r; bestTrack = t }
      }
      const sorted = [...tracks].sort((a, b) => (a.year ?? 0) - (b.year ?? 0) || a.title.localeCompare(b.title))
      result.push({ album, artist: bestTrack.artist, tracks: sorted, thumbnailTrackId: bestTrack.trackId, rating: bestRating })
    }
    result.sort((a, b) => a.album.localeCompare(b.album))

    const q = searchQuery.trim().toLowerCase()
    if (q) return result.filter(g => g.album.toLowerCase().includes(q) || g.artist.toLowerCase().includes(q))
    return result
  })

  let selectedTracks = $derived(
    selectedAlbum ? albumGroups.find(g => g.album === selectedAlbum)?.tracks ?? [] : []
  )

  function formatDuration(s: number): string {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${String(sec).padStart(2, '0')}`
  }

  function starSegments(rating: number): ('full' | 'half' | 'empty')[] {
    const sv = Math.min(5, rating / 20)
    const segs: ('full' | 'half' | 'empty')[] = []
    for (let i = 0; i < 5; i++) {
      const r = Math.max(0, Math.min(1, sv - i))
      if (r >= 0.75) segs.push('full')
      else if (r >= 0.25) segs.push('half')
      else segs.push('empty')
    }
    return segs
  }

  function getRating(trackId: string): number {
    return $metadataCache.get(trackId)?.rating ?? 0
  }
</script>

{#if selectedAlbum}
  <div class="flex h-full flex-col">
    <div class="flex items-center gap-2 border-b border-white/10 px-4 py-3">
      <button onclick={() => selectedAlbum = null} class="rounded-full p-1 text-muted transition-colors hover:text-primary" aria-label="Back">
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5m7-7-7 7 7 7"/></svg>
      </button>
      <h2 class="truncate text-sm font-bold text-primary">{selectedAlbum}</h2>
    </div>
    <div class="flex-1 overflow-y-auto pb-24">
      <div class="px-4 py-2">
        {#each selectedTracks as track, idx (track.trackId)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-hover"
            role="button"
            tabindex="0"
            onclick={() => { addToUserQueue(track.trackId); playbackManager.playTrackById(track.trackId) }}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { addToUserQueue(track.trackId); playbackManager.playTrackById(track.trackId) } }}
          >
            <LazyThumb {track} wrapperClass="h-10 w-10 flex-shrink-0 rounded" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-bold text-primary">{track.title}</p>
              <p class="truncate text-xs text-muted">{track.artist} · {track.year ?? '—'} · {formatDuration(track.duration)}</p>
            </div>
            <div class="flex flex-shrink-0 items-center gap-0.5">
              {#each starSegments(getRating(track.trackId)) as seg, si}
                <svg class="h-3 w-3" viewBox="0 0 24 24">
                  {#if seg === 'half'}
                    <defs><linearGradient id="al-{track.trackId}-{si}"><stop offset="50%" stop-color="#facc15" /><stop offset="50%" stop-color="transparent" /></linearGradient></defs>
                  {/if}
                  <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26Z" fill={seg === 'full' ? '#facc15' : seg === 'half' ? 'url(#al-' + track.trackId + '-' + si + ')' : 'none'} stroke={seg === 'empty' ? '#555' : '#facc15'} stroke-width="1" />
                </svg>
              {/each}
            </div>
            <button onclick={() => addToUserQueue(track.trackId)} class="flex-shrink-0 rounded-full p-1.5 text-muted transition-colors hover:text-primary" aria-label="Add to queue">
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
            </button>
          </div>
        {/each}
      </div>
    </div>
  </div>
{:else}
  <div class="flex h-full flex-col">
    <div class="border-b border-white/10 px-4 py-3">
      <h2 class="text-xs font-medium uppercase tracking-wider text-muted">Albums · {albumGroups.length}</h2>
    </div>
    <div class="flex-1 overflow-y-auto pb-24">
      <div class="grid grid-cols-2 gap-4 px-4 py-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {#each albumGroups as group (group.album)}
          <button onclick={() => selectedAlbum = group.album} class="group text-left transition-transform hover:scale-[1.02]">
            <LazyThumb track={group.tracks.find(t => t.trackId === group.thumbnailTrackId) || group.tracks[0]} wrapperClass="mb-2 aspect-square w-full rounded-lg" />
            <p class="truncate text-sm font-bold text-primary">{group.album}</p>
            <p class="truncate text-xs text-muted">{group.artist} · {group.tracks.length} tracks</p>
          </button>
        {/each}
      </div>
      {#if albumGroups.length === 0}
        <p class="px-4 py-12 text-center text-xs text-muted">No albums found</p>
      {/if}
    </div>
  </div>
{/if}

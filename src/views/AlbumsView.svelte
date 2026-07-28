<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { library, metadataCache } from '../stores/appState'
  import { saveViewState, restoreViewState } from '../lib/viewState'
  import type { Track } from '../stores/appState'
  import TrackDetailsModal from '../components/TrackDetailsModal.svelte'
  import LazyThumb from '../components/LazyThumb.svelte'
  import TrackRow from '../components/TrackRow.svelte'

  let { searchQuery = '' }: { searchQuery?: string } = $props()

  const viewName = 'albums'

  let selectedAlbum = $state<string | null>(null)
  let detailsTrack: Track | null = $state(null)

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

  let scrollContainer: HTMLDivElement | null = null
  let detailScrollContainer: HTMLDivElement | null = null

  onMount(() => {
    const saved = restoreViewState<{ scrollTop: number; selectedAlbum: string | null }>(viewName)
    if (saved) {
      selectedAlbum = saved.selectedAlbum
      const container = selectedAlbum ? detailScrollContainer : scrollContainer
      if (container) container.scrollTop = saved.scrollTop
    }
  })

  onDestroy(() => {
    const container = selectedAlbum ? detailScrollContainer : scrollContainer
    saveViewState(viewName, {
      scrollTop: container?.scrollTop ?? 0,
      selectedAlbum
    })
  })
</script>

{#if selectedAlbum}
  <div class="flex h-full flex-col">
    <div class="flex items-center gap-2 border-b border-white/10 px-4 py-3">
      <button onclick={() => selectedAlbum = null} class="rounded-full p-1 text-muted transition-colors hover:text-primary" aria-label="Back">
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5m7-7-7 7 7 7"/></svg>
      </button>
      <h2 class="truncate text-sm font-bold text-primary">{selectedAlbum}</h2>
    </div>
    <div bind:this={detailScrollContainer} class="flex-1 overflow-y-auto pb-24">
<div class="px-4 py-2">
        {#each selectedTracks as track (track.trackId)}
          <TrackRow {track} ondetails={() => detailsTrack = track} showAlbumArtist />
        {/each}
      </div>
  </div>
</div>

{#if detailsTrack}
  <TrackDetailsModal track={detailsTrack} onclose={() => detailsTrack = null} />
{/if}
{:else}
  <div class="flex h-full flex-col">
    <div class="border-b border-white/10 px-4 py-3">
      <h2 class="text-xs font-medium uppercase tracking-wider text-muted">Albums · {albumGroups.length}</h2>
    </div>
    <div bind:this={scrollContainer} class="flex-1 overflow-y-auto pb-24">
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

<script lang="ts">
  import { library, metadataCache } from '../stores/appState'
  import type { Track } from '../stores/appState'
  import TrackDetailsModal from '../components/TrackDetailsModal.svelte'
  import LazyThumb from '../components/LazyThumb.svelte'
  import TrackRow from '../components/TrackRow.svelte'

  let { searchQuery = '' }: { searchQuery?: string } = $props()

  let selectedArtist = $state<string | null>(null)
  let detailsTrack: Track | null = $state(null)

  type ArtistGroup = {
    artist: string
    tracks: Track[]
    thumbnailTrackId: string
    rating: number
  }

  let artistGroups = $derived.by(() => {
    const groups = new Map<string, Track[]>()
    for (const track of $library) {
      const key = track.artist
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(track)
    }

    const result: ArtistGroup[] = []
    for (const [artist, tracks] of groups) {
      let bestTrack = tracks[0]
      let bestRating = -1
      for (const t of tracks) {
        const r = $metadataCache.get(t.trackId)?.rating ?? 0
        if (r > bestRating) { bestRating = r; bestTrack = t }
      }
      const sorted = [...tracks].sort((a, b) => (a.year ?? 0) - (b.year ?? 0) || a.album.localeCompare(b.album) || a.title.localeCompare(b.title))
      result.push({ artist, tracks: sorted, thumbnailTrackId: bestTrack.trackId, rating: bestRating })
    }
    result.sort((a, b) => a.artist.localeCompare(b.artist))

    const q = searchQuery.trim().toLowerCase()
    if (q) return result.filter(g => g.artist.toLowerCase().includes(q))
    return result
  })

  let selectedTracks = $derived(
    selectedArtist ? artistGroups.find(g => g.artist === selectedArtist)?.tracks ?? [] : []
  )

  </script>

{#if selectedArtist}
  <div class="flex h-full flex-col">
    <div class="flex items-center gap-2 border-b border-white/10 px-4 py-3">
      <button onclick={() => selectedArtist = null} class="rounded-full p-1 text-muted transition-colors hover:text-primary" aria-label="Back">
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5m7-7-7 7 7 7"/></svg>
      </button>
      <h2 class="truncate text-sm font-bold text-primary">{selectedArtist}</h2>
    </div>
    <div class="flex-1 overflow-y-auto pb-24">
<div class="px-4 py-2">
        {#each selectedTracks as track (track.trackId)}
          <TrackRow {track} ondetails={() => detailsTrack = track} />
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
      <h2 class="text-xs font-medium uppercase tracking-wider text-muted">Artists · {artistGroups.length}</h2>
    </div>
    <div class="flex-1 overflow-y-auto pb-24">
      <div class="grid grid-cols-2 gap-4 px-4 py-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {#each artistGroups as group (group.artist)}
          <button onclick={() => selectedArtist = group.artist} class="group text-left transition-transform hover:scale-[1.02]">
            <LazyThumb track={group.tracks.find(t => t.trackId === group.thumbnailTrackId) || group.tracks[0]} wrapperClass="mb-2 aspect-square w-full rounded-lg" />
            <p class="truncate text-sm font-bold text-primary">{group.artist}</p>
            <p class="truncate text-xs text-muted">{group.tracks.length} tracks</p>
          </button>
        {/each}
      </div>
      {#if artistGroups.length === 0}
        <p class="px-4 py-12 text-center text-xs text-muted">No artists found</p>
      {/if}
    </div>
  </div>
{/if}

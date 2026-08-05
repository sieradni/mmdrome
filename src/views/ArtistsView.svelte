<script lang="ts">
  import { onMount } from 'svelte'
  import { library, metadataCache, autoQueueFilters, queue } from '../stores/appState'
  import { saveViewState, restoreViewState } from '../lib/viewState'
  import { libraryFilters, applyFilterSort, makeGroupAggregates } from '../lib/libraryFilters'
  import { playbackManager } from '../lib/playbackManager'
  import { saveQueue } from '../lib/db'
  import type { Track } from '../stores/appState'
  import TrackDetailsModal from '../components/TrackDetailsModal.svelte'
  import LazyThumb from '../components/LazyThumb.svelte'
  import TrackRow from '../components/TrackRow.svelte'
  import FilterSortBar from '../components/FilterSortBar.svelte'

  let { searchQuery = '' }: { searchQuery?: string } = $props()

  const viewName = 'artists'

  let selectedArtist = $state<string | null>(null)
  let detailsTrack: Track | null = $state(null)

  type ArtistGroup = {
    artist: string
    tracks: Track[]
    thumbnailTrackId: string
    rating: number
    avgRating: number
    lovedCount: number
    year: number | null
    length: number
  }

  function getRating(trackId: string): number {
    return $metadataCache.get(trackId)?.rating ?? 0
  }

  function getLoved(trackId: string): boolean {
    return $metadataCache.get(trackId)?.loved ?? false
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
        const r = getRating(t.trackId)
        if (r > bestRating) { bestRating = r; bestTrack = t }
      }
      const sorted = [...tracks].sort((a, b) => (a.year ?? 0) - (b.year ?? 0) || a.album.localeCompare(b.album) || a.title.localeCompare(b.title))
      result.push({ artist, tracks: sorted, thumbnailTrackId: bestTrack.trackId, rating: bestRating, ...makeGroupAggregates(sorted, getRating, getLoved) })
    }
    result.sort((a, b) => a.artist.localeCompare(b.artist))

    const q = searchQuery.trim().toLowerCase()
    if (q) return result.filter(g => g.artist.toLowerCase().includes(q))
    return result
  })

  let visibleGroups = $derived(applyFilterSort(artistGroups, $libraryFilters))

  let selectedTracks = $derived(
    selectedArtist ? artistGroups.find(g => g.artist === selectedArtist)?.tracks ?? [] : []
  )

  let scrollContainer = $state<HTMLDivElement | null>(null)
  let detailScrollContainer = $state<HTMLDivElement | null>(null)

  let ready = $state(false)

  $effect(() => {
    if (!ready) return
    saveViewState(viewName, { selectedArtist })
  })

  let scrollRestorePending = $state(false)

  $effect(() => {
    const groups = artistGroups
    if (!scrollRestorePending) return
    if (selectedArtist) {
      if (!detailScrollContainer) return
      if (detailScrollContainer.scrollHeight > detailScrollContainer.clientHeight) {
        const saved = restoreViewState<{ detailScrollTop: number }>(viewName)
        if (saved?.detailScrollTop) {
          detailScrollContainer.scrollTop = saved.detailScrollTop
        }
        scrollRestorePending = false
      }
    } else {
      if (!scrollContainer) return
      if (scrollContainer.scrollHeight > scrollContainer.clientHeight) {
        const saved = restoreViewState<{ listScrollTop: number }>(viewName)
        if (saved?.listScrollTop) {
          scrollContainer.scrollTop = saved.listScrollTop
        }
        scrollRestorePending = false
      }
    }
  })

  function handlePlayFromArtist(trackId: string) {
    autoQueueFilters.update((f) => ({ ...f, artistScope: selectedArtist ?? undefined, albumScope: undefined }))
    playbackManager.playTrackById(trackId)
  }

  function playAll() {
    const tracks = selectedTracks
    if (tracks.length === 0) return
    const trackIds = tracks.map((t) => t.trackId)
    autoQueueFilters.update((f) => ({ ...f, artistScope: selectedArtist ?? undefined, albumScope: undefined }))
    queue.update((q) => {
      const updated = { ...q, userQueue: trackIds, autoQueue: [], historyQueue: [], activeIndex: 0 }
      saveQueue(updated)
      return updated
    })
    playbackManager.playTrackAt(0)
  }

  onMount(() => {
    const saved = restoreViewState<{ listScrollTop: number; detailScrollTop: number; selectedArtist: string | null }>(viewName)
    if (saved) {
      selectedArtist = saved.selectedArtist
    }
    ready = true
    if (saved) scrollRestorePending = true
  })

</script>

{#if selectedArtist}
  <div class="flex h-full flex-col">
    <div class="flex items-center gap-3 border-b border-white/10 px-4 py-2.5">
      <button onclick={() => selectedArtist = null} class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Back">
        <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5m7-7-7 7 7 7"/></svg>
      </button>
      <h2 class="truncate text-lg font-bold text-primary">{selectedArtist}</h2>
      <button onclick={playAll} class="ml-auto flex items-center gap-1.5 rounded-full bg-surface-hover px-4 py-2 text-sm font-medium text-primary transition-opacity hover:opacity-80" aria-label="Play all">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        Play All
      </button>
    </div>
    <div bind:this={detailScrollContainer} class="flex-1 overflow-y-auto pb-24"
         onscroll={() => { if (detailScrollContainer) saveViewState(viewName, { detailScrollTop: detailScrollContainer.scrollTop }) }}>
<div class="px-4 py-2">
      {#each selectedTracks as track (track.trackId)}
        <TrackRow {track} ondetails={() => detailsTrack = track} onplay={handlePlayFromArtist} />
      {/each}
    </div>
    </div>
  </div>

{#if detailsTrack}
  <TrackDetailsModal track={detailsTrack} onclose={() => detailsTrack = null} />
{/if}
{:else}
  <div class="relative flex h-full flex-col">
    <FilterSortBar />
    <div class="border-b border-white/10 px-4 py-3">
      <h2 class="text-xs font-medium uppercase tracking-wider text-muted">Artists · {visibleGroups.length}</h2>
    </div>
    <div bind:this={scrollContainer} class="flex-1 overflow-y-auto pb-24"
         onscroll={() => { if (scrollContainer) saveViewState(viewName, { listScrollTop: scrollContainer.scrollTop }) }}>
      <div class="grid grid-cols-2 gap-4 px-4 py-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {#each visibleGroups as group (group.artist)}
          <button onclick={() => selectedArtist = group.artist} class="group text-left transition-transform hover:scale-[1.02]">
            <LazyThumb track={group.tracks.find(t => t.trackId === group.thumbnailTrackId) || group.tracks[0]} wrapperClass="mb-2 aspect-square w-full rounded-lg" />
            <p class="truncate text-sm font-bold text-primary">{group.artist}</p>
            <p class="truncate text-xs text-muted">{group.tracks.length} tracks</p>
          </button>
        {/each}
      </div>
      {#if visibleGroups.length === 0}
        <p class="px-4 py-12 text-center text-xs text-muted">No artists found</p>
      {/if}
    </div>
  </div>
{/if}
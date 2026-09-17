<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { library, metadataCache, autoQueueScope, currentTrack } from '../stores/appState'
  import { saveViewState, restoreViewState } from '../lib/viewState'
  import { libraryFilters, applyFilterSort, makeGroupAggregates } from '../lib/libraryFilters'
  import { parseSearchQuery, fieldsMatchQuery, trackMatchesQuery, highlightSegments, type HighlightSegment } from '../lib/searchCore'
  import { foldMapForSearch } from '../lib/matchNormalize'

  import { playbackManager } from '../lib/playbackManager'
  import { queueManager } from '../lib/queueManager'
  import type { Track } from '../stores/appState'
  import TrackDetailsModal from '../components/TrackDetailsModal.svelte'
  import LazyThumb from '../components/LazyThumb.svelte'
  import TrackRow from '../components/TrackRow.svelte'
  import FilterSortBar from '../components/FilterSortBar.svelte'
  import JumpToCurrentButton from '../components/JumpToCurrentButton.svelte'
  import ScrollTopButton from '../components/ScrollTopButton.svelte'

  let { searchQuery = '' }: { searchQuery?: string } = $props()

  /** The active query's tokens — empty when not searching (plain render). */
  let searchTokens = $derived(parseSearchQuery(searchQuery))

  /** Best-effort highlight segments for a group field (verify-gated — never wrong). */
  function fieldSegs(text: string): HighlightSegment[] {
    const { folded, mapStart, mapEnd } = foldMapForSearch(text)
    return highlightSegments(text, folded, searchTokens, mapStart, mapEnd)
  }

  const viewName = 'albums'

  let selectedAlbum = $state<string | null>(null)
  let detailsTrack: Track | null = $state(null)

  type AlbumGroup = {
    album: string
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
        const r = getRating(t.trackId)
        if (r > bestRating) { bestRating = r; bestTrack = t }
      }
      const sorted = [...tracks].sort((a, b) => (a.year ?? 0) - (b.year ?? 0) || a.title.localeCompare(b.title))
      result.push({ album, artist: bestTrack.artist, tracks: sorted, thumbnailTrackId: bestTrack.trackId, rating: bestRating, ...makeGroupAggregates(sorted, getRating, getLoved) })
    }
    result.sort((a, b) => a.album.localeCompare(b.album))

    const tokens = parseSearchQuery(searchQuery)
    if (tokens.length > 0) {
      // Group fields OR any contained track matches — searching a song title
      // surfaces the album holding it.
      return result.filter(
        (g) =>
          fieldsMatchQuery([g.album, g.artist], tokens) ||
          g.tracks.some((t) => trackMatchesQuery(t, tokens))
      )
    }
    return result
  })

  let visibleGroups = $derived(applyFilterSort(albumGroups, $libraryFilters, getRating))

  // Incremental render (the SongsView CHUNK pattern): the grid grows by
  // GRID_CHUNK cells as the sentinel nears the viewport bottom, so a large
  // library mounts 50 cells, not 5,000 — `.cv-cell` mitigates the paint cost
  // of what IS mounted, this bounds the mount itself. The limit persists in
  // view state alongside the scroll position so a restored session re-renders
  // the grown chunk BEFORE restoring scrollTop (a 50-cell grid cannot
  // scroll to row 400). Deliberately NO reset when FilterSortBar opens
  // (SongsView resets): collapsing the grid under a scrolled user yanks the
  // scroll position; the limit is honest "how deep they went".
  const GRID_CHUNK = 50
  let gridLimit = $state(GRID_CHUNK)
  let gridSentinelEl = $state<HTMLDivElement>()
  let renderedGroups = $derived(visibleGroups.slice(0, gridLimit))
  let gridHasMore = $derived(gridLimit < visibleGroups.length)

  let selectedTracks = $derived(
    selectedAlbum ? albumGroups.find(g => g.album === selectedAlbum)?.tracks ?? [] : []
  )

  let scrollContainer = $state<HTMLDivElement | null>(null)
  let detailScrollContainer = $state<HTMLDivElement | null>(null)

  let currentAlbum = $derived($currentTrack?.album ?? null)
  let canJumpList = $derived(currentAlbum ? visibleGroups.some((g) => g.album === currentAlbum) : false)
  let canJumpDetail = $derived(
    $currentTrack ? selectedTracks.some((t) => t.trackId === $currentTrack.trackId) : false
  )

  let jumpScrollPending = $state(false)

  function jumpToCurrent() {
    // Grow the grid first if the target album is past the rendered chunk —
    // the scroll-into-view below can only find a mounted cell.
    const idx = currentAlbum ? visibleGroups.findIndex((g) => g.album === currentAlbum) : -1
    if (idx >= gridLimit) gridLimit = idx + GRID_CHUNK
    jumpScrollPending = true
  }

  $effect(() => {
    if (!jumpScrollPending) return
    const inDetail = selectedAlbum !== null
    const container = inDetail ? detailScrollContainer : scrollContainer
    const id = inDetail ? $currentTrack?.trackId : currentAlbum
    if (!container || !id) {
      jumpScrollPending = false
      return
    }
    tick().then(() => {
      requestAnimationFrame(() => {
        const el = container.querySelector(inDetail ? `[data-track-id="${CSS.escape(id)}"]` : `[data-album="${CSS.escape(id)}"]`)
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        jumpScrollPending = false
      })
    })
  })

  let ready = $state(false)

  $effect(() => {
    if (!ready) return
    saveViewState(viewName, {
      selectedAlbum,
      ...(selectedAlbum ? {} : { listGridLimit: gridLimit }),
    })
  })

  let scrollRestorePending = $state(false)

  // Re-arm the scroll restore when the list branch remounts after a detail view
  // is closed (back button), otherwise the remounted list starts at the top.
  let wasInDetail = $state(false)
  $effect(() => {
    if (selectedAlbum) {
      wasInDetail = true
    } else if (wasInDetail) {
      wasInDetail = false
      scrollRestorePending = true
    }
  })

  $effect(() => {
    const lc = scrollContainer
    const se = gridSentinelEl
    if (!lc || !se) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && lc.offsetHeight > 0) gridLimit += GRID_CHUNK
      },
      { root: lc, rootMargin: '200px' }
    )
    observer.observe(se)
    return () => observer.disconnect()
  })

  $effect(() => {
    if (!scrollRestorePending) return
    if (selectedAlbum) {
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

  function handlePlayFromAlbum(trackId: string) {
    autoQueueScope.set({ albumScope: selectedAlbum ?? undefined, artistScope: undefined })
    playbackManager.playTrackById(trackId)
  }

  function playAll() {
    const tracks = selectedTracks
    if (tracks.length === 0) return
    const trackIds = tracks.map((t) => t.trackId)
    autoQueueScope.set({ albumScope: selectedAlbum ?? undefined, artistScope: undefined })
    queueManager.playAll(trackIds)
    playbackManager.playTrackAt(0)
  }

  onMount(() => {
    const saved = restoreViewState<{ listScrollTop: number; detailScrollTop: number; selectedAlbum: string | null; listGridLimit?: number }>(viewName)
    if (saved) {
      selectedAlbum = saved.selectedAlbum
      if (typeof saved.listGridLimit === 'number') gridLimit = Math.max(GRID_CHUNK, saved.listGridLimit)
    }
    ready = true
    if (saved) scrollRestorePending = true
  })

  // Sentinel observer as an $effect (not onMount): it re-arms whenever the
  // list branch binds — including returning from a restored detail view, where
  // an onMount observer would have bailed on a null container and never
  // re-registered (the grid would freeze at its first chunk).

</script>

{#if selectedAlbum}
  <div class="relative flex h-full flex-col">
    <div class="flex items-center gap-3 border-b border-white/10 px-4 py-2">
      <button onclick={() => selectedAlbum = null} class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Back">
        <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5m7-7-7 7 7 7"/></svg>
      </button>
      <h2 class="truncate text-lg font-bold text-primary">{selectedAlbum}</h2>
      <button onclick={playAll} class="ml-auto flex items-center gap-1.5 rounded-full bg-surface-hover px-4 py-1.5 text-sm font-medium text-primary transition-opacity hover:opacity-80" aria-label="Play all">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        Play All
      </button>
    </div>
    <div bind:this={detailScrollContainer} class="flex-1 overflow-y-auto pb-24"
         onscroll={() => { if (detailScrollContainer) saveViewState(viewName, { detailScrollTop: detailScrollContainer.scrollTop }) }}>    <div class="px-4 pt-2 pb-1">
        {#each selectedTracks as track (track.trackId)}
          <TrackRow {track} playing={track.trackId === $currentTrack?.trackId} ondetails={() => detailsTrack = track} showAlbumArtist onplay={handlePlayFromAlbum} highlightTokens={searchTokens} />
        {/each}
      </div>
    </div>
    <JumpToCurrentButton show={canJumpDetail} onclick={jumpToCurrent} />
    <ScrollTopButton target={detailScrollContainer} posClass={canJumpDetail ? 'bottom-20 right-4' : 'bottom-5 right-4'} />
  </div>

{#if detailsTrack}
  <TrackDetailsModal track={detailsTrack} onclose={() => detailsTrack = null} />
{/if}
{:else}
  <div class="relative flex h-full flex-col">
    <FilterSortBar />
    <div class="border-b border-white/10 px-4 py-3">
      <h2 class="text-xs font-medium uppercase tracking-wider text-muted">Albums · {visibleGroups.length}{#if gridHasMore}{' '}({renderedGroups.length} shown){/if}</h2>
    </div>
    <div bind:this={scrollContainer} class="flex-1 overflow-y-auto pb-24"
         onscroll={() => { if (scrollContainer) saveViewState(viewName, { listScrollTop: scrollContainer.scrollTop }) }}>
      <div class="grid grid-cols-2 gap-4 px-4 py-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {#each renderedGroups as group (group.album)}
          <button onclick={() => selectedAlbum = group.album} data-album={group.album} class="cv-cell group text-left transition-transform hover:scale-[1.02]">
            <LazyThumb track={group.tracks.find(t => t.trackId === group.thumbnailTrackId) || group.tracks[0]} size={256} wrapperClass="mb-2 aspect-square w-full rounded-lg" />
            <p class="truncate text-sm font-bold text-primary">
              {#if searchTokens.length > 0}
                {#each fieldSegs(group.album) as seg, i (i)}{#if seg.match}<mark class="rounded-sm bg-yellow-300/40 px-0 text-primary">{seg.text}</mark>{:else}{seg.text}{/if}{/each}
              {:else}
                {group.album}
              {/if}
            </p>
            <p class="truncate text-xs text-muted">
              {#if searchTokens.length > 0}
                {#each fieldSegs(group.artist) as seg, i (i)}{#if seg.match}<mark class="rounded-sm bg-yellow-300/40 px-0 text-primary">{seg.text}</mark>{:else}{seg.text}{/if}{/each}
              {:else}
                {group.artist}
              {/if}
              · {group.tracks.length} tracks
            </p>
          </button>
        {/each}
      </div>
      {#if visibleGroups.length === 0}
        <p class="px-4 py-12 text-center text-xs text-muted">No albums found</p>
      {/if}
      {#if renderedGroups.length > 0}
        <div bind:this={gridSentinelEl} class="py-6 text-center">
          {#if gridHasMore}
            <p class="text-sm text-muted">Loading more…</p>
          {:else}
            <p class="text-sm text-muted">All {visibleGroups.length} albums loaded</p>
          {/if}
        </div>
      {/if}
    </div>
    <JumpToCurrentButton show={canJumpList} onclick={jumpToCurrent} />
    <ScrollTopButton target={scrollContainer} posClass={canJumpList ? 'bottom-20 right-4' : 'bottom-5 right-4'} />
  </div>
{/if}
<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { library, metadataCache, autoQueueScope, currentTrack } from '../stores/appState'
  import { saveViewState, restoreViewState } from '../lib/viewState'
  import { ESTIMATED_ROW_H, computeWindow, endOffsetPx, scrollTopForIndex, startOffsetPx } from '../lib/virtualWindow'
  import { computeGridWindow, endGapPx, measureGridRowPx, scrollTopForCell, startGapPx, syncGridCols } from '../lib/gridWindow'
  import { createScrollWindow, firstRowMeasure } from '../lib/scrollWindow'
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

  // Virtual grid window (2026-09-28; the SongsView model applied to the grid):
  // a CELL exists iff its index is inside `gridWin` — no growth sentinel, no
  // grow-only memory. Cuts are ROW-exact (gridWindow.ts) so the model agrees
  // with the CSS grid; row spacers keep the scroll height at the full grid
  // height, so restore is a plain scrollTop write and the old
  // restore-before-sentinel ordering is structurally gone.
  let gridWin = $state({ startCell: 0, endCell: 0, startRow: 0, endRow: 0 })
  let gridRowPx = $state(260)
  let gridCols = $state(2)
  let renderedGroups = $derived(visibleGroups.slice(gridWin.startCell, gridWin.endCell))
  let gridTopGap = $derived(startGapPx(gridWin, { totalCells: visibleGroups.length, cols: gridCols, rowPx: gridRowPx, gridPadTop: 0 }))
  let gridBottomGap = $derived(endGapPx(gridWin, { totalCells: visibleGroups.length, cols: gridCols, rowPx: gridRowPx, gridPadTop: 0 }))

  // The shared scroll-window machine (see SongsView): one engine for the
  // throttled scroll + trailing derive, view-state save, consume-once
  // restore, and ResizeObserver re-derive. The measure closure syncs the
  // column count and measures rowPx from a FULLY-VISIBLE cell only (the
  // 2026-09-28 oscillator contract, now living in gridWindow.ts).
  const gridMachine = createScrollWindow<{ startCell: number; endCell: number; startRow: number; endRow: number }>({
    getTotal: () => visibleGroups.length,
    getViewport: () => scrollContainer,
    getWindow: () => gridWin,
    setWindow: (w) => {
      gridWin = w
    },
    getRowH: () => gridRowPx,
    setRowH: (h) => {
      gridRowPx = h
    },
    compute: ({ total, scrollTop, viewportH, rowH }) =>
      computeGridWindow({
        totalCells: total,
        cols: gridCols,
        scrollTop,
        viewportH,
        rowPx: rowH,
        gridPadTop: 16,
      }),
    measure: (el, currentRowPx) => {
      const grid = el.querySelector<HTMLElement>('.grid')
      if (!grid) return currentRowPx
      const cols = syncGridCols(grid)
      if (cols !== null) gridCols = cols
      return measureGridRowPx(el, grid, '[data-album]', currentRowPx)
    },
    viewKey: viewName,
    scrollTopField: 'listScrollTop',
  })

  $effect(() => {
    void visibleGroups
    void scrollContainer
    gridMachine.deriveNow()
    return gridMachine.observeResize()
  })

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
    // The grid jump IS a scrollTop write (the window derives around it); the
    // smooth-center pass below is polish. No limit-growth pre-step — the
    // target cell renders by derivation.
    if (selectedAlbum) {
      const idx = selectedTracks.findIndex((t) => t.trackId === $currentTrack?.trackId)
      if (idx >= 0 && detailScrollContainer) {
        detailScrollContainer.scrollTop = scrollTopForIndex(idx, detailScrollContainer.clientHeight, detailRowH)
        detailMachine.deriveNow()
      }
    } else {
      const idx = currentAlbum ? visibleGroups.findIndex((g) => g.album === currentAlbum) : -1
      if (idx >= 0 && scrollContainer) {
        scrollContainer.scrollTop = scrollTopForCell(idx, scrollContainer.clientHeight, { totalCells: visibleGroups.length, cols: gridCols, rowPx: gridRowPx, gridPadTop: 16 })
        gridMachine.deriveNow()
      }
    }
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

  // ── Detail view (album track list) window: same model as SongsView ──
  let detailWin = $state({ start: 0, end: 0 })
  let detailRowH = $state(ESTIMATED_ROW_H)
  let detailRows = $derived(selectedTracks.slice(detailWin.start, detailWin.end))
  let detailTopPad = $derived(startOffsetPx(detailWin.start, detailRowH))
  let detailBottomPad = $derived(endOffsetPx(selectedTracks.length, detailWin.end, detailRowH))

  // Detail list rides the SAME machine (list compute + first-row measure).
  const detailMachine = createScrollWindow<{ start: number; end: number }>({
    getTotal: () => selectedTracks.length,
    getViewport: () => detailScrollContainer,
    getWindow: () => detailWin,
    setWindow: (w) => {
      detailWin = w
    },
    getRowH: () => detailRowH,
    setRowH: (h) => {
      detailRowH = h
    },
    compute: ({ total, scrollTop, viewportH, rowH }) => computeWindow({ total, scrollTop, viewportH, rowH }),
    measure: firstRowMeasure('[data-track-id]'),
    viewKey: viewName,
    scrollTopField: 'detailScrollTop',
  })

  $effect(() => {
    void selectedTracks
    void detailScrollContainer
    detailMachine.deriveNow()
  })

  let ready = $state(false)

  $effect(() => {
    if (!ready) return
    saveViewState(viewName, { selectedAlbum })
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

  // Restore: the scroll height is ALWAYS the full list/grid (windowed
  // spacers), so both surfaces restore as a plain scrollTop write through the
  // machines' consume-once restore. The legacy `listGridLimit` field in old
  // persisted state is ignored — the window derives from the restored
  // scrollTop.
  $effect(() => {
    if (!scrollRestorePending) return
    if (selectedAlbum) {
      if (!detailScrollContainer || selectedTracks.length === 0) return
      const saved = restoreViewState<{ detailScrollTop: number }>(viewName)
      if (saved?.detailScrollTop) detailMachine.armRestore(saved.detailScrollTop)
      detailMachine.restoreIfReady()
      scrollRestorePending = false
    } else {
      if (!scrollContainer || visibleGroups.length === 0) return
      const saved = restoreViewState<{ listScrollTop: number }>(viewName)
      if (saved?.listScrollTop) gridMachine.armRestore(saved.listScrollTop)
      gridMachine.restoreIfReady()
      scrollRestorePending = false
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
    const saved = restoreViewState<{ selectedAlbum: string | null }>(viewName)
    if (saved) {
      selectedAlbum = saved.selectedAlbum
    }
    ready = true
    if (saved) scrollRestorePending = true
  })

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
    <div bind:this={detailScrollContainer} class="flex-1 overflow-y-auto overflow-anchor-none pb-24"
         onscroll={detailMachine.onScroll}>    <div class="px-4 pt-2 pb-1">
        <div style="height:{detailTopPad}px" aria-hidden="true"></div>
        {#each detailRows as track (track.trackId)}
          <TrackRow {track} windowed playing={track.trackId === $currentTrack?.trackId} ondetails={() => detailsTrack = track} showAlbumArtist onplay={handlePlayFromAlbum} highlightTokens={searchTokens} />
        {/each}
        <div style="height:{detailBottomPad}px" aria-hidden="true"></div>
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
      <h2 class="text-xs font-medium uppercase tracking-wider text-muted">Albums · {visibleGroups.length}</h2>
    </div>
    <div bind:this={scrollContainer} class="flex-1 overflow-y-auto overflow-anchor-none pb-24"
         onscroll={gridMachine.onScroll}>
      <div style="height:{gridTopGap}px" aria-hidden="true"></div>
      <div class="grid grid-cols-2 gap-4 px-4 py-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {#each renderedGroups as group (group.album)}
          <button onclick={() => selectedAlbum = group.album} data-album={group.album} class="group text-left transition-transform hover:scale-[1.02]">
            <LazyThumb track={group.tracks.find(t => t.trackId === group.thumbnailTrackId) || group.tracks[0]} size={256} windowed wrapperClass="mb-2 aspect-square w-full rounded-lg" />
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
      <div style="height:{gridBottomGap}px" aria-hidden="true"></div>
      {#if visibleGroups.length === 0}
        <p class="px-4 py-12 text-center text-xs text-muted">No albums found</p>
      {/if}
    </div>
    <JumpToCurrentButton show={canJumpList} onclick={jumpToCurrent} />
    <ScrollTopButton target={scrollContainer} posClass={canJumpList ? 'bottom-20 right-4' : 'bottom-5 right-4'} />
  </div>
{/if}
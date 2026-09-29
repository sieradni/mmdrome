<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { library, metadataCache, currentTrack } from '../stores/appState'
  import { restoreViewState } from '../lib/viewState'
  import { libraryFilters, trackMatchesGenre } from '../lib/libraryFilters'
  import { parseSearchQuery, rankTrackMatch } from '../lib/searchCore'
  import {
    ESTIMATED_ROW_H,
    computeWindow,
    endOffsetPx,
    scrollTopForIndex,
    startOffsetPx,
  } from '../lib/virtualWindow'
  import { createScrollWindow, firstRowMeasure } from '../lib/scrollWindow'
  import type { Track } from '../stores/appState'
  import TrackDetailsModal from '../components/TrackDetailsModal.svelte'
  import TrackRow from '../components/TrackRow.svelte'
  import FilterSortBar from '../components/FilterSortBar.svelte'
  import JumpToCurrentButton from '../components/JumpToCurrentButton.svelte'
  import ScrollTopButton from '../components/ScrollTopButton.svelte'

  let { searchQuery = '' }: { searchQuery?: string } = $props()

  const viewName = 'songs'

  let detailsTrack: Track | null = $state(null)

  let listContainer = $state<HTMLDivElement | null>(null)

  // ── Filter / sort / search (unchanged semantics) ────────────────────

  function getMeta(trackId: string) {
    return $metadataCache.get(trackId)
  }

  function getRating(trackId: string): number {
    return getMeta(trackId)?.rating ?? 0
  }

  function getLoved(trackId: string): boolean {
    return getMeta(trackId)?.loved ?? false
  }

  /** The active query's tokens — empty when not searching (plain render). */
  let searchTokens = $derived(parseSearchQuery(searchQuery))

  let processed = $derived.by(() => {
    const f = $libraryFilters
    let list = $library
    const tokens = searchTokens
    if (tokens.length > 0) {
      // Relevance order while searching (rank 0 = no match). Array.sort is
      // stable, so score ties keep library order; an active shared sort
      // below overrides the relevance order by re-sorting afterward.
      const scored = list
        .map((t) => ({ t, rank: rankTrackMatch(t, tokens) }))
        .filter((s) => s.rank > 0)
      scored.sort((a, b) => b.rank - a.rank)
      list = scored.map((s) => s.t)
    }
    list = list.filter((t) => {
      const r = getRating(t.trackId)
      return r >= f.minRating && r <= f.maxRating
    })
    if (f.lovedOnly) list = list.filter((t) => getLoved(t.trackId))
    if (f.genre) list = list.filter((t) => trackMatchesGenre(t, f.genre))
    const fromY = f.fromYear !== null && f.fromYear !== undefined && f.fromYear !== '' ? Number(f.fromYear) : null
    const toY = f.toYear !== null && f.toYear !== undefined && f.toYear !== '' ? Number(f.toYear) : null
    const minL = f.minLength !== null && f.minLength !== undefined && f.minLength !== '' ? Number(f.minLength) : null
    const maxL = f.maxLength !== null && f.maxLength !== undefined && f.maxLength !== '' ? Number(f.maxLength) : null

    if (fromY !== null) list = list.filter((t) => (t.year ?? 0) >= fromY)
    if (toY !== null) list = list.filter((t) => (t.year ?? 9999) <= toY)
    if (minL !== null) list = list.filter((t) => t.duration >= minL)
    if (maxL !== null) list = list.filter((t) => t.duration <= maxL)
    if (f.sortBy) {
      list = [...list].sort((a, b) => {
        let cmp = 0
        switch (f.sortBy) {
          case 'rating':
            cmp = getRating(a.trackId) - getRating(b.trackId)
            break
          case 'loved':
            cmp = Number(getLoved(a.trackId)) - Number(getLoved(b.trackId))
            break
          case 'year':
            cmp = (a.year ?? 0) - (b.year ?? 0)
            break
          case 'length':
            cmp = a.duration - b.duration
            break
        }
        return cmp * (f.sortAsc ? 1 : -1)
      })
    }
    return list
  })

  let currentIndex = $derived(
    $currentTrack ? processed.findIndex((t) => t.trackId === $currentTrack.trackId) : -1
  )
  let canJumpToCurrent = $derived(currentIndex >= 0)

  // ── Virtual window (2026-09-28) ─────────────────────────────────────
  // Replaces the grow-only CHUNK/limit + IntersectionObserver sentinel: a row
  // exists in the DOM if and only if its index is inside `win`. The window is
  // re-derived on every throttled scroll frame and on content/viewport
  // changes; the spacers keep the scroll height at the FULL list height at
  // all times, so restore is a plain scrollTop write and there is no
  // restore-before-sentinel ordering problem. The pure math lives in
  // virtualWindow.ts (unit-pinned); this view is the thin adapter.
  let win = $state<{ start: number; end: number }>({ start: 0, end: 0 })
  let rowH = $state(ESTIMATED_ROW_H)

  let visibleRows = $derived(processed.slice(win.start, win.end))
  let topPad = $derived(startOffsetPx(win.start, rowH))
  let bottomPad = $derived(endOffsetPx(processed.length, win.end, rowH))

  // The engine (throttled scroll + trailing derive, view-state save,
  // consume-once restore, ResizeObserver re-derive) lives in the shared
  // `scrollWindow.ts`; this view keeps the reactive holders, the derived
  // slice/pads, and the pure compute. The accessor arrows hand the machine
  // REAL signal access — reads/writes compile at THIS call site — so no
  // runes are imported in the machine or here.
  const machine = createScrollWindow<{ start: number; end: number }>({
    getTotal: () => processed.length,
    getViewport: () => listContainer,
    getWindow: () => win,
    setWindow: (w) => {
      win = w
    },
    getRowH: () => rowH,
    setRowH: (h) => {
      rowH = h
    },
    compute: ({ total, scrollTop, viewportH, rowH: h }) => computeWindow({ total, scrollTop, viewportH, rowH: h }),
    measure: firstRowMeasure('[data-track-id]'),
    viewKey: viewName,
    scrollTopField: 'scrollTop',
  })

  // Re-derive on content changes (library load, filter/sort/search edits —
  // the list identity changes with none of the scroll signals), consume the
  // restore once the list has content, and own the ResizeObserver lifecycle
  // (rotation, keyboard). Reads only `processed` + `listContainer`; the
  // writes (win/rowH) are not read here, so the effect cannot self-trigger.
  $effect(() => {
    void processed
    void listContainer
    machine.deriveNow()
    machine.restoreIfReady()
    return machine.observeResize()
  })

  // Restore arm: the saved scrollTop lands exactly because the scroll height
  // is ALWAYS the full list (spacers sized for every row) — set once real
  // content exists. The legacy `limit` field in old persisted state is
  // simply ignored.
  onMount(() => {
    const saved = restoreViewState<{ scrollTop: number }>(viewName)
    if (saved?.scrollTop) machine.armRestore(saved.scrollTop)
  })

  // ── Jump-to-current ──────────────────────────────────────────────────
  // Under the window model the jump IS a scrollTop write (scrollTopForIndex
  // centers the row; the scroll event derives the window around it). The
  // pending effect then smooth-centers the now-rendered row — the same
  // polish as before, minus the limit-growth pre-step (there is no limit;
  // the row renders by derivation).
  function jumpToCurrent() {
    if (currentIndex < 0) return
    const el = listContainer
    if (!el) return
    el.scrollTop = scrollTopForIndex(currentIndex, el.clientHeight, rowH)
    machine.deriveNow()
    jumpScrollPending = true
  }

  let jumpScrollPending = $state(false)

  $effect(() => {
    if (!jumpScrollPending) return
    const id = $currentTrack?.trackId
    if (!id) {
      jumpScrollPending = false
      return
    }
    tick().then(() => {
      requestAnimationFrame(() => {
        const el = listContainer?.querySelector(`[data-track-id="${CSS.escape(id)}"]`)
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        jumpScrollPending = false
      })
    })
  })
</script>

<div class="relative flex h-full flex-col">
  <FilterSortBar />
  <JumpToCurrentButton show={canJumpToCurrent} onclick={jumpToCurrent} />
  <ScrollTopButton target={listContainer} posClass={canJumpToCurrent ? 'bottom-20 right-4' : 'bottom-5 right-4'} />

  <div bind:this={listContainer} class="flex-1 overflow-y-auto overflow-anchor-none pb-24" onscroll={machine.onScroll}>
    <div class="px-4 pt-2 pb-1">
      <!-- Virtual window: two estimated spacers + the rendered slice. The
           spacer sum is always ≈ full-list height, so the scrollbar is
           honest at every position and restore is a plain scrollTop write. -->
      <div style="height:{topPad}px" aria-hidden="true"></div>
      {#each visibleRows as track (track.trackId)}
        <TrackRow {track} showAlbum={false} windowed playing={track.trackId === $currentTrack?.trackId} ondetails={() => detailsTrack = track} highlightTokens={searchTokens} />
      {/each}
      <div style="height:{bottomPad}px" aria-hidden="true"></div>

      <div class="py-6 text-center">
        {#if $library.length === 0}
          <p class="text-sm text-muted">Your library is empty. Scan your music to get started.</p>
        {:else}
          <p class="text-sm text-muted">{processed.length} tracks</p>
        {/if}
      </div>
    </div>
  </div>
</div>

{#if detailsTrack}
  <TrackDetailsModal track={detailsTrack} onclose={() => detailsTrack = null} />
{/if}

<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { library, metadataCache, addToUserQueue, playNext, currentTrack } from '../stores/appState'
  import { playbackManager } from '../lib/playbackManager'
  import { saveViewState, restoreViewState } from '../lib/viewState'
  import { libraryFilters, trackMatchesGenre } from '../lib/libraryFilters'
  import type { Track } from '../stores/appState'
  import TrackDetailsModal from '../components/TrackDetailsModal.svelte'
  import LazyThumb from '../components/LazyThumb.svelte'
  import TrackOptionsDropdown from '../components/TrackOptionsDropdown.svelte'
  import TrackRow from '../components/TrackRow.svelte'
  import FilterSortBar from '../components/FilterSortBar.svelte'
  import JumpToCurrentButton from '../components/JumpToCurrentButton.svelte'

  let { searchQuery = '' }: { searchQuery?: string } = $props()

  const viewName = 'songs'

  const CHUNK = 50
  let limit = $state(CHUNK)

  let detailsTrack: Track | null = $state(null)

  let listContainer: HTMLDivElement
  let sentinelEl: HTMLDivElement

  let ready = $state(false)

  $effect(() => {
    if (!ready) return
    saveViewState(viewName, {
      limit
    })
  })

  let scrollRestorePending = $state(false)

  $effect(() => {
    if (!scrollRestorePending || !listContainer) return
    const count = visible.length
    if (count > 0 && listContainer.scrollHeight > listContainer.clientHeight) {
      const saved = restoreViewState<{ scrollTop: number }>(viewName)
      if (saved?.scrollTop) {
        listContainer.scrollTop = saved.scrollTop
      }
      scrollRestorePending = false
    }
  })

  onMount(() => {
    const saved = restoreViewState<{
      scrollTop: number
      limit: number
    }>(viewName)
    if (saved) {
      limit = saved.limit
    }
    ready = true
    if (saved?.scrollTop) scrollRestorePending = true
  })

  onMount(() => {
    if (!listContainer || !sentinelEl) return () => {}
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && listContainer.offsetHeight > 0) limit += CHUNK
      },
      { root: listContainer, rootMargin: '200px' }
    )
    observer.observe(sentinelEl)
    return () => observer.disconnect()
  })

  $effect(() => {
    if (!listContainer || !sentinelEl) return
    if (!hasMore) return
    const sRect = sentinelEl.getBoundingClientRect()
    const cRect = listContainer.getBoundingClientRect()
    if (sRect.top <= cRect.bottom + 200) {
      limit += CHUNK
    }
  })

  function getMeta(trackId: string) {
    return $metadataCache.get(trackId)
  }

  function getRating(trackId: string): number {
    return getMeta(trackId)?.rating ?? 0
  }

  function getLoved(trackId: string): boolean {
    return getMeta(trackId)?.loved ?? false
  }

  let processed = $derived.by(() => {
    const f = $libraryFilters
    let list = $library
    const q = searchQuery.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.artist.toLowerCase().includes(q) ||
          t.album.toLowerCase().includes(q) ||
          (t.composer ?? '').toLowerCase().includes(q)
      )
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
let visible = $derived(processed.slice(0, limit))
  let hasMore = $derived(limit < processed.length)

  let currentIndex = $derived(
    $currentTrack ? processed.findIndex((t) => t.trackId === $currentTrack.trackId) : -1
  )
  let canJumpToCurrent = $derived(currentIndex >= 0)

  let jumpScrollPending = $state(false)

  function jumpToCurrent() {
    if (currentIndex < 0) return
    if (currentIndex >= limit) {
      limit = currentIndex + CHUNK
    }
    jumpScrollPending = true
  }

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
  <FilterSortBar onopen={() => { limit = CHUNK }} />
  <JumpToCurrentButton show={canJumpToCurrent} onclick={jumpToCurrent} />

  <div bind:this={listContainer} class="flex-1 overflow-y-auto pb-24"
       onscroll={() => { if (listContainer) saveViewState(viewName, { scrollTop: listContainer.scrollTop }) }}>
    <div class="px-4 py-2">
      {#each visible as track (track.trackId)}
        <TrackRow {track} showAlbum={false} ondetails={() => detailsTrack = track} />
      {/each}

      <div bind:this={sentinelEl} class="py-6 text-center">
        {#if $library.length === 0}
          <p class="text-sm text-muted">Your library is empty. Scan your music to get started.</p>
        {:else if hasMore}
          <p class="text-sm text-muted">Loading more...</p>
        {:else}
          <p class="text-sm text-muted">All {processed.length} tracks loaded</p>
        {/if}
      </div>
    </div>
  </div>
</div>

{#if detailsTrack}
  <TrackDetailsModal track={detailsTrack} onclose={() => detailsTrack = null} />
{/if}

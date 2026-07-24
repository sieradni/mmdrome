<script lang="ts">
  import { onMount } from 'svelte'
  import { library, metadataCache, addToUserQueue, playNext } from '../stores/appState'
  import { playbackManager } from '../lib/playbackManager'
  import type { Track } from '../stores/appState'
  import TrackDetailsModal from '../components/TrackDetailsModal.svelte'
  import LazyThumb from '../components/LazyThumb.svelte'
  import TrackOptionsDropdown from '../components/TrackOptionsDropdown.svelte'
  import TrackRow from '../components/TrackRow.svelte'

  let { searchQuery = '' }: { searchQuery?: string } = $props()

  let filterOpen = $state(false)
  let sortOpen = $state(false)

  let minRating = $state(0)
  let maxRating = $state(100)
  let lovedOnly = $state(false)
  let fromYear = $state<number | ''>('')
  let toYear = $state<number | ''>('')
  let minLength = $state<number | ''>('')
  let maxLength = $state<number | ''>('')

  type SortKey = 'rating' | 'loved' | 'year' | 'length'
  let sortBy = $state<SortKey | null>(null)
  let sortAsc = $state(false)

  const CHUNK = 50
  let limit = $state(CHUNK)

  let detailsTrack: Track | null = $state(null)

  let listContainer: HTMLDivElement
  let sentinelEl: HTMLDivElement

  $effect(() => {
    JSON.stringify({ minRating, maxRating, lovedOnly, fromYear, toYear, minLength, maxLength, sortBy, sortAsc, searchQuery })
    limit = CHUNK
  })

  onMount(() => {
    if (!listContainer || !sentinelEl) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) limit += CHUNK
      },
      { root: listContainer, rootMargin: '200px' }
    )
    observer.observe(sentinelEl)
    return () => observer.disconnect()
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

  function toggleFilter() {
    filterOpen = !filterOpen
    if (filterOpen) sortOpen = false
  }

  function toggleSort() {
    sortOpen = !sortOpen
    if (sortOpen) filterOpen = false
  }

  function setSort(key: SortKey) {
    if (sortBy === key) {
      sortAsc = !sortAsc
    } else {
      sortBy = key
      sortAsc = key === 'length' || key === 'year'
    }
  }

  let processed = $derived.by(() => {
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
      return r >= minRating && r <= maxRating
    })
    if (lovedOnly) list = list.filter((t) => getLoved(t.trackId))
    const fromY = fromYear !== null && fromYear !== undefined && fromYear !== '' ? Number(fromYear) : null
    const toY = toYear !== null && toYear !== undefined && toYear !== '' ? Number(toYear) : null
    const minL = minLength !== null && minLength !== undefined && minLength !== '' ? Number(minLength) : null
    const maxL = maxLength !== null && maxLength !== undefined && maxLength !== '' ? Number(maxLength) : null

    if (fromY !== null) list = list.filter((t) => (t.year ?? 0) >= fromY)
    if (toY !== null) list = list.filter((t) => (t.year ?? 9999) <= toY)
    if (minL !== null) list = list.filter((t) => t.duration >= minL)
    if (maxL !== null) list = list.filter((t) => t.duration <= maxL)
    if (sortBy) {
      list = [...list].sort((a, b) => {
        let cmp = 0
        switch (sortBy) {
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
        return cmp * (sortAsc ? 1 : -1)
      })
    }
    return list
  })

  let visible = $derived(processed.slice(0, limit))
  let hasMore = $derived(limit < processed.length)

  const sortLabels: Record<SortKey, string> = {
    rating: 'Rating',
    loved: 'Loved',
    year: 'Year',
    length: 'Length',
  }
</script>

<div class="flex h-full flex-col">
  <div class="flex items-center gap-2 border-b border-white/10 px-4 py-2">
    <button
      onclick={toggleFilter}
      class="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
      class:bg-surface-hover={filterOpen}
      class:text-primary={filterOpen}
      class:text-muted={!filterOpen}
    >Filter</button>
    <button
      onclick={toggleSort}
      class="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
      class:bg-surface-hover={sortOpen}
      class:text-primary={sortOpen}
      class:text-muted={!sortOpen}
    >Sort</button>
    {#if sortBy}
      <span class="ml-auto text-xs text-muted">Sorted by {sortLabels[sortBy]} {sortAsc ? '↑' : '↓'}</span>
    {/if}
  </div>

  {#if filterOpen}
    <div class="border-b border-white/10 bg-surface/50 px-4 py-3">
      <div class="space-y-3">
        <div>
          <span class="text-xs font-medium text-muted">Rating range</span>
          <div class="mt-1 flex items-center gap-2">
            <input
              type="range"
              min="0"
              max="100"
              bind:value={minRating}
              class="h-1 w-24 accent-yellow-500"
            />
            <input
              type="number"
              min="0"
              max="100"
              bind:value={minRating}
              class="w-14 rounded bg-surface-hover px-2 py-1 text-xs text-primary ring-1 ring-white/10"
            />
            <span class="text-xs text-muted">–</span>
            <input
              type="number"
              min="0"
              max="100"
              bind:value={maxRating}
              class="w-14 rounded bg-surface-hover px-2 py-1 text-xs text-primary ring-1 ring-white/10"
            />
            <input
              type="range"
              min="0"
              max="100"
              bind:value={maxRating}
              class="h-1 w-24 accent-yellow-500"
            />
          </div>
        </div>

        <label class="flex cursor-pointer items-center gap-2 text-xs text-muted">
          <input type="checkbox" bind:checked={lovedOnly} class="accent-yellow-500" />
          Loved tracks only
        </label>

        <div>
          <span class="text-xs font-medium text-muted">Year</span>
          <div class="mt-1 flex items-center gap-2">
            <input
              type="number"
              placeholder="From"
              bind:value={fromYear}
              class="w-24 rounded bg-surface-hover px-2 py-1 text-xs text-primary ring-1 ring-white/10 placeholder-muted"
            />
            <span class="text-xs text-muted">to</span>
            <input
              type="number"
              placeholder="To"
              bind:value={toYear}
              class="w-24 rounded bg-surface-hover px-2 py-1 text-xs text-primary ring-1 ring-white/10 placeholder-muted"
            />
          </div>
        </div>

        <div>
          <span class="text-xs font-medium text-muted">Length (seconds)</span>
          <div class="mt-1 flex items-center gap-2">
            <input
              type="number"
              placeholder="Min"
              bind:value={minLength}
              class="w-24 rounded bg-surface-hover px-2 py-1 text-xs text-primary ring-1 ring-white/10 placeholder-muted"
            />
            <span class="text-xs text-muted">to</span>
            <input
              type="number"
              placeholder="Max"
              bind:value={maxLength}
              class="w-24 rounded bg-surface-hover px-2 py-1 text-xs text-primary ring-1 ring-white/10 placeholder-muted"
            />
          </div>
        </div>
      </div>
    </div>
  {/if}

  {#if sortOpen}
    <div class="border-b border-white/10 bg-surface/50 px-4 py-3">
      <p class="mb-2 text-xs font-medium text-muted">Sort by</p>
      <div class="space-y-1">
        {#each ['rating', 'loved', 'year', 'length'] as key (key)}
          {@const k = key as SortKey}
          <button
            onclick={() => setSort(k)}
            class="flex w-full items-center justify-between rounded px-2 py-1.5 text-xs transition-colors"
            class:bg-surface-hover={sortBy === k}
            class:text-primary={sortBy === k}
            class:text-muted={sortBy !== k}
          >
            <span>{sortLabels[k]}</span>
            {#if sortBy === k}
              <span class="text-yellow-500">{sortAsc ? '↑' : '↓'}</span>
            {/if}
          </button>
        {/each}
        {#if sortBy}
          <button
            onclick={() => sortBy = null}
            class="mt-2 w-full rounded px-2 py-1 text-xs text-muted transition-colors hover:text-primary"
          >Clear sort</button>
        {/if}
      </div>
    </div>
  {/if}

  <div bind:this={listContainer} class="flex-1 overflow-y-auto pb-24">
    <div class="px-4 py-2">
      {#each visible as track (track.trackId)}
        <TrackRow {track} showAlbum={false} ondetails={() => detailsTrack = track} />
      {/each}

      <div bind:this={sentinelEl} class="py-6 text-center">
        {#if $library.length === 0}
          <p class="text-xs text-muted">Your library is empty. Scan your music to get started.</p>
        {:else if hasMore}
          <p class="text-xs text-muted">Loading more...</p>
        {:else}
          <p class="text-xs text-muted">All {processed.length} tracks loaded</p>
        {/if}
      </div>
    </div>
  </div>
</div>

{#if detailsTrack}
  <TrackDetailsModal track={detailsTrack} onclose={() => detailsTrack = null} />
{/if}

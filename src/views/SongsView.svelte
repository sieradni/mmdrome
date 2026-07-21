<script lang="ts">
  import { onMount } from 'svelte'
  import { slide } from 'svelte/transition'
  import { library, metadataCache, addToUserQueue } from '../stores/appState'
  import type { Track } from '../stores/appState'
  import TrackDetailsModal from '../components/TrackDetailsModal.svelte'

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

  let menuTrackId: string | null = $state(null)
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

  $effect(() => {
    if (menuTrackId === null) return
    function handler(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest('[data-menu]')) menuTrackId = null
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
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
          t.album.toLowerCase().includes(q)
      )
    }
    list = list.filter((t) => {
      const r = getRating(t.trackId)
      return r >= minRating && r <= maxRating
    })
    if (lovedOnly) list = list.filter((t) => getLoved(t.trackId))
    if (fromYear !== '') list = list.filter((t) => (t.year ?? 0) >= Number(fromYear))
    if (toYear !== '') list = list.filter((t) => (t.year ?? 9999) <= Number(toYear))
    if (minLength !== '') list = list.filter((t) => t.duration >= Number(minLength))
    if (maxLength !== '') list = list.filter((t) => t.duration <= Number(maxLength))
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

  let enriched = $derived(
    visible.map((t) => ({
      ...t,
      stars: starSegments(getRating(t.trackId)),
      loved: getLoved(t.trackId),
    }))
  )

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
    <div transition:slide={{ duration: 200 }} class="border-b border-white/10 bg-surface/50 px-4 py-3">
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
    <div transition:slide={{ duration: 200 }} class="border-b border-white/10 bg-surface/50 px-4 py-3">
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
      {#each enriched as track, idx (track.trackId)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-hover"
        >
          <div class="h-10 w-10 flex-shrink-0 rounded bg-surface-hover"></div>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-bold text-primary">{track.title}</p>
            <p class="truncate text-xs text-muted">{track.artist}</p>
          </div>

          <div class="flex flex-shrink-0 items-center gap-0.5">
            {#each track.stars as seg, si}
              <svg class="h-3.5 w-3.5" viewBox="0 0 24 24">
                {#if seg === 'half'}
                  <defs>
                    <linearGradient id="sg-{idx}-{si}">
                      <stop offset="50%" stop-color="#facc15" />
                      <stop offset="50%" stop-color="transparent" />
                    </linearGradient>
                  </defs>
                {/if}
                <path
                  d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26Z"
                  fill={seg === 'full' ? '#facc15' : seg === 'half' ? 'url(#sg-' + idx + '-' + si + ')' : 'none'}
                  stroke={seg === 'empty' ? '#555' : '#facc15'}
                  stroke-width="1"
                />
              </svg>
            {/each}
          </div>

          <button
            onclick={(e) => { e.stopPropagation(); addToUserQueue(track.trackId) }}
            class="flex-shrink-0 rounded-full p-1.5 text-muted transition-colors hover:text-primary"
            aria-label="Add to queue"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
            </svg>
          </button>

          <div class="relative" data-menu>
            <button
              onclick={(e) => { e.stopPropagation(); menuTrackId = menuTrackId === track.trackId ? null : track.trackId }}
              class="flex-shrink-0 rounded-full p-1.5 text-muted transition-colors hover:text-primary"
              aria-label="More options"
            >
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
              </svg>
            </button>
            {#if menuTrackId === track.trackId}
              <div class="absolute right-0 top-8 z-50 w-40 rounded-lg border border-white/10 bg-surface py-1 shadow-xl">
                <button
                  onclick={(e) => { e.stopPropagation(); addToUserQueue(track.trackId); menuTrackId = null }}
                  class="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-primary"
                >
                  <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" /></svg>
                  Add to queue
                </button>
                <button
                  onclick={(e) => { e.stopPropagation(); menuTrackId = null }}
                  class="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-primary"
                >
                  <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" /></svg>
                  Play next
                </button>
                <button
                  onclick={(e) => { e.stopPropagation(); detailsTrack = track; menuTrackId = null }}
                  class="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-primary"
                >
                  <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
                  Details
                </button>
              </div>
            {/if}
          </div>
        </div>
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

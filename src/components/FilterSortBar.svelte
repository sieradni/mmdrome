<script lang="ts">
  import { libraryFilters, sortLabels, distinctGenres } from '../lib/libraryFilters'
  import type { LibrarySortKey } from '../lib/libraryFilters'
  import { library } from '../stores/appState'

  let { onopen }: { onopen?: () => void } = $props()

  let genres = $derived(distinctGenres($library))

  function toggleFilter() {
    libraryFilters.update((f) => ({ ...f, filterOpen: !f.filterOpen, sortOpen: false }))
    onopen?.()
  }

  function toggleSort() {
    libraryFilters.update((f) => ({ ...f, sortOpen: !f.sortOpen, filterOpen: false }))
    onopen?.()
  }

  function closeFilter() {
    libraryFilters.update((f) => ({ ...f, filterOpen: false }))
  }

  function closeSort() {
    libraryFilters.update((f) => ({ ...f, sortOpen: false }))
  }

  function setSort(key: LibrarySortKey) {
    libraryFilters.update((f) => {
      if (f.sortBy === key) {
        return { ...f, sortAsc: !f.sortAsc }
      }
      return { ...f, sortBy: key, sortAsc: key === 'length' || key === 'year' }
    })
    onopen?.()
  }

  // Picking a sort option applies it AND closes — the common case is
  // pick-one-and-go, so the menu never traps the user.
  function applySort(key: LibrarySortKey) {
    setSort(key)
    closeSort()
  }

  function clearFilters() {
    libraryFilters.update((f) => ({
      ...f,
      minRating: 0,
      maxRating: 100,
      lovedOnly: false,
      genre: '',
      fromYear: '',
      toYear: '',
      minLength: '',
      maxLength: '',
    }))
  }

  // Whether any filter is non-default — drives the Filter pill's active dot so
  // a set-but-closed filter is never invisible.
  const filterActive = $derived(
    $libraryFilters.minRating > 0
      || $libraryFilters.maxRating < 100
      || $libraryFilters.lovedOnly
      || $libraryFilters.genre !== ''
      || $libraryFilters.fromYear !== ''
      || $libraryFilters.toYear !== ''
      || $libraryFilters.minLength !== ''
      || $libraryFilters.maxLength !== '',
  )

  // Mouse-free close: Escape closes whichever popup is open. Window-level so
  // it works no matter where focus sits (inputs, selects, nowhere).
  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return
    if ($libraryFilters.filterOpen || $libraryFilters.sortOpen) {
      libraryFilters.update((f) => ({ ...f, filterOpen: false, sortOpen: false }))
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if $libraryFilters.filterOpen}
  <!-- Centered modal (TrackDetailsModal idiom): Esc, backdrop, X, or Done. -->
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    onclick={closeFilter}
    role="presentation"
  >
    <div
      class="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-xl border border-white/10 bg-surface shadow-2xl"
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="Library filters"
      tabindex="-1"
    >
      <div class="flex items-center justify-between border-b border-white/10 px-5 py-3">
        <span class="text-base font-bold text-primary">Filters</span>
        <button
          onclick={() => libraryFilters.update((f) => ({ ...f, filterOpen: false }))}
          class="rounded-full p-1.5 text-muted transition-colors hover:text-primary"
          aria-label="Close filters"
        >
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
    <div class="space-y-4 px-5 py-4">
      <div>
        <span class="text-sm font-medium text-muted">Rating range</span>
        <div class="mt-1 flex items-center gap-2">
          <input
            type="range"
            min="0"
            max="100"
            value={$libraryFilters.minRating}
            oninput={(e) => libraryFilters.update((f) => ({ ...f, minRating: Number((e.target as HTMLInputElement).value) }))}
            class="h-1 w-20"
          />
          <input
            type="number"
            min="0"
            max="100"
            value={$libraryFilters.minRating}
            oninput={(e) => libraryFilters.update((f) => ({ ...f, minRating: Number((e.target as HTMLInputElement).value) }))}
            class="w-14 rounded bg-surface-hover px-2 py-1 text-sm text-primary ring-1 ring-white/10"
          />
          <span class="text-sm text-muted">–</span>
          <input
            type="number"
            min="0"
            max="100"
            value={$libraryFilters.maxRating}
            oninput={(e) => libraryFilters.update((f) => ({ ...f, maxRating: Number((e.target as HTMLInputElement).value) }))}
            class="w-14 rounded bg-surface-hover px-2 py-1 text-sm text-primary ring-1 ring-white/10"
          />
          <input
            type="range"
            min="0"
            max="100"
            value={$libraryFilters.maxRating}
            oninput={(e) => libraryFilters.update((f) => ({ ...f, maxRating: Number((e.target as HTMLInputElement).value) }))}
            class="h-1 w-20"
          />
        </div>
      </div>

      <label class="flex cursor-pointer items-center gap-2 text-sm text-muted">
        <input
          type="checkbox"
          checked={$libraryFilters.lovedOnly}
          onchange={(e) => libraryFilters.update((f) => ({ ...f, lovedOnly: (e.target as HTMLInputElement).checked }))}

        />
        Loved tracks only
      </label>

      {#if genres.length > 0}
        <div>
          <span class="text-sm font-medium text-muted">Genre</span>
          <select
            value={$libraryFilters.genre}
            onchange={(e) => libraryFilters.update((f) => ({ ...f, genre: (e.target as HTMLSelectElement).value }))}
            class="mt-1 block w-full rounded bg-surface-hover px-2 py-1 text-sm text-primary ring-1 ring-white/10 outline-none"
          >
            <option value="">All genres</option>
            {#each genres as g}
              <option value={g}>{g}</option>
            {/each}
          </select>
        </div>
      {/if}

      <div>
        <span class="text-sm font-medium text-muted">Year</span>
        <div class="mt-1 flex items-center gap-2">
          <input
            type="number"
            placeholder="From"
            value={$libraryFilters.fromYear === '' ? '' : $libraryFilters.fromYear}
            oninput={(e) => libraryFilters.update((f) => ({ ...f, fromYear: (e.target as HTMLInputElement).value === '' ? '' : Number((e.target as HTMLInputElement).value) }))}
            class="w-24 rounded bg-surface-hover px-2 py-1 text-sm text-primary ring-1 ring-white/10 placeholder-muted"
          />
          <span class="text-sm text-muted">to</span>
          <input
            type="number"
            placeholder="To"
            value={$libraryFilters.toYear === '' ? '' : $libraryFilters.toYear}
            oninput={(e) => libraryFilters.update((f) => ({ ...f, toYear: (e.target as HTMLInputElement).value === '' ? '' : Number((e.target as HTMLInputElement).value) }))}
            class="w-24 rounded bg-surface-hover px-2 py-1 text-sm text-primary ring-1 ring-white/10 placeholder-muted"
          />
        </div>
      </div>

      <div>
        <span class="text-sm font-medium text-muted">Length (seconds)</span>
        <div class="mt-1 flex items-center gap-2">
          <input
            type="number"
            placeholder="Min"
            value={$libraryFilters.minLength === '' ? '' : $libraryFilters.minLength}
            oninput={(e) => libraryFilters.update((f) => ({ ...f, minLength: (e.target as HTMLInputElement).value === '' ? '' : Number((e.target as HTMLInputElement).value) }))}
            class="w-24 rounded bg-surface-hover px-2 py-1 text-sm text-primary ring-1 ring-white/10 placeholder-muted"
          />
          <span class="text-sm text-muted">to</span>
          <input
            type="number"
            placeholder="Max"
            value={$libraryFilters.maxLength === '' ? '' : $libraryFilters.maxLength}
            oninput={(e) => libraryFilters.update((f) => ({ ...f, maxLength: (e.target as HTMLInputElement).value === '' ? '' : Number((e.target as HTMLInputElement).value) }))}
            class="w-24 rounded bg-surface-hover px-2 py-1 text-sm text-primary ring-1 ring-white/10 placeholder-muted"
          />
        </div>
      </div>

      {#if filterActive}
        <button onclick={clearFilters} class="w-full rounded px-2 py-1.5 text-sm text-muted transition-colors hover:text-primary">
          Clear all filters
        </button>
      {/if}
    </div>
    </div>
  </div>
{/if}

{#if $libraryFilters.sortOpen}
  <!-- Centered modal: a tap on an option applies and closes; Esc/backdrop too. -->
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    onclick={closeSort}
    role="presentation"
  >
    <div
      class="max-h-[80vh] w-full max-w-xs overflow-y-auto rounded-xl border border-white/10 bg-surface shadow-2xl"
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="Library sort"
      tabindex="-1"
    >
      <div class="flex items-center justify-between border-b border-white/10 px-5 py-3">
        <span class="text-base font-bold text-primary">Sort by</span>
        <button
          onclick={() => libraryFilters.update((f) => ({ ...f, sortOpen: false }))}
          class="rounded-full p-1.5 text-muted transition-colors hover:text-primary"
          aria-label="Close sort"
        >
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
    <div class="space-y-1 px-3 py-3">
      {#each ['rating', 'loved', 'year', 'length'] as key (key)}
        {@const k = key as LibrarySortKey}
        <button
          onclick={() => applySort(k)}
          class="flex w-full items-center justify-between rounded px-2 py-1.5 text-sm transition-colors"
          class:bg-surface-hover={$libraryFilters.sortBy === k}
          class:text-primary={$libraryFilters.sortBy === k}
          class:text-muted={$libraryFilters.sortBy !== k}
        >
          <span>{sortLabels[k]}</span>
          {#if $libraryFilters.sortBy === k}              <span class="text-accent">{$libraryFilters.sortAsc ? '↑' : '↓'}</span>
          {/if}
        </button>
      {/each}
      {#if $libraryFilters.sortBy}
        <button
          onclick={() => { libraryFilters.update((f) => ({ ...f, sortBy: null })); closeSort() }}
          class="mt-2 w-full rounded px-2 py-1 text-sm text-muted transition-colors hover:text-primary"
        >Clear sort</button>
      {/if}
    </div>
    </div>
  </div>
{/if}

<div class="absolute bottom-5 left-4 z-20 flex gap-2">
  <button
    onclick={toggleFilter}
    aria-expanded={$libraryFilters.filterOpen}
    class={"flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium text-primary transition-colors shadow-lg ring-1 " + ($libraryFilters.filterOpen ? 'bg-surface-raised ring-white/20' : 'bg-surface-hover ring-white/10')}
  >
    Filter
    {#if filterActive}
      <span class="h-1.5 w-1.5 rounded-full bg-white/70" aria-hidden="true"></span>
    {/if}
  </button>
  <button
    onclick={toggleSort}
    aria-expanded={$libraryFilters.sortOpen}
    class={"rounded-full px-5 py-2.5 text-sm font-medium text-primary transition-colors shadow-lg ring-1 " + ($libraryFilters.sortOpen ? 'bg-surface-raised ring-white/20' : 'bg-surface-hover ring-white/10')}
  >Sort{$libraryFilters.sortBy ? `: ${sortLabels[$libraryFilters.sortBy]} ${$libraryFilters.sortAsc ? '↑' : '↓'}` : ''}</button>
</div>
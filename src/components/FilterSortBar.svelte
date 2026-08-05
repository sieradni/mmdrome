<script lang="ts">
  import { libraryFilters, sortLabels } from '../lib/libraryFilters'
  import type { LibrarySortKey } from '../lib/libraryFilters'

  let { onopen }: { onopen?: () => void } = $props()

  function toggleFilter() {
    libraryFilters.update((f) => ({ ...f, filterOpen: !f.filterOpen, sortOpen: false }))
    onopen?.()
  }

  function toggleSort() {
    libraryFilters.update((f) => ({ ...f, sortOpen: !f.sortOpen, filterOpen: false }))
    onopen?.()
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
</script>

{#if $libraryFilters.filterOpen}
  <div class="border-b border-white/10 bg-surface/50 px-4 py-3">
    <div class="space-y-3">
      <div>
        <span class="text-sm font-medium text-muted">Rating range</span>
        <div class="mt-1 flex items-center gap-2">
          <input
            type="range"
            min="0"
            max="100"
            value={$libraryFilters.minRating}
            oninput={(e) => libraryFilters.update((f) => ({ ...f, minRating: Number((e.target as HTMLInputElement).value) }))}
            class="h-1 w-24 accent-yellow-500"
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
            class="h-1 w-24 accent-yellow-500"
          />
        </div>
      </div>

      <label class="flex cursor-pointer items-center gap-2 text-sm text-muted">
        <input
          type="checkbox"
          checked={$libraryFilters.lovedOnly}
          onchange={(e) => libraryFilters.update((f) => ({ ...f, lovedOnly: (e.target as HTMLInputElement).checked }))}
          class="accent-yellow-500"
        />
        Loved tracks only
      </label>

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
    </div>
  </div>
{/if}

{#if $libraryFilters.sortOpen}
  <div class="border-b border-white/10 bg-surface/50 px-4 py-3">
    <p class="mb-2 text-sm font-medium text-muted">Sort by</p>
    <div class="space-y-1">
      {#each ['rating', 'loved', 'year', 'length'] as key (key)}
        {@const k = key as LibrarySortKey}
        <button
          onclick={() => setSort(k)}
          class="flex w-full items-center justify-between rounded px-2 py-1.5 text-sm transition-colors"
          class:bg-surface-hover={$libraryFilters.sortBy === k}
          class:text-primary={$libraryFilters.sortBy === k}
          class:text-muted={$libraryFilters.sortBy !== k}
        >
          <span>{sortLabels[k]}</span>
          {#if $libraryFilters.sortBy === k}
            <span class="text-yellow-500">{$libraryFilters.sortAsc ? '↑' : '↓'}</span>
          {/if}
        </button>
      {/each}
      {#if $libraryFilters.sortBy}
        <button
          onclick={() => libraryFilters.update((f) => ({ ...f, sortBy: null }))}
          class="mt-2 w-full rounded px-2 py-1 text-sm text-muted transition-colors hover:text-primary"
        >Clear sort</button>
      {/if}
    </div>
  </div>
{/if}

<div class="absolute bottom-5 left-4 z-20 flex gap-2">
  <button
    onclick={toggleFilter}
    class={"rounded-full px-5 py-2.5 text-sm font-medium text-primary transition-colors shadow-lg ring-1 ring-white/10 " + ($libraryFilters.filterOpen ? 'bg-white/25' : 'bg-white/15')}
  >Filter</button>
  <button
    onclick={toggleSort}
    class={"rounded-full px-5 py-2.5 text-sm font-medium text-primary transition-colors shadow-lg ring-1 ring-white/10 " + ($libraryFilters.sortOpen ? 'bg-white/25' : 'bg-white/15')}
  >Sort{$libraryFilters.sortBy ? `: ${sortLabels[$libraryFilters.sortBy]} ${$libraryFilters.sortAsc ? '↑' : '↓'}` : ''}</button>
</div>
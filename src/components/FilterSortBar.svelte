<script lang="ts">
  import { libraryFilters, sortLabels, distinctGenres } from '../lib/libraryFilters'
  import type { LibrarySortKey } from '../lib/libraryFilters'
  import { library } from '../stores/appState'
  import { autoQueueFilterFields, autoQueueSort, shuffleEnabled } from '../stores/appState'
  import { autoQueueSettingsDiffer, planApplyLibraryToAutoQueue } from '../lib/autoQueuePlan'
  import AppSlider from './AppSlider.svelte'

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
    if (applyOpen) return // the confirm modal owns Escape while open
    if ($libraryFilters.filterOpen || $libraryFilters.sortOpen) {
      libraryFilters.update((f) => ({ ...f, filterOpen: false, sortOpen: false }))
    }
  }

  // ── Apply-to-auto-queue (2026-09-29) ─────────────────────────────────
  // The auto queue carries its OWN filter/sort settings; the library sort no
  // longer silently re-ranks it. When the two settings diverge, this afford-
  // ance offers the copy. The visibility and the plan are ONE pure predicate
  // (autoQueuePlan) so the button can never offer an empty apply, and the
  // popup can never describe a change the plan will not make.
  let applyOpen = $state(false)

  let applyPlan = $derived(
    planApplyLibraryToAutoQueue($libraryFilters, $autoQueueFilterFields, $autoQueueSort),
  )

  let showApplyButton = $derived(
    autoQueueSettingsDiffer($libraryFilters, $autoQueueFilterFields, $autoQueueSort),
  )

  function confirmApply() {
    const plan = planApplyLibraryToAutoQueue($libraryFilters, $autoQueueFilterFields, $autoQueueSort)
    if (plan.filters) {
      autoQueueFilterFields.update((f) => ({ ...f, ...plan.filters }))
    }
    if (plan.sort) {
      autoQueueSort.set(plan.sort)
    }
    applyOpen = false
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
          <AppSlider
            value={$libraryFilters.minRating}
            min={0}
            max={100}
            step={10}
            label="Minimum rating"
            onInput={(v) => libraryFilters.update((f) => ({ ...f, minRating: v }))}
            class="w-24 shrink"
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
          <AppSlider
            value={$libraryFilters.maxRating}
            min={0}
            max={100}
            step={10}
            label="Maximum rating"
            onInput={(v) => libraryFilters.update((f) => ({ ...f, maxRating: v }))}
            class="w-24 shrink"
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
    class={"flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium transition-colors ring-1 " + ($libraryFilters.filterOpen ? 'text-primary bg-[#191919] ring-white/15' : 'text-muted bg-[#0f0f0f] ring-white/10 hover:text-primary hover:ring-white/20')}
  >
    Filter
    {#if filterActive}
      <span class="h-1.5 w-1.5 rounded-full bg-white/70" aria-hidden="true"></span>
    {/if}
  </button>
  <button
    onclick={toggleSort}
    aria-expanded={$libraryFilters.sortOpen}
    class={"rounded-full px-5 py-2.5 text-sm font-medium transition-colors ring-1 " + ($libraryFilters.sortOpen ? 'text-primary bg-[#191919] ring-white/15' : 'text-muted bg-[#0f0f0f] ring-white/10 hover:text-primary hover:ring-white/20')}
  >Sort{$libraryFilters.sortBy ? `: ${sortLabels[$libraryFilters.sortBy]} ${$libraryFilters.sortAsc ? '↑' : '↓'}` : ''}</button>
  {#if showApplyButton}
    <!-- Apply-library-filter/sort-to-auto-queue: appears ONLY when the two
         settings differ (the pure diff predicate). Icon-only round button,
         same silhouette as the pills. -->
    <button
      onclick={() => (applyOpen = true)}
      class="flex h-10 w-10 items-center justify-center rounded-full text-muted bg-[#0f0f0f] ring-1 ring-white/10 transition-colors hover:text-primary hover:ring-white/20"
      aria-label="Apply the library filter and sort to the auto queue"
      title="Apply to auto queue"
    >
      <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <!-- Two stacked list rows flowing down onto one row: the shared
             filter/sort flowing into the queue -->
        <path d="M4 5h10M4 9h7" />
        <path d="M17 3v10m0 0 3-3m-3 3-3-3" />
        <path d="M4 15h16M4 19h16" />
      </svg>
      <span class="sr-only">Apply filter and sort to auto queue</span>
    </button>
  {/if}
</div>

{#if applyOpen}
  <!-- Apply confirm: centered modal (the app idiom), Esc + backdrop close;
       Escape routing above defers to THIS dialog while it is open. -->
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    onclick={() => (applyOpen = false)}
    role="presentation"
  >
    <div
      class="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-xl border border-white/10 bg-surface shadow-2xl"
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="Apply to auto queue"
      tabindex="-1"
    >
      <div class="flex items-center justify-between border-b border-white/10 px-5 py-3">
        <span class="text-base font-bold text-primary">Apply to auto queue</span>
        <button
          onclick={() => (applyOpen = false)}
          class="rounded-full p-1.5 text-muted transition-colors hover:text-primary"
          aria-label="Close"
        >
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
      <div class="space-y-4 px-5 py-4">
        <p class="text-sm text-muted">Copy the library filter and sort into the auto queue's settings? The auto queue will refill to match.</p>
        <div class="flex flex-wrap gap-2">
          {#if applyPlan.filters}
            <span class="rounded-full bg-white/10 px-2.5 py-1 text-xs font-medium text-primary">Filters</span>
          {/if}
          {#if applyPlan.sort}
            <span class="rounded-full bg-white/10 px-2.5 py-1 text-xs font-medium text-primary">Sort{applyPlan.sort.sortBy ? `: ${sortLabels[applyPlan.sort.sortBy]} ${applyPlan.sort.sortAsc ? '↑' : '↓'}` : ''}</span>
          {/if}
        </div>
        {#if $shuffleEnabled}
          <p class="text-xs text-muted/70">Shuffle is on — the sort is saved but the order applies when shuffle is off.</p>
        {/if}
        <p class="text-xs text-muted/70">Only the auto queue's settings change; your search filter and any album/artist scope stay as they are.</p>
        <div class="flex justify-end gap-2 pt-1">
          <button
            onclick={() => (applyOpen = false)}
            class="rounded-lg px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-primary"
          >Cancel</button>
          <button
            onclick={confirmApply}
            class="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90"
          >Apply</button>
        </div>
      </div>
    </div>
  </div>
{/if}
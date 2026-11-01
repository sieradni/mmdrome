<script lang="ts">
  /**
   * The ONE sort-stack editor (2026-11-01): primary + optional secondary tiers
   * over `sortCore`, with Random as a plain sort value.
   *
   * Both the library Sort dialog and the auto-queue filter dialog render THIS
   * component against their own store — the alternative (two hand-copied chip
   * rows) is exactly how the library's and the queue's editors drifted apart
   * before. All rules (pick / flip / clear, random-collapses-the-stack,
   * restore-on-random-off) live in `sortCore`; this file is markup only.
   */
  import {
    clearSort,
    describeSort,
    isRandomSort,
    reRollRandom,
    setTier,
    sortLabels,
    SORT_KEYS,
    SORT_TIER_KEYS,
    type SortState,
  } from '../lib/sortCore'

  let {
    state,
    onchange,
    allowRandom = true,
  }: {
    state: SortState
    onchange: (next: SortState) => void
    /** The auto queue shows Random (it IS shuffle); a future surface may not. */
    allowRandom?: boolean
  } = $props()

  const primary = $derived(state.tiers[0])
  const secondary = $derived(state.tiers[1])
  const random = $derived(isRandomSort(state))
  const hasRandom = $derived(state.tiers.some((t) => t.key === 'random'))

  function chipClass(active: boolean): string {
    return (
      'rounded-full px-3 py-1.5 text-xs font-medium ring-1 transition-colors ' +
      (active
        ? 'bg-white/15 text-primary ring-white/25'
        : 'bg-surface text-muted ring-white/10 hover:text-primary hover:ring-white/20')
    )
  }
</script>

<div class="space-y-3">
  <div>
    <div class="flex items-baseline justify-between gap-2">
      <span class="text-[11px] font-semibold uppercase tracking-widest text-muted/70">Primary</span>
      {#if primary}
        <button
          type="button"
          class="rounded px-1 text-[11px] text-muted transition-colors hover:text-primary"
          onclick={() => onchange(setTier(state, 0, null))}
          data-testid="primary-sort-clear"
        >Clear</button>
      {/if}
    </div>
    <div class="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="Primary sort">
      {#each SORT_KEYS as key (key)}
        {#if key !== 'random' || allowRandom}
          <button
            type="button"
            class={chipClass(primary?.key === key)}
            aria-pressed={primary?.key === key}
            data-sort-key={key}
            onclick={() => onchange(setTier(state, 0, key))}
          >
            {sortLabels[key]}
            {#if primary?.key === key && key !== 'random'}
              <span class="text-accent">{primary.asc ? '↑' : '↓'}</span>
            {/if}
          </button>
        {/if}
      {/each}
    </div>
  </div>

  {#if !random}
    <div>
      <div class="flex items-baseline justify-between gap-2">
        <span class="text-[11px] font-semibold uppercase tracking-widest text-muted/70">Secondary</span>
        {#if secondary}
          <button
            type="button"
            class="rounded px-1 text-[11px] text-muted transition-colors hover:text-primary"
            onclick={() => onchange(setTier(state, 1, null))}
            data-testid="secondary-sort-clear"
          >Clear</button>
        {/if}
      </div>
      <div class="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="Secondary sort">
        {#each SORT_TIER_KEYS as key (key)}
          {#if key !== primary?.key}
            <button
              type="button"
              class={chipClass(secondary?.key === key)}
              aria-pressed={secondary?.key === key}
              aria-label={`Secondary ${sortLabels[key]}`}
              data-sort-key={`secondary-${key}`}
              onclick={() => onchange(setTier(state, 1, key))}
            >
              {sortLabels[key]}
              {#if secondary?.key === key && key !== 'random'}
                <span class="text-accent">{secondary.asc ? '↑' : '↓'}</span>
              {/if}
            </button>
          {/if}
        {/each}
      </div>
      {#if secondary}
        <p class="mt-1.5 text-[11px] text-muted/60">
          {secondary.key === 'random' ? 'Tied songs are shuffled.' : 'Tied songs are ordered by the secondary key.'}
        </p>
      {/if}
    </div>
  {/if}

  {#if hasRandom}
    <div class="flex flex-wrap items-center gap-3">
      <button
        type="button"
        class="rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-primary ring-1 ring-white/20 transition-colors hover:bg-white/15"
        onclick={() => onchange(reRollRandom(state))}
        data-testid="reroll-random"
      >New random order</button>
      <span class="text-[11px] text-muted/60">
        {random ? 'Random has no direction and no secondary key.' : 'A new shuffle of the tied songs.'}
      </span>
    </div>
  {/if}

  <div class="flex items-center justify-between gap-2 border-t border-white/5 pt-2 text-xs">
    <span class="text-muted" data-testid="sort-summary">{describeSort(state) || 'Library order'}</span>
    {#if state.tiers.length > 0}
      <button
        type="button"
        class="rounded px-1 py-0.5 text-muted transition-colors hover:text-primary"
        onclick={() => onchange(clearSort(state))}
        data-testid="clear-sort"
      >Clear sort</button>
    {/if}
  </div>
</div>

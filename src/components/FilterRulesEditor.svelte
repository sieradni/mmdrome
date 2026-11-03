<script lang="ts">
  /**
   * The ONE filter builder body (2026-11-03), rendered inside BOTH the library
   * Filters dialog and the Queue's auto-queue filter dialog.
   *
   * Layout rule: the rating range and the Loved switch are ALWAYS visible
   * (they were the only filters before this expansion and they stay one tap
   * away); every other field — text fields (genre, artist, album, title,
   * album artist, composer) and numerical fields (year, length, date added) —
   * is reached through `+ Add filter` and renders as a typed clause. All
   * clauses are ANDed.
   *
   * The component owns no filter policy: `filterCore` describes the fields,
   * builds/edits clauses and decides what they mean; this file is markup plus
   * the add-picker's open state.
   */
  import {
    ADDABLE_FILTER_FIELDS,
    FILTER_FIELD_SPECS,
    RATING_MAX,
    RATING_MIN,
    RATING_STEP,
    addFilterClause,
    clearFilterRuleSet,
    filterRuleSetActive,
    rangeDomain,
    removeFilterClause,
    replaceFilterClause,
    type FilterClause,
    type FilterRuleSet,
    type RangeFilterField,
  } from '../lib/filterCore'
  import FilterClauseRow from './FilterClauseRow.svelte'
  import ModalShell from './ModalShell.svelte'
  import RangeFilterSlider from './RangeFilterSlider.svelte'

  let {
    rules,
    onchange,
    genres = [],
    addedBounds,
  }: {
    rules: FilterRuleSet
    /** Receives the complete next rule set (the caller spreads it over its own
     *  state, so surface-specific fields such as the auto search query stay). */
    onchange: (next: FilterRuleSet) => void
    /** Distinct library genres — suggestion chips for the Genre clause. */
    genres?: string[]
    /** Date-added bounds from the library (see `addedBoundsOf`). */
    addedBounds?: { min: number; max: number }
  } = $props()

  let addOpen = $state(false)

  const active = $derived(filterRuleSetActive(rules))
  const ratingDomain = $derived(rangeDomain('rating'))
  const available = $derived(
    ADDABLE_FILTER_FIELDS.filter((field) => !rules.clauses.some((c) => c.field === field)),
  )

  function setRating(side: 'min' | 'max', raw: string): void {
    const parsed = raw.trim() === '' ? null : Number(raw)
    if (parsed === null) {
      // Clearing snaps to the boundary (a blank max must not become 0 and
      // reject every rated track — the old queue-panel defect).
      if (side === 'min') onchange({ ...rules, minRating: RATING_MIN })
      else onchange({ ...rules, maxRating: RATING_MAX })
      return
    }
    if (!Number.isFinite(parsed)) return
    const v = Math.min(RATING_MAX, Math.max(RATING_MIN, parsed))
    if (side === 'min') {
      onchange({ ...rules, minRating: v, maxRating: Math.max(rules.maxRating, v) })
    } else {
      onchange({ ...rules, maxRating: v, minRating: Math.min(rules.minRating, v) })
    }
  }

  function domainFor(field: RangeFilterField) {
    return rangeDomain(field, { addedMin: addedBounds?.min, addedMax: addedBounds?.max })
  }

  function add(field: (typeof ADDABLE_FILTER_FIELDS)[number]): void {
    onchange(addFilterClause(rules, field))
    addOpen = false
  }

  function replace(next: FilterClause): void {
    onchange(replaceFilterClause(rules, next))
  }
</script>

<div class="space-y-3">
  <!-- Rating: always visible, dual-handle, editable by slider AND number. -->
  <div class="rounded-lg border border-white/10 bg-white/[0.03] p-3" data-filter-rating>
    <div class="flex items-baseline justify-between gap-2">
      <span class="text-sm font-medium text-primary">Rating</span>
      <span class="text-xs tabular-nums text-muted" data-testid="rating-range-label">{rules.minRating} – {rules.maxRating}</span>
    </div>
    <div class="mt-2">
      <RangeFilterSlider
        label="Rating filter"
        min={ratingDomain.min}
        max={ratingDomain.max}
        step={ratingDomain.step}
        valueMin={rules.minRating}
        valueMax={rules.maxRating}
        format={(v) => String(v)}
        onInput={(lo, hi) => onchange({ ...rules, minRating: lo, maxRating: hi })}
      />
    </div>
    <div class="mt-1 flex items-center gap-2">
      <input
        data-testid="min-rating"
        type="number"
        inputmode="numeric"
        min={RATING_MIN}
        max={RATING_MAX}
        step={RATING_STEP}
        value={rules.minRating}
        aria-label="Minimum rating"
        oninput={(e) => setRating('min', (e.target as HTMLInputElement).value)}
        class="w-full min-w-0 rounded bg-surface-hover px-2 py-1.5 text-sm tabular-nums text-primary ring-1 ring-white/10 outline-none focus:ring-accent-ring"
      />
      <span class="shrink-0 text-sm text-muted">–</span>
      <input
        data-testid="max-rating"
        type="number"
        inputmode="numeric"
        min={RATING_MIN}
        max={RATING_MAX}
        step={RATING_STEP}
        value={rules.maxRating}
        aria-label="Maximum rating"
        oninput={(e) => setRating('max', (e.target as HTMLInputElement).value)}
        class="w-full min-w-0 rounded bg-surface-hover px-2 py-1.5 text-sm tabular-nums text-primary ring-1 ring-white/10 outline-none focus:ring-accent-ring"
      />
    </div>
  </div>

  <!-- Loved: always visible. -->
  <label class="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-primary">
    <input
      type="checkbox"
      checked={rules.lovedOnly}
      onchange={(e) => onchange({ ...rules, lovedOnly: (e.target as HTMLInputElement).checked })}
      class="h-4 w-4 accent-[var(--color-accent)]"
    />
    Loved tracks only
  </label>

  {#each rules.clauses as clause (clause.id)}
    <FilterClauseRow
      {clause}
      domain={clause.kind === 'range' ? domainFor(clause.field) : undefined}
      {genres}
      onchange={replace}
      onremove={() => onchange(removeFilterClause(rules, clause.id))}
    />
  {/each}

  <button
    type="button"
    onclick={() => (addOpen = true)}
    data-testid="add-filter"
    class="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-white/20 px-3 py-2 text-sm font-medium text-muted transition-colors hover:border-white/30 hover:text-primary"
  >
    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
    Add filter
  </button>

  {#if active}
    <button
      type="button"
      onclick={() => onchange(clearFilterRuleSet())}
      class="w-full rounded px-2 py-1.5 text-sm text-muted transition-colors hover:text-primary"
    >
      Clear all filters
    </button>
  {/if}
</div>

{#if addOpen}
  <ModalShell ariaLabel="Add filter" onclose={() => (addOpen = false)}>
    <div class="flex shrink-0 items-center justify-between border-b border-white/10 px-5 py-3">
      <span class="text-base font-bold text-primary">Add filter</span>
      <button
        onclick={() => (addOpen = false)}
        class="rounded-full p-1.5 text-muted transition-colors hover:text-primary"
        aria-label="Close add filter"
      >
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    </div>
    <div class="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-4 py-3">
      {#each available as field (field)}
        <button
          type="button"
          data-add-filter={field}
          onclick={() => add(field)}
          class="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg bg-white/[0.04] px-3 py-2 text-left transition-colors hover:bg-white/10"
        >
          <span class="text-sm font-medium text-primary">{FILTER_FIELD_SPECS[field].label}</span>
          <span class="text-[11px] uppercase tracking-wider text-muted/60">{FILTER_FIELD_SPECS[field].hint}</span>
        </button>
      {:else}
        <p class="px-1 py-3 text-sm text-muted">Every filterable field is already in use.</p>
      {/each}
      <p class="px-1 pt-2 text-[11px] text-muted/60">
        Filters combine with AND. Rating and Loved stay above the list.
      </p>
    </div>
  </ModalShell>
{/if}

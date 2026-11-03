<script lang="ts">
  /**
   * One filter clause, rendered by its FIELD TYPE (2026-11-03):
   *  - `range` → a dual-handle slider over the field's full domain plus two
   *    numeric inputs (the slider and the inputs are the same value, and both
   *    are always readable);
   *  - `text` → a fuzzy input (`"quotes"` = exact), with tappable genre
   *    suggestions so a half-remembered genre name is one tap away;
   *  - `boolean` → an on/off switch.
   *
   * No policy lives here: the row emits the next CLAUSE, and the parent
   * (`FilterRulesEditor` → `filterCore.replaceFilterClause`) applies it.
   */
  import {
    FILTER_FIELD_SPECS,
    formatDate,
    formatDuration,
    formatRangeValue,
    rangeDomain,
    textValueMatches,
    type FilterClause,
    type RangeDomain,
    type RangeFilterClause,
  } from '../lib/filterCore'
  import RangeFilterSlider from './RangeFilterSlider.svelte'

  let {
    clause,
    domain,
    genres = [],
    onchange,
    onremove,
  }: {
    clause: FilterClause
    /** Pre-computed domain for a range clause (the editor owns the library
     *  bounds used by date-added). */
    domain?: RangeDomain
    genres?: string[]
    onchange: (next: FilterClause) => void
    onremove: () => void
  } = $props()

  const spec = $derived(FILTER_FIELD_SPECS[clause.field])

  const rangeView = $derived.by(() => {
    if (clause.kind !== 'range') return null
    const dom = domain ?? rangeDomain(clause.field)
    return {
      dom,
      field: clause.field,
      lo: clause.min ?? dom.min,
      hi: clause.max ?? dom.max,
      any: clause.min === null && clause.max === null,
    }
  })

  const boolView = $derived(clause.kind === 'boolean' ? clause : null)

  const suggestions = $derived.by(() => {
    if (clause.kind !== 'text' || clause.field !== 'genre') return []
    const q = clause.query.trim()
    if (!q || genres.length === 0) return []
    if (genres.some((g) => g.toLowerCase() === q.toLowerCase())) return []
    return genres.filter((g) => textValueMatches(q, g)).slice(0, 6)
  })

  /** A date-added bound is chosen on a calendar, never typed as epoch ms. */
  function setDateBound(side: 'min' | 'max', raw: string): void {
    if (raw === '') {
      setBound(side, '')
      return
    }
    const ms = Date.parse(`${raw}T00:00:00Z`)
    if (Number.isFinite(ms)) setBound(side, String(ms))
  }

  function setBound(side: 'min' | 'max', raw: string): void {
    if (clause.kind !== 'range') return
    const dom = rangeView?.dom ?? rangeDomain(clause.field)
    const parsed = raw.trim() === '' ? null : Number(raw)
    if (parsed !== null && !Number.isFinite(parsed)) return
    const v = parsed === null ? null : Math.min(dom.max, Math.max(dom.min, parsed))
    const next: RangeFilterClause = { ...clause, [side]: v }
    // Typing past the other bound WIDENS the range instead of silently
    // clamping the typed number — the user's value is what they asked for.
    if (side === 'min' && v !== null && next.max !== null && v > next.max) next.max = v
    if (side === 'max' && v !== null && next.min !== null && v < next.min) next.min = v
    onchange(next)
  }

  function onSlider(nextLo: number, nextHi: number): void {
    if (clause.kind !== 'range' || !rangeView) return
    const dom = rangeView.dom
    // A handle parked at the domain edge means "no bound" — stored as null so
    // the clause stays open even if the library (and thus the domain) moves.
    onchange({
      ...clause,
      min: nextLo <= dom.min ? null : nextLo,
      max: nextHi >= dom.max ? null : nextHi,
    })
  }

</script>

<div class="rounded-lg border border-white/10 bg-white/[0.03] p-3" data-filter-clause={clause.field}>
  <div class="flex items-center justify-between gap-2">
    <div class="flex min-w-0 items-baseline gap-2">
      <span class="text-sm font-medium text-primary">{spec.label}</span>
      <span class="text-[10px] uppercase tracking-wider text-muted/60">{spec.hint}</span>
    </div>
    <button
      type="button"
      onclick={onremove}
      aria-label={`Remove ${spec.label} filter`}
      class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-white/10 hover:text-primary"
    >
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>
  </div>

  {#if clause.kind === 'range' && rangeView}
    <div class="mt-2">
      <RangeFilterSlider
        label={`${spec.label} filter`}
        min={rangeView.dom.min}
        max={rangeView.dom.max}
        step={rangeView.dom.step}
        valueMin={rangeView.lo}
        valueMax={rangeView.hi}
        format={(v) => formatRangeValue(rangeView.field, v)}
        onInput={onSlider}
      />
      {#if clause.field === 'added'}
        <div class="mt-1 flex items-center gap-2">
          <input
            type="date"
            value={clause.min === null ? '' : formatDate(clause.min)}
            aria-label={`${spec.label} minimum`}
            oninput={(e) => setDateBound('min', (e.target as HTMLInputElement).value)}
            class="w-full min-w-0 rounded bg-surface-hover px-2 py-1.5 text-sm tabular-nums text-primary ring-1 ring-white/10 outline-none focus:ring-accent-ring"
          />
          <span class="shrink-0 text-sm text-muted">–</span>
          <input
            type="date"
            value={clause.max === null ? '' : formatDate(clause.max)}
            aria-label={`${spec.label} maximum`}
            oninput={(e) => setDateBound('max', (e.target as HTMLInputElement).value)}
            class="w-full min-w-0 rounded bg-surface-hover px-2 py-1.5 text-sm tabular-nums text-primary ring-1 ring-white/10 outline-none focus:ring-accent-ring"
          />
        </div>
      {:else}
        <div class="mt-1 flex items-center gap-2">
          <input
            type="number"
            inputmode="numeric"
            min={rangeView.dom.min}
            max={rangeView.dom.max}
            step={rangeView.dom.step}
            value={clause.min ?? ''}
            placeholder="Any"
            aria-label={`${spec.label} minimum`}
            oninput={(e) => setBound('min', (e.target as HTMLInputElement).value)}
            class="w-full min-w-0 rounded bg-surface-hover px-2 py-1.5 text-sm tabular-nums text-primary ring-1 ring-white/10 placeholder-muted outline-none focus:ring-accent-ring"
          />
          <span class="shrink-0 text-sm text-muted">–</span>
          <input
            type="number"
            inputmode="numeric"
            min={rangeView.dom.min}
            max={rangeView.dom.max}
            step={rangeView.dom.step}
            value={clause.max ?? ''}
            placeholder="Any"
            aria-label={`${spec.label} maximum`}
            oninput={(e) => setBound('max', (e.target as HTMLInputElement).value)}
            class="w-full min-w-0 rounded bg-surface-hover px-2 py-1.5 text-sm tabular-nums text-primary ring-1 ring-white/10 placeholder-muted outline-none focus:ring-accent-ring"
          />
        </div>
      {/if}
      <p class="mt-1 text-[11px] text-muted/60">
        {#if clause.field === 'length'}
          ${formatDuration(rangeView.lo)} – {formatDuration(rangeView.hi)} (total length)
        {:else if rangeView.any}
          Whole range — no bound
        {:else}
          Both sides editable; a handle at either edge means no bound on that side.
        {/if}
      </p>
    </div>
  {:else if clause.kind === 'text'}
    <input
      type="text"
      value={clause.query}
      placeholder={spec.example ? `e.g. ${spec.example}` : 'Any'}
      aria-label={`${spec.label} filter`}
      oninput={(e) => onchange({ ...clause, query: (e.target as HTMLInputElement).value })}
      class="mt-2 w-full rounded bg-surface-hover px-2 py-1.5 text-sm text-primary ring-1 ring-white/10 placeholder-muted outline-none focus:ring-accent-ring"
    />
    <p class="mt-1 text-[11px] text-muted/60">Fuzzy match — wrap text in "quotes" for an exact match.</p>
    {#if suggestions.length > 0}
      <div class="mt-1.5 flex flex-wrap gap-1.5" aria-label={`${spec.label} suggestions`}>
        {#each suggestions as suggestion (suggestion)}
          <button
            type="button"
            onclick={() => onchange({ ...clause, query: suggestion })}
            class="rounded-full bg-white/10 px-2.5 py-1 text-xs text-muted transition-colors hover:bg-white/15 hover:text-primary"
          >{suggestion}</button>
        {/each}
      </div>
    {/if}
  {:else if boolView}
    <button
      type="button"
      role="switch"
      aria-checked={boolView.value}
      aria-label={`${spec.label} filter`}
      onclick={() => onchange({ ...boolView, value: !boolView.value })}
      class="mt-2 flex w-full items-center justify-between rounded-lg bg-surface-hover px-3 py-2 text-sm text-primary ring-1 ring-white/10"
    >
      <span>{boolView.value ? 'Only loved tracks' : 'Exclude loved tracks'}</span>
      <span class={'relative h-5 w-9 rounded-full transition-colors ' + (boolView.value ? 'bg-accent' : 'bg-white/20')}>
        <span class={'absolute top-0.5 h-4 w-4 rounded-full bg-[#0d0d0d] transition-[left] ' + (boolView.value ? 'left-4' : 'left-0.5')}></span>
      </span>
    </button>
  {/if}
</div>

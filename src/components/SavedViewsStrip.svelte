<script lang="ts">
  import { libraryFilters } from '../lib/libraryFilters'
  import { filterPresets } from '../stores/appState'
  import { applyPresetById, presetIsActive } from '../lib/filterPresets'

  /**
   * Saved library views as chips — ONE tap applies a stored view without opening
   * the filter dialog. Horizontally scrollable so a long list never widens the
   * bar; the active view is highlighted.
   *
   * Applying writes `libraryFilters` ONLY (see `filterPresets`): a stored view
   * can never re-rank or refill the auto queue.
   */
  function applySavedView(id: string) {
    const next = applyPresetById($libraryFilters, $filterPresets, id)
    if (next) libraryFilters.set(next)
  }
</script>

{#if $filterPresets.length > 0}
  <div
    class="absolute bottom-[4.5rem] left-4 right-4 z-20 flex gap-2 overflow-x-auto pb-0.5"
    role="group"
    aria-label="Saved views"
  >
    {#each $filterPresets as preset (preset.id)}
      {@const active = presetIsActive(preset, $libraryFilters)}
      <button
        onclick={() => applySavedView(preset.id)}
        aria-pressed={active}
        data-preset-id={preset.id}
        class="shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ring-1 {active ? 'bg-accent-soft text-accent ring-accent-ring/40' : 'bg-[#0f0f0f] text-muted ring-white/10 hover:text-primary hover:ring-white/20'}"
      >{preset.name}</button>
    {/each}
  </div>
{/if}

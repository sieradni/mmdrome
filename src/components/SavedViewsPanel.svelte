<script lang="ts">
  import { libraryFilters } from '../lib/libraryFilters'
  import { filterPresets } from '../stores/appState'
  import {
    PRESET_MAX_COUNT,
    PRESET_NAME_MAX,
    applyPresetById,
    planSavePreset,
    presetIsActive,
    removePreset,
  } from '../lib/filterPresets'

  /**
   * The saved-views MANAGER: name + save, list (apply / remove).
   *
   * It renders inside the Filters dialog (`ModalShell`) and owns only its own
   * input state — the presets themselves live in the persisted `filterPresets`
   * store, and every naming/cap/decode rule is in the pure `filterPresets`
   * core, so this component can hold no policy.
   *
   * Saving under an existing name updates that view in place, which is why the
   * list doubles as the manage surface.
   */
  let saveName = $state('')
  let saveError = $state('')

  function newPresetId(): string {
    return `fp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  }

  function saveCurrentView() {
    const result = planSavePreset($filterPresets, saveName, $libraryFilters, newPresetId())
    if (!result.ok) {
      saveError = result.reason === 'limit'
        ? `You can keep ${PRESET_MAX_COUNT} saved views — remove one first.`
        : 'Give the view a name first.'
      return
    }
    filterPresets.set(result.presets)
    saveName = ''
    saveError = ''
  }

  function applySavedView(id: string) {
    const next = applyPresetById($libraryFilters, $filterPresets, id)
    if (next) libraryFilters.set(next)
  }
</script>

<div class="border-t border-white/10 pt-3">
  <span class="text-sm font-medium text-muted">Saved views</span>
  <div class="mt-1 flex items-center gap-2">
    <input
      type="text"
      bind:value={saveName}
      maxlength={PRESET_NAME_MAX}
      placeholder="Name this view"
      aria-label="Saved view name"
      onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveCurrentView() } }}
      class="min-w-0 flex-1 rounded bg-surface-hover px-2 py-1 text-sm text-primary ring-1 ring-white/10 placeholder-muted"
    />
    <button
      onclick={saveCurrentView}
      class="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-black transition-opacity hover:opacity-90"
    >Save</button>
  </div>
  {#if saveError}
    <p class="mt-1 text-xs text-red-400" role="status">{saveError}</p>
  {/if}
  {#if $filterPresets.length > 0}
    <ul class="mt-2 space-y-1" aria-label="Saved views">
      {#each $filterPresets as preset (preset.id)}
        {@const active = presetIsActive(preset, $libraryFilters)}
        <li class="flex items-center gap-2 rounded px-1 py-0.5">
          <button
            onclick={() => applySavedView(preset.id)}
            aria-pressed={active}
            class="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-sm transition-colors {active ? 'text-accent' : 'text-muted hover:text-primary'}"
          >{preset.name}</button>
          <button
            onclick={() => filterPresets.set(removePreset($filterPresets, preset.id))}
            aria-label={`Remove saved view ${preset.name}`}
            class="shrink-0 rounded-full p-1 text-muted/70 transition-colors hover:text-red-400"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

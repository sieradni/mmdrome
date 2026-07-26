<script lang="ts">
  import { audioManager } from '../lib/audioManager'
  import EqGraph from '../components/EqGraph.svelte'
  import {
    activePresetId,
    userPresets,
    currentEqState,
    eqBypassed,
    saveUserPreset,
    deleteUserPreset,
    applyPreset,
    persistEqBypass,
    persistEqState,
  } from '../lib/eq/eqStore'
  import { parseEqText } from '../lib/eq/eqParser'
  import { DEFAULT_GRAPHIC_FREQUENCIES, BUILTIN_PRESETS, mergeFiltersIntoDefaultGrid } from '../lib/eq/builtInPresets'
  import type { EqPreset, EqFilterConfig } from '../lib/eq/eqTypes'

  let { onback, oncloseall }: { onback: () => void; oncloseall: () => void } = $props()

  let preampDb = $state($currentEqState.preampDb)
  let showImport = $state(false)
  let importText = $state('')
  let importErrors = $state('')
  let saveDialogOpen = $state(false)
  let newPresetName = $state('')
  let eqState = $state<EqPreset>(structuredClone($currentEqState))

  const presets = $derived([...BUILTIN_PRESETS, ...$userPresets])

  const FREQ_LABELS = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k']
  const FREQ_VALUES = DEFAULT_GRAPHIC_FREQUENCIES

  // Only use first 10 bands for sliders (any extras are appended beyond index 9)
  let gains = $state($currentEqState.filters.slice(0, 10).map((f) => -f.gain))

  function setGain(index: number) {
    audioManager.setEqBandGain(index, -gains[index])
    eqState.filters[index].gain = -gains[index]
  }

  function toggleBypass() {
    const newVal = !$eqBypassed
    audioManager.setEqBypass(newVal)
    persistEqBypass(newVal)
  }

  function onPreampChange() {
    audioManager.setPreampDb(preampDb)
    eqState.preampDb = preampDb
  }

  function resetAll() {
    const flatGains = FREQ_VALUES.map(() => 0)
    gains = flatGains
    preampDb = 0
    eqState = { ...eqState, preampDb: 0, filters: eqState.filters.map((f) => ({ ...f, gain: 0 })) }
    audioManager.setPreampDb(0)
    // Reset standard bands
    for (let i = 0; i < FREQ_VALUES.length; i++) {
      audioManager.setEqBandGain(i, 0)
    }
    // Reset extras via full config apply
    audioManager.applyFiltersConfig(eqState.filters)
  }

  async function selectPreset(id: string) {
    const preset = await applyPreset(id)
    if (!preset) return
    eqState = structuredClone(preset)
    preampDb = preset.preampDb
    gains = preset.filters.slice(0, 10).map((f) => -f.gain)
    audioManager.setPreampDb(preset.preampDb)
    audioManager.applyFiltersConfig(preset.filters)
  }

  async function saveCurrentPreset() {
    const name = newPresetName.trim() || `User Preset ${Date.now()}`
    const now = Date.now()
    const preset: EqPreset = {
      id: `user_${now}`,
      name,
      mode: eqState.mode,
      preampDb,
      filters: eqState.filters.map((f) => ({ ...f })),
    }
    await saveUserPreset(preset)
    saveDialogOpen = false
    newPresetName = ''
    await selectPreset(preset.id)
  }

  async function removePreset(id: string) {
    await deleteUserPreset(id)
  }

  function handleImport() {
    const result = parseEqText(importText)
    if (result.errors.length > 0) {
      importErrors = result.errors.join('\n')
      return
    }
    importErrors = ''

    // Merge imported filters onto the 10-band default grid
    const { baseFilters, extraFilters } = mergeFiltersIntoDefaultGrid(result.filters)
    const mergedFilters = [...baseFilters, ...extraFilters]

    preampDb = result.preampDb
    gains = baseFilters.map((f) => -f.gain)
    eqState = {
      id: 'imported',
      name: 'Imported',
      mode: result.mode,
      preampDb,
      filters: mergedFilters,
    }

    audioManager.setPreampDb(preampDb)
    audioManager.applyFiltersConfig(mergedFilters)

    // Persist to store so it survives navigation and track changes
    currentEqState.set(eqState)
    activePresetId.set('custom')
    persistEqState(eqState, 'custom')

    showImport = false
    importText = ''
  }

</script>

<div class="flex h-full flex-col bg-background">
  <div class="flex items-center justify-between px-4 py-3">
    <span class="text-sm font-medium text-primary">Equalizer</span>
    <div class="flex items-center gap-2">
      <button
        onclick={toggleBypass}
        class={"rounded px-2.5 py-1 text-xs font-medium transition-colors " + ($eqBypassed ? 'bg-yellow-500/10 text-yellow-400' : 'bg-surface-hover text-primary')}
      >
        {$eqBypassed ? 'Bypassed' : 'Active'}
      </button>
      <button onclick={oncloseall} class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Library">
        <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" /></svg>
      </button>
      <button onclick={onback} class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Close">
        <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6l-12 12" /></svg>
      </button>
    </div>
  </div>

  <div class="flex-1 overflow-y-auto px-4 pb-6 space-y-4">

    <!-- PRESET SELECTOR -->
    <div class="flex items-center gap-2">
      <div class="relative flex-1">
        <select
          class="w-full appearance-none rounded-lg bg-surface px-3 py-2 text-xs text-primary outline-none ring-1 ring-white/10 focus:ring-primary/40"
          value={$activePresetId}
          onchange={(e) => selectPreset((e.target as HTMLSelectElement).value)}
        >
          {#each presets as p}
            <option value={p.id}>{p.name}</option>
          {/each}
        </select>
        <svg class="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
      </div>
      <button onclick={() => { saveDialogOpen = true; newPresetName = '' }} class="rounded-lg bg-white/10 px-2.5 py-2 text-xs text-primary transition-colors hover:bg-white/20 ring-1 ring-white/10" title="Save preset">Save</button>
      <button onclick={() => { showImport = !showImport; importText = ''; importErrors = '' }} class="rounded-lg bg-surface px-2.5 py-2 text-xs text-muted transition-colors hover:text-primary ring-1 ring-white/10" title="Import AutoEQ/Parametric EQ text">
        {showImport ? 'Close' : 'Import'}
      </button>
      {#if !presets.find(p => p.id === $activePresetId)?.isBuiltin}
        <button onclick={() => removePreset($activePresetId)} class="rounded-lg bg-surface px-2.5 py-2 text-xs text-red-400 transition-colors hover:bg-red-500/10 ring-1 ring-white/10" title="Delete preset">Delete</button>
      {/if}
    </div>

    <!-- SAVE DIALOG -->
    {#if saveDialogOpen}
      <div class="flex items-center gap-2 rounded-lg bg-surface px-3 py-2 ring-1 ring-white/10">
        <input
          type="text"
          placeholder="Preset name..."
          bind:value={newPresetName}
          class="flex-1 bg-transparent text-xs text-primary outline-none placeholder:text-muted/50"
          onkeydown={(e) => { if (e.key === 'Enter') saveCurrentPreset() }}
        />
        <button onclick={saveCurrentPreset} class="rounded bg-white/15 px-2.5 py-1 text-xs font-medium text-primary hover:bg-white/25">Save</button>
        <button onclick={() => saveDialogOpen = false} class="rounded px-2 py-1 text-xs text-muted">Cancel</button>
      </div>
    {/if}

    <!-- AUTO EQ IMPORT TEXTBOX -->
    {#if showImport}
      <div class="rounded-lg bg-surface ring-1 ring-white/10">
        <textarea
          class="h-32 w-full resize-none bg-transparent p-3 text-xs font-mono text-primary outline-none placeholder:text-muted/30"
          placeholder="Paste AutoEQ / EqualizerAPO / Peace EQ config text here..."
          bind:value={importText}
        ></textarea>
        {#if importErrors}
          <div class="px-3 pb-2 text-[10px] text-red-400/80 whitespace-pre-wrap">{importErrors}</div>
        {/if}
        <div class="flex justify-end gap-2 px-3 pb-3">
          <button onclick={() => { showImport = false; importText = ''; importErrors = '' }} class="rounded px-2.5 py-1 text-xs text-muted hover:text-primary">Cancel</button>
          <button onclick={handleImport} class="rounded bg-white/15 px-3 py-1 text-xs font-medium text-primary hover:bg-white/25">Apply</button>
        </div>
      </div>
    {/if}

    <!-- PREAMP SLIDER -->
    <div class="flex items-center gap-3">
      <span class="w-14 text-[10px] text-muted/60">Preamp</span>
      <input
        type="range"
        min="-12"
        max="12"
        step="0.5"
        bind:value={preampDb}
        oninput={onPreampChange}
        class="h-1 w-full accent-primary/80"
        disabled={$eqBypassed}
      />
      <span class="w-14 text-right text-[10px] tabular-nums text-muted/60">{preampDb > 0 ? '+' : ''}{preampDb.toFixed(1)} dB</span>
    </div>

    <!-- FREQUENCY RESPONSE GRAPH -->
    <EqGraph preampDb={$eqBypassed ? 0 : preampDb} filters={eqState.filters} eqBypassed={$eqBypassed} />

    <!-- 10-BAND GRAPHIC EQ SLIDERS -->
    <div class="flex items-end justify-between gap-1" style="height: 220px;">
      {#each FREQ_LABELS as label, i}
        <div class="flex flex-1 flex-col items-center gap-1 h-full justify-end">
          <span class="text-[10px] tabular-nums text-muted/60">{-gains[i] > 0 ? '+' : ''}{(-gains[i]).toFixed(1)}</span>
          <input
            type="range"
            min="-12"
            max="12"
            step="0.5"
            bind:value={gains[i]}
            oninput={() => setGain(i)}
            class="h-32 w-1 accent-white/80 [writing-mode:vertical-lr]"
            disabled={$eqBypassed}
          />
          <span class="text-[10px] text-muted/50">{label}</span>
        </div>
      {/each}
    </div>

    <!-- RESET -->
    <div class="flex justify-center">
      <button onclick={resetAll} class="rounded px-3 py-1.5 text-xs text-muted transition-colors hover:text-primary ring-1 ring-white/10">Reset All</button>
    </div>
  </div>
</div>

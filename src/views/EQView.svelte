<script lang="ts">
  import { engine } from '../lib/engineFacade'
  import EqGraph from '../components/EqGraph.svelte'
  import EqSlider from '../components/EqSlider.svelte'
  import AppSlider from '../components/AppSlider.svelte'
  import { get } from 'svelte/store'
  import {
    activePresetId,
    userPresets,
    eqBypassed,
    workingEq,
    editWorkingEq,
    resetWorkingEq,
    deleteUserPreset,
    applyPreset,
    saveEqSession,
    findPresetById,
  } from '../lib/eq/eqStore'
  import { parseEqText } from '../lib/eq/eqParser'
  import { BUILTIN_PRESETS, mergeFiltersIntoDefaultGrid } from '../lib/eq/builtInPresets'
  import {
    insertBandAt,
    removeBandAt,
    withExplicitCurve,
    flipAllCurveTypes,
    hasGraphicBands,
    suggestInsertFrequency,
  } from '../lib/eq/eqCurveTopology'
  import type { EqPreset } from '../lib/eq/eqTypes'

  let { onback, oncloseall }: { onback: () => void; oncloseall: () => void } = $props()

  let showImport = $state(false)
  let importText = $state('')
  let importErrors = $state('')
  let saveDialogOpen = $state(false)
  let newPresetName = $state('')
  let selectEl: HTMLSelectElement | null = $state(null)

  const presets = $derived([...BUILTIN_PRESETS, ...$userPresets])

  // The working session is THE source of truth: edits persist automatically
  // (debounced Dexie write in the store layer), so leaving the view loses
  // nothing and no unmount hooks exist.
  const eqState = $derived($workingEq.state)
  const preampDb = $derived($workingEq.state.preampDb)
  const isGraphicImport = $derived(
    eqState.mode === 'graphic' && !!eqState.graphicEqCurves && eqState.graphicEqCurves.length > 0
  )

  /** Push a full preset-shaped state to the engine (the audible truth).
   *  Graphic IMPORTS keep their raw curve stack (unchanged behavior);
   *  everything else — parametric, hybrid, saved presets — goes through
   *  applyFiltersConfig, which routes hybrid (any graphic band) to the
   *  convolver internally. */
  function applyEqToEngine(state: EqPreset) {
    engine.setPreampDb(state.preampDb)
    if (state.mode === 'graphic' && !state.isBuiltin && state.graphicEqCurves && state.graphicEqCurves.length > 0) {
      engine.applyGraphicEQ(state.filters, state.graphicEqCurves)
    } else {
      engine.applyFiltersConfig(state.filters)
    }
  }

  // ── Edit paths: engine push stays INSTANT; the store debounces persist ──

  function setGain(index: number, value: number) {
    engine.setEqBandGain(index, value)
    editWorkingEq((st) => {
      const f = st.filters[index]
      if (f) f.gain = value
      return st
    })
  }

  function onPreampChange(value: number) {
    engine.setPreampDb(value)
    editWorkingEq((st) => {
      st.preampDb = value
      return st
    })
  }

  function toggleBypass() {
    const newVal = !$eqBypassed
    engine.setEqBypass(newVal)
    // The `persisted` store layer owns the Dexie write.
    eqBypassed.set(newVal)
  }

  // ── Flexible band editing (graph + list share the working state) ────────

  function moveFilter(index: number, frequency: number, gain: number) {
    // Live drag: per-band params without a chain rebuild (see
    // audioManager.setEqBandParams — no disconnect/reconnect churn). Gain
    // is clamped to the engine's ±12 range HERE too — the state must never
    // drift from what the engine applies (the graph's dB scale can exceed
    // ±12 when big boosts widen it).
    const clampedGain = Math.max(-12, Math.min(12, gain))
    engine.setEqBandParams(index, frequency, clampedGain)
    editWorkingEq((st) => {
      const f = st.filters[index]
      if (f) {
        f.frequency = Math.round(frequency)
        f.gain = clampedGain
      }
      return st
    })
  }

  function setBandQ(index: number, q: number) {
    const f = eqState.filters[index]
    if (!f) return
    // Q only shapes the biquad — graphic points are curve samples. Live
    // path (no chain rebuild), same as the drag.
    engine.setEqBandParams(index, f.frequency, f.gain, q)
    editWorkingEq((st) => {
      const band = st.filters[index]
      if (band) band.q = q
      return st
    })
  }

  function addBand(frequency: number): number {
    let newIndex = -1
    editWorkingEq((st) => {
      const next = insertBandAt(st.filters, frequency, { gain: 0 })
      // insertBandAt SORTS by frequency — the new band's row index must be
      // found in the RESULT (identity of the inserted object), not assumed.
      const before = new Set(st.filters)
      newIndex = next.findIndex((f) => !before.has(f))
      st.filters = next
      return st
    })
    // A structural change needs the full push (band count changed).
    applyEqToEngine(get(workingEq).state)
    return newIndex
  }

  function removeBand(index: number) {
    editWorkingEq((st) => {
      st.filters = removeBandAt(st.filters, index)
      return st
    })
    applyEqToEngine(get(workingEq).state)
  }

  function toggleBandCurve(index: number) {
    const f = eqState.filters[index]
    if (!f) return
    const next = f.curve === 'graphic' ? 'parametric' : 'graphic'
    editWorkingEq((st) => {
      st.filters = withExplicitCurve(st.filters, index, next)
      return st
    })
    // Curve type flips the engine path (biquad ↔ convolver point).
    applyEqToEngine(get(workingEq).state)
  }

  function flipAllCurves() {
    editWorkingEq((st) => {
      st.filters = flipAllCurveTypes(st.filters)
      return st
    })
    applyEqToEngine(get(workingEq).state)
  }

  const canFlipCurves = $derived(!isGraphicImport && eqState.filters.length > 0)
  const anyGraphic = $derived(hasGraphicBands(eqState.filters))

  // ── Unified save (2026-09-14 UX pass): ONE Save button. User-preset base →
  //    overwrite; builtin/imported base → name-and-create. The dialog only
  //    appears when a name is actually needed (the old dual Save-as-Current /
  //    Save-New pair asked the user to know the difference up front). The
  //    SESSION BASE decides (not activePresetId — an import keeps the old
  //    preset selected while base.id is 'imported'; same rule as the store). ──
  const basePreset = $derived(presets.find((p) => p.id === $workingEq.base.id))
  const baseIsUserPreset = $derived(!!basePreset && !basePreset.isBuiltin && $workingEq.base.id !== 'imported')
  const saveNeedsName = $derived(!baseIsUserPreset)
  const saveDisabled = $derived(baseIsUserPreset && !$workingEq.dirty)

  function onSaveTap() {
    if (saveDisabled) return
    if (saveNeedsName) {
      newPresetName = ''
      saveDialogOpen = true
    } else {
      void saveEqSession()
    }
  }

  // ── Per-band popover (frequency edit + Q + curve kind + remove) — the
  //    band row itself is just value / slider / frequency, so 12+ bands stay
  //    readable on a phone. ──
  let bandPopover = $state<number | null>(null)
  let bandFreqDraft = $state('')

  function openBandEditor(i: number) {
    const f = eqState.filters[i]
    if (!f || isGraphicImport) return
    bandPopover = i
    bandFreqDraft = String(f.frequency)
  }

  function applyBandFreq() {
    const i = bandPopover
    if (i === null) return
    const f = eqState.filters[i]
    if (!f) return
    const parsed = Number(bandFreqDraft)
    if (!Number.isFinite(parsed)) return
    const freq = Math.min(20000, Math.max(20, Math.round(parsed)))
    moveFilter(i, freq, f.gain)
    bandFreqDraft = String(freq)
  }

  // ── Add-band frequency prompt (2026-09-14: the user picks the frequency
  //    instead of accepting a magic widest-gap default — graph taps already
  //    place by position, the button now matches that mental model). ──
  let addBandPrompt = $state(false)
  let addBandFreq = $state(1000)

  function onAddBandTap() {
    addBandFreq = Math.round(suggestInsertFrequency(eqState.filters))
    addBandPrompt = true
  }

  function confirmAddBand() {
    const freq = Math.min(20000, Math.max(20, Math.round(addBandFreq)))
    if (!Number.isFinite(freq)) return
    const idx = addBand(freq)
    addBandPrompt = false
    if (idx >= 0) openBandEditor(idx)
  }

  // ── Preset flows (dirty-guarded) ────────────────────────────────────────

  type DirtyChoice = 'save' | 'discard' | 'cancel'
  let dirtyDialog = $state<{ open: boolean; resolve?: (c: DirtyChoice) => void }>({ open: false })

  function askDirtyChoice(): Promise<DirtyChoice> {
    return new Promise((resolve) => {
      dirtyDialog = { open: true, resolve }
    })
  }

  function settleDirty(choice: DirtyChoice) {
    dirtyDialog.resolve?.(choice)
    dirtyDialog = { open: false }
  }

  async function selectPreset(id: string) {
    // Dirty overlay over a DIFFERENT preset: ask before discarding (user
    // decision 2026-09-13 — Save / Discard / Cancel).
    if ($workingEq.dirty && id !== $workingEq.base.id) {
      const choice = await askDirtyChoice()
      if (choice === 'cancel') {
        // Revert the select's visual value to the actual active preset.
        if (selectEl) selectEl.value = $activePresetId
        return
      }
      if (choice === 'save') {
        // Unified save: user-preset base → overwrite; builtin/import → new
        // "(modified)" preset (no name prompt mid-switch — the default name
        // is the old Save-as-Current behavior).
        await saveEqSession()
      }
      // 'discard' falls through — applyPreset resets the session clean.
    }
    const preset = await applyPreset(id)
    if (!preset) return
    applyEqToEngine(preset)
  }

  function handlePresetChange(e: Event) {
    void selectPreset((e.target as HTMLSelectElement).value)
  }

  function resetAll() {
    // Reset = the session's BASE: the active preset (edits dropped), or flat
    // for an imported EQ. The old graphic-reset path left the convolver
    // curves un-zeroed (audible EQ unchanged) — flat here means genuinely
    // flat: zeroed filters, no curve stack.
    const base = $workingEq.base
    const target: EqPreset =
      base.id === 'imported'
        ? {
            ...base,
            preampDb: 0,
            filters: base.filters.map((f) => ({ ...f, gain: 0 })),
            graphicEqCurves: undefined,
          }
        : structuredClone(base)
    applyEqToEngine(target)
    resetWorkingEq(target)
  }

  async function saveCurrentPreset() {
    await saveEqSession(newPresetName)
    saveDialogOpen = false
    newPresetName = ''
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

    let imported: EqPreset
    if (result.mode === 'graphic') {
      // GraphicEQ: raw curve stack via convolution (no grid merging).
      imported = {
        id: 'imported',
        name: 'Imported',
        mode: 'graphic',
        preampDb: result.preampDb,
        filters: result.filters,
        graphicEqCurves: result.graphicEqCurves,
      }
    } else {
      // Parametric/AutoEQ: merge onto the 10-band grid; unmatched filters
      // are appended as first-class bands (now visible/editable rows).
      const { baseFilters, extraFilters } = mergeFiltersIntoDefaultGrid(result.filters)
      imported = {
        id: 'imported',
        name: 'Imported',
        mode: 'parametric',
        preampDb: result.preampDb,
        filters: [...baseFilters, ...extraFilters],
      }
    }

    applyEqToEngine(imported)
    resetWorkingEq(imported)
    showImport = false
    importText = ''
  }

  function freqLabel(f: number): string {
    if (f >= 1000) return `${(f / 1000).toFixed(f >= 10000 ? 0 : 1).replace(/\.0$/, '')}k`
    return `${Math.round(f)}`
  }

  function formatDb(v: number): string {
    return `${v > 0 ? '+' : ''}${v.toFixed(1)}`
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

    <!-- PRESET SELECTOR: the select owns the full row width (2026-09-14:
         preset names were truncated by four squeeze-in buttons); the actions
         moved to their own row below. -->
    <div class="flex items-center gap-2">
      <div class="relative flex-1">
        <select
          bind:this={selectEl}
          class="w-full appearance-none rounded-lg bg-surface px-3 py-2 text-xs text-primary outline-none ring-1 ring-white/10 focus:ring-primary/40"
          value={$activePresetId}
          onchange={handlePresetChange}
        >
          {#each presets as p}
            <option value={p.id}>{p.name}</option>
          {/each}
        </select>
        <svg class="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
      </div>
      {#if $workingEq.dirty}
        <span class="shrink-0 text-[10px] font-medium text-amber-400" title="Unsaved changes over {findPresetById($workingEq.base.id)?.name ?? 'the active preset'} — they persist with the working state until you save or reset">(edited)</span>
      {/if}
    </div>

    <!-- ACTIONS ROW: one Save (unified — overwrites user presets, asks for a
         name over builtins/imports), Import, Delete. Labels are short so all
         three fit a 360px row without truncation. -->
    <div class="flex items-center gap-2">
      <button
        onclick={onSaveTap}
        disabled={saveDisabled}
        class={"flex-1 rounded-lg px-2.5 py-2 text-xs font-medium ring-1 transition-colors " +
          (saveDisabled
            ? 'bg-white/5 text-muted/40 ring-white/5'
            : 'bg-sky-500/15 text-sky-400 ring-sky-500/30 hover:bg-sky-500/25')}
      >
        {saveNeedsName ? 'Save as New…' : 'Save'}
      </button>
      <button onclick={() => { showImport = !showImport; importText = ''; importErrors = '' }} class="rounded-lg bg-surface px-2.5 py-2 text-xs text-muted transition-colors hover:text-primary ring-1 ring-white/10" title="Import AutoEQ/Parametric EQ text">
        {showImport ? 'Close' : 'Import'}
      </button>
      {#if !presets.find(p => p.id === $activePresetId)?.isBuiltin}
        <button onclick={() => removePreset($activePresetId)} class="rounded-lg bg-surface px-2.5 py-2 text-xs text-red-400 transition-colors hover:bg-red-500/10 ring-1 ring-white/10" title="Delete preset">Delete</button>
      {/if}
    </div>

    <!-- SAVE DIALOG (only for builtin/imported bases — a name is needed) -->
    {#if saveDialogOpen}
      <div class="flex items-center gap-2 rounded-lg bg-surface px-3 py-2 ring-1 ring-white/10">
        <input
          type="text"
          placeholder="Preset name…"
          bind:value={newPresetName}
          class="flex-1 bg-transparent text-xs text-primary outline-none placeholder:text-muted/50"
          onkeydown={(e) => { if (e.key === 'Enter') void saveCurrentPreset() }}
        />
        <button onclick={() => void saveCurrentPreset()} class="rounded bg-white/15 px-2.5 py-1 text-xs font-medium text-primary hover:bg-white/25">Save</button>
        <button onclick={() => saveDialogOpen = false} class="rounded px-2 py-1 text-xs text-muted">Cancel</button>
      </div>
    {/if}

    <!-- DIRTY PRESET-SWITCH DIALOG -->
    {#if dirtyDialog.open}
      <div class="flex flex-col gap-2 rounded-lg bg-surface px-3 py-3 ring-1 ring-amber-500/30">
        <span class="text-xs text-primary">You have unsaved changes. Switch presets?</span>
        <div class="flex justify-end gap-2">
          <button onclick={() => settleDirty('save')} class="rounded bg-sky-500/15 px-2.5 py-1 text-xs text-sky-400 ring-1 ring-sky-500/30 hover:bg-sky-500/25">Save</button>
          <button onclick={() => settleDirty('discard')} class="rounded bg-white/15 px-2.5 py-1 text-xs text-primary hover:bg-white/25">Discard</button>
          <button onclick={() => settleDirty('cancel')} class="rounded px-2.5 py-1 text-xs text-muted hover:text-primary">Cancel</button>
        </div>
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
      <AppSlider
        value={preampDb}
        min={-12}
        max={12}
        step={0.5}
        label="Preamp"
        valueText={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`}
        onInput={onPreampChange}
        disabled={$eqBypassed}
        class="w-full"
      />
      <span class="w-14 text-right text-[10px] tabular-nums text-muted/60">{preampDb > 0 ? '+' : ''}{preampDb.toFixed(1)} dB</span>
    </div>

    <!-- FREQUENCY RESPONSE GRAPH (editable: drag points, tap a dot for
         value/delete, tap empty space to add) -->
    <EqGraph
      preampDb={$eqBypassed ? 0 : preampDb}
      filters={eqState.filters}
      eqBypassed={$eqBypassed}
      eqMode={eqState.mode}
      graphicEqCurves={eqState.graphicEqCurves}
      editable={!isGraphicImport}
      onMoveFilter={moveFilter}
      onAddFilter={(freq) => {
        const idx = addBand(freq)
        if (idx >= 0) openBandEditor(idx)
      }}
      onRemoveFilter={removeBand}
    />

    <!-- BAND EDITOR CONTROLS: each action says what it does -->
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <button
          onclick={onAddBandTap}
          class="rounded px-2.5 py-1 text-xs text-primary ring-1 ring-white/10 transition-colors hover:bg-white/10"
          title="Add a band — you pick the frequency (tapping the graph also adds a band at that spot)"
          disabled={$eqBypassed || isGraphicImport}
        >+ Add Band</button>
        <button
          onclick={flipAllCurves}
          class="rounded px-2.5 py-1 text-xs ring-1 ring-white/10 transition-colors hover:bg-white/10 {anyGraphic ? 'text-accent' : 'text-muted'}"
          title="Convert every band: parametric (its own peak filter) ↔ graphic (a point the curve passes through)"
          disabled={$eqBypassed || !canFlipCurves}
        >{anyGraphic ? 'All Parametric' : 'All Graphic'}</button>
      </div>
      {#if anyGraphic}
        <span class="text-[10px] text-muted/60" title="■ = graphic point the curve passes through; ● = parametric band with its own peak">■ graphic · ● parametric</span>
      {/if}
    </div>

    <!-- BAND SLIDERS: one slim column per band — value / vertical slider /
         tappable frequency. Q, curve kind and remove live in the dot's
         popover on the graph (and Q stays in the popover for parametric
         bands), so 12+ columns stay readable on a phone. -->
    <div class="overflow-x-auto pb-1">
      <div class="flex items-stretch justify-between gap-1" style="height: 190px; min-width: min-content;">
        {#each eqState.filters as f, i (i)}
          <div class="flex min-w-9 flex-1 flex-col items-center gap-1">
            <span class="text-[10px] tabular-nums text-muted/60">{formatDb(f.gain)}</span>
            <div class="flex min-h-0 w-full flex-1 justify-center py-1">
              <EqSlider
                value={f.gain}
                label="{freqLabel(f.frequency)} Hz band"
                disabled={$eqBypassed}
                onInput={(v) => setGain(i, v)}
              />
            </div>
            {#if !isGraphicImport}
              <button
                onclick={() => openBandEditor(i)}
                class="rounded px-1 text-[10px] leading-tight {f.curve === 'graphic' ? 'text-accent' : 'text-muted/70'} hover:text-primary"
                title="Band settings: frequency, width (Q), curve kind, remove"
                disabled={$eqBypassed}
              >{freqLabel(f.frequency)}{f.curve === 'graphic' ? ' ■' : ''}</button>
            {:else}
              <span class="text-[10px] text-muted/50">{freqLabel(f.frequency)}</span>
            {/if}
          </div>
        {/each}
      </div>
    </div>

    <!-- PER-BAND POPOVER: frequency (typed!), width (Q), curve kind, remove -->
    {#if bandPopover !== null && eqState.filters[bandPopover]}
      {@const bi = bandPopover}
      {@const bf = eqState.filters[bi]}
      <div class="rounded-lg bg-surface px-3 py-2.5 ring-1 ring-white/10">
        <div class="mb-2 flex items-center justify-between">
          <span class="text-xs font-medium text-primary">Band · {freqLabel(bf.frequency)} Hz {bf.curve === 'graphic' ? '(graphic point)' : '(parametric)'}</span>
          <button onclick={() => (bandPopover = null)} class="rounded-full p-1 text-muted hover:text-primary" aria-label="Close band editor">
            <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6l-12 12" /></svg>
          </button>
        </div>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label class="flex items-center gap-1.5 text-[10px] text-muted">
            Freq
            <input
              type="number"
              min="20"
              max="20000"
              bind:value={bandFreqDraft}
              onchange={applyBandFreq}
              onkeydown={(e) => { if (e.key === 'Enter') applyBandFreq() }}
              class="w-20 rounded bg-white/5 px-2 py-1 text-xs tabular-nums text-primary outline-none ring-1 ring-white/10 focus:ring-primary/40"
            />
            Hz
          </label>
          {#if bf.curve !== 'graphic'}
            <label class="flex items-center gap-2 text-[10px] text-muted" title="Bandwidth: low = broad, high = narrow">
              Width (Q)
              <AppSlider
                value={bf.q}
                min={0.2}
                max={8}
                step={0.1}
                label="Q for {freqLabel(bf.frequency)} Hz band"
                onInput={(v) => setBandQ(bi, v)}
                disabled={$eqBypassed}
                class="w-28"
              />
              <span class="w-8 text-right text-[10px] tabular-nums text-muted/70">{bf.q.toFixed(1)}</span>
            </label>
          {/if}
          <button
            onclick={() => toggleBandCurve(bi)}
            class="rounded px-2 py-1 text-[10px] ring-1 ring-white/10 {bf.curve === 'graphic' ? 'text-accent' : 'text-muted'} hover:bg-white/10"
            title={bf.curve === 'graphic' ? 'Graphic curve point — tap to give this band its own peak' : 'Parametric band — tap to make it a point the curve passes through'}
            disabled={$eqBypassed}
          >{bf.curve === 'graphic' ? '■ Graphic' : '● Parametric'}</button>
          <button
            onclick={() => { const i = bandPopover; bandPopover = null; if (i !== null) removeBand(i) }}
            class="rounded px-2 py-1 text-[10px] text-red-400/90 ring-1 ring-white/10 hover:bg-red-500/10"
            title="Remove this band"
            disabled={$eqBypassed || eqState.filters.length <= 1}
          >Remove</button>
        </div>
      </div>
    {/if}

    <!-- ADD-BAND FREQUENCY PROMPT -->
    {#if addBandPrompt}
      <div class="flex items-center gap-2 rounded-lg bg-surface px-3 py-2 ring-1 ring-white/10">
        <span class="text-xs text-muted">New band at</span>
        <input
          type="number"
          min="20"
          max="20000"
          bind:value={addBandFreq}
          onkeydown={(e) => { if (e.key === 'Enter') confirmAddBand() }}
          class="w-24 rounded bg-white/5 px-2 py-1 text-xs tabular-nums text-primary outline-none ring-1 ring-white/10 focus:ring-primary/40"
        />
        <span class="text-xs text-muted">Hz</span>
        <button onclick={confirmAddBand} class="ml-auto rounded bg-white/15 px-2.5 py-1 text-xs font-medium text-primary hover:bg-white/25">Add</button>
        <button onclick={() => (addBandPrompt = false)} class="rounded px-2 py-1 text-xs text-muted">Cancel</button>
      </div>
    {/if}

    <!-- RESET -->
    <div class="flex justify-center">
      <button onclick={resetAll} class="rounded px-3 py-1.5 text-xs text-muted transition-colors hover:text-primary ring-1 ring-white/10">Reset All</button>
    </div>
  </div>
</div>

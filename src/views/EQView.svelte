<script lang="ts">
  import { engine } from '../lib/engineFacade'
  import EqGraph from '../components/EqGraph.svelte'
  import EqSlider from '../components/EqSlider.svelte'
  import AppSlider from '../components/AppSlider.svelte'
  import EqSheetModal from '../components/EqSheetModal.svelte'
  import { get } from 'svelte/store'
  import {
    activePresetId,
    userPresets,
    eqBypassed,
    workingEq,
    editWorkingEq,
    resetWorkingEq,
    deleteUserPreset,
    saveEqSession,
    findPresetById,
    switchSessionBase,
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

  // ── Band editor MODAL (2026-09-15): tapping a graph dot (with its new
  //    22px hit target) or a band's frequency label opens the FULL editor —
  //    frequency, gain, width (Q), curve kind, remove — as a centered modal.
  //    The old cramped SVG popover (value + × only) and the inline
  //    shifting-UI rows are gone. ──
  let bandModalIndex = $state<number | null>(null)
  let bandFreqDraft = $state('')
  let bandGainDraft = $state('')

  const modalBand = $derived(bandModalIndex !== null ? eqState.filters[bandModalIndex] : undefined)

  function openBandEditor(i: number) {
    const f = eqState.filters[i]
    if (!f || isGraphicImport) return
    bandModalIndex = i
    bandFreqDraft = String(f.frequency)
    bandGainDraft = String(f.gain)
  }

  function closeBandModal() {
    bandModalIndex = null
  }

  function commitModalFreq() {
    const i = bandModalIndex
    const f = modalBand
    if (i === null || !f) return
    const parsed = Number(bandFreqDraft)
    if (!Number.isFinite(parsed)) {
      bandFreqDraft = String(f.frequency)
      return
    }
    const freq = Math.min(20000, Math.max(20, Math.round(parsed)))
    moveFilter(i, freq, f.gain)
    bandFreqDraft = String(freq)
  }

  function commitModalGain() {
    const i = bandModalIndex
    const f = modalBand
    if (i === null || !f) return
    const parsed = Number(bandGainDraft)
    if (!Number.isFinite(parsed)) {
      bandGainDraft = String(f.gain)
      return
    }
    const gain = Math.min(12, Math.max(-12, Math.round(parsed * 2) / 2))
    moveFilter(i, f.frequency, gain)
    bandGainDraft = String(gain)
  }

  function modalGainChip(v: number) {
    const i = bandModalIndex
    const f = modalBand
    if (i === null || !f) return
    moveFilter(i, f.frequency, v)
    bandGainDraft = String(v)
  }

  function removeModalBand() {
    const i = bandModalIndex
    closeBandModal()
    if (i !== null) removeBand(i)
  }

  // ── Save MODAL (2026-09-15): the two explicit choices live in a real
  //    centered modal instead of an inline block that shifted the UI. The
  //    SESSION BASE decides (not activePresetId — an import keeps the old
  //    preset selected while base.id is 'imported'; same rule as the store). ──
  const basePreset = $derived(presets.find((p) => p.id === $workingEq.base.id))
  const baseIsUserPreset = $derived(!!basePreset && !basePreset.isBuiltin && $workingEq.base.id !== 'imported')
  let saveDialogOpen = $state(false)
  let newPresetName = $state('')

  function onSaveTap() {
    // Never disabled: even a CLEAN session offers Save as New, which is how
    // an existing preset gets DUPLICATED (user request — copying must work).
    newPresetName = ''
    saveDialogOpen = true
  }

  function saveOverwrite() {
    void saveEqSession(undefined, 'auto').then(() => {
      saveDialogOpen = false
      newPresetName = ''
    })
  }

  function saveAsNew() {
    void saveEqSession(newPresetName, 'new').then(() => {
      saveDialogOpen = false
      newPresetName = ''
    })
  }

  // ── Add-band MODAL (was an inline prompt row): the user picks the
  //    frequency; graph taps still add at the tapped spot. ──
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

  // ── Preset flows ────────────────────────────────────────────────────
  // The dirty-switch dialog is GONE (2026-09-15): switching presets re-bases
  // the continuous session and carries the edits — there is nothing to
  // discard, force-save, or cancel.

  async function selectPreset(id: string) {
    // Continuous-session switch (2026-09-15): the working edits are never
    // discarded or force-saved — the session re-bases on the selection and
    // CARRIES the edits, so the sound is unchanged and Save reliably offers
    // "Save as Current" over the selected preset. The old flow discarded
    // the dirty overlay ("Save as Current" vanished after a switch) or
    // force-created a new preset from the switch dialog.
    if (id === $workingEq.base.id && !$workingEq.dirty) return // no-op selection
    const preset = findPresetById(id)
    if (!preset) return
    activePresetId.set(id)
    switchSessionBase(preset)
    applyEqToEngine($workingEq.state)
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

    <!-- ACTIONS ROW: one Save (opens the modal with both choices), Import,
         Delete. Labels are short so all three fit a 360px row. -->
    <div class="flex items-center gap-2">
      <button
        onclick={onSaveTap}
        class="flex-1 rounded-lg bg-sky-500/15 px-2.5 py-2 text-xs font-medium text-sky-400 ring-1 ring-sky-500/30 transition-colors hover:bg-sky-500/25"
      >
        Save
      </button>
      <button onclick={() => { showImport = !showImport; importText = ''; importErrors = '' }} class="rounded-lg bg-surface px-2.5 py-2 text-xs text-muted transition-colors hover:text-primary ring-1 ring-white/10" title="Import AutoEQ/Parametric EQ text">
        {showImport ? 'Close' : 'Import'}
      </button>
      {#if !presets.find(p => p.id === $activePresetId)?.isBuiltin}
        <button onclick={() => removePreset($activePresetId)} class="rounded-lg bg-surface px-2.5 py-2 text-xs text-red-400 transition-colors hover:bg-red-500/10 ring-1 ring-white/10" title="Delete preset">Delete</button>
      {/if}
    </div>

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

    <!-- FREQUENCY RESPONSE GRAPH (editable: drag points, tap a dot for the
         full band editor, tap empty space to add; drag = pan, wheel/pinch =
         zoom the frequency axis) -->
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
      onBandTap={openBandEditor}
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
         tappable frequency (opens the full band editor modal), so 12+
         columns stay readable on a phone. -->
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
                title="Band settings: frequency, gain, width (Q), curve kind, remove"
                disabled={$eqBypassed}
              >{freqLabel(f.frequency)}{f.curve === 'graphic' ? ' ■' : ''}</button>
            {:else}
              <span class="text-[10px] text-muted/50">{freqLabel(f.frequency)}</span>
            {/if}
          </div>
        {/each}
      </div>
    </div>

    <!-- RESET -->
    <div class="flex justify-center">
      <button onclick={resetAll} class="rounded px-3 py-1.5 text-xs text-muted transition-colors hover:text-primary ring-1 ring-white/10">Reset All</button>
    </div>
  </div>
</div>

<!-- ══════════ MODALS (2026-09-15): centered sheets instead of inline rows
     that shifted the UI. Band editor / Save / Add-band / dirty-switch. ════ -->

<!-- BAND EDITOR MODAL -->
<EqSheetModal
  open={bandModalIndex !== null && !!modalBand}
  title={modalBand ? `Band · ${freqLabel(modalBand.frequency)} Hz` : 'Band'}
  onclose={closeBandModal}
>
  {#if modalBand && bandModalIndex !== null}
    <div class="space-y-4">
      <!-- Frequency + gain -->
      <div class="flex items-center gap-3">
        <label class="flex flex-1 items-center gap-1.5 text-[10px] text-muted">
          Freq
          <input
            type="number"
            min="20"
            max="20000"
            bind:value={bandFreqDraft}
            onchange={commitModalFreq}
            onkeydown={(e) => { if (e.key === 'Enter') commitModalFreq() }}
            class="w-24 rounded bg-white/5 px-2 py-1.5 text-sm tabular-nums text-primary outline-none ring-1 ring-white/10 focus:ring-primary/40"
          />
          Hz
        </label>
        <label class="flex flex-1 items-center gap-1.5 text-[10px] text-muted">
          Gain
          <input
            type="number"
            min="-12"
            max="12"
            step="0.5"
            bind:value={bandGainDraft}
            onchange={commitModalGain}
            onkeydown={(e) => { if (e.key === 'Enter') commitModalGain() }}
            class="w-20 rounded bg-white/5 px-2 py-1.5 text-sm tabular-nums text-primary outline-none ring-1 ring-white/10 focus:ring-primary/40"
          />
          dB
        </label>
      </div>

      <!-- Gain quick chips -->
      <div class="flex items-center gap-1.5">
        <span class="text-[10px] text-muted/60">Quick:</span>
        {#each [-6, -3, 0, 3, 6] as g}
          <button
            onclick={() => modalGainChip(g)}
            class="rounded px-2 py-1 text-[10px] tabular-nums ring-1 transition-colors {modalBand.gain === g ? 'bg-primary/15 text-primary ring-primary/40' : 'text-muted ring-white/10 hover:bg-white/10'}"
          >{g > 0 ? '+' : ''}{g}</button>
        {/each}
      </div>

      <!-- Width (Q) — parametric bands only -->
      {#if modalBand.curve !== 'graphic'}
        <div class="flex items-center gap-3">
          <span class="w-16 text-[10px] text-muted" title="Bandwidth: low = broad, high = narrow">Width (Q)</span>
          <AppSlider
            value={modalBand.q}
            min={0.2}
            max={8}
            step={0.1}
            label="Q for {freqLabel(modalBand.frequency)} Hz band"
            onInput={(v) => setBandQ(bandModalIndex ?? 0, v)}
            disabled={$eqBypassed}
            class="flex-1"
          />
          <span class="w-8 text-right text-[10px] tabular-nums text-muted/70">{modalBand.q.toFixed(1)}</span>
        </div>
      {/if}

      <!-- Curve kind: the two explicit choices with descriptions -->
      <div class="space-y-1.5">
        <span class="text-[10px] text-muted">Curve type</span>
        <button
          onclick={() => toggleBandCurve(bandModalIndex ?? 0)}
          class="w-full rounded-lg px-3 py-2 text-left text-xs ring-1 transition-colors {modalBand.curve === 'parametric' ? 'bg-primary/10 text-primary ring-primary/30' : 'text-muted ring-white/10 hover:bg-white/10'}"
        >
          ● Parametric
          <span class="block text-[10px] text-muted/70">Its own peak/biquad filter at this frequency</span>
        </button>
        <button
          onclick={() => toggleBandCurve(bandModalIndex ?? 0)}
          class="w-full rounded-lg px-3 py-2 text-left text-xs ring-1 transition-colors {modalBand.curve === 'graphic' ? 'bg-accent/10 text-accent ring-accent/30' : 'text-muted ring-white/10 hover:bg-white/10'}"
        >
          ■ Graphic
          <span class="block text-[10px] text-muted/70">A point the response curve passes through</span>
        </button>
      </div>

      <!-- Remove -->
      <button
        onclick={removeModalBand}
        class="w-full rounded-lg px-3 py-2 text-xs text-red-400 ring-1 ring-red-500/30 transition-colors hover:bg-red-500/10"
        disabled={$eqBypassed || eqState.filters.length <= 1}
      >
        Remove band
      </button>
    </div>
  {/if}
</EqSheetModal>

<!-- SAVE MODAL: both choices explicit — overwrite the active user preset,
     or save as a NEW preset (the copy path, always available) -->
<EqSheetModal open={saveDialogOpen} title="Save preset" onclose={() => (saveDialogOpen = false)}>
  <div class="space-y-3">
    {#if baseIsUserPreset}
      <button
        onclick={saveOverwrite}
        class="w-full rounded-lg bg-sky-500/15 px-3 py-2.5 text-left text-xs font-medium text-sky-400 ring-1 ring-sky-500/30 hover:bg-sky-500/25"
      >
        Save as Current
        <span class="block text-[10px] font-normal text-sky-400/70">Overwrite “{basePreset?.name}” with these settings</span>
      </button>
    {/if}
    <div>
      <div class="flex items-center gap-2">
        <input
          type="text"
          placeholder="New preset name…"
          bind:value={newPresetName}
          class="min-w-0 flex-1 rounded-lg bg-white/5 px-3 py-2 text-xs text-primary outline-none ring-1 ring-white/10 focus:ring-primary/40 placeholder:text-muted/50"
          onkeydown={(e) => { if (e.key === 'Enter') saveAsNew() }}
        />
        <button onclick={saveAsNew} class="shrink-0 rounded-lg bg-white/15 px-3 py-2 text-xs font-medium text-primary hover:bg-white/25">Save as New</button>
      </div>
      <p class="mt-1.5 text-[10px] text-muted/60">{newPresetName.trim() ? `“${newPresetName.trim()}”` : `“${$workingEq.base.name} (modified)”`} will be created — the current preset stays untouched.</p>
    </div>
    <div class="flex justify-end">
      <button onclick={() => (saveDialogOpen = false)} class="rounded px-3 py-1.5 text-xs text-muted hover:text-primary">Cancel</button>
    </div>
  </div>
</EqSheetModal>

<!-- ADD-BAND MODAL -->
<EqSheetModal open={addBandPrompt} title="Add band" onclose={() => (addBandPrompt = false)}>
  <div class="space-y-3">
    <div class="flex items-center gap-2">
      <span class="text-xs text-muted">New band at</span>
      <input
        type="number"
        min="20"
        max="20000"
        bind:value={addBandFreq}
        onkeydown={(e) => { if (e.key === 'Enter') confirmAddBand() }}
        class="w-28 rounded bg-white/5 px-2 py-1.5 text-sm tabular-nums text-primary outline-none ring-1 ring-white/10 focus:ring-primary/40"
      />
      <span class="text-xs text-muted">Hz</span>
    </div>
    <div class="flex justify-end gap-2">
      <button onclick={() => (addBandPrompt = false)} class="rounded px-3 py-1.5 text-xs text-muted hover:text-primary">Cancel</button>
      <button onclick={confirmAddBand} class="rounded-lg bg-white/15 px-4 py-1.5 text-xs font-medium text-primary hover:bg-white/25">Add</button>
    </div>
  </div>
</EqSheetModal>


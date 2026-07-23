<script lang="ts">
  import { audioManager } from '../lib/audioManager'

  let { onback }: { onback: () => void } = $props()

  let eqBypassed = $state(audioManager.eqBypassed)

  const FREQ_LABELS = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k']
  const FREQ_VALUES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

  let gains = $state(FREQ_VALUES.map((_, i) => {
    const filter = audioManager['_eqFilters']?.[i]
    return filter ? -filter.gain.value : 0
  }))

  function setGain(index: number) {
    audioManager.setEqBandGain(index, -gains[index])
  }

  function toggleBypass() {
    eqBypassed = !eqBypassed
    audioManager.setEqBypass(eqBypassed)
  }

  function resetAll() {
    gains = gains.map(() => 0)
    gains.forEach((_, i) => audioManager.setEqBandGain(i, 0))
  }
</script>

<div class="flex h-full flex-col bg-background">
  <div class="flex items-center justify-between px-4 py-3">
    <div class="flex items-center gap-3">
      <button onclick={onback} class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Back">
        <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5m7-7-7 7 7 7"/></svg>
      </button>
      <span class="text-sm font-medium text-primary">Equalizer</span>
    </div>
    <div class="flex items-center gap-2">
      <button onclick={resetAll} class="rounded px-2.5 py-1 text-xs text-muted transition-colors hover:text-primary">Reset</button>
      <button
        onclick={toggleBypass}
        class={"rounded px-2.5 py-1 text-xs font-medium transition-colors" + (eqBypassed ? ' bg-yellow-500/10 text-yellow-400' : ' bg-surface-hover text-primary')}
      >
        {eqBypassed ? 'Bypassed' : 'Active'}
      </button>
    </div>
  </div>

  <div class="flex-1 overflow-y-auto px-6">
    <div class="flex items-end justify-between gap-1 pb-4" style="height: 320px;">
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
            disabled={eqBypassed}
          />
          <span class="text-[10px] text-muted/50">{label}</span>
        </div>
      {/each}
    </div>

    <div class="pb-8 text-center text-xs text-muted/50">
      Drag sliders to adjust gain (-12dB to +12dB)
    </div>
  </div>
</div>

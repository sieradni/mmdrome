<script lang="ts">
  import { audioManager } from '../lib/audioManager'

  let { onback, oncloseall }: { onback: () => void; oncloseall: () => void } = $props()

  let sliderVal = $state(speedToSlider(audioManager.speed))
  let pitch = $state(audioManager.pitchOctaves)
  let tapeMode = $state(audioManager.tapeMode)

  let speed = $derived(sliderToSpeed(sliderVal))

  function sliderToSpeed(val: number): number {
    if (val <= 50) return 0.2 * Math.pow(5, val / 50)
    return Math.pow(4, (val - 50) / 50)
  }

  function speedToSlider(s: number): number {
    if (s <= 1) return 50 * Math.log(s / 0.2) / Math.log(5)
    return 50 + 50 * Math.log(s) / Math.log(4)
  }

  function updateSpeed() {
    audioManager.setSpeed(speed)
  }

  function updatePitch() {
    audioManager.setPitchOctaves(pitch)
  }

  function toggleTape() {
    tapeMode = !tapeMode
    audioManager.setTapeMode(tapeMode)
  }

  function resetAll() {
    sliderVal = 50
    pitch = 0
    tapeMode = false
    audioManager.setSpeed(1)
    audioManager.setPitchOctaves(0)
    audioManager.setTapeMode(false)
  }
</script>

<div class="flex h-full flex-col bg-background">
  <div class="flex items-center justify-between px-4 py-3">
    <span class="text-sm font-medium text-primary">Pitch & Speed</span>
    <div class="flex items-center gap-2">
      <button
        onclick={resetAll}
        class="rounded-lg px-2 py-1 text-xs text-muted transition-colors hover:text-primary"
        aria-label="Reset speed and pitch"
      >Reset</button>
      <button onclick={oncloseall} class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Library">
        <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" /></svg>
      </button>
      <button onclick={onback} class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Close">
        <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6l-12 12" /></svg>
      </button>
    </div>
  </div>

  <div class="flex-1 overflow-y-auto px-6 space-y-8">
    <!-- Speed -->
    <div class="space-y-3">
      <div class="flex items-center justify-between">
        <p class="text-xs font-medium text-muted uppercase tracking-wider">Speed</p>
        <span class="text-sm tabular-nums text-primary">{speed.toFixed(2)}x</span>
      </div>
      <input
        type="range"
        min="0"
        max="100"
        step="0.1"
        bind:value={sliderVal}
        oninput={updateSpeed}
        class="h-1 w-full accent-white/80"
      />
      <div class="flex justify-between text-[10px] text-muted/50">
        <span>0.2x</span>
        <span>1x</span>
        <span>4x</span>
      </div>
    </div>

    <!-- Pitch -->
    <div class="space-y-3" class:opacity-40={tapeMode}>
      <div class="flex items-center justify-between">
        <p class="text-xs font-medium text-muted uppercase tracking-wider">Pitch</p>
        <span class="text-sm tabular-nums text-primary">{pitch > 0 ? '+' : ''}{pitch.toFixed(2)} oct</span>
      </div>
      <input
        type="range"
        min="-2"
        max="2"
        step="0.01"
        bind:value={pitch}
        oninput={updatePitch}
        disabled={tapeMode}
        class="h-1 w-full accent-white/80 disabled:opacity-30"
      />
      <div class="flex justify-between text-[10px] text-muted/50">
        <span>-2</span>
        <span>0</span>
        <span>+2</span>
      </div>
    </div>

    <!-- Tape Mode -->
    <div class="space-y-3 pt-2">
      <div class="flex items-center justify-between">
        <div>
          <p class="text-sm font-medium text-primary">Tape Mode</p>
          <p class="text-xs text-muted">Pitch follows speed when enabled</p>
        </div>
        <button
          onclick={toggleTape}
          aria-label={tapeMode ? 'Disable tape mode' : 'Enable tape mode'}
          class={"relative h-6 w-11 rounded-full transition-colors" + (tapeMode ? ' bg-yellow-500' : ' bg-white/20')}
        >
          <span class={"absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform" + (tapeMode ? ' translate-x-5' : '')}></span>
        </button>
      </div>
    </div>
  </div>
</div>

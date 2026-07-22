<script lang="ts">
  import { audioManager } from '../lib/audioManager'

  let { onback }: { onback: () => void } = $props()

  let volume = $state(audioManager.preamp?.gain.value ?? 1)

  function updateVolume() {
    if (audioManager.preamp) {
      audioManager.preamp.gain.value = volume
    }
  }
</script>

<div class="flex h-full flex-col bg-background">
  <div class="flex items-center gap-3 px-4 py-3">
    <button onclick={onback} class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Back">
      <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5m7-7-7 7 7 7"/></svg>
    </button>
    <span class="text-sm font-medium text-primary">Volume</span>
  </div>

  <div class="flex flex-1 flex-col items-center justify-center px-10">
    <div class="mb-8">
      <svg class="h-20 w-20 text-muted/30" viewBox="0 0 24 24" fill="currentColor">
        <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
      </svg>
    </div>

    <div class="w-full max-w-sm space-y-4">
      <div class="flex items-center justify-between">
        <span class="text-xs text-muted">Preamp Gain</span>
        <span class="text-sm tabular-nums text-primary">{(volume * 100).toFixed(0)}%</span>
      </div>
      <input
        type="range"
        min="0"
        max="2"
        step="0.01"
        bind:value={volume}
        oninput={updateVolume}
        class="h-1.5 w-full accent-white/80"
      />
      <div class="flex justify-between text-[10px] text-muted/50">
        <span>0%</span>
        <span>100%</span>
        <span>200%</span>
      </div>
    </div>
  </div>
</div>

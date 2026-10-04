<script lang="ts">
  import { engineUnavailable } from '../stores/appState'
  import { engine } from '../lib/engineFacade'

  /**
   * Persistent banner shown when the native recovery ladder gives up on the
   * audio engine (an invalidated AVAudioSession that never recovered —
   * 2026-10-04). Before this, the app silently stopped playing and only a
   * force-quit fixed it; now one tap rebuilds the graph. The store stays false
   * on web, so this never renders off-native.
   */
  let restarting = $state(false)

  function restart() {
    restarting = true
    engine.restartAudioEngine()
    // The native `engineRecovered` event clears the store; release the local
    // busy state shortly after so the button never sticks on a failed tap.
    setTimeout(() => (restarting = false), 1500)
  }
</script>

{#if $engineUnavailable}
  <div
    class="fixed inset-x-0 bottom-0 z-[60] flex items-center gap-3 border-t border-amber-400/30 bg-zinc-900/95 px-4 py-3 backdrop-blur"
    style="padding-bottom: max(0.75rem, env(safe-area-inset-bottom))"
    role="alert"
  >
    <div class="min-w-0 flex-1">
      <p class="text-sm font-semibold text-amber-300">Audio engine unavailable</p>
      <p class="truncate text-xs text-white/60">Playback stopped. Tap to restart.</p>
    </div>
    <button
      type="button"
      class="shrink-0 rounded-full bg-amber-400 px-4 py-2 text-sm font-semibold text-zinc-900 active:scale-95 disabled:opacity-60"
      disabled={restarting}
      onclick={restart}
    >
      {restarting ? 'Restarting…' : 'Restart audio'}
    </button>
  </div>
{/if}

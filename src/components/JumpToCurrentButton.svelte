<script lang="ts">
  let { show, onclick }: { show: boolean; onclick: () => void } = $props()
</script>

{#if show}
  <button
    onclick={onclick}
    class="absolute bottom-5 right-4 z-20 flex items-center gap-1.5 rounded-full bg-surface-hover px-5 py-2.5 text-sm font-medium text-primary shadow-lg ring-1 ring-white/10 transition-colors hover:bg-surface-raised"
    aria-label="Jump to currently playing track"
  >
    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
    Now Playing
  </button>
{/if}
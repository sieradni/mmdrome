<script lang="ts">
  let { show, onclick }: { show: boolean; onclick: () => void } = $props()
</script>

{#if show}
  <button
    onclick={onclick}
    class="absolute bottom-5 right-4 z-20 flex items-center rounded-full bg-surface-hover px-4 py-2.5 text-xl font-medium text-primary shadow-lg ring-1 ring-white/10 transition-colors hover:bg-surface-raised"
    aria-label="Jump to currently playing track"
  >→</button>
{/if}
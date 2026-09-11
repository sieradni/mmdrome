<script lang="ts">
  let { show, onclick }: { show: boolean; onclick: () => void } = $props()
</script>

{#if show}
  <button
    onclick={onclick}
    class="absolute bottom-5 right-4 z-20 flex items-center rounded-full bg-[#0f0f0f] px-4 py-2.5 text-xl font-medium text-muted ring-1 ring-white/10 transition-colors hover:text-primary hover:ring-white/20"
    aria-label="Jump to currently playing track"
  >→</button>
{/if}
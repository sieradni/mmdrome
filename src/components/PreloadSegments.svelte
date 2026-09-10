<script lang="ts">
  import type { PreloadEntry } from '$lib/loadStatus'

  export interface PreloadSegment {
    id: string
    title: string
    entry?: PreloadEntry
  }

  interface Props {
    /** Next tracks in play order (already windowed + capped by the parent). */
    segments: PreloadSegment[]
  }

  let { segments }: Props = $props()

  const cachedCount = $derived(segments.filter((s) => s.entry?.state === 'cached').length)
</script>

{#if segments.length > 0}
  <!-- Ambient upcoming-download strip: solid = cached, partial = fetching with
       known bytes, pulsing = fetching without Content-Length, dim = queued.
       Decorative (the queue rows are the operable surface). -->
  <div
    class="flex items-center gap-1"
    role="img"
    aria-label={`${cachedCount} of ${segments.length} upcoming tracks downloaded`}
  >
    {#each segments as s (s.id)}
      <div
        title={s.title}
        class="relative h-1 flex-1 overflow-hidden rounded-full bg-white/10"
      >
        {#if s.entry?.state === 'cached'}
          <div class="absolute inset-0 rounded-full bg-white/55"></div>
        {:else if s.entry?.state === 'fetching'}
          {#if s.entry.progress !== null}
            <div
              class="absolute inset-y-0 left-0 rounded-full bg-white/45"
              style="width: {s.entry.progress * 100}%;"
            ></div>
          {:else}
            <div class="absolute inset-0 animate-pulse rounded-full bg-white/30"></div>
          {/if}
        {/if}
      </div>
    {/each}
  </div>
{/if}

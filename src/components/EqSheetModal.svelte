<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    open: boolean
    title: string
    onclose: () => void
    /** A11y name (defaults to title). */
    label?: string
    children: Snippet
  }

  let { open, title, onclose, label, children }: Props = $props()
</script>

<svelte:window onkeydown={(e) => { if (open && e.key === 'Escape') onclose() }} />

{#if open}
  <!-- Centered modal at ALL widths (2026-09-15 revision): the sm:-gated
       bottom-sheet rendered bottom-anchored in the app's narrow window AND
       on every phone (both < 640px), which the user called out as extra
       movement. This is now the TrackDetailsModal/FilterSortBar idiom —
       centered card, max-w-lg, Esc + backdrop close. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    onclick={onclose}
    role="presentation"
  >
    <div
      class="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/10 bg-surface shadow-2xl"
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-label={label ?? title}
      tabindex="-1"
    >
      <!-- Header -->
      <div class="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <span class="text-sm font-semibold text-primary">{title}</span>
        <button
          onclick={onclose}
          class="rounded-full p-1.5 text-muted transition-colors hover:text-primary"
          aria-label="Close"
        >
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6l-12 12" /></svg>
        </button>
      </div>

      <!-- Body -->
      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
        {@render children()}
      </div>
    </div>
  </div>
{/if}

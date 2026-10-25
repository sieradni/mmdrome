<script lang="ts">
  import type { Snippet } from 'svelte'
  import ModalShell from './ModalShell.svelte'

  /**
   * The Equalizer's dialog: a TITLE + a scroll body, on the app's one modal
   * primitive (ModalShell). It owns no dialog behaviour of its own — the shell
   * is a native `<dialog>` opened with `showModal()`, which is what gives focus
   * containment, an inert background and top-layer stacking. This used to be a
   * second hand-rolled `fixed z-50` overlay with `aria-modal="true"`: the
   * attribute was untrue in practice (focus stayed on the trigger outside it
   * and every background control stayed tabbable), and Esc had to be re-bound
   * by hand. Do NOT reintroduce an overlay here — a second dialog implementation
   * forks the app's modal behaviour (2026-10-25d).
   */
  interface Props {
    open: boolean
    title: string
    onclose: () => void
    children: Snippet
  }

  let { open, title, onclose, children }: Props = $props()
</script>

{#if open}
  <ModalShell {onclose} ariaLabel={title}>
    <div class="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3">
      <span class="text-sm font-semibold text-primary">{title}</span>
      <button
        onclick={onclose}
        class="rounded-full p-1.5 text-muted transition-colors hover:text-primary"
        aria-label="Close"
      >
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6l-12 12" /></svg>
      </button>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3.5">
      {@render children()}
    </div>
  </ModalShell>
{/if}

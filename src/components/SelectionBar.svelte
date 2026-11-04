<script lang="ts">
  import { selection, clearSelection, selectAllInSurface } from '../stores/selectionStore'
  import {
    applySelectionAddToQueue,
    applySelectionLove,
    applySelectionPlayNext,
    applySelectionRemove,
    applySelectionSetUserQueue,
  } from '../lib/queueCommands'
  import { selectionLabel } from '../lib/selectionCore'

  /**
   * The ONE action bar for a multi-select (2026-11-04), shared by the library
   * and the queue.
   *
   * It is a VIEW over the selection store, not an owner of state: the count,
   * the surface and the available verbs all come from the store, and every
   * button calls the same `queueCommands` function the batch context menu does
   * — so the bar and the menu can never disagree about what "Remove" means.
   *
   * Surface differences are deliberate and small: a library selection is a set
   * of songs that is not queued yet (Play next / Add to queue), a queue
   * selection is already queued (Add to user queue / Remove). "Set as user
   * queue" and the feedback toggle are meaningful on both.
   *
   * Rendered by the OWNING view (never fixed here), so the library can float it
   * above the mini player while the queue swaps it in place of its action
   * island. Escape clears the selection, matching the context menu's dismissal
   * contract.
   */

  let { variant, class: className = '' }: { variant: 'library' | 'queue'; class?: string } = $props()

  let active = $derived($selection.mode && $selection.surface === variant && $selection.keys.length > 0)
  let count = $derived($selection.keys.length)
  let canSelectAll = $derived(($selection.orders[variant]?.length ?? 0) > count)

  $effect(() => {
    if (!active) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      clearSelection()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })

  const buttonClass =
    'flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5 text-muted ring-1 ring-white/10 transition-colors hover:bg-accent-soft hover:text-accent'
</script>

{#if active}
  <div
    class={'flex flex-col gap-1.5 rounded-t-2xl bg-[#090909] p-1.5 ring-1 ring-white/10 ' + className}
    role="region"
    aria-label="Selection actions"
    data-testid="selection-bar"
  >
    <div class="flex items-center gap-2 px-1.5 pt-0.5">
      <span class="text-[11px] font-semibold uppercase tracking-widest text-accent">
        {selectionLabel(count, 'song')}
      </span>
      <div class="h-0.5 flex-1 rounded-full bg-white/20"></div>
      {#if canSelectAll}
        <button
          type="button"
          onclick={() => selectAllInSurface(variant)}
          class="rounded-full px-2.5 py-1 text-[11px] font-medium text-muted transition-colors hover:text-primary"
        >Select all</button>
      {/if}
      <button
        type="button"
        onclick={clearSelection}
        class="rounded-full p-1.5 text-muted transition-colors hover:text-primary"
        aria-label="Clear selection"
      >
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
        </svg>
      </button>
    </div>

    <div class="flex items-stretch gap-1.5">
      {#if variant === 'library'}
        <button type="button" onclick={applySelectionPlayNext} class={buttonClass} aria-label="Play selection next">
          <svg class="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z" />
          </svg>
          <span class="w-full truncate text-center text-[10px] font-medium leading-none">Play next</span>
        </button>
      {/if}

      <button
        type="button"
        onclick={applySelectionAddToQueue}
        class={buttonClass}
        aria-label={variant === 'queue' ? 'Add selection to the user queue' : 'Add selection to the queue'}
      >
        <svg class="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
        </svg>
        <span class="w-full truncate text-center text-[10px] font-medium leading-none">
          {variant === 'queue' ? 'To user queue' : 'Add to queue'}
        </span>
      </button>

      <button
        type="button"
        onclick={applySelectionSetUserQueue}
        class={buttonClass}
        aria-label="Replace the user queue with the selection"
      >
        <svg class="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 3L7.41 7.59 8.83 9 11 6.83V15h2V6.83L15.17 9l1.41-1.41L12 3zM5 19h14v2H5z" />
        </svg>
        <span class="w-full truncate text-center text-[10px] font-medium leading-none">Set queue</span>
      </button>

      <button type="button" onclick={applySelectionLove} class={buttonClass} aria-label="Toggle loved for the selection">
        <svg class="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
        </svg>
        <span class="w-full truncate text-center text-[10px] font-medium leading-none">Loved</span>
      </button>

      {#if variant === 'queue'}
        <button
          type="button"
          onclick={applySelectionRemove}
          class={buttonClass + ' hover:bg-red-500/15 hover:text-red-400'}
          aria-label="Remove selection from the queue"
        >
          <svg class="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </svg>
          <span class="w-full truncate text-center text-[10px] font-medium leading-none">Remove</span>
        </button>
      {/if}
    </div>
  </div>
{/if}

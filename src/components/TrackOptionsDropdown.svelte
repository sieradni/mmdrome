<script lang="ts">
  import { addToUserQueue, playNext } from '../stores/appState'
  import type { Track } from '../stores/appState'

  let { track, ondetails }: { track: Track; ondetails?: () => void } = $props()

  let menuOpen = $state(false)
  let addedTrackIds = $state(new Set<string>())

  function handleAddToQueue(trackId: string) {
    addToUserQueue(trackId)
    addedTrackIds = new Set([...addedTrackIds, trackId])
    setTimeout(() => {
      const next = new Set(addedTrackIds)
      next.delete(trackId)
      addedTrackIds = next
    }, 1000)
  }

  function handlePlayNext() {
    playNext(track.trackId)
    menuOpen = false
  }

  function handleDetails() {
    ondetails?.()
    menuOpen = false
  }

  $effect(() => {
    if (!menuOpen) return
    function handler(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest('[data-menu]')) menuOpen = false
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  })
</script>

<div class="relative" data-menu>
  <button
    onclick={(e) => { e.stopPropagation(); menuOpen = !menuOpen }}
    class="flex-shrink-0 self-stretch rounded-none px-0.5 text-muted transition-colors hover:text-primary"
    aria-label="More options"
  >
    <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
    </svg>
  </button>
  {#if menuOpen}
    <div class="absolute right-0 top-8 z-50 w-40 rounded-lg border border-white/10 bg-surface py-1 shadow-xl">
      <button
        onclick={(e) => { e.stopPropagation(); handleAddToQueue(track.trackId) }}
        class="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-primary"
      >
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" /></svg>
        Add to queue
      </button>
      <button
        onclick={(e) => { e.stopPropagation(); handlePlayNext() }}
        class="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-primary"
      >
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" /></svg>
        Play next
      </button>
      <button
        onclick={(e) => { e.stopPropagation(); handleDetails() }}
        class="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-primary"
      >
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
        Details
      </button>
    </div>
  {/if}
</div>
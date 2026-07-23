<script lang="ts">
  import { queue, library, currentTrack, shuffleEnabled, toggleShuffle, currentTime } from '../stores/appState'
  import { playbackManager } from '../lib/playbackManager'
  import { addToUserQueue, removeFromUserQueue } from '../stores/appState'
import { saveQueue } from '../lib/db'
import LazyThumb from '../components/LazyThumb.svelte'
import type { Track } from '../stores/appState'

  let { onclose }: { onclose: () => void } = $props()

  let dragIndex = $state<number | null>(null)
  let dropAutoIndex = $state<number | null>(null)
  let showHistory = $state(false)

  let userTracks = $derived.by(() => {
    const q = $queue
    const lib = $library
    const ordered: (Track | null)[] = q.userQueue.map((id) => lib.find((t) => t.trackId === id) ?? null)
    return ordered.filter((t): t is Track => t !== null)
  })

  let autoTracks = $derived.by(() => {
    const q = $queue
    const lib = $library
    const ordered: (Track | null)[] = q.autoQueue.map((id) => lib.find((t) => t.trackId === id) ?? null)
    return ordered.filter((t): t is Track => t !== null)
  })

  let historyTracks = $derived.by(() => {
    const q = $queue
    const lib = $library
    return q.historyQueue.map((id) => lib.find((t) => t.trackId === id)).filter((t): t is Track => t !== null).slice(0, 100)
  })

  let activeIndex = $derived($queue.activeIndex)

  function formatTime(sec: number): string {
    if (!isFinite(sec) || sec < 0) return '0:00'
    const m = Math.floor(sec / 60)
    const s = Math.floor(sec % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  function handleDragStart(e: DragEvent, index: number) {
    if (!e.dataTransfer) return
    dragIndex = index
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(index))
  }

  function handleDragOver(e: DragEvent, zone: 'user' | 'auto', idx: number) {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    if (zone === 'auto') {
      dropAutoIndex = idx
    }
  }

  function handleDragLeave(zone: 'user' | 'auto') {
    if (zone === 'auto') dropAutoIndex = null
  }

  function handleDrop(e: DragEvent, zone: 'user' | 'auto', dropIdx: number) {
    e.preventDefault()
    const fromIndex = dragIndex
    if (fromIndex === null) {
      dragIndex = null
      dropAutoIndex = null
      return
    }

    const q = $queue

    if (zone === 'user') {
      const newUser = [...q.userQueue]
      const [moved] = newUser.splice(fromIndex, 1)
      let targetIdx = dropIdx
      if (targetIdx > fromIndex) targetIdx--
      newUser.splice(targetIdx, 0, moved)
      const updated = { ...q, userQueue: newUser }
      saveQueue(updated); queue.set(updated)
    } else {
      const autoIdx = dropIdx - q.userQueue.length
      const movedId = q.userQueue[fromIndex]
      if (movedId == null) { dragIndex = null; dropAutoIndex = null; return }

      const toConvert = q.autoQueue.slice(0, autoIdx)
      const convertIds = new Set(toConvert)
      const updated = {
        ...q,
        userQueue: q.userQueue.filter((_, i) => i !== fromIndex),
        autoQueue: q.autoQueue.filter((id) => !convertIds.has(id)),
      }
      const insertPos = fromIndex <= updated.userQueue.length ? fromIndex : updated.userQueue.length
      updated.userQueue.splice(insertPos, 0, movedId, ...toConvert)
      saveQueue(updated); queue.set(updated)
    }

    dragIndex = null
    dropAutoIndex = null
  }

  function promoteToUser(trackId: string) {
    const q = $queue
    const idx = q.autoQueue.indexOf(trackId)
    if (idx < 0) return
    addToUserQueue(trackId)
    const newAuto = q.autoQueue.filter((id) => id !== trackId)
    const updated = { ...q, autoQueue: newAuto }
    saveQueue(updated); queue.set(updated)
  }

  function removeFromUser(trackId: string) {
    const q = $queue
    const idx = q.userQueue.indexOf(trackId)
    if (idx < 0) return
    removeFromUserQueue(idx)
  }

  function isCurrent(trackId: string): boolean {
    const q = $queue
    const combined = [...q.userQueue, ...q.autoQueue]
    return q.activeIndex >= 0 && q.activeIndex < combined.length && combined[q.activeIndex] === trackId
  }

  function combinedIndexOf(trackId: string): number {
    const q = $queue
    const combined = [...q.userQueue, ...q.autoQueue]
    return combined.indexOf(trackId)
  }

  let dragBoundaryActive = $derived(dragIndex !== null && dropAutoIndex !== null)
</script>

<div class="flex h-full flex-col bg-background">
  <!-- Header -->
  <div class="flex items-center justify-between px-4 py-3">
    <button onclick={onclose} class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Close queue">
      <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5m7-7-7 7 7 7"/></svg>
    </button>
    <span class="text-sm font-medium text-muted">Queue</span>
    <span class="w-10"></span>
  </div>

  <!-- Queue List -->
  <div class="flex-1 overflow-y-auto pb-24">
    {#if $queue.userQueue.length === 0 && $queue.autoQueue.length === 0}
      <div class="flex h-full items-center justify-center">
        <p class="text-xs text-muted">Queue is empty</p>
      </div>
    {/if}

    <!-- Now Playing Indicator -->
    {#if $currentTrack}
      <div class="mx-4 mb-2 flex items-center gap-3 rounded-lg bg-surface/50 px-3 py-2.5 ring-1 ring-white/10">
        <LazyThumb track={$currentTrack} wrapperClass="h-10 w-10 flex-shrink-0 rounded" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-primary">{$currentTrack.title}</p>
          <p class="truncate text-xs text-muted">{$currentTrack.artist}</p>
        </div>
        <span class="text-xs text-muted tabular-nums">{formatTime($currentTime)}</span>
      </div>
    {/if}

    <!-- History Toggle -->
    {#if historyTracks.length > 0}
      <button
        onclick={() => showHistory = !showHistory}
        class="mx-4 mb-1 flex w-[calc(100%-2rem)] items-center gap-2 rounded px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover"
      >
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
          <path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/>
        </svg>
        <span>Previous ({historyTracks.length})</span>
        <svg class={"ml-auto h-3.5 w-3.5 transition-transform" + (showHistory ? ' rotate-180' : '')} viewBox="0 0 24 24" fill="currentColor">
          <path d="M7 10l5 5 5-5z"/>
        </svg>
      </button>

      {#if showHistory}
        <div class="mx-4 mb-2 space-y-0.5 rounded-lg bg-surface/30 px-2 py-2">
          {#each historyTracks as track, idx (idx)}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 transition-colors hover:bg-surface-hover"
              onclick={() => { const ci = combinedIndexOf(track.trackId); if (ci >= 0) playbackManager.playTrackAt(ci) }}
              role="button"
              tabindex="0"
              onkeydown={(e) => { if (e.key === 'Enter') { const ci = combinedIndexOf(track.trackId); if (ci >= 0) playbackManager.playTrackAt(ci) } }}
            >
              <LazyThumb {track} wrapperClass="h-8 w-8 flex-shrink-0 rounded" />
              <div class="min-w-0 flex-1">
                <p class="truncate text-xs text-muted">{track.title}</p>
                <p class="truncate text-[10px] text-muted/60">{track.artist}</p>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {/if}

    <!-- === USER QUEUE === -->
    {#if userTracks.length > 0}
      <div class="mx-4 mb-1 mt-3 flex items-center gap-2 px-1">
        <div class="h-px flex-1 bg-white/10"></div>
        <span class="text-[10px] font-medium uppercase tracking-wider text-muted/50">User Queue</span>
        <div class="h-px flex-1 bg-white/10"></div>
      </div>

      <div class="mx-2 space-y-0.5">
        {#each userTracks as track, idx (idx)}
          {@const dragOver = dragIndex === idx}
          <div
            draggable="true"
            ondragstart={(e) => handleDragStart(e, idx)}
            ondragover={(e) => handleDragOver(e, 'user', idx)}
            ondrop={(e) => handleDrop(e, 'user', idx)}
            class={"flex items-center gap-2 rounded-lg px-2 py-2 transition-colors" + (dragOver ? ' opacity-50' : '') + (isCurrent(track.trackId) ? ' bg-white/5' : ' hover:bg-surface-hover')}
          >
            <!-- Drag Handle -->
            <div class="flex-shrink-0 cursor-grab text-muted/40 hover:text-muted" aria-label="Drag to reorder">
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/>
              </svg>
            </div>

            <!-- Current Track Indicator -->
            {#if isCurrent(track.trackId)}
              <div class="flex-shrink-0">
                <svg class="h-3 w-3 text-yellow-500" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z"/>
                </svg>
              </div>
            {:else}
              <span class="w-3 flex-shrink-0 text-[10px] text-muted/40 tabular-nums">{idx + 1}</span>
            {/if}

            <LazyThumb {track} wrapperClass="h-9 w-9 flex-shrink-0 rounded" />

            <div class="min-w-0 flex-1">
              <p class="truncate text-sm text-primary">{track.title}</p>
              <p class="truncate text-xs text-muted">{track.artist}</p>
            </div>

            <button
              onclick={() => removeFromUser(track.trackId)}
              class="flex-shrink-0 rounded-full p-1 text-muted/40 transition-colors hover:text-red-400"
              aria-label="Remove from queue"
            >
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
              </svg>
            </button>
          </div>
        {/each}
      </div>
    {/if}

    <!-- ── Boundary Indicator ── -->
    <div
      class={"mx-4 my-2 flex items-center gap-2 px-1 transition-all duration-200" + (dragBoundaryActive ? ' opacity-100' : ' opacity-40')}
    >
      <div
        class={"h-0.5 flex-1 rounded-full transition-colors duration-200" + (dragBoundaryActive ? ' bg-yellow-500' : ' bg-white/20')}
      ></div>
      <span
        class={"text-[10px] font-medium uppercase tracking-wider transition-colors duration-200" + (dragBoundaryActive ? ' text-yellow-400' : ' text-muted/50')}
      >
        {dragBoundaryActive ? 'Release to convert' : 'Auto Queue'}
      </span>
      <div
        class={"h-0.5 flex-1 rounded-full transition-colors duration-200" + (dragBoundaryActive ? ' bg-yellow-500' : ' bg-white/20')}
      ></div>
    </div>

    <!-- === AUTO QUEUE === -->
    {#if autoTracks.length > 0}
      <div
        class="mx-2 space-y-0.5"
        ondragover={(e) => { if (dragIndex !== null) { e.preventDefault(); } }}
        ondrop={(e) => { if (dragIndex !== null) { handleDrop(e, 'auto', $queue.userQueue.length); } }}
      >
        {#each autoTracks as track, idx (idx)}
          {@const combinedIdx = userTracks.length + idx}
          <div
            ondragover={(e) => handleDragOver(e, 'auto', combinedIdx)}
            ondragleave={() => handleDragLeave('auto')}
            ondrop={(e) => handleDrop(e, 'auto', combinedIdx)}
            class={"flex items-center gap-2 rounded-lg px-2 py-2 transition-colors" + (isCurrent(track.trackId) ? ' bg-white/5' : ' hover:bg-surface-hover') + (dropAutoIndex === combinedIdx && dragIndex !== null ? ' ring-1 ring-yellow-500/50' : '')}
          >
            <!-- Current Track Indicator -->
            {#if isCurrent(track.trackId)}
              <div class="w-6 flex-shrink-0">
                <svg class="h-3 w-3 text-yellow-500" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z"/>
                </svg>
              </div>
            {:else}
              <span class="w-6 flex-shrink-0 text-[10px] text-muted/40 tabular-nums">{idx + 1}</span>
            {/if}

            <LazyThumb {track} wrapperClass="h-9 w-9 flex-shrink-0 rounded" />

            <div class="min-w-0 flex-1">
              <p class="truncate text-sm text-primary">{track.title}</p>
              <p class="truncate text-xs text-muted">{track.artist}</p>
            </div>

            <button
              onclick={() => promoteToUser(track.trackId)}
              class="flex-shrink-0 rounded-full p-1 text-muted/40 transition-colors hover:text-green-400"
              aria-label="Add to user queue"
            >
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
              </svg>
            </button>
          </div>
        {/each}
      </div>
    {:else if userTracks.length > 0}
      <p class="px-6 py-4 text-center text-xs text-muted/50">Auto queue is empty</p>
    {/if}
  </div>

  <!-- ── Footer Controls ── -->
  <div class="sticky bottom-0 flex items-center justify-between border-t border-white/10 bg-surface px-4 py-2.5 safe-area-bottom">
    <button
      onclick={toggleShuffle}
      class={"flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors" + ($shuffleEnabled ? ' text-yellow-400 bg-yellow-500/10' : ' text-muted')}
    >
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>
      <span>Shuffle</span>
    </button>

    <button
      onclick={onclose}
      class="rounded-lg p-2 text-muted transition-colors hover:text-primary"
      aria-label="Settings"
    >
      <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
    </button>
  </div>
</div>

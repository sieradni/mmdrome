<script lang="ts">
  import { queue, library, currentTrack, shuffleEnabled, toggleShuffle, currentTime, playbackSpeed, playbackState, clearQueue } from '../stores/appState'
  import { playbackManager } from '../lib/playbackManager'
  import { audioManager } from '../lib/audioManager'
  import { addToUserQueue, removeFromUserQueue } from '../stores/appState'
  import { saveQueue } from '../lib/db'
  import LazyThumb from '../components/LazyThumb.svelte'
  import type { Track } from '../stores/appState'

  let { onclose }: { onclose: () => void } = $props()

  let dragIndex = $state<number | null>(null)
  let dropAutoIndex = $state<number | null>(null)

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

  let duration = $state(0)

  $effect(() => {
    const handler = () => {
      duration = audioManager.activeElement.duration || 0
    }
    audioManager.a.addEventListener('durationchange', handler)
    audioManager.b.addEventListener('durationchange', handler)
    handler()
    return () => {
      audioManager.a.removeEventListener('durationchange', handler)
      audioManager.b.removeEventListener('durationchange', handler)
    }
  })

  let effectiveDuration = $derived($playbackSpeed > 0 ? duration / $playbackSpeed : duration)

  function formatTime(sec: number): string {
    if (!isFinite(sec) || sec < 0) return '0:00'
    const m = Math.floor(sec / 60)
    const s = Math.floor(sec % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  function seek(e: Event) {
    const el = e.target as HTMLInputElement
    const t = parseFloat(el.value)
    const realTime = $playbackSpeed > 0 ? t * $playbackSpeed : t
    audioManager.activeElement.currentTime = realTime
    currentTime.set(realTime)
  }

  let sliderValue = $derived($playbackSpeed > 0 ? $currentTime / $playbackSpeed : $currentTime)
  let sliderMax = $derived(effectiveDuration || 1)

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

  function isCurrent(combinedIndex: number): boolean {
    return combinedIndex === $queue.activeIndex
  }

  function playQueueItem(combinedIndex: number) {
    if (combinedIndex !== $queue.activeIndex) {
      playbackManager.playTrackAt(combinedIndex)
    }
  }

  function handleClearQueue() {
    clearQueue()
    playbackManager.replenishAutoQueue()
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
    <button
      onclick={handleClearQueue}
      class="rounded-lg px-2 py-1 text-xs text-muted transition-colors hover:text-red-400"
      aria-label="Clear queue"
    >
      Clear
    </button>
  </div>

  <!-- Queue List -->
  <div class="flex-1 overflow-y-auto pb-4">
    {#if $queue.userQueue.length === 0 && $queue.autoQueue.length === 0}
      <div class="flex h-full items-center justify-center">
        <p class="text-xs text-muted">Queue is empty</p>
      </div>
    {/if}

    <!-- Now Playing Section -->
    {#if $currentTrack}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="mx-4 mb-3 rounded-lg bg-surface/50 px-3 py-2.5 ring-1 ring-white/10"
        role="button"
        tabindex="0"
        onclick={onclose}
        onkeydown={(e) => { if (e.key === 'Enter') onclose() }}
      >
        <div class="flex items-center gap-3">
          <LazyThumb track={$currentTrack} wrapperClass="h-10 w-10 flex-shrink-0 rounded" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-primary">{$currentTrack.title}</p>
            <p class="truncate text-xs text-muted">{$currentTrack.artist}</p>
          </div>
          <span class="text-xs text-muted tabular-nums">{formatTime(sliderValue)} / {formatTime(effectiveDuration)}</span>
        </div>

        <!-- Seek Bar -->
        <div class="mt-2 flex items-center gap-2">
          <input
            type="range"
            min="0"
            max={sliderMax}
            value={sliderValue}
            oninput={(e) => { e.stopPropagation(); seek(e) }}
            class="h-1 flex-1 accent-white/80 cursor-pointer"
            step="0.1"
          />
        </div>

        <!-- Controls -->
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="mt-2 flex items-center justify-between gap-3" onclick={(e) => e.stopPropagation()}>
          <button
            onclick={() => toggleShuffle()}
            class="rounded-full p-1.5 transition-colors"
            class:text-yellow-400={$shuffleEnabled}
            class:text-muted={!$shuffleEnabled}
            aria-label="Toggle shuffle"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>
          </button>

          <button class="rounded-full p-1.5 text-muted transition-colors hover:text-primary" aria-label="Previous track" onclick={() => playbackManager.prev()}>
            <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
          </button>

          <button class="rounded-full bg-primary p-2 text-background transition-colors hover:opacity-80" aria-label="Play / Pause" onclick={() => playbackManager.togglePlayPause()}>
            {#if $playbackState === 'playing'}
              <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>
            {:else}
              <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            {/if}
          </button>

          <button class="rounded-full p-1.5 text-muted transition-colors hover:text-primary" aria-label="Next track" onclick={() => playbackManager.next()}>
            <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z"/></svg>
          </button>

          <span class="w-5"></span>
        </div>
      </div>
    {/if}

    <!-- === USER QUEUE === -->
    {#if userTracks.length > 0}
      <div class="mx-4 mb-1 mt-2 flex items-center gap-2 px-1">
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
            onclick={() => playQueueItem(idx)}
            role="button"
            tabindex="0"
            onkeydown={(e) => { if (e.key === 'Enter') playQueueItem(idx) }}
            class={"flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 transition-colors" + (dragOver ? ' opacity-50' : '') + (isCurrent(idx) ? ' bg-white/5' : ' hover:bg-surface-hover')}
          >
            <!-- Drag Handle -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div role="presentation" class="flex-shrink-0 cursor-grab text-muted/40 hover:text-muted" aria-label="Drag to reorder" onclick={(e) => e.stopPropagation()}>
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/>
              </svg>
            </div>

            <!-- Current Track Indicator -->
            {#if isCurrent(idx)}
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
              onclick={(e) => { e.stopPropagation(); removeFromUser(track.trackId) }}
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
      <!-- svelte-ignore a11y_no_static_element_interactions -->
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
            onclick={() => playQueueItem(combinedIdx)}
            role="button"
            tabindex="0"
            onkeydown={(e) => { if (e.key === 'Enter') playQueueItem(combinedIdx) }}
            class={"flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 transition-colors" + (isCurrent(combinedIdx) ? ' bg-white/5' : ' hover:bg-surface-hover') + (dropAutoIndex === combinedIdx && dragIndex !== null ? ' ring-1 ring-yellow-500/50' : '')}
          >
            <!-- Current Track Indicator -->
            {#if isCurrent(combinedIdx)}
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
              onclick={(e) => { e.stopPropagation(); promoteToUser(track.trackId) }}
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
</div>

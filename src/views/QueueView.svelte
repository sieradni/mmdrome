<script lang="ts">
  import {
    queue,
    library,
    currentTrack,
    shuffleEnabled,
    toggleShuffle,
    currentTime,
    playbackSpeed,
    playbackState,
    clearQueue,
    autoQueueFilters,
    removeFromAutoQueue,
    removeFromUserQueue,
    type Track,
    type QueueState,
  } from '../stores/appState'
  import { onMount, onDestroy } from 'svelte'
  import { flip } from 'svelte/animate'
  import { playbackManager } from '../lib/playbackManager'
  import { audioManager } from '../lib/audioManager'
  import { saveQueue, getSetting, setSetting } from '../lib/db'
  import LazyThumb from '../components/LazyThumb.svelte'
  import TrackDetailsModal from '../components/TrackDetailsModal.svelte'

  let { onclose, oncloseall }: { onclose: () => void; oncloseall: () => void } = $props()

  let filterOpen = $state(false)
  let detailsTrack: Track | null = $state(null)

  // Filter settings state
  let minRating = $state(0)
  let maxRating = $state(100)
  let lovedOnly = $state(false)
  let fromYear = $state<number | ''>('')
  let toYear = $state<number | ''>('')
  let minLength = $state<number | ''>('')
  let maxLength = $state<number | ''>('')
  let searchQuery = $state('')

  function norm(v: any): number | '' {
    if (v === 0 || v === null || v === undefined || v === '') return ''
    const num = Number(v)
    return isNaN(num) ? '' : num
  }

  onMount(async () => {
    const saved = await getSetting<string>('autoQueueFilters')
    if (saved) {
      try {
        const p = JSON.parse(saved)
        if (p.minRating !== undefined) minRating = p.minRating
        if (p.maxRating !== undefined) maxRating = p.maxRating
        if (p.lovedOnly !== undefined) lovedOnly = p.lovedOnly
        if (p.fromYear !== undefined) fromYear = norm(p.fromYear)
        if (p.toYear !== undefined) toYear = norm(p.toYear)
        if (p.minLength !== undefined) minLength = norm(p.minLength)
        if (p.maxLength !== undefined) maxLength = norm(p.maxLength)
        if (p.searchQuery !== undefined) searchQuery = p.searchQuery || ''
      } catch { /* ignore corrupt saved filter */ }
    }
  })

  $effect(() => {
    autoQueueFilters.set({ minRating, maxRating, lovedOnly, fromYear, toYear, minLength, maxLength, searchQuery })
    setSetting('autoQueueFilters', JSON.stringify({ minRating, maxRating, lovedOnly, fromYear, toYear, minLength, maxLength, searchQuery }))
    playbackManager.replenishAutoQueue()
  })

  // Underlying track arrays
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

  let combinedTracks = $derived([...userTracks, ...autoTracks])

  // Drag Engine State
  let listContainerEl = $state<HTMLElement | null>(null)

  let isDragging = $state(false)
  let draggedCombinedIndex = $state<number | null>(null)
  let targetCombinedIndex = $state<number | null>(null)

  let pointerX = $state(0)
  let pointerY = $state(0)
  let dragProxyWidth = $state(320)

  let autoScrollFrameId: number | null = null

  interface KeyedTrack {
    key: string
    track: Track
    originalCombinedIdx: number
  }

  // Reactive preview items for user queue
  let previewUserItems = $derived.by<KeyedTrack[]>(() => {
    const U = userTracks.length
    if (!isDragging || draggedCombinedIndex === null || targetCombinedIndex === null) {
      return userTracks.map((track, i) => ({
        key: `u-${i}-${track.trackId}`,
        track,
        originalCombinedIdx: i,
      }))
    }

    const fromIdx = draggedCombinedIndex
    const toIdx = targetCombinedIndex
    const isUserSource = fromIdx < U

    const draggedTrack = isUserSource ? userTracks[fromIdx] : autoTracks[fromIdx - U]
    if (!draggedTrack) {
      return userTracks.map((track, i) => ({ key: `u-${i}-${track.trackId}`, track, originalCombinedIdx: i }))
    }
    const draggedKey = isUserSource ? `u-${fromIdx}-${draggedTrack.trackId}` : `a-${fromIdx - U}-${draggedTrack.trackId}`

    if (isUserSource) {
      const remainingUser = userTracks
        .map((t, i) => ({ key: `u-${i}-${t.trackId}`, track: t, originalCombinedIdx: i }))
        .filter((_, i) => i !== fromIdx)

      if (toIdx <= U) {
        let insertAt = toIdx
        if (insertAt > fromIdx) insertAt--
        insertAt = Math.max(0, Math.min(insertAt, remainingUser.length))
        const res = [...remainingUser]
        res.splice(insertAt, 0, { key: draggedKey, track: draggedTrack, originalCombinedIdx: fromIdx })
        return res
      } else {
        // User -> Auto conversion rule: convert auto tracks above target position to user queue
        const autoTargetIdx = toIdx - U
        const convertedAuto = autoTracks.slice(0, autoTargetIdx).map((t, i) => ({
          key: `a-${i}-${t.trackId}`,
          track: t,
          originalCombinedIdx: U + i,
        }))
        return [...remainingUser, ...convertedAuto, { key: draggedKey, track: draggedTrack, originalCombinedIdx: fromIdx }]
      }
    } else {
      // Source is Auto -> promoting to user queue
      const remainingUser = userTracks.map((t, i) => ({ key: `u-${i}-${t.trackId}`, track: t, originalCombinedIdx: i }))
      if (toIdx <= U) {
        const insertAt = Math.max(0, Math.min(toIdx, remainingUser.length))
        const res = [...remainingUser]
        res.splice(insertAt, 0, { key: draggedKey, track: draggedTrack, originalCombinedIdx: fromIdx })
        return res
      } else {
        return remainingUser
      }
    }
  })

  // Reactive preview items for auto queue
  let previewAutoItems = $derived.by<KeyedTrack[]>(() => {
    const U = userTracks.length
    if (!isDragging || draggedCombinedIndex === null || targetCombinedIndex === null) {
      return autoTracks.map((track, i) => ({
        key: `a-${i}-${track.trackId}`,
        track,
        originalCombinedIdx: U + i,
      }))
    }

    const A = autoTracks.length
    const fromIdx = draggedCombinedIndex
    const toIdx = targetCombinedIndex
    const isUserSource = fromIdx < U

    const draggedTrack = isUserSource ? userTracks[fromIdx] : autoTracks[fromIdx - U]
    if (!draggedTrack) {
      return autoTracks.map((track, i) => ({ key: `a-${i}-${track.trackId}`, track, originalCombinedIdx: U + i }))
    }
    const draggedKey = isUserSource ? `u-${fromIdx}-${draggedTrack.trackId}` : `a-${fromIdx - U}-${draggedTrack.trackId}`

    if (isUserSource) {
      if (toIdx <= U) {
        return autoTracks.map((t, i) => ({ key: `a-${i}-${t.trackId}`, track: t, originalCombinedIdx: U + i }))
      } else {
        const autoTargetIdx = toIdx - U
        return autoTracks.slice(autoTargetIdx).map((t, i) => {
          const origAutoIdx = autoTargetIdx + i
          return {
            key: `a-${origAutoIdx}-${t.trackId}`,
            track: t,
            originalCombinedIdx: U + origAutoIdx,
          }
        })
      }
    } else {
      // Source is Auto
      const autoFromIdx = fromIdx - U
      const remainingAuto = autoTracks
        .map((t, i) => ({ key: `a-${i}-${t.trackId}`, track: t, originalCombinedIdx: U + i }))
        .filter((_, i) => i !== autoFromIdx)

      if (toIdx <= U) {
        return remainingAuto
      } else {
        const autoTargetIdx = toIdx - U
        let insertAt = autoTargetIdx
        if (insertAt > autoFromIdx) insertAt--
        insertAt = Math.max(0, Math.min(insertAt, remainingAuto.length))
        const res = [...remainingAuto]
        res.splice(insertAt, 0, { key: draggedKey, track: draggedTrack, originalCombinedIdx: fromIdx })
        return res
      }
    }
  })

  let draggedTrack = $derived.by(() => {
    if (draggedCombinedIndex === null) return null
    return combinedTracks[draggedCombinedIndex] ?? null
  })

  let isConvertingUserToAuto = $derived(
    isDragging &&
    draggedCombinedIndex !== null &&
    draggedCombinedIndex < userTracks.length &&
    targetCombinedIndex !== null &&
    targetCombinedIndex > userTracks.length
  )

  let duration = $state(0)

  $effect(() => {
    const handler = () => {
      duration = audioManager.playbackElement.duration || 0
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
    audioManager.playbackElement.currentTime = realTime
    currentTime.set(realTime)
  }

  let sliderValue = $derived($playbackSpeed > 0 ? $currentTime / $playbackSpeed : $currentTime)
  let sliderMax = $derived(effectiveDuration || 1)

  // Drag Engine Functions
  function updateTargetFromPointer(y: number) {
    if (!listContainerEl) return
    const items = Array.from(listContainerEl.querySelectorAll<HTMLElement>('.queue-track-item'))
    if (items.length === 0) return

    let target = items.length
    for (let i = 0; i < items.length; i++) {
      const rect = items[i].getBoundingClientRect()
      const midY = rect.top + rect.height / 2
      if (y < midY) {
        target = i
        break
      }
    }
    targetCombinedIndex = target
  }

  function startPointerDrag(e: PointerEvent, combinedIdx: number) {
    if (e.button !== undefined && e.button !== 0) return

    e.preventDefault()
    e.stopPropagation()

    isDragging = true
    draggedCombinedIndex = combinedIdx
    targetCombinedIndex = combinedIdx

    pointerX = e.clientX
    pointerY = e.clientY

    const targetEl = e.currentTarget as HTMLElement
    if (targetEl && targetEl.setPointerCapture) {
      try {
        targetEl.setPointerCapture(e.pointerId)
      } catch { /* ignore capture error */ }
    }

    const rowEl = targetEl.closest('.queue-track-item') as HTMLElement
    if (rowEl) {
      dragProxyWidth = rowEl.getBoundingClientRect().width
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)

    updateTargetFromPointer(e.clientY)
    startAutoScrollLoop()
  }

  function handlePointerMove(e: PointerEvent) {
    if (!isDragging) return
    pointerX = e.clientX
    pointerY = e.clientY
    updateTargetFromPointer(e.clientY)
  }

  function handlePointerUp(e: PointerEvent) {
    if (!isDragging) return
    applyDrop()
  }

  function handlePointerCancel(e: PointerEvent) {
    stopPointerDrag()
  }

  function applyDrop() {
    if (!isDragging || draggedCombinedIndex === null || targetCombinedIndex === null) {
      stopPointerDrag()
      return
    }

    const currentQ = $queue
    const currentCombinedIds = [...currentQ.userQueue, ...currentQ.autoQueue]
    const activeTrackId = currentQ.activeIndex >= 0 ? currentCombinedIds[currentQ.activeIndex] : null

    const newUserIds = previewUserItems.map((item) => item.track.trackId)
    const newAutoIds = previewAutoItems.map((item) => item.track.trackId)

    const newCombinedIds = [...newUserIds, ...newAutoIds]
    const newActiveIndex = activeTrackId ? newCombinedIds.indexOf(activeTrackId) : -1

    const updated: QueueState = {
      ...currentQ,
      userQueue: newUserIds,
      autoQueue: newAutoIds,
      activeIndex: newActiveIndex,
    }

    saveQueue(updated)
    queue.set(updated)

    stopPointerDrag()
  }

  function stopPointerDrag() {
    isDragging = false
    draggedCombinedIndex = null
    targetCombinedIndex = null

    stopAutoScrollLoop()

    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', handlePointerUp)
    window.removeEventListener('pointercancel', handlePointerCancel)
  }

  function startAutoScrollLoop() {
    if (autoScrollFrameId !== null) cancelAnimationFrame(autoScrollFrameId)

    function loop() {
      if (!isDragging || !listContainerEl) return

      const rect = listContainerEl.getBoundingClientRect()
      const threshold = 60
      const topEdge = rect.top + threshold
      const bottomEdge = rect.bottom - threshold

      if (pointerY < topEdge) {
        const intensity = Math.min(1, (topEdge - pointerY) / threshold)
        listContainerEl.scrollTop -= Math.max(3, intensity * 18)
        updateTargetFromPointer(pointerY)
      } else if (pointerY > bottomEdge) {
        const intensity = Math.min(1, (pointerY - bottomEdge) / threshold)
        listContainerEl.scrollTop += Math.max(3, intensity * 18)
        updateTargetFromPointer(pointerY)
      }

      autoScrollFrameId = requestAnimationFrame(loop)
    }

    autoScrollFrameId = requestAnimationFrame(loop)
  }

  function stopAutoScrollLoop() {
    if (autoScrollFrameId !== null) {
      cancelAnimationFrame(autoScrollFrameId)
      autoScrollFrameId = null
    }
  }

  onDestroy(() => {
    stopPointerDrag()
  })

  // Action Helpers
  function promoteToUser(trackId: string) {
    queue.update((q) => {
      const idx = q.autoQueue.indexOf(trackId)
      if (idx < 0) return q
      const autoQueue = q.autoQueue.filter((id) => id !== trackId)
      const userQueue = [...q.userQueue, trackId]
      const updated = { ...q, userQueue, autoQueue }
      saveQueue(updated)
      return updated
    })
  }

  function promoteToUserNext(trackId: string) {
    queue.update((q) => {
      const idx = q.autoQueue.indexOf(trackId)
      if (idx < 0) return q
      const autoQueue = q.autoQueue.filter((id) => id !== trackId)
      const insertAt = q.activeIndex >= 0 ? q.activeIndex + 1 : q.userQueue.length
      const userQueue = [...q.userQueue.slice(0, insertAt), trackId, ...q.userQueue.slice(insertAt)]
      const adjustedIndex = q.activeIndex >= insertAt ? q.activeIndex + 1 : q.activeIndex
      const updated = { ...q, userQueue, autoQueue, activeIndex: adjustedIndex }
      saveQueue(updated)
      return updated
    })
  }

  function moveToNext(trackId: string) {
    queue.update((q) => {
      const idx = q.userQueue.indexOf(trackId)
      if (idx < 0) return q
      const insertAt = q.activeIndex >= 0 ? q.activeIndex + 1 : q.userQueue.length
      if (idx === insertAt) return q
      const userQueue = q.userQueue.filter((id) => id !== trackId)
      const target = insertAt > idx ? insertAt - 1 : insertAt
      userQueue.splice(target, 0, trackId)
      let activeIndex = q.activeIndex
      if (idx === q.activeIndex) {
        activeIndex = target
      } else if (idx < q.activeIndex && target >= q.activeIndex) {
        activeIndex--
      } else if (idx > q.activeIndex && target <= q.activeIndex) {
        activeIndex++
      }
      const updated = { ...q, userQueue, activeIndex }
      saveQueue(updated)
      return updated
    })
  }

  function moveToEnd(trackId: string) {
    queue.update((q) => {
      const idx = q.userQueue.indexOf(trackId)
      if (idx < 0) return q
      const userQueue = q.userQueue.filter((id) => id !== trackId)
      userQueue.push(trackId)
      let activeIndex = q.activeIndex
      if (idx === q.activeIndex) {
        activeIndex = userQueue.length - 1
      } else if (idx < q.activeIndex) {
        activeIndex--
      }
      const updated = { ...q, userQueue, activeIndex }
      saveQueue(updated)
      return updated
    })
  }

  function removeFromUser(trackId: string) {
    const q = $queue
    const idx = q.userQueue.indexOf(trackId)
    if (idx < 0) return
    removeFromUserQueue(idx)
  }

  function isCurrentTrack(trackId: string, currentCombinedIdx: number): boolean {
    if ($queue.activeIndex < 0) return false
    return currentCombinedIdx === $queue.activeIndex
  }

  function playQueueItem(trackId: string, currentCombinedIdx: number) {
    if (isDragging) return
    const activeId = $queue.activeIndex >= 0 ? combinedTracks[$queue.activeIndex]?.trackId : null
    if (!$currentTrack || $playbackState === 'stopped' || activeId !== trackId || currentCombinedIdx !== $queue.activeIndex) {
      playbackManager.playTrackAt(currentCombinedIdx)
    } else {
      playbackManager.seek(0)
    }
  }

  function handleClearQueue() {
    clearQueue()
    playbackManager.replenishAutoQueue()
  }
</script>

<div class="flex h-full flex-col bg-background select-none">
  <!-- Header -->
  <div class="flex items-center justify-between px-4 py-3">
    <div class="flex items-center gap-2">
      <button onclick={oncloseall} class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Library">
        <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" /></svg>
      </button>
      <button onclick={onclose} class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Close queue">
        <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5m7-7-7 7 7 7"/></svg>
      </button>
    </div>
    <span class="text-sm font-medium text-muted">Queue</span>
    <button
      onclick={handleClearQueue}
      class="rounded-lg px-2 py-1 text-xs text-muted transition-colors hover:text-red-400"
      aria-label="Clear queue"
    >
      Clear
    </button>
  </div>

  <!-- Queue List Scroll Container -->
  <div bind:this={listContainerEl} class="flex-1 overflow-y-auto pb-4 touch-pan-y">
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
            onmousedown={(e) => e.stopPropagation()}
            onclick={(e) => e.stopPropagation()}
            class="h-1 flex-1 accent-white/80 cursor-pointer"
            step="0.1"
          />
        </div>

        <!-- Controls -->
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="mt-2 flex items-center justify-between gap-3" onclick={(e) => e.stopPropagation()}>
          <button
            onclick={() => toggleShuffle()}
            class="rounded-full p-2 text-muted transition-colors hover:text-primary"
            class:text-yellow-400={$shuffleEnabled}
            class:text-muted={!$shuffleEnabled}
            aria-label="Toggle shuffle"
          >
            <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>
          </button>

          <button class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Previous track" onclick={() => playbackManager.prev()}>
            <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
          </button>

          <button class="rounded-full bg-primary p-2.5 text-background transition-colors hover:opacity-80" aria-label="Play / Pause" onclick={() => playbackManager.togglePlayPause()}>
            {#if $playbackState === 'playing'}
              <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>
            {:else}
              <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            {/if}
          </button>

          <button class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Next track" onclick={() => playbackManager.next()}>
            <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z"/></svg>
          </button>

          <span class="w-5"></span>
        </div>
      </div>
    {/if}

    <!-- === USER QUEUE === -->
    {#if previewUserItems.length > 0}
      <div class="mx-4 mb-1 mt-2 flex items-center gap-2 px-1">
        <div class="h-px flex-1 bg-white/10"></div>
        <span class="text-[10px] font-medium uppercase tracking-wider text-muted/50">User Queue</span>
        <div class="h-px flex-1 bg-white/10"></div>
      </div>

      <div class="mx-2 space-y-0.5" role="group" aria-label="User queue">
        {#each previewUserItems as item, itemIndex (item.key)}
          <div
            animate:flip={{ duration: 150 }}
            onclick={() => playQueueItem(item.track.trackId, itemIndex)}
            role="button"
            tabindex="0"
            onkeydown={(e) => { if (e.key === 'Enter') playQueueItem(item.track.trackId, itemIndex) }}
            class={"queue-track-item flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 transition-colors " +
              (isCurrentTrack(item.track.trackId, itemIndex) ? 'bg-white/5 ' : 'hover:bg-surface-hover ') +
              (isDragging && item.originalCombinedIdx === draggedCombinedIndex ? 'opacity-30 ring-1 ring-yellow-500/50 bg-yellow-500/10 ' : '')
            }
            data-combined-index={itemIndex}
          >
            <!-- Drag Handle -->
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div
              class="drag-handle touch-none flex-shrink-0 cursor-grab active:cursor-grabbing rounded p-1 text-muted/60 transition-colors hover:text-muted hover:bg-surface-hover"
              aria-label="Drag to reorder"
              onclick={(e) => e.stopPropagation()}
              onpointerdown={(e) => startPointerDrag(e, item.originalCombinedIdx)}
              role="presentation"
            >
              <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/>
              </svg>
            </div>

            {#if isCurrentTrack(item.track.trackId, itemIndex)}
              <div class="flex-shrink-0">
                <svg class="h-3 w-3 text-yellow-500" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z"/>
                </svg>
              </div>
            {:else}
              <span class="w-3 flex-shrink-0 text-[10px] text-muted/50 tabular-nums text-center">{itemIndex + 1}</span>
            {/if}

            <LazyThumb track={item.track} wrapperClass="h-10 w-10 flex-shrink-0 rounded" />

            <div class="min-w-0 flex-1">
              <p class="truncate text-sm text-primary">{item.track.title}</p>
              <p class="truncate text-xs text-muted">{item.track.artist}</p>
            </div>

            <!-- Action Buttons -->
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div class="flex flex-shrink-0 items-center gap-1" onclick={(e) => e.stopPropagation()} role="presentation">
              <button
                onclick={() => detailsTrack = item.track}
                class="rounded-lg p-2 text-muted/70 transition-colors hover:text-primary"
                aria-label="View details"
              >
                <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>
                </svg>
              </button>
              <button
                onclick={() => moveToNext(item.track.trackId)}
                class="rounded-lg p-2 text-muted/70 transition-colors hover:text-green-400"
                aria-label="Move to next"
              >
                <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z"/>
                </svg>
              </button>
              <button
                onclick={() => moveToEnd(item.track.trackId)}
                class="rounded-lg p-2 text-muted/70 transition-colors hover:text-green-400"
                aria-label="Move to end"
              >
                <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M5 18h14v-2H5v2zm0-5h14v-2H5v2zm0-7v2h14V6H5z"/>
                </svg>
              </button>
              <button
                onclick={() => removeFromUser(item.track.trackId)}
                class="rounded-lg p-2 text-muted/70 transition-colors hover:text-red-400"
                aria-label="Remove from queue"
              >
                <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                </svg>
              </button>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <!-- ── Boundary Indicator ── -->
    <div
      class={"mx-4 my-2 flex items-center gap-2 px-1 transition-all duration-200 " + (isConvertingUserToAuto ? 'opacity-100 scale-[1.01]' : 'opacity-40')}
      role="separator"
      aria-label="Auto queue boundary"
    >
      <div class={"h-0.5 flex-1 rounded-full transition-colors duration-200 " + (isConvertingUserToAuto ? 'bg-yellow-500 shadow-sm shadow-yellow-500/50' : 'bg-white/20')}></div>
      <span class="flex items-center gap-2">
        <span class={"text-[10px] font-medium uppercase tracking-wider transition-colors duration-200 " + (isConvertingUserToAuto ? 'text-yellow-400 font-semibold' : 'text-muted/50')}>
          {isConvertingUserToAuto ? 'Release to convert to User Queue' : 'Auto Queue'}
        </span>
        <button
          onclick={() => filterOpen = !filterOpen}
          class={"rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors " + (filterOpen ? 'bg-white/10 text-white' : 'text-muted/50 hover:text-white')}
        >Filter</button>
      </span>
      <div class={"h-0.5 flex-1 rounded-full transition-colors duration-200 " + (isConvertingUserToAuto ? 'bg-yellow-500 shadow-sm shadow-yellow-500/50' : 'bg-white/20')}></div>
    </div>

    {#if filterOpen}
      <div class="mx-4 mb-2 rounded-lg border border-white/10 bg-surface/50 px-3 py-3">
        <div class="space-y-3">
          <div>
            <span class="text-xs font-medium text-muted">Search Query</span>
            <div class="mt-1">
              <input
                type="search"
                placeholder="Fuzzy search title, artist, album..."
                bind:value={searchQuery}
                class="w-full rounded bg-surface-hover px-2 py-1 text-xs text-primary ring-1 ring-white/10 placeholder-muted outline-none focus:ring-white/20"
              />
            </div>
          </div>

          <div>
            <span class="text-xs font-medium text-muted">Rating range</span>
            <div class="mt-1 flex items-center gap-2">
              <input type="range" min="0" max="100" bind:value={minRating} class="h-1 w-24 accent-yellow-500" />
              <input type="number" min="0" max="100" bind:value={minRating} class="w-14 rounded bg-surface-hover px-2 py-1 text-xs text-primary ring-1 ring-white/10" />
              <span class="text-xs text-muted">–</span>
              <input type="number" min="0" max="100" bind:value={maxRating} class="w-14 rounded bg-surface-hover px-2 py-1 text-xs text-primary ring-1 ring-white/10" />
              <input type="range" min="0" max="100" bind:value={maxRating} class="h-1 w-24 accent-yellow-500" />
            </div>
          </div>
          <label class="flex cursor-pointer items-center gap-2 text-xs text-muted">
            <input type="checkbox" bind:checked={lovedOnly} class="accent-yellow-500" />
            Loved tracks only
          </label>
          <div>
            <span class="text-xs font-medium text-muted">Year</span>
            <div class="mt-1 flex items-center gap-2">
              <input type="number" placeholder="From" bind:value={fromYear} class="w-24 rounded bg-surface-hover px-2 py-1 text-xs text-primary ring-1 ring-white/10 placeholder-muted" />
              <span class="text-xs text-muted">to</span>
              <input type="number" placeholder="To" bind:value={toYear} class="w-24 rounded bg-surface-hover px-2 py-1 text-xs text-primary ring-1 ring-white/10 placeholder-muted" />
            </div>
          </div>
          <div>
            <span class="text-xs font-medium text-muted">Length (seconds)</span>
            <div class="mt-1 flex items-center gap-2">
              <input type="number" placeholder="Min" bind:value={minLength} class="w-24 rounded bg-surface-hover px-2 py-1 text-xs text-primary ring-1 ring-white/10 placeholder-muted" />
              <span class="text-xs text-muted">to</span>
              <input type="number" placeholder="Max" bind:value={maxLength} class="w-24 rounded bg-surface-hover px-2 py-1 text-xs text-primary ring-1 ring-white/10 placeholder-muted" />
            </div>
          </div>
        </div>
      </div>
    {/if}

    <!-- === AUTO QUEUE === -->
    {#if previewAutoItems.length > 0}
      <div class="mx-2 space-y-0.5" role="group" aria-label="Auto queue">
        {#each previewAutoItems as item, idx (item.key)}
          {@const itemCombinedIndex = previewUserItems.length + idx}
          <div
            animate:flip={{ duration: 150 }}
            onclick={() => playQueueItem(item.track.trackId, itemCombinedIndex)}
            role="button"
            tabindex="0"
            onkeydown={(e) => { if (e.key === 'Enter') playQueueItem(item.track.trackId, itemCombinedIndex) }}
            class={"queue-track-item flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 transition-colors " +
              (isCurrentTrack(item.track.trackId, itemCombinedIndex) ? 'bg-white/5 ' : 'hover:bg-surface-hover ') +
              (isDragging && item.originalCombinedIdx === draggedCombinedIndex ? 'opacity-30 ring-1 ring-yellow-500/50 bg-yellow-500/10 ' : '')
            }
            data-combined-index={itemCombinedIndex}
          >
            <!-- Drag Handle -->
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div
              class="drag-handle touch-none flex-shrink-0 cursor-grab active:cursor-grabbing rounded p-1 text-muted/60 transition-colors hover:text-muted hover:bg-surface-hover"
              aria-label="Drag to reorder"
              onclick={(e) => e.stopPropagation()}
              onpointerdown={(e) => startPointerDrag(e, item.originalCombinedIdx)}
              role="presentation"
            >
              <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/>
              </svg>
            </div>

            {#if isCurrentTrack(item.track.trackId, itemCombinedIndex)}
              <div class="flex-shrink-0">
                <svg class="h-3 w-3 text-yellow-500" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z"/>
                </svg>
              </div>
            {:else}
              <span class="w-3 flex-shrink-0 text-[10px] text-muted/50 tabular-nums text-center">{idx + 1}</span>
            {/if}

            <LazyThumb track={item.track} wrapperClass="h-10 w-10 flex-shrink-0 rounded" />

            <div class="min-w-0 flex-1">
              <p class="truncate text-sm text-primary">{item.track.title}</p>
              <p class="truncate text-xs text-muted">{item.track.artist}</p>
            </div>

            <!-- Action Buttons -->
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div class="flex flex-shrink-0 items-center gap-1" onclick={(e) => e.stopPropagation()} role="presentation">
              <button
                onclick={() => detailsTrack = item.track}
                class="rounded-lg p-2 text-muted/70 transition-colors hover:text-primary"
                aria-label="View details"
              >
                <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>
                </svg>
              </button>
              <button
                onclick={() => promoteToUserNext(item.track.trackId)}
                class="rounded-lg p-2 text-muted/70 transition-colors hover:text-green-400"
                aria-label="Play next"
              >
                <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z"/>
                </svg>
              </button>
              <button
                onclick={() => promoteToUser(item.track.trackId)}
                class="rounded-lg p-2 text-muted/70 transition-colors hover:text-green-400"
                aria-label="Add to user queue"
              >
                <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                </svg>
              </button>
              <button
                onclick={() => removeFromAutoQueue(item.track.trackId)}
                class="rounded-lg p-2 text-muted/70 transition-colors hover:text-red-400"
                aria-label="Remove from auto queue"
              >
                <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                </svg>
              </button>
            </div>
          </div>
        {/each}
      </div>
    {:else if previewUserItems.length > 0}
      <p class="px-6 py-4 text-center text-xs text-muted/50">Auto queue is empty</p>
    {/if}
  </div>
</div>

<!-- Floating Drag Proxy (Ghost) -->
{#if isDragging && draggedTrack}
  <div
    class="pointer-events-none fixed z-50 flex items-center gap-2.5 rounded-lg bg-surface/95 px-3 py-2 text-primary shadow-2xl ring-1 ring-white/20 backdrop-blur-md opacity-95 transition-transform duration-75"
    style="left: {pointerX}px; top: {pointerY}px; width: {dragProxyWidth}px; transform: translate(-50%, -50%) scale(1.02);"
  >
    <LazyThumb track={draggedTrack} wrapperClass="h-10 w-10 flex-shrink-0 rounded shadow" />
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-semibold text-primary">{draggedTrack.title}</p>
      <p class="truncate text-xs text-muted">{draggedTrack.artist}</p>
    </div>
  </div>
{/if}

{#if detailsTrack}
  <TrackDetailsModal track={detailsTrack} onclose={() => detailsTrack = null} />
{/if}

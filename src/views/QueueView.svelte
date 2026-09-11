<script lang="ts">
  import {
    queue,
    library,
    currentTrack,
    settings,
    shuffleEnabled,
    toggleShuffle,
    currentTime,
    effectiveDuration,
    playbackState,
    autoQueueFilterFields,
    ratingBound,
    queueWrapNotice,
    autoQueueEmptyNotice,
    type Track,
    type AutoQueueFilterFields,
  } from '../stores/appState'
  import { bufferedRanges, preloadEntries } from '../stores/loadStatus'
  import { advanceTargetIndex } from '../lib/queueMutation'
  import { filterRangesValid } from '../lib/autoQueuePlan'
  import { onMount, onDestroy, tick } from 'svelte'
  import { flip } from 'svelte/animate'
  import { playbackManager } from '../lib/playbackManager'
  import { queueManager } from '../lib/queueManager'
  import { distinctGenres } from '../lib/libraryFilters'
  import { saveViewState, restoreViewState } from '../lib/viewState'
  import LazyThumb from '../components/LazyThumb.svelte'
  import TrackDetailsModal from '../components/TrackDetailsModal.svelte'
  import SeekBar from '../components/SeekBar.svelte'
  import BufferSpinner from '../components/BufferSpinner.svelte'
  import ScrollTopButton from '../components/ScrollTopButton.svelte'

  let { onclose, oncloseall }: { onclose: () => void; oncloseall: () => void } = $props()

  let filterOpen = $state(false)
  let detailsTrack: Track | null = $state(null)
  let genres = $derived(distinctGenres($library))

  // Whether the active row sits in the user section (the clear-above/below
  // buttons only apply there — B2's position anchor is a user-queue concept).
  // NOTHING active (`activeIndex < 0`) means "above/below current" is
  // undefined — both counts read 0 so the buttons disable instead of showing
  // a badge the tap would silently no-op on (the mutation returns null when
  // nothing is active).
  let activeInUser = $derived($queue.activeIndex >= 0 && $queue.activeIndex < $queue.userQueue.length)
  // Rows the clear buttons would remove (0 = button disabled/hidden). When the
  // active row sits in the AUTO section, every user row is above it — the
  // auto-queue-promote invariant keeps user rows out of the tail, so the
  // active auto row is always the LAST user row's successor and clear-below
  // has nothing to remove (0).
  let aboveCount = $derived($queue.activeIndex < 0 ? 0 : activeInUser ? $queue.activeIndex : $queue.userQueue.length)
  let belowCount = $derived(activeInUser ? $queue.userQueue.length - $queue.activeIndex - 1 : 0)

  // Filter fields live in the persisted `autoQueueFilterFields` store — the
  // single source of truth. The store layer persists changes, and the
  // playbackManager reaction replenishes the auto queue (trailing-debounced).
  // No local mirrors, no debounce here (C1).
  function setFilter<K extends keyof AutoQueueFilterFields>(field: K, value: AutoQueueFilterFields[K]): void {
    autoQueueFilterFields.update((f) => ({ ...f, [field]: value }))
  }

  function numFilterField(v: string): number | '' {
    return v === '' ? '' : Number(v)
  }

  onMount(async () => {
    const savedScroll = restoreViewState<{ scrollTop: number }>('queue')
    if (savedScroll && listContainerEl) {
      await tick()
      listContainerEl.scrollTop = savedScroll.scrollTop
    }
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

  let jumpScrollPending = $state(false)
  let jumpBoundaryPending = $state(false)

  function jumpToCurrent() {
    jumpScrollPending = true
  }

  $effect(() => {
    if (!jumpScrollPending || !listContainerEl) return
    const id = $currentTrack?.trackId
    if (!id) {
      jumpScrollPending = false
      return
    }
    tick().then(() => {
      requestAnimationFrame(() => {
        const el = listContainerEl?.querySelector(`[data-track-id="${CSS.escape(id)}"]`)
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        jumpScrollPending = false
      })
    })
  })

  // Jump to the user/auto boundary row (the first auto row) — the floating
  // dock's compass action. No-ops when there is no boundary row.
  $effect(() => {
    if (!jumpBoundaryPending || !listContainerEl) return
    if ($queue.userQueue.length === 0) {
      jumpBoundaryPending = false
      return
    }
    tick().then(() => {
      requestAnimationFrame(() => {
        const el = listContainerEl?.querySelector('[data-boundary]')
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        jumpBoundaryPending = false
      })
    })
  })

  let isDragging = $state(false)
  let draggedCombinedIndex = $state<number | null>(null)
  let targetCombinedIndex = $state<number | null>(null)

  let pointerX = $state(0)
  let pointerY = $state(0)
  let dragProxyWidth = $state(320)
  let dragOffsetX = $state(0)
  let dragOffsetY = $state(0)

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

  function formatTime(sec: number): string {
    if (!isFinite(sec) || sec < 0) return '0:00'
    const m = Math.floor(sec / 60)
    const s = Math.floor(sec % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

 function seekValue(t: number) {
     playbackManager.seek(t)
   }

  /** Ids in the background-preload window (same playing-track-aware start
   *  the preloader fills from). Rows outside it never read the entries map,
   *  so stale entries can't tint rows that left the window. */
  let preloadWindow = $derived.by((): Set<string> => {
    const n = $settings.preloadTracks ?? 0
    if (n <= 0) return new Set()
    const q = $queue
    const ids = [...q.userQueue, ...q.autoQueue]
    const idx = advanceTargetIndex(q, ids, $currentTrack?.trackId)
    if (idx < 0 || idx >= ids.length) return new Set()
    return new Set(ids.slice(idx, idx + n))
  })

  /** Ambient left-to-right fill for an upcoming queue row: a linear-gradient
   *  layer over the row's own background (no extra element, no stacking
   *  fights). Monotonic ladder (review 2026-09-11 — "darker → more tinted
   *  as the download completes", never inverted), PRELOAD range pushed
   *  darker overall with the ramp made more pronounced (second review pass:
   *  2% → 9%, cached ceiling 9% — the progress must READ, not whisper):
   *    fetching partial: 2% → 9% mix AND the fill's extent grows with byte
   *    progress; cached: 9% full wash (the partial's ceiling); the CURRENT
   *    row (.ui-now-playing-row, 11% + edge) sits above all preloads.
   *  Browsers without color-mix drop the background-image and show no wash. */
  function preloadTint(trackId: string): string | undefined {
    if (!preloadWindow.has(trackId)) return undefined
    const entry = $preloadEntries[trackId]
    if (!entry) return undefined
    if (entry.state === 'cached') {
      return 'background-image: linear-gradient(to right, color-mix(in srgb, var(--app-accent) 9%, #101010) 100%, transparent 100%);'
    }
    if (entry.state === 'fetching' && entry.progress !== null) {
      const p = Math.min(Math.max(entry.progress, 0), 1)
      const mix = 2 + p * 7
      return `background-image: linear-gradient(to right, color-mix(in srgb, var(--app-accent) ${mix.toFixed(1)}%, #101010) ${p * 100}%, transparent ${p * 100}%);`
    }
    return undefined
  }

  let sliderValue = $derived($currentTime)
  let sliderMax = $derived($effectiveDuration > 0 ? $effectiveDuration : 1)

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
      const rect = rowEl.getBoundingClientRect()
      dragProxyWidth = rect.width
      dragOffsetX = e.clientX - rect.left
      dragOffsetY = e.clientY - rect.top
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

  function handlePointerUp() {
    if (!isDragging) return
    applyDrop()
  }

  function handlePointerCancel() {
    stopPointerDrag()
  }

  function applyDrop() {
    if (!isDragging || draggedCombinedIndex === null || targetCombinedIndex === null) {
      stopPointerDrag()
      return
    }

    queueManager.reorderAll(
      previewUserItems.map((item) => item.track.trackId),
      previewAutoItems.map((item) => item.track.trackId),
    )

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
  function removeFromUser(trackId: string) {
    const q = $queue
    const idx = q.userQueue.indexOf(trackId)
    if (idx < 0) return
    // Removing the PLAYING row skips to the next track immediately (2.4/2.7)
    // — playbackManager decides whether the removed id was the playing one.
    const removedId = queueManager.removeFromUserQueue(idx)
    if (removedId !== undefined) playbackManager.handleQueueRowRemoved(removedId)
  }

  function isCurrentTrack(currentCombinedIdx: number): boolean {
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
    queueManager.clearQueue()
    queueManager.replenishAutoQueue()
  }

  function clearAbove() {
    queueManager.clearUserAboveActive()
    queueManager.replenishAutoQueue()
  }

  function clearBelow() {
    queueManager.clearUserBelowActive()
    queueManager.replenishAutoQueue()
  }

  function jumpToBoundary() {
    jumpBoundaryPending = true
  }
</script>

<div class="relative flex h-full flex-col bg-background select-none">
  <!-- Header --><!-- py-0.5 + p-2 keeps the bar's total height at the
       original 52px despite the larger 28px glyphs (review 2026-09-11). -->
  <div class="grid grid-cols-3 items-center border-b border-white/10 px-4 py-0.5">
    <div class="flex items-center gap-1">
      <button onclick={oncloseall} class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Library">
        <svg class="h-7 w-7" viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" /></svg>
      </button>
      <button onclick={onclose} class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Close queue">
        <svg class="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5m7-7-7 7 7 7"/></svg>
      </button>
    </div>
    <span class="text-center text-base font-medium text-muted">Queue</span>
    <button
      onclick={handleClearQueue}
      class="justify-self-end rounded-lg bg-surface-hover px-3 py-2 text-sm font-medium text-primary transition-colors hover:text-red-400"
      aria-label="Clear queue"
    >
      Clear
    </button>
  </div>

  <!-- Now Playing island (pinned, ALWAYS visible — an empty state mirrors
       the home view's island so the layout never jumps) -->
  <div class="shrink-0 px-4 pb-1.5 pt-1">
    {#if $currentTrack}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="ui-island relative overflow-hidden px-3 pb-0 pt-2"
        role="button"
        tabindex="0"
        onclick={onclose}
        onkeydown={(e) => { if (e.key === 'Enter') onclose() }}
      >
        <div class="flex items-center gap-3">
          <LazyThumb track={$currentTrack} size={128} wrapperClass="h-10 w-10 flex-shrink-0 rounded" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-primary">{$currentTrack.title}</p>
            <p class="truncate text-xs text-muted">{$currentTrack.artist}</p>
          </div>
          <span class="text-xs text-muted tabular-nums">{formatTime(sliderValue)} / {formatTime($effectiveDuration)}</span>
        </div>

        <!-- Seek Bar -->
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="mt-0" onclick={(e) => e.stopPropagation()} onmousedown={(e) => e.stopPropagation()}>
          <SeekBar
            value={sliderValue}
            max={sliderMax}
            buffered={$bufferedRanges}
            label="Seek"
            valueText="{formatTime(sliderValue)} of {formatTime($effectiveDuration)}"
            onSeek={seekValue}
          />
        </div>

        <!-- Controls: prev / play / next as ONE centered cluster of
             equal-size buttons (nav home/back live in the header — no
             duplicates); shuffle stays pinned far left (absolute) and never
             shifts the group. -->
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="relative -mt-1" onclick={(e) => e.stopPropagation()}>
          <button
            onclick={() => toggleShuffle()}
            class="absolute left-0 top-1/2 -translate-y-1/2 rounded-full p-2.5 transition-colors"
            class:text-accent={$shuffleEnabled}
            class:text-muted={!$shuffleEnabled}
            aria-label="Toggle shuffle"
          >
            <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>
          </button>

          <div class="flex items-center justify-center gap-1.5">
            <button class="rounded-full p-2.5 text-muted transition-colors hover:text-primary" aria-label="Previous track" onclick={() => playbackManager.prev()}>
              <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
            </button>

            <button class="rounded-full p-2.5 text-primary transition-colors hover:text-primary" aria-label="Play / Pause" onclick={() => playbackManager.togglePlayPause()}>
              {#if $playbackState === 'buffering'}
                <span class="flex h-6 w-6 items-center justify-center">
                  <BufferSpinner sizeClass="h-6 w-6" trackClass="border-white/30" headClass="border-t-white" />
                </span>
              {:else if $playbackState === 'playing'}
                <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>
              {:else}
                <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              {/if}
            </button>

            <button class="rounded-full p-2.5 text-muted transition-colors hover:text-primary" aria-label="Next track" onclick={() => playbackManager.next()}>
              <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z"/></svg>
            </button>
          </div>
        </div>
      </div>
    {:else}
      <!-- Empty island: same silhouette as the home mini-player's empty
           state so the two surfaces read as one design. -->
      <div class="ui-island flex items-center gap-3 px-3 py-2.5">
        <div class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded bg-white/5">
          <svg class="h-5 w-5 text-muted" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
        </div>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-primary">Not playing</p>
          <p class="truncate text-xs text-muted">{$queue.userQueue.length + $queue.autoQueue.length > 0 ? 'Press play on a track below' : 'Queue is empty'}</p>
        </div>
      </div>
    {/if}
  </div>

  <!-- Queue List Scroll Container -->
  <div bind:this={listContainerEl} class="min-h-0 flex-1 overflow-y-auto pb-2 touch-pan-y" onscroll={() => { if (listContainerEl) saveViewState('queue', { scrollTop: listContainerEl.scrollTop }) }}>
    <!-- bottom-16: the action island is IN FLOW below the list now — at
         bottom-4 the top button landed ON "Clear below" (review 2026-09-11). -->
    <ScrollTopButton target={listContainerEl} posClass="bottom-16 right-4" />
    {#if $queue.userQueue.length === 0 && $queue.autoQueue.length === 0}
      <div class="flex h-full items-center justify-center">
        <p class="text-sm text-muted">Queue is empty</p>
      </div>
    {/if}

    <!-- === USER QUEUE === -->
    {#if previewUserItems.length > 0}
      <div class="mx-4 mb-1 mt-3 flex items-center gap-2 px-1" role="heading" aria-level="2">
        <span class="text-[11px] font-semibold uppercase tracking-widest text-muted">Up next</span>
        <span class="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted">{previewUserItems.length}</span>
        <div class="h-0.5 flex-1 rounded-full bg-white/25"></div>
      </div>

      <div class="mx-2 space-y-0.5" role="group" aria-label="User queue">
        {#each previewUserItems as item, itemIndex (item.key)}
          <div
            animate:flip={{ duration: 150 }}
            onclick={() => playQueueItem(item.track.trackId, itemIndex)}
            role="button"
            tabindex="0"
            onkeydown={(e) => { if (e.key === 'Enter') playQueueItem(item.track.trackId, itemIndex) }}
            class={"queue-track-item flex cursor-pointer items-center gap-1.5 rounded-lg py-2 pl-1.5 pr-1 transition-colors " +
              (isCurrentTrack(itemIndex) ? 'ui-now-playing-row ' : 'hover:bg-white/5 ') +
              (isDragging && item.originalCombinedIdx === draggedCombinedIndex ? 'opacity-30 ring-1 ring-accent-ring bg-accent-soft ' : '')
            }
            style={preloadTint(item.track.trackId)}
            data-combined-index={itemIndex}
            data-track-id={item.track.trackId}
          >
            <!-- Drag Handle -->
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div
              class="drag-handle touch-none flex-shrink-0 cursor-grab active:cursor-grabbing rounded py-1 pl-1 pr-0.5 text-muted/60 transition-colors hover:text-muted hover:bg-surface-hover"
              aria-label="Drag to reorder"
              onclick={(e) => e.stopPropagation()}
              onpointerdown={(e) => startPointerDrag(e, item.originalCombinedIdx)}
              role="presentation"
            >
              <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/>
              </svg>
            </div>

            <LazyThumb track={item.track} size={128} wrapperClass="h-10 w-10 flex-shrink-0 rounded" />

            <!-- Minimal: current row is the plain white/10 fill — no EQ-bar
                 glyph (de-cluttered 2026-09-10 review). -->

            <div class="min-w-0 flex-1">
              <p class="truncate text-sm text-primary">{item.track.title}</p>
              <p class="truncate text-xs text-muted">{item.track.artist}</p>
            </div>

            <!-- Action Buttons -->
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div class="flex flex-shrink-0 items-center gap-0.5" onclick={(e) => e.stopPropagation()} role="presentation">
              <button
                onclick={() => detailsTrack = item.track}
                class="rounded-lg p-2 text-muted/70 transition-colors hover:text-primary"
                aria-label="View details"
              >
                <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
                </svg>
              </button>
              <button
                onclick={() => queueManager.moveToNext(item.track.trackId)}
                class="rounded-lg p-2 text-muted/70 transition-colors hover:text-green-400"
                aria-label="Move to next"
              >
                <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z"/>
                </svg>
              </button>
              <button
                onclick={() => queueManager.moveToEnd(item.track.trackId)}
                class="rounded-lg p-2 text-muted/70 transition-colors hover:text-green-400"
                aria-label="Move to end"
              >
                <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M7 13l5 5 5-5"/>
                  <path d="M7 6l5 5 5-5"/>
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

    <!-- ── Boundary ── the user/auto seam is now the line under the "Up next"
         header; the old separator row between the sections is gone. The
         jump-to-boundary scroll target rides the AUTO header (the first auto
         row is the boundary), and the drag-over-seam conversion banner lives
         there too so the seam affordance survives without a dedicated row. -->

    {#if $queueWrapNotice && previewAutoItems.length > 0}
      <p class="mx-4 mb-1 text-center text-[11px] text-muted/60">Continuing from the top of the sort order</p>
    {/if}

    {#if $autoQueueEmptyNotice}
      <p class="mx-4 mb-1 text-center text-[11px] text-yellow-500/80">Auto queue is empty — nothing left to add from the current filters</p>
    {/if}

    <!-- === AUTO QUEUE === -->
    {#if previewAutoItems.length > 0}
      <div class="mx-4 mb-1 flex items-center gap-2 px-1" role="heading" aria-level="2" data-boundary>
        <span class="text-[11px] font-semibold uppercase tracking-widest" class:text-accent={isConvertingUserToAuto} class:text-muted={!isConvertingUserToAuto}>Auto</span>
        <span class="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted">{previewAutoItems.length}</span>
        <div class="h-0.5 flex-1 rounded-full bg-white/25"></div>
        {#if isConvertingUserToAuto}
          <span class="text-xs font-medium uppercase tracking-wider text-accent">Release to convert to User Queue</span>
        {/if}
      </div>
      <div class="mx-2 space-y-0.5" role="group" aria-label="Auto queue">
        {#each previewAutoItems as item, idx (item.key)}
          {@const itemCombinedIndex = previewUserItems.length + idx}
          <div
            animate:flip={{ duration: 150 }}
            onclick={() => playQueueItem(item.track.trackId, itemCombinedIndex)}
            role="button"
            tabindex="0"
            onkeydown={(e) => { if (e.key === 'Enter') playQueueItem(item.track.trackId, itemCombinedIndex) }}
            class={"queue-track-item flex cursor-pointer items-center gap-1.5 rounded-lg py-2 pl-1.5 pr-1 transition-colors " +
              (isCurrentTrack(itemCombinedIndex) ? 'bg-white/10 ' : 'hover:bg-white/5 ') +
              (isDragging && item.originalCombinedIdx === draggedCombinedIndex ? 'opacity-30 ring-1 ring-accent-ring bg-accent-soft ' : '')
            }
            style={preloadTint(item.track.trackId)}
            data-combined-index={itemCombinedIndex}
            data-track-id={item.track.trackId}
          >
            <!-- Drag Handle -->
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div
              class="drag-handle touch-none flex-shrink-0 cursor-grab active:cursor-grabbing rounded py-1 pl-1 pr-0.5 text-muted/60 transition-colors hover:text-muted hover:bg-surface-hover"
              aria-label="Drag to reorder"
              onclick={(e) => e.stopPropagation()}
              onpointerdown={(e) => startPointerDrag(e, item.originalCombinedIdx)}
              role="presentation"
            >
              <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/>
              </svg>
            </div>

            <LazyThumb track={item.track} size={128} wrapperClass="h-10 w-10 flex-shrink-0 rounded" />

            <!-- Minimal: current row is the plain white/10 fill — no EQ-bar
                 glyph (de-cluttered 2026-09-10 review). -->

            <div class="min-w-0 flex-1">
              <p class="truncate text-sm text-primary">{item.track.title}</p>
              <p class="truncate text-xs text-muted">{item.track.artist}</p>
            </div>

            <!-- Action Buttons -->
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div class="flex flex-shrink-0 items-center gap-0.5" onclick={(e) => e.stopPropagation()} role="presentation">
              <button
                onclick={() => detailsTrack = item.track}
                class="rounded-lg p-2 text-muted/70 transition-colors hover:text-primary"
                aria-label="View details"
              >
                <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
                </svg>
              </button>
              <button
                onclick={() => queueManager.promoteToUserNext(item.track.trackId)}
                class="rounded-lg p-2 text-muted/70 transition-colors hover:text-green-400"
                aria-label="Play next"
              >
                <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z"/>
                </svg>
              </button>
              <button
                onclick={() => queueManager.promoteToUser(item.track.trackId)}
                class="rounded-lg p-2 text-muted/70 transition-colors hover:text-green-400"
                aria-label="Add to user queue"
              >
                <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                </svg>
              </button>
              <button
                onclick={() => queueManager.removeFromAutoQueue(item.track.trackId)}
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
      <p class="px-6 py-4 text-center text-sm text-muted/50">Auto queue is empty</p>
    {/if}

    <!-- End-of-queue terminus: extra scroll length past the last row so the
         ↑ button (or a thumb resting near the list bottom) never covers the
         final rows (review 2026-09-11). -->
    {#if combinedTracks.length > 0}
      <div class="flex flex-col items-center gap-1 px-6 pb-16 pt-8 text-center" aria-hidden="true">
        <div class="h-0.5 w-8 rounded-full bg-white/15"></div>
        <p class="text-[11px] uppercase tracking-widest text-muted/40">End of queue</p>
      </div>
    {/if}
  </div>

  <!-- Action island: outlined, icon-over-label buttons that GROW to fill
       ONE row (flex-1 + truncate — never wraps, no precise-tap targets).
       In flow BELOW the list — the old floating dock overlayed the last
       rows, so bottom content was unreachable without scrolling blind past
       it. Shaped like the now-playing island above (rounded card, ring,
       margins) so the two read as one design language. Counts sit inline in
       the label text — a red corner badge read as an OS notification (it is
       a destructive count, not an alert), so it died. -->
  <!-- iOS device: the safe-area inset ALREADY covers the home-indicator
       clearance (App-level nav bar carries safe-area-bottom too) — the extra
       12px --safe-area-extra over-padded the action island off the bottom of
       the screen (review 2026-09-11). -->
  <div class="shrink-0 px-4 pt-1 safe-area-bottom">
    <!-- Square bottom corners: the island sits flush against the screen edge,
         so rounding only the bottom read as a floating gap (review
         2026-09-11). Hover language = ACCENT here (the island's five buttons
         are the queue's primary operable controls), matching the row-accent
         states elsewhere. -->
    <div class="flex items-stretch gap-1.5 rounded-t-2xl bg-[#090909] p-1.5 ring-1 ring-white/10">
      <button
        onclick={jumpToCurrent}
        disabled={!$currentTrack}
        class="flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5 text-muted ring-1 ring-white/10 transition-colors hover:bg-accent-soft hover:text-accent disabled:opacity-30"
        aria-label="Jump to currently playing track"
      >
        <svg class="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16zm-1-13v5.59l3.95 3.95 1.41-1.41L13 11.17V7h-2z"/></svg>
        <span class="w-full truncate text-center text-[10px] font-medium leading-none">Current</span>
      </button>
      <button
        onclick={jumpToBoundary}
        disabled={$queue.userQueue.length === 0 || previewAutoItems.length === 0}
        class="flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5 text-muted ring-1 ring-white/10 transition-colors hover:bg-accent-soft hover:text-accent disabled:opacity-30"
        aria-label="Jump to the user and auto queue boundary"
      >
        <svg class="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
        <span class="w-full truncate text-center text-[10px] font-medium leading-none">Boundary</span>
      </button>
      <button
        onclick={() => filterOpen = !filterOpen}
        class={"flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5 transition-colors hover:bg-accent-soft hover:text-accent " + (filterOpen ? 'chip-on' : 'text-muted ring-1 ring-white/10')}
        aria-label="Auto queue filters"
        aria-expanded={filterOpen}
      >
        <svg class="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/></svg>
        <span class="w-full truncate text-center text-[10px] font-medium leading-none">Filters</span>
      </button>
      <button
        onclick={clearAbove}
        disabled={aboveCount === 0}
        class="flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5 text-muted ring-1 ring-white/10 transition-colors hover:bg-accent-soft hover:text-accent disabled:opacity-30 disabled:hover:bg-transparent"
        aria-label={`Clear ${aboveCount} played track${aboveCount === 1 ? '' : 's'} above the current song`}
      >
        <svg class="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 15.41 12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>
        <span class="w-full truncate text-center text-[10px] font-medium leading-none">Clear above{#if aboveCount > 0}&nbsp;{aboveCount}{/if}</span>
      </button>
      <button
        onclick={clearBelow}
        disabled={belowCount === 0}
        class="flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5 text-muted ring-1 ring-white/10 transition-colors hover:bg-accent-soft hover:text-accent disabled:opacity-30 disabled:hover:bg-transparent"
        aria-label={`Clear ${belowCount} track${belowCount === 1 ? '' : 's'} below the current song`}
      >
        <svg class="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
        <span class="w-full truncate text-center text-[10px] font-medium leading-none">Clear below{#if belowCount > 0}&nbsp;{belowCount}{/if}</span>
      </button>
    </div>
  </div>
</div>

<!-- Auto-queue filter popup: a centered modal (TrackDetailsModal idiom) —
     closes via Esc, backdrop, X, or Done; never demands a precise click. -->
{#if filterOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    onclick={() => filterOpen = false}
    role="presentation"
  >
    <div
      class="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-xl border border-white/10 bg-surface shadow-2xl"
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="Auto queue filters"
      tabindex="-1"
    >
      <div class="flex items-center justify-between border-b border-white/10 px-5 py-3">
        <span class="text-base font-bold text-primary">Auto queue filters</span>
        <button onclick={() => filterOpen = false} class="rounded-full p-1.5 text-muted transition-colors hover:text-primary" aria-label="Close filters">
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
      <div class="space-y-4 px-5 py-4">
        <div>
          <span class="text-sm font-medium text-muted">Search Query</span>
          <div class="mt-1">
            <input
              type="search"
              placeholder="Fuzzy search title, artist, album..."
              value={$autoQueueFilterFields.searchQuery ?? ''}
              oninput={(e) => setFilter('searchQuery', (e.target as HTMLInputElement).value)}
              class="w-full rounded bg-surface-hover px-2 py-1 text-sm text-primary ring-1 ring-white/10 placeholder-muted outline-none focus:ring-accent-ring"
            />
          </div>
        </div>

        <div>
          <span class="text-sm font-medium text-muted">Rating range</span>
          <div class="mt-1 flex items-center gap-2">
            <input type="range" min="0" max="100" value={$autoQueueFilterFields.minRating} oninput={(e) => setFilter('minRating', Number((e.target as HTMLInputElement).value))} class="h-1 w-24" />
            <input data-testid="min-rating" type="number" min="0" max="100" value={$autoQueueFilterFields.minRating} oninput={(e) => setFilter('minRating', ratingBound((e.target as HTMLInputElement).value, 0))} class="w-14 rounded bg-surface-hover px-2 py-1 text-sm text-primary ring-1 ring-white/10" />
            <span class="text-sm text-muted">–</span>
            <input data-testid="max-rating" type="number" min="0" max="100" value={$autoQueueFilterFields.maxRating} oninput={(e) => setFilter('maxRating', ratingBound((e.target as HTMLInputElement).value, 100))} class="w-14 rounded bg-surface-hover px-2 py-1 text-sm text-primary ring-1 ring-white/10" />
            <input type="range" min="0" max="100" value={$autoQueueFilterFields.maxRating} oninput={(e) => setFilter('maxRating', Number((e.target as HTMLInputElement).value))} class="h-1 w-24" />
          </div>
        </div>
        <label class="flex cursor-pointer items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={$autoQueueFilterFields.lovedOnly} onchange={(e) => setFilter('lovedOnly', (e.target as HTMLInputElement).checked)} />
          Loved tracks only
        </label>
        {#if genres.length > 0}
          <div>
            <span class="text-sm font-medium text-muted">Genre</span>
            <select value={$autoQueueFilterFields.genre ?? ''} onchange={(e) => setFilter('genre', (e.target as HTMLSelectElement).value)} class="mt-1 block w-full rounded bg-surface-hover px-2 py-1 text-sm text-primary ring-1 ring-white/10 outline-none">
              <option value="">All genres</option>
              {#each genres as g}
                <option value={g}>{g}</option>
              {/each}
            </select>
          </div>
        {/if}
        <div>
          <span class="text-sm font-medium text-muted">Year</span>
          <div class="mt-1 flex items-center gap-2">
            <input type="number" placeholder="From" value={$autoQueueFilterFields.fromYear} oninput={(e) => setFilter('fromYear', numFilterField((e.target as HTMLInputElement).value))} class="w-24 rounded bg-surface-hover px-2 py-1 text-sm text-primary ring-1 ring-white/10 placeholder-muted" />
            <span class="text-sm text-muted">to</span>
            <input type="number" placeholder="To" value={$autoQueueFilterFields.toYear} oninput={(e) => setFilter('toYear', numFilterField((e.target as HTMLInputElement).value))} class="w-24 rounded bg-surface-hover px-2 py-1 text-sm text-primary ring-1 ring-white/10 placeholder-muted" />
          </div>
        </div>
        <div>
          <span class="text-sm font-medium text-muted">Length (seconds)</span>
          <div class="mt-1 flex items-center gap-2">
            <input type="number" placeholder="Min" value={$autoQueueFilterFields.minLength} oninput={(e) => setFilter('minLength', numFilterField((e.target as HTMLInputElement).value))} class="w-24 rounded bg-surface-hover px-2 py-1 text-sm text-primary ring-1 ring-white/10 placeholder-muted" />
            <span class="text-sm text-muted">to</span>
            <input type="number" placeholder="Max" value={$autoQueueFilterFields.maxLength} oninput={(e) => setFilter('maxLength', numFilterField((e.target as HTMLInputElement).value))} class="w-24 rounded bg-surface-hover px-2 py-1 text-sm text-primary ring-1 ring-white/10 placeholder-muted" />
          </div>
        </div>
        {#if !filterRangesValid($autoQueueFilterFields)}
          <p class="text-[11px] text-yellow-500/80">Ranges are inverted — no track can match both bounds</p>
        {/if}
      </div>
    </div>
  </div>
{/if}

<svelte:window onkeydown={(e) => { if (e.key === 'Escape' && filterOpen) filterOpen = false }} />

<!-- Floating Drag Proxy (Ghost) -->
{#if isDragging && draggedTrack}
  <div
    class="pointer-events-none fixed z-50 flex items-center gap-2.5 rounded-lg bg-surface/95 px-3 py-2 text-primary shadow-2xl ring-1 ring-white/20 backdrop-blur-md opacity-95 transition-transform duration-75"
    style="left: {pointerX - dragOffsetX}px; top: {pointerY - dragOffsetY}px; width: {dragProxyWidth}px; transform-origin: top left; transform: scale(1.02);"
  >
    <LazyThumb track={draggedTrack} size={128} wrapperClass="h-10 w-10 flex-shrink-0 rounded shadow" />
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-semibold text-primary">{draggedTrack.title}</p>
      <p class="truncate text-xs text-muted">{draggedTrack.artist}</p>
    </div>
  </div>
{/if}

{#if detailsTrack}
  <TrackDetailsModal track={detailsTrack} onclose={() => detailsTrack = null} />
{/if}

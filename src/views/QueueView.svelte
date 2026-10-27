<script lang="ts">
  import {
    queue,
    library,
    currentTrack,
    shuffleEnabled,
    toggleShuffle,
    currentTime,
    effectiveDuration,
    playbackState,
    autoQueueFilterFields,
    autoQueueSort,
    autoQueueEnabled,
    ratingBound,
    queueWrapNotice,
    autoQueueEmptyNotice,
    autoQueueScope,
    type Track,
    type AutoQueueFilterFields,
  } from '../stores/appState'
  import { bufferedRanges, preloadEntries } from '../stores/loadStatus'
  import { planDragDrop } from '../lib/queueMutation'
  import {
    entryIdOf,
    findEntryIndex,
    rowKeyOf,
    sectionOccurrences,
  } from '../lib/queueOccurrence'
  import { currentLoadedFraction } from '../lib/loadStatus'
  import { filterRangesValid } from '../lib/autoQueuePlan'
  import { onMount, onDestroy, tick } from 'svelte'
  import { derived } from 'svelte/store'
  import AppSlider from '../components/AppSlider.svelte'
  import ClearableSearch from '../components/ClearableSearch.svelte'
  import { playbackManager } from '../lib/playbackManager'
  import { queueManager } from '../lib/queueManager'
  import { distinctGenres } from '../lib/libraryFilters'
  import { restoreViewState } from '../lib/viewState'
  import { sortLabels, type LibrarySortKey } from '../lib/libraryFilters'
  import { ESTIMATED_ROW_H, OVERSCAN_ROWS, endOffsetPx, startOffsetPx } from '../lib/virtualWindow'
  import { createScrollWindow, firstRowMeasure } from '../lib/scrollWindow'
  import LazyThumb from '../components/LazyThumb.svelte'
  import TrackDetailsModal from '../components/TrackDetailsModal.svelte'
  import SeekBar from '../components/SeekBar.svelte'
  import BufferSpinner from '../components/BufferSpinner.svelte'
  import ScrollTopButton from '../components/ScrollTopButton.svelte'
  import { tooltip } from '../lib/tooltip'

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

  /** Auto-queue sort editor (the filter modal's Sort section). Same pick /
   *  flip / clear contract as the library sort menu: picking the active key
   *  flips direction, picking a new key sets its default direction, null
   *  clears. Writes the PERSISTED setting; the fill only acts on it while
   *  shuffle is off (under shuffle the eligible pool is sampled uniformly and
   *  the sort has no effect). The editor is always rendered (2026-10-24). */
  function setAutoSort(key: LibrarySortKey | null): void {
    autoQueueSort.update((s) => {
      if (key === null) return { ...s, sortBy: null }
      if (s.sortBy === key) return { ...s, sortAsc: !s.sortAsc }
      return { sortBy: key, sortAsc: key === 'length' || key === 'year' }
    })
  }

  onMount(() => {
    const savedScroll = restoreViewState<{ scrollTop: number }>('queue')
    if (savedScroll?.scrollTop) queueMachine.armRestore(savedScroll.scrollTop)
  })

  // Library lookup for the occurrence rows. One Map per library change; the
  // row derives below run on every queue write, so a per-id `find` over the
  // whole library would be O(queue × library).
  let trackMap = $derived.by(() => {
    const m = new Map<string, Track>()
    for (const t of $library) m.set(t.trackId, t)
    return m
  })

  /** Live combined id order — the only source of a row's true combined index. */
  let combinedIds = $derived([...$queue.userQueue, ...$queue.autoQueue])

  interface KeyedTrack {
    /** Occurrence row key (`u-<id>#<n>` / `a-<id>#<n>`) — position-free. */
    key: string
    /** Transport/occurrence identity (the drag identity, D4/D11). */
    entryId: string
    track: Track
    /** True combined index in the CURRENT queue (data-stamped, never a mount
     *  position); during a drag it is the PREVIEW-space index. */
    originalCombinedIdx: number
  }

  /** Rows for one section, occurrence-keyed. An id missing from the library
   *  still consumes its queue slot: `originalCombinedIdx` comes from the
   *  occurrence list, never from the filtered row array. */
  function sectionItems(ids: string[], section: 'user' | 'auto', base: number): KeyedTrack[] {
    return sectionOccurrences(ids, section).flatMap((occurrence, i) => {
      const track = trackMap.get(occurrence.trackId)
      if (!track) return []
      return [{
        key: rowKeyOf(section, occurrence.trackId, occurrence.ordinal),
        entryId: entryIdOf(section, occurrence.trackId, occurrence.ordinal),
        track,
        originalCombinedIdx: base + i,
      }]
    })
  }

  let userItems = $derived(sectionItems($queue.userQueue, 'user', 0))
  let autoItems = $derived(sectionItems($queue.autoQueue, 'auto', $queue.userQueue.length))

  // Drag Engine State
  let listContainerEl = $state<HTMLElement | null>(null)

  let jumpScrollPending = $state(false)
  let jumpBoundaryPending = $state(false)

  function jumpToCurrent() {
    // Under the virtual windows the current row may be OUTSIDE the mounted
    // set — the old querySelector-only jump silently did nothing (pre-window
    // every row existed). Two steps, the SongsView pattern: write the
    // section-offset scrollTop so the row mounts by derivation, then let
    // the pending effect smooth-center it. The section geometry reads are
    // the SAME group-offset queries the window compute uses.
    const el = listContainerEl
    const idx = $queue.activeIndex
    const id = $currentTrack?.trackId
    if (!el || idx < 0 || !id) {
      jumpScrollPending = true
      return
    }
    if (el.querySelector(`[data-track-id="${CSS.escape(id)}"]`)) {
      jumpScrollPending = true
      return
    }
    const U = previewUserItems.length
    const inUser = idx < U
    const group = el.querySelector<HTMLElement>(inUser ? '[aria-label="User queue"]' : '[aria-label="Auto queue"]')
    const groupTop = group ? group.offsetTop : 44
    const sectionIdx = inUser ? idx : idx - U
    el.scrollTop = Math.max(0, groupTop + sectionIdx * queueRowH + queueRowH / 2 - el.clientHeight / 2)
    queueMachine.deriveNow()
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
  // Drag identity is the OCCURRENCE, not an id and not an index (2026-09-12
  // for the index half; 2026-10-21 for the occurrence half). An advance,
  // promotion, or fill re-rank landing mid-drag reindexes the combined list,
  // so a start-of-drag index can point at a different row by the time the
  // finger lifts; with duplicates an id names two rows, so it cannot say
  // WHICH one the user grabbed (G5). The entry id (`user:x`, `user:x#1`, …)
  // names exactly one row. The drag-time sections are snapshotted and the
  // drop is resolved against them + the CURRENT store by occurrence counts.
  let draggedEntryId = $state<string | null>(null)
  let targetCombinedIndex = $state<number | null>(null)
  let liveDragUserIds = $state<string[]>([])
  let liveDragAutoIds = $state<string[]>([])

  let pointerX = $state(0)
  let pointerY = $state(0)
  let dragProxyWidth = $state(320)
  let dragOffsetX = $state(0)
  let dragOffsetY = $state(0)

  let autoScrollFrameId: number | null = null

  // Preview + drop share ONE transform (planDragDrop): the dragged row is
  // re-resolved BY ID in the drag-time arrays on every evaluation, so the
  // preview re-resolves if the underlying arrays change instead of freezing
  // a start-of-drag index snapshot.
  let draggedCombinedIdxLive = $derived.by(() => {
    if (draggedEntryId === null) return -1
    return findEntryIndex(liveDragUserIds, liveDragAutoIds, draggedEntryId)
  })

  let dragPlan = $derived.by(() => {
    if (!isDragging || draggedEntryId === null || targetCombinedIndex === null || draggedCombinedIdxLive < 0) {
      return null
    }
    return planDragDrop(liveDragUserIds, liveDragAutoIds, draggedCombinedIdxLive, targetCombinedIndex)
  })

  // Preview rows during a drag (the plan's target space), live rows otherwise.
  // Keys are occurrence-scoped and position-free: a row's Svelte identity
  // survives every advance/promotion/fill rewrite that keeps its place among
  // same-id copies (the 2026-09-23 churn lesson), and two copies of one song
  // get distinct keys (D4). The ordinal changes only when a same-id copy
  // ABOVE the row is added or removed — exactly when the row's copy is a
  // different one.
  let previewUserItems = $derived.by<KeyedTrack[]>(() => {
    if (!dragPlan) return userItems
    return sectionItems(dragPlan.user, 'user', 0)
  })

  let previewAutoItems = $derived.by<KeyedTrack[]>(() => {
    if (!dragPlan) return autoItems
    return sectionItems(dragPlan.auto, 'auto', dragPlan.user.length)
  })

  let draggedTrack = $derived.by(() => {
    if (!draggedEntryId) return null
    return [...userItems, ...autoItems].find((i) => i.entryId === draggedEntryId)?.track ?? null
  })

  // ── Virtual windows (2026-09-28; the SongsView model, per section) ──
  // The queue can flood to 500+ rows (Play All); each section renders a
  // ~30-row window between row spacers, so the flood costs a bounded DOM.
  // DRAG-SAFETY: the drag engine never depends on what is MOUNTED — the
  // drop target is a section-space INDEX resolved from the pointer (see
  // updateTargetFromPointer), and `applyDragDrop` plans against the
  // drag-time ID snapshot, so rows outside the window behave exactly like
  // rows the user cannot see: real, ordered, droppable-onto.
  //
  // ONE shared machine drives BOTH sections (single throttle/save/derive per
  // scroll event): the window state is the PAIR, the compute closure is the
  // existing two-section cut over the DOM-measured group offsets, and the
  // row-height EMA folds one `.queue-track-item` per derive (shared holder —
  // both sections read the same queueRowH).
  let userWin = $state({ start: 0, end: 0 })
  let autoWin = $state({ start: 0, end: 0 })
  let queueRowH = $state(ESTIMATED_ROW_H)

  let mountedUserItems = $derived(previewUserItems.slice(userWin.start, userWin.end))
  let mountedAutoItems = $derived(previewAutoItems.slice(autoWin.start, autoWin.end))
  let userTopPad = $derived(startOffsetPx(userWin.start, queueRowH))
  let userBottomPad = $derived(endOffsetPx(previewUserItems.length, userWin.end, queueRowH))
  let autoTopPad = $derived(startOffsetPx(autoWin.start, queueRowH))
  let autoBottomPad = $derived(endOffsetPx(previewAutoItems.length, autoWin.end, queueRowH))

  const queueMachine = createScrollWindow<{ user: { start: number; end: number }; auto: { start: number; end: number } }>({
    // The restore gate keys on ANY content (either section rendering).
    getTotal: () => previewUserItems.length + previewAutoItems.length,
    getViewport: () => listContainerEl,
    getWindow: () => ({ user: userWin, auto: autoWin }),
    setWindow: (w) => {
      userWin = w.user
      autoWin = w.auto
    },
    getRowH: () => queueRowH,
    setRowH: (h) => {
      queueRowH = h
    },
    compute: ({ scrollTop, viewportH, rowH }) => {
      const el = listContainerEl
      if (!el) return { user: userWin, auto: autoWin }
      const scrollBottom = scrollTop + viewportH
      // Section offsets in the scroll coordinate space: user header (~30px)
      // + user list, then wrap notice + auto header. Measured live from the
      // section groups when mounted; estimated while the other section is
      // empty/collapsed.
      const userGroup = el.querySelector<HTMLElement>('[aria-label="User queue"]')
      const autoGroup = el.querySelector<HTMLElement>('[aria-label="Auto queue"]')
      const userTop = userGroup ? userGroup.offsetTop : 44
      const autoTop = autoGroup ? autoGroup.offsetTop : userTop + previewUserItems.length * rowH + 44
      const U = previewUserItems.length
      const A = previewAutoItems.length
      // USER window: rows overlap [scrollTop − OVERSCAN_ROWS, scrollBottom
      // + OVERSCAN_ROWS] (the shared constant — the 2026-09-29 buffer
      // widening applies to the queue too). The START is upper-clamped to
      // the section length (the grids' tail-clamp rule): scrolled PAST the
      // section, the window is EMPTY and the pad is the full section height
      // — never an inverted window (start > U) whose start-pad claims rows
      // that do not exist. The unclamped cut made scrollHeight grow with
      // scroll depth; with scroll anchoring now really off (app.css), a
      // clamped fling landing could point at the phantom empty space with
      // nothing left to re-pin it (2026-09-28 adversarial review, the
      // near=0 queue-band failure).
      const uStart = Math.min(Math.max(0, Math.floor(Math.max(0, scrollTop - userTop) / rowH) - OVERSCAN_ROWS), U)
      const uEnd = U === 0 ? 0 : Math.max(uStart, Math.min(U, Math.ceil((scrollBottom - userTop) / rowH) + OVERSCAN_ROWS))
      // AUTO window: same cut against the auto group's offset (same clamp).
      const aStart = Math.min(Math.max(0, Math.floor(Math.max(0, scrollTop - autoTop) / rowH) - OVERSCAN_ROWS), A)
      const aEnd = A === 0 ? 0 : Math.max(aStart, Math.min(A, Math.ceil((scrollBottom - autoTop) / rowH) + OVERSCAN_ROWS))
      return { user: { start: uStart, end: uEnd }, auto: { start: aStart, end: aEnd } }
    },
    measure: firstRowMeasure('.queue-track-item'),
    viewKey: 'queue',
    scrollTopField: 'scrollTop',
  })

  $effect(() => {
    void previewUserItems
    void previewAutoItems
    void listContainerEl
    queueMachine.deriveNow()
    queueMachine.restoreIfReady()
  })

  let isConvertingUserToAuto = $derived(
    isDragging &&
    draggedCombinedIdxLive >= 0 &&
    draggedCombinedIdxLive < liveDragUserIds.length &&
    targetCombinedIndex !== null &&
    targetCombinedIndex > liveDragUserIds.length
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

  /** Ambient left-to-right fill for a queue row: a linear-gradient layer over
   *  the row's own background (no extra element, no stacking fights). Every
   *  row with a load-status entry tints — not only the upcoming window — so
   *  a played row that re-enters the window shows its true (refreshed) state
   *  instead of looking resurrected. Stale entries can't haunt past rows:
   *  the manager evicts the previous track's entry on every native track
   *  change, and the web preloader evicts by URL. Monotonic ladder (review
   *  2026-09-11 — "darker → more tinted as the download completes", never
   *  inverted), PRELOAD range pushed darker overall with the ramp made more
   *  pronounced (second review pass: 2% → 9%, cached ceiling 9% — the
   *  progress must READ, not whisper):
   *    fetching partial: 2% → 9% mix AND the fill's extent grows with byte
   *    progress; cached: 9% full wash (the partial's ceiling); the CURRENT
   *    row (.ui-now-playing-row, 11% + edge) sits above all preloads.
   *  Browsers without color-mix drop the background-image and show no wash. */
  function preloadTint(trackId: string): string | undefined {
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

    // The drop target is the rows' TRUE combined index, read from
    // `data-combined-index` — NEVER the positional loop index. Under the
    // virtual windows the mounted set is a ~13-row slice: at rest the first
    // mounted row is userWin.start, mid-drag it is the plan preview's row 0
    // (the template computes the attribute the same way the preview does),
    // so positional indexing dropped rows windowStart slots too high (the
    // 2026-09-28 adversarial review catch). "Past the last mounted row"
    // defaults to the end of the PREVIEW space (the plan preserves the total
    // count, so preview-end == combined-end in both spaces).
    let target = previewUserItems.length + previewAutoItems.length
    for (const item of items) {
      const rect = item.getBoundingClientRect()
      const midY = rect.top + rect.height / 2
      if (y < midY) {
        const idx = Number(item.dataset.combinedIndex)
        target = Number.isFinite(idx) ? idx : target
        break
      }
    }
    targetCombinedIndex = target
  }

  function startPointerDrag(e: PointerEvent, item: KeyedTrack) {
    if (e.button !== undefined && e.button !== 0) return

    e.preventDefault()
    e.stopPropagation()

    isDragging = true
    // The row's OCCURRENCE identity (D4/D11) — not its id (two copies share
    // one) and not its index (mid-drag mutations reindex the real lists).
    draggedEntryId = item.entryId
    targetCombinedIndex = item.originalCombinedIdx
    // Drag-time section snapshot: the preview and the drop both plan against
    // these, with the dragged occurrence re-resolved live by entry id.
    liveDragUserIds = $queue.userQueue.slice()
    liveDragAutoIds = $queue.autoQueue.slice()

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
    if (!isDragging || draggedEntryId === null || targetCombinedIndex === null) {
      stopPointerDrag()
      return
    }

    // Resolve against the drag-time sections BY OCCURRENCE — the arrays that
    // produced the preview the user sees. queueManager.applyDragDrop recomputes
    // the shape from the CURRENT store by per-id occurrence counts
    // (mutation-race safe: an advance/promotion landing mid-drag can no longer
    // be overwritten by a stale snapshot) and no-ops when nothing changed.
    queueManager.applyDragDrop(draggedEntryId, targetCombinedIndex, liveDragUserIds, liveDragAutoIds)

    stopPointerDrag()
  }

  function stopPointerDrag() {
    isDragging = false
    draggedEntryId = null
    targetCombinedIndex = null
    liveDragUserIds = []
    liveDragAutoIds = []

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
  /** B5 scope pill label: "Album · <name>" / "Artist · <name>" (session-only). */
  const scopeLabel = derived(autoQueueScope, (s) =>
    s.albumScope ? `Album · ${s.albumScope}` : s.artistScope ? `Artist · ${s.artistScope}` : null,
  )

  /** Removes exactly the row that was pressed — never `indexOf(trackId)`.
   *  With duplicates an id names several rows, so the ROW's combined index is
   *  the only safe target (D4). */
  function removeRow(item: KeyedTrack) {
    if (isDragging) return
    const idx = item.originalCombinedIdx
    if (idx < $queue.userQueue.length) {
      // Removing the PLAYING row skips to the next track immediately (2.4/2.7).
      // With duplicates the id is ambiguous, so the ROW fact is captured
      // before the write: only the active row's own removal is a skip
      // (removing another copy of the audible song must not skip it).
      const removedWasActive = idx === $queue.activeIndex
      const removedId = queueManager.removeFromUserQueue(idx)
      if (removedId !== undefined) playbackManager.handleQueueRowRemoved(removedId, removedWasActive)
      return
    }
    queueManager.removeFromAutoQueue(idx - $queue.userQueue.length)
  }

  /** Section-local index of a queue row (user rows map 1:1, auto rows are
   *  offset by the user length). */
  function autoIndexOf(item: KeyedTrack): number {
    return item.originalCombinedIdx - $queue.userQueue.length
  }

  function isCurrentTrack(currentCombinedIdx: number): boolean {
    if ($queue.activeIndex < 0) return false
    return currentCombinedIdx === $queue.activeIndex
  }

  /** Plays the pressed ROW (by combined index). Pressing the audible row
   *  restarts it; every other row is a positional play. Occurrence identity
   *  makes this exact even when several rows share a track id. */
  function playQueueItem(currentCombinedIdx: number) {
    if (isDragging) return
    const id = combinedIds[currentCombinedIdx]
    if (id === undefined) return
    const isAudible = currentCombinedIdx === $queue.activeIndex
      && $currentTrack?.trackId === id
      && $playbackState !== 'stopped'
    if (isAudible) playbackManager.seek(0)
    else playbackManager.playTrackAt(currentCombinedIdx)
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

<!-- Root is the positioning context for the scroll-top button (the scroll
     container itself is not relative, so the button's bottom-* utilities
     resolve against THIS box — bottom-6 lands above the in-flow action
     island, never on top of it; iOS review 2026-09-11). -->
<div class="relative flex h-full flex-col bg-background select-none">
  <!-- Header --><!-- py-0.5 + p-2 keeps the bar's total height at the
       original 52px despite the larger 28px glyphs (review 2026-09-11). -->
  <div class="grid grid-cols-3 items-center border-b border-white/10 px-4 py-0.5">
    <div class="flex items-center gap-1">
      <button use:tooltip onclick={oncloseall} class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Library">
        <svg class="h-7 w-7" viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" /></svg>
      </button>
      <button use:tooltip onclick={onclose} class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Close queue">
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
            loadedFraction={currentLoadedFraction($preloadEntries[$currentTrack?.trackId ?? ''])}
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
            use:tooltip
            onclick={() => toggleShuffle()}
            class="absolute left-0 top-1/2 -translate-y-1/2 rounded-full p-2.5 transition-colors"
            class:text-accent={$shuffleEnabled}
            class:text-muted={!$shuffleEnabled}
            aria-label="Toggle shuffle"
          >
            <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>
          </button>

          <div class="flex items-center justify-center gap-1.5">
            <button use:tooltip class="rounded-full p-2.5 text-muted transition-colors hover:text-primary" aria-label="Previous track" onclick={() => playbackManager.prev()}>
              <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
            </button>

            <button use:tooltip class="rounded-full p-2.5 text-muted transition-colors hover:text-primary" aria-label="Play / Pause" onclick={() => playbackManager.togglePlayPause()}>
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

            <button use:tooltip class="rounded-full p-2.5 text-muted transition-colors hover:text-primary" aria-label="Next track" onclick={() => playbackManager.next()}>
              <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z"/></svg>
            </button>
          </div>
        </div>
      </div>
    {:else}
      <!-- Empty island: same silhouette as the home mini-player's empty
           state so the two surfaces read as one design. Tappable like the
           active island — closing lands on the expanded Now Playing view
           (closeQueue opens it whenever a current track exists, even
           stopped after a play-out). -->
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
      <div
        class="ui-island flex cursor-pointer items-center gap-3 px-3 py-2.5"
        role="button"
        tabindex="0"
        onclick={onclose}
        onkeydown={(e) => { if (e.key === 'Enter') onclose() }}
      >
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
  <div bind:this={listContainerEl} class="min-h-0 flex-1 overflow-y-auto overflow-anchor-none pb-2 touch-pan-y" onscroll={queueMachine.onScroll}>
    <!-- bottom-24 against the ROOT (this container isn't relative): the
         island stack on iOS = safe-area inset (~34) + wrapper pad + island
         (~54) ≈ 92px — bottom-16 (64px) landed INSIDE it, which is exactly
         the "top button halfway under the island" report. 96px clears both
         platforms; web (~62px island) floats ~34px above it.
         (iOS review 2026-09-11). -->
    <ScrollTopButton target={listContainerEl} posClass="bottom-24 right-4" />
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
        <div style="height:{userTopPad}px" aria-hidden="true"></div>
        {#each mountedUserItems as item (item.key)}
          <!-- The combined index is a property of the item's DATA (stamped
               when the preview arrays are built, preserved through slice)
               — never of its mount position. The old `userWin.start + …`
               double-counted the window offset and corrupted EVERY
               consumer at once: play (taps hit playTrackAt's bounds guard
               or played the wrong row), the now-playing indicator, the
               drag drop-target, and the drag identity. -->
          {@const itemIndex = item.originalCombinedIdx}
          <div
            onclick={() => playQueueItem(itemIndex)}
            role="button"
            tabindex="0"
            onkeydown={(e) => { if (e.key === 'Enter') playQueueItem(itemIndex) }}
            class={"queue-track-item flex cursor-pointer items-center gap-1.5 rounded-lg py-2 pl-1.5 pr-1 transition-colors " +
              (isCurrentTrack(itemIndex) ? 'ui-now-playing-row ' : 'hover:bg-white/5 ') +
              (isDragging && item.entryId === draggedEntryId ? 'opacity-30 ring-1 ring-accent-ring bg-accent-soft ' : '')
            }
            style={preloadTint(item.track.trackId)}
            data-combined-index={itemIndex}
            data-track-id={item.track.trackId}
            data-entry-id={item.entryId}
          >
            <!-- Drag Handle -->
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div
              class="drag-handle touch-none flex-shrink-0 cursor-grab active:cursor-grabbing rounded py-1 pl-1 pr-0.5 text-muted/60 transition-colors hover:text-muted hover:bg-surface-hover"
              aria-label="Drag to reorder"
              onclick={(e) => e.stopPropagation()}
              onpointerdown={(e) => startPointerDrag(e, item)}
              role="presentation"
            >
              <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/>
              </svg>
            </div>

            <LazyThumb track={item.track} size={128} windowed wrapperClass="h-10 w-10 flex-shrink-0 rounded" />

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
                onclick={() => queueManager.moveRowToNext(itemIndex)}
                class="rounded-lg p-2 text-muted/70 transition-colors hover:text-green-400"
                aria-label="Move to next"
              >
                <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z"/>
                </svg>
              </button>
              <button
                onclick={() => queueManager.moveRowToEnd(itemIndex)}
                class="rounded-lg p-2 text-muted/70 transition-colors hover:text-green-400"
                aria-label="Move to end"
              >
                <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M7 13l5 5 5-5"/>
                  <path d="M7 6l5 5 5-5"/>
                </svg>
              </button>
              <button
                onclick={() => removeRow(item)}
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
        <div style="height:{userBottomPad}px" aria-hidden="true"></div>
      </div>
    {/if}

    <!-- ── Boundary ── the user/auto seam is now the line under the "Up next"
         header; the old separator row between the sections is gone. The
         jump-to-boundary scroll target rides the AUTO header (the first auto
         row is the boundary), and the drag-over-seam conversion banner lives
         there too so the seam affordance survives without a dedicated row. -->

    <!-- D9: the auto queue's own switch. It is mirrored here (next to the
         section it controls) and is the ONLY place it is offered, so the
         section and its control can never drift onto different screens. Off
         renders the quiet state, NOT the filter warning: "nothing matches" and
         "you turned suggestions off" are different facts. -->
    {#if $queue.userQueue.length > 0}
      <div class="mx-4 mb-1 flex items-center gap-2 px-1" role="group" aria-label="Auto queue settings">
        <span class="text-[11px] font-semibold uppercase tracking-widest {$autoQueueEnabled ? 'text-muted/70' : 'text-muted'}">
          {$autoQueueEnabled ? 'Suggestions on' : 'Auto queue off'}
        </span>
        <div class="h-0.5 flex-1 rounded-full bg-white/15"></div>
        <button
          type="button"
          class="rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors {$autoQueueEnabled ? 'bg-white/10 text-muted hover:text-primary' : 'bg-accent-soft text-accent hover:bg-accent-ring/30'}"
          aria-pressed={$autoQueueEnabled}
          onclick={() => queueManager.setAutoQueueEnabled(!$autoQueueEnabled)}
          data-testid="toggle-auto-queue"
        >{$autoQueueEnabled ? 'Turn off' : 'Turn on'}</button>
      </div>
    {/if}

    {#if $queueWrapNotice && previewAutoItems.length > 0}
      <p class="mx-4 mb-1 text-center text-[11px] text-muted/60">Continuing from the top of the sort order</p>
    {/if}

    {#if $autoQueueEmptyNotice && $autoQueueEnabled}
      <!-- B5: with an album/artist scope an exhausted pool is the scope's natural
           end, not a filter problem — yellow would read as a warning. The label
           names the scope so the source stays visible without auto rows. -->
      {#if $scopeLabel}
        <p class="mx-4 mb-1 text-center text-[11px] text-muted/60">End of {$scopeLabel}</p>
      {:else}
        <p class="mx-4 mb-1 text-center text-[11px] text-yellow-500/80">Auto queue is empty — nothing left to add from the current filters</p>
      {/if}
    {/if}

    <!-- === AUTO QUEUE === -->
    {#if previewAutoItems.length > 0}
      <div class="mx-4 mb-1 flex items-center gap-2 px-1" role="heading" aria-level="2" data-boundary>
        <span class="text-[11px] font-semibold uppercase tracking-widest" class:text-accent={isConvertingUserToAuto} class:text-muted={!isConvertingUserToAuto}>Auto</span>
        <span class="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted">{previewAutoItems.length}</span>
        {#if $scopeLabel}
          <!-- B5: persistent scope indicator — the auto queue draws from this
               album/artist only; truncation-safe (names can be long). -->
          <span class="max-w-[45%] truncate rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-primary" title={$scopeLabel}>{$scopeLabel}</span>
        {/if}
        <div class="h-0.5 flex-1 rounded-full bg-white/25"></div>
        {#if isConvertingUserToAuto}
          <span class="text-xs font-medium uppercase tracking-wider text-accent">Release to convert to User Queue</span>
        {/if}
      </div>
      <div class="mx-2 space-y-0.5" role="group" aria-label="Auto queue">
        <div style="height:{autoTopPad}px" aria-hidden="true"></div>
        {#each mountedAutoItems as item (item.key)}
          <!-- Same data-stamped index as the user section (it already
               includes the user length); no window offset may be added. -->
          {@const itemCombinedIndex = item.originalCombinedIdx}
          <div
            onclick={() => playQueueItem(itemCombinedIndex)}
            role="button"
            tabindex="0"
            onkeydown={(e) => { if (e.key === 'Enter') playQueueItem(itemCombinedIndex) }}
            class={"queue-track-item flex cursor-pointer items-center gap-1.5 rounded-lg py-2 pl-1.5 pr-1 transition-colors " +
              (isCurrentTrack(itemCombinedIndex) ? 'bg-white/10 ' : 'hover:bg-white/5 ') +
              (isDragging && item.entryId === draggedEntryId ? 'opacity-30 ring-1 ring-accent-ring bg-accent-soft ' : '')
            }
            style={preloadTint(item.track.trackId)}
            data-combined-index={itemCombinedIndex}
            data-track-id={item.track.trackId}
            data-entry-id={item.entryId}
          >
            <!-- Drag Handle -->
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div
              class="drag-handle touch-none flex-shrink-0 cursor-grab active:cursor-grabbing rounded py-1 pl-1 pr-0.5 text-muted/60 transition-colors hover:text-muted hover:bg-surface-hover"
              aria-label="Drag to reorder"
              onclick={(e) => e.stopPropagation()}
              onpointerdown={(e) => startPointerDrag(e, item)}
              role="presentation"
            >
              <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/>
              </svg>
            </div>

            <LazyThumb track={item.track} size={128} windowed wrapperClass="h-10 w-10 flex-shrink-0 rounded" />

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
                onclick={() => queueManager.promoteToUserNext(autoIndexOf(item))}
                class="rounded-lg p-2 text-muted/70 transition-colors hover:text-green-400"
                aria-label="Play next"
              >
                <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z"/>
                </svg>
              </button>
              <button
                onclick={() => queueManager.promoteToUser(autoIndexOf(item))}
                class="rounded-lg p-2 text-muted/70 transition-colors hover:text-green-400"
                aria-label="Add to user queue"
              >
                <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                </svg>
              </button>
              <button
                onclick={() => removeRow(item)}
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
        <div style="height:{autoBottomPad}px" aria-hidden="true"></div>
      </div>
    {:else if previewUserItems.length > 0 && $autoQueueEnabled}
      <!-- D9: an OFF auto queue is not an empty one — the switch row above
           already says "Auto queue off", and stacking an empty-section line on
           top of it reads as a fault. -->
      <p class="px-6 py-4 text-center text-sm text-muted/50">Auto queue is empty</p>
    {/if}

    <!-- End-of-queue terminus: extra scroll length past the last row so the
         ↑ button (or a thumb resting near the list bottom) never covers the
         final rows (review 2026-09-11). -->
    {#if combinedIds.length > 0}
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
        use:tooltip
        onclick={jumpToCurrent}
        disabled={!$currentTrack}
        class="flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5 text-muted ring-1 ring-white/10 transition-colors hover:bg-accent-soft hover:text-accent disabled:opacity-30"
        aria-label="Jump to currently playing track"
      >
        <svg class="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 18a8 8 0 110-16 8 8 0 010 16zm-1-13v5.59l3.95 3.95 1.41-1.41L13 11.17V7h-2z"/></svg>
        <span class="w-full truncate text-center text-[10px] font-medium leading-none">Current</span>
      </button>
      <button
        use:tooltip
        onclick={jumpToBoundary}
        disabled={$queue.userQueue.length === 0 || previewAutoItems.length === 0}
        class="flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5 text-muted ring-1 ring-white/10 transition-colors hover:bg-accent-soft hover:text-accent disabled:opacity-30"
        aria-label="Jump to the user and auto queue boundary"
      >
        <svg class="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
        <span class="w-full truncate text-center text-[10px] font-medium leading-none">Boundary</span>
      </button>
      <button
        use:tooltip
        onclick={() => filterOpen = !filterOpen}
        class={"flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5 transition-colors hover:bg-accent-soft hover:text-accent " + (filterOpen ? 'chip-on' : 'text-muted ring-1 ring-white/10')}
        aria-label="Auto queue filters"
        aria-expanded={filterOpen}
      >
        <svg class="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/></svg>
        <span class="w-full truncate text-center text-[10px] font-medium leading-none">Filters</span>
      </button>
      <button
        use:tooltip
        onclick={clearAbove}
        disabled={aboveCount === 0}
        class="flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5 text-muted ring-1 ring-white/10 transition-colors hover:bg-accent-soft hover:text-accent disabled:opacity-30 disabled:hover:bg-transparent"
        aria-label={`Clear ${aboveCount} played track${aboveCount === 1 ? '' : 's'} above the current song`}
      >
        <svg class="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 15.41 12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>
        <span class="w-full truncate text-center text-[10px] font-medium leading-none">Clear above{#if aboveCount > 0}&nbsp;{aboveCount}{/if}</span>
      </button>
      <button
        use:tooltip
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
        <!-- Auto-queue SORT (2026-09-29, restyled same day after user
             feedback): the fill follows its own sort now; edited here like
             the library sort menu. A bordered card so the section reads as
             its own control, not one more filter blob; re-tapping the
             active key flips direction (the library menu's contract — the
             separate Reverse-direction button was clutter and is gone).
             ALWAYS rendered since 2026-10-24 (user decision — the old
             `{#if !$shuffleEnabled}` gate made a persisted setting look
             missing); shuffle only changes how the pool is sampled, never
             what this editor shows. -->
        <div class="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5">
          <span class="text-sm font-medium text-muted">Sort order</span>
          <div class="mt-1.5 space-y-0.5">
            {#each ['rating', 'loved', 'year', 'length', 'added'] as key (key)}
              {@const k = key as LibrarySortKey}
              <button
                onclick={() => setAutoSort(k)}
                class="flex w-full items-center justify-between rounded px-2 py-1.5 text-sm transition-colors"
                class:bg-surface-hover={$autoQueueSort.sortBy === k}
                class:text-primary={$autoQueueSort.sortBy === k}
                class:text-muted={$autoQueueSort.sortBy !== k}
              >
                <span>{sortLabels[k]}</span>
                {#if $autoQueueSort.sortBy === k}
                  <span class="text-accent">{$autoQueueSort.sortAsc ? '↑' : '↓'}</span>
                {/if}
              </button>
            {/each}
            {#if $autoQueueSort.sortBy}
              <button
                onclick={() => setAutoSort(null)}
                class="mt-1 w-full rounded-t-none border-t border-white/5 px-2 py-1.5 text-xs text-muted transition-colors hover:text-primary"
              >Clear sort</button>
            {/if}
          </div>
        </div>
        <div>
          <span class="text-sm font-medium text-muted">Search Query</span>
          <div class="mt-1">
            <ClearableSearch
              value={$autoQueueFilterFields.searchQuery ?? ''}
              placeholder="Fuzzy search title, artist, album..."
              onInput={(v) => setFilter('searchQuery', v)}
              class="rounded bg-surface-hover px-2 py-1 pr-8 text-sm text-primary ring-1 ring-white/10 placeholder-muted outline-none focus:ring-accent-ring"
            />
          </div>
        </div>

        <div>
          <span class="text-sm font-medium text-muted">Rating range</span>
          <div class="mt-1 flex items-center gap-2">
            <AppSlider value={$autoQueueFilterFields.minRating} min={0} max={100} step={10} label="Minimum rating" onInput={(v) => setFilter('minRating', v)} class="w-20 shrink" />
            <input data-testid="min-rating" type="number" min="0" max="100" value={$autoQueueFilterFields.minRating} oninput={(e) => setFilter('minRating', ratingBound((e.target as HTMLInputElement).value, 0))} class="w-14 rounded bg-surface-hover px-2 py-1 text-sm text-primary ring-1 ring-white/10" />
            <span class="text-sm text-muted">–</span>
            <input data-testid="max-rating" type="number" min="0" max="100" value={$autoQueueFilterFields.maxRating} oninput={(e) => setFilter('maxRating', ratingBound((e.target as HTMLInputElement).value, 100))} class="w-14 rounded bg-surface-hover px-2 py-1 text-sm text-primary ring-1 ring-white/10" />
            <AppSlider value={$autoQueueFilterFields.maxRating} min={0} max={100} step={10} label="Maximum rating" onInput={(v) => setFilter('maxRating', v)} class="w-20 shrink" />
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

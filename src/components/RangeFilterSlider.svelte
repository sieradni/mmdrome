<script lang="ts">
  /**
   * Dual-handle range slider — the ONE numerical filter control (2026-11-03).
   *
   * Replaces the old pair of independent single-value `AppSlider`s (minimum and
   * maximum as separate tracks) for rating, year, length and date-added. Two
   * handles on ONE track show the selected band and the full domain at once,
   * which is the actual question a range filter asks ("where in the whole range
   * is my slice?"). Sized for touch: the root is 48 px tall and the handles
   * carry a 20 px disc with a bigger hover/drag state; the whole strip is
   * press-to-jump (SeekBar's pattern), picking the NEAREST handle.
   *
   * Handles can never cross: each one clamps at the other, and the parent
   * reducer (`filterCore.patchRangeClause`) never stores an inverted pair.
   *
   * Pointer state is LOCAL (`dragLo`/`dragHi`) so a fast drag never reads a
   * stale prop between the store write and the re-render; the props are the
   * committed value and re-sync when no gesture is active.
   *
   * Handle RESOLUTION lives in the pure `rangeSliderCore` (2026-11-14): a press
   * on two OVERLAPPING handles defers to the first movement, because a fixed
   * tie-break made a pair parked at the right edge impossible to drag down (the
   * press took the maximum, which is already clamped there).
   */
  import {
    applyHandleMove,
    pickDragHandle,
    resolvePendingHandle,
    type RangeHandle,
    type RangeHandlePick,
  } from '../lib/rangeSliderCore'

  interface Props {
    label: string
    min: number
    max: number
    step?: number
    valueMin: number
    valueMax: number
    format?: (v: number) => string
    disabled?: boolean
    /** Extra classes for the root. */
    class?: string
    onInput?: (min: number, max: number) => void
  }

  let {
    label,
    min,
    max,
    step = 1,
    valueMin,
    valueMax,
    format = (v: number) => String(v),
    disabled = false,
    class: className = '',
    onInput,
  }: Props = $props()

  let trackEl = $state<HTMLDivElement | null>(null)
  let dragging = $state<RangeHandlePick | null>(null)
  let dragLo = $state<number | null>(null)
  let dragHi = $state<number | null>(null)

  const safeMax = $derived(max > min ? max : min + 1)
  const committedLo = $derived(clamp(valueMin))
  const committedHi = $derived(clamp(valueMax))
  const lo = $derived(dragLo ?? Math.min(committedLo, committedHi))
  const hi = $derived(dragHi ?? Math.max(committedLo, committedHi))
  const loPct = $derived(((lo - min) / (safeMax - min)) * 100)
  const hiPct = $derived(((hi - min) / (safeMax - min)) * 100)

  function clamp(v: number): number {
    return Math.min(safeMax, Math.max(min, Number.isFinite(v) ? v : min))
  }

  function snap(raw: number): number {
    const stepped = Math.round((raw - min) / step) * step + min
    return clamp(Number(stepped.toFixed(6)))
  }

  function valueFromClientX(clientX: number): number {
    if (!trackEl) return lo
    const rect = trackEl.getBoundingClientRect()
    if (rect.width <= 0) return lo
    const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1)
    return snap(min + ratio * (safeMax - min))
  }

  function emit(nextLo: number, nextHi: number): void {
    dragLo = nextLo
    dragHi = nextHi
    onInput?.(nextLo, nextHi)
  }

  function handlePointerDown(e: PointerEvent): void {
    if (disabled) return
    e.preventDefault()
    const v = valueFromClientX(e.clientX)
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    const pick = pickDragHandle(v, lo, hi)
    dragging = pick
    // Overlapping handles: the gesture's first movement picks the side, so a
    // press ON the collapsed pair neither changes the band nor burns itself on
    // a guess (a fixed tie-break used to grab the maximum, which is exactly the
    // handle that cannot move off the right edge).
    if (pick === 'pending') return
    const [nextLo, nextHi] = applyHandleMove(pick, v, lo, hi)
    emit(nextLo, nextHi)
  }

  function handlePointerMove(e: PointerEvent): void {
    if (dragging === null || disabled) return
    const v = valueFromClientX(e.clientX)
    let which: RangeHandle
    if (dragging === 'pending') {
      const resolved = resolvePendingHandle(v, lo)
      if (resolved === null) return
      which = resolved
      dragging = resolved
    } else {
      which = dragging
    }
    const [nextLo, nextHi] = applyHandleMove(which, v, lo, hi)
    emit(nextLo, nextHi)
  }

  function handlePointerUp(e: PointerEvent): void {
    if (dragging === null) return
    handlePointerMove(e)
    dragging = null
    dragLo = null
    dragHi = null
  }

  // Keyboard edits write the committed value and never leave a local drag
  // state behind: `dragLo/dragHi` are for a POINTER gesture, and parking them
  // here would make every later prop change (a preset apply, a reset) invisible
  // to the slider.
  function nudge(which: 0 | 1, dir: 1 | -1, multiplier = 1): void {
    if (disabled) return
    const delta = dir * step * multiplier
    // Clamp against the OTHER handle, not just the domain: a keyboard nudge
    // while the handles touch must be a no-op, never store min > max (the
    // pointer paths already clamp the same way).
    if (which === 0) onInput?.(Math.min(clamp(lo + delta), hi), hi)
    else onInput?.(lo, Math.max(clamp(hi + delta), lo))
  }

  function edge(which: 0 | 1, toMax: boolean): void {
    if (disabled) return
    if (which === 0) onInput?.(toMax ? hi : min, hi)
    else onInput?.(lo, toMax ? safeMax : lo)
  }

  function handleKeyDown(which: 0 | 1, e: KeyboardEvent): void {
    if (disabled) return
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        e.preventDefault()
        nudge(which, -1)
        break
      case 'ArrowRight':
      case 'ArrowUp':
        e.preventDefault()
        nudge(which, 1)
        break
      case 'PageDown':
        e.preventDefault()
        nudge(which, -1, 10)
        break
      case 'PageUp':
        e.preventDefault()
        nudge(which, 1, 10)
        break
      case 'Home':
        e.preventDefault()
        edge(which, false)
        break
      case 'End':
        e.preventDefault()
        edge(which, true)
        break
    }
  }

</script>

<div
  class="group w-full touch-none select-none outline-none {className}"
  class:opacity-40={disabled}
  class:pointer-events-none={disabled}
>
  <div class="flex items-center justify-between text-xs tabular-nums text-muted">
    <span class="rounded bg-white/5 px-1.5 py-0.5 text-primary">{format(lo)}</span>
    <span class="text-muted/50">–</span>
    <span class="rounded bg-white/5 px-1.5 py-0.5 text-primary">{format(hi)}</span>
  </div>

  <div
    role="group"
    aria-label={`${label} slider`}
    class="relative mt-1 flex h-12 cursor-pointer items-center"
    onpointerdown={handlePointerDown}
    onpointermove={handlePointerMove}
    onpointerup={handlePointerUp}
    onpointercancel={() => {
      dragging = null
      dragLo = null
      dragHi = null
    }}
  >
    <div
      bind:this={trackEl}
      class="relative h-2.5 w-full rounded-full bg-white/15 transition-[height] duration-150 group-hover:h-3"
      class:h-3={dragging !== null}
    >
      <!-- Selected band: solid accent between the handles. -->
      <div
        class="absolute inset-y-0 rounded-full bg-accent"
        style="left: {loPct}%; width: {Math.max(0, hiPct - loPct)}%;"
      ></div>

      <!-- Minimum handle -->
      <div
        role="slider"
        tabindex={disabled ? -1 : 0}
        aria-label={`${label} minimum`}
        aria-valuemin={min}
        aria-valuemax={hi}
        aria-valuenow={lo}
        aria-valuetext={format(lo)}
        aria-orientation="horizontal"
        class="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full bg-accent shadow-[0_0_0_1px_rgb(0_0_0/0.6)] ring-2 ring-[#0d0d0d] outline-none transition-[height,width] duration-100 hover:h-6 hover:w-6 focus-visible:ring-2 focus-visible:ring-accent"
        class:h-6={dragging === 0}
        class:w-6={dragging === 0}
        style="left: {loPct}%;"
        onkeydown={(e) => handleKeyDown(0, e)}
      ></div>

      <!-- Maximum handle -->
      <div
        role="slider"
        tabindex={disabled ? -1 : 0}
        aria-label={`${label} maximum`}
        aria-valuemin={lo}
        aria-valuemax={safeMax}
        aria-valuenow={hi}
        aria-valuetext={format(hi)}
        aria-orientation="horizontal"
        class="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full bg-accent shadow-[0_0_0_1px_rgb(0_0_0/0.6)] ring-2 ring-[#0d0d0d] outline-none transition-[height,width] duration-100 hover:h-6 hover:w-6 focus-visible:ring-2 focus-visible:ring-accent"
        class:h-6={dragging === 1}
        class:w-6={dragging === 1}
        style="left: {hiPct}%;"
        onkeydown={(e) => handleKeyDown(1, e)}
      ></div>
    </div>
  </div>
</div>

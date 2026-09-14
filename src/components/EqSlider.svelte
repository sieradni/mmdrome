<script lang="ts">
  /**
   * Custom vertical slider (SeekBar's pattern, rotated) — replaces
   * input[type=range] with writing-mode:vertical-lr in EQView.
   *
   * Why custom: Chromium anchors min at the TOP of a vertical-lr range
   * input unless direction:rtl is ALSO set (the "upside-down" fill bug —
   * values mapped correctly, the fill ran top-to-bottom), older iOS Safari
   * ignores writing-mode on range inputs entirely, and Firefox diverges
   * again. A pointer-driven bar with explicit geometry is device-stable by
   * construction — the same reasoning that built SeekBar.
   *
   * Conventions:
   *  - min sits at the BOTTOM (natural EQ orientation).
   *  - the fill grows FROM CENTER (0 dB) toward the thumb — boost fills up,
   *    cut fills down — matching the response graph. Range must be
   *    symmetric for the center to be 0; EQView always passes -12..12.
   *  - values are plain signed dB here (no inverted-sign convention — the
   *    caller owns any sign mapping).
   */

  interface Props {
    value: number
    min?: number
    max?: number
    step?: number
    disabled?: boolean
    label?: string
    /** Fired on press/release/keyboard and per pointermove during a drag. */
    onInput?: (value: number) => void
  }

  let { value, min = -12, max = 12, step = 0.5, disabled = false, label = 'EQ band', onInput }: Props = $props()

  let trackEl: HTMLDivElement | null = $state(null)
  let dragging = $state(false)
  let dragValue = $state(0)
  let lastTapTime = 0

  // While dragging the thumb follows the finger even if the store tick lags.
  const shown = $derived(dragging ? dragValue : Math.min(Math.max(value, min), max))
  /** Thumb position as a 0..1 ratio from the BOTTOM. */
  const ratio = $derived((shown - min) / (max - min))
  const thumbPct = $derived(ratio * 100)
  /** 0 dB position as a 0..1 ratio from the bottom (center of a symmetric range). */
  const centerRatio = $derived((0 - min) / (max - min))
  /** Fill spans from the 0 dB line to the thumb. */
  const fillBottomPct = $derived(Math.min(ratio, centerRatio) * 100)
  const fillHeightPct = $derived(Math.abs(ratio - centerRatio) * 100)

  function snap(raw: number): number {
    const snapped = Math.round((raw - min) / step) * step + min
    return Math.min(Math.max(snapped, min), max)
  }

  function valueFromClientY(clientY: number): number {
    if (!trackEl) return shown
    const rect = trackEl.getBoundingClientRect()
    if (rect.height <= 0) return shown
    const ratioFromBottom = 1 - (clientY - rect.top) / rect.height
    return snap(min + Math.min(Math.max(ratioFromBottom, 0), 1) * (max - min))
  }

  function handlePointerDown(e: PointerEvent): void {
    if (disabled) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    // Double-tap anywhere on the band → snap to 0 dB (the common reset).
    const now = Date.now()
    if (now - lastTapTime < 300) {
      dragValue = 0
      lastTapTime = 0
      onInput?.(0)
      return
    }
    lastTapTime = now
    dragging = true
    dragValue = valueFromClientY(e.clientY)
    onInput?.(dragValue)
  }

  function handlePointerMove(e: PointerEvent): void {
    if (!dragging || disabled) return
    dragValue = valueFromClientY(e.clientY)
    onInput?.(dragValue)
  }

  function handlePointerUp(e: PointerEvent): void {
    if (!dragging) return
    dragValue = valueFromClientY(e.clientY)
    onInput?.(dragValue)
    dragging = false
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (disabled) return
    const coarse = e.key === 'PageUp' || e.key === 'PageDown' ? 3 : step
    if (e.key === 'ArrowDown' || e.key === 'PageDown') {
      e.preventDefault()
      onInput?.(snap(shown - coarse))
    } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
      e.preventDefault()
      onInput?.(snap(shown + coarse))
    } else if (e.key === 'Home') {
      e.preventDefault()
      onInput?.(min)
    } else if (e.key === 'End') {
      e.preventDefault()
      onInput?.(max)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onInput?.(0)
    }
  }

  function formatDb(v: number): string {
    return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
  }
</script>

<div
  role="slider"
  tabindex={disabled ? -1 : 0}
  aria-label={label}
  aria-orientation="vertical"
  aria-valuemin={min}
  aria-valuemax={max}
  aria-valuenow={shown}
  aria-valuetext={formatDb(shown)}
  aria-disabled={disabled}
  class="group relative h-full w-full cursor-pointer touch-none outline-none"
  class:opacity-40={disabled}
  class:pointer-events-none={disabled}
  onpointerdown={handlePointerDown}
  onpointermove={handlePointerMove}
  onpointerup={handlePointerUp}
  onpointercancel={() => {
    dragging = false
  }}
  onkeydown={handleKeyDown}
>
  <!-- Track: 4px bar centered in the column, full height -->
  <div
    bind:this={trackEl}
    class="absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 rounded-full bg-white/10"
  >
    <!-- Fill from the 0 dB line toward the thumb -->
    <div
      class="absolute left-0 w-full rounded-full bg-accent"
      style="bottom: {fillBottomPct}%; height: {fillHeightPct}%;"
      aria-hidden="true"
    ></div>
  </div>

  <!-- 0 dB tick line -->
  <div
    class="pointer-events-none absolute left-1/2 h-px w-3 -translate-x-1/2 bg-white/25"
    style="bottom: {centerRatio * 100}%;"
    aria-hidden="true"
  ></div>

  <!-- Thumb: rides the same geometry as the track (left-1/2 + w-1) so it
       can never drift from the fill; enlarges on hover/drag -->
  <div
    class="pointer-events-none absolute left-1/2 h-3.5 w-3.5 -translate-x-1/2 translate-y-1/2 rounded-full bg-accent shadow-[0_0_0_1px_rgb(0_0_0/0.6)] transition-[height,width] duration-100 group-hover:h-4 group-hover:w-4"
    class:h-4={dragging}
    class:w-4={dragging}
    style="bottom: {thumbPct}%;"
    aria-hidden="true"
  ></div>
</div>

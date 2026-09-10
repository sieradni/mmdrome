<script lang="ts">
  import { bufferedRangeFills, clampSeekTime, type BufferedRange } from '$lib/loadStatus'

  interface Props {
    /** Current playhead position in seconds. */
    value: number
    /** Track duration in seconds (A1 truth). */
    max: number
    /** Normalized buffered ranges — the gray layer. Empty = unknown. */
    buffered?: BufferedRange[]
    disabled?: boolean
    label?: string
    /** Spoken value, e.g. "1:23 of 5:00". */
    valueText?: string
    /** Fired live during drag/scrub (same cadence as the old range oninput). */
    onSeek?: (value: number) => void
  }

  let {
    value,
    max,
    buffered = [],
    disabled = false,
    label = 'Seek',
    valueText,
    onSeek,
  }: Props = $props()

  let trackEl: HTMLDivElement | null = $state(null)
  let dragging = $state(false)
  let dragValue = $state(0)

  const safeMax = $derived(max > 0 && isFinite(max) ? max : 1)
  // While dragging, the thumb follows the finger — not the playhead — so the
  // bar never fights the user when `value` ticks underneath.
  const shown = $derived(dragging ? dragValue : Math.min(Math.max(value || 0, 0), safeMax))
  const playedPct = $derived((shown / safeMax) * 100)
  const fills = $derived(bufferedRangeFills(buffered, safeMax))

  function valueFromClientX(clientX: number): number {
    if (!trackEl) return shown
    const rect = trackEl.getBoundingClientRect()
    if (rect.width <= 0) return shown
    return clampSeekTime(((clientX - rect.left) / rect.width) * safeMax, safeMax)
  }

  function handlePointerDown(e: PointerEvent): void {
    if (disabled) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    dragging = true
    dragValue = valueFromClientX(e.clientX)
    onSeek?.(dragValue)
  }

  function handlePointerMove(e: PointerEvent): void {
    if (!dragging || disabled) return
    dragValue = valueFromClientX(e.clientX)
    onSeek?.(dragValue)
  }

  function handlePointerUp(e: PointerEvent): void {
    if (!dragging) return
    dragValue = valueFromClientX(e.clientX)
    onSeek?.(dragValue)
    dragging = false
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (disabled) return
    const step = safeMax >= 60 ? 5 : 1
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault()
      onSeek?.(clampSeekTime(shown - step, safeMax))
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault()
      onSeek?.(clampSeekTime(shown + step, safeMax))
    } else if (e.key === 'Home') {
      e.preventDefault()
      onSeek?.(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      onSeek?.(safeMax)
    }
  }
</script>

<!-- h-9 hit area with a slim visual bar: the whole strip seeks, not a 4 px line. -->
<div
  role="slider"
  tabindex={disabled ? -1 : 0}
  aria-label={label}
  aria-orientation="horizontal"
  aria-valuemin={0}
  aria-valuemax={Math.round(safeMax)}
  aria-valuenow={Math.round(shown)}
  aria-valuetext={valueText}
  aria-disabled={disabled}
  class="group flex h-9 cursor-pointer touch-none items-center outline-none"
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
  <!-- mx reserves knob overhang so the thumb never clips at 0/100%. -->
  <div class="mx-[7px] w-full">
    <div
      bind:this={trackEl}
      class="relative h-1.5 w-full rounded-full bg-white/10 transition-[height] group-hover:h-2"
    >
      <div class="absolute inset-0 overflow-hidden rounded-full">
        {#each fills as f, i (i)}
          <div
            class="absolute inset-y-0 rounded-full bg-white/25"
            style="left: {f.left}%; width: {f.width}%;"
          ></div>
        {/each}
        <div
          class="absolute inset-y-0 left-0 rounded-full bg-white/85"
          style="width: {playedPct}%;"
        ></div>
      </div>
      <div
        class="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow transition-transform {dragging
          ? 'scale-125'
          : 'group-hover:scale-110'}"
        style="left: {playedPct}%;"
      ></div>
    </div>
  </div>
</div>

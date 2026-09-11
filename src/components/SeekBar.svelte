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

<!-- Knob-less bar (Spotify/YouTube pattern): the h-9 strip seeks anywhere.
  Review pass 2026-09-11: the track is taller (6px → 8px on hover/drag) and
  carries a thin vertical playhead line marking the exact position. Second
  pass (review 2026-09-11): RECTANGULAR geometry — the played fill has no
  rounded end (the old round cap left slivers of gap against the straight
  playhead line), the track itself only slightly rounded, and the playhead
  line is a step darker than pure white. -->
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
  <div class="w-full">
    <div
      bind:this={trackEl}
      class="relative h-2.5 w-full rounded-sm bg-white/10 transition-[height] duration-150 group-hover:h-3"
      class:h-3={dragging}
    >
      <div class="absolute inset-0 overflow-hidden rounded-sm">
        {#each fills as f, i (i)}
          <div
            class="absolute inset-y-0 rounded-sm bg-white/20"
            style="left: {f.left}%; width: {f.width}%;"
          ></div>
        {/each}
        <!-- Played fill: SOLID accent at rest (playback is the app's pulse;
             no hover brightening — one consistent color, review 2026-09-11).
             Square ends — the playhead line must sit flush against the fill. -->
        <div
          class="absolute inset-y-0 left-0 bg-accent"
          style="width: {playedPct}%;"
        ></div>
      </div>
      <!-- Thin vertical playhead (position marker): 2px line a step darker
           than white, overshooting the track, OUTSIDE the clipped fill
           container so it never gets cut. -->
      <div
        class="pointer-events-none absolute top-1/2 h-5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-neutral-300"
        style="left: {playedPct}%;"
        aria-hidden="true"
      ></div>
    </div>
  </div>
</div>

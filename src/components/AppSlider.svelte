<script lang="ts">
  /**
   * Custom horizontal slider (SeekBar's pointer-driven pattern) — replaces
   * native input[type=range] for every non-EQ-slider control (rating, volume,
   * speed/pitch, crossfade, Q, filter ranges).
   *
   * Why custom: the native input is a 16px-tall control — well under the
   * ~44px touch target iOS HIG expects — so adjusting a rating on a phone
   * means precise thumb-hits (the "slider is hard to press" report), and no
   * native range input supports tap-to-jump on touch (tapping the track
   * does nothing; you must drag the tiny thumb). A pointer-driven bar fixes
   * both by construction: the whole h-9 strip is the control, press = jump,
   * drag = adjust. Same reasoning that built SeekBar and EqSlider.
   *
   * Visual language matches SeekBar: 6px track (taller on hover/drag),
   * solid accent fill from the left edge, square fill end. Two-way `value`
   * binding keeps it a drop-in for the old <input bind:value>.
   */

  interface Props {
    value: number
    min?: number
    max?: number
    step?: number
    disabled?: boolean
    label?: string
    /** Spoken/current-value text, e.g. v => `${v}%` (ARIA valuetext). */
    valueText?: (v: number) => string
    /** Extra classes for the root (width utilities: flex-1, w-24, …). */
    class?: string
    /** Fired on press, per pointermove during drag, and on keyboard steps. */
    onInput?: (value: number) => void
    /** Fired when the gesture ENDS (pointer release) — the commit-on-release
     *  contract the rating sliders use (pending-mark on first input, write
     *  on release). Keyboard steps commit per step. */
    onCommit?: (value: number) => void
  }

  let {
    value = $bindable(0),
    min = 0,
    max = 100,
    step = 1,
    disabled = false,
    label = 'Slider',
    valueText,
    class: className = '',
    onInput,
    onCommit,
  }: Props = $props()

  let trackEl: HTMLDivElement | null = $state(null)
  let dragging = $state(false)

  const safeMax = $derived(max > min ? max : min + 1)
  const shown = $derived(Math.min(Math.max(value, min), safeMax))
  const fillPct = $derived(((shown - min) / (safeMax - min)) * 100)

  function snap(raw: number): number {
    const stepped = Math.round((raw - min) / step) * step + min
    const fixed = Number(stepped.toFixed(6)) // kill FP dust from 0.01 steps
    return Math.min(Math.max(fixed, min), safeMax)
  }

  function valueFromClientX(clientX: number): number {
    if (!trackEl) return shown
    const rect = trackEl.getBoundingClientRect()
    if (rect.width <= 0) return shown
    const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1)
    return snap(min + ratio * (safeMax - min))
  }

  function handlePointerDown(e: PointerEvent): void {
    if (disabled) return
    e.preventDefault() // no text-selection/scroll takeover while sliding
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    dragging = true
    value = valueFromClientX(e.clientX)
    onInput?.(value)
  }

  function handlePointerMove(e: PointerEvent): void {
    if (!dragging || disabled) return
    value = valueFromClientX(e.clientX)
    onInput?.(value)
  }

  function handlePointerUp(e: PointerEvent): void {
    if (!dragging) return
    value = valueFromClientX(e.clientX)
    onInput?.(value)
    dragging = false
    onCommit?.(value)
  }

  function nudge(dir: 1 | -1, multiplier = 1): void {
    if (disabled) return
    value = snap(shown + dir * step * multiplier)
    onInput?.(value)
    onCommit?.(value) // keyboard steps commit per step (no gesture end)
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (disabled) return
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault()
      nudge(-1)
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault()
      nudge(1)
    } else if (e.key === 'PageDown') {
      e.preventDefault()
      nudge(-1, 10)
    } else if (e.key === 'PageUp') {
      e.preventDefault()
      nudge(1, 10)
    } else if (e.key === 'Home') {
      e.preventDefault()
      value = min
      onInput?.(value)
    } else if (e.key === 'End') {
      e.preventDefault()
      value = safeMax
      onInput?.(value)
    }
  }
</script>

<div
  role="slider"
  tabindex={disabled ? -1 : 0}
  aria-label={label}
  aria-valuemin={min}
  aria-valuemax={safeMax}
  aria-valuenow={shown}
  aria-valuetext={valueText ? valueText(shown) : undefined}
  aria-disabled={disabled}
  class="group flex h-9 w-full cursor-pointer touch-none items-center outline-none {className}"
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
  <div
    bind:this={trackEl}
    class="relative h-1.5 w-full rounded-full bg-white/10 transition-[height] duration-150 group-hover:h-2.5"
    class:h-2.5={dragging}
  >
    <!-- Played fill: solid accent from the left edge (SeekBar's language). -->
    <div
      class="absolute inset-y-0 left-0 rounded-full bg-accent"
      style="width: {fillPct}%;"
    ></div>
  </div>
</div>

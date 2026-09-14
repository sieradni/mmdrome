<script lang="ts">
  import { calculateTotalResponse } from '../lib/eq/eqResponseCalculator'
  import { calculateGraphicTotalResponse } from '../lib/eq/graphicEqResponseCalculator'
  import { effectiveCurve } from '../lib/eq/eqCurveTopology'
  import type { EqFilterConfig, EqPoint, EqCurveType } from '../lib/eq/eqTypes'
  import type { FrequencyPoint } from '../lib/eq/eqResponseCalculator'

  interface Props {
    preampDb?: number
    filters?: EqFilterConfig[]
    eqBypassed?: boolean
    eqMode?: 'parametric' | 'graphic'
    graphicEqCurves?: EqPoint[][]
    /** Editor mode: handles become draggable, tap-to-add and ×-to-remove. */
    editable?: boolean
    onMoveFilter?: (index: number, frequency: number, gain: number) => void
    onAddFilter?: (frequency: number) => void
    onRemoveFilter?: (index: number) => void
  }

  let {
    preampDb = 0,
    filters = [],
    eqBypassed = false,
    eqMode = 'parametric' as 'parametric' | 'graphic',
    graphicEqCurves,
    editable = false,
    onMoveFilter,
    onAddFilter,
    onRemoveFilter,
  }: Props = $props()

  const FREQ_GRID = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
  const FREQ_LABELS = ['20', '50', '100', '200', '500', '1k', '2k', '5k', '10k', '20k']
  const GAIN_STEP = 0.5

  const MIN_FREQ = 20
  const MAX_FREQ = 20000
  const LOG_MIN = Math.log10(MIN_FREQ)
  const LOG_MAX = Math.log10(MAX_FREQ)

  let width = $state(600)
  let height = $state(180)
  let svgEl: SVGSVGElement | null = $state(null)

  // Calculate dynamic dB scale based on actual response curve
  let maxAbsGain = $derived.by(() => {
    if (!points || points.length === 0) return 12
    let maxVal = 0
    for (const p of points) {
      const abs = Math.abs(p.gainDb)
      if (abs > maxVal) maxVal = abs
    }
    maxVal = Math.max(6, maxVal + 4) // add 4dB headroom, minimum ±6dB
    return Math.min(36, Math.ceil(maxVal / 6) * 6) // round up to nearest 6dB, max ±36
  })

  let dbGrid = $derived.by(() => {
    const step = maxAbsGain <= 12 ? 6 : maxAbsGain <= 24 ? 6 : 12
    const grid: number[] = []
    for (let v = -maxAbsGain; v <= maxAbsGain; v += step) {
      grid.push(v)
    }
    if (!grid.includes(0)) grid.push(0)
    return grid.sort((a, b) => a - b)
  })

  function freqToX(freq: number): number {
    const logF = Math.log10(Math.max(MIN_FREQ, Math.min(MAX_FREQ, freq)))
    return ((logF - LOG_MIN) / (LOG_MAX - LOG_MIN)) * width
  }

  function dbToY(db: number): number {
    const clampedDb = Math.max(-maxAbsGain, Math.min(maxAbsGain, db))
    const halfH = height / 2
    return halfH - (clampedDb / maxAbsGain) * halfH
  }

  /** Hybrid response: when ANY enabled band is a graphic point the whole
   *  EQ renders through the interpolated-curve calculator (the engine's
   *  convolution path — one visual truth, §0.4); parametric mode keeps the
   *  per-biquad response sum. */
  const hybrid = $derived(filters.some((f) => f.enabled && effectiveCurve(f) === 'graphic'))

  // Frequency response points
  let points = $derived.by<FrequencyPoint[]>(() => {
    if (eqBypassed) return calculateTotalResponse(0, [], 100)
    if (eqMode === 'graphic') {
      return calculateGraphicTotalResponse(preampDb, filters, graphicEqCurves, 150)
    }
    if (hybrid) {
      const linear = calculateTotalResponse(0, filters, 150)
      const curve = calculateGraphicTotalResponse(0, filters, undefined, 150)
      return linear.map((p, i) => ({
        frequency: p.frequency,
        gainDb: preampDb + p.gainDb + curve[i].gainDb,
      }))
    }
    return calculateTotalResponse(preampDb, filters, 150)
  })

  let pathD = $derived.by(() => {
    if (!points || points.length === 0) return ''
    const coords = points.map((p) => `${freqToX(p.frequency).toFixed(1)},${dbToY(p.gainDb).toFixed(1)}`)
    return `M ${coords.join(' L ')}`
  })

  let areaD = $derived.by(() => {
    if (!points || points.length === 0) return ''
    const firstX = freqToX(points[0].frequency).toFixed(1)
    const lastX = freqToX(points[points.length - 1].frequency).toFixed(1)
    const zeroY = dbToY(0).toFixed(1)
    return `${pathD} L ${lastX},${zeroY} L ${firstX},${zeroY} Z`
  })

  // Handle positions: a parametric band's handle sits at its biquad bump
  // (frequency, gain); a graphic band's handle sits ON the interpolated
  // curve at its frequency — the visual statement that its gain is the
  // curve's gain there, not an isolated bump.
  let bandNodes = $derived.by(() => {
    const effPreamp = eqBypassed ? 0 : preampDb
    const nodes: {
      index: number
      x: number
      y: number
      kind: EqCurveType
      freq: number
      gain: number
    }[] = []
    // Track the FULL filters index — disabled bands shift an enabled-only
    // counter, and these indexes feed the move/remove callbacks.
    filters.forEach((f, i) => {
      if (!f.enabled) return
      nodes.push({
        index: i,
        // Parametric AND graphic handles sit at (frequency, gain): in the
        // hybrid renderer the interpolated curve passes through each
        // graphic point's own gain, so one formula lands every handle on
        // the curve.
        x: freqToX(f.frequency),
        y: dbToY(effPreamp + f.gain),
        kind: effectiveCurve(f),
        freq: f.frequency,
        gain: f.gain,
      })
    })
    return nodes
  })

  // ── Editor interaction (pointer capture, SeekBar pattern) ──────────────

  let dragIndex: number | null = $state(null)

  function svgPointFromEvent(e: PointerEvent): { freq: number; db: number } {
    const rect = svgEl?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return { freq: MIN_FREQ, db: 0 }
    const px = ((e.clientX - rect.left) / rect.width) * width
    const py = ((e.clientY - rect.top) / rect.height) * height
    const logF = LOG_MIN + (Math.min(Math.max(px, 0), width) / width) * (LOG_MAX - LOG_MIN)
    const freq = Math.pow(10, logF)
    const db =
      ((height / 2 - Math.min(Math.max(py, 0), height)) / (height / 2)) * maxAbsGain
    return { freq, db }
  }

  function snapDb(db: number): number {
    return Math.round(db / GAIN_STEP) * GAIN_STEP
  }

  function handleHandleDown(index: number) {
    return (e: PointerEvent) => {
      if (!editable || eqBypassed) return
      e.preventDefault()
      e.stopPropagation()
      ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
      dragIndex = index
    }
  }

  function handleHandleMove(e: PointerEvent) {
    if (dragIndex === null || !onMoveFilter) return
    const { freq, db } = svgPointFromEvent(e)
    // The pointer's dB is on the DISPLAYED curve (includes preamp); the
    // caller wants the band's own gain — subtract the preamp offset so the
    // handle tracks the finger exactly (handle y = preamp + gain).
    onMoveFilter(dragIndex, freq, snapDb(db - preampDb))
  }

  function handleHandleUp() {
    dragIndex = null
  }

  function handleSvgClick(e: MouseEvent) {
    if (!editable || eqBypassed || !onAddFilter) return
    // A click anywhere on a handle group (circle, square, or its × button)
    // must never register as add-point — check the ancestor, not just the
    // exact target.
    if ((e.target as Element)?.closest?.('[data-eq-handle]')) return
    const { freq } = svgPointFromEvent(e as unknown as PointerEvent)
    onAddFilter(freq)
  }

  function handleRemove(index: number) {
    return (e: { stopPropagation(): void }) => {
      e.stopPropagation()
      onRemoveFilter?.(index)
    }
  }

  const fmtFreq = (f: number): string => (f >= 1000 ? `${(f / 1000).toFixed(1)}k` : `${Math.round(f)}`)
</script>

<div class="relative w-full overflow-hidden rounded-xl bg-surface/80 p-3 backdrop-blur border border-white/5 shadow-inner">
  <div class="relative h-44 w-full" bind:clientWidth={width} bind:clientHeight={height}>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions --><!-- Tap-to-add is a pointer affordance; the keyboard-editable path is the
         band list below the graph (add button + per-row controls). -->
    <svg
      bind:this={svgEl}
      class="h-full w-full select-none overflow-visible"
      class:cursor-crosshair={editable && !eqBypassed}
      viewBox={`0 0 ${width} ${height}`}
      onclick={handleSvgClick}
    >
      <defs>
        <linearGradient id="eqFillGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--app-accent, #ffffff)" stop-opacity="0.25" />
          <stop offset="100%" stop-color="var(--app-accent, #ffffff)" stop-opacity="0.02" />
        </linearGradient>
      </defs>

      <!-- Horizontal dB Grid Lines -->
      {#each dbGrid as db}
        {@const y = dbToY(db)}
        <line
          x1="0"
          y1={y}
          x2={width}
          y2={y}
          stroke="currentColor"
          stroke-dasharray={db === 0 ? 'none' : '3,3'}
          class={db === 0 ? 'text-white/25 stroke-[1.5]' : 'text-white/10 stroke-[1]'}
        />
        <text
          x="4"
          y={y - 3}
          class="fill-muted/40 text-[9px] font-mono select-none"
        >
          {db > 0 ? '+' : ''}{db}dB
        </text>
      {/each}

      <!-- Vertical Frequency Grid Lines -->
      {#each FREQ_GRID as freq, i}
        {@const x = freqToX(freq)}
        <line
          x1={x}
          y1="0"
          x2={x}
          y2={height}
          stroke="currentColor"
          stroke-dasharray="2,3"
          class="text-white/10 stroke-[1]"
        />
        <text
          x={x}
          y={height - 4}
          text-anchor="middle"
          class="fill-muted/50 text-[9px] font-mono select-none"
        >
          {FREQ_LABELS[i]}
        </text>
      {/each}

      <!-- Filled Area under Curve -->
      <path d={areaD} fill="url(#eqFillGradient)" />

      <!-- Response Curve Line -->
      <path
        d={pathD}
        fill="none"
        class={eqBypassed ? 'stroke-yellow-400/60 stroke-[2]' : 'stroke-primary stroke-[2.5]'}
        stroke-linecap="round"
        stroke-linejoin="round"
      />

      <!-- Band Handles: round solid = parametric biquad; square hollow =
           graphic curve point (the two curve kinds are visually distinct). -->
      {#if !eqBypassed}
        {#each bandNodes as node (node.index)}
          {#if editable && !eqBypassed}
            <g
              data-eq-handle="1"
              role="button"
              tabindex="0"
              aria-label="{node.kind === 'graphic' ? 'Curve point' : 'Parametric band'} {fmtFreq(node.freq)} Hz"
              class="cursor-grab touch-none"
              onpointerdown={handleHandleDown(node.index)}
              onpointermove={handleHandleMove}
              onpointerup={handleHandleUp}
              onpointercancel={handleHandleUp}
            >
              {#if node.kind === 'graphic'}
                <rect
                  x={node.x - 5}
                  y={node.y - 5}
                  width="10"
                  height="10"
                  class="fill-background stroke-primary stroke-[2] transition-all duration-150"
                />
              {:else}
                <circle
                  cx={node.x}
                  cy={node.y}
                  r="4.5"
                  class="fill-primary stroke-background stroke-[2] transition-all duration-150"
                />
              {/if}
              <!-- remove affordance (editor only): a real ARIA button —
                   keyboard Enter/Space triggers it like a click -->
              <circle
                cx={node.x + 10}
                cy={node.y - 10}
                r="5"
                role="button"
                tabindex="0"
                aria-label="Remove band {fmtFreq(node.freq)}"
                class="fill-surface-raised text-muted/80 stroke-[1] stroke-white/20 cursor-pointer hover:text-red-400"
                onpointerdown={(e) => e.stopPropagation()}
                onclick={handleRemove(node.index)}
                onkeydown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    handleRemove(node.index)(e)
                  }
                }}
              />
              <text
                x={node.x + 10}
                y={node.y - 7.5}
                text-anchor="middle"
                class="pointer-events-none fill-current text-[7px] font-mono select-none"
              >×</text>
            </g>
          {:else}
            {#if node.kind === 'graphic'}
              <rect
                x={node.x - 5}
                y={node.y - 5}
                width="10"
                height="10"
                class="fill-background stroke-primary stroke-[2]"
              />
            {:else}
              <circle
                cx={node.x}
                cy={node.y}
                r="4.5"
                class="fill-background stroke-primary stroke-[2] shadow-md"
              />
            {/if}
          {/if}
        {/each}
      {/if}
    </svg>
  </div>
</div>

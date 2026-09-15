<script lang="ts">
  import { calculateTotalResponse } from '../lib/eq/eqResponseCalculator'
  import { calculateGraphicTotalResponse } from '../lib/eq/graphicEqResponseCalculator'
  import { effectiveCurve } from '../lib/eq/eqCurveTopology'
  import { spectrumBandEdges, visibleBands } from '../lib/eq/spectrumCore'
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
    /** Tap (not drag) on a band dot — the view opens the FULL band editor
     *  (modal with frequency, gain, Q, curve kind, remove). Replaces the old
     *  cramped SVG popover (2026-09-15: dots were also hard to press). */
    onBandTap?: (index: number) => void
    /** Live spectrum levels (0..1 per band, the shared 20 Hz–20 kHz log
     *  ladder from spectrumCore) rendered as a filled shape BEHIND the grid
     *  and response curve. Empty/absent = no overlay (nothing playing, or
     *  a platform without the tap). `spectrumLive` gates the subtle
     *  fade-in so a stale last frame doesn't linger after pause. */
    spectrum?: Float32Array | null
    spectrumLive?: boolean
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
    onBandTap,
    spectrum = null,
    spectrumLive = false,
  }: Props = $props()

  const GAIN_STEP = 0.5

  const MIN_FREQ = 20
  const MAX_FREQ = 20000
  const LOG_MIN = Math.log10(MIN_FREQ)
  const LOG_MAX = Math.log10(MAX_FREQ)

  // ── Viewport (2026-09-15): the frequency axis pans and zooms ─────────────
  // Horizontal view window [viewMin, viewMax] in Hz. Vertical stays
  // auto-scaled (maxAbsGain below) — vertical pan has no meaning there.
  const MIN_SPAN_DECADES = 0.35
  const FULL_SPAN_DECADES = LOG_MAX - LOG_MIN
  let viewMin = $state(MIN_FREQ)
  let viewMax = $state(MAX_FREQ)
  let logViewMin = $derived(Math.log10(viewMin))
  let logViewMax = $derived(Math.log10(viewMax))
  const isZoomed = $derived(logViewMin > LOG_MIN + 1e-9 || logViewMax < LOG_MAX - 1e-9)

  /** Clamp a requested window: span within [MIN_SPAN, FULL], window inside
   *  the absolute 20 Hz–20 kHz range. */
  function setView(minFreq: number, maxFreq: number) {
    let lo = Math.log10(minFreq)
    let hi = Math.log10(maxFreq)
    let span = hi - lo
    if (span > FULL_SPAN_DECADES) {
      const c = (lo + hi) / 2
      span = FULL_SPAN_DECADES
      lo = c - span / 2
      hi = c + span / 2
    }
    if (span < MIN_SPAN_DECADES) {
      const c = (lo + hi) / 2
      span = MIN_SPAN_DECADES
      lo = c - span / 2
      hi = c + span / 2
    }
    if (lo < LOG_MIN) {
      lo = LOG_MIN
      hi = lo + span
    }
    if (hi > LOG_MAX) {
      hi = LOG_MAX
      lo = hi - span
    }
    viewMin = Math.pow(10, lo)
    viewMax = Math.pow(10, hi)
  }

  function resetView() {
    setView(MIN_FREQ, MAX_FREQ)
  }

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
    return ((logF - logViewMin) / (logViewMax - logViewMin)) * width
  }

  function dbToY(db: number): number {
    const clampedDb = Math.max(-maxAbsGain, Math.min(maxAbsGain, db))
    const halfH = height / 2
    return halfH - (clampedDb / maxAbsGain) * halfH
  }

  /** Hybrid response: when ANY enabled band is a graphic point the whole
   *  EQ renders through the interpolated-curve calculator (the engine's
   *  convolution path — one visual truth, §0.4); parametric mode keeps the
   *  per-biquad response sum. 300 points so a zoomed-in view stays smooth. */
  const hybrid = $derived(filters.some((f) => f.enabled && effectiveCurve(f) === 'graphic'))

  // Frequency response points
  let points = $derived.by<FrequencyPoint[]>(() => {
    if (eqBypassed) return calculateTotalResponse(0, [], 300)
    if (eqMode === 'graphic') {
      return calculateGraphicTotalResponse(preampDb, filters, graphicEqCurves, 300)
    }
    if (hybrid) {
      const linear = calculateTotalResponse(0, filters, 300)
      const curve = calculateGraphicTotalResponse(0, filters, undefined, 300)
      return linear.map((p, i) => ({
        frequency: p.frequency,
        gainDb: preampDb + p.gainDb + curve[i].gainDb,
      }))
    }
    return calculateTotalResponse(preampDb, filters, 300)
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

  /** The drawn curve's dB at an arbitrary frequency — log-frequency linear
   *  interpolation over `points`, the EXACT polyline the SVG path connects
   *  (linear in log space matches the segments). Handles snap to this, so a
   *  dot sits on the drawn line BY CONSTRUCTION — it can never float above
   *  or below the visual curve (2026-09-14: handles sat at preamp + band
   *  gain and drifted wherever neighbor bumps overlapped). */
  function curveDbAt(freq: number): number {
    if (points.length === 0) return 0
    if (freq <= points[0].frequency) return points[0].gainDb
    const logF = Math.log10(freq)
    for (let i = 1; i < points.length; i++) {
      if (points[i].frequency >= freq) {
        const a = points[i - 1]
        const b = points[i]
        const t =
          (logF - Math.log10(a.frequency)) / (Math.log10(b.frequency) - Math.log10(a.frequency))
        return a.gainDb + t * (b.gainDb - a.gainDb)
      }
    }
    return points[points.length - 1].gainDb
  }

  // Handle positions: ON the displayed curve at the band's frequency — the
  // single visual truth (the dot IS where the curve is; dragging it moves the
  // band to follow). Parametric and graphic share the position; kind is kept
  // for the distinct shapes.
  let bandNodes = $derived.by(() => {
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
        x: freqToX(f.frequency),
        y: dbToY(curveDbAt(f.frequency)),
        kind: effectiveCurve(f),
        freq: f.frequency,
        gain: f.gain,
      })
    })
    return nodes
  })

  // ── Editor interaction (pointer capture, SeekBar pattern) ──────────────

  let dragIndex: number | null = $state(null)
  /** True once a handle drag moved beyond the tap slop — a drag-end must
   *  stay quiet (no editor modal), only a genuine TAP opens it (2026-09-15:
   *  the rewrite initially dropped this and every drag-end popped the
   *  modal — caught by the live probe, contract from 2026-09-14). */
  let dragMoved = $state(false)
  let dragStartX = 0
  let dragStartY = 0

  function svgPointFromEvent(e: PointerEvent | MouseEvent): { freq: number; db: number } {
    const rect = svgEl?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return { freq: MIN_FREQ, db: 0 }
    const px = ((e.clientX - rect.left) / rect.width) * width
    const py = ((e.clientY - rect.top) / rect.height) * height
    const logF = logViewMin + (Math.min(Math.max(px, 0), width) / width) * (logViewMax - logViewMin)
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
      e.stopPropagation() // the graph's pan gesture must not start from a dot
      ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
      dragIndex = index
      dragMoved = false
      dragStartX = e.clientX
      dragStartY = e.clientY
    }
  }

  function handleHandleMove(e: PointerEvent) {
    if (dragIndex === null || !onMoveFilter) return
    if (Math.hypot(e.clientX - dragStartX, e.clientY - dragStartY) > TAP_SLOP_PX) dragMoved = true
    const { freq, db } = svgPointFromEvent(e)
    // The pointer's dB is on the DISPLAYED curve (includes preamp); the
    // caller wants the band's own gain — subtract the preamp offset so the
    // handle tracks the finger exactly (the handle y rides the curve, which
    // includes preamp + neighbors — the subtraction lands the band's gain so
    // the dot stays under the finger as the curve re-computes).
    onMoveFilter(dragIndex, freq, snapDb(db - preampDb))
  }

  function handleHandleUp(index: number | null) {
    // A TAP (no meaningful drag) opens the FULL band editor; a drag-end stays
    // quiet: the user was placing the band, not asking.
    if (index !== null && !dragMoved && dragIndex === index && onBandTap) onBandTap(index)
    dragIndex = null
    dragMoved = false
  }

  // ── Pan / zoom gestures (2026-09-15): 1 finger = pan, 2 = pinch+pan,
  //    wheel = zoom about the cursor. Tap-to-add stays: a gesture that moved
  //    ≥ 6 px suppresses the click that follows the pointerup. ──────────────
  const TAP_SLOP_PX = 6

  // ── Spectrum overlay geometry ──────────────────────────────────────────
  // The bands ride the SAME log-x / dB-y mapping as the response curve, so
  // a spectral peak visually aligns with the frequency it will affect.
  // The overlay's full height is capped at the 0 dB line's half (energy
  // above 0 dB would hide the curve) and only the bands inside the current
  // pan/zoom window render — the overlay follows the viewport exactly.
  const SPECTRUM_BANDS = 48
  const spectrumEdges = spectrumBandEdges(SPECTRUM_BANDS)
  let spectrumPath = $derived.by(() => {
    if (!spectrum || spectrumLive === false || spectrum.length === 0) return ''
    const vis = visibleBands(
      Array.from(spectrum),
      spectrumEdges,
      Math.pow(10, logViewMin),
      Math.pow(10, logViewMax)
    )
    if (vis.levels.length === 0) return ''
    const zeroY = dbToY(0)
    const floorY = dbToY(-maxAbsGain) // chart floor
    const halfSpan = (zeroY - floorY) * 0.55 // cap: 55% of the lower half
    const logStart = Math.log10(vis.startEdgeHz)
    const logEnd = Math.log10(vis.endEdgeHz)
    const xOf = (f: number) => ((Math.log10(f) - logViewMin) / (logViewMax - logViewMin)) * width
    // Band-bar polygon: one rectangle per band, stepping through the
    // shared edges — reads as a classic spectrum analyzer and keeps each
    // band's contribution visually separable.
    const stepX = ((logEnd - logStart) / vis.levels.length / (logViewMax - logViewMin)) * width
    const pts: string[] = [`M ${xOf(vis.startEdgeHz).toFixed(1)},${zeroY.toFixed(1)}`]
    for (let i = 0; i < vis.levels.length; i++) {
      const h = Math.max(0, Math.min(1, vis.levels[i])) * halfSpan
      const x0 = xOf(vis.startEdgeHz) + i * stepX
      pts.push(`L ${x0.toFixed(1)},${(zeroY - h).toFixed(1)}`)
      pts.push(`L ${(x0 + stepX).toFixed(1)},${(zeroY - h).toFixed(1)}`)
    }
    pts.push(`L ${xOf(vis.endEdgeHz).toFixed(1)},${zeroY.toFixed(1)}`)
    return pts.join(' ')
  })
  type Pt = { x: number; y: number }
  let pointers = new Map<number, Pt>()
  let gestureDist = 0
  /** True once the active gesture moved/pinched meaningfully — eats the
   *  click that follows, so a pan never adds a band. Cleared on down. */
  let gestureMoved = false
  /** Pinch anchor: previous two-finger distance + the log-frequency under
   *  the midpoint (the content point that stays under the fingers). */
  let lastPinch: { dist: number; contentLogF: number } | null = null

  function graphPointerDown(e: PointerEvent) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    gestureDist = 0
    if (pointers.size === 1) gestureMoved = false // fresh gesture
    if (pointers.size === 2) {
      gestureMoved = true // a pinch is never a tap
      const [p1, p2] = [...pointers.values()]
      lastPinch = { dist: Math.hypot(p2.x - p1.x, p2.y - p1.y), contentLogF: 0 }
    }
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }

  function graphPointerMove(e: PointerEvent) {
    const prev = pointers.get(e.pointerId)
    if (!prev) return
    const rect = svgEl?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return
    const cur = { x: e.clientX, y: e.clientY }
    pointers.set(e.pointerId, cur)

    if (pointers.size === 1) {
      const dx = cur.x - prev.x
      const dy = cur.y - prev.y
      gestureDist += Math.hypot(dx, dy)
      if (gestureDist > TAP_SLOP_PX) gestureMoved = true
      if (!gestureMoved || dx === 0) return
      // Dragging right moves the WINDOW left in frequency (content follows
      // the finger). Horizontal only — vertical is auto-scaled.
      const logDelta = (dx / rect.width) * (logViewMax - logViewMin)
      setView(Math.pow(10, logViewMin - logDelta), Math.pow(10, logViewMax - logDelta))
    } else if (pointers.size === 2) {
      gestureMoved = true
      const [p1, p2] = [...pointers.values()]
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y)
      const midX = (p1.x + p2.x) / 2
      const frac = Math.min(Math.max((midX - rect.left) / rect.width, 0), 1)
      // Content point currently under the midpoint (pre-move view bounds).
      const contentLogF = logViewMin + frac * (logViewMax - logViewMin)
      if (lastPinch && lastPinch.dist > 0) {
        const ratio = lastPinch.dist / Math.max(dist, 1) // fingers apart → span shrinks
        const clamped = Math.max(0.2, Math.min(5, ratio))
        const spanLog = Math.max(MIN_SPAN_DECADES, Math.min(FULL_SPAN_DECADES, (logViewMax - logViewMin) * clamped))
        // Keep the anchored content point at the (moving) midpoint — pan
        // and zoom in one transform.
        const lo = contentLogF - frac * spanLog
        setView(Math.pow(10, lo), Math.pow(10, lo + spanLog))
      }
      lastPinch = { dist, contentLogF }
    }
  }

  function graphPointerUp(e: PointerEvent) {
    pointers.delete(e.pointerId)
    if (pointers.size < 2) lastPinch = null
  }

  function graphWheel(e: WheelEvent) {
    const rect = svgEl?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return
    e.preventDefault()
    const frac = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1)
    const anchorLog = logViewMin + frac * (logViewMax - logViewMin)
    const factor = Math.exp(e.deltaY * 0.0018) // wheel down = zoom out
    const spanLog = Math.max(MIN_SPAN_DECADES, Math.min(FULL_SPAN_DECADES, (logViewMax - logViewMin) * factor))
    const lo = anchorLog - frac * spanLog
    setView(Math.pow(10, lo), Math.pow(10, lo + spanLog))
  }

  function handleSvgClick(e: MouseEvent) {
    if (!editable || eqBypassed || !onAddFilter) return
    // A click on a handle group (the dot) belongs to the dot — never add.
    if ((e.target as Element)?.closest?.('[data-eq-handle]')) return
    // A pan/pinch/wheel gesture must not register as tap-to-add.
    if (gestureMoved) {
      gestureMoved = false
      return
    }
    const { freq } = svgPointFromEvent(e)
    onAddFilter(freq)
  }

  // ── Dynamic 1-2-5 frequency grid: self-similar under zoom (density is
  //    constant), and at the full view it reproduces the classic fixed
  //    grid 20/50/100/200/500/1k/2k/5k/10k/20k exactly. ─────────────────────
  let freqGrid = $derived.by(() => {
    const out: number[] = []
    const kStart = Math.floor(logViewMin)
    const kEnd = Math.ceil(logViewMax)
    for (let k = kStart; k <= kEnd; k++) {
      for (const m of [1, 2, 5]) {
        const f = m * Math.pow(10, k)
        if (f >= viewMin * 0.999 && f <= viewMax * 1.001) out.push(f)
      }
    }
    return out
  })

  const fmtGrid = (f: number): string =>
    f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : `${f}`
</script>

<div class="relative w-full overflow-hidden rounded-xl bg-surface/80 p-3 backdrop-blur border border-white/5 shadow-inner">
  <div class="relative h-44 w-full" bind:clientWidth={width} bind:clientHeight={height}>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions --><!-- Tap-to-add is a pointer affordance; the keyboard-editable path is the
         band list below the graph (add button + per-row controls). -->
    <svg
      bind:this={svgEl}
      class="h-full w-full touch-none select-none overflow-visible"
      class:cursor-crosshair={editable && !eqBypassed}
      viewBox={`0 0 ${width} ${height}`}
      onclick={handleSvgClick}
      onpointerdown={graphPointerDown}
      onpointermove={graphPointerMove}
      onpointerup={graphPointerUp}
      onpointercancel={graphPointerUp}
      onwheel={graphWheel}
    >
      <defs>
        <linearGradient id="eqFillGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--app-accent, #ffffff)" stop-opacity="0.25" />
          <stop offset="100%" stop-color="var(--app-accent, #ffffff)" stop-opacity="0.02" />
        </linearGradient>
      </defs>

      <!-- Spectrum overlay: BEHIND the grid lines and curve (the EQ is the
           foreground subject; the spectrum is context). Muted accent so it
           reads as live audio without competing. -->
      {#if spectrumPath}
        <path
          d={spectrumPath}
          class="fill-accent/20 stroke-accent/50 stroke-[1]"
          stroke-linejoin="round"
        />
      {/if}

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

      <!-- Vertical Frequency Grid Lines (dynamic 1-2-5 per the view window) -->
      {#each freqGrid as freq}
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
          {fmtGrid(freq)}
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
           graphic curve point (the two curve kinds are visually distinct).
           Each carries a 22 px INVISIBLE hit circle — a 5 px dot alone is
           unusable on a phone (2026-09-15 "dots are hard to press"). -->
      {#if !eqBypassed}
        {#each bandNodes as node (node.index)}
          {#if editable && !eqBypassed}
            <g
              data-eq-handle="1"
              role="button"
              tabindex="0"
              aria-label="{node.kind === 'graphic' ? 'Curve point' : 'Parametric band'} {fmtGrid(node.freq)} Hz — tap to edit, drag to move"
              class="cursor-grab touch-none"
              onpointerdown={handleHandleDown(node.index)}
              onpointermove={handleHandleMove}
              onpointerup={() => handleHandleUp(node.index)}
              onpointercancel={() => handleHandleUp(null)}
              onkeydown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onBandTap?.(node.index)
                }
              }}
            >
              <!-- Hit target: far larger than the visible dot -->
              <circle cx={node.x} cy={node.y} r="22" fill="transparent" />
              {#if node.kind === 'graphic'}
                <rect
                  x={node.x - (dragIndex === node.index ? 6 : 5)}
                  y={node.y - (dragIndex === node.index ? 6 : 5)}
                  width={dragIndex === node.index ? 12 : 10}
                  height={dragIndex === node.index ? 12 : 10}
                  class="fill-background stroke-primary stroke-[2]"
                />
              {:else}
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={dragIndex === node.index ? 6 : 5}
                  class="fill-primary stroke-background stroke-[2]"
                />
              {/if}
            </g>
          {:else}
            <circle cx={node.x} cy={node.y} r="22" fill="transparent" />
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
                r="5"
                class="fill-background stroke-primary stroke-[2] shadow-md"
              />
            {/if}
          {/if}
        {/each}
      {/if}
    </svg>

    <!-- Reset-view chip: appears only when zoomed/panned -->
    {#if isZoomed}
      <button
        onclick={resetView}
        class="absolute right-1 top-1 rounded-full bg-black/55 px-2.5 py-0.5 text-[10px] font-medium text-white/85 backdrop-blur transition-colors hover:bg-black/75"
        title="Reset the frequency view (20 Hz – 20 kHz)"
      >Reset view</button>
    {/if}
  </div>
</div>

<script lang="ts">
  import { calculateTotalResponse } from '../lib/eq/eqResponseCalculator'
  import type { EqFilterConfig } from '../lib/eq/eqTypes'

  let {
    preampDb = 0,
    filters = [],
    eqBypassed = false,
  }: {
    preampDb?: number
    filters?: EqFilterConfig[]
    eqBypassed?: boolean
  } = $props()

  const FREQ_GRID = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
  const FREQ_LABELS = ['20', '50', '100', '200', '500', '1k', '2k', '5k', '10k', '20k']

  const MIN_FREQ = 20
  const MAX_FREQ = 20000
  const LOG_MIN = Math.log10(MIN_FREQ)
  const LOG_MAX = Math.log10(MAX_FREQ)

  let width = $state(600)
  let height = $state(180)

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

  // Frequency response points
  let points = $derived(
    eqBypassed ? calculateTotalResponse(0, [], 100) : calculateTotalResponse(preampDb, filters, 150)
  )

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

  let bandNodes = $derived(
    filters
      .filter((f) => f.enabled)
      .map((f) => ({
        x: freqToX(f.frequency),
        y: dbToY((eqBypassed ? 0 : preampDb) + f.gain),
        type: f.type,
        freq: f.frequency,
        gain: f.gain,
      }))
  )
</script>

<div class="relative w-full overflow-hidden rounded-xl bg-surface/80 p-3 backdrop-blur border border-white/5 shadow-inner">
  <div class="relative h-44 w-full" bind:clientWidth={width} bind:clientHeight={height}>
    <svg class="h-full w-full select-none overflow-visible" viewBox={`0 0 ${width} ${height}`}>
      <defs>
        <linearGradient id="eqFillGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--color-primary, #6366f1)" stop-opacity="0.25" />
          <stop offset="100%" stop-color="var(--color-primary, #6366f1)" stop-opacity="0.02" />
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

      <!-- Band Markers -->
      {#if !eqBypassed}
        {#each bandNodes as node}
          <circle
            cx={node.x}
            cy={node.y}
            r="4.5"
            class="fill-background stroke-primary stroke-[2] shadow-md transition-all duration-150 hover:r-6"
          />
        {/each}
      {/if}
    </svg>
  </div>
</div>

interface PendingThumb {
  el: HTMLElement
  load: () => void
  distance: number
  retries: number
}

const MAX_PER_TICK = 3
const MAX_ZERO_SIZE_RETRIES = 10

let pending: PendingThumb[] = []
let running = false

function tick(): void {
  running = false
  if (pending.length === 0) return

  const vh = window.innerHeight
  const midViewport = vh / 2
  const dropDistance = vh * 3

  const keep: PendingThumb[] = []
  for (const p of pending) {
    const rect = p.el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) {
      // Not laid out yet — hold it (unbounded batching would load invisible
      // thumbs early; dropping it strands it forever since the IntersectionObserver
      // only re-fires on intersection *changes*). Give up after a few frames.
      if (p.retries > 0) {
        p.retries--
        p.distance = Number.MAX_SAFE_INTEGER
        keep.push(p)
      }
      continue
    }
    const dist = Math.abs(rect.top + rect.height / 2 - midViewport)
    if (dist > dropDistance) continue
    p.distance = dist
    keep.push(p)
  }

  keep.sort((a, b) => a.distance - b.distance)
  const batch = keep.splice(0, MAX_PER_TICK)
  for (const p of batch) p.load()

  pending = keep
  if (pending.length > 0) {
    running = true
    requestAnimationFrame(tick)
  }
}

function start(): void {
  if (running || pending.length === 0) return
  running = true
  requestAnimationFrame(tick)
}

/**
 * Queue a thumbnail load so the browser fetches/decodes at most `MAX_PER_TICK`
 * per frame, always nearest-to-viewport first. Fast scrolling past rows never
 * creates a decode backlog that stalls the current scroll position.
 */
export function requestThumb(el: HTMLElement, load: () => void): void {
  if (pending.some((p) => p.el === el)) return
  pending.push({ el, load, distance: 0, retries: MAX_ZERO_SIZE_RETRIES })
  start()
}

export function cancelThumb(el: HTMLElement): void {
  const i = pending.findIndex((p) => p.el === el)
  if (i >= 0) pending.splice(i, 1)
}
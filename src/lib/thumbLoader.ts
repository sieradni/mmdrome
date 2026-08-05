interface PendingThumb {
  el: HTMLElement
  load: () => void
  distance: number
}

const MAX_PER_TICK = 3

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
    if (rect.width === 0 && rect.height === 0) continue
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
  pending.push({ el, load, distance: 0 })
  start()
}

export function cancelThumb(el: HTMLElement): void {
  const i = pending.findIndex((p) => p.el === el)
  if (i >= 0) pending.splice(i, 1)
}
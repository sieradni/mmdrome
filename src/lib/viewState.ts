type ViewState = Record<string, unknown>

const STORAGE_KEY = 'mmdrome_viewstate'

const store: Record<string, ViewState> = load()

function load(): Record<string, ViewState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function writeStorage(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // storage full or unavailable — silently ignore
  }
}

/**
 * Scroll-jank fix (P2, 2026-09-23): every view's scroll handler calls
 * `saveViewState` PER SCROLL EVENT, and the old code immediately
 * JSON.stringify'd the WHOLE store + hit localStorage synchronously each
 * time — main-thread IO mid-gesture, compounding the row-paint cost of every
 * scroll frame. The in-memory merge below stays SYNCHRONOUS (restore
 * semantics unchanged — a read right after a save still sees the value);
 * only the stringify + storage write is trailing-debounced.
 *
 * `pagehide` + `visibilitychange→hidden` flush immediately — iOS kills the
 * webview without a reliable `beforeunload`, and backgrounding is exactly
 * when a not-yet-persisted scrollTop would be lost (beforeunload is wired
 * too, for desktop web).
 */

const PERSIST_DEBOUNCE_MS = 300

let persistTimer: ReturnType<typeof setTimeout> | null = null

function schedulePersist(): void {
  if (persistTimer !== null) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    writeStorage()
  }, PERSIST_DEBOUNCE_MS)
}

/** Test/lifecycle hook: write any pending debounce NOW. */
export function flushViewStatePersistence(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer)
    persistTimer = null
    writeStorage()
  }
  if (sessionPersistTimer !== null) {
    clearTimeout(sessionPersistTimer)
    sessionPersistTimer = null
    writeSessionStorage()
  }
}

// Page-lifecycle flush — guarded so a Node import stays side-effect-free.
if (typeof document !== 'undefined') {
  const flush = () => flushViewStatePersistence()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
  window.addEventListener('pagehide', flush)
  window.addEventListener('beforeunload', flush)
}

const sessionStore: Record<string, ViewState> = loadSession()

function loadSession(): Record<string, ViewState> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

let sessionPersistTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSessionPersist(): void {
  if (sessionPersistTimer !== null) return
  sessionPersistTimer = setTimeout(() => {
    sessionPersistTimer = null
    writeSessionStorage()
  }, PERSIST_DEBOUNCE_MS)
}

function writeSessionStorage(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(sessionStore))
  } catch {
    // storage full or unavailable — silently ignore
  }
}

export function saveViewState(view: string, state: ViewState) {
  store[view] = { ...store[view], ...state }
  schedulePersist()
}

export function restoreViewState<T extends ViewState>(view: string): T | null {
  const saved = store[view]
  if (!saved) return null
  return { ...saved } as T
}

export function saveViewStateSession(view: string, state: ViewState) {
  sessionStore[view] = { ...sessionStore[view], ...state }
  scheduleSessionPersist()
}

export function restoreViewStateSession<T extends ViewState>(view: string): T | null {
  const saved = sessionStore[view]
  if (!saved) return null
  return { ...saved } as T
}
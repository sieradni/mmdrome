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

function persist(store: Record<string, ViewState>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // storage full or unavailable — silently ignore
  }
}

export function saveViewState(view: string, state: ViewState) {
  store[view] = { ...store[view], ...state }
  persist(store)
}

export function restoreViewState<T extends ViewState>(view: string): T | null {
  const saved = store[view]
  if (!saved) return null
  return { ...saved } as T
}
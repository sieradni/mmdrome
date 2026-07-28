type ViewState = Record<string, unknown>

const store: Record<string, ViewState> = {}

export function saveViewState(view: string, state: ViewState) {
  store[view] = { ...state }
}

export function restoreViewState<T extends ViewState>(view: string): T | null {
  const saved = store[view]
  if (!saved) return null
  return { ...saved } as T
}
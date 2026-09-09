import { get } from 'svelte/store'
import { persisted } from './persistedStore'

/**
 * Appearance customization (accent color + font), per C6: engine/UI-bound
 * presentation scalars live in `persisted` stores, NOT the `settings` object
 * store. Both apply themselves to document CSS variables, which app.css wires
 * into the Tailwind theme (`--color-accent` etc.) and the base font stack.
 *
 * The accent is expressed as a hue (or null for the neutral white default) so
 * the soft/ring variants derive from one number — a future picker only needs
 * to move one slider. Warning/status yellows in the app are NOT accent-driven:
 * they are semantic (attention), deliberately left hardcoded.
 */

export const NEUTRAL_ACCENT = 'neutral'

/** The swatch hues offered by the Appearance tab (hsl hue numbers). */
export const ACCENT_HUES = [0, 25, 45, 140, 190, 220, 270, 320] as const

export type AppFont =
  | 'jetbrains'
  | 'plex'
  | 'geist'
  | 'fira'
  | 'roboto'
  | 'inter'
  | 'space'
  | 'system'

/** The font choices: monospace by identity (the app's voice), plus two
 *  proportional options for users who prefer one. All bundled locally via
 *  fontsource (offline/native safe). Each list button renders in its own
 *  stack so the picker shows the real thing. */
export const FONT_OPTIONS: { id: AppFont; label: string; stack: string }[] = [
  {
    id: 'jetbrains',
    label: 'JetBrains Mono',
    stack: "'JetBrains Mono Variable', ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, monospace",
  },
  {
    id: 'plex',
    label: 'IBM Plex Mono',
    stack: "'IBM Plex Mono', ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, monospace",
  },
  {
    id: 'geist',
    label: 'Geist Mono',
    stack: "'Geist Mono Variable', ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, monospace",
  },
  {
    id: 'fira',
    label: 'Fira Code',
    stack: "'Fira Code', ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, monospace",
  },
  {
    id: 'roboto',
    label: 'Roboto Mono',
    stack: "'Roboto Mono', ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, monospace",
  },
  {
    id: 'inter',
    label: 'Inter (sans)',
    stack: "'Inter Variable', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  },
  {
    id: 'space',
    label: 'Space Grotesk (sans)',
    stack: "'Space Grotesk Variable', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  },
  {
    id: 'system',
    label: 'System',
    stack: "ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, Consolas, monospace",
  },
]

const _accentHue = persisted<number | typeof NEUTRAL_ACCENT>('appearanceAccentHue', NEUTRAL_ACCENT)
const _appFont = persisted<AppFont>('appearanceFont', 'jetbrains')

export const accentHue = _accentHue.store
export const appFont = _appFont.store

/** CSS for the given hue: solid accent + translucent soft/ring companions. */
function cssForHue(hue: number | null): { accent: string; soft: string; ring: string } {
  if (hue === null) {
    // Neutral: the app's original white chrome.
    return {
      accent: '#ffffff',
      soft: 'rgb(255 255 255 / 0.15)',
      ring: 'rgb(255 255 255 / 0.3)',
    }
  }
  return {
    accent: `hsl(${hue} 70% 62%)`,
    soft: `hsl(${hue} 60% 55% / 0.16)`,
    ring: `hsl(${hue} 60% 55% / 0.38)`,
  }
}

export function applyAppearance(): void {
  const root = document.documentElement
  const stored = get(_accentHue.store)
  const { accent, soft, ring } = cssForHue(stored === NEUTRAL_ACCENT ? null : stored)
  root.style.setProperty('--app-accent', accent)
  root.style.setProperty('--app-accent-soft', soft)
  root.style.setProperty('--app-accent-ring', ring)
  const font = FONT_OPTIONS.find((f) => f.id === (get(_appFont.store) || 'jetbrains')) ?? FONT_OPTIONS[0]
  root.style.setProperty('--app-font', font.stack)
  // The 93.75% root size compensates for monospace's larger apparent size;
  // proportional faces read true to size, so they run at the normal 100%.
  root.classList.toggle('proportional-font', font.id === 'inter' || font.id === 'space')
}

/** Restore once at boot (main.ts) and subscribe to further changes. */
export async function initAppearance(): Promise<void> {
  await Promise.all([_accentHue.restore(), _appFont.restore()])
  applyAppearance()
  _accentHue.store.subscribe(() => applyAppearance())
  _appFont.store.subscribe(() => applyAppearance())
}

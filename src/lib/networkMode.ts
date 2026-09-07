import { derived, writable } from 'svelte/store'
import { settings } from '../stores/appState'
import { BackgroundAudio } from './nativePlugin'
import { Capacitor } from '@capacitor/core'

/**
 * Network mode (low-data mode): cellular/expensive detection + the effective
 * low-data flag. All consumers read `effectiveLowData`, never the raw
 * setting — the derived store is the single gate.
 *
 * Platform reality (verified 2026-09-06):
 * - Native iOS: the BackgroundAudio plugin exposes `getNetworkState` backed by
 *   NWPathMonitor (`isExpensive` = cellular/hotspot, `isConstrained` = the OS
 *   Low Data Mode setting) + a `networkStateChanged` event. Exact.
 * - Web: only the Network Information API heuristic (Chromium). `effectiveType`
 *   '2g'/'slow-2g'/'3g' is treated as "metered-ish"; '4g' is ambiguous
 *   (Wi-Fi AND good cellular) and is NOT treated as cellular. Safari provides
 *   nothing — the auto-cellular toggle never engages on WebKit. Honest
 *   limitation, surfaced in the Settings copy.
 *
 * `initNetworkMode()` is awaited in App.svelte's onMount BEFORE the Navidrome
 * load pipeline, so on native the boot gates every costly automatic request on
 * the real network state (the earlier boot steps are all local).
 */

export interface NetworkStatus {
  /** A authoritative or heuristic determination has been made. */
  known: boolean
  /** True only when the connection is plausibly cellular/metered. */
  isCellular: boolean
  /** The OS-level Low Data Mode flag (native iOS only). */
  osLowData: boolean
  /** 'native' = NWPathMonitor, 'web-hint' = Network Information API. */
  source: 'native' | 'web-hint'
}

const networkStatus = writable<NetworkStatus>({
  known: false,
  isCellular: false,
  osLowData: false,
  source: 'web-hint',
})

/** Test hook (the `__setScannerDeps` precedent): drives the networkStatus
 *  store directly so the derived-gate composition is pinned without faking
 *  Capacitor or the Network Information API. */
export function __setNetworkStatus(s: Partial<NetworkStatus>): void {
  networkStatus.update((cur) => ({ ...cur, ...s }))
}

/** Read-only view for consumers that need the raw status (Debug HUD). */
export const networkStatusStore = { subscribe: networkStatus.subscribe }

/**
 * The single gate every low-data consumer reads. Effective mode is the manual
 * toggle OR the cellular auto-toggle (when cellular is actually known) OR the
 * OS-level Low Data Mode flag (native). When `lowDataOnCellular` is on but the
 * platform cannot detect cellular, this stays false — it never guesses
 * toward engagement.
 */
export const effectiveLowData = derived(
  [settings, networkStatus],
  ([$settings, $net]) =>
    !!$settings.lowDataMode ||
    !!$settings.lowDataOnCellular && $net.known && $net.isCellular ||
    $net.osLowData,
)

const CELLULAR_EFFECTIVE_TYPES = new Set(['slow-2g', '2g', '3g'])

function applyWebHint(): void {
  try {
    const conn = (navigator as { connection?: { effectiveType?: string; addEventListener?: (t: string, l: () => void) => void; removeEventListener?: (t: string, l: () => void) => void } }).connection
    if (!conn?.effectiveType) return
    const update = () => {
      networkStatus.update((s) => ({
        ...s,
        known: true,
        isCellular: CELLULAR_EFFECTIVE_TYPES.has(conn.effectiveType ?? ''),
        source: 'web-hint',
      }))
    }
    update()
    conn.addEventListener?.('change', update)
  } catch { /* no Network Information API — stays known:false */ }
}

function wireNative(): void {
  if (!Capacitor.isNativePlatform()) return
  // Live updates while the app runs (Wi-Fi ↔ cellular transitions).
  void BackgroundAudio.addListener('networkStateChanged', (data: { isExpensive: boolean; isConstrained: boolean }) => {
    networkStatus.set({
      known: true,
      isCellular: !!data.isExpensive,
      osLowData: !!data.isConstrained,
      source: 'native',
    })
  }).catch(() => {})
}

/**
 * Boot wiring — awaited BEFORE the Navidrome load pipeline in App.svelte.
 * Native asks the plugin for the current NWPathMonitor snapshot (falls through
 * as `known:false` on any failure so boot is never blocked); web applies the
 * Network Information API hint if the browser exposes one.
 */
export async function initNetworkMode(): Promise<void> {
  wireNative()
  if (Capacitor.isNativePlatform()) {
    try {
      const state = await BackgroundAudio.getNetworkState()
      networkStatus.set({
        known: true,
        isCellular: !!state.isExpensive,
        osLowData: !!state.isConstrained,
        source: 'native',
      })
    } catch { /* older plugin build without the method — boot proceeds ungated */ }
    return
  }
  applyWebHint()
}

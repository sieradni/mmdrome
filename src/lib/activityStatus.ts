/**
 * Pure background-activity & connection status selector for the main library
 * views (Phase 1B of docs/plans/2026-10-18-holistic-polish-and-roadmap.md).
 *
 * Design contract (Rule C8 / minimal chrome):
 *  - Returns `null` when idle and healthy so the status strip takes ZERO
 *    height in normal browsing.
 *  - Precedence (highest urgency / active user-visible operation first):
 *    1. `pushing` — WebDAV file tag push in progress (`done/total`).
 *    2. `loading-library` — Navidrome connection check or song pagination in flight.
 *    3. `scanning` — WebDAV metadata scan in flight (`scanned/total`).
 *    4. `probing` — Background WebDAV tag probe reading identity tags (`done / done+remaining`).
 *    5. `cached-offline` — Library loaded from local cache because the connect
 *       failed (`cached: true` + connection error). The LABEL distinguishes the
 *       verdict: a rejected credential says so instead of claiming the device
 *       is offline (the same strip slot, a different truth).
 */

import type { ConnectFailure } from './authHealth'

export interface ActivityStatusInput {
  navChecking: boolean
  navLoading: boolean
  navCached?: boolean
  navError?: string
  /** The classified connect failure behind a cached fallback (`auth` says the
   *  credentials were rejected; absent/`unreachable` means the server could not
   *  be reached). */
  navFailure?: ConnectFailure
  scanStatus: 'idle' | 'scanning' | 'complete' | 'error'
  scanScanned: number
  scanTotal: number
  probeActive: boolean
  probeDone: number
  probeRemaining: number
  pushActive: boolean
  pushDone: number
  pushTotal: number
}

export type ActivityStatusKind =
  | 'pushing'
  | 'loading-library'
  | 'scanning'
  | 'probing'
  | 'cached-offline'

export interface ActivityStatus {
  kind: ActivityStatusKind
  label: string
  /** Optional [0..100] progress percentage; `null` = indeterminate spinner/pulse. */
  progressPct: number | null
  /** Target settings section when the user taps the status pill. */
  targetTab: 'sources' | 'library'
}

function clampPct(done: number, total: number): number | null {
  if (total <= 0) return null
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)))
}

export function deriveActivityStatus(input: ActivityStatusInput): ActivityStatus | null {
  if (input.pushActive) {
    const pct = clampPct(input.pushDone, input.pushTotal)
    const counts = input.pushTotal > 0 ? ` (${input.pushDone}/${input.pushTotal})` : ''
    return {
      kind: 'pushing',
      label: `Writing tags to files${counts}…`,
      progressPct: pct,
      targetTab: 'library',
    }
  }

  if (input.navChecking || input.navLoading) {
    return {
      kind: 'loading-library',
      label: input.navChecking ? 'Connecting to server…' : 'Loading library…',
      progressPct: null,
      targetTab: 'sources',
    }
  }

  if (input.scanStatus === 'scanning') {
    const pct = clampPct(input.scanScanned, input.scanTotal)
    const counts = input.scanTotal > 0 ? ` (${input.scanScanned}/${input.scanTotal})` : ''
    return {
      kind: 'scanning',
      label: `Scanning file tags${counts}…`,
      progressPct: pct,
      targetTab: 'library',
    }
  }

  if (input.probeActive) {
    const total = input.probeDone + input.probeRemaining
    const pct = clampPct(input.probeDone, total)
    const counts = total > 0 ? ` (${input.probeDone}/${total})` : ''
    return {
      kind: 'probing',
      label: `Reading file tags${counts}…`,
      progressPct: pct,
      targetTab: 'library',
    }
  }

  if (input.navCached && input.navError) {
    return {
      kind: 'cached-offline',
      label:
        input.navFailure === 'auth'
          ? 'Sign-in failed — browsing cached library'
          : 'Offline — browsing cached library',
      progressPct: null,
      targetTab: 'sources',
    }
  }

  return null
}

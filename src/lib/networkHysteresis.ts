/**
 * Pure flap-hysteresis for the network-mode gate (P5, 2026-09-23).
 *
 * Field evidence (2026-09-23 dump): NWPathMonitor re-fired the cellular bit
 * twice within ~6 s (`network exp=false → exp=true → exp=false`), and each
 * `effectiveLowData` flip re-derived EVERY consumer at once — transcode
 * rendition URLs for the playing track, preload tint economics, the native
 * `params` push (`ldm=cellular`), and `refreshQueue` fan-outs. A flap is a
 * server-side connectivity wobble, not a user decision; no consumer should
 * see it.
 *
 * Contract: a cellular-bit change must HOLD for FLAP_CONFIRM_MS before the
 * filtered value commits. The OS Low Data Mode bit (isConstrained) does NOT
 * ride this filter — it flips on an explicit user toggle, never flaps, and
 * is applied live by the caller. The boot snapshot (effective === null)
 * adopts the first raw value immediately so boot is never delayed.
 *
 * DOM-free, clock-injected — pinned by tests/networkHysteresis.test.ts.
 */

/** How long a raw change must hold before it commits. A NWPathMonitor blip
 *  resolves in well under a second; a genuine Wi-Fi↔cellular handoff lasts. */
export const FLAP_CONFIRM_MS = 3000

export interface NetworkHysteresisState {
  /** The filtered cellular bit. `null` = boot not yet seen (first raw value adopts immediately). */
  effective: boolean | null
  /** Pending candidate awaiting confirmation; null when idle. */
  candidate: boolean | null
  /** When the pending candidate FIRST appeared (a reversed blip restarts nothing — same candidate keeps its clock). */
  candidateAt: number | null
  /** Raw transitions that never survived confirmation (flap counter — dump-visible). */
  suppressed: number
}

export function freshNetworkHysteresis(): NetworkHysteresisState {
  return { effective: null, candidate: null, candidateAt: null, suppressed: 0 }
}

export interface FlapVerdict {
  /** The filtered value after this update. */
  effective: boolean
  /** True only when the filtered value CHANGED with this call — the only
   *  signal on which the caller may update consumers (that store write IS
   *  the churn the filter exists to prevent). */
  changed: boolean
  state: NetworkHysteresisState
}

export function decideCellularFlap(
  raw: boolean,
  now: number,
  state: NetworkHysteresisState,
): FlapVerdict {
  // Boot: adopt the first authoritative snapshot without confirmation.
  if (state.effective === null) {
    return {
      effective: raw,
      changed: true,
      state: { effective: raw, candidate: null, candidateAt: null, suppressed: state.suppressed },
    }
  }

  // Raw agrees with the filtered value: any pending candidate died (a blip
  // that reversed before confirming) — count it, go idle.
  if (raw === state.effective) {
    const cancelled = state.candidate !== null
    return {
      effective: state.effective,
      changed: false,
      state: {
        effective: state.effective,
        candidate: null,
        candidateAt: null,
        suppressed: state.suppressed + (cancelled ? 1 : 0),
      },
    }
  }

  // Raw differs. Same candidate still pending → let its original clock run;
  // commit once it has held long enough.
  if (state.candidate === raw && state.candidateAt !== null) {
    if (now - state.candidateAt >= FLAP_CONFIRM_MS) {
      return {
        effective: raw,
        changed: true,
        state: { effective: raw, candidate: null, candidateAt: null, suppressed: state.suppressed },
      }
    }
    return { effective: state.effective, changed: false, state }
  }

  // New (or restarted) candidate — start its confirmation window.
  return {
    effective: state.effective,
    changed: false,
    state: { ...state, candidate: raw, candidateAt: now },
  }
}

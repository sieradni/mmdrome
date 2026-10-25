import { derived } from 'svelte/store'
import { engine } from '../engineFacade'
import { eqBypassed, workingEq } from './eqStore'

/**
 * THE one place the EQ session reaches the audio engine.
 *
 * The working session is the single writable EQ state and `applyEq` is the
 * single engine-facing write, so the two are joined HERE — by a subscription,
 * not by the callers. Every transition (a slider edit, a preset switch, an
 * import, Reset All, deleting the active preset) and every bypass flip lands
 * in this one subscription, so no handler can apply the state it forgot to
 * push: the 2026-10 audit found a preset switch that moved the sliders and the
 * store while the engine kept the previous preset until the next track load —
 * and on iOS until relaunch, because the native push only ran at boot.
 *
 * Store subscriptions fire synchronously on `set`, so the engine still follows
 * a drag instantly; the persistence leg (eqStore) stays the only debounced
 * part. The derived store also gives the BOOT push: subscribing runs it once
 * with the restored session, which is what replaced `pushNativeEqFromStore`.
 */
const engineEq = derived([workingEq, eqBypassed], ([$session, $bypassed]) => ({
  state: $session.state,
  bypassed: $bypassed,
}))

let stop: (() => void) | null = null

/** Install the session → engine subscription (idempotent; returns a teardown
 *  for tests). Called once at boot, AFTER the native engine is engaged and the
 *  EQ session is restored. */
export function startEqEngineSync(): () => void {
  if (stop) return stop
  const unsubscribe = engineEq.subscribe(({ state, bypassed }) => engine.applyEq(state, bypassed))
  stop = () => {
    unsubscribe()
    stop = null
  }
  return stop
}

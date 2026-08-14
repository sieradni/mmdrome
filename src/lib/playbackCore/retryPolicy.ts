/**
 * Pure exponential-backoff retry policy — ONE machine for the three (plus a
 * hidden fourth) retry paths in playbackManager (TODO 1.0 Step 1).
 *
 * The current code has: web `WebTransport` (cap 3, 1s/2s/4s), native
 * `NativeTransport` (cap 2, 1s/2s), background (zero — a bg load failure just
 * idles), and the play()-rejection loop inside `_loadAndPlay` (cap 3, 1s/2s,
 * different delay shape — deliberately NOT modeled here: an autoplay-policy
 * rejection is not fixed by backoff, it needs a user gesture).
 *
 * This class is deliberately stateful-but-pure: no timers, no callbacks, no
 * trackId — the adapter owns the setTimeout, the track-keyed validity check
 * (a stale retry timer must not fire for a changed track — `reset()` on any
 * advance/track change) and the give-up action (web: error-driven advance;
 * native: queue end; bg: nothing).
 *
 * Delay: `backoffBase^(attempt-1) * baseDelayMs` — web (3, 1000) yields
 * 1000/2000/4000 then give-up; native (2, 1000) yields 1000/2000 then
 * give-up; bg (0, _) gives up on the first error.
 */

export interface RetryPolicyConfig {
  /** Retries before give-up (web 3, native 2, bg 0). */
  maxAttempts: number
  /** Delay of the first retry in ms. */
  baseDelayMs: number
  /** Exponential factor; default 2 → 1s, 2s, 4s… */
  backoffBase?: number
}

export type RetryDecision =
  | { kind: 'retry'; attempt: number; delayMs: number }
  | { kind: 'give-up' }

export class RetryPolicy {
  private readonly config: RetryPolicyConfig
  private _attempts = 0

  constructor(config: RetryPolicyConfig) {
    this.config = config
  }

  /** The number of errors recorded since the last reset. */
  get attemptCount(): number {
    return this._attempts
  }

  /** Records an error and returns the decision: retry with the backoff delay
   *  for this attempt, or give up when the cap is exceeded. */
  onError(): RetryDecision {
    this._attempts++
    if (this._attempts > this.config.maxAttempts) {
      return { kind: 'give-up' }
    }
    const base = this.config.backoffBase ?? 2
    const delayMs = Math.pow(base, this._attempts - 1) * this.config.baseDelayMs
    return { kind: 'retry', attempt: this._attempts, delayMs }
  }

  /** Clears the attempt count — call on any successful advance, track change,
   *  or manual control so a stale error can never consume the next attempt. */
  reset(): void {
    this._attempts = 0
  }
}
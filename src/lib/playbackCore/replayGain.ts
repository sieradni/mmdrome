/**
 * Pure replay-gain field computation (TODO 1.0 Step 2) — extracts the inline
 * mode × gain math from `playbackManager._setupNextTrack`. The result feeds:
 *  - `linearGain` — the standby node gain at crossfade arm time (AGENTS.md A7
 *    semantics: null when mode is off or the active mode's gain is missing —
 *    the engine falls back to 1);
 *  - `trackGainDb`/`albumGainDb` — the RAW dB values, re-applied by the
 *    transport after a crossfade switch (1.10-3: the engine's current-gain
 *    fields would otherwise keep the OLD track's values, so a later mode
 *    change re-applies stale gain to the new active element). The engine
 *    picks track/album per its mode, so both are always carried raw.
 */

import type { ReplayGainFields } from './types'

export type ReplayGainMode = 'off' | 'track' | 'album'

export interface ReplayGainTrack {
  replayGain?: number | null
  albumReplayGain?: number | null
}

export function computeReplayGainFields(mode: ReplayGainMode, track: ReplayGainTrack | undefined): ReplayGainFields {
  const trackGainDb = track?.replayGain ?? null
  const albumGainDb = track?.albumReplayGain ?? null
  let linearGain: number | null = null
  if (mode === 'track' && trackGainDb !== null && isFinite(trackGainDb)) {
    linearGain = Math.pow(10, trackGainDb / 20)
  } else if (mode === 'album' && albumGainDb !== null && isFinite(albumGainDb)) {
    linearGain = Math.pow(10, albumGainDb / 20)
  }
  return { linearGain, trackGainDb, albumGainDb }
}
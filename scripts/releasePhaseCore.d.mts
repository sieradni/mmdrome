/** Types for scripts/releasePhaseCore.mjs (pure phase-derivation core for
 *  the resumable release driver). Hand-written pair for the .mjs module so
 *  the strict test config can import it without enabling allowJs. */

export type PhaseName = 'preflight' | 'gates' | 'bump' | 'branch-ci' | 'tag' | 'verify' | 'done'

export interface ReleaseFacts {
  cleanTree: boolean
  pkgVersion: string
  targetVersion: string
  tagExists: boolean
  headPushed: boolean
  branchCiGreen: boolean | null
  tagRunGreen: boolean | null
  releasePublished: boolean
  assetSize: number | null
  manifestState: ManifestState
  surfacesCurrent: boolean
  gatesRanForHead: boolean
}

export type ManifestState = 'correct' | 'absent' | 'sizeless' | 'wrong-size'

export interface PhaseDecision {
  phase: PhaseName
  reason: string
}

export declare const PHASE_ORDER: readonly string[]

export declare function compareVersions(pkgVersion: string, targetVersion: string): 'greater' | 'equal' | 'lower'

export declare function manifestBackfillState(
  entry: { version: string; size?: number } | undefined,
  version: string,
  assetSize: number,
): ManifestState

export declare function deriveReleasePhase(f: ReleaseFacts): PhaseDecision

export declare function stateRecordValid(record: { sha?: string } | undefined, currentSha: string): boolean

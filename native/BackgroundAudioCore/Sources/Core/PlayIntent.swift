import Foundation

/// Pure play-intent decisions for a stalled staged schedule (2026-10-07,
/// Phase 1 of `docs/plans/2026-10-07-seek-intent-and-stream-epochs.md`).
///
/// The reported bug: a scrub into a region the stream has not delivered parks
/// the staged schedule in the buffering stall and clears `hasLiveSchedule`.
/// `play()` tested `!hasLiveSchedule` BEFORE the stall-resume branch and
/// restarted the whole row at 0:00 — the stalled position WAS the intent, and
/// the ordering threw it away.
///
/// This core pins the ordering: a resumable staged stall is consulted BEFORE
/// the no-schedule restart, so no future edit can re-order the checks
/// silently. It also names the parked-seek application: a seek that landed
/// before any schedule could be made is applied by the FIRST schedule that
/// can be made for the row.
///
/// Dependency-free, `swift test`-hostable (E5: CI compiles and tests the core).
public enum PlayIntent {

    /// What `play()` must do, decided purely from engine state.
    public enum Action: Equatable {
        /// The engine is parked at the end of a track by the sleep timer:
        /// advance instead of resuming.
        case advanceAfterSleepPause
        /// A staged schedule is sitting in the buffering stall: re-schedule
        /// from the stalled position. MUST be tested before `.restartTrack`.
        case resumeStagedStall
        /// No schedule exists at all: (re)start the current row.
        case restartTrack
        /// A param change happened while paused: restart via a fresh schedule
        /// so the new speed/pitch actually take effect.
        case restartForParams
        /// Plain resume of the live schedule.
        case plainResume
    }

    /// The engine-state inputs the decision reads (a plain value so the
    /// ordering matrix is unit-testable).
    public struct State: Equatable {
        public var waitingAtTrackEnd: Bool
        /// `stagedSchedule?.isStalled == true && stagedSourceURL != nil`.
        public var stagedStallResumable: Bool
        public var hasLiveSchedule: Bool
        public var paramsDirty: Bool

        public init(
            waitingAtTrackEnd: Bool,
            stagedStallResumable: Bool,
            hasLiveSchedule: Bool,
            paramsDirty: Bool
        ) {
            self.waitingAtTrackEnd = waitingAtTrackEnd
            self.stagedStallResumable = stagedStallResumable
            self.hasLiveSchedule = hasLiveSchedule
            self.paramsDirty = paramsDirty
        }
    }

    /// THE Phase-1 decision. Order matters and is pinned by tests:
    /// sleep park → staged stall → no-schedule restart → params → plain.
    public static func decide(_ state: State) -> Action {
        if state.waitingAtTrackEnd { return .advanceAfterSleepPause }
        // A stalled staged position is a POSITION, not an absence of
        // schedule — this check MUST precede `.restartTrack`.
        if state.stagedStallResumable { return .resumeStagedStall }
        if !state.hasLiveSchedule { return .restartTrack }
        if state.paramsDirty { return .restartForParams }
        return .plainResume
    }

    /// The position a row's FIRST schedule must start from (Phase 1): a seek
    /// that landed before any source could be scheduled is parked by the
    /// engine and applied here, instead of being dropped to 0 (or reported as
    /// "Track not ready" → JS retry → reload from 0).
    public static func firstScheduleStartSeconds(pendingSeekSeconds: Double?) -> Double {
        max(0, pendingSeekSeconds ?? 0)
    }
}

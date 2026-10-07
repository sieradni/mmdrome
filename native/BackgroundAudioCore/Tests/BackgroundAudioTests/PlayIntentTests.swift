import Foundation
import XCTest
@testable import BackgroundAudioCore

final class PlayIntentTests: XCTestCase {

    // MARK: - Ordering (the reported reset-to-0 root cause)

    /// THE Phase-1 pin: a stalled staged schedule with NO live schedule must
    /// resume the stall — never restart the row at 0. The old `play()`
    /// consulted `!hasLiveSchedule` first, which is exactly the bug.
    func testStalledStagedResumeBeatsTheNoScheduleRestart() {
        let state = PlayIntent.State(
            waitingAtTrackEnd: false,
            stagedStallResumable: true,
            hasLiveSchedule: false,
            paramsDirty: false)
        XCTAssertEqual(PlayIntent.decide(state), .resumeStagedStall)
    }

    /// A stalled schedule resumed by `scheduleCurrentTrack` re-applies the
    /// playback params itself, so a dirty param change must not divert the
    /// resume into a track restart.
    func testStalledStagedResumeBeatsADirtyParamChange() {
        let state = PlayIntent.State(
            waitingAtTrackEnd: false,
            stagedStallResumable: true,
            hasLiveSchedule: true,
            paramsDirty: true)
        XCTAssertEqual(PlayIntent.decide(state), .resumeStagedStall)
    }

    /// The sleep park stays the first check: it must not be swallowed by a
    /// lingering staged stall.
    func testSleepParkBeatsEverything() {
        let state = PlayIntent.State(
            waitingAtTrackEnd: true,
            stagedStallResumable: true,
            hasLiveSchedule: false,
            paramsDirty: true)
        XCTAssertEqual(PlayIntent.decide(state), .advanceAfterSleepPause)
    }

    func testNoScheduleWithNoStallRestartsTheRow() {
        let state = PlayIntent.State(
            waitingAtTrackEnd: false,
            stagedStallResumable: false,
            hasLiveSchedule: false,
            paramsDirty: false)
        XCTAssertEqual(PlayIntent.decide(state), .restartTrack)
    }

    /// A dirty param change with a live schedule restarts via a fresh
    /// schedule (the resume must apply the new speed/pitch).
    func testDirtyParamsRestartOnlyWithALiveSchedule() {
        let dirty = PlayIntent.State(
            waitingAtTrackEnd: false,
            stagedStallResumable: false,
            hasLiveSchedule: true,
            paramsDirty: true)
        XCTAssertEqual(PlayIntent.decide(dirty), .restartForParams)

        let clean = PlayIntent.State(
            waitingAtTrackEnd: false,
            stagedStallResumable: false,
            hasLiveSchedule: true,
            paramsDirty: false)
        XCTAssertEqual(PlayIntent.decide(clean), .plainResume)
    }

    // MARK: - Parked seek (the first schedule honors the intent)

    func testFirstScheduleStartUsesTheParkedSeek() {
        XCTAssertEqual(PlayIntent.firstScheduleStartSeconds(pendingSeekSeconds: 87.5), 87.5)
        XCTAssertEqual(PlayIntent.firstScheduleStartSeconds(pendingSeekSeconds: nil), 0)
        // A negative/nonsense park can never rewind past the file start.
        XCTAssertEqual(PlayIntent.firstScheduleStartSeconds(pendingSeekSeconds: -3), 0)
    }
}

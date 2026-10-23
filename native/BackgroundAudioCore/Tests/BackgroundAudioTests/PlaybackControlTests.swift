import XCTest
@testable import BackgroundAudioCore

final class PlaybackControlTests: XCTestCase {
    func testPauseSupersedesRecoveryButKeepsTheDownloadedBytesOwned() {
        var control = PlaybackControl()
        control.replace(playing: true)
        let download = control.lease
        let recovery = control.lease
        control.request(playing: false)
        XCTAssertFalse(control.permits(recovery))
        XCTAssertTrue(control.ownsSession(download))
        XCTAssertFalse(control.mayRender)
        // The file completion can schedule paused without discarding bytes.
        control.request(playing: true)
        XCTAssertTrue(control.mayRender)
        XCTAssertTrue(control.ownsSession(download))
        XCTAssertFalse(control.permits(recovery), "new Play must not revive an old timer")
        XCTAssertTrue(control.permits(control.lease))
    }

    func testReplacementAndTeardownInvalidateEvenAnotherCopyOfTheSameSong() {
        var control = PlaybackControl()
        control.replace(playing: true)
        let firstCopy = control.lease
        control.replace(playing: true)
        XCTAssertFalse(control.ownsSession(firstCopy))
        let secondCopy = control.lease
        control.stop()
        XCTAssertFalse(control.ownsSession(secondCopy))
        XCTAssertFalse(control.desiredPlaying)
        XCTAssertFalse(control.mayRender)
    }

    func testInterruptionPreservesPendingPlayButExplicitPauseAlwaysWins() {
        var control = PlaybackControl()
        control.replace(playing: true) // buffering/failed-start, no rendering required
        control.beginInterruption()
        control.beginInterruption() // duplicate begin must not replace snapshot
        XCTAssertTrue(control.desiredPlaying)
        XCTAssertFalse(control.mayRender)
        control.request(playing: false)
        XCTAssertFalse(control.endInterruption(shouldResume: true))
        XCTAssertFalse(control.desiredPlaying)
        XCTAssertFalse(control.endInterruption(shouldResume: true))
    }

    func testInterruptionPermissionAndNewerPlayHaveDifferentOwnership() {
        var control = PlaybackControl()
        control.replace(playing: true)
        control.beginInterruption()
        XCTAssertFalse(control.endInterruption(shouldResume: false))
        XCTAssertFalse(control.desiredPlaying)
        control.beginInterruption()
        control.request(playing: true) // deliberate command, not automatic resume
        XCTAssertTrue(control.endInterruption(shouldResume: false))
        control.beginInterruption()
        XCTAssertTrue(control.endInterruption(shouldResume: true))
    }

    func testIdleInterruptionAndStaleFlagClearNeverInventPlay() {
        var control = PlaybackControl()
        control.beginInterruption()
        XCTAssertFalse(control.endInterruption(shouldResume: true))
        control.replace(playing: true)
        control.beginInterruption()
        control.request(playing: false)
        control.clearStaleInterruption()
        XCTAssertFalse(control.mayRender)
        XCTAssertFalse(control.endInterruption(shouldResume: true))
    }

    func testStopAndNewOccurrenceDuringInterruptionDoNotRestoreOldIntent() {
        var control = PlaybackControl()
        control.replace(playing: true)
        control.beginInterruption()
        control.stop()
        XCTAssertFalse(control.endInterruption(shouldResume: true))
        control.beginInterruption()
        control.replace(playing: false)
        XCTAssertFalse(control.endInterruption(shouldResume: true))
    }

    func testAutomaticGraphStartsWaitForInterruptionPermissionButExplicitPlayMayProbe() {
        var control = PlaybackControl()
        XCTAssertFalse(control.mayAttemptStart(explicitPlay: true))
        control.replace(playing: true)
        XCTAssertTrue(control.mayAttemptStart(explicitPlay: false))
        control.beginInterruption()
        XCTAssertFalse(control.mayAttemptStart(explicitPlay: false), "configuration notifications cannot steal the session")
        XCTAssertTrue(control.mayAttemptStart(explicitPlay: true), "a deliberate Play may prove a missing OS end stale")
        control.request(playing: false)
        XCTAssertFalse(control.mayAttemptStart(explicitPlay: true), "reactivation never invents Play intent")
        XCTAssertFalse(control.endInterruption(shouldResume: true))
        XCTAssertFalse(control.mayAttemptStart(explicitPlay: false))
    }

    func testCommandInterpreterPublishesEveryAcceptedCommandIncludingNoOps() {
        var desired = false
        var effects: [PlaybackCommand] = []
        var publicationStates: [Bool] = []
        func issue(_ command: PlaybackCommand) {
            let result = PlaybackCommandInterpreter.perform(command,
                hasContent: true, desiredPlaying: desired,
                execute: { semantic in
                    effects.append(semantic)
                    switch semantic {
                    case .play: desired = true
                    case .pause: desired = false
                    default: break
                    }
                }, publish: { publicationStates.append(desired) })
            XCTAssertEqual(result, .accepted)
        }
        issue(.play)
        issue(.play) // explicit Play never toggles
        issue(.toggle) // pending Play, still not rendering -> Pause
        issue(.pause) // no-op must repair system metadata too
        issue(.toggle)
        XCTAssertEqual(effects, [.play, .play, .pause, .pause, .play])
        XCTAssertEqual(publicationStates, [true, true, false, false, true])
    }

    func testRejectedCommandsNeverExecuteOrPublish() {
        var executions = 0
        var publications = 0
        let commands: [PlaybackCommand] = [.play, .pause, .toggle, .next, .previous, .seek(12)]
        for command in commands {
            XCTAssertEqual(PlaybackCommandInterpreter.perform(command,
                hasContent: false, desiredPlaying: false,
                execute: { _ in executions += 1 }, publish: { publications += 1 }), .noContent)
        }
        for position in [-1.0, Double.nan, Double.infinity] {
            XCTAssertEqual(PlaybackCommandInterpreter.perform(.seek(position),
                hasContent: true, desiredPlaying: true,
                execute: { _ in executions += 1 }, publish: { publications += 1 }), .invalid)
        }
        XCTAssertEqual(executions, 0)
        XCTAssertEqual(publications, 0)
    }

    func testAcceptedPlayCanRemainPendingWithoutBeingReportedAsRendering() {
        var control = PlaybackControl()
        control.replace(playing: false)
        var rendering = false
        var assignedRate = 1.0
        XCTAssertEqual(PlaybackCommandInterpreter.perform(.play,
            hasContent: true, desiredPlaying: control.desiredPlaying,
            execute: { _ in control.request(playing: true) },
            publish: { assignedRate = rendering ? 1 : 0 }), .accepted)
        XCTAssertTrue(control.desiredPlaying)
        XCTAssertEqual(assignedRate, 0)
        let oldRetry = control.lease
        PlaybackCommandInterpreter.perform(.pause,
            hasContent: true, desiredPlaying: control.desiredPlaying,
            execute: { _ in control.request(playing: false); rendering = false },
            publish: { assignedRate = rendering ? 1 : 0 })
        XCTAssertFalse(control.permits(oldRetry))
        XCTAssertEqual(assignedRate, 0)
    }

    func testSourceCallbacksSurvivePauseSeekAndRebuildButNotReplacementLoadOrEpoch() {
        var control = PlaybackControl()
        control.replace(playing: true)
        let fullDownload = control.beginSource()
        control.request(playing: false)
        XCTAssertTrue(control.ownsSource(fullDownload))
        XCTAssertFalse(control.mayRender)
        control.request(playing: true)
        XCTAssertTrue(control.ownsSource(fullDownload), "node reschedules/rebuilds do not replace byte ownership")
        let epoch = control.beginSource()
        XCTAssertFalse(control.ownsSource(fullDownload))
        XCTAssertTrue(control.ownsSource(epoch))
        control.replace(playing: true) // same song, another occurrence
        XCTAssertFalse(control.ownsSource(epoch))
        let replacement = control.beginSource()
        control.stop()
        XCTAssertFalse(control.ownsSource(replacement))
    }

    func testDelayedEffectsWithFakeClockCannotResumeAfterPauseOrNewSession() {
        var control = PlaybackControl()
        control.replace(playing: true)
        let bytes = control.beginSource()
        let recovery = control.lease
        var now = 0.0
        var effects: [String] = []
        let callbacks: [(at: Double, run: () -> Void)] = [
            (0.5, { if control.permits(recovery) { effects.append("recover") } }),
            (1.0, { if control.ownsSource(bytes) { effects.append(control.mayRender ? "schedule-playing" : "schedule-paused") } }),
            (1.5, { if control.permits(recovery) { effects.append("retry") } })]
        control.request(playing: false)
        now = 1
        for callback in callbacks where callback.at <= now { callback.run() }
        XCTAssertEqual(effects, ["schedule-paused"])
        control.request(playing: true)
        now = 2
        for callback in callbacks where callback.at > 1 && callback.at <= now { callback.run() }
        XCTAssertEqual(effects, ["schedule-paused"], "new Play cannot revive superseded timers")
        control.replace(playing: true)
        XCTAssertFalse(control.ownsSource(bytes))
    }

    func testManyPausePlayAndCompletionOrdersAlwaysRespectLatestIntent() {
        // Exhaustive short traces: completions are observations, never commands.
        for mask in 0..<256 {
            var control = PlaybackControl()
            control.replace(playing: true)
            let bytes = control.lease
            var expected = true
            for step in 0..<8 {
                expected = mask & (1 << step) != 0
                control.request(playing: expected)
                XCTAssertEqual(control.mayRender, expected)
                XCTAssertTrue(control.ownsSession(bytes))
                // A completion may read live permission but must never set it.
                let permissionAtCompletion = control.mayRender
                XCTAssertEqual(permissionAtCompletion, expected)
            }
            control.stop()
            XCTAssertFalse(control.ownsSession(bytes))
        }
    }
}

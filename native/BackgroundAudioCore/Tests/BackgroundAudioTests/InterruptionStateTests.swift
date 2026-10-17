import XCTest
@testable import BackgroundAudioCore

final class InterruptionStateTests: XCTestCase {
    func testDuplicateBeginPreservesOriginalResumeIntent() {
        var state = InterruptionState()
        XCTAssertTrue(state.begin(isPlaying: true))
        XCTAssertFalse(state.begin(isPlaying: false))
        XCTAssertTrue(state.end(shouldResume: true))
        XCTAssertFalse(state.end(shouldResume: true))
    }

    func testIdleAndDeniedResumeStayIdle() {
        var state = InterruptionState()
        XCTAssertTrue(state.begin(isPlaying: false))
        XCTAssertFalse(state.end(shouldResume: true))
        XCTAssertTrue(state.begin(isPlaying: true))
        XCTAssertFalse(state.end(shouldResume: false))
        XCTAssertTrue(state.begin(isPlaying: true))
        state.clear()
        XCTAssertFalse(state.end(shouldResume: true))
    }
}

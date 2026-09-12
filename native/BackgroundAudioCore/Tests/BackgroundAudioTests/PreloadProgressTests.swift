import XCTest
@testable import BackgroundAudioCore

/// Pins the pure diff-machine behind the native preload-progress events
/// (webview parity with the web preloader's PreloadEvent stream). The
/// engine's 1 s sampler calls `PreloadProgress.event(lastEmitted:observed:)`
/// per track; these tests pin which observations become bridge events.
final class PreloadProgressTests: XCTestCase {
    private func fetching(_ p: Double?) -> PreloadProgress {
        PreloadProgress(state: "fetching", progress: p)
    }

    func testFirstFetchingObservationEmits() {
        XCTAssertNotNil(PreloadProgress.event(lastEmitted: nil, observed: fetching(0.05)))
        // Indeterminate first observation (no Content-Length) also opens.
        XCTAssertNotNil(PreloadProgress.event(lastEmitted: nil, observed: fetching(nil)))
    }

    func testUnchangedFetchingSnapshotIsSilent() {
        let last = PreloadProgress(state: "fetching", progress: 0.4)
        // Identical read → nil (the common case on a stalled/small download).
        XCTAssertNil(PreloadProgress.event(lastEmitted: last, observed: fetching(0.4)))
        // Sub-1% jitter → nil (no bridge chatter).
        XCTAssertNil(PreloadProgress.event(lastEmitted: last, observed: fetching(0.404)))
    }

    func testIndeterminateToDeterminateEmits() {
        let last = PreloadProgress(state: "fetching", progress: nil)
        XCTAssertNotNil(PreloadProgress.event(lastEmitted: last, observed: fetching(0.1)))
    }

    func testDeterminateToIndeterminateEmits() {
        let last = PreloadProgress(state: "fetching", progress: 0.5)
        XCTAssertNotNil(PreloadProgress.event(lastEmitted: last, observed: fetching(nil)))
    }

    func testProgressAboveWindowEmits() {
        let last = PreloadProgress(state: "fetching", progress: 0.4)
        XCTAssertNotNil(PreloadProgress.event(lastEmitted: last, observed: fetching(0.41)))
        XCTAssertNotNil(PreloadProgress.event(lastEmitted: last, observed: fetching(0.9)))
    }

    func testCachedAlwaysEmitsWhenDifferent() {
        let last = PreloadProgress(state: "fetching", progress: 0.9)
        let cached = PreloadProgress(state: "cached", progress: 1.0)
        XCTAssertEqual(PreloadProgress.event(lastEmitted: last, observed: cached), cached)
        // A repeated `cached` (defensive) is silent.
        XCTAssertNil(PreloadProgress.event(lastEmitted: cached, observed: cached))
    }

    func testGoneAlwaysEmitsWhenDifferent() {
        let last = PreloadProgress(state: "fetching", progress: 0.5)
        XCTAssertEqual(
            PreloadProgress.event(lastEmitted: last, observed: PreloadProgress(state: "gone", progress: nil)),
            PreloadProgress(state: "gone", progress: nil)
        )
        // Repeated gone is silent.
        XCTAssertNil(PreloadProgress.event(
            lastEmitted: PreloadProgress(state: "gone", progress: nil),
            observed: PreloadProgress(state: "gone", progress: nil)
        ))
    }

    func testCachedToFetchingReopenEmits() {
        // An upgrade re-download reopens a previously cached track.
        let cached = PreloadProgress(state: "cached", progress: 1.0)
        XCTAssertNotNil(PreloadProgress.event(lastEmitted: cached, observed: fetching(0.0)))
    }
}

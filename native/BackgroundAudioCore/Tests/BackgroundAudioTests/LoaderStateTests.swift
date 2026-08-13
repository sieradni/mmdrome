import Foundation
import XCTest
@testable import BackgroundAudioCore

final class LoaderStateTests: XCTestCase {

    func testClaimRefusesDuplicates() {
        var s = LoaderState<Int>()
        XCTAssertTrue(s.claim("a", task: 1))
        XCTAssertFalse(s.claim("a", task: 2))
        XCTAssertTrue(s.isActive("a"))
        XCTAssertNil(s.cached("a"))
    }

    func testChainAndComplete() {
        var s = LoaderState<Int>()
        _ = s.claim("a", task: 1)
        s.chain("a", { _, _ in })
        s.chain("a", { _, _ in })
        XCTAssertEqual(s.pendingCount(for: "a"), 2)
        let fired = s.complete("a")
        XCTAssertEqual(fired.count, 2)
        XCTAssertEqual(s.pendingCount(for: "a"), 0)
        XCTAssertFalse(s.isActive("a"))
        // A second complete finds nothing pending — no double-fire.
        XCTAssertEqual(s.complete("a").count, 0)
    }

    func testCompleteFiresInChainOrder() {
        var s = LoaderState<Int>()
        _ = s.claim("a", task: 1)
        var order: [Int] = []
        s.chain("a", { _, _ in order.append(1) })
        s.chain("a", { _, _ in order.append(2) })
        _ = s.complete("a")
        XCTAssertEqual(order, [1, 2])
    }

    func testStoreAndCached() {
        var s = LoaderState<Int>()
        XCTAssertNil(s.cached("a"))
        s.store(URL(fileURLWithPath: "/tmp/x"), for: "a")
        XCTAssertEqual(s.cached("a"), URL(fileURLWithPath: "/tmp/x"))
    }

    func testEvictClearsAll() {
        var s = LoaderState<Int>()
        _ = s.claim("a", task: 1)
        s.chain("a", { _, _ in })
        s.store(URL(fileURLWithPath: "/tmp/x"), for: "a")
        let (task, url) = s.evict("a")
        XCTAssertEqual(task, 1)
        XCTAssertEqual(url, URL(fileURLWithPath: "/tmp/x"))
        XCTAssertFalse(s.isActive("a"))
        XCTAssertNil(s.cached("a"))
        XCTAssertEqual(s.pendingCount(for: "a"), 0)
    }

    func testFullCycle() {
        var s = LoaderState<Int>()
        _ = s.claim("a", task: 1)
        s.chain("a", { _, _ in })
        s.store(URL(fileURLWithPath: "/tmp/cached"), for: "b")
        _ = s.complete("a")
        // Cached track is re-prefetchable while the download for `a` is gone.
        XCTAssertFalse(s.isActive("a"))
        XCTAssertEqual(s.cached("b"), URL(fileURLWithPath: "/tmp/cached"))
        XCTAssertTrue(s.claim("a", task: 2))
    }
}
import Foundation
import XCTest
@testable import BackgroundAudioCore

final class EventLogTests: XCTestCase {

    func testSeqIsMonotonicAcrossAdditions() {
        var log = NativeEventLog(capacity: 10)
        log.add(now: 1, domain: "engine", level: .info, "a")
        log.add(now: 2, domain: "engine", level: .info, "b")
        log.add(now: 3, domain: "engine", level: .danger, "c")
        XCTAssertEqual(log.events.map(\.seq), [0, 1, 2])
        XCTAssertEqual(log.nextSeq, 3)
        XCTAssertEqual(log.events.map(\.message), ["a", "b", "c"])
    }

    func testRingEvictsOldestAndCountsDropped() {
        var log = NativeEventLog(capacity: 3)
        for i in 0..<5 { log.add(now: Double(i), domain: "engine", level: .info, "e\(i)") }
        XCTAssertEqual(log.events.map(\.message), ["e2", "e3", "e4"])
        XCTAssertEqual(log.events.map(\.seq), [2, 3, 4])
        XCTAssertEqual(log.droppedCount, 2)
        // nextSeq survives eviction: the watermark never re-issues a seq.
        XCTAssertEqual(log.nextSeq, 5)
    }

    func testDebugLevelIsDomainGatedAtWriteTime() {
        var log = NativeEventLog(capacity: 10, activeDomains: [])
        log.add(now: 1, domain: "loader", level: .debug, "verbose")
        XCTAssertTrue(log.events.isEmpty, "inactive domain must not record (write-time gate)")

        log.setActiveDomains(["loader"])
        log.add(now: 2, domain: "loader", level: .debug, "verbose")
        XCTAssertEqual(log.events.count, 1)
        XCTAssertEqual(log.nextSeq, 1, "the dropped call must not consume a seq")
    }

    func testDangerAndInfoAlwaysRecordRegardlessOfDomains() {
        var log = NativeEventLog(capacity: 10, activeDomains: [])
        log.add(now: 1, domain: "engine", level: .danger, "gate verdict")
        log.add(now: 2, domain: "crossfade", level: .info, "transition")
        XCTAssertEqual(log.events.map(\.level), [.danger, .info])
    }

    func testSinceSeqReturnsOnlyNewerEvents() {
        var log = NativeEventLog(capacity: 10)
        for i in 0..<4 { log.add(now: Double(i), domain: "engine", level: .info, "e\(i)") }
        XCTAssertEqual(log.events(sinceSeq: 1).map(\.seq), [2, 3])
        XCTAssertEqual(log.events(sinceSeq: -1).map(\.seq), [0, 1, 2, 3])
        XCTAssertTrue(log.events(sinceSeq: 3).isEmpty)
    }

    func testSinceSeqLimitCapsFromTheNewestSide() {
        var log = NativeEventLog(capacity: 10)
        for i in 0..<5 { log.add(now: Double(i), domain: "engine", level: .info, "e\(i)") }
        let capped = log.events(sinceSeq: -1, limit: 2)
        XCTAssertEqual(capped.map(\.message), ["e3", "e4"], "a first full pull must return the newest rows, not the oldest")
    }

    func testEvictedEntriesAreNeverReturnedBySinceSeq() {
        var log = NativeEventLog(capacity: 2)
        for i in 0..<4 { log.add(now: Double(i), domain: "engine", level: .info, "e\(i)") }
        // seqs 0,1 were evicted; the watermark holder still asks sinceSeq: 0.
        XCTAssertEqual(log.events(sinceSeq: 0).map(\.seq), [2, 3])
    }
}

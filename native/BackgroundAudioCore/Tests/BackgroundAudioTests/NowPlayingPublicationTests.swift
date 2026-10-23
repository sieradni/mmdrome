import XCTest
@testable import BackgroundAudioCore

final class NowPlayingPublicationTests: XCTestCase {
    private func snapshot(_ id: String = "song", entry: String = "user:song", position: Double = 37, playing: Bool = true, speed: Double = 1.25) -> NowPlayingPublication.Snapshot {
        .init(trackId: id, entryId: entry, position: position, playing: playing, speed: speed)
    }

    func testPauseThenArtworkCannotRestoreOlderRateOrPosition() {
        var publication = NowPlayingPublication()
        publication.publish(snapshot(), publisher: "command:app-bridge", now: 1)
        let paused = snapshot(position: 41.5, playing: false)
        publication.publish(paused, publisher: "command:remote-command", now: 2)
        XCTAssertTrue(publication.permitsArtwork(trackId: "song"))
        publication.publish(publication.snapshot, publisher: "artwork", now: 3)
        XCTAssertEqual(publication.snapshot, paused)
        XCTAssertEqual(publication.snapshot?.rate, 0)
        XCTAssertEqual(publication.snapshot?.position, 41.5)
        XCTAssertEqual(publication.snapshot?.defaultRate, 1.25)
        XCTAssertEqual(publication.revision, 3)
    }

    func testClearResetsStateAndRejectsLateArtworkWithoutResurrection() {
        var publication = NowPlayingPublication()
        publication.publish(snapshot(), publisher: "state", now: 1)
        publication.publish(nil, publisher: "clear", now: 2)
        XCTAssertFalse(publication.permitsArtwork(trackId: "song"))
        XCTAssertNil(publication.snapshot)
        XCTAssertEqual(publication.staleArtwork, 1)
        publication.publish(snapshot("next", entry: "user:next", playing: false), publisher: "state", now: 3)
        XCTAssertFalse(publication.permitsArtwork(trackId: "song"))
        XCTAssertEqual(publication.snapshot?.rate, 0)
        XCTAssertEqual(publication.snapshot?.trackId, "next")
    }

    func testTimerPublishesPositionButSuppressesTranscriptNoise() {
        var publication = NowPlayingPublication()
        XCTAssertTrue(publication.publish(snapshot(), publisher: "state", now: 0))
        for tick in 1...1000 {
            XCTAssertFalse(publication.publish(snapshot(position: Double(tick)), publisher: "timer", now: Double(tick)))
        }
        XCTAssertEqual(publication.revision, 1001)
        XCTAssertEqual(publication.suppressedTicks, 1000)
        XCTAssertEqual(publication.snapshot?.position, 1000)
        XCTAssertTrue(publication.publish(snapshot(position: 1000, playing: false), publisher: "timer", now: 1001))
        XCTAssertTrue(publication.publish(snapshot(position: 1000, playing: false), publisher: "command:remote-command", now: 1002))
        XCTAssertTrue(publication.publish(snapshot(entry: "user:song#1", playing: false), publisher: "timer", now: 1003))
    }

    func testSnapshotSanitizesNonFiniteClockAndRate() {
        let value = snapshot(position: .nan, speed: .infinity)
        XCTAssertEqual(value.position, 0)
        XCTAssertEqual(value.rate, 1)
        XCTAssertEqual(value.defaultRate, 1)
        XCTAssertEqual(snapshot(position: -10, playing: false, speed: 0).position, 0)
        XCTAssertEqual(snapshot(playing: false, speed: 2).rate, 0)
        XCTAssertEqual(snapshot(playing: false, speed: 2).defaultRate, 2)
    }

    func testRegistrationIsIdempotentAndRemovesExactlyOwnedTargets() {
        let registration = RemoteCommandRegistration()
        var installs = 0
        var removed: [Int] = []
        func install() {
            registration.install {
                installs += 1
                return (0..<6).map { index in { removed.append(index) } }
            }
        }
        install()
        install()
        XCTAssertEqual(installs, 1)
        XCTAssertEqual(registration.count, 6)
        registration.removeAll()
        registration.removeAll()
        XCTAssertEqual(removed, Array(0..<6))
        XCTAssertEqual(registration.count, 0)
        install()
        XCTAssertEqual(installs, 2)
        registration.removeAll()
        XCTAssertEqual(removed.count, 12)
    }

    func testRegistrationDeinitRemovesTargetsEvenWithoutExplicitTeardown() {
        var removals = 0
        do {
            let registration = RemoteCommandRegistration()
            registration.install { [{ removals += 1 }] }
        }
        XCTAssertEqual(removals, 1)
    }
}

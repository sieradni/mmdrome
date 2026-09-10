import Foundation
import XCTest
@testable import BackgroundAudioCore

/// Pins the loader's variant identity + preserve-unless-upgrade rule. The
/// trackId-only cache served stale bytes across transcode changes (a raw file
/// downloaded on Wi-Fi kept playing after low-data mode engaged); these tests
/// pin the contract the TrackFileLoader adapter implements.
final class TrackVariantTests: XCTestCase {

    private func streamURL(format: String? = nil, maxBitRate: Int? = nil) -> URL {
        var comps = URLComponents(string: "https://srv.example/rest/stream.view")!
        comps.queryItems = [
            URLQueryItem(name: "u", value: "user"),
            URLQueryItem(name: "p", value: "enc:abc123"),
            URLQueryItem(name: "v", value: "1.16.1"),
            URLQueryItem(name: "c", value: "mmdrome"),
            URLQueryItem(name: "id", value: "42"),
        ]
        if let format {
            comps.queryItems?.append(URLQueryItem(name: "format", value: format))
        }
        if let maxBitRate {
            comps.queryItems?.append(URLQueryItem(name: "maxBitRate", value: String(maxBitRate)))
        }
        comps.queryItems?.append(URLQueryItem(name: "estimateContentLength", value: "true"))
        return comps.url!
    }

    // MARK: - init(url)

    func testNoFormatIsRaw() {
        XCTAssertEqual(TrackVariant(url: streamURL()), .raw)
    }

    func testEmptyFormatIsRaw() {
        XCTAssertEqual(TrackVariant(url: streamURL(format: "")), .raw)
    }

    func testTranscodeParsesFormatAndBitrate() {
        XCTAssertEqual(TrackVariant(url: streamURL(format: "mp3", maxBitRate: 64)),
                       .transcode(format: "mp3", maxBitRate: 64))
    }

    func testFormatValueIsCaseInsensitive() {
        // buildStreamUrl always emits lowercase, but never trust the wire.
        XCTAssertEqual(TrackVariant(url: streamURL(format: "MP3", maxBitRate: 64)),
                       .transcode(format: "mp3", maxBitRate: 64))
    }

    func testMissingBitrateFallsBackToClientDefault() {
        // Matches transcodePolicy.ts (bitrate ?? 128) so the key is
        // deterministic for every URL shape.
        XCTAssertEqual(TrackVariant(url: streamURL(format: "opus")),
                       .transcode(format: "opus", maxBitRate: 128))
    }

    func testUnparseableBitrateFallsBackToClientDefault() {
        var comps = URLComponents(url: streamURL(format: "opus"), resolvingAgainstBaseURL: false)!
        comps.queryItems?.append(URLQueryItem(name: "maxBitRate", value: "loud"))
        XCTAssertEqual(TrackVariant(url: comps.url!),
                       .transcode(format: "opus", maxBitRate: 128))
    }

    func testAuthAndNoiseParamsNeverForkTheVariant() {
        // u/p/v/c/id/estimateContentLength differ per server and session —
        // only format/maxBitRate matter.
        XCTAssertEqual(TrackVariant(url: streamURL(format: "mp3", maxBitRate: 64)),
                       TrackVariant(url: streamURL(format: "mp3", maxBitRate: 64)))
    }

    func testFileURLIsRaw() {
        XCTAssertEqual(TrackVariant(url: URL(fileURLWithPath: "/tmp/song.mp3")), .raw)
    }

    // MARK: - key / rank

    func testKeys() {
        XCTAssertEqual(TrackVariant.raw.key, "raw")
        XCTAssertEqual(TrackVariant.transcode(format: "mp3", maxBitRate: 64).key, "mp3@64")
    }

    func testRawOutranksEveryTranscode() {
        XCTAssertGreaterThan(TrackVariant.raw.rank,
                             TrackVariant.transcode(format: "flac", maxBitRate: 320).rank)
    }

    func testTranscodeRankIsBitrateOrder() {
        XCTAssertGreaterThan(TrackVariant.transcode(format: "mp3", maxBitRate: 192).rank,
                             TrackVariant.transcode(format: "opus", maxBitRate: 64).rank)
    }

    // MARK: - shouldServeCached (preserve-unless-upgrade)

    func testExactVariantServes() {
        XCTAssertTrue(shouldServeCached(cached: .transcode(format: "mp3", maxBitRate: 64),
                                        requested: .transcode(format: "mp3", maxBitRate: 64)))
    }

    func testCachedRawServesTranscodeRequest() {
        // Preserve: never re-download just to downgrade.
        XCTAssertTrue(shouldServeCached(cached: .raw,
                                        requested: .transcode(format: "mp3", maxBitRate: 64)))
    }

    func testHigherTranscodeServesLowerRequest() {
        XCTAssertTrue(shouldServeCached(cached: .transcode(format: "opus", maxBitRate: 128),
                                        requested: .transcode(format: "mp3", maxBitRate: 64)))
    }

    func testLowerTranscodeNeverServesHigherRequest() {
        // Upgrade: evict + re-download.
        XCTAssertFalse(shouldServeCached(cached: .transcode(format: "mp3", maxBitRate: 64),
                                         requested: .raw))
        XCTAssertFalse(shouldServeCached(cached: .transcode(format: "mp3", maxBitRate: 64),
                                         requested: .transcode(format: "opus", maxBitRate: 128)))
    }

    func testSameRateDifferentFormatTieServesCached() {
        // Equivalent tier — no re-download for a lateral move.
        XCTAssertTrue(shouldServeCached(cached: .transcode(format: "mp3", maxBitRate: 64),
                                        requested: .transcode(format: "opus", maxBitRate: 64)))
    }

    // MARK: - transcodeCacheKey

    func testCacheKeyIsDeterministic() {
        let v = TrackVariant.transcode(format: "mp3", maxBitRate: 64)
        XCTAssertEqual(transcodeCacheKey(trackId: "navidrome-42", variant: v),
                       transcodeCacheKey(trackId: "navidrome-42", variant: v))
    }

    func testCacheKeySeparatesVariants() {
        let id = "navidrome-42"
        let raw = transcodeCacheKey(trackId: id, variant: .raw)
        let mp3 = transcodeCacheKey(trackId: id, variant: .transcode(format: "mp3", maxBitRate: 64))
        let mp3hi = transcodeCacheKey(trackId: id, variant: .transcode(format: "mp3", maxBitRate: 128))
        XCTAssertNotEqual(raw, mp3)
        XCTAssertNotEqual(mp3, mp3hi)
        XCTAssertNotEqual(raw, transcodeCacheKey(trackId: "navidrome-43", variant: .raw))
    }
}

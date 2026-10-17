import Foundation
import XCTest
@testable import BackgroundAudioCore

final class AudioResponsePolicyTests: XCTestCase {
    func testAudioAndGenericResponsesRemainAllowed() {
        for status in [200, 206] {
            for mime in [nil, "audio/ogg", "audio/mpeg", "application/octet-stream", "application/ogg"] {
                XCTAssertNil(AudioResponsePolicy.rejection(status: status, contentType: mime))
            }
        }
    }

    func testRangeRemaindersAreNotSniffedAsDocumentHeaders() {
        for body in ["{", "[", "<html>"] {
            let prefix = Data(body.utf8)
            XCTAssertNil(AudioResponsePolicy.rejection(status: 206, contentType: "audio/ogg", prefix: prefix, contentRangeStart: 4096))
            XCTAssertNil(AudioResponsePolicy.rejection(status: 206, contentType: nil, prefix: prefix))
            XCTAssertNotNil(AudioResponsePolicy.rejection(status: 206, contentType: nil, prefix: prefix, contentRangeStart: 0))
        }
    }

    func testServerFailuresPreserveQueue() {
        for status in [401, 403, 429, 500, 502, 503] {
            let error = AudioResponsePolicy.rejection(status: status, contentType: nil)!
            XCTAssertTrue(AudioResponsePolicy.stopsQueue(error))
        }
        for mime in [nil, "text/html"] {
            XCTAssertFalse(AudioResponsePolicy.stopsQueue(AudioResponsePolicy.rejection(status: 404, contentType: mime)!))
        }
    }

    func testLoginAndProtocolDocumentsAreNotAudioEvenWithSuccessfulStatus() {
        for mime in ["Text/HTML; charset=utf-8", "application/json", "application/xml", "text/plain"] {
            XCTAssertTrue(AudioResponsePolicy.stopsQueue(AudioResponsePolicy.rejection(status: 200, contentType: mime)!))
        }
        for body in ["\u{feff}  <!DOCTYPE html>", "<html>", "<?xml version=\"1.0\"?>", "<subsonic-response", "{\"error\":1}"] {
            XCTAssertNotNil(AudioResponsePolicy.rejection(status: 200, contentType: "application/octet-stream", prefix: Data(body.utf8)))
        }
        XCTAssertFalse(AudioResponsePolicy.stopsQueue(NSError(domain: "mmdrome.loader", code: -7002)))
    }
}

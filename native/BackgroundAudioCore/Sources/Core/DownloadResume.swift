import Foundation

/// Pure resume/reassembly decisions for the TrackFileLoader (2026-09-21,
/// the "partial downloads feel like a subpar response" review). iOS ships
/// two established continuation mechanisms and the loader used neither:
/// every failure discarded all delivered bytes and started over, so on a
/// flaky interface the same track could re-download from zero repeatedly.
///
/// Two failure shapes, two continuations:
/// - **Loud cut** (URLSession `error != nil`): the system hands back opaque
///   `resumeData` in the error's userInfo — the loader re-issues
///   `downloadTask(withResumeData:)` and URLSession reassembles internally.
///   Nothing to decide here beyond presence/absence.
/// - **Clean early close** (no error, body short of the transfer's own
///   announced Content-Length — the Connectivity-Assist shape): URLSession
///   reports SUCCESS, so there is no resumeData. The loader keeps the
///   delivered prefix as a `.part` file and re-requests the remainder with
///   `Range: bytes=<offset>-`, then concatenates.
///
/// This core owns every DECISION in that flow; the loader owns mechanics
/// (file moves, task creation). Dependency-free, `swift test`-hostable.
public enum DownloadResume {

    /// A retained partial download awaiting continuation. `parts` are the
    /// delivered prefix files IN ORDER; `announcedTotal` is the ORIGINAL
    /// transfer's Content-Length (the full size — a range response's own
    /// Content-Length covers only the remainder and must never be compared
    /// against the combined bytes). `fromOpaqueResumeData` marks entries
    /// created by URLSession's own resumeData path (their bytes live inside
    /// the opaque data; `parts` is empty and no concat happens).
    public struct Pending: Equatable {
        public var parts: [Int64]
        public var announcedTotal: Int64
        public var fromOpaqueResumeData: Bool

        public init(parts: [Int64] = [], announcedTotal: Int64, fromOpaqueResumeData: Bool = false) {
            self.parts = parts
            self.announcedTotal = announcedTotal
            self.fromOpaqueResumeData = fromOpaqueResumeData
        }

        /// Total delivered bytes across all retained parts.
        public var deliveredBytes: Int64 { parts.reduce(0, +) }
    }

    /// Maximum retained parts before a fresh full download is the sane move
    /// (each append is a second network round trip; unbounded part growth on
    /// a churning interface would out-wait the resource timeout).
    public static let maxParts = 4

    /// DECISION: how the next attempt for a cache key downloads.
    public enum Continuation: Equatable {
        /// No retained state — plain full download.
        case fresh
        /// URLSession's own continuation: `downloadTask(withResumeData:)`.
        case opaqueResume
        /// Range request from `offset`, then concatenate onto the parts.
        case rangeAppend(offset: Int64)
    }

    /// Picks the continuation for the next attempt. `opaqueResumeData` comes
    /// from a loud failure's error userInfo; `pending` is any retained clean
    /// close. Opaque resume wins (it carries URLSession's internal byte
    /// accounting, which a Range request cannot see). Range-append requires
    /// the delivered prefix to exist and stay under the part cap.
    public static func planNextAttempt(
        pending: Pending?,
        opaqueResumeData: Data?
    ) -> Continuation {
        if opaqueResumeData != nil { return .opaqueResume }
        guard let pending, !pending.fromOpaqueResumeData, !pending.parts.isEmpty,
              pending.parts.count < maxParts
        else { return .fresh }
        return .rangeAppend(offset: pending.deliveredBytes)
    }

    /// VALIDATION of a range response (2026-09-21, the double-append guard):
    /// a server that does not honor `Range` answers `200` with the FULL body.
    /// Concatenating that onto the retained prefix would produce
    /// prefix + full — a file LARGER than the original (and, after the
    /// container header lands mid-stream, undecodable). Only `206 Partial
    /// Content` may be appended; anything else means "server ignored the
    /// range — discard the prefix, the new body IS the whole transfer".
    public static func rangeResponseIsAppendable(statusCode: Int) -> Bool {
        statusCode == 206
    }

    /// Parses the START offset out of a `Content-Range` response header
    /// ("bytes 3700000-4999999/5000000" → 3700000; "bytes */5000000" and
    /// garbage → nil). A 206 whose start does not equal the requested offset
    /// is a misaligned answer — appending would corrupt the file (bytes from
    /// the wrong position spliced mid-stream), the exact poison class the
    /// trust boundary exists to stop. Callers treat nil/mismatch as
    /// "prefix replaced", never appended.
    /// DECISION (2026-09-24, the in-loader writer continuation): may an
    /// early-closed writer's remainder be re-requested with a Range header?
    /// The loader must also hold the delivered bytes — an offset into an
    /// empty/nonexistent scratch would splice WRONG bytes mid-stream (the
    /// misalignment poison class the 206 validation exists to stop). The
    /// part cap applies equally: past it, a fresh attempt is the sane move.
    public static func writerContinuationEligible(offset: Int64, hasRetainedPart: Bool) -> Bool {
        guard offset > 0, hasRetainedPart else { return false }
        return true
    }

    public static func parseContentRangeStart(_ text: String?) -> Int64? {
        guard let text, text.hasPrefix("bytes") else { return nil }
        let body = text.dropFirst("bytes".count).trimmingCharacters(in: .whitespaces)
        guard let dash = body.firstIndex(of: "-") else { return nil }
        let start = body[body.startIndex..<dash].trimmingCharacters(in: .whitespaces)
        return Int64(start)
    }

    /// The Range header value for the next attempt, or nil when the
    /// continuation is not a range append.
    public static func rangeHeader(offset: Int64) -> String? {
        guard offset > 0 else { return nil }
        return "bytes=\(offset)-"
    }

    /// Post-concat validation plan: the combined byte count is judged
    /// against the ORIGINAL transfer's announced total — byte-exact for raw
    /// streams (the 2026-09-21 clean-close gate), never for transcodes
    /// (their announced length is a server-side estimate). Mirrors
    /// `DownloadSanity.isShortOfAnnouncedBytes`'s contract at the merged
    /// boundary; kept separate so the resume flow fails with its own
    /// diagnosable error code.
    public static func combinedIsShort(
        combinedBytes: Int64,
        announcedTotal: Int64,
        isRawStream: Bool
    ) -> Bool {
        guard isRawStream, announcedTotal > 0 else { return false }
        return combinedBytes < announcedTotal
    }

    // MARK: - Early-close network fingerprint (2026-09-25)

    /// WHY the early close happened (data assist? proxy? origin?) is
    /// unprovable from a byte count alone — the response's own network
    /// facts must ride the log verbatim. The 2026-09-25 "repeatedly
    /// skipping" dump recorded only counter/disk/announced, so the
    /// data-assist suspicion could not be confirmed or ruled out.
    /// Immutable snapshot of ONE attempt's response evidence.
    public struct ResponseFingerprint: Equatable {
        public let statusCode: Int
        public let connectionHeader: String?
        public let contentLengthHeader: String?
        public let contentRangeHeader: String?
        public let acceptRangesHeader: String?
        public let contentTypeHeader: String?

        public init(
            statusCode: Int,
            connectionHeader: String?,
            contentLengthHeader: String?,
            contentRangeHeader: String?,
            acceptRangesHeader: String?,
            contentTypeHeader: String?
        ) {
            self.statusCode = statusCode
            self.connectionHeader = connectionHeader
            self.contentLengthHeader = contentLengthHeader
            self.contentRangeHeader = contentRangeHeader
            self.acceptRangesHeader = acceptRangesHeader
            self.contentTypeHeader = contentTypeHeader
        }
    }

    /// One-line, copy-paste-safe summary for a structured event. Truncates
    /// long header values (Connection is normally `keep-alive`; a proxy or
    /// Connection: close verdict is the diagnostic payload).
    public static func responseFingerprintLine(_ f: ResponseFingerprint) -> String {
        func short(_ s: String?) -> String {
            guard let s else { return "-" }
            return s.count > 48 ? String(s.prefix(45)) + "..." : s
        }
        return "status=\(f.statusCode) conn=\(short(f.connectionHeader))"
            + " clen=\(short(f.contentLengthHeader))"
            + " crange=\(short(f.contentRangeHeader))"
            + " aranges=\(short(f.acceptRangesHeader))"
            + " ctype=\(short(f.contentTypeHeader))"
    }

}

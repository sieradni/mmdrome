import Foundation

/// Pure two-phase decode-capability classifier for the NATIVE probe
/// (2026-09-21, "what is the point of checking if it doesn't actually
/// verify"): the static per-platform table + OS-version gate decided codec
/// verdicts with ZERO evidence — a lookup table wearing a probe's clothes,
/// and it field-pinned a bogus mp3 fallback twice. The native probe now
/// mirrors the web's two-phase semantics, but phase 2 hands the REAL bytes
/// to `AVAudioFile` — the EXACT decoder the playback graph uses — so an
/// 'ok' verdict is proof the engine can play the format, not an OS-version
/// guess.
///
/// Phase 1 — transport: fetch a tiny sample (server-side transcode at the
/// lowest bitrate) with plain URLSession. Transport failures (offline,
/// captive portal, server down) and non-media bodies (Subsonic error JSON)
/// classify as `.network` — NEVER persisted, retried next boot. Phase 2 —
/// decode: write the received bytes to a temp file, open with
/// `AVAudioFile`, read frames. An open/read failure after real media bytes
/// IS the device: `.unsupported`.
///
/// Dependency-free (no AVFoundation import needed at the decision layer —
/// the loader injects the frame count), `swift test`-hostable.
public enum DecodeProbe {

    /// The raw payload of a completed phase-1 fetch.
    public struct Sample {
        public let bytes: Data
        public init(bytes: Data) { self.bytes = bytes }
    }

    public enum Verdict: Equatable {
        /// Real media bytes the decoder opened and read — proof.
        case ok(frames: Int64)
        /// Real media bytes the decoder rejected — the device.
        case unsupported(reason: String)
        /// No evidence (transport failure, error body, timeout). Never
        /// persisted.
        case network
    }

    /// PHASE 1 classification: what did the transport deliver?
    /// `statusCode` 200/206 with bytes → sample; anything else (HTTP error,
    /// empty body) → network. `bodyLooksLikeJson` screens the Subsonic
    /// error payload (`{"...` / `["...`) — a server problem, not a codec
    /// gap.
    public static func classifyTransport(
        statusCode: Int,
        bodyBytes: Data
    ) -> Verdict {
        guard (200...206).contains(statusCode), !bodyBytes.isEmpty else {
            return .network
        }
        if bodyLooksLikeJson(bodyBytes) { return .network }
        return .ok(frames: 0) // sentinel: transport ok, decode pending
    }

    /// The pure JSON-screen (exported for tests): a body starting with
    /// `{` or `[` (after ASCII whitespace) is a Subsonic error payload,
    /// not media.
    public static func bodyLooksLikeJson(_ data: Data) -> Bool {
        guard let first = data.first(where: { !($0 == 0x20 || $0 == 0x09 || $0 == 0x0a || $0 == 0x0d) }) else {
            return false
        }
        return first == 0x7b || first == 0x5b
    }

    /// PHASE 2 classification: given the received sample and the frame
    /// count the REAL decoder produced (caller runs `AVAudioFile` + a read),
    /// what's the verdict? `decodeError nil` + frames > 0 → ok; any decode
    /// failure → unsupported (the device rejected real media bytes).
    public static func classifyDecode(
        decodeError: String?,
        decodedFrames: Int64
    ) -> Verdict {
        if let decodeError {
            return .unsupported(reason: decodeError)
        }
        guard decodedFrames > 0 else {
            return .unsupported(reason: "decoder produced 0 frames")
        }
        return .ok(frames: decodedFrames)
    }

    /// Minimum sample size for a decode verdict to be meaningful: a body
    /// too small to carry any container header cannot prove decodeability
    /// (returns .network — no evidence, retry later). 4 KB comfortably
    /// holds an Ogg/MP3/MP4 header at 16 kbps.
    public static let minimumSampleBytes = 4096

    public static func classifyTransportWithMinimum(
        statusCode: Int,
        bodyBytes: Data
    ) -> Verdict {
        let v = classifyTransport(statusCode: statusCode, bodyBytes: bodyBytes)
        if case .ok = v, bodyBytes.count < minimumSampleBytes {
            return .network
        }
        return v
    }

    /// Persistence rule (mirrors the web probe): only an EVIDENCE-BACKED
    /// verdict is stored; `.network` and the empty-id/timeout `nil` cases
    /// retry on the next boot. `probeVerdictIsPersistent` decides; the JS
    /// layer owns the store.
    public static func probeVerdictIsPersistent(_ v: Verdict) -> Bool {
        switch v {
        case .ok, .unsupported: return true
        case .network: return false
        }
    }
}

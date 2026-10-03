import Foundation
import AVFoundation
import BackgroundAudioCore

/// Native codec probe (2026-09-21 — evidence, not a table).
///
/// The format probe must answer one question: does THIS device's decoder
/// actually play THIS server transcode? The answer has to come from real
/// bytes — the pre-2026-09-21 static per-platform table shipped a bogus mp3
/// fallback twice (1.2.30 flat table, 1.2.31 UA guess), and a lookup table
/// wearing a probe's clothes is worse than no check at all. So this downloads
/// a tiny sample of the low-bitrate transcode URL (the same request shape the
/// web probe makes), hands the REAL bytes to `AVAudioFile` — the exact decoder
/// the playback graph uses — and reads frames back.
///
/// Two-phase, mirroring `formatProbe.ts`: transport failures and error bodies
/// answer `network` (never persisted, retried next boot); only bytes the
/// decoder actually opened and read produce `ok` and a frame count. The pure
/// classification (minimum-size gate, decode verdicts) lives in
/// `DecodeProbe.swift`; this file is only the I/O shell.
///
/// BOUNDARY (2026-10-03): deliberately NOT a member of `TrackFileLoader`. The
/// probe shares the loader's URLSession habits but NONE of its state — no
/// cache maps, no scratch, no writer, no retention. It was living in the
/// loader only because the loader happened to own the download machinery,
/// which contradicted the loader's "transfer layer" boundary. The plugin
/// reaches it through `NativeAudioEngine.probeFormatURL`.
enum DecodeProbeRunner {

    /// Downloads a tiny sample of `sampleURL` and reports the decode verdict.
    /// Deliberately NOT main-thread-bound: the probe is independent of the
    /// audio graph, and the completion hops wherever the caller needs it.
    static func probeDecode(
        sampleURL: URL,
        completion: @escaping (_ verdict: String, _ detail: String) -> Void
    ) {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        config.timeoutIntervalForResource = 15
        let probeSession = URLSession(configuration: config)
        let task = probeSession.dataTask(with: sampleURL) { body, response, error in
            guard error == nil, let http = response as? HTTPURLResponse else {
                completion("network", error?.localizedDescription ?? "no response")
                return
            }
            let status = http.statusCode
            guard let body, !body.isEmpty else {
                completion("network", "http \(status) empty body")
                return
            }
            let verdict = DecodeProbe.classifyTransportWithMinimum(statusCode: status, bodyBytes: body)
            switch verdict {
            case .network:
                completion("network", "http \(status) body \(body.count)B (error payload or too small)")
                return
            case .unsupported(let reason):
                completion("unsupported", reason)
                return
            case .ok:
                break // real media bytes — proceed to the decoder
            }
            let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("mmprobe-").appendingPathExtension("bin")
            do {
                try body.write(to: tmp, options: .atomic)
            } catch {
                completion("network", "sample write failed: \(error.localizedDescription)")
                return
            }
            defer { try? FileManager.default.removeItem(at: tmp) }
            var decodeError: String?
            var frames: Int64 = 0
            do {
                let audio = try AVAudioFile(forReading: tmp)
                frames = audio.length
                if frames > 0 {
                    // Read a frame to force real demux work (length alone can
                    // trust the header; a frame read exercises the decoder).
                    guard let format = try? AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: audio.fileFormat.sampleRate, channels: max(1, audio.fileFormat.channelCount), interleaved: false) else {
                        throw NSError(domain: "mmdrome.probe", code: 1)
                    }
                    let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1024)
                    if let buf { try audio.read(into: buf) }
                }
            } catch {
                decodeError = error.localizedDescription
            }
            let verdict2 = DecodeProbe.classifyDecode(decodeError: decodeError, decodedFrames: frames)
            switch verdict2 {
            case .ok(let f):
                completion("ok", "\(f) frames decoded by AVAudioFile")
            case .unsupported(let reason):
                completion("unsupported", reason)
            case .network:
                completion("network", "unexpected transport verdict in decode phase")
            }
        }
        task.resume()
    }
}
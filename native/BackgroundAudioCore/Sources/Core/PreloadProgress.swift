import Foundation

/// Pure diff-machine for streaming native preload progress to the webview
/// (JS parity with `lib/loadStatus.ts`'s PreloadEvent states). The engine
/// samples the loader's URLSessionDownloadTask counters on a 1 s timer; THIS
/// type decides which observations become events so the bridge never
/// receives a steady stream of unchanged snapshots.
///
/// Semantics:
/// - `fetching` emits only when the byte ratio moved ≥ 1% since the last
///   EMITTED snapshot (identical re-reads are the common case — the download
///   may be stalled or the track tiny).
/// - `cached` (the bytes are on disk) and `gone` (nothing in flight or on
///   disk — row left the window / evicted) always emit when they differ:
///   a completion can land any time, including while the poll timer is
///   suspended (paused engine), and the completion transition must not be
///   swallowed by the diff window.
public struct PreloadProgress: Equatable, Sendable {
    /// "fetching" | "cached" | "gone"
    public var state: String
    /// 0...1 byte ratio while fetching; nil = indeterminate (no Content-Length).
    public var progress: Double?

    public init(state: String, progress: Double?) {
        self.state = state
        self.progress = progress
    }

    /// Returns the snapshot to emit when `observed` differs from the last
    /// EMITTED snapshot for this track, else nil (nothing to send).
    public static func event(
        lastEmitted: PreloadProgress?,
        observed: PreloadProgress
    ) -> PreloadProgress? {
        guard lastEmitted != observed else { return nil }
        // Terminal/transient states always announce themselves.
        if observed.state != "fetching" { return observed }
        // First observation of a fetching track always emits (opens the row).
        guard lastEmitted?.state == "fetching",
              let last = lastEmitted?.progress,
              let now = observed.progress else { return observed }
        // Same-shape fetching snapshot: emit only on a real move (1% window).
        if abs(now - last) >= 0.01 { return observed }
        return nil
    }
}

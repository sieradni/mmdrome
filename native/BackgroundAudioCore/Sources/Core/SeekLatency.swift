import Foundation

/// The four legs of a seek's latency (2026-10-07, plan Phase 4 item 3).
///
/// One probe per user seek, four marks, one line. The point of the measurement
/// is that the seek-intent / epoch work (and any future cross-row preemption)
/// is decided by numbers rather than by a claim about "feels faster".
public enum SeekLatencyLeg: String, CaseIterable, Sendable {
    /// The engine committed to a strategy for this seek (served locally,
    /// parked for the first schedule, or handed to a server-offset epoch).
    case decision
    /// The first byte of the transfer that will feed the target arrived (the
    /// downloadTask lane exposes no progress callback — see
    /// `Report.firstByteInferred`).
    case firstByte
    /// The first schedule containing the target exists.
    case firstSchedule
    /// Playback started: the node began rendering the schedule that covers the
    /// target. The device's own output buffer is beyond the app's reach and is
    /// deliberately NOT included — this leg is "the app is done waiting", and
    /// the constant output buffer cancels out when two seeks are compared.
    case firstPlayback

    /// Declaration order = pipeline order. A report always emits its legs in
    /// this order so two dumps read the same way.
    public var order: Int {
        switch self {
        case .decision: return 0
        case .firstByte: return 1
        case .firstSchedule: return 2
        case .firstPlayback: return 3
        }
    }
}

/// Pure seek-latency accounting: a `Probe` records when a leg was reached, and
/// a `Report` turns those stamps into deltas from the seek request plus the one
/// canonical event line the field dump greps for.
public enum SeekLatency {
    /// A probe older than this is no longer attributed to its seek: a user who
    /// seeks while paused and presses play a minute later is measuring their
    /// own pause, not the engine.
    public static let maximumProbeAgeSeconds: TimeInterval = 60

    // MARK: - Probe

    public struct Probe: Equatable, Sendable {
        public let trackId: String
        public let targetSeconds: Double
        public let requestedAt: TimeInterval
        public private(set) var strategy: String = "unknown"
        public private(set) var marks: [SeekLatencyLeg: TimeInterval] = [:]

        public init(trackId: String, targetSeconds: Double, requestedAt: TimeInterval) {
            self.trackId = trackId
            self.targetSeconds = targetSeconds
            self.requestedAt = requestedAt
        }

        /// The strategy the seek decided on ("local", "parked", "epoch",
        /// "staged-stall", "refused"). Recorded with the decision leg so a dump
        /// can group latencies by strategy.
        public mutating func note(strategy: String) {
            self.strategy = strategy
        }

        /// Marks a leg. THE FIRST MARK WINS — a retry, a second transfer for
        /// the same seek, or a redundant call must not inflate the leg (the
        /// same "first evidence is the truth" rule the loader's gates use).
        @discardableResult
        public mutating func mark(_ leg: SeekLatencyLeg, at t: TimeInterval) -> Bool {
            guard marks[leg] == nil else { return false }
            marks[leg] = t
            return true
        }

        public var isComplete: Bool {
            SeekLatencyLeg.allCases.allSatisfy { marks[$0] != nil }
        }

        /// Whether a mark at `t` still belongs to THIS seek: the same row (a
        /// mark from another track can never complete this seek) and inside the
        /// probe's lifetime.
        public func accepts(trackId: String, at t: TimeInterval) -> Bool {
            guard trackId == self.trackId else { return false }
            let age = t - requestedAt
            return age >= 0 && age <= SeekLatency.maximumProbeAgeSeconds
        }

        public func report() -> Report {
            func ms(_ leg: SeekLatencyLeg) -> Double? {
                marks[leg].map { max(0, ($0 - requestedAt) * 1000) }
            }
            // The first byte is only directly observable on the staged/epoch
            // lane. When it was never seen but a schedule exists, the byte
            // arrived no later than that schedule — record the bound and say so.
            let direct = ms(.firstByte)
            let schedule = ms(.firstSchedule)
            let inferred = direct == nil && schedule != nil
            return Report(
                trackId: trackId,
                targetSeconds: targetSeconds,
                strategy: strategy,
                decisionMs: ms(.decision),
                firstByteMs: direct ?? (inferred ? schedule : nil),
                firstScheduleMs: schedule,
                firstPlaybackMs: ms(.firstPlayback),
                firstByteInferred: inferred)
        }
    }

    // MARK: - Report

    public struct Report: Equatable, Sendable {
        public let trackId: String
        public let targetSeconds: Double
        public let strategy: String
        public let decisionMs: Double?
        public let firstByteMs: Double?
        public let firstScheduleMs: Double?
        public let firstPlaybackMs: Double?
        /// True when `firstByteMs` is the SCHEDULE leg standing in for an
        /// unobservable byte arrival (printed with a `*`).
        public let firstByteInferred: Bool

        public var complete: Bool {
            decisionMs != nil && firstByteMs != nil && firstScheduleMs != nil && firstPlaybackMs != nil
        }

        /// The number that answers "how long did the user wait for audio".
        public var totalMs: Double? { firstPlaybackMs }
    }

    /// The ONE canonical line, EMITTED AS A SINGLE LINE (the JS self-test
    /// folds it by this exact shape, so keep the labels and their order):
    ///
    /// `seek latency id=<trackId> target=<x.x>s strategy=<s> decision=<d|->ms`
    /// ` firstByte=<b|->ms firstSchedule=<f|->ms firstPlayback=<p|->ms total=<t|->ms`
    ///
    /// A missing leg is `-`; an inferred byte leg carries a trailing `*`.
    public static func line(_ report: Report) -> String {
        func m(_ value: Double?) -> String {
            guard let value else { return "-" }
            return String(format: "%.1f", value)
        }
        let byte = m(report.firstByteMs) + (report.firstByteInferred ? "*" : "")
        let strategy = report.strategy.replacingOccurrences(of: " ", with: "_")
        return "seek latency id=\(report.trackId) target=\(String(format: "%.1f", report.targetSeconds))s "
            + "strategy=\(strategy) decision=\(m(report.decisionMs))ms firstByte=\(byte)ms "
            + "firstSchedule=\(m(report.firstScheduleMs))ms firstPlayback=\(m(report.firstPlaybackMs))ms "
            + "total=\(m(report.totalMs))ms"
    }
}

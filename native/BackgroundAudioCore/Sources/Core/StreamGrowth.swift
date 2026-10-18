import Foundation

/// Scheduling decisions consume a FRESH file observation, never a cached
/// partial-file length. All positions supplied here are absolute source seconds.
public enum StreamGrowth {
    public static let evaluationInterval = 0.2
    public static let lowHeadroomSeconds = 5.0

    public enum Action: Equatable {
        case wait
        case start
        case extend(to: Int64)
        case resume
    }

    public enum EndAction: Equatable {
        case park
        case awaitRender(delay: Double)
        case finish
    }

    /// dataConsumed is chain bookkeeping, not proof the final audible tail
    /// rendered. Recheck on the same bounded clock, preserving user pause.
    public static func endAction(playing: Bool, measured: Bool, position: Double,
                                 scheduledEnd: Double, speed: Double) -> EndAction {
        guard playing else { return .park }
        guard measured, position.isFinite, scheduledEnd.isFinite,
              position + 0.02 < scheduledEnd else { return .finish }
        return .awaitRender(delay: min(evaluationInterval, max(0.02, (scheduledEnd - position) / max(0.25, speed))))
    }

    public static func decide(
        firstSchedule: Bool,
        stalled: Bool,
        userPaused: Bool,
        interrupted: Bool,
        positionSeconds: Double,
        trackEndSeconds: Double,
        scheduledEndFrames: Int64,
        schedulableEndFrames: Int64,
        sampleRate: Double,
        speed: Double
    ) -> Action {
        guard sampleRate.isFinite, sampleRate > 0, speed.isFinite, speed > 0,
              positionSeconds.isFinite, trackEndSeconds.isFinite else { return .wait }
        let position = Int64(max(0, positionSeconds) * sampleRate)
        let available = Double(schedulableEndFrames - position) / sampleRate / speed
        if firstSchedule {
            // The byte lead is only an estimate. Prove the readable audio lead,
            // including the requested seek position and playback consumption.
            let remaining = max(0, trackEndSeconds - positionSeconds) / speed
            return available >= min(StreamPolicy.minimumLeadSeconds, remaining) && available > 0 ? .start : .wait
        }
        if stalled {
            guard !userPaused, !interrupted else { return .wait }
            return available >= StreamSchedule.resumeMarginSeconds ? .resume : .wait
        }
        let growth = Double(schedulableEndFrames - scheduledEndFrames) / sampleRate / speed
        let headroom = Double(scheduledEndFrames - position) / sampleRate / speed
        // Keep ordinary extensions batched, but do not strand usable audio
        // behind the churn threshold when the current schedule is running out.
        if growth >= StreamSchedule.minExtensionSeconds ||
            (headroom <= lowHeadroomSeconds && growth >= evaluationInterval) {
            return .extend(to: schedulableEndFrames)
        }
        return .wait
    }
}

/// Production and tests use the SAME coalescing pump. Byte arrivals are exact
/// accounting; expensive opens/scheduling run at most once per interval, with
/// a trailing evaluation even if the last arrival falls inside that interval.
public final class StreamGrowthPump {
    public typealias Schedule = (Double, @escaping () -> Void) -> (() -> Void)
    private let now: () -> Double
    private let schedule: Schedule
    private let evaluate: () -> Void
    private var lastEvaluation: Double?
    private var cancelPending: (() -> Void)?
    private var generation = 0

    public init(now: @escaping () -> Double, schedule: @escaping Schedule, evaluate: @escaping () -> Void) {
        self.now = now
        self.schedule = schedule
        self.evaluate = evaluate
    }

    public func request() {
        guard cancelPending == nil else { return }
        let delay = max(0, StreamGrowth.evaluationInterval - (now() - (lastEvaluation ?? -Double.greatestFiniteMagnitude)))
        let token = generation
        // The scheduler enqueues (never invokes inline), including delay zero.
        cancelPending = schedule(delay) { [weak self] in
            guard let self, token == self.generation else { return }
            self.cancelPending = nil
            self.lastEvaluation = self.now()
            self.evaluate()
        }
    }

    public func cancel() {
        generation += 1
        cancelPending?()
        cancelPending = nil
        lastEvaluation = nil
    }
}

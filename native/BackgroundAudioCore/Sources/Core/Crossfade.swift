import Foundation

// MARK: - Crossfade ramp

/// Pure interpolation profile for a gain ramp, mirroring the web engine's
/// manual interpolation. `factor(at:)` is the normalized 0...1 progress value
/// at time-fraction `t` — the same math the old `rampVolume` inlined.
public enum RampCurve: Equatable {
    case linear
    case exponential
    case sigmoid(steepness: Float)

    /// Builds the curve from the engine's raw string setting ("linear" /
    /// "exponential"); anything else falls back to the default sigmoid
    /// S-curve, exactly like the engine's switch-default branch.
    public init(raw: String, steepness: Float) {
        switch raw {
        case "linear": self = .linear
        case "exponential": self = .exponential
        default: self = .sigmoid(steepness: steepness)
        }
    }

    public func factor(at t: Float) -> Float {
        switch self {
        case .linear:
            return t
        case .exponential:
            return t * t
        case .sigmoid(let k):
            return 1.0 / (1.0 + exp(-k * (t - 0.5)))
        }
    }
}

/// Pure description of a crossfade gain ramp: the active side fades from
/// `activeStart` to 0 while the standby side fades from 0 to `standbyEnd`,
/// both driven by ONE `stepCount`-step timer in lockstep. (TODO 1.1: the old
/// engine called `rampVolume` twice, and the second call invalidated the
/// shared timer before its first tick, so the fade-out never ran.)
public struct RampPlan: Equatable {
    public static let stepCount = 40

    public let activeStart: Float
    public let standbyEnd: Float
    public let duration: Float
    public let curve: RampCurve

    public init(activeStart: Float, standbyEnd: Float, duration: Float, curve: RampCurve) {
        self.activeStart = activeStart
        self.standbyEnd = standbyEnd
        self.duration = duration
        self.curve = curve
    }

    /// Seconds per timer tick; 0 for a zero-duration plan (the engine snaps).
    public var stepTime: Float {
        duration > 0 ? duration / Float(Self.stepCount) : 0
    }

    /// Normalized 0...1 progress for a 1-based step index (1...stepCount).
    public static func fraction(step: Int) -> Float {
        min(1, Float(max(0, step)) / Float(stepCount))
    }

    public func activeGain(atStep step: Int) -> Float {
        activeStart + (0 - activeStart) * curve.factor(at: Self.fraction(step: step))
    }

    public func standbyGain(atStep step: Int) -> Float {
        0 + (standbyEnd - 0) * curve.factor(at: Self.fraction(step: step))
    }
}

// MARK: - Crossfade lifecycle

public enum CrossfadePhase: Equatable {
    /// No crossfade is armed or running.
    case idle
    /// The monitor hit the transition point; the standby is about to be scheduled.
    case armed
    /// Both nodes are rendering under the ramp; the active node's completion
    /// finalizes the switch.
    case inFlight
}

/// Pure lifecycle model for the crossfade trio (armed/in-flight + target
/// index). One value instead of three fields so the phase and the target can
/// never drift apart. (TODO 1.8: `pausing()` — a mid-fade pause cancels the
/// switch and tears the ramp down; resume re-arms from the current track.)
public struct CrossfadeState: Equatable {
    public let phase: CrossfadePhase
    public let targetIndex: Int

    public static let idle = CrossfadeState(phase: .idle, targetIndex: -1)

    public init(phase: CrossfadePhase, targetIndex: Int) {
        self.phase = phase
        self.targetIndex = targetIndex
    }

    /// True when a fade is armed or in flight.
    public var isActive: Bool { phase == .armed || phase == .inFlight }
    /// True only while the ramp is running.
    public var isInFlight: Bool { phase == .inFlight }

    /// The monitor hit the transition point: arm the fade.
    public func arming(targetIndex: Int) -> CrossfadeState {
        CrossfadeState(phase: .armed, targetIndex: targetIndex)
    }

    /// The ramp started: the fade is in flight.
    public func starting(targetIndex: Int) -> CrossfadeState {
        CrossfadeState(phase: .inFlight, targetIndex: targetIndex)
    }

    /// The fade was dropped before completion — the standby wasn't ready, or
    /// playback paused mid-fade (the ramp must not keep mutating gains while
    /// paused; the switch is cancelled and resume re-arms from the current
    /// track).
    public func pausing() -> CrossfadeState { .idle }

    /// The active node finished and the standby became the active node.
    public func completing() -> CrossfadeState { .idle }
}

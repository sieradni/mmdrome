import Foundation

/// Whether a JS-sent queue snapshot is consistent with the engine's current
/// track — the check `refreshQueue` uses to decide between a tail replacement
/// and a full reset. (TODO 1.4: a divergent snapshot is reported via the
/// engine's `ended` event, the honest signal, so JS re-snapshots from its own
/// authoritative queue instead of navigating stale indexes.)
public enum QueueDivergence: Equatable {
    /// The snapshot's active row matches the engine's current track — safe to
    /// replace the tail without disturbing playback.
    case synced
    /// The snapshot's active row is missing or differs — the JS view diverged.
    case divergent
}

/// Pure divergence decision. An empty id means "no active row" on that side:
/// both empty → synced (nothing playing anywhere, nothing to diverge); exactly
/// one empty → divergent (one side claims a current track the other doesn't).
/// The "snapshot active row out of range" case is modelled as an empty
/// snapshot id by the caller.
public func queueDivergence(snapshotActiveId: String, engineCurrentId: String) -> QueueDivergence {
    switch (snapshotActiveId.isEmpty, engineCurrentId.isEmpty) {
    case (false, false):
        return snapshotActiveId == engineCurrentId ? .synced : .divergent
    case (true, true):
        return .synced
    default:
        return .divergent
    }
}

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

/// Returns the active index that may be installed during a synchronized queue
/// refresh. The index is deliberately rejected when out of range instead of
/// being clamped: an invalid snapshot is a divergence and must take the full
/// reset/ended path in the engine.
public func synchronizedQueueActiveIndex(
    snapshotActiveId: String,
    engineCurrentId: String,
    requestedIndex: Int,
    trackCount: Int
) -> Int? {
    guard requestedIndex >= 0, requestedIndex < trackCount else { return nil }
    guard queueDivergence(snapshotActiveId: snapshotActiveId, engineCurrentId: engineCurrentId) == .synced else {
        return nil
    }
    return requestedIndex
}

/// The outcome of a lag-tolerant refresh decision (2026-09-21 P0b).
public enum QueueRefreshDecision: Equatable {
    /// The snapshot's active row IS the engine's current row — the normal
    /// synced path (re-anchor by id, rebuild the tail). `index` is the
    /// caller-validated requested index.
    case synced(index: Int)
    /// The snapshot's active row is BEHIND the engine (a natural advance's
    /// trackChanged/refreshQueue pair crossed in flight), but the row the
    /// engine is actually playing EXISTS in the snapshot. Re-anchor to
    /// `index` — where the live row lives in the snapshot — and rebuild the
    /// tail. Playback is never disturbed: the engine's active row stays the
    /// row its node is rendering (the identity invariant the completion
    /// guards key on), only the tail is re-synced. Duplicate ids re-anchor
    /// to the first occurrence — every guard compares track-id STRINGS, so
    /// instance identity is not load-bearing.
    case containsCurrent(index: Int)
    /// True divergence — full reset and `ended` so JS re-snapshots.
    case divergent
}

/// Pure refresh decision for a snapshot whose active row does not match the
/// engine's current row. During a natural advance the two `trackChanged`
/// snapshots cross in flight (each advance fires trackChanged → advance →
/// refreshQueue on BOTH sides): a plain mismatch is not necessarily a broken
/// queue — it may simply be a LAG. If the engine's live row is present
/// anywhere in the snapshot, the queue is reconcilable without stopping;
/// only a snapshot that has lost the live row entirely is a real divergence.
///
/// `snapshotTrackIds` is the snapshot's rows in order (the caller maps
/// `tracks.map(\.trackId)`); the contains-current lookup is its only use.
public func queueRefreshDecision(
    snapshotActiveId: String,
    engineCurrentId: String,
    requestedIndex: Int,
    trackCount: Int,
    snapshotTrackIds: [String]
) -> QueueRefreshDecision {
    let inRange = requestedIndex >= 0 && requestedIndex < trackCount
    // Synced: snapshot names the live row (or both sides are idle).
    if queueDivergence(snapshotActiveId: snapshotActiveId, engineCurrentId: engineCurrentId) == .synced {
        return inRange ? .synced(index: requestedIndex) : .divergent
    }
    // Engine idle: there is no live row to find in the snapshot — a snapshot
    // claiming a current track while the engine plays nothing is a reset case.
    guard !engineCurrentId.isEmpty else { return .divergent }
    // Lag-tolerated: the live row exists in the snapshot (view one behind).
    if let found = snapshotTrackIds.firstIndex(of: engineCurrentId) {
        return .containsCurrent(index: found)
    }
    return .divergent
}

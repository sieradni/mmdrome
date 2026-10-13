/**
 * Local-storage boot resilience (2026-10-13).
 *
 * Field report: on iOS the app booted to "Failed to initialize local storage:
 * UnknownError: Attempt to get a record from database without an in-progress
 * transaction", with an empty library, no way to recover — while the native
 * engine kept playing. Root cause: WebKit invalidates the `IDBDatabase`
 * handle when its network process crashes (memory pressure / OS resource
 * reclamation), and every later request fails with that `UnknownError`.
 * `idbdb.onclose` is supposed to let Dexie discard the dead handle
 * (`db.close({disableAutoOpen:false})`), but the event is frequently NEVER
 * delivered — the capacitor-filesystem issue that tracks this class
 * (ionic-team/capacitor-filesystem#72) reports the same, and the reported
 * remedy is exactly what `reopenDatabase` does: drop the cached handle and
 * open a FRESH connection (WebKit's `new indexedDB.open()` succeeds after the
 * crash — WebKit/WebKit#60094).
 *
 * The classification is pure and lives here so the retry policy is pinned in
 * Node without IndexedDB (design rule F2). It is deliberately TIGHT: only the
 * provably-dead-connection signatures earn a reopen+retry. An `AbortError`
 * (the ordinary transient transaction abort, A3) or any ordinary error is not
 * a dead handle — blind retries there would delay a real boot bug for no gain.
 */

/** Attempts for the init read phase (1 initial + up to 2 recoveries). */
export const STORAGE_INIT_MAX_ATTEMPTS = 3

export type StorageInitAction = 'reopen' | 'abort'

/** `name` + `message` of anything thrown — Dexie wraps a DOMException in a
 *  `DexieError` whose message is "<name> <message>", so matching the COMBINED
 *  text is the only form that survives both shapes. */
function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name} ${err.message}`
  if (typeof err === 'string') return err
  const e = err as { name?: unknown; message?: unknown } | null | undefined
  if (e && typeof e === 'object') return `${String(e.name ?? '')} ${String(e.message ?? '')}`
  return String(err ?? '')
}

/**
 * True when the error means the IndexedDB CONNECTION itself is dead — the one
 * class where closing the cached handle and opening a fresh one is the fix.
 *
 * Everything is matched against the COMBINED name+message text, because Dexie
 * re-wraps the original error in its own class: `exceptions.OpenFailed(dbOpenError)`
 * and `DatabaseClosed(dbOpenError)` set `message = "<inner.name> <inner.message>"`
 * while `name` becomes the WRAPPER's suffix (verified against Dexie 4.4.4). A
 * classifier that trusted `name` alone would therefore miss a dead handle that
 * was wrapped once — the boot's own `indexedDB.open()` failure, re-thrown at
 * every later operation as `OpenFailedError`, is exactly that shape.
 *
 * Signatures (all observed on iOS WebKit / Dexie):
 *  - `UnknownError: Attempt to get a record from database without an
 *    in-progress transaction` (also "get all index records", "open a cursor",
 *    "generate key" variants) — the field report's shape;
 *  - `InvalidStateError: The database connection is closing` — the same crash
 *    surfacing through a request that raced the invalidation;
 *  - Dexie's `DatabaseClosedError` — a closed instance, the same fix.
 *
 * Deliberately NOT here:
 *  - `MissingAPIError` / "IndexedDB API missing" — the platform has no
 *    IndexedDB at all. Nothing is dead, so a reopen can never help; surfacing
 *    immediately is the honest answer. This is checked FIRST because Dexie
 *    wraps it in a `DatabaseClosedError`, which would otherwise classify.
 *  - `TransactionInactiveError` — Dexie's `if (!this.active) throw` (4.4.4
 *    `Transaction.create` / `_promise`), i.e. a table used AFTER its
 *    transaction completed: the classic async-gap programming error. Retrying
 *    it would silently run the operation OUTSIDE the scope the caller wrote it
 *    in — masking a real bug with a wrong write. A genuinely dead handle does
 *    not surface this way (it fails when the request/transaction is CREATED,
 *    per the signatures above).
 */
export function isBrokenIdbConnection(err: unknown): boolean {
  const text = errorText(err)
  if (/MissingAPIError|IndexedDB API missing/i.test(text)) return false
  if (/without an in[- ]progress transaction/i.test(text)) return true
  if (/InvalidStateError/.test(text) && /connection (is )?clos|database is clos|not open/i.test(text)) return true
  if (/DatabaseClosedError/.test(text)) return true
  return false
}

/**
 * The boot decision for one failed init attempt: `reopen` (drop the dead
 * handle, open a fresh connection, retry the read phase) or `abort` (surface
 * the error — the boot banner's Reload affordance is the recovery).
 */
export function planStorageInitAttempt(
  err: unknown,
  attempt: number,
  maxAttempts: number = STORAGE_INIT_MAX_ATTEMPTS,
): StorageInitAction {
  if (!isBrokenIdbConnection(err)) return 'abort'
  return attempt < maxAttempts ? 'reopen' : 'abort'
}

/**
 * How long a successful reopen suppresses ANOTHER reopen (ms).
 *
 * A dead connection fails MANY operations at once (the boot's `loadSettings`
 * alone fires ~26 concurrent reads, and queue persists overlap metadata
 * writes). The first failure reopens the connection — which by definition
 * closes the handle the others were still using, so they fail too. Without a
 * cooldown every one of them would reopen again, and each reopen would kill
 * the retries of its siblings: a close/open storm that turns one dead handle
 * into a cascade. Inside the cooldown a broken-connection failure just RETRIES
 * against the connection the first recovery already opened.
 */
export const RECOVERY_COOLDOWN_MS = 1500

/**
 * How long a FAILED recovery suppresses further reopen attempts (ms).
 *
 * The cooldown above covers the recovering case; this covers the one that
 * cannot recover. Without it a connection that stays broken turns EVERY store
 * operation into another `indexedDB.open()` attempt plus another pair of ring
 * lines — the metadata scanner alone writes in a loop, and `loadSettings`
 * fires ~26 reads. Inside the backoff a dead-connection failure surfaces as
 * the caller's own error, which is exactly what happened before operation
 * recovery existed: the boot banner (C9) or A3's persist warning. A recovery
 * that then SUCCEEDS restores full behavior immediately — the backoff is only
 * measured from failures.
 */
export const RECOVERY_FAILURE_BACKOFF_MS = 1500

/**
 * Upper bound on one reopen attempt (ms).
 *
 * A WebKit `indexedDB.open()` that never settles would otherwise convert a
 * recoverable failure into a hang — and, because callers share the in-flight
 * recovery, into a hang for every operation that fails alongside it. On timeout
 * the recovery counts as failed (original error surfaced, backoff armed) and
 * the abandoned open stays in flight for whoever needs it next, so a late
 * success still lands in `msSinceReopen` and spares the next reopen.
 *
 * A "false" timeout is the cost: a genuine open slower than this is reported
 * as a failure rather than waited out. 5 s is far above a healthy open even
 * for a large DB (the open itself reads no data; only a version upgrade can be
 * slow, and that path is rare), so the bound trades a rare false negative for
 * the certainty that a broken connection can never wedge the UI forever.
 */
export const REOPEN_TIMEOUT_MS = 5000

export type OperationRetryPlan = 'reopen-and-retry' | 'retry' | 'surface'

export interface OperationRetryContext {
  /** `db.isOpen()` at failure time. A DEAD WebKit handle still reports open,
   *  so this alone can never justify skipping a reopen. */
  connectionOpen: boolean
  /** ms since the last successful reopen (`Infinity` when never). */
  msSinceReopen: number
  /** ms since the last FAILED reopen attempt (`Infinity` when none). */
  msSinceFailedRecovery: number
}

/** Test/host overrides for the time-based rules. */
export interface OperationRetryTuning {
  cooldownMs?: number
  failureBackoffMs?: number
}

/**
 * The per-OPERATION recovery decision (2026-10-13) — the general form of the
 * boot-only `planStorageInitAttempt`, applied to every store read/write.
 *
 *  - `reopen-and-retry` — the connection is dead (or not open at all): discard
 *    the cached handle, open a fresh one, run the operation again.
 *  - `retry` — a reopen landed within the cooldown and the connection reports
 *    open, so this failure is almost certainly a SIBLING of that recovery
 *    (its handle was closed underneath it, or the burst's tx was killed): run
 *    the operation again against the fresh connection instead of churning
 *    another close/open (see `RECOVERY_COOLDOWN_MS`).
 *  - `surface` — not a dead connection, a recovery just FAILED (see
 *    `RECOVERY_FAILURE_BACKOFF_MS`), or the operation already retried. An
 *    `AbortError` lands here by design (A3): it is the ordinary transient
 *    abort, not a dead handle.
 *
 * The "already retried" bound is enforced by the caller's structure (the
 * retry is a fresh, unwrapped call), so this stays a pure decision.
 */
export function planOperationRetry(
  err: unknown,
  ctx: OperationRetryContext,
  tuning: OperationRetryTuning = {},
): OperationRetryPlan {
  const cooldownMs = tuning.cooldownMs ?? RECOVERY_COOLDOWN_MS
  const failureBackoffMs = tuning.failureBackoffMs ?? RECOVERY_FAILURE_BACKOFF_MS
  if (!isBrokenIdbConnection(err)) return 'surface'
  if (ctx.msSinceFailedRecovery < failureBackoffMs) return 'surface'
  if (ctx.connectionOpen && ctx.msSinceReopen < cooldownMs) return 'retry'
  return 'reopen-and-retry'
}

/** One-line, bounded rendering of a storage error for the debug ring — the
 *  raw WebKit message is long and the next dump must be able to grep it. */
export function describeStorageError(err: unknown): string {
  const text = errorText(err).replace(/\s+/g, ' ').trim() || 'unknown error'
  return text.length > 180 ? `${text.slice(0, 179)}…` : text
}

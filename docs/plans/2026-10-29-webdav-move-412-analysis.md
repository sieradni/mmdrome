# Browser WebDAV MOVE 412 after 1.4.4

Date: 2026-10-29. Reviewed revision: `59785a5` (1.4.4).
Scope: analysis of the supplied trace, source review, and an isolated model
reproduction. No application changes, deployment, or requests to the user's
server were performed. The supplied credential is deliberately excluded.

Implementation follow-up: browser MOVE now sends explicit `Overwrite: T` while
retaining revalidation and omitting If headers. The real HTTP fixture models
both standards-default and explicit-T-required servers; the existing browser
cache/remote-tag preservation regression runs against both. The analysis below
records the pre-fix 1.4.4 behavior. No live-host confirmation is claimed.

Validation: the added real-browser explicit-T-required case reproduced the
original 412 before the application fix and passed afterward. Both server modes
pass; 1,572 unit tests, type checks (zero errors/warnings), and 15 targeted
browser tests passed. The production change is one unconditional Overwrite T
header, with no new retry or capability state.

## Conclusion

The trace shows a readable **HTTP 412 response to the actual MOVE**, not the
previous CORS preflight failure. The leading explanation is an overwrite
compatibility regression in 1.4.4: browser mode omits `Overwrite: T`, but some
real WebDAV implementations require it to replace an existing destination.
The supplied server's CORS policy explicitly permits `Overwrite`, so sending
it would not introduce the header-permission problem shown in this trace.

This is strongly supported, but not confirmed against that host. A controlled
same-server comparison with and without the header, or backend identification
and logs, is needed to establish the host's exact reason for 412.

## What the supplied trace establishes

- MOVE was sent from the temporary upload to the original file's destination.
  The server returned 412 with an allowed origin and a readable response.
  This attempt got past CORS and reached a responding HTTP server/proxy.
- The request carries Destination and Authorization, with no If, If-Match,
  If-Unmodified-Since, or Overwrite header. This matches the 1.4.4 browser path.
- The CORS response permits Authorization, Content-Type, Depth, Range,
  Destination, and **Overwrite**, plus every method used by this push.
- `pre revalidated` identifies the app's selected write mode. It does not mean
  the client sent a conditional header. In this mode the core only reaches
  MOVE after its fresh destination comparison reports unchanged.
- The app reports `failed-move`, `remote not-committed`, `local not-needed`,
  and successful temp deletion. It received a rejection, removed its upload,
  and did not mark the edit synchronized.

Cloudflare headers and HTTP/3 identify the outward serving path, not the
WebDAV backend. The 19-byte text response alone does not identify the backend
or prove what condition failed. The encoded source and Destination paths are
consistent: spaces and brackets are percent-encoded, and the source adds the
temporary suffix. The trace provides no specific evidence of a path-encoding
failure or of a real concurrent writer.

## Introducing application change

`f92453d` introduced `AtomicWriteOptions.revalidateOnly`, selected for browser
writes by `runManualWebDAVSync` on both initial and recovery attempts
(`src/lib/syncEngine.ts:981`, `1089`). It removed conditional MOVE headers and
also omitted Overwrite (`src/lib/webdavAtomicWrite.ts:311`). The latter relied
on the standards-defined default.

That default is real: [RFC 4918 §10.6](https://www.rfc-editor.org/rfc/rfc4918.html#section-10.6)
requires an omitted Overwrite header to behave as T. The mistake was treating
that standard requirement as sufficient evidence of deployed interoperability.
Restoring explicit overwrite intent is separate from restoring the optional
conditional headers that caused CORS failures.

## A concrete server implementation explains this exact response

The current official [Go WebDAV handler source](https://github.com/golang/net/blob/master/webdav/webdav.go)
passes `r.Header.Get("Overwrite") == "T"` to its MOVE implementation. An absent
header therefore becomes false. Its COPY path uses a different expression,
`!= "F"`; testing COPY would not establish MOVE behavior.

The associated [moveFiles implementation](https://github.com/golang/net/blob/master/webdav/file.go)
checks whether the destination exists. If it exists and overwrite is false,
it returns HTTP 412 before renaming. An explicit T permits replacement.

That is a verified example of the behavior, not an identification of the user's
server. It nevertheless explains all the important observations: temp PUT
succeeds, the original destination already exists, the fresh comparison is
unchanged, no conditional headers are present, and MOVE consistently returns
412 for every replacement.

## Isolated reproduction

The real `webdavPutAtomic` core was executed with an injected transport
modeling that verified Go rule and an existing destination. The only request
difference between the two scenarios was adding Overwrite T to MOVE.

| Request | Observed sequence and outcome |
| --- | --- |
| Current browser request, no Overwrite | PUT 201 → PROPFIND 207 (unchanged) → MOVE 412 → DELETE 204. Error: failed MOVE, revalidated, not committed, temp deleted. |
| Same request with Overwrite T | PUT 201 → PROPFIND 207 (unchanged) → MOVE 204. Success reported as revalidated. |

This reproduces the app's reported failure under a concrete documented server
rule. It is a model test, not a live-host confirmation. The local diagnostic
script is `test-results/move-412-analysis.mjs` (ignored, temporary artifact).

## Why tests passed

The real HTTP fixture in `tests/e2e/localServers.ts` replaces an existing file
after the conditional-header checks without evaluating Overwrite at all.
Consequently it cannot expose a server requiring an explicit T. The browser
test's essential-header allowlist also omitted Overwrite, so it actively
endorsed the omission. The unit test for minimal headers required exactly
Authorization and Destination. Together these tests pinned our chosen request
shape and a permissive fixture, rather than this deployed replacement behavior.

The correct standards default does not make those tests evidence that all
real servers accept omission. The previous report's minimal-permissions claim
was too broad for the server behaviors covered.

## Why the report says failed-move without retry

`webdavAtomicWrite.ts:351` only applies its 412 dialect/conflict decision to
conditional rungs. A 412 on `revalidated` reaches the ordinary HTTP failure
path (`:373`), deletes the temp, and throws AtomicWriteError. `syncEngine.ts`
classifies that as an HTTP MOVE failure. The report accurately reflects the
current code, but it cannot tell the user which server condition failed.

Additionally, the atomic-write response interface consumes status for MOVE;
it does not capture the server's error body or request identifier in this
failure. Better bounded, redacted MOVE diagnostics would help distinguish
future failures, though they are not required for the likely correction here.

## Recommended next step

1. Confirm the overwrite behavior using disposable files on the same host:
   create an existing destination and a temp source; compare a MOVE with only
   Destination against one also carrying Overwrite T. Keep conditional headers
   absent in both. This need not touch a music file.
2. Restore explicit `Overwrite: T` on browser MOVE, retaining fresh reads,
   mandatory unchanged revalidation, cleanup, and the absence of If headers.
   This is a small request-construction change, not a new fallback ladder.
3. Add a fixture mode requiring explicit T for existing destinations and a
   browser regression against the supplied allowlist. Keep a standards-default
   fixture too. Update the practical CORS baseline to include Overwrite.
4. Do not add automatic weaker retries for arbitrary fetch errors, delete the
   destination before MOVE, or switch to direct whole-file PUT as a workaround.
   Those would change uncertainty handling or replacement safety unnecessarily.

If explicit T still returns 412, the next evidence is the actual response body
and backend/version or request-correlated server log. At that point server
replacement policy, proxy header handling, or a custom precondition remains
possible; none is established by the current trace.

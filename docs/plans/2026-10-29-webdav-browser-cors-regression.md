# WebDAV browser push: Cache-Control CORS regression

Date: 2026-10-29. Reviewed revision: `13efe8a` (package version 1.4.2).
Scope: analysis and reproduction; no application changes made.

Implementation follow-up (2026-10-29): the correction below is now implemented
for release 1.4.3. GET and PROPFIND use `cache: 'no-store'`; the native adapter
preserves its revalidation header. The permanent regression is
`tests/e2e/realservers.spec.ts` — “push stays fresh when CORS forbids
cache-control and an older GET is cached”. It proves a stale cache exists,
preserves a newer remote tag through push, and confirms a tagged-If guard.
Validation passed: 1,565 unit tests, type checks (zero warnings/errors), and
13 browser tests covering real servers, push outcomes/collisions and boot.
The analysis below records the original revision and investigation.

## Finding

The reported error matches a confirmed browser compatibility regression introduced by `b33fdc976dbfe0709fdffd09ba09efd9ff0a3f19` on October 27 (included in `ios-v1.4.2`). That change explicitly added `Cache-Control: no-cache` to two push reads:

| Request | Source | Purpose |
| --- | --- | --- |
| GET of the original music file | `src/lib/syncEngine.ts:241`, `webdavGet` | Obtain fresh bytes before editing tags. |
| PROPFIND, Depth 0 | `src/lib/webdavAtomicWrite.ts:165`, `readDestinationValidators` | Obtain the collision baseline before GET, then re-check the destination before MOVE and after rejected preconditions. |

The freshness requirement is valid. Its implementation expands the browser request-header permissions required from the WebDAV server. A server that previously allowed Authorization, Depth and the write headers can reject these reads if its `Access-Control-Allow-Headers` omits `cache-control`.

This is an application compatibility regression against restrictive CORS configurations. The server is enforcing its advertised policy. Header capitalization cannot fix it: CORS compares header names without case sensitivity.

## Failure sequence and impact

1. Push calls `readPushBaseline` before downloading the file (`syncEngine.ts:919`). Its PROPFIND preflight asks permission for `authorization,cache-control,content-type,depth`.
2. A server omitting `cache-control` rejects that permission check. The browser does not send the actual PROPFIND and exposes a fetch rejection to JavaScript.
3. `readDestinationValidators` catches the rejection and returns `unknown` (`webdavAtomicWrite.ts:171`). `readPushBaseline` converts that into an absent baseline.
4. The following GET explicitly sets the same header. Its preflight asks for `authorization,cache-control` and fails too.
5. The row fails before tag editing, temp PUT or MOVE. It remains pending. The error is classified as `network`, normally at `get-headers`, with disposition `failed-get` (`syncEngine.ts:670–683`, `1210–1230`).

For this read-stage failure, the target file is unchanged and no temp upload has occurred. Other rows in a batch can still have committed; this does not establish the state of an entire mixed run.

Affected conditions: browser execution, cross-origin WebDAV, and a preflight policy that does not permit this new explicit header. Same-origin deployments and servers allowing the header avoid this specific failure. Native requests use `CapacitorHttp.request` instead of browser fetch (`webdavUtils.ts`), so browser CORS enforcement does not explain a native failure.

The console message is more specific than the application's report because JavaScript generally receives a network error for a failed CORS check. The app cannot reliably infer “cache-control denied” from a generic fetch rejection alone.

## Verification

A standalone diagnostic used Playwright Chromium **151.0.7922.34**, two different origins (`localhost` page → `127.0.0.1` HTTP endpoint), and a real local HTTP server. The server permitted GET/PROPFIND and only `authorization, depth, content-type` request headers. Responses were deliberately cacheable (`public, max-age=3600`). Each successful variant was fetched twice at the same URL.

| Request configuration | GET | PROPFIND | Observation |
| --- | --- | --- | --- |
| Explicit `Cache-Control: no-cache` | Blocked | Blocked | OPTIONS listed `cache-control`; actual read never reached the server. |
| `cache: 'no-store'`, no explicit cache header | Passed | Passed | Both reads reached the server each time; preflight header list omitted `cache-control`. |
| `cache: 'reload'`, no explicit cache header | Passed | Passed | Both reads reached the server each time. |
| `cache: 'no-cache'`, no explicit cache header | Passed | Passed | Both reads reached the server each time in this experiment. |
| Default cache, no explicit cache header | Passed | Passed | Second GET reused the first response; PROPFIND reached the server twice. |

Important distinction: Chromium still generated wire-level `Cache-Control: no-cache` and `Pragma: no-cache` for `no-store`. Those browser-added headers were absent from `Access-Control-Request-Headers`. Browser cache options therefore do not impose the same preflight permission requirement as adding those headers in application code.

This agrees with the [WHATWG Fetch Standard](https://fetch.spec.whatwg.org/#http-network-or-cache-fetch): cache directives are added during HTTP network/cache processing, after the [CORS preflight permission check](https://fetch.spec.whatwg.org/#http-fetch). The standard defines `no-store` as behaving without the HTTP cache. This experiment verifies Chromium; Firefox, Safari and the affected production server have not been exercised.

Existing targeted unit suites also pass: **30/30** across `tests/webdavAtomicWrite.test.ts` and `tests/pushSyncEngine.test.ts`. These tests passing alongside the reproduction demonstrates the coverage gap, not production compatibility.

Local reproduction script and captured requests: `test-results/cors-push-analysis.mjs` and `test-results/cors-push-analysis.json` (ignored diagnostic artifacts). Run `node test-results/cors-push-analysis.mjs` while those artifacts remain available.

## Why current tests missed it

- Unit tests inject a transport, so they do not execute browser CORS checks. `tests/pushSyncEngine.test.ts:198–199` and `tests/webdavAtomicWrite.test.ts:129` explicitly require the problematic header. They pin the chosen mechanism rather than just fresh-read behavior.
- The real-server browser fixture explicitly permits `cache-control` (`tests/e2e/localServers.ts:215–216`). Real sockets are useful, but this fixture cannot expose a missing-header permission regression.

## Recommended correction

1. For browser push reads, express freshness with `RequestInit.cache: 'no-store'` and omit the application-supplied `Cache-Control` header. Apply it to **both** GET and PROPFIND; changing only GET leaves validator reads silently failing and can degrade writes to the existing `blind` path.
2. Preserve baseline-before-body ordering, the pre-MOVE re-check, and the conditional MOVE ladder. Simply deleting the GET header while retaining default caching is insufficient: the reproduction showed reuse of stale file bytes, which could then be paired with a fresh baseline and overwrite newer remote content.
3. Handle platform differences explicitly. The web transport already forwards RequestInit to fetch (`webdavUtils.ts:95`); the native adapter copies headers into CapacitorHttp and does not forward `cache`. A browser-only cache option must not accidentally remove the native freshness directive. Keep native headers or map the freshness intent in the transport, with native cache behavior verified separately.
4. Replace header-only assertions with appropriate freshness/transport checks. Add a restrictive CORS fixture that omits `cache-control` and a real-browser push test proving successful commit, retained collision checks, and fresh bytes despite a cacheable earlier GET. Retain the permissive fixture too.
5. Keep validator-read failure distinguishable from “server publishes no validators” in future diagnostics. The current catch-all hides the first failure; do not turn every generic network error into a claimed CORS diagnosis.

Immediate server-side workaround: explicitly include `cache-control` in the relevant OPTIONS response's `Access-Control-Allow-Headers`, preserving the other required headers, allowed origin and methods. `Access-Control-Expose-Headers` controls response visibility and will not fix this request-header rejection. This workaround requires control of the server or proxy; the application correction avoids imposing it on existing installations.

## Separate compatibility issue to track

The MOVE ladder can introduce `If`, `If-Match`, or `If-Unmodified-Since`. A server's CORS policy must allow whichever header is used. The current ladder advances on **HTTP 412 with a proven unchanged destination**, but a CORS-blocked MOVE rejects fetch and goes directly to cleanup/error (`webdavAtomicWrite.ts:298–313`), without trying the next rung.

Consequently, fixing cache-control does not prove compatibility with every WebDAV server. Add a separate browser case where `If` is disallowed but another guard header is allowed. Do not broadly retry or weaken guards on a generic fetch rejection: the browser also uses that error for ambiguous network failures where a MOVE might already have committed. Any fallback design must preserve that uncertainty and the existing collision rules.

## Conclusion

The reported mechanism is reproduced and its introducing commit is identified. A browser cache option provides a verified Chromium route to fresh reads without the new preflight requirement. Implementation should cover both read sites, preserve native behavior and collision checks, and add restrictive browser CORS coverage. Production-host and cross-browser verification remain outstanding.

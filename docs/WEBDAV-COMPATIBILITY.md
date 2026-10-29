# WebDAV compatibility evidence

Audit: 2026-10-29, preparing 1.4.5. This is a tested matrix, not a promise that
every version, proxy, authentication scheme or storage driver works.

## Live implementations

The same production atomic-write core, validator parser and tag editor were
run against real upstream servers on disposable local filesystems. Browser
requests ran through Chromium 151 and Firefox 153 with real cross-origin preflights, using a
reverse proxy permitting only Authorization, Content-Type, Depth, Destination
and Overwrite, with no exposed response headers. The proxy implements CORS and
test Basic authentication; it does not simulate DAV responses or file writes.

| Implementation | Version tested | Normal MP3 / Opus writes | Additional findings |
| --- | --- | --- | --- |
| Go WebDAV | golang.org/x/net v0.62.0, Go 1.26.0 | Pass | Explicit Overwrite T required. Response-loss replay can remove the committed destination; see below. |
| Apache mod_dav_fs | Apache 2.4.69 | Pass | 14/14 scenarios pass with a working DAV lock database. Alpine image needs its DBM plugin installed. |
| sabre/dav | 4.7.0 | Pass | 14/14 scenarios pass. This tests the engine, not a complete Nextcloud/ownCloud installation. |
| rclone serve webdav | 1.75.2, local backend | Pass | Explicit Overwrite T required. Same response-loss replay hazard as Go. Other rclone storage providers were not exercised. |
| Dufs | 0.47.0 | Pass | 14/14 scenarios at its advertised validator granularity. DAV publishes second-resolution last-modified without ETag. |
| WsgiDAV | 4.4.0, cheroot 11.1.2 | Pass | 14/14 scenarios pass. |
| nginx + DAV extension | nginx 1.30.6, Alpine dav-ext package | Pass | 14/14 scenarios at its advertised validator granularity. The tested extension publishes last-modified without ETag. Stock nginx DAV alone is insufficient. |

Each browser ran 98 scenarios: 96 passed and two recorded the upstream replay
limitation below. There were no unexpected failures in the final runs. The
date-only validator limits are recorded at the server level as well.

The suite covers three filename shapes (spaces, brackets, Unicode, literal #,
& and %), replacement of an existing file, real MP3 and Opus rating writes,
discovery, single-range reads, concurrent changes during temp upload, cancel
cleanup and dropped MOVE responses. Both the browser mode and the native-core
conditional ladder are exercised. The latter uses Node HTTP, not an iPhone or
Capacitor URLSession; native device behavior remains a separate verification.
The app's built-bundle browser tests provide the UI/orchestration coverage;
this matrix targets the real server protocol boundary.

## Limits the audit exposed

### Lost-response replay on Go WebDAV / rclone

In the fault test, the server commits MOVE, then the proxy drops its response.
Both tested browser stacks transparently repeated the request. The
application invokes fetch once, but the server sees two MOVEs. Go/rclone were
observed removing the destination on the replay before discovering that the
source temp was already gone. The original successful replacement can therefore
be followed by a missing destination. This server/proxy/browser combination
cannot be described as safe under that failure, even though normal writes work.

The client now reports an unknown outcome whenever a MOVE failure is followed
by a missing temp. It keeps the local edit pending, reserves the target for the
rest of the batch, and does not initiate another upload. This prevents a false
“not committed” claim; it cannot undo an HTTP-stack replay or repair an upstream
destructive rename implementation automatically. Prefer a server implementation
that preserves the destination when the MOVE source is absent, and test proxy
failure behavior. No direct-PUT or delete-before-MOVE workaround was added.

This is consistent with the upstream implementations:
[Go MOVE dispatch](https://github.com/golang/net/blob/master/webdav/webdav.go),
[Go file replacement](https://github.com/golang/net/blob/master/webdav/file.go),
[rclone's Go handler](https://github.com/rclone/rclone/blob/v1.75.2/cmd/serve/webdav/webdav.go),
and [Chromium's reused-connection retry](https://github.com/chromium/chromium/blob/main/net/http/http_network_transaction.cc).

### Validator precision and the final race

Dufs and the tested nginx extension publish last-modified without an ETag in
DAV XML. A timestamp rounded to seconds can miss two updates in one second.
Their concurrent-write test deliberately crosses that advertised resolution;
the evidence records the same-second limitation, rather than claiming a hash
or revision comparison. Other metadata-derived ETags can have analogous limits
on filesystems with coarse timestamps. No file size was promoted to a validator.

Every browser mode also has a final re-check→MOVE race. The minimal CORS path
provides a fresh client check, not an atomic server-enforced comparison. It
refuses unreadable/missing/incomparable validators, but cannot manufacture a
stronger revision token than the server supplies. See the actual Dufs
[DAV property output](https://github.com/sigoden/dufs/blob/v0.47.0/src/server.rs).

## Product/configuration review, not live product certification

| Product or setup | Evidence and support boundary |
| --- | --- |
| Nextcloud | Uses sabre/dav, as shown in its [dependency manifest](https://github.com/nextcloud/3rdparty/blob/master/composer.json). The engine passed; product plugins, locking, encryption, external storage and per-user permissions were not live-tested. |
| ownCloud | Review the deployed version's DAV layer and authoring permissions. No full ownCloud instance was exercised; a passing sabre engine is not product certification. |
| OpenList / AList-derived servers | Current OpenList [MOVE code](https://github.com/OpenListTeam/OpenList/blob/main/server/webdav/webdav.go) requires explicit T. [Permissions](https://openlistteam.github.io/OpenList-Docs/guide/advanced/webdav) and the selected storage driver's rename/delete/upload behavior matter. No cloud-driver combination is certified by the local-filesystem runs. |
| Cloudreve | [Current replacement code](https://github.com/cloudreve/Cloudreve/blob/master/pkg/webdav/webdav.go) handles overwrite explicitly. An [upstream 4.18.0 report](https://github.com/cloudreve/cloudreve/issues/3537) documents a temp-rename replacement defect. Check the deployed version; current source is not proof that an older installation has the fix. |
| IIS WebDAV | Requires WebDAV Publishing and its separate [authoring rules](https://learn.microsoft.com/en-us/iis/configuration/system.webserver/webdav/authoringrules/), plus CORS and a compatible Basic-auth/TLS setup. Not live-tested. |
| nginx built-in DAV only | Insufficient: [built-in methods](https://nginx.org/en/docs/http/ngx_http_dav_module.html) omit PROPFIND. The [DAV extension](https://github.com/arut/nginx-dav-ext-module) supplies discovery; the configured combination was live-tested above. |
| NAS, hosted DAV and reverse proxies | Require the same method/header permissions, writable temp files, replace-capable MOVE, usable validators, correct external Destination/Host handling and Basic authentication accepted by the app. Vendor/version/provider combinations need their own run; no universal claim is made. |

## Repeat the gate

Prerequisites: Node/npm dependencies, Playwright Chromium (or Firefox), Go 1.26 and a running
Docker engine. The Docker images and server dependencies are pinned in
`tests/webdav-servers/`; the suite builds its own small integration images.

```sh
npm run test:webdav-servers
npm run test:webdav-servers -- apache sabre wsgidav
npm run test:webdav-servers -- --strict
```

Set `WEBDAV_BROWSER=firefox` to select Firefox (PowerShell:
`$env:WEBDAV_BROWSER = 'firefox'`). The default is Chromium. The CI workflow runs
both engines as separate jobs. This command is opt-in and is not part of Node's
ordinary unit-test discovery.

Each run creates `webdav-compat-results/run-*/report.json`, including exact
image identities, individual case results, request/status traces and observed
limitations. Containers/processes are stopped afterward; disposable files stay
with the evidence. All services bind to loopback. No user server or credentials
are used.

The evidence directory is separate from Playwright's test-results directory,
which the UI suite clears on startup. Both suites can run independently.

Unexpected failures exit nonzero. Known *observed* upstream limitations are
reported separately as `limitation` / `passed-with-limitations`; they are not
counted as passed cases. `--strict` also exits nonzero for those limitations.
The GitHub WebDAV compatibility workflow runs the same gate on relevant pushes
and preserves its evidence. A green default job means no new unexpected
failure, not that every listed server has identical guarantees.

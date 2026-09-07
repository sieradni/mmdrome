# Low Data Mode + Cellular Auto-Toggle + Transcoding — Plan (2026-09-06)

Status: PROPOSED (design verified against codebase + Navidrome source; not yet implemented)

## 0. Answers up front

- **Cellular auto-toggle "before anything happens"?** On **iOS native: yes, verifiably** — the boot chain (App.svelte `onMount`) does Dexie restore + local session restores (zero network) *before* the Navidrome load pipeline, so a plugin network-state call awaited at that point gates every costly automatic request deterministically. On **web: no true cellular API exists** — only the Network Information API heuristic (`navigator.connection.effectiveType`, Chromium-only; Safari provides nothing). The setting must degrade honestly there (heuristic on Chrome/Android, never engages on Safari/WebKit).
- **Will transcoding work with preloading? Yes, on both platforms** — the web preloader `fetch`es whole responses into the Cache API (an estimated `Content-Length` from `estimateContentLength=true` doesn't matter to `fetch`), and the native loader `URLSession.downloadTask`s the snapshot URL the same way it does raw ones. The caveat is cache-key staleness when transcode params change (§4.4). CORRECTION (2026-09-06): the earlier claim that `AVAudioFile` cannot read ogg/opus on iOS was an unverified memory assertion — the user plays opus files natively today (empirical), Safari gained full opus-in-`<audio>` support on iOS 18.4 (caniuse: partial before, full from 18.4), and the native engine strips stream URLs to no extension so `AVAudioFile` probes headers rather than trusting suffixes. What remains TRUE and is now stated precisely: if opus plays in the native iOS app, that IS the AVAudioFile path (full download → header probe → decode) and the blanket claim is directly falsified on that device; if it plays in the PWA, that's Safari's decoder — either way, per-device capability is decided at runtime, so §5.6 replaces the hard ban with a capability probe.
- **Navidrome transcoding semantics were verified against Navidrome master** (`server/subsonic/stream.go`, `core/stream/decider.go`, `core/stream/legacy_client.go`, `consts/consts.go`), not from memory. Key facts in §4.1.
- **Default transcode format = opus (user decision 2026-09-06)** — corroborated by Navidrome itself: `consts.DefaultDownsamplingFormat = "opus"` and the built-in opus profile defaults to 128 kbps. MP3 is an automatic fallback ONLY on a failed per-device capability probe (never a silent downgrade — the settings surface states the effective format and why). The picker exposes every built-in server format (opus/mp3/aac/flac) plus a custom format field for server-defined ffmpeg commands; every choice is probe-verified per device.

## 1. Verified inventory: what spends data automatically today

### Boot chain (App.svelte `onMount`, in order)
1. `initStores()` / `initEqStore()` — Dexie only, no network.
2. `restoreLfmSession()` — local read only.
3. `scrobbleFlushEngine.init()` — restores pending count; **kicks an immediate flush if rows are pending**; installs `online` listener + 60 s tick.
4. If Navidrome credentials exist: `setCachedConfig` → `loadLibraryFromNavidrome()`:
   - `connectNavidrome`: ping + **search3 pagination** (whole catalog, 500/page) + `getScanStatus`.
   - Applies library (server or cached fallback via `planNavidromeLoad`).
   - If WebDAV configured and `navigator.onLine`: **`void scanAll('modified')`** — one PROPFIND (Depth: infinity or BFS crawl), mtime diff, then chunked-Range GETs for changed files, reverse binds, fingerprint-gated unmatched retries.
5. `ensureTagProbeAfterRestore()` — WebDAV configured + online → **background tag probes** (bounded rotating window).
6. `playbackManager.init()` — native: queue snapshot with per-track stream+cover URLs; `setPreloadCount(preloadTracks)`.

### While running
- **Web preloader** (`preloadTracks > 0`, WEB ONLY): 1 s poll; fetches the next N tracks fully into Cache API within the last 30 s of the current track.
- **Native prefetch**: `prefetchUpcoming` at schedule time downloads the next N tracks fully to disk (`setPreloadCount`).
- **Scrobble flush**: 60 s tick + `online` kicks; direct Last.fm/ListenBrainz POSTs; Navidrome `scrobble` (now-playing + submission) fires per listen from `scrobbleManager`.
- Thumbs: on-scroll only (LazyThumb + thumbLoader distance queue) — **already user-driven**.
- File Matching Refresh, Rescan All, Check Modified Ratings, Push Changes, Trigger Navidrome Scan — **already explicit buttons**.

### Structural choke points (load-bearing for this plan)
- All WebDAV traffic → `webdavFetch` (webdavUtils.ts). Navidrome API → plain fetch. Stream/cover URLs → plain `<audio src>` / URLSession (NOT through webdavFetch).
- Auth params are cached per (username, password) (`buildAuthParams`, navidromeApi.ts:133) → **stream URLs are deterministic cache keys** (salt/token stable until credentials change). The preloader's Cache-API keys and the native snapshot URLs already exploit this.
- C6 boundary: LDM/transcode flags are reactive policy/config scalars → **`settings` object store + `updateSetting`**, not `persisted()` stores.

## 2. Low data mode — spec

### Principle
Kill **automatic** network work only. Anything the user clicks still works (one deliberate tap = the user spending their own data). Streaming and thumbnails stay (core function; explicitly requested to keep). Auto-preload is borderline → **stays ON** in LDM (it's bounded to the next few tracks and is what makes LDM streaming viable on a marginal connection).

### Effective state (single read path)
```
effectiveLowData = settings.lowDataMode || (settings.lowDataOnCellular && networkStatus.isCellular)
```
Exposed as a derived store from the new `src/lib/networkMode.ts`. **All consumers read `effectiveLowData`, never the raw setting.**

### What LDM disables
| # | Operation | Mechanism |
|---|---|---|
| 1 | Boot auto-scan (`scanAll('modified')` after connect) | `planNavidromeLoad` gains a `lowData` input → `scanWebdav: false` (pure-planner change, test-pinnable). Library connect itself still runs — it's essential and user-configured. |
| 2 | Boot tag probe (`ensureTagProbeAfterRestore`) | Skip when `effectiveLowData` at that moment. |
| 3 | Web preloader | Settings subscription additionally gates the poll timer on `!$effectiveLowData` — timer stops on engage, restarts on lift. |
| 4 | Native prefetch | `setPreloadCount(0)` while engaged (existing settings-subscription push site; extend to react to `effectiveLowData`), restore after. |
| 5 | Scrobble flush auto-drain | `ScrobbleFlushEngine.setAutoFlushEnabled(false)`: `kick()` no-ops, 60 s tick skips. Rows stay in the durable `pendingScrobbles` queue — nothing is lost. |
| 6 | Navidrome scrobbles (now-playing + submission) | Gated in the `scrobbleManager` destination fan-out on `effectiveLowData`. LDM listens won't appear in server history — documented tradeoff. |

### What LDM does NOT touch
Streaming, explicit scan/push/matching buttons, queue mutations, File Matching Refresh, sleep timer, `navigator.storage.persist()`. The connect-time search3 pagination is **not** trimmed (a partial library would break search; the cache fallback already covers offline).

### Thumbnail quality (2026-09-06 addition — verified: thumbs are the biggest LDM win)
`LazyThumb.svelte` calls `getCoverUrl(track, $coverConfig)` with NO size → `buildCoverArtUrl` sends no `size` param → **every list/grid thumbnail today downloads the ORIGINAL-resolution cover file** (often 1–3 MB). The only sized consumers are the media-session/lock-screen paths (512). Proposal, safe by construction:
- `buildCoverArtUrl(config, id, size)` already supports Subsonic `size`; `coverArtCache` keys are `trackId-<size ?? 'original'>` (C5) so different sizes never collide — no staleness risk.
- Add per-context size defaults via a restored `size` prop on LazyThumb (it existed and was swept as dead when all call sites passed nothing): list rows 128, album/artist grid cells 256, now-playing/detail large art 512, native snapshot stays 512. LDM overrides each down one canonical step (128→96… or simply forces 128 for lists/grids, keeps 512 for now-playing).
- Use ONLY canonical sizes (96/128/256/512) so Navidrome's disk-cached resize results are reused instead of triggering per-size resize jobs.
- Failure mode is cosmetic-only (blurry large art if LDM shrinks now-playing too far — so it doesn't), and the existing `onerror` → brand-icon fallback is unaffected. `crossorigin=anonymous` behavior unchanged (same endpoint).

### Transitions
- **Toggled ON mid-session**: cancel an in-flight scan via `cancelScan()` (D4-resumable — processed rows keep results; the cancelled landing's honest copy + Resume scan button already exist). A user-initiated Push in flight is **left to finish** (don't cancel work the user just asked for). Preload stops; native count → 0; flush disabled.
- **Lifted (manual off, or cell→Wi-Fi with `lowDataOnCellular`)**: **no automatic make-up scan** — no suppressed-op backlog exists by design (same reasoning as C7: a state-change-triggered scan would also surprise the user mid-session). Preload resumes; flush resumes on the next tick (kick once on the transition).
- No resume buttons needed anywhere — the suppressed ops are all re-derived on their next natural trigger.

### Settings surface
New "Data & Network" section (Settings): `Low data mode` toggle, `Auto-enable on cellular` toggle (+ honest platform note: "Native iOS detects cellular exactly; web uses approximate browser network hints and may never engage on Safari"), plus the transcoding controls (§4.3).

## 3. Cellular detection — platform reality

- Project deps today: `@capacitor/core` + `@capacitor/ios` only — no network plugin.
- **Web**: `navigator.connection.effectiveType` + `saveData` + `change` events. `effectiveType: '4g'` is reported on Wi-Fi *and* good cellular, so at best a heuristic (`isCellular ≈ effectiveType ∈ {slow-2g, 2g, 3g}`). Safari ignores the API entirely → never engages on WebKit.
- **iOS native**: no JS-reachable cellular API, but the project **owns a native plugin** (BackgroundAudio). Add `NWPathMonitor` there: `path.isExpensive` (cellular/hotspot) + `path.isConstrained` (Low Data Mode at the OS level — worth surfacing too) → new plugin method `getNetworkState` + an event + a field in `getState()`. No new dependency, and CI (`Build unsigned app`) compiles it.
- **Ordering guarantee**: `networkMode.init()` is called in `onMount` BEFORE the Navidrome block; on native it awaits `getNetworkState` (fails soft → `known: false`, boot proceeds ungated). This is the "before anything happens" answer: the only earlier work is local.
- **PWA on iOS (Safari, non-native)**: no cellular API at all — `lowDataOnCellular` never engages; manual LDM still works. UI must say so.

## 4. Transcoding (Navidrome server-side)

### 4.1 Verified server semantics (Navidrome master)
- Params on `stream.view`: `maxBitRate` (kbps), `format` (`mp3`, `opus`, `raw`, …), `estimateContentLength=true` → Content-Length becomes an *estimate* for transcoded streams (Navidrome supports it; otherwise transcoded responses are unlength'd, which breaks some client progress math).
- Decision path (`legacy_client.go::buildLegacyClientInfo` + `ResolveRequest`):
  - Explicit `format` ≠ source → forced transcode profile at `maxBitRate` (default 256 kbps fallback server-side).
  - Bitrate-only (`maxBitRate < source bitrate`, no format) → downsamples to server's `DefaultDownsamplingFormat`.
  - Source at/below the cap with no format → **direct play** (raw) — so sending `maxBitRate` universally is free for small files.
  - Explicit `format=raw` short-circuits everything (bypasses even player-level overrides).
  - Player-level transcode overrides (set in the Navidrome UI per player) apply *after* legacy params and can still force transcode.
  - No compatible profile → falls back to `DefaultDownsamplingFormat`, ultimately raw. **A bad request degrades to full-data, never to failure.**
  - Server needs ffmpeg for transcodes; without it everything is raw (silent from the client's view).
- Seeking on transcoded streams: Navidrome serves HTTP byte ranges over the ffmpeg pipe and sets `X-Content-Duration`; `HTMLAudioElement`/AVAudioFile seeking works. `estimateContentLength` is an estimate (VBR) — irrelevant to us because **A1 already forbids binding element duration** (`track.duration` stays the sole truth).

### 4.2 Client design
- New settings (SettingsMap): `transcodeMode: 'off' | 'lowData' | 'always'` (default **'off'** — no silent behavior change), `transcodeFormat: string` (default **'opus'**; kept a plain string, NOT a union — the custom-format field must type-check), `transcodeBitrate: number` (default **128**; picker offers 64/96/128/192/256/320; hidden/disabled when the chosen format is lossless like flac, which ignores bitrate server-side).
- Format picker: the four built-ins (opus — preferred/smaller at equal quality, mp3, aac, flac) plus **Custom…** free-text for any format the server admin has an ffmpeg command for. Server-side truth: an unknown/no-command format does NOT fail — `ResolveRequest` falls back to the server's `DefaultDownsamplingFormat` (opus on stock installs), so a bad custom format still yields transcoded audio, just not the requested codec (undetectable client-side; documented in the field's hint text).
- **Format capability probe + fallback (2026-09-06, user decision: opus default, mp3 only if actually necessary)**: one-shot probe per chosen format at connect (`new Audio()` + ~1 s of `format=<fmt>&maxBitRate=16`, fire-and-forget `canplay()`/`error` verdict, result cached per format+platform in the persisted settings store). On probe FAILURE for the chosen format: stream URLs automatically use `mp3` (the `effectiveTranscodeFormat` selector, pure + test-pinned) AND the settings section shows a dismissable notice ("Opus isn't supported on this device — using MP3"). No probe pass = no fallback, ever — necessity is demonstrated, not assumed. A failed probe is retried on next app start (OS updates can add support).
- ONE pure extension: `buildStreamUrl(config, songId, transcode?: { format: string; maxBitRate: number })` — optional third arg, default undefined = byte-identical current behavior (all existing tests stay green). Active params: `format`, `maxBitRate`, `estimateContentLength=true`. The `format` value is the EFFECTIVE format (already resolved through the probe/fallback selector), so the URL layer stays policy-free.
- Mode resolution: `'always'` → always attach; `'lowData'` → attach iff `effectiveLowData`; `'off'` → never. Computed once per URL build in the three call sites: `_resolveUrl` (web fg), the web bg load path, `_buildSnapshot` (native). WebDAV tracks are untouched (resolver only serves `navidrome-` ids).

### 4.3 Crossfade / preload interaction (the asked question)
- **Web preloader**: works unchanged — `fetch(url)` downloads the whole transcoded response; `cache.put` under the exact URL key. `estimateContentLength` doesn't matter to `fetch`. Preloaded blob + seek = fine.
- **Native loader**: `prefetch`/`downloadTask` from the snapshot URL, same as raw; the `pathExtension == "view"` stripping already handles `stream.view`; `AVAudioFile` probes the (transcoded) header. Default format is opus (see §4.2); any format that fails the device probe falls back to mp3 automatically.
- Crossfades between different formats (raw flac → next track mp3): separate audio elements + gain nodes are codec-agnostic; no impact. No-crossfade instant switches have the same tiny gap characteristics as today's mixed-format libraries. Same is true for transcoded-opus ↔ raw-opus switches: the container/codec being "the same" across a fade boundary is irrelevant — each element decodes independently.

### 4.4 Staleness handling when transcode-affecting settings change (mode/format/bitrate/LDM flip)
- **Web**: bump a preloader cache namespace (transcoded URLs differ from raw ones — stale entries become dead weight; simplest correct fix: derive `CACHE_NAME` from the current transcode params, or sweep non-matching keys). Explicitly call `_rearmCrossfadeTarget()` from the settings subscription (the A12 queue-subscription path doesn't fire on settings changes). The ARMED target's URL was resolved at arm time — dropping the arm lets the next monitor tick re-arm with fresh params.
- **Native**: trigger `this._scheduleNativeQueueSync()` (rebuild snapshot URLs) on the same change; the engine's next prefetch uses new params.
- **Deliberate semantics: the current track is never re-fetched mid-play** — new bitrate applies from the next track on both platforms. (Reusing `restartForParams` for transcode changes would interrupt audio for a cosmetic bitrate change; not worth it.) Document in the settings copy.

## 5. Risks & edge cases

1. **Web cellular detection is a heuristic at best** (impossible on Safari/WebKit) — never present it as exact.
2. **Boot race on native** — must await `getNetworkState` before the load pipeline; plugin failure falls through as `known: false` (never blocks boot).
3. **Preload cache staleness** on transcode-param change — key URLs include params; needs namespace bump or sweep (§4.4).
4. **Native snapshot staleness** on param change — refreshQueue path exists; wire it (§4.4).
5. **Mid-play switches don't apply** — next-track semantics, documented.
6. **Opus is the default; support is per-device → probe + auto-fallback (CORRECTED + DECIDED 2026-09-06)**. The original plan wrongly asserted `AVAudioFile` can't read ogg/opus on iOS (user empirically plays opus files; Safari has full opus-in-`<audio>` from iOS 18.4 per caniuse; Navidrome's own `DefaultDownsamplingFormat` is opus). Opus is therefore the default transcode format. Residual risk: pre-18.4 Safari PWAs (and hypothetical old-OS native decode gaps) — handled by the one-shot capability probe: on failure the client auto-falls back to mp3 for stream URLs and shows a settings notice; no fallback without demonstrated failure. The native engine's extension-stripping (§3.4) means format capability is decided by the OS audio toolbox at header-probe time, not by our suffix handling.
7. **Server without ffmpeg silently returns raw** (full data) — not client-detectable; note in settings copy.
8. **Scrobble semantics**: LDM gates Navidrome scrobbles entirely (server history gap) and defers Last.fm/ListenBrainz rows (already 13-day expiry — weeks-long LDM loses very old listens; poison/attempt rules unchanged).
9. **`Content-Length` on transcoded streams is an estimate** — harmless here (no duration binding per A1; fetch/URLSession stream until done).
10. **Player-level server overrides** can still transcode regardless of client params — out of our control, harmless direction.
11. **X-Content-Duration header exists** — do NOT start trusting it (A1).

## 6. Suggested implementation order (independent PRs)

1. **PR-A — plumbing**: `networkMode.ts` (`networkStatus` + `effectiveLowData` + `initNetworkMode()`), settings fields, Settings section. No behavior change. Tests: effective-mode selector matrix.
2. **PR-B — LDM gating**: `planNavidromeLoad` lowData input, probe gate, preloader gate, native preload-count push, flush `setAutoFlushEnabled`, scrobbleManager fan-out gate, cancelScan-on-engage. Tests: planner, preloader, flush engine, fan-out.
3. **PR-C — native cellular**: Swift `NWPathMonitor` in the BackgroundAudio plugin (`getNetworkState` + event + state field), JS wiring. CI compiles; runtime verified on device.
4. **PR-D — transcoding**: `buildStreamUrl` extension + 3 call sites + Settings controls (built-ins + custom format + bitrate) + capability probe + `effectiveTranscodeFormat` fallback selector + preloader-cache/snapshot invalidation. Tests: URL builder, format selector, probe verdict plumbing, manager invalidation, snapshot URLs.

Each PR keeps `npm run check` + `npm test` green; PR-C additionally gates on the iOS CI workflow.

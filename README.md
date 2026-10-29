# mmdrome

A self-hosted, mobile-first music player PWA. Streams from a Navidrome server via the Subsonic API. Built with Svelte 5, TypeScript, and Tailwind CSS.

## Features

- **Navidrome integration** — browse and stream your music library
- **Custom audio engine** — gapless playback, crossfading (up to 15s), ReplayGain (track/album), independent pitch and speed control via Web Audio API + SoundTouch
- **10-band graphic equalizer** — custom modifiable EQ presets stored locally
- **EQ Import** — Supports autoEQ parametric and GraphicEQ(EqualizerAPO).
- **iOS background audio** — handoff mechanism with media session controls, position polling, and EQ/filter bypass
- **Queue system** — user queue + auto-queue, shuffle, loop-one/loop-all, album/artist scoping
- **WebDAV metadata writing** — edit ratings, loved status, and comments back to your audio files via taglib-wasm
- **Direct scrobbling** — Last.fm (desktop auth flow) and ListenBrainz (user token) integration client-side: durable offline queue, now-playing, and outward heart sync — no server-side setup needed; Navidrome forwarding can stay off
- **Fuzzy search** — search tracks, artists, albums
- **PWA** — installable, works offline, service worker

## Requirements

- **Navidrome** server with Subsonic API access (required for streaming)
- **WebDAV** server (optional, for metadata write-back)

## Setup

```bash
npm install
npm run dev      # development server with HMR
npm run build    # production build
npm run preview  # preview production build
npm run check    # type checking (svelte-check + tsc)
npm run device   # build + run on a real host (docs/ON-DEVICE.md)
npm run deploy   # deploy to GitHub Pages
```

`npm run device` is the one way to get a build onto a real host and see what it did:
`--web` builds the real bundle and serves it on your Wi-Fi (add `--fixtures` for a local
Navidrome + WebDAV to point a phone at, or `--drive` to run the real-server exercise and print
the app's own log and push report); `--ios` builds, installs and launches on a simulator or a
connected iPhone and streams its console. Per-platform differences are handled inside the
command — nothing is dropped for not being available on your machine. The short version, with
the manual steps per host, is [docs/ON-DEVICE.md](docs/ON-DEVICE.md).

## iOS app (SideStore)

The native iOS build (background audio engine, lock-screen controls) is distributed as a SideStore source — install once, update from SideStore, no manual sideloading:

1. In SideStore, add this source URL (served from GitHub Pages — recommended, always current):
   `https://sieradni.github.io/mmdrome/sidestore/apps.json`
2. Install **mmdrome** from the source. SideStore signs it with your own Apple ID and refreshes it automatically before the 7-day expiry.

The same manifest is also served via jsDelivr at `https://cdn.jsdelivr.net/gh/sieradni/mmdrome@main/sidestore/apps.json`, but jsDelivr has repeatedly served stale versions after releases (three consecutive releases in 2026-09) even after cache purges — prefer the Pages URL.

Each iOS release is built in CI from an `ios-vX.Y.Z` tag as an unsigned IPA attached to a GitHub Release; the source file points at it. A tag or green build alone does not mean an update is available: CI must publish the IPA and finalize the manifest with its exact byte size before SideStore can install it. See the [release operator guide](docs/RELEASING.md) for the end-to-end procedure and verification checklist. Browse the [documentation index](docs/README.md) for the plans and engineering references.

## Architecture

The app is a client-side SPA. Music streams directly from Navidrome to the browser. Persistent data (settings, EQ profiles, queue, metadata cache) lives in IndexedDB via Dexie. The audio engine uses dual HTMLAudioElement instances for gapless playback, routed through Web Audio API nodes (gain, SoundTouch worklet, EQ biquad filters) to the destination.

## Background Playback

iOS suspends Web Audio API and worklets when the app goes to the background. mmdrome handles this with a dedicated background HTMLAudioElement (`_bgEl`) that takes over when the page visibility changes:

- On `visibilitychange` to hidden, the active element's position and source are transferred to `_bgEl`. Volume becomes the iOS hardware volume (Web Audio `GainNode` preamp is bypassed).
- SoundTouch pitch/speed shifting and the EQ biquad filter chain are unavailable in background mode. Only `playbackRate` is applied directly to `_bgEl`.
- Position polling runs every 250ms while in background mode because `timeupdate` events can stall on iOS.
- Media session actions (play, pause, seek, next/prev track) are routed to `_bgEl` when in background mode.
- On return to foreground, `_bgEl` is paused and the Web Audio context is resumed. Effects (EQ, SoundTouch) are reapplied.

This mechanism is iOS-specific. On desktop/Android the standard Web Audio pipeline remains active at all times.

## WebDAV Metadata Sync

WebDAV is optional and lets mmdrome read and write audio metadata (rating, loved status, BPM, comments) directly to your music files on the server.

**CORS required.** Your WebDAV server must allow requests from the mmdrome origin. The app uses PROPFIND to build a file index, GET for audio/tag reads, and PUT + MOVE to write via a temporary file. Browser pushes use fresh destination checks with only essential request headers. See [minimum CORS permissions and concurrency limits](docs/WEBDAV-CORS.md) and the [tested server compatibility matrix](docs/WEBDAV-COMPATIBILITY.md).

**Directory structure.** The WebDAV URL should point to the root of your music library (e.g., `https://example.com/remote.php/dav/files/user/`). The scanner does a recursive `PROPFIND /` to discover all files, then matches them to Navidrome tracks by comparing normalized artist + title from the filename. Files must have a path under the WebDAV root — the directory structure itself is not prescriptive beyond that.

**Write safety.** Writes use a temp-file + rename pattern (PUT to `.<original>.tmp`, then MOVE over the original) with ETag-based conflict detection. If the file changed on disk between read and write, the PUT is rejected and the sync reports a conflict.

## Limitations

- **Navidrome only.** Only Subsonic-compatible servers (Navidrome specifically) are supported. No direct filesystem playback, no other Subsonic implementations have been tested.
- **Web Audio API dependency.** Audio processing (EQ, SoundTouch, crossfading, ReplayGain) requires Web Audio API. If the AudioContext fails to resume, playback falls back to the raw HTMLAudioElement without effects.
- **iOS background mode bypasses effects.** Pitch/speed shifting and EQ are unavailable while the app is backgrounded on iOS.
- **No gapless for different-codec tracks.** Gapless playback crossfades between tracks regardless of codec, but seamless sample-accurate gapless (no crossfade) is not supported across format boundaries.
- **Service worker limited.** The PWA service worker (`public/sw.js`) is a minimal cache-first strategy (static assets). Full offline support is limited to previously cached assets, not streamed audio. Cover art is intentionally not app-cached — the session-stable Subsonic salt lets the browser's HTTP cache do that job (with ETag revalidation).
- **Single user.** No multi-user support. One Navidrome account per instance.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Svelte 5 (runes) |
| Language | TypeScript |
| Build | Vite |
| Styling | Tailwind CSS v4 |
| Database | Dexie (IndexedDB) |
| Audio | Web Audio API, @soundtouchjs/audio-worklet |
| Tagging | taglib-wasm |

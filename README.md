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
npm run deploy   # deploy to GitHub Pages
```

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

**CORS required.** Your WebDAV server must be configured to allow CORS requests from the mmdrome origin. The app uses PROPFIND (depth: infinity) to build a file index, GET to download small chunks for tag parsing, and PUT + MOVE (atomic write via temp file + rename with ETag-based concurrency) to write changes back.

**Directory structure.** The WebDAV URL should point to the root of your music library (e.g., `https://example.com/remote.php/dav/files/user/`). The scanner does a recursive `PROPFIND /` to discover all files, then matches them to Navidrome tracks by comparing normalized artist + title from the filename. Files must have a path under the WebDAV root — the directory structure itself is not prescriptive beyond that.

**Write safety.** Writes use a temp-file + rename pattern (PUT to `.<original>.tmp`, then MOVE over the original) with ETag-based conflict detection. If the file changed on disk between read and write, the PUT is rejected and the sync reports a conflict.

## Limitations

- **Navidrome only.** Only Subsonic-compatible servers (Navidrome specifically) are supported. No direct filesystem playback, no other Subsonic implementations have been tested.
- **Web Audio API dependency.** Audio processing (EQ, SoundTouch, crossfading, ReplayGain) requires Web Audio API. If the AudioContext fails to resume, playback falls back to the raw HTMLAudioElement without effects.
- **iOS background mode bypasses effects.** Pitch/speed shifting and EQ are unavailable while the app is backgrounded on iOS.
- **No gapless for different-codec tracks.** Gapless playback crossfades between tracks regardless of codec, but seamless sample-accurate gapless (no crossfade) is not supported across format boundaries.
- **Service worker limited.** The PWA service worker (`public/sw.js`) is a minimal cache-first strategy. Full offline support is limited to previously cached assets, not streamed audio.
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

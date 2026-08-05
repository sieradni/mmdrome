# Project Context, Architecture & Developer Knowledge Base

This file serves as the definitive reference guide for developers and AI agents working on **mmdrome**. It provides core architectural context, implementation patterns, known platform quirks, and a persistent log of learned information to minimize analysis overhead.

---

## 1. Tech Stack & Framework Conventions
- **Framework**: Svelte 5 (utilizing runes: `$state`, `$derived`, `$effect`) + TypeScript + Tailwind CSS v4.
- **Build System**: Vite (Client-side SPA).
- **Design Philosophy**: Minimalist. Avoid heavy third-party UI/component libraries. Use native Svelte reactivity, Tailwind utilities, and simple CSS.
- **Local Storage / Database**: Dexie (IndexedDB wrapper) for user settings, custom EQ profiles, and track metadata cache (`src/lib/db.ts`).

---

## 2. Audio Engine Architecture (`src/lib/audioManager.ts`)
mmdrome features an advanced custom audio pipeline built on top of the Web Audio API and HTML5 Audio:
- **Dual-Element Architecture**: Uses two `HTMLAudioElement` instances (`a` and `b`) to enable gapless playback, preloading, and crossfading.
- **Audio Routing Chain**:
  `HTMLAudioElement (a or b)` ➔ `MediaElementAudioSourceNode` ➔ `GainNode (Track RG)` ➔ `SoundTouchNode` (AudioWorklet for pitch/tempo shifting) ➔ Parametric/Graphic EQ Biquad Filter Chain ➔ Preamp `GainNode` ➔ `AudioContext.destination`.
- **SoundTouch Integration**: `@soundtouchjs/audio-worklet` provides independent pitch and speed (tempo) control.
- **Crossfading**: Managed via dual gain nodes (`_gainA`, `_gainB`) with exponential volume ramping (`exponentialRampToValueAtTime`) over a configurable duration (up to 15s).
- **ReplayGain**: Supports track and album replay gain modes, dynamically adjusting gain nodes (`_rgGainA`, `_rgGainB`).

---

## 3. iOS Background Audio Mode (Critical Platform Quirks)
iOS aggressively suspends `AudioContext` and throttles background timers/events. mmdrome implements a specialized background handoff mechanism:
- **Background Element (`_bgEl`)**: A bare `HTMLAudioElement` kept warm specifically for background playback when the page hides (`visibilitychange` event).
- **Volume Handling**: iOS does not respect `HTMLAudioElement.volume` — the hardware volume rocker is the only volume control. `_bgEl.volume` is set to `0` (and never raised) because setting it is a no-op on iOS. Volume is controlled entirely by the master preamp (`_preamp` GainNode) while in foreground, and by the iOS system volume while in background.
- **Limitations & Workarounds in Background Mode**:
  - **Bypassed Effects**: SoundTouch and Web Audio Biquad filters (EQ) are bypassed in background mode because iOS suspends AudioContext and worklets. `_bgEl.playbackRate = speed` is applied directly to the HTML audio element.
  - **Media Session Routing**: Browser/lockscreen media session action handlers (`play`, `pause`, `seekto`, `nexttrack`, `previoustrack`) explicitly check `audioManager.isInBgMode` and route controls directly to `_bgEl`.
  - **Position Polling**: Because `timeupdate` events can stall on iOS background elements, position state and store updates (`currentTime`) are polled at a **250ms interval** while `isInBgMode` is true.
  - **Race Condition Protection**: `_exitBackground` and `_onBgTrackEnd` coordinate via a `_bgTrackEndHandled` flag to prevent double queue advancement or conflicting `src`/`currentTime` writes on the active element when a track ends in background concurrent with the user returning to foreground.

---

## 4. State Management & Core Services
- **Global App State (`src/stores/appState.ts`)**: Svelte stores managing current track, playback state, queue (`userQueue`, `autoQueue`), shuffle mode, settings, and library tracks.
- **Queue Manager (`src/lib/queueManager.ts`)**: Encapsulates all queue logic — advancement, auto-queue replenishment/filtering, auto-to-user promotion, history management. Separated from `playbackManager` to keep concern boundaries clean.
- **Playback Manager (`src/lib/playbackManager.ts`)**: Controls track transitions, playback (play/pause/next/prev/seek), crossfade handling, and syncs with `audioManager`. Does NOT own queue logic — delegates to `queueManager`.
- **Sync & Metadata Engines (`src/lib/syncEngine.ts`, `metadataScanner.ts`, `navidromeApi.ts`)**: Integrates with Navidrome (Subsonic API) for streaming/syncing library data and WebDAV for local/remote indexing.
- **Tagging (`src/lib/taglibSingleton.ts`, `tagWriter.ts`)**: Uses `taglib-wasm` for robust audio file metadata reading and writing.

---

## 5. Git Hygiene & Development Workflow
- **Commit Granularity**: Commit changes in small, logical steps. Verify each feature/bugfix is fully functional before moving to the next task.
- **Type Checking**: Run `npm run check` (`svelte-check` + `tsc`) to verify type safety across Svelte and TypeScript files before finalizing changes.

---

## 6. Learned Information & Operational Log
*(Add new technical discoveries, platform workarounds, or architectural decisions here as you encounter them during development).*
- *[2026-07-25]* Established comprehensive context guide to replace minimal AGENTS.md, eliminating redundant codebase analysis loops.
- *[2026-07-26]* Extracted queue management from `playbackManager.ts` into dedicated `src/lib/queueManager.ts`. Cleared dead `src/stores/queueManager.ts` and empty `src/lib/{api,audio,database,sync}/` directories. Fixed `DEFAULT_BAND_Q` inconsistency (both `audioManager.ts` and `builtInPresets.ts` now use `Math.SQRT1_2`). Moved `promoteActiveTrack()` to after successful `el.play()` to prevent polluting user queue on playback failure.
- *[2026-07-27]* Added build-time version injection via Vite `define` in `vite.config.ts`. `src/lib/version.ts` exports `appVersion`, `commitHash`, and `buildTime` from injected globals (`__APP_VERSION__`, `__COMMIT_HASH__`, `__BUILD_TIME__`). Displayed at the bottom of SettingsView. The commit hash comes from `git rev-parse --short HEAD`; falls back to `'unknown'` if git is unavailable.
- *[2026-07-27]* Eliminated all reliance on `HTMLAudioElement.duration` for track duration. It can report incorrect/wrong values (NaN, truncated, or shorter than actual), causing early track ending, broken seek clamping, and wrong slider max values. `track.duration` (metadata) is now the sole source of truth for duration everywhere. The `elementDuration` store and `effectiveDuration` fallback to it were removed. `onEnded` no longer has an early-detection workaround that compared `elemDur` to `metaDur` (which caused stuck queues when `elemDur` was wrong).
- *[2026-07-27]* Fixed scroll position reset when switching between song/album/artist tabs. Created `src/lib/viewState.ts` with `saveViewState`/`restoreViewState` functions. Each view component (`SongsView`, `AlbumsView`, `ArtistsView`) saves ALL local UI state (scroll position, filterOpen, sortOpen, min/max rating/year/length, sortBy, sortAsc, infinite-scroll limit, selected album/artist) via `onDestroy` and restores it via `onMount`. The `{#if}` rendering approach is retained (no CSS visibility toggling), avoiding scrolling regressions that occurred when wrapper `<div>` elements broke the `h-full` height inheritance chain. The `offsetHeight > 0` guard on SongsView's IntersectionObserver prevents phantom triggering when the container has zero dimensions.
- *[2026-07-28]* Added **auto-queue scoping** via `albumScope`/`artistScope` fields on `AutoQueueFilters`. Scope is set only when the user plays a track (or hits Play All) from an album/artist detail view via `handlePlayFromAlbum`/`handlePlayFromArtist` handlers, NOT on view entry/exit — scope persists across tab switches. Scope is cleared when toggling shuffle. Implemented in `_matchesAutoQueueFilters()` in `queueManager.ts`. Added **Play All** button to album/artist detail headers that clears the user queue and queues all tracks of the opened album/artist while setting the scope. Added **Loop-One** mode (`loopMode` store with values `'none' | 'one' | 'all'`). `_onTrackEnded`, `_onBgTrackEnd`, and `_handleCrossfadeEnd` in `playbackManager.ts` check `loopMode === 'one'` and restart the current track. Loop button added to now-playing overlay. Fixed `QueueView.svelte` — `autoQueueFilters.set()` changed to `.update()` to preserve scope. Added `onplay` callback prop to `TrackRow`. Removed `addToUserQueue` from `TrackRow.handlePlay` to prevent duplicate queue entries. Added `replenishAutoQueue()` in `_loadAndPlay` for immediate queue population.
- *[2026-07-28]* **Scope clearing on default TrackRow path**: When `TrackRow.handlePlay` is called without an `onplay` prop (e.g., from SongsView, search results, QueueView), auto-queue scope (`albumScope`/`artistScope`) is cleared before playing. This prevents stale scope from filtering the auto-queue when the user plays a track outside the scoped album/artist context.
- *[2026-08-04]* **Native iOS engine — JS bridge (Phase 3)**: Architected the JS↔Swift bridge. `Capacitor.isNativePlatform()` gates every path — the PWA keeps the Web Audio engine untouched; iOS routes through the `BackgroundAudio` plugin client (`src/lib/nativePlugin.ts`, `nativeEngine` singleton; plugin `jsName: "BackgroundAudio"` registered via `registerPlugin<BackgroundAudioPlugin>`).
  - **Bridge protocol**: JS sends a full combined-queue snapshot (`setQueue`, then `playTrackAt(index, autoPlay)`), native owns the clock and emits `trackChanged` (payload `{ trackId }`, NOT index — queueManager's `promoteActiveTrack()` reindexes the combined queue whenever an auto track starts, so index mapping drifts; JS reconciles by **trackId**), `playbackStateChanged`, `ended`, `error`. `refreshQueue({tracks, activeIndex})` re-sends the full current combined queue without disturbing the actively playing track (native verifies `tracks[activeIndex].trackId == currentTrackId`, tears down any armed crossfade on the old tail, monitor re-arms). `setLoopMode` for mid-play loop changes. JS resends `refreshQueue` after every `trackChanged` reconcile so the native tail stays in lockstep with JS promotions/replenishment; native list only exhausts → `ended` → JS wraps (loop all) or continues via `combined[activeIndex+1]`, else stops.
  - **File facade (`src/lib/engineFacade.ts`, `engine` singleton)**: All views (`EQView`, `PitchSpeedView`, `VolumeView`) now talk to the facade, which mirrors speed/pitch/tape/volume/preamp/filters locally on native and pushes to the plugin, or delegates straight to `audioManager` on web (PWA behavior unchanged — `npm run check` clean after conversion). `EqPoint[][]`/curves ignored on native. Crossfade curve hard-coded to sigmoid k=8 (web only exposes duration).
  - **playbackManager refactor**: `init()` splits into `_initWeb()` (verbatim old body) / `_initNative()` (nativeEngine.init, settings restore, `pushNativeEqFromStore()`, loopMode/settings subscriptions, 250ms position polling → `currentTime`). Shared subscriptions (`playbackSpeed`/`pitchOctaves` → `engine.set*`, replenish/library/shuffle/filters) move to `_subscribeShared()`. **Gotcha**: on native `engine.setSpeed(savedSpeed)` does NOT echo back into the `playbackSpeed` store (no `onSpeedChange` hook), and `_subscribeShared` fires immediately — so `_initNative` MUST `playbackSpeed.set(savedSpeed ?? 1)`/`pitchOctaves.set(savedPitch ?? 0)` before subscribing or the defaults clobber restored values. `mediaSession.ts`, `setupPreloader`, `_attachPlaybackListeners` are web-only; App.svelte's `timeupdate` `$effect` early-returns on native. `_nativeLoadPlay` = setQueue+playTrackAt+promote+replenish; `_onNativeTrackChanged` re-adopts a playing track if it fell out of combined (re-insert into userQueue), pushes history for the previous track, promotes/replenishes, refreshes queue; `_onNativeError` mirrors web's exponential-retry then ends.
  - **Native EQ mapping**: `NativeFilterSnapshot` type strings map to `AVAudioUnitEQFilterType` in `AudioEngine.swift::mapFilterType` (`bandpass→.bandPass`, `notch→.bandStop`, default `.parametric`); Q→bandwidth via `1/max(q,0.05)` approximation.
  - **SPM path fix (`npm run sync:ios`)**: `cap sync ios` regenerates `ios/App/CapApp-SPM/Package.swift` and computes local plugin paths via Node `path.relative()`, which emits backslashes on Windows (`..\..\..\native\BackgroundAudio`) — SPM can't resolve those. `scripts/fix-spm-path.mjs` normalizes backslashes to forward slashes and is chained after `cap sync ios` in the `sync:ios` npm script (no-op on macOS CI, which already produces POSIX paths).
  - **Standby crossfade generation**: `AVAudioPlayerNode.stop()` fires the pending completion handler. `refreshQueue`/`setLoopMode` tear down armed crossfades, so the standby's stopped segment must not fake a natural track advance — guarded by a dedicated `standbyScheduleGeneration` (`AudioEngine.swift`). It is only bumped when a crossfade is armed/in-flight (`hadCrossfade` captured before `stopCrossfadeMonitor()` clears the flags); after `finalizeCrossfadeSwitch` the former-standby node's completion IS the active track's natural-end trigger and must stay valid, or the queue stalls.

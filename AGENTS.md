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

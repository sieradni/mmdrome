# Coding Standards and Architecture Guidelines
- Framework: Svelte + TypeScript + Tailwind CSS.
- Keep the codebase minimalist. Avoid heavy third-party UI libraries (e.g., component libraries). Use native Svelte states and simple CSS/Tailwind
- Git Hygiene: Commit changes in small, logical steps. Verify each feature is functional before moving to the next task.

# Audio Architecture
## Primary Pipeline (all platforms at 1x speed)
```
HTMLAudioElement → MediaElementAudioSourceNode → GainNode(vol) → GainNode(RG) → SoundTouchNode → BiquadFilterNode[] (EQ) → GainNode(preamp) → AudioContext.destination
```
- HTMLAudioElement.playbackRate=1 always when SoundTouch is available
- SoundTouchNode.playbackRate handles all speed changes
- Tape mode: HTMLAudioElement.playbackRate=speed, SoundTouchNode.playbackRate=1 (pass-through)

## Alternative Pipeline (iOS speed≠1, if SoundTouch issues persist)
When SoundTouch + HTMLAudioElement streaming causes problems on iOS at non-1x speed:
```
fetch blob → decodeAudioData() → AudioBufferSourceNode → SoundTouchNode → EQ → preamp → destination
```
- Download full track as blob, decode to AudioBuffer, connect directly to SoundTouch
- Avoids HTMLAudioElement entirely for that playback session
- Higher quality (PCM buffer, no streaming), no playbackRate compounding
- Memory cost: full decoded track in memory
- NOT used for background mode (iOS suspends AudioContext); background falls back to bare HTMLAudioElement with playbackRate=speed (no pitch preservation)

## iOS Background Mode
- When page hides on iOS: creates a bare HTMLAudioElement (_bgEl) to bypass AudioContext suspension
- _bgEl.playbackRate = speed (no SoundTouch/EQ in background — iOS limitation)
- Media Session action handlers route to _bgEl when in bg mode
- Position state polled at 250ms interval since timeupdate may not fire reliably on background element
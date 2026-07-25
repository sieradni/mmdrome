# Coding Standards and Architecture Guidelines
- Framework: Svelte + TypeScript + Tailwind CSS.
- Keep the codebase minimalist. Avoid heavy third-party UI libraries (e.g., component libraries). Use native Svelte states and simple CSS/Tailwind
- Git Hygiene: Commit changes in small, logical steps. Verify each feature is functional before moving to the next task.

## iOS Background Mode
- When page hides on iOS: creates a bare HTMLAudioElement (_bgEl) to bypass AudioContext suspension
- _bgEl.playbackRate = speed (no SoundTouch/EQ in background — iOS limitation)
- Media Session action handlers route to _bgEl when in bg mode
- Position state polled at 250ms interval since timeupdate may not fire reliably on background element
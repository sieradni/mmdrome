<script lang="ts">
  /**
   * Lyrics panel (Now Playing split). Renders `lyricsState` from
   * lyricsService:
   * - Synced docs: auto-scrolling line list; the active line renders in
   *   accent (a STATE mark per C8 — same role as the now-playing row) with
   *   neighbours dimmed by distance. Tapping a line seeks to its start.
   * - Manual scrolling (wheel / touch / scrollbar drag) suspends auto-follow;
   *   a Resume pill re-engages it — the "don't fight the user's scroll"
   *   contract.
   * - Unsynced docs render as clean scrollable text.
   * - Empty state is one quiet line.
   */
  import { get } from 'svelte/store'
  import { lyricsState, loadLyricsForTrack } from '../lib/lyricsService'
  import { activeLineIndex, isBreakMarker } from '../lib/lyricsCore'
  import { currentTime, currentTrack, effectiveDuration } from '../stores/appState'
  import { playbackManager } from '../lib/playbackManager'
  import BufferSpinner from './BufferSpinner.svelte'

  // Self-contained data leg: while mounted (Now Playing open), load lyrics for
  // the current track. ONLY the trackId is reactive — the duration is read
  // untracked (get()), or the effect would re-fire when effectiveDuration
  // resolves asynchronously and flash the loading state on every track.
  $effect(() => {
    const track = $currentTrack
    if (!track) return
    loadLyricsForTrack(track.trackId, { duration: get(effectiveDuration) || track.duration })
  })

  // A new track's lyrics are fresh content: auto-follow re-engages (a scroll
  // pause made on the previous track must not strand the new one).
  let followedTrackId: string | null = null
  $effect(() => {
    const trackId = $lyricsState.trackId
    if (trackId !== followedTrackId) {
      followedTrackId = trackId
      followEnabled = true
    }
  })

  let listEl: HTMLElement | undefined = $state()
  let followEnabled = $state(true)
  /** Timestamp until which scroll events are attributed to our own smooth scroll. */
  let programmaticUntil = 0

  const tMs = $derived(Math.round($currentTime * 1000))
  const doc = $derived($lyricsState.doc)
  const lines = $derived(doc?.lines ?? [])
  const synced = $derived(doc?.synced ?? false)
  const activeIdx = $derived(synced ? activeLineIndex(lines, tMs) : -1)

  // Auto-follow: recentre the active line whenever it changes while engaged.
  $effect(() => {
    if (!followEnabled) return
    const idx = activeIdx
    const container = listEl
    if (idx < 0 || !container) return
    const target = container.querySelector<HTMLElement>(`[data-lyric-idx="${idx}"]`)
    if (!target) return
    programmaticUntil = Date.now() + 700
    container.scrollTo({
      top: target.offsetTop - container.clientHeight / 2 + target.clientHeight / 2,
      behavior: 'smooth',
    })
  })

  /** User-intent scroll: wheel, touch, or a scrollbar drag that drifted the
   *  view well away from the active line. Suspends auto-follow. */
  function handleUserScrollIntent(): void {
    if (followEnabled) followEnabled = false
  }

  function handleScroll(): void {
    if (!followEnabled || !listEl) return
    if (Date.now() < programmaticUntil) return
    // Scrollbar drag on desktop fires no wheel/touch events — detect it by
    // drift: if the view's centre sits far from the active line, the user
    // moved it deliberately.
    const active = listEl.querySelector<HTMLElement>(`[data-lyric-idx="${activeIdx}"]`)
    if (!active) return
    const centre = listEl.scrollTop + listEl.clientHeight / 2
    const activeCentre = active.offsetTop + active.clientHeight / 2
    if (Math.abs(centre - activeCentre) > listEl.clientHeight * 0.45) followEnabled = false
  }

  function resumeFollow(): void {
    followEnabled = true
    // The auto-follow $effect reads followEnabled — this re-run recentres.
  }

  function seekToLine(startMs: number | null): void {
    if (startMs === null) return
    followEnabled = true
    playbackManager.seek(startMs / 1000)
  }

  function lineClass(idx: number, isBreak: boolean): string {
    if (idx === activeIdx) return isBreak ? 'text-accent/80' : 'text-accent font-semibold'
    const dist = Math.abs(idx - activeIdx)
    if (activeIdx < 0) return 'text-muted/70'
    if (dist <= 2) return isBreak ? 'text-muted/50' : 'text-primary/85'
    if (dist <= 5) return 'text-muted/60'
    return 'text-muted/40'
  }
</script>

<div class="relative h-full min-h-0">
  {#if $lyricsState.loading}
    <div class="flex h-full items-center justify-center">
      <BufferSpinner sizeClass="h-6 w-6" />
    </div>
  {:else if doc && synced}
    <div
      bind:this={listEl}
      role="region"
      aria-label="Lyrics"
      onscroll={handleScroll}
      onwheel={handleUserScrollIntent}
      ontouchstart={handleUserScrollIntent}
      class="flex h-full flex-col overflow-y-auto px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <!-- Spacers (not % padding — that is width-relative): give the first and
           last lines room to reach the centred scroll position. -->
      <div class="min-h-[38%] shrink-0 grow-0"></div>
      {#each lines as line, idx (idx)}
        {#if line.startMs !== null}
          <button
            type="button"
            data-lyric-idx={idx}
            onclick={() => seekToLine(line.startMs)}
            class={'block w-full cursor-pointer py-1.5 text-left text-[15px] leading-snug transition-colors duration-300 ' +
              (isBreakMarker(line) ? 'text-center text-lg ' : '') +
              lineClass(idx, isBreakMarker(line))}
          >
            {line.text}
          </button>
        {:else}
          <p
            data-lyric-idx={idx}
            class={'py-1.5 text-[15px] leading-snug ' +
              (isBreakMarker(line) ? 'text-center text-lg ' : '') +
              lineClass(idx, isBreakMarker(line))}
          >
            {line.text}
          </p>
        {/if}
      {/each}
      <div class="min-h-[55%] shrink-0 grow-0"></div>
    </div>
    {#if !followEnabled && activeIdx >= 0}
      <button
        onclick={resumeFollow}
        class="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-surface px-3 py-1.5 text-xs font-medium text-primary shadow-lg ring-1 ring-white/10 transition-colors hover:text-accent"
        aria-label="Resume lyrics follow"
      >
        Resume
      </button>
    {/if}
  {:else if doc}
    <!-- Unsynced: clean static text -->
    <div class="h-full overflow-y-auto px-4 py-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {#each doc.lines as line, idx (idx)}
        <p class="py-1 text-[15px] leading-relaxed text-primary/85">{line.text}</p>
      {/each}
    </div>
  {:else if $lyricsState.unavailable}
    <div class="flex h-full items-center justify-center px-6">
      <p class="text-center text-sm text-muted/50">No lyrics available for this track</p>
    </div>
  {:else if $lyricsState.trackId && !$lyricsState.trackId.startsWith('navidrome-')}
    <!-- WebDAV/local track: lyrics come from Navidrome's server-side tags and
         sidecars, so this is an honest scope statement, not an error. -->
    <div class="flex h-full items-center justify-center px-6">
      <p class="text-center text-sm text-muted/50">Lyrics are available for Navidrome tracks only</p>
    </div>
  {/if}
</div>

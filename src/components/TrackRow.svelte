<script lang="ts">
  import { autoQueueScope } from '../stores/appState'
  import { metadataCache } from '../stores/appState'
  import { playbackManager } from '../lib/playbackManager'
  import { queueManager } from '../lib/queueManager'
  import { highlightSegments, type HighlightSegment } from '../lib/searchCore'
  import { foldMapForSearch } from '../lib/matchNormalize'
  import type { Track } from '../stores/appState'
  import LazyThumb from './LazyThumb.svelte'
  import { contextMenuTrigger } from '../lib/contextMenuTrigger'
  import { openContextMenu } from '../lib/contextMenuStore'
  import { selection, selectionClick, toggleSelection } from '../stores/selectionStore'

  let { track, showAlbum = true, showDuration = false, showAlbumArtist = false, dataTrackId, ondetails, onplay, highlightTokens = [], playing = false, windowed = false }: {
    track: Track
    showAlbum?: boolean
    showDuration?: boolean
    showAlbumArtist?: boolean
    dataTrackId?: string
    ondetails?: () => void
    onplay?: (trackId: string) => void
    /** Search tokens to bold in title/artist/album — empty = plain render. */
    highlightTokens?: string[]
    /** This row is the CURRENT track (any playback state) — whole-row accent
     *  element (solid wash + left edge). */
    playing?: boolean
    /** The parent renders a virtual window (SongsView): LazyThumb skips its
     *  own IntersectionObservers because visibility is derived by the parent. */
    windowed?: boolean
  } = $props()

  /**
   * Best-effort highlight segments for one field (searchCore's
   * `highlightSegments` + the fold map). The verify-gate degrades to plain
   * text on any map/fold mismatch, so highlights can never be wrong.
   */
  function fieldSegs(text: string): HighlightSegment[] {
    const { folded, mapStart, mapEnd } = foldMapForSearch(text)
    return highlightSegments(text, folded, highlightTokens, mapStart, mapEnd)
  }

  function formatDuration(s: number): string {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${String(sec).padStart(2, '0')}`
  }

  function getRating(trackId: string): number {
    return $metadataCache.get(trackId)?.rating ?? 0
  }

  function getLoved(trackId: string): boolean {
    return $metadataCache.get(trackId)?.loved ?? false
  }

  function starSegments(r: number): ('full' | 'half' | 'empty')[] {
    const sv = Math.min(5, r / 20)
    const segs: ('full' | 'half' | 'empty')[] = []
    for (let i = 0; i < 5; i++) {
      const v = Math.max(0, Math.min(1, sv - i))
      if (v >= 0.75) segs.push('full')
      else if (v >= 0.25) segs.push('half')
      else segs.push('empty')
    }
    return segs
  }

  let added = $state(false)
  let addTimer: ReturnType<typeof setTimeout> | null = null

  function handleAdd(e: MouseEvent, trackId: string) {
    e.stopPropagation()
    queueManager.addToUserQueue(trackId)
    added = true
    if (addTimer) clearTimeout(addTimer)
    addTimer = setTimeout(() => {
      added = false
    }, 1000)
  }

  /**
   * Multi-select (2026-11-04): Shift extends the range from the anchor, Ctrl/Cmd
   * toggles one row, and a plain press inside selection mode toggles too (the
   * only path a phone has — there is no modifier key on touch). Outside
   * selection mode a press keeps its own meaning, so the row's play semantics
   * are untouched for every existing surface.
   */
  let rowSelected = $derived($selection.surface === 'library' && $selection.keys.includes(track.trackId))
  let selectionMode = $derived($selection.mode && $selection.surface === 'library')

  // Click AND keydown reach the same press path: both carry the modifier
  // flags, so one signature keeps Shift-range / Ctrl-toggle identical on a
  // pointer and on Enter/Space (no cast, no second branch to drift).
  function handlePlay(event: MouseEvent | KeyboardEvent, trackId: string) {
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      event.preventDefault()
      selectionClick('library', trackId, {
        shift: event.shiftKey,
        toggle: event.ctrlKey || event.metaKey,
      })
      return
    }
    if (selectionMode) {
      toggleSelection('library', trackId)
      return
    }
    if (onplay) {
      onplay(trackId)
    } else {
      autoQueueScope.set({})
      playbackManager.playTrackById(trackId)
    }
  }

  /** Hold / right-click opens the shared track menu. The row's press semantics
   *  are passed through, so a detail view keeps its album/artist auto-queue
   *  scope while a plain library row clears it. */
  function handleContextMenu(position: { x: number; y: number }, trigger: HTMLElement) {
    openContextMenu({
      target: {
        kind: 'track',
        track,
        onDetails: ondetails ? () => ondetails!() : undefined,
        onPlay: onplay ? () => onplay!(track.trackId) : undefined,
      },
      x: position.x,
      y: position.y,
      trigger,
    })
  }

  /** The ⋮ button opens the SAME unified ContextMenu (full menu, Option 1).
   *  Anchored below the button; the menu's placement flips if it would overflow.
   *  `TrackOptionsDropdown.svelte` is DELETED — this handler is the only ⋮ path
   *  (C12). */
  function handleMoreOptions(e: MouseEvent) {
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    handleContextMenu(
      { x: rect.left + rect.width / 2, y: rect.bottom },
      e.currentTarget as HTMLElement,
    )
  }
</script>

<!-- Row container is NOT interactive (no role="button", no click/key handlers):
     the play target is a real <button> below, and the + / ⋮ buttons are SIBLINGS
     of it — never nested inside a button-role element. tabindex="-1" exists only
     so the context menu can return focus here; it is NOT a Tab stop. -->
<div
  class={"relative flex items-center gap-2 rounded-lg py-2 pl-1.5 pr-1 transition-colors " +
    (rowSelected ? 'bg-accent-soft ring-1 ring-accent-ring ' : '') +
    (playing ? 'ui-now-playing-row' : 'hover:bg-white/5')}
  tabindex="-1"
  use:contextMenuTrigger={{ onOpen: handleContextMenu }}
  data-track-id={dataTrackId ?? track.trackId}
  data-selected={rowSelected || undefined}
>
  <button
    type="button"
    class="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left"
    onclick={(e) => handlePlay(e, track.trackId)}
    aria-pressed={selectionMode ? rowSelected : undefined}
  >
    {#if selectionMode}
      <!-- Selection affordance: a fixed-size leading check so the target row is
           unambiguous on touch, where no hover state exists. -->
      <span class="flex h-5 w-5 flex-shrink-0 items-center justify-center" aria-hidden="true">
        <span
          class={"flex h-5 w-5 items-center justify-center rounded-full border transition-colors " +
            (rowSelected ? 'border-accent bg-accent text-black' : 'border-white/30')}
        >
          {#if rowSelected}
            <svg class="h-3 w-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" /></svg>
          {/if}
        </span>
      </span>
    {/if}
    <LazyThumb {track} {windowed} wrapperClass="h-10 w-10 flex-shrink-0 rounded" />
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm text-primary">
        {#if highlightTokens.length > 0}
          {#each fieldSegs(track.title) as seg, i (i)}{#if seg.match}<mark class="rounded-sm bg-yellow-300/40 px-0 text-primary">{seg.text}</mark>{:else}{seg.text}{/if}{/each}
        {:else}
          {track.title}
        {/if}
      </p>
      <p class="truncate text-xs text-muted">
        {#if highlightTokens.length > 0}
          {#each fieldSegs(track.artist) as seg, i (i)}{#if seg.match}<mark class="rounded-sm bg-yellow-300/40 px-0 text-primary">{seg.text}</mark>{:else}{seg.text}{/if}{/each}
          {#if showAlbum} · {#each fieldSegs(track.album) as seg, i (i)}{#if seg.match}<mark class="rounded-sm bg-yellow-300/40 px-0 text-primary">{seg.text}</mark>{:else}{seg.text}{/if}{/each}{/if}
        {:else}
          {track.artist}
          {#if showAlbum} · {track.album}{/if}
        {/if}
        {#if showAlbum && track.year !== undefined && track.year !== null} · {track.year}{/if}
        {#if showDuration} · {formatDuration(track.duration)}{/if}
      </p>
    </div>
  </button>

  <div class="-ml-1 flex flex-shrink-0 items-center gap-0.5" aria-hidden="true">
    <!-- Ratings render ONLY when there is something to show (2026-09-23 scroll
         review): the old unconditional block put 5 star SVGs (+ a gradient
         <defs> per half-star) on EVERY row — a library of unrated tracks was
         hundreds of invisible gray-stroke SVGs and unique gradient defs, all
         repainted on every scroll frame. Rated rows render stars; a loved
         row without a rating renders just the heart. Row height is
         unchanged; the trailing area is empty for the common unrated case
         (same as Spotify/Apple Music). Decorative: aria-hidden (C8 / the
         ContextMenu.svelte pattern) + ONE shared defs for the half-star
         gradient (a single id per mounted row, never per segment). -->
    {#if getRating(track.trackId) > 0}
      {@const segments = starSegments(getRating(track.trackId))}
      {@const gradientId = `tr-half-star-${track.trackId}`}
      {#if segments.includes('half')}
        <svg width="0" height="0" aria-hidden="true" style="position:absolute">
          <defs>
            <linearGradient id={gradientId}>
              <stop offset="50%" stop-color="#facc15" />
              <stop offset="50%" stop-color="transparent" />
            </linearGradient>
          </defs>
        </svg>
      {/if}
      {#each segments as seg}
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26Z"
            fill={seg === 'full' ? '#facc15' : seg === 'half' ? `url(#${gradientId})` : 'none'}
            stroke={seg === 'empty' ? '#555' : '#facc15'}
            stroke-width="1"
          />
        </svg>
      {/each}
    {/if}
    {#if getLoved(track.trackId)}
      <svg class="ml-0.5 h-3.5 w-3.5 text-red-400" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
      </svg>
    {/if}
  </div>

  <button
    type="button"
    onclick={(e) => handleAdd(e, track.trackId)}
    class="flex-shrink-0 self-stretch rounded-none px-0.5 text-muted transition-colors hover:text-primary"
    aria-label="Add to queue"
  >
    {#if added}
      <svg class="h-5 w-5 text-green-400" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" /></svg>
    {:else}
      <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" /></svg>
    {/if}
  </button>

  <!-- Album-artist column (album/artist detail views): only when it actually
       DIFFERS from the track artist — on single-artist albums the two are
       identical and the trailing name read as a duplicate (review
       2026-09-11). Real use case: compilation various-artists albums. -->
  {#if showAlbumArtist && track.albumArtist && track.albumArtist !== track.artist}
    <span class="flex-shrink-0 text-xs text-muted/60 max-w-[120px] truncate">{track.albumArtist}</span>
  {/if}

  <button
    type="button"
    onclick={handleMoreOptions}
    class="flex-shrink-0 self-stretch rounded-none px-0.5 text-muted transition-colors hover:text-primary"
    aria-label="More options"
    aria-haspopup="menu"
  >
    <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
    </svg>
  </button>
</div>

<script lang="ts">
  import { describePushDiff, type PushableTrackInfo } from '../lib/pushReconcile'
  import type { Snippet } from 'svelte'
  let { track, thumbnail, onopen }: {
    track: PushableTrackInfo
    thumbnail?: Snippet
    /** Opens the track's detail view. Absent = no library Track to show
     *  (an orphaned pending edit), so the title/art stay plain text. */
    onopen?: () => void
  } = $props()
  let diff = $derived(describePushDiff(track))
</script>

{#snippet thumbBox()}
  <span data-testid="push-thumbnail" class="block h-16 w-16 shrink-0 overflow-hidden rounded-md bg-surface-hover" aria-hidden="true">
    {#if thumbnail}
      {@render thumbnail()}
    {:else}
      <svg class="h-full w-full p-2.5 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13M9 8l12-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="18" cy="16" rx="3" ry="2"/></svg>
    {/if}
  </span>
{/snippet}

<div class="min-w-0 flex-1 space-y-2">
  <div class="flex items-start gap-3">
    {#if onopen}
      <button
        type="button"
        data-testid="push-thumbnail-button"
        onclick={onopen}
        aria-label={`Show details for ${track.title}`}
        class="shrink-0 rounded-lg transition-opacity active:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        {@render thumbBox()}
      </button>
    {:else}
      {@render thumbBox()}
    {/if}
    <div class="min-w-0 flex-1 space-y-1.5">
      {#if onopen}
        <button
          type="button"
          data-testid="push-title-button"
          onclick={onopen}
          class="-mx-1 block max-w-full rounded-md px-1 py-0.5 text-left text-sm font-medium text-primary transition-opacity active:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          <span class="break-words">{track.title}</span>
        </button>
      {:else}
        <p class="break-words text-sm font-medium text-primary">{track.title}</p>
      {/if}
      {#if track.artist || track.album}
        <p class="break-words text-xs text-muted">{track.artist ?? ''}{track.artist && track.album ? ' · ' : ''}{track.album ?? ''}</p>
      {/if}
      <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
        {#if diff.ratingText}
          <span role="img" aria-label={track.prevRating !== undefined && diff.ratingChanged ? `Rating: ${track.prevRating} to ${track.rating} out of 100` : `Rating to write: ${track.rating} out of 100`} data-testid={`push-diff-rating-${track.trackId}`} class="inline-flex items-center whitespace-pre rounded-md bg-[#facc15]/10 px-2 py-1 ring-1 ring-inset ring-[#facc15]/20 {diff.ratingChanged ? 'text-primary' : 'text-muted'}"><span data-testid="push-rating-icon" class="text-[#facc15]">★</span>{diff.ratingText.slice(1)}</span>
        {/if}
        {#if diff.lovedText}
          <span role="img" aria-label={track.prevLoved !== undefined && diff.lovedChanged ? `Loved: ${track.prevLoved ? 'loved' : 'not loved'} to ${track.loved ? 'loved' : 'not loved'}` : `Loved to write: ${track.loved ? 'loved' : 'not loved'}`} data-testid={`push-diff-loved-${track.trackId}`} class="inline-flex items-center whitespace-pre rounded-md bg-red-400/10 px-2 py-1 ring-1 ring-inset ring-red-400/20 {diff.lovedChanged ? 'text-primary' : 'text-muted'}">{#each diff.lovedText.split(/([♡♥])/) as part}{#if part === '♡' || part === '♥'}<span data-testid="push-loved-icon" class="text-red-400">{part}</span>{:else}{part}{/if}{/each}</span>
        {/if}
        {#if !diff.ratingText && !diff.lovedText}<span class="text-muted">Rating 0 · Not loved</span>{/if}
        {#if track.fileType}<span class="text-muted uppercase">{track.fileType}</span>{/if}
      </div>
    </div>
  </div>
  <p class="break-all text-xs text-muted" title={track.webdavPath}>→ {track.webdavPath}</p>
</div>

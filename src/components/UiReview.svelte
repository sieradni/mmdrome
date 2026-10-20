<script lang="ts">
  import PushTrackSummary from './PushTrackSummary.svelte'
  import PushConfirmShell from './PushConfirmShell.svelte'
  import PushDiscardButton from './PushDiscardButton.svelte'
  import ActivityStrip from './ActivityStrip.svelte'
  import { tooltip } from '../lib/tooltip'
  import { deriveActivityStatus, type ActivityStatusInput } from '../lib/activityStatus'
  import type { PushableTrackInfo } from '../lib/pushReconcile'

  let scenario = $state('scanning')
  let modalOpen = $state(true)
  let message = $state('')
  const scenarios = ['idle', 'connecting', 'loading', 'scanning', 'pushing', 'cached']
  // Synthetic artwork keeps the review offline and independent of credentials.
  const demoCover = (color: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" fill="${color}"/><circle cx="48" cy="48" r="30" fill="#fff" opacity=".15"/><circle cx="48" cy="48" r="13" fill="#111"/><circle cx="48" cy="48" r="3" fill="#ddd"/></svg>`)}`
  let discardTarget = $state<string | null>(null)
  let tracks = $state<PushableTrackInfo[]>([
    { trackId: 'one', title: 'Everything In Its Right Place', artist: 'Radiohead', album: 'Kid A', fileType: 'flac', webdavPath: 'Radiohead/Kid A/01 Everything In Its Right Place.flac', rating: 100, prevRating: 60, loved: true, prevLoved: false },
    { trackId: 'two', title: 'A very long song title that should wrap without hiding the changes', artist: 'An artist with a long name', album: 'A quiet record', fileType: 'mp3', webdavPath: 'Music/A quiet record/02 A very long song title.mp3', rating: 0, prevRating: 80, loved: false, prevLoved: true },
    { trackId: 'three', title: 'Reckoner', artist: 'Radiohead', album: 'In Rainbows', fileType: 'flac', webdavPath: 'Radiohead/In Rainbows/07 Reckoner.flac', rating: 80, prevRating: 40, loved: false, prevLoved: false },
  ])
  let status = $derived.by(() => {
    const input: ActivityStatusInput = {
      navChecking: scenario === 'connecting', navLoading: scenario === 'loading',
      navCached: scenario === 'cached', navError: scenario === 'cached' ? 'Unavailable' : undefined,
      scanStatus: scenario === 'scanning' ? 'scanning' : 'idle', scanScanned: 42, scanTotal: 180,
      probeActive: false, probeDone: 0, probeRemaining: 0,
      pushActive: scenario === 'pushing', pushDone: 3, pushTotal: 12,
    }
    return deriveActivityStatus(input)
  })
</script>

<main class="mx-auto max-w-2xl px-5 py-8 text-primary">
  <p class="text-xs text-muted">DESIGN REVIEW · LOCAL FIXTURES ONLY</p>
  <h1 class="mt-2 text-xl font-medium">Less chrome. Clearer decisions.</h1>
  <p class="mt-3 text-sm text-muted">No server, saved settings, queue, or playback is touched. These are the same track rows and activity strip used in the app.</p>
  <label class="mt-6 block text-sm">Activity scenario
    <select bind:value={scenario} class="ml-2 p-2">
      {#each scenarios as item}<option value={item}>{item}</option>{/each}
    </select>
  </label>
  <div class="mt-4 border-y border-white/10">
    <ActivityStrip {status} onclick={() => { message = 'In the app, this opens the relevant Settings section.' }} />
  </div>
  <div class="mt-5 flex items-center gap-3">
    <button class="btn-secondary btn-md" onclick={() => { modalOpen = true }}>Review push changes</button>
    <button use:tooltip aria-label="About this preview" class="h-10 w-10 rounded-full border border-white/15" onclick={() => { message = 'Preview only — no files can be written.' }}>?</button>
  </div>
  <p role="status" class="mt-4 text-xs text-muted">{message}</p>
</main>

{#if modalOpen}
  <PushConfirmShell onclose={() => { modalOpen = false }}>
      <header class="shrink-0 border-b border-white/10 px-5 py-4">
        <h2 id="review-title" class="text-base font-semibold">Write ratings to WebDAV files?</h2>
        <p id="push-confirm-description" class="mt-1 text-xs text-muted">Updates only rating and loved tags. A wrong file link applies these tags to the wrong file. Tags can be corrected later if you know the previous values. Verify the paths below.</p>
      </header>
      <div class="min-h-0 overflow-y-auto px-5 py-3.5">
        <p role="status" class="text-xs text-muted">{tracks.length} file{tracks.length === 1 ? '' : 's'} will be updated:</p>
        <ul class="divide-y divide-white/10">
          {#each tracks as track (track.trackId)}
            <li class="py-3.5">
              <div class="flex items-start gap-1">
                {#if track.trackId !== 'two'}
                  <PushTrackSummary {track}>
                    {#snippet thumbnail()}
                      <img src={demoCover(track.trackId === 'one' ? '#456575' : '#916343')} alt="" class="h-full w-full object-cover" />
                    {/snippet}
                  </PushTrackSummary>
                {:else}
                  <PushTrackSummary {track} />
                {/if}
                <PushDiscardButton title={track.title} expanded={discardTarget === track.trackId} onclick={() => { discardTarget = track.trackId }} />
              </div>
              {#if discardTarget === track.trackId}
                <div class="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-surface-hover px-2.5 py-1.5">
                  <span class="min-w-0 flex-1 text-xs">Discard this edit? These rating and loved changes will not be written to the file.</span>
                  <button class="btn-secondary min-h-11 px-3 py-1 text-xs" onclick={() => { tracks = tracks.filter((item) => item.trackId !== track.trackId); discardTarget = null }}>Discard</button>
                  <button class="min-h-11 px-3 py-1 text-xs text-muted" onclick={() => { discardTarget = null }}>Keep</button>
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      </div>
      <footer class="flex shrink-0 flex-wrap justify-end gap-2 border-t border-white/10 px-5 py-3.5">
        <button class="btn-secondary btn-md min-h-11" onclick={() => { modalOpen = false }}>Close preview</button>
        <button class="btn-primary btn-md min-h-11" disabled>Write to files (demo)</button>
      </footer>
  </PushConfirmShell>
{/if}

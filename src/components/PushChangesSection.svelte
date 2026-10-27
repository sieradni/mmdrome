<script lang="ts">
  import PushTrackSummary from './PushTrackSummary.svelte'
  import PushConfirmShell from './PushConfirmShell.svelte'
  import PushDiscardButton from './PushDiscardButton.svelte'
  import PushReportPanel from './PushReportPanel.svelte'
  import TrackDetailsModal from './TrackDetailsModal.svelte'
  import LazyThumb from './LazyThumb.svelte'

  import { library, metadataCache, pushState, lastPushReport, settings, relinkPendingMetadata } from '../stores/appState'
  import { getPendingSyncMetadata, getFileTagsForBase } from '../lib/db'
  import { discardLocalEdit } from '../lib/metadataScanner'
  import { runManualWebDAVSync } from '../lib/syncEngine'
  import { webdavBaseKey } from '../lib/webdavUtils'
  import { buildPushBreakdown, withLibraryTitles, withPushContext, EMPTY_PUSH_BREAKDOWN, type PushBreakdown, type PushableTrackInfo, type PushTrackContext } from '../lib/pushReconcile'
  import { get } from 'svelte/store'
  import type { Track } from '../stores/appState'

  /**
   * The whole Push Changes concern: the button, the live progress + cancel, the
   * last result line, the retained report, the confirm pane with its per-row
   * discard, and the details view a row opens.
   *
   * Extracted from `SettingsView` (2026-10-27g) — it was a self-contained
   * concern living inside a 2,700-line surface: its own state, its own Dexie
   * reads, its own pane. The STORES stay the single owners of the data
   * (`pushState`, `lastPushReport`, `library`, `metadataCache`); this component
   * owns only the pane's UI state (open confirm, expanded discard, details).
   *
   * The one injected dependency is `commitCredentials` — persisting the edited
   * Sources fields is that tab's concern, and the run must not talk to a server
   * before the newest credentials are durable on disk.
   *
   * "A run is going" is read from `pushState.active`, not mirrored into a
   * local flag: the store is the owner (it also drives the progress block),
   * and a mirror would re-enable the button while a run is live if this
   * section is unmounted and remounted mid-push (switching Settings tabs).
   */
  let { commitCredentials }: { commitCredentials: () => Promise<void> } = $props()

  let syncResult = $state('')
  let confirmPush = $state(false)
  // Row title/art in the push pane open the SAME details view the library
  // rows do (⋮ → Details), so a path can be verified against the real tags
  // before anything is written. Null = closed.
  let detailTrack = $state<Track | null>(null)
  const pushLibraryTracks = $derived(confirmPush ? new Map($library.map((track) => [track.trackId, track])) : new Map())
  // The dialog's full picture — bucket counts + the pushable track list.
  let pushBreakdown = $state<PushBreakdown>(EMPTY_PUSH_BREAKDOWN)

  /** Confirm-dialog list slice (2026-09-28 long-list sweep): the breakdown's
   *  `tracks` is deliberately uncapped (the count must reflect the real run),
   *  but the dialog's ROWS render the first slice only — a 1,000-file push
   *  no longer lays out 1,000 two-line rows + buttons in the modal. */
  const PUSH_DIALOG_LIST_CAP = 50
  // In-dialog × discard: which row's confirm strip is open + the in-flight
  // guard. Confirm runs discardLocalEdit (D6-safe: the row keeps its file
  // link/provenance, only the pending write is abandoned) and rebuilds the
  // breakdown — the dialog stays truthful about what the run would do.
  let pushDiscardTarget = $state<string | null>(null)
  let pushDiscardBusy = $state(false)

  /** Single derivation of `pushBreakdown` from the live pending rows and
   *  probed tag cache, shared across open, detail-close, and per-row discard. */
  async function refreshPushBreakdown(): Promise<PushBreakdown> {
    const pending = await getPendingSyncMetadata()
    const currentBaseKey = webdavBaseKey($settings.webdavUrl ?? '', $settings.webdavUser ?? '')
    const ctxMap = await buildPushContextMap(currentBaseKey)
    const bd = buildPushBreakdown(
      withPushContext(withLibraryTitles(pending, pendingTitleMap()), ctxMap),
      currentBaseKey,
    )
    pushBreakdown = bd
    return bd
  }

  async function pushChanges() {
    await commitCredentials()
    // A mid-session library load (Connect & Load) can orphan pending edits
    // on re-encoded ids AFTER boot relink already ran — try the same
    // path/identity re-link here so the dialog names rows instead of
    // offering raw ids (no-op when nothing is orphaned). AWAITED: the
    // getPendingSyncMetadata read below must observe the moved rows, not the
    // pre-relink Dexie state (the migration e2e caught the race).
    await relinkPendingMetadata(get(library), webdavBaseKey($settings.webdavUrl ?? '', $settings.webdavUser ?? ''))
    const bd = await refreshPushBreakdown()
    if (bd.pushable > 0) {
      confirmPush = true
    } else {
      // if nothing is safely pushable (all skipped/no-path/wrong-server), just run
      // and report the result so the user sees the "N skipped" state.
      performPush()
    }
  }

  /** trackId → "Title — Artist" for the Push dialog (bindTrackToFile's
   *  conflict modal format). Missing library rows fall back to the row's
   *  OWN identity snapshot (stamped at commit time) — so an orphaned stale
   *  id still shows what it was edited as, with a muted "stale" hint
   *  instead of the not-in-library marker. Truly identity-less rows keep
   *  the raw-id fallback. */
  function pendingTitleMap(): Map<string, string> {
    const titles = new Map<string, string>()
    for (const t of get(library)) titles.set(t.trackId, `${t.title}${t.artist ? ` — ${t.artist}` : ''}`)
    for (const row of get(metadataCache).values()) {
      if (!row.title || titles.has(row.trackId)) continue
      titles.set(row.trackId, `${row.title}${row.artist ? ` — ${row.artist}` : ''}`)
    }
    return titles
  }

  /** Builds per-track baseline context (album, fileType, previous rating/loved
   *  from the probed WebDAV file tag cache only) so the
   *  Push confirmation dialog can render clean old → new diffs. */
  async function buildPushContextMap(currentBaseKey: string): Promise<Map<string, PushTrackContext>> {
    const ctx = new Map<string, PushTrackContext>()
    const tagEntries = currentBaseKey ? await getFileTagsForBase(currentBaseKey).catch(() => []) : []
    const tagByPath = new Map(tagEntries.filter((e) => e.status === 'ok' && e.metadata).map((e) => [e.path, e.metadata!]))
    const metaById = get(metadataCache)
    for (const t of get(library)) {
      const title = t.title
      const row = metaById.get(t.trackId)
      const fileMeta = row?.webdavPath ? tagByPath.get(row.webdavPath) : undefined
      // Navidrome ratings may already mirror the local edit and are NOT the
      // previous WebDAV file value. Only a successful file probe is evidence.
      const prevRating = fileMeta?.rating
      const prevLoved = fileMeta?.loved
      ctx.set(t.trackId, {
        title,
        artist: t.artist || undefined,
        album: t.album || undefined,
        fileType: t.fileType,
        prevRating,
        prevLoved,
      })
    }
    for (const row of metaById.values()) {
      if (ctx.has(row.trackId) || !row.title) continue
      const fileMeta = row.webdavPath ? tagByPath.get(row.webdavPath) : undefined
      ctx.set(row.trackId, {
        title: row.title,
        artist: row.artist || undefined,
        fileType: row.fileType,
        prevRating: fileMeta?.rating,
        prevLoved: fileMeta?.loved,
      })
    }
    return ctx
  }

  /** True when the dialog row's name came from a snapshot rather than a live
   *  library row (the muted "stale id" hint, not the not-in-library one). */
  function isSnapshotNamed(t: PushableTrackInfo): boolean {
    if (get(library).some((l) => l.trackId === t.trackId)) return false
    const row = get(metadataCache).get(t.trackId)
    return !!row?.title
  }

  /** Close the push pane's details view and re-derive the breakdown so edits
   *  made in TrackDetailsModal reflect immediately in the confirm pane. */
  async function closePushDetails() {
    detailTrack = null
    if (!confirmPush) return
    const bd = await refreshPushBreakdown()
    if (bd.pushable === 0) confirmPush = false
  }

  // ── In-dialog × discard (the orphan-row cleanup path too) ───────────────

  function requestDiscardPending(t: PushableTrackInfo) {
    if (pushDiscardBusy) return
    pushDiscardTarget = t.trackId
  }

  function cancelDiscardPending() {
    pushDiscardTarget = null
  }

  async function confirmDiscardPending(t: PushableTrackInfo) {
    pushDiscardBusy = true
    try {
      await discardLocalEdit(t.trackId)
      pushDiscardTarget = null
      const bd = await refreshPushBreakdown()
      if (bd.pushable === 0) {
        confirmPush = false
        syncResult = 'All pending edits were discarded — nothing to push.'
      }
    } finally {
      pushDiscardBusy = false
    }
  }

  async function performPush() {
    confirmPush = false
    syncResult = ''
    pushState.set({ active: true, done: 0, total: 0, current: 'Starting…' })
    try {
      const result = await runManualWebDAVSync({
        onProgress: (done, total, current) => {
          // Spread the PRIOR state: a bare set would wipe cancelRequested
          // (set between progress events by the Cancel button) and the run
          // would never stop.
          pushState.update((s) => ({ ...s, active: true, done, total, current }))
        },
        isCancelled: () => get(pushState).cancelRequested === true,
      })
      const parts = [
        ...(result.cancelled ? ['Push cancelled'] : []),
        `Pushed ${result.synced} track(s)`,
        result.failed ? `${result.failed} failed` : '',
      ]
      if (result.repended) parts.push(`${result.repended} kept pending (newer edit during push)`)
      if (result.localFailed) parts.push(`${result.localFailed} written remotely (local cache update failed)`)
      if (result.unknownOutcomes) parts.push(`${result.unknownOutcomes} uncertain (MOVE response lost)`)
      if (result.skipped) parts.push(`${result.skipped} skipped (no pushable WebDAV file)`)
      if (result.wrongServer) parts.push(`${result.wrongServer} on a different server`)
      if (result.blindOverwrite) parts.push(`${result.blindOverwrite} written without ETag protection (server sent no ETag)`)
      if (result.catalogRefresh === 'failed') parts.push('Navidrome catalog refresh failed')
      if (result.failureReason) parts.push(result.failureReason)
      syncResult = parts.filter(Boolean).join(', ')
    } catch (err) {
      syncResult = `Push failed: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      pushState.set({ active: false, done: 0, total: 0, current: '', cancelRequested: false })
    }
  }

  function requestPushCancel() {
    // Sets the flag the run's isCancelled reads; the loop exits between rows.
    pushState.update((s) => ({ ...s, cancelRequested: true }))
  }
</script>

<!-- Push Changes -->
<section class="px-4 py-4">
  <h3 class="mb-3 text-base font-medium text-primary">Push Changes</h3>
  <p class="mb-2 text-sm text-muted">Writes rating and loved edits into your music files' tags over WebDAV.</p>
  <div class="space-y-3">
    <button
      onclick={pushChanges}
      disabled={$pushState.active}
      class="btn-primary btn-lg w-full"
    >
      {#if $pushState.active}
        <svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        Pushing…
      {:else}
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>
        Push Changes
      {/if}
    </button>
    {#if $pushState.active}
      <!-- Live progress lives in the section (the modal closes when
           the run starts) — bar + current row + cancel-between-rows. -->
      <div class="space-y-2">
        <div class="h-1.5 w-full overflow-hidden rounded-full bg-surface-hover">
          <div
            class="h-full rounded-full bg-primary transition-all"
            style="width: {$pushState.total > 0 ? Math.round(($pushState.done / $pushState.total) * 100) : 0}%"
          ></div>
        </div>
        <p class="text-sm text-muted">{$pushState.current}</p>
        <button
          onclick={requestPushCancel}
          disabled={$pushState.cancelRequested}
          class="w-full rounded-lg bg-surface-hover px-4 py-2 text-sm font-medium text-muted transition-opacity hover:opacity-80 disabled:opacity-50"
        >{$pushState.cancelRequested ? 'Cancelling…' : 'Cancel push'}</button>
      </div>
    {/if}
    {#if syncResult}
      <p class="text-sm text-muted">{syncResult}</p>
    {/if}
    <PushReportPanel report={$lastPushReport} />
  </div>
</section>

{#if confirmPush}
  <PushConfirmShell
    count={pushBreakdown.pushable}
    submitDisabled={pushDiscardBusy || pushBreakdown.pushable === 0}
    onsubmit={performPush}
    onclose={() => { confirmPush = false }}
  >
    <ul class="divide-y divide-white/10">
      {#each pushBreakdown.tracks.slice(0, PUSH_DIALOG_LIST_CAP) as t (t.trackId)}
        <li class="py-3.5 text-muted">
          <div class="flex items-start justify-between gap-1">
            <div class="min-w-0 flex-1">
              {#if pushLibraryTracks.get(t.trackId)}
                {@const libraryTrack = pushLibraryTracks.get(t.trackId)!}
                <PushTrackSummary track={t} onopen={() => { detailTrack = libraryTrack }}>
                  {#snippet thumbnail()}
                    <LazyThumb track={libraryTrack} size={96} wrapperClass="h-full w-full" />
                  {/snippet}
                </PushTrackSummary>
              {:else}
                <PushTrackSummary track={t} />
              {/if}
              {#if !pendingTitleMap().has(t.trackId)}
                <p class="text-xs text-amber-300">(Track not in library — no matching song found. Discard with the ×)</p>
              {:else if isSnapshotNamed(t)}
                <p class="text-xs text-muted/70">(no longer in the library — shown from the edit's saved title)</p>
              {/if}
            </div>
            <div class="flex shrink-0 items-center pt-0.5">
              <PushDiscardButton title={t.title} expanded={pushDiscardTarget === t.trackId} testId={`push-discard-${t.trackId}`} onclick={() => requestDiscardPending(t)} disabled={pushDiscardBusy} />
            </div>
          </div>
          {#if pushDiscardTarget === t.trackId}
            <div class="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-surface-hover px-2.5 py-1.5" data-testid={`push-discard-confirm-${t.trackId}`}>
              <span class="min-w-0 flex-1 text-xs">Discard this edit? These rating and loved changes will not be written to the file.</span>
              <button
                onclick={() => confirmDiscardPending(t)}
                disabled={pushDiscardBusy}
                class="min-h-11 shrink-0 rounded-lg bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-300 ring-1 ring-red-500/30 transition-opacity hover:opacity-80 disabled:opacity-50"
              >{pushDiscardBusy ? 'Discarding…' : 'Discard'}</button>
              <button
                onclick={cancelDiscardPending}
                disabled={pushDiscardBusy}
                class="min-h-11 shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium text-muted transition-opacity hover:opacity-80 disabled:opacity-50"
              >Keep</button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    {#if pushBreakdown.tracks.length > PUSH_DIALOG_LIST_CAP}
      <p class="text-xs text-muted">… and {pushBreakdown.tracks.length - PUSH_DIALOG_LIST_CAP} more (the count above is the full list).</p>
    {/if}
    {#if pushBreakdown.wrongServer > 0}
      <p class="text-xs text-amber-300">{pushBreakdown.wrongServer} skipped — matched on a different server.</p>
    {/if}
    {#if pushBreakdown.noBase > 0}
      <p class="text-xs text-amber-300">{pushBreakdown.noBase} skipped — unverified file link (matched before server verification existed). Re-link via File Matching.</p>
    {/if}
    {#if pushBreakdown.ignored > 0}
      <p class="text-xs text-muted">{pushBreakdown.ignored} dismissed — will not be pushed.</p>
    {/if}
    {#if pushBreakdown.noPath > 0}
      <p class="text-xs text-muted">{pushBreakdown.noPath} without a matched file — nothing to write.</p>
    {/if}
  </PushConfirmShell>
{/if}

{#if detailTrack}
  <TrackDetailsModal track={detailTrack} onclose={closePushDetails} />
{/if}

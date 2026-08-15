<script lang="ts">
  import { onMount } from 'svelte'
  import { get } from 'svelte/store'
  import { Capacitor } from '@capacitor/core'
  import { settings, updateSetting, webdavConnection, navidromeConnection, navidromeLoadStatus, metadataScanState, library } from '../stores/appState'
  import { saveViewStateSession, restoreViewStateSession } from '../lib/viewState'
  import { appVersion, commitHash, buildTime } from '../lib/version'
  import { runManualWebDAVSync, testWebdavConn, testNavidromeConn, loadLibraryFromNavidrome } from '../lib/syncEngine'
  import { webdavBaseKey } from '../lib/webdavUtils'
  import { getPendingSyncMetadata } from '../lib/db'
  import { setWebdavCredentials, rebuildIndex, scanAll, listUnresolvedMatches, searchWebdavFiles, bindTrackToFile, unbindTrack, ignoreTrack, unignoreTrack, discardLocalEdit, DISPLAY_CAP, tagProbeState, ensureTagProbe, reverifyStaleLinks, reverifyTrack } from '../lib/metadataScanner'
  import type { UnresolvedTrack } from '../lib/metadataScanner'
  import { setSetting } from '../lib/db'
  import { reconcileToNavidrome } from '../lib/feedbackService'
  import { getCachedConfig, setCachedConfig, cachedConfigMatches } from '../lib/navidromeApi'
  import { tick } from 'svelte'
  import type { SettingsMap } from '../stores/appState'
  import type { WebdavFileEntry } from '../lib/db'

  type SettingsTab = 'sources' | 'playback' | 'library' | 'about'

  const savedSettingsState = restoreViewStateSession<{ tab?: SettingsTab; scrollTops?: Record<string, number> }>('settings')

  let tab = $state<SettingsTab>(savedSettingsState?.tab ?? 'sources')
  let scrollTops = $state<Record<string, number>>({ sources: 0, playback: 0, library: 0, about: 0, ...(savedSettingsState?.scrollTops ?? {}) })

  const tabs: { id: SettingsTab; label: string }[] = [
    { id: 'sources', label: 'Sources' },
    { id: 'playback', label: 'Playback' },
    { id: 'library', label: 'Library' },
    { id: 'about', label: 'About' },
  ]

  let syncing = $state(false)
  let syncResult = $state('')
  let pendingPushCount = $state(0)
  let confirmPush = $state(false)
  let reconcileResult = $state('')
  let indexing = $state(false)
  let scrollContainer: HTMLDivElement | null = null

  $effect(() => {
    const st = scrollContainer?.scrollTop ?? 0
    if (scrollTops[tab] !== st) scrollTops[tab] = st
    saveViewStateSession('settings', { tab, scrollTops })
  })

  onMount(async () => {
    await tick()
    if (scrollContainer) scrollContainer.scrollTop = scrollTops[tab]
  })

  function switchTab(t: SettingsTab) {
    if (t === tab) return
    if (scrollContainer) scrollTops[tab] = scrollContainer.scrollTop
    tab = t
    tick().then(() => {
      if (scrollContainer) scrollContainer.scrollTop = scrollTops[t]
    })
  }

  function onInput(field: 'webdavUrl' | 'webdavUser' | 'webdavToken' | 'navidromeUrl' | 'navidromeUser' | 'navidromePassword') {
    return (e: Event) => {
      updateSetting(field, (e.target as HTMLInputElement).value)
    }
  }

  function setPreload(val: number) {
    updateSetting('preloadTracks', val)
  }

  function setCrossfade(e: Event) {
    updateSetting('crossfadeDuration', Number((e.target as HTMLInputElement).value))
  }

  function setReplayGainMode(val: 'off' | 'track' | 'album') {
    updateSetting('replayGainMode', val)
  }

  function setRatingSource(val: 'webdav' | 'navidrome') {
    updateSetting('ratingSource', val)
    if (val === 'navidrome') {
      // Navidrome-only writing: local file tags are never the target.
      updateSetting('syncToNavidrome', true)
    }
  }

  async function setSyncToNavidrome() {
    const val = !($settings.syncToNavidrome ?? false)
    updateSetting('syncToNavidrome', val)
    reconcileResult = ''
    if (val && ($settings.ratingSource ?? 'webdav') === 'webdav') {
      // Turning on server mirroring in WebDAV mode pushes the current local diff.
      reconcileResult = await reconcileRatings()
    }
  }

  function setWriteTagsInNavidromeMode() {
    updateSetting('writeTagsInNavidromeMode', !($settings.writeTagsInNavidromeMode ?? false))
  }

  async function reconcileRatings(): Promise<string> {
    try {
      const res = await reconcileToNavidrome()
      return `Synced ${res.pushed} track(s) to Navidrome`
    } catch (err) {
      return `Sync failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  function setScrobbling() {
    updateSetting('scrobbling', !($settings.scrobbling ?? false))
  }

  /**
   * Synchronously pushes the edited credential fields into the settings store
   * AND Dexie, with URL/user normalization applied. Action buttons must call
   * this before reading `$settings` / `getSetting` so they act on the newest
   * durable values. There is no debounce window left to race: the inputs write
   * through to the store on every keystroke, so this only guarantees persistence
   * + trimming right before a network call.
   */
  async function commitCredentials(): Promise<void> {
    const s = get(settings)
    const entries: [keyof SettingsMap, string][] = [
      ['webdavUrl', s.webdavUrl ?? ''],
      ['webdavUser', s.webdavUser ?? ''],
      ['webdavToken', s.webdavToken ?? ''],
      ['navidromeUrl', s.navidromeUrl ?? ''],
      ['navidromeUser', s.navidromeUser ?? ''],
      ['navidromePassword', s.navidromePassword ?? ''],
    ]
    // URL/user fields are trimmed (stray whitespace breaks request URLs and
    // cache baseKeys); tokens/passwords are preserved byte-for-byte.
    const normalize = (key: keyof SettingsMap, value: string): string =>
      key === 'webdavUrl' || key === 'webdavUser' || key === 'navidromeUrl' || key === 'navidromeUser'
        ? value.trim()
        : value
    for (const [key, value] of entries) {
      updateSetting(key, normalize(key, value))
    }
    await Promise.all(entries.map(([key, value]) => setSetting(key, normalize(key, value))))
    // A committed url/user change — including clearing the fields — invalidates
    // the in-memory Navidrome config cache, or stale stream/cover URLs keep
    // pointing at the old server until restart (TODO 3.4).
    const navUrl = normalize('navidromeUrl', s.navidromeUrl ?? '')
    const navUser = normalize('navidromeUser', s.navidromeUser ?? '')
    if (!cachedConfigMatches(getCachedConfig(), navUrl, navUser)) {
      setCachedConfig(null)
    }
  }

  async function testWebdav() {
    await commitCredentials()
    webdavConnection.set({ connected: false, checking: true })
    try {
      const result = await testWebdavConn()
      webdavConnection.set({ ...result, checking: false })
      // Fresh setup flow: a working WebDAV server plus an already-loaded
      // library can populate ratings immediately. Gated on the library being
      // loaded and no scan being in flight — repeated credential re-tests and
      // completed scan states stay inert; "error" recovers a creds-less
      // attempt once the fields are filled and tested again.
      if (result.connected && $settings.webdavUrl && $settings.webdavUser && $settings.webdavToken) {
        if (get(library).length > 0 && (get(metadataScanState).status === 'idle' || get(metadataScanState).status === 'error')) {
          setWebdavCredentials($settings.webdavUrl, $settings.webdavUser, $settings.webdavToken)
          scanAll('modified')
        }
      }
    } catch (err) {
      webdavConnection.set({ connected: false, error: err instanceof Error ? err.message : String(err), checking: false })
    }
  }

  async function buildIndex() {
    indexing = true
    try {
      await commitCredentials()
      const s = $settings
      if (s.webdavUrl && s.webdavUser && s.webdavToken) {
        setWebdavCredentials(s.webdavUrl, s.webdavUser, s.webdavToken)
      }
      await rebuildIndex()
    } catch (err) {
      metadataScanState.set({
        status: 'error',
        progress: { scanned: 0, total: 0, failed: 0, missing: 0, duplicateMatches: 0 },
        error: err instanceof Error && err.message === 'WebDAV credentials not configured'
          ? err.message
          : 'WebDAV index refresh failed — is the WebDAV server reachable?',
      })
    } finally {
      indexing = false
    }
  }

  async function startMetadataScan() {
    await commitCredentials()
    const s = $settings
    if (s.webdavUrl && s.webdavUser && s.webdavToken) {
      setWebdavCredentials(s.webdavUrl, s.webdavUser, s.webdavToken)
    }
    // scanAll probes the server itself — no ensureIndex pre-call.
    scanAll('modified')
  }

  async function rescanAllMetadata() {
    await commitCredentials()
    const s = $settings
    if (s.webdavUrl && s.webdavUser && s.webdavToken) {
      setWebdavCredentials(s.webdavUrl, s.webdavUser, s.webdavToken)
    }
    scanAll('force')
  }

  async function connectNavidromeHandler() {
    await commitCredentials()
    navidromeConnection.set({ connected: false, checking: true })
    navidromeLoadStatus.set({ loading: true, loaded: 0, failed: 0 })
    try {
      // Shared pipeline (same as app startup): connect → library + metadata
      // seeding → server lastScan → automatic incremental WebDAV scan.
      const result = await loadLibraryFromNavidrome(true)
      navidromeConnection.set({ ...result.connection, checking: false })
      navidromeLoadStatus.set({
        loading: false,
        loaded: result.loadResult.loaded,
        failed: result.loadResult.failed,
        error: result.loadResult.error,
        cached: result.loadResult.cached,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      navidromeConnection.set({ connected: false, error: msg, checking: false })
      navidromeLoadStatus.set({ loading: false, loaded: 0, failed: 0, error: msg })
    }
  }

  async function testNavidrome() {
    await commitCredentials()
    navidromeConnection.set({ connected: false, checking: true })
    try {
      const result = await testNavidromeConn()
      navidromeConnection.set({ ...result, checking: false })
    } catch (err) {
      navidromeConnection.set({ connected: false, error: err instanceof Error ? err.message : String(err), checking: false })
    }
  }

  async function pushChanges() {
    await commitCredentials()
    const pending = await getPendingSyncMetadata()
    // Ignored rows are never pushed (D5) — they must not inflate the
    // confirmation count or the unsafe bucket (TODO 3.8c).
    const pushable = pending.filter((r) => !r.ignored)
    // The same derivation the scan stamp and Push use (webdavBaseKey) — a raw
    // template here would misclassify every row on stray whitespace and could
    // skip the confirmation dialog entirely (TODO 3.5 convention).
    const currentBaseKey = webdavBaseKey($settings.webdavUrl ?? '', $settings.webdavUser ?? '')
    const safeCount = pushable.filter((r) => r.webdavPath && r.webdavBase === currentBaseKey).length
    if (safeCount > 0) {
      pendingPushCount = safeCount
      confirmPush = true
    }
    // if nothing is safely pushable (all skipped/no-path/wrong-server), just run
    // and report the result so the user sees the "N skipped" state.
    if (safeCount === 0) {
      performPush()
    }
  }

  async function performPush() {
    confirmPush = false
    syncing = true
    syncResult = ''
    try {
      const result = await runManualWebDAVSync()
      const parts = [`Pushed ${result.synced} track(s)`, result.failed ? `${result.failed} failed` : '']
      if (result.skipped) parts.push(`${result.skipped} skipped (no pushable WebDAV file)`)
      if (result.wrongServer) parts.push(`${result.wrongServer} on a different server`)
      if (result.blindOverwrite) parts.push(`${result.blindOverwrite} written without ETag protection (server sent no ETag)`)
      syncResult = parts.filter(Boolean).join(', ')
    } catch (err) {
      syncResult = `Push failed: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      syncing = false
    }
  }

  // ── File Matching ──────────────────────────────────────────────────────

  const kindBadges: Record<UnresolvedTrack['kind'], { label: string; cls: string }> = {
    'ambiguous': { label: 'Multiple matches', cls: 'bg-yellow-500/20 text-yellow-300 ring-yellow-500/30' },
    'no-match': { label: 'File not found', cls: 'bg-red-500/20 text-red-300 ring-red-500/30' },
    'vanished': { label: 'Removed from server', cls: 'bg-red-500/20 text-red-300 ring-red-500/30' },
    'stale-base': { label: 'Server URL updated', cls: 'bg-orange-500/20 text-orange-300 ring-orange-500/30' },
    'ignored': { label: 'Ignored', cls: 'bg-white/10 text-muted ring-white/20' },
    'matched': { label: 'Matched', cls: 'bg-green-500/20 text-green-300 ring-green-500/30' },
  }

  let unresolvedRows = $state<UnresolvedTrack[]>([])
  let unresolvedLoading = $state(false)
  let unresolvedError = $state('')
  let unresolvedLoaded = $state(false)
  let pickerTrackId = $state<string | null>(null)
  let searchQuery = $state('')
  let searchResults = $state<WebdavFileEntry[]>([])
  let searching = $state(false)
  let conflict = $state<{ trackId: string; path: string; conflictTitle: string } | null>(null)
  let showIgnored = $state(false)
  let showMatched = $state(false)
  let unresolvedCounts = $state<Record<UnresolvedTrack['kind'], number>>({ 'no-match': 0, ambiguous: 0, 'vanished': 0, 'stale-base': 0, matched: 0, ignored: 0 })
  let blockedCount = $state(0)
  let bindError = $state<{ trackId: string; message: string } | null>(null)
  let matchCap = $state(DISPLAY_CAP)
  let reverifyState = $state<{ running: boolean; result: string }>({ running: false, result: '' })

  function countTotal(): number {
    const c = unresolvedCounts
    return c['no-match'] + c.ambiguous + c.vanished + c['stale-base'] + c.ignored + c.matched
  }

  function countLine(): string {
    const c = unresolvedCounts
    const bits: string[] = []
    if (c['no-match']) bits.push(`${c['no-match']} file not found`)
    if (c.ambiguous) bits.push(`${c.ambiguous} multiple matches`)
    if (c.vanished) bits.push(`${c.vanished} removed from server`)
    if (c['stale-base']) bits.push(`${c['stale-base']} server changed`)
    if (c.ignored) bits.push(`${c.ignored} ignored`)
    if (bits.length === 0) return ''
    const line = `Unresolved — ${bits.join(', ')}`
    return blockedCount > 0 ? `${line}; ${blockedCount} blocked by pending edits` : line
  }

  function tagProbeText(): string {
    const s = $tagProbeState
    return s.done > 0 ? `${s.done} file${s.done === 1 ? '' : 's'} (${s.remaining} remaining)` : 'unclaimed files'
  }

  // Full set (returned uncapped) is held in unresolvedRows; toggles + matchCap
  // filter and slice it client-side so ignored/matched rows are never starved
  // out of visibility by an arbitrary hard cap.
  const filterVisible = $derived(
    unresolvedRows.filter((r) => (showIgnored || r.kind !== 'ignored') && (showMatched || r.kind !== 'matched')),
  )
  const visibleRows = $derived(filterVisible.slice(0, matchCap))

  async function refreshUnresolved() {
    const prevTop = scrollContainer?.scrollTop ?? 0
    unresolvedLoading = true
    unresolvedError = ''
    bindError = null
    try {
      await commitCredentials()
      const s = $settings
      if (s.webdavUrl && s.webdavUser && s.webdavToken) {
        setWebdavCredentials(s.webdavUrl, s.webdavUser, s.webdavToken)
      } else {
        unresolvedError = 'WebDAV credentials not configured'
        unresolvedRows = []
        return
      }
      const rows = await listUnresolvedMatches()
      unresolvedRows = rows.rows
      unresolvedCounts = rows.counts
      blockedCount = rows.pendingBlocked
      unresolvedLoaded = true
      void ensureTagProbe()
    } catch (err) {
      unresolvedError = err instanceof Error ? err.message : String(err)
    } finally {
      unresolvedLoading = false
      await tick()
      if (scrollContainer && prevTop > 0) scrollContainer.scrollTop = prevTop
    }
  }

  $effect(() => {
    if (tab !== 'library' || unresolvedLoaded) return
    refreshUnresolved()
  })

  function openPicker(trackId: string) {
    pickerTrackId = pickerTrackId === trackId ? null : trackId
    searchQuery = ''
    searchResults = []
    bindError = null
  }

  async function runSearch() {
    if (!pickerTrackId) return
    const row = unresolvedRows.find((r) => r.trackId === pickerTrackId)
    if (!row) return
    searching = true
    try {
      searchResults = searchWebdavFiles(searchQuery, row.fileType)
    } finally {
      searching = false
    }
  }

  async function doBind(trackId: string, path: string, force = false) {
    bindError = null
    const res = await bindTrackToFile(trackId, path, force)
    if (res.ok) {
      conflict = null
      pickerTrackId = null
      await refreshUnresolved()
      return
    }
    if (res.reason === 'conflict' && !force) {
      conflict = { trackId, path, conflictTitle: res.conflictTitle ?? '' }
      return
    }
    if (res.reason === 'conflict-pending') {
      bindError = {
        trackId,
        message: `Can't re-bind — the other track (${res.conflictTitle ?? 'unknown'}) has a pending change; unbound edits would be lost.`,
      }
      conflict = null
      return
    }
    bindError = {
      trackId,
      message: res.reason === 'not-in-index'
        ? 'That file is not in the current index — refresh the index first.'
        : res.reason === 'no-row'
          ? 'No metadata row for this track.'
          : res.reason === 'no-creds'
            ? 'WebDAV credentials not configured.'
            : 'Could not bind.',
    }
  }

  async function doUnbind(trackId: string) {
    await unbindTrack(trackId)
    await refreshUnresolved()
  }

  async function doIgnore(trackId: string) {
    await ignoreTrack(trackId)
    await refreshUnresolved()
  }

  async function doUnignore(trackId: string) {
    await unignoreTrack(trackId)
    await refreshUnresolved()
  }

  async function doRestamp(row: UnresolvedTrack) {
    if (!row.webdavPath) return
    bindError = null
    const res = await reverifyTrack(row.trackId)
    if (!res.ok) {
      bindError = res.reason === 'no-creds'
        ? { trackId: row.trackId, message: 'WebDAV credentials not configured.' }
        : res.reason === 'index-failure'
          ? { trackId: row.trackId, message: 'Index refresh failed — is the WebDAV server reachable?' }
          : res.reason === 'not-in-index'
          ? { trackId: row.trackId, message: 'That file is not in the current index — refresh the index first.' }
          : res.reason === 'no-row'
            ? { trackId: row.trackId, message: 'No metadata row for this track.' }
            : res.reason === 'not-stale'
              ? { trackId: row.trackId, message: 'This link is already current.' }
              : res.reason === 'conflict'
                ? {
                    trackId: row.trackId,
                    message: `The file's tags say "${res.fileTitle}" — not "${row.title}". Clear the link and pick the right file.`,
                  }
                : { trackId: row.trackId, message: 'Could not verify the file.' }
      return
    }
    await refreshUnresolved()
  }

  async function doDiscard(trackId: string) {
    await discardLocalEdit(trackId)
    await refreshUnresolved()
  }

  async function doReverify() {
    reverifyState = { running: true, result: '' }
    try {
      const r = await reverifyStaleLinks()
      const bits: string[] = []
      if (r.conflict) bits.push(`${r.conflict} don't match the linked file`)
      if (r.unknown) bits.push(`${r.unknown} couldn't be read`)
      reverifyState = {
        running: false,
        result: bits.length > 0
          ? `Re-verified ${r.verified} — ${bits.join(', ')} — check the rows below.`
          : r.verified > 0
            ? `Re-verified ${r.verified} row${r.verified === 1 ? '' : 's'}.`
            : 'Nothing to re-verify.',
      }
    } catch (e) {
      reverifyState = { running: false, result: e instanceof Error ? e.message : 'Re-verify failed.' }
    }
    await refreshUnresolved()
  }
</script>

<div class="flex h-full flex-col">
  <div class="border-b border-white/10 px-4 py-3">
    <h2 class="text-sm font-medium uppercase tracking-wider text-muted">Settings</h2>
    <div class="mt-2 flex gap-1">
      {#each tabs as t (t.id)}
        <button
          onclick={() => switchTab(t.id)}
          class="rounded-lg px-4 py-1.5 text-sm font-medium transition-colors"
          class:bg-surface-hover={tab === t.id}
          class:text-primary={tab === t.id}
          class:text-muted={tab !== t.id}
        >{t.label}</button>
      {/each}
    </div>
  </div>
  <div class="flex-1 overflow-y-auto pb-24" bind:this={scrollContainer}
       onscroll={() => { if (scrollContainer) scrollTops[tab] = scrollContainer.scrollTop }}>
    <div class="divide-y divide-white/10">
      {#if tab === 'sources'}
        <!-- Navidrome -->
        <section class="px-4 py-4">
          <h3 class="mb-3 text-base font-medium text-primary">Navidrome</h3>
          <div class="space-y-3">
            <input
              type="url"
              data-testid="navidrome-url"
              placeholder="https://music.example.com"
              value={$settings.navidromeUrl ?? ''}
              oninput={onInput('navidromeUrl')}
              class="w-full rounded-lg bg-surface-hover px-4 py-2 text-sm text-primary placeholder-muted outline-none ring-1 ring-transparent transition-colors focus:ring-white/20"
            />
            <input
              type="text"
              data-testid="navidrome-user"
              placeholder="Username"
              value={$settings.navidromeUser ?? ''}
              oninput={onInput('navidromeUser')}
              class="w-full rounded-lg bg-surface-hover px-4 py-2 text-sm text-primary placeholder-muted outline-none ring-1 ring-transparent transition-colors focus:ring-white/20"
            />
            <input
              type="password"
              data-testid="navidrome-password"
              placeholder="Password"
              value={$settings.navidromePassword ?? ''}
              oninput={onInput('navidromePassword')}
              class="w-full rounded-lg bg-surface-hover px-4 py-2 text-sm text-primary placeholder-muted outline-none ring-1 ring-transparent transition-colors focus:ring-white/20"
            />
            <div class="flex items-center gap-3">
              <button
                onclick={testNavidrome}
                disabled={$navidromeConnection.checking || $navidromeLoadStatus.loading}
                class="flex items-center justify-center gap-2 rounded-lg bg-surface-hover px-5 py-2.5 text-sm font-medium text-primary transition-opacity hover:opacity-80 disabled:opacity-50"
              >
                {#if $navidromeConnection.checking}
                  <svg class="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Testing…
                {:else}
                  Test Connection
                {/if}
              </button>
            </div>
            <button
              onclick={connectNavidromeHandler}
              disabled={$navidromeConnection.checking || $navidromeLoadStatus.loading}
              class="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-base font-medium text-background transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              {#if $navidromeConnection.checking || $navidromeLoadStatus.loading}
                <svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                {$navidromeConnection.checking ? 'Connecting…' : 'Loading Songs…'}
              {:else}
                Connect & Load Songs
              {/if}
            </button>
            {#if $navidromeConnection.connected}
              <p class="text-sm text-green-400">
                Connected{$navidromeConnection.serverVersion ? ' (' + $navidromeConnection.serverVersion + ')' : ''}
              </p>
            {:else if $navidromeConnection.error}
              <p class="text-sm text-red-400">{$navidromeConnection.error}</p>
            {/if}
            {#if $navidromeLoadStatus.loaded > 0 || $navidromeLoadStatus.error}
              <p class="text-sm text-muted">
                {$navidromeLoadStatus.error
                  ? `Error: ${$navidromeLoadStatus.error}`
                  : `Loaded ${$navidromeLoadStatus.loaded} song(s), ${$navidromeLoadStatus.failed} failed${$navidromeLoadStatus.cached ? ' (from cache)' : ''}`}
              </p>
            {/if}
          </div>
        </section>

        <!-- WebDAV -->
        <section class="px-4 py-4">
          <h3 class="mb-3 text-base font-medium text-primary">WebDAV Sync</h3>
          <p class="mb-2 text-sm text-muted">
            {Capacitor.isNativePlatform()
              ? 'The native app talks to the server directly, so no CORS setup is needed. On the web app the server must allow requests from this site.'
              : 'Requires CORS to be allowed on the server for this site.'}
          </p>
          <div class="space-y-3">
            <input
              type="url"
              placeholder="https://example.com/remote.php/dav/files/user/"
              value={$settings.webdavUrl ?? ''}
              oninput={onInput('webdavUrl')}
              class="w-full rounded-lg bg-surface-hover px-4 py-2 text-sm text-primary placeholder-muted outline-none ring-1 ring-transparent transition-colors focus:ring-white/20"
            />
            <input
              type="text"
              placeholder="Username"
              value={$settings.webdavUser ?? ''}
              oninput={onInput('webdavUser')}
              class="w-full rounded-lg bg-surface-hover px-4 py-2 text-sm text-primary placeholder-muted outline-none ring-1 ring-transparent transition-colors focus:ring-white/20"
            />
            <input
              type="password"
              placeholder="Password / Token"
              value={$settings.webdavToken ?? ''}
              oninput={onInput('webdavToken')}
              class="w-full rounded-lg bg-surface-hover px-4 py-2 text-sm text-primary placeholder-muted outline-none ring-1 ring-transparent transition-colors focus:ring-white/20"
            />
            <div class="flex items-center gap-3">
              <button
                onclick={testWebdav}
                disabled={$webdavConnection.checking}
                class="flex items-center justify-center gap-2 rounded-lg bg-surface-hover px-5 py-2.5 text-sm font-medium text-primary transition-opacity hover:opacity-80 disabled:opacity-50"
              >
                {#if $webdavConnection.checking}
                  <svg class="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Testing…
                {:else}
                  Test Connection
                {/if}
              </button>
              {#if $webdavConnection.connected}
                <span class="text-sm text-green-400">Connected</span>
              {:else if $webdavConnection.error}
                <span class="text-sm text-red-400">{$webdavConnection.error}</span>
              {/if}
            </div>
            <button
              onclick={rescanAllMetadata}
              disabled={$metadataScanState.status === 'scanning'}
              class="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-base font-medium text-background transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              {#if $metadataScanState.status === 'scanning'}
                <svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Scanning {$metadataScanState.progress.scanned}/{$metadataScanState.progress.total}...
              {:else if $metadataScanState.status === 'complete' && $metadataScanState.progress.total > 0 && $metadataScanState.error === undefined}
                <svg class="h-4 w-4 text-green-400" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                Done — rescan again
              {:else}
                <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M19 8H5v11h14V8zm0-2c1.1 0 2 .9 2 2v11c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V8c0-1.1.9-2 2-2h14zm-7 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3z"/></svg>
                Rescan All Metadata
              {/if}
            </button>
            {#if $metadataScanState.status === 'complete'}
              {#if $metadataScanState.error}
                <p class="text-sm text-red-400">{$metadataScanState.error}</p>
              {:else}
                <p class="text-sm text-green-400">Scan complete — {$metadataScanState.progress.scanned} scanned, {$metadataScanState.progress.failed} failed{$metadataScanState.progress.missing > 0 ? `, ${$metadataScanState.progress.missing} files missing` : ''}{$metadataScanState.progress.duplicateMatches > 0 ? `, ${$metadataScanState.progress.duplicateMatches} ambiguous` : ''}</p>
              {/if}
            {:else if $metadataScanState.status === 'scanning'}
              <p class="text-sm text-muted">{$metadataScanState.progress.annotation ?? 'Scanning files'} — {$metadataScanState.progress.scanned}/{$metadataScanState.progress.total} ({$metadataScanState.progress.failed} failed)</p>
            {:else if $metadataScanState.status === 'error'}
              <p class="text-sm text-red-400">{$metadataScanState.error}</p>
            {/if}
          </div>
        </section>

        <!-- Ratings source -->
        <section class="px-4 py-4">
          <h3 class="mb-3 text-base font-medium text-primary">Ratings Source</h3>
          <p class="mb-3 text-sm text-muted">Where rating and loved changes are written. Loaded values always come from both sources and are merged for display.</p>
          <div class="space-y-3">
            <div class="flex gap-2">
              {#each [{ id: 'webdav', label: 'Your Files' }, { id: 'navidrome', label: 'Navidrome' }] as opt}
                <button
                  onclick={() => setRatingSource(opt.id as 'webdav' | 'navidrome')}
                  class="rounded-lg px-5 py-2.5 text-sm font-medium transition-colors"
                  class:bg-primary={($settings.ratingSource ?? 'webdav') === opt.id}
                  class:text-background={($settings.ratingSource ?? 'webdav') === opt.id}
                  class:bg-surface-hover={($settings.ratingSource ?? 'webdav') !== opt.id}
                  class:text-muted={($settings.ratingSource ?? 'webdav') !== opt.id}
                >{opt.label}</button>
              {/each}
            </div>
            {#if ($settings.ratingSource ?? 'webdav') === 'navidrome'}
              <p class="text-sm text-muted">Navidrome is the authoritative store. Ratings are pushed straight to the server.</p>
              <label class="flex cursor-pointer items-center gap-3">
                <input type="checkbox" checked={$settings.writeTagsInNavidromeMode ?? false} onchange={setWriteTagsInNavidromeMode} class="accent-yellow-500" />
                <div>
                  <p class="text-base text-primary">Also write tags to your files</p>
                  <p class="text-sm text-muted">Keep file tags in sync with the server so MusicBee sees phone edits (pushed with Push Changes).</p>
                </div>
              </label>
            {:else}
              <label class="flex cursor-pointer items-center gap-3">
                <input type="checkbox" checked={$settings.syncToNavidrome ?? false} onchange={setSyncToNavidrome} class="accent-yellow-500" />
                <div>
                  <p class="text-base text-primary">Also mirror ratings to Navidrome</p>
                  <p class="text-sm text-muted">Mirror every rating/loved change to the server while keeping your files as the source of truth.</p>
                </div>
              </label>
              {#if reconcileResult}
                <p class="text-sm text-muted">{reconcileResult}</p>
              {/if}
            {/if}
          </div>
        </section>
      {/if}

      {#if tab === 'playback'}
        <!-- Preload -->
        <section class="px-4 py-4">
          <h3 class="mb-3 text-base font-medium text-primary">Preloading</h3>
          <p class="mb-2 text-sm text-muted">Number of upcoming tracks to preload</p>
          <div class="flex gap-2">
            {#each [0, 1, 2, 3, 5] as n}
              <button
                onclick={() => setPreload(n)}
                class="rounded-lg px-5 py-2.5 text-sm font-medium transition-colors"
                class:bg-primary={($settings.preloadTracks ?? 0) === n}
                class:text-background={($settings.preloadTracks ?? 0) === n}
                class:bg-surface-hover={($settings.preloadTracks ?? 0) !== n}
                class:text-muted={($settings.preloadTracks ?? 0) !== n}
              >{n === 0 ? 'Off' : n}</button>
            {/each}
          </div>
        </section>

        <!-- Crossfade -->
        <section class="px-4 py-4">
          <h3 class="mb-3 text-base font-medium text-primary">Crossfade</h3>
          <div class="flex items-center gap-3">
            <input
              type="range"
              min="0"
              max="15"
              step="0.5"
              value={$settings.crossfadeDuration ?? 0}
              oninput={setCrossfade}
              class="h-1 flex-1 accent-yellow-500"
            />
            <span class="w-10 text-right text-sm text-muted">{($settings.crossfadeDuration ?? 0)}s</span>
          </div>
        </section>

        <!-- Replay Gain -->
        <section class="px-4 py-4">
          <h3 class="mb-3 text-base font-medium text-primary">Replay Gain</h3>
          <p class="mb-2 text-sm text-muted">Apply loudness normalization based on file metadata</p>
          <div class="flex gap-2">
            {#each ['off', 'track', 'album'] as mode}
              <button
                onclick={() => setReplayGainMode(mode as 'off' | 'track' | 'album')}
                class="rounded-lg px-5 py-2.5 text-sm font-medium transition-colors"
                class:bg-primary={($settings.replayGainMode ?? 'off') === mode}
                class:text-background={($settings.replayGainMode ?? 'off') === mode}
                class:bg-surface-hover={($settings.replayGainMode ?? 'off') !== mode}
                class:text-muted={($settings.replayGainMode ?? 'off') !== mode}
              >{mode === 'off' ? 'Off' : mode === 'track' ? 'Track Gain' : 'Album Gain'}</button>
            {/each}
          </div>
        </section>

        <!-- Scrobbling -->
        <section class="px-4 py-4">
          <label class="flex cursor-pointer items-center gap-3">
            <input type="checkbox" checked={$settings.scrobbling ?? false} onchange={setScrobbling} class="accent-yellow-500" />
            <div>
              <p class="text-base text-primary">Scrobble to Navidrome</p>
              <p class="text-sm text-muted">Report plays and now-playing status. Navidrome forwards to Last.fm / ListenBrainz if configured there.</p>
            </div>
          </label>
        </section>
      {/if}

      {#if tab === 'library'}
        <!-- Push Changes -->
        <section class="px-4 py-4">
          <h3 class="mb-3 text-base font-medium text-primary">Push Changes</h3>
          <p class="mb-2 text-sm text-muted">Upload locally modified ratings and loved flags to your WebDAV files.</p>
          <div class="space-y-3">
            <button
              onclick={pushChanges}
              disabled={syncing}
              class="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-base font-medium text-background transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              {#if syncing}
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
            {#if syncResult}
              <p class="text-sm text-muted">{syncResult}</p>
            {/if}
          </div>
        </section>

        {#if confirmPush}
          <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
            <div class="w-full max-w-sm rounded-xl bg-surface-raised p-4">
              <h4 class="mb-2 text-base font-medium text-primary">Write ratings to WebDAV files?</h4>
              <p class="mb-4 text-sm text-muted">
                This will download and rewrite tags (rating and loved heart) on {pendingPushCount} file(s) on your WebDAV server. A wrong file link gives the rating to a different file. Open File Matching to verify the file paths first.
              </p>
              <div class="flex justify-end gap-2">
                <button
                  onclick={() => { confirmPush = false }}
                  class="rounded-lg bg-surface-hover px-4 py-2 text-sm font-medium text-muted transition-opacity hover:opacity-80"
                >Cancel</button>
                <button
                  onclick={performPush}
                  class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-80"
                >Write to files</button>
              </div>
            </div>
          </div>
        {/if}

        <!-- Metadata Scan -->
        <section class="px-4 py-4">
          <h3 class="mb-3 text-base font-medium text-primary">Metadata Scan</h3>
          <p class="mb-2 text-sm text-muted">Read ratings and loved status from file tags via WebDAV. Runs incremental check on library load (1 request, only reads changed files).</p>
          <div class="space-y-3">
            <button
              onclick={startMetadataScan}
              disabled={$metadataScanState.status === 'scanning'}
              class="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-base font-medium text-background transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              {#if $metadataScanState.status === 'scanning'}
                <svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Scanning {$metadataScanState.progress.scanned}/{$metadataScanState.progress.total}...
              {:else}
                <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M19 8H5v11h14V8zm0-2c1.1 0 2 .9 2 2v11c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V8c0-1.1.9-2 2-2h14zm-7 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3z"/></svg>
                Check Modified Ratings
              {/if}
            </button>
            <button
              onclick={rescanAllMetadata}
              disabled={$metadataScanState.status === 'scanning'}
              class="flex w-full items-center justify-center gap-2 rounded-lg bg-surface-hover px-4 py-3 text-base font-medium text-primary transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              {#if $metadataScanState.status === 'scanning'}
                <svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Scanning {$metadataScanState.progress.scanned}/{$metadataScanState.progress.total}...
              {:else}
                <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M19 8H5v11h14V8zm0-2c1.1 0 2 .9 2 2v11c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V8c0-1.1.9-2 2-2h14zm-7 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3z"/></svg>
                Rescan All Metadata
              {/if}
            </button>
            <button
              onclick={buildIndex}
              disabled={indexing}
              class="flex w-full items-center justify-center gap-2 rounded-lg bg-surface-hover px-4 py-3 text-base font-medium text-primary transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              {#if indexing}
                Indexing...
              {:else}
                Rebuild WebDAV File Index
              {/if}
            </button>
            {#if $metadataScanState.status === 'complete'}
              {#if $metadataScanState.error}
                <p class="text-sm text-red-400">{$metadataScanState.error}</p>
              {:else}
                <p class="text-sm text-green-400">Scan complete — {$metadataScanState.progress.scanned} scanned, {$metadataScanState.progress.failed} failed{$metadataScanState.progress.missing > 0 ? `, ${$metadataScanState.progress.missing} files missing` : ''}{$metadataScanState.progress.duplicateMatches > 0 ? `, ${$metadataScanState.progress.duplicateMatches} ambiguous` : ''}</p>
              {/if}
            {:else if $metadataScanState.status === 'scanning'}
              <p class="text-sm text-muted">{$metadataScanState.progress.annotation ?? 'Scanning files'} — {$metadataScanState.progress.scanned}/{$metadataScanState.progress.total} ({$metadataScanState.progress.failed} failed)</p>
            {:else if $metadataScanState.status === 'error'}
              <p class="text-sm text-red-400">{$metadataScanState.error}</p>
            {/if}
          </div>
        </section>

        <!-- File Matching -->
        <section class="px-4 py-4">
          <div class="mb-1 flex items-center justify-between">
            <h3 class="text-base font-medium text-primary">File Matching</h3>
            <button
              onclick={refreshUnresolved}
              disabled={unresolvedLoading || $metadataScanState.status === 'scanning'}
              class="rounded-lg bg-surface-hover px-3 py-1.5 text-sm font-medium text-primary transition-opacity hover:opacity-80 disabled:opacity-50"
            >Refresh</button>
          </div>
          <p class="mb-2 text-sm text-muted">
            Shows songs the scanner could not safely link to a file on your WebDAV server. Link them manually so Push Changes can write their ratings, or mark them as not on this server.
          </p>
          {#if $tagProbeState.active}
            <p class="mb-2 text-sm text-muted">
              Reading tags from {tagProbeText()} to match files by their contents…
            </p>
          {/if}
          {#if countTotal() > 0}
            <p class="mb-2 text-sm text-muted">{countLine()}</p>
          {/if}
          {#if unresolvedCounts['stale-base'] > 0}
            <div class="mb-2 flex items-center gap-2">
              <button
                onclick={doReverify}
                disabled={reverifyState.running || unresolvedLoading || $metadataScanState.status === 'scanning'}
                class="rounded-lg bg-surface-hover px-3 py-1.5 text-sm font-medium text-primary transition-opacity hover:opacity-80 disabled:opacity-50"
              >{reverifyState.running ? 'Re-verifying…' : 'Re-verify file links'}</button>
              {#if reverifyState.result}
                <p class="text-xs text-muted">{reverifyState.result}</p>
              {/if}
            </div>
          {/if}
          {#if unresolvedError}
            <p class="text-sm text-red-400">{unresolvedError}</p>
          {:else if unresolvedRows.length > 0}
            <div class:opacity-50={unresolvedLoading}>
            {#each visibleRows as row (row.trackId)}
              <div class="mb-2 rounded-lg bg-surface px-3 py-2">
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0">
                    <p class="truncate text-sm text-primary">{row.title}</p>
                    <p class="truncate text-xs text-muted">{row.artist}{row.album ? ` · ${row.album}` : ''}</p>
                  </div>
                  <span class="mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 {kindBadges[row.kind].cls}">
                    {row.kind === 'matched' && row.matchSource === 'manual' ? 'Manually bound' : kindBadges[row.kind].label}
                  </span>
                </div>
                {#if row.pendingPush && row.kind !== 'matched'}
                  <p class="mt-1 text-xs text-yellow-300">
                 {row.kind === 'ignored'
                       ? 'A local rating is waiting to upload, but push is skipped while this track is ignored.'
                       : row.kind === 'stale-base'
                         ? 'A local rating is waiting to upload — update the link to push it.'
                         : row.kind === 'vanished'
                           ? 'A local rating is waiting to upload, but its file is gone from the server. Select a file to push.'
                           : 'A local rating is waiting to upload — link it to a file to push.'}
                  </p>
                  <button
                    onclick={() => doDiscard(row.trackId)}
                    class="mt-1 rounded-lg bg-surface-hover px-3 py-1.5 text-sm font-medium text-primary transition-opacity hover:opacity-80"
                  >Discard local change</button>
                {/if}
                {#if row.webdavPath}
                  <p class="mt-1 truncate text-xs text-muted">{row.webdavPath}</p>
                {/if}
                {#if row.kind === 'stale-base'}
                  <div class="mt-2 flex gap-2">
                    <button
                      onclick={() => doRestamp(row)}
                      class="rounded-lg bg-surface-hover px-3 py-1.5 text-sm font-medium text-primary transition-opacity hover:opacity-80"
                    >Update file link</button>
                    <button
                      onclick={() => openPicker(row.trackId)}
                      class="rounded-lg bg-surface-hover px-3 py-1.5 text-sm font-medium text-primary transition-opacity hover:opacity-80"
                  >Search for file…</button>
                    <button
                      onclick={() => doUnbind(row.trackId)}
                      class="rounded-lg bg-surface-hover px-3 py-1.5 text-sm font-medium text-muted transition-opacity hover:opacity-80"
                    >Clear file link</button>
                  </div>
                {:else if row.kind === 'matched'}
                  <button
                    onclick={() => doUnbind(row.trackId)}
                    class="mt-2 rounded-lg bg-surface-hover px-3 py-1.5 text-sm font-medium text-primary transition-opacity hover:opacity-80"
                  >Clear match</button>
                {:else if row.kind === 'ignored'}
                  <button
                    onclick={() => doUnignore(row.trackId)}
                    class="mt-2 rounded-lg bg-surface-hover px-3 py-1.5 text-sm font-medium text-primary transition-opacity hover:opacity-80"
                  >Un-ignore</button>
                {:else}
                  <div class="mt-2 flex gap-2">
                    <button
                      onclick={() => openPicker(row.trackId)}
                      class="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-background transition-opacity hover:opacity-80"
                    >Select correct file…</button>
                    <button
                      onclick={() => doIgnore(row.trackId)}
                      class="rounded-lg bg-surface-hover px-3 py-1.5 text-sm font-medium text-muted transition-opacity hover:opacity-80"
                    >Not on this server</button>
                  </div>
                  {/if}
                {#if bindError && bindError.trackId === row.trackId}
                  <p class="mt-2 text-xs text-red-400">{bindError.message}</p>
                {/if}
                {#if pickerTrackId === row.trackId}
                  <div class="mt-2 space-y-2 border-t border-white/10 pt-2">
                    {#if row.candidates.length > 0}
                      <p class="text-xs text-muted">
                        {row.kind === 'ambiguous'
                          ? (row.candidates.length > 1
                              ? 'Multiple files match equally — choose the correct one:'
                              : 'This file matches by its tags but not certainly — confirm:')
                          : 'Suggested files:'}
                      </p>
                      {#each row.candidates as cand (cand.path)}
                        <button
                          onclick={() => doBind(row.trackId, cand.path)}
                          class="block w-full text-left"
                        >
                          <span class="block truncate rounded-lg bg-surface-hover px-3 py-1.5 text-xs text-primary transition-opacity hover:opacity-80">{cand.path}</span>
                          {#if cand.tags?.title}
                            <span class="block truncate px-1 text-[11px] text-muted">
                              ¶ {cand.tags.title}{cand.tags.artist ? ` — ${cand.tags.artist}` : ''}{cand.tags.album ? ` — ${cand.tags.album}` : ''}
                            </span>
                          {/if}
                        </button>
                      {/each}
                    {/if}
                    <div class="flex gap-2">
                      <input
                        type="text"
                        placeholder="Search all files…"
                        value={searchQuery}
                        oninput={(e) => { searchQuery = (e.target as HTMLInputElement).value }}
                        onkeydown={(e) => { if (e.key === 'Enter') runSearch() }}
                        class="min-w-0 flex-1 rounded-lg bg-surface-hover px-3 py-1.5 text-sm text-primary placeholder-muted outline-none ring-1 ring-transparent transition-colors focus:ring-white/20"
                      />
                      <button
                        onclick={runSearch}
                        disabled={searching || !searchQuery.trim()}
                        class="rounded-lg bg-surface-hover px-3 py-1.5 text-sm font-medium text-primary transition-opacity hover:opacity-80 disabled:opacity-50"
                      >Search</button>
                    </div>
                    {#if searchResults.length > 0}
                      <div class="max-h-40 space-y-1 overflow-y-auto">
                        {#each searchResults as cand (cand.path)}
                          <button onclick={() => doBind(row.trackId, cand.path)} class="block w-full text-left">
                            <span class="block truncate rounded-lg bg-surface-hover px-3 py-1.5 text-xs text-primary transition-opacity hover:opacity-80">{cand.path}</span>
                            {#if cand.tags?.title}
                              <span class="block truncate px-1 text-[11px] text-muted">
                                ¶ {cand.tags.title}{cand.tags.artist ? ` — ${cand.tags.artist}` : ''}{cand.tags.album ? ` — ${cand.tags.album}` : ''}
                              </span>
                            {/if}
                          </button>
                        {/each}
                      </div>
                    {:else if searching}
                      <p class="text-xs text-muted">Searching…</p>
                    {:else if searchQuery.trim()}
                      <p class="text-xs text-muted">No matches for “{searchQuery.trim()}”.</p>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
            {#if visibleRows.length < filterVisible.length}
              <p class="mt-1 text-xs text-muted">Showing {visibleRows.length} of {filterVisible.length} visible rows. Increase "Rows shown" above to list more.</p>
            {:else}
              <p class="mt-1 text-xs text-muted">Showing all {filterVisible.length} visible row{filterVisible.length === 1 ? '' : 's'}.</p>
            {/if}
            <div class="mt-2 flex items-center gap-2 text-sm">
              <label for="matchCap" class="text-muted">Rows shown:</label>
              <input
                id="matchCap"
                type="number"
                min="1"
                placeholder="100"
                value={matchCap}
                oninput={(e) => { const v = +(e.target as HTMLInputElement).value || 0; matchCap = v < 1 ? DISPLAY_CAP : v }}
                class="w-20 rounded-lg bg-surface-hover px-2 py-1 text-sm text-primary outline-none ring-1 ring-transparent transition-colors focus:ring-white/20"
              />
              <button
                onclick={() => matchCap = Infinity}
                class="rounded-lg bg-surface-hover px-2 py-1 text-xs font-medium text-primary transition-opacity hover:opacity-80"
              >All</button>
            </div>
            {#if unresolvedCounts.ignored > 0}
              <button
                onclick={() => showIgnored = !showIgnored}
                class="mt-1 text-sm font-medium text-muted transition-colors hover:text-primary"
              >{showIgnored ? 'Hide' : 'Show'} ignored ({unresolvedCounts.ignored})</button>
            {/if}
            {#if unresolvedCounts.matched > 0}
              <button
                onclick={() => showMatched = !showMatched}
                class="mt-1 text-sm font-medium text-muted transition-colors hover:text-primary"
              >{showMatched ? 'Hide' : 'Show'} matched ({unresolvedCounts.matched})</button>
            {/if}
            </div>
          {:else if unresolvedLoading}
            <p class="text-sm text-muted">Loading…</p>
          {:else}
            <p class="text-sm text-green-400">All tracks matched.</p>
          {/if}
        </section>

        {#if conflict}
          <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
            <div class="w-full max-w-sm rounded-xl bg-surface-raised p-4">
              <h4 class="mb-2 text-base font-medium text-primary">File already bound</h4>
              <p class="mb-3 text-sm text-muted">
                That file is already matched to <span class="text-primary">{conflict.conflictTitle}</span>. Binding it here will leave the other track unmatched.
              </p>
              <div class="flex justify-end gap-2">
                <button
                  onclick={() => conflict = null}
                  class="rounded-lg bg-surface-hover px-4 py-2 text-sm font-medium text-muted transition-opacity hover:opacity-80"
                >Cancel</button>
                <button
                  onclick={() => { if (conflict) doBind(conflict.trackId, conflict.path, true) }}
                  class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-80"
                >Bind anyway</button>
              </div>
            </div>
          </div>
        {/if}
      {/if}

      {#if tab === 'about'}
        <section class="px-4 py-6">
          <h3 class="mb-3 text-base font-medium text-primary">mmdrome</h3>
          <p class="text-sm text-muted">
            v{appVersion} ({commitHash}) &mdash; {new Date(buildTime).toLocaleString()}
          </p>
          <p class="mt-4 text-sm text-muted">
            A minimalist music player for your Navidrome / WebDAV library.
          </p>
        </section>
      {/if}
    </div>
  </div>
</div>

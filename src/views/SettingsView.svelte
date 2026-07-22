<script lang="ts">
  import { settings, updateSetting, webdavConnection, navidromeConnection, navidromeLoadStatus, setLibrary, initMetadataForTracks } from '../stores/appState'
  import { runManualWebDAVSync, testWebdavConn, connectNavidrome } from '../lib/syncEngine'
  import { navidromeSongToTrack } from '../lib/navidromeApi'
  import type { Track } from '../stores/appState'

  let webdavUrl = $state('')
  let webdavUser = $state('')
  let webdavToken = $state('')
  let navidromeUrl = $state('')
  let navidromeUser = $state('')
  let navidromePassword = $state('')
  let preloadTracks = $state(0)
  let crossfadeDuration = $state(0)
  let tapeMode = $state(false)
  let snapTolerance = $state(0.15)
  let syncing = $state(false)
  let syncResult = $state('')

  $effect(() => {
    const s = $settings
    webdavUrl = s.webdavUrl ?? ''
    webdavUser = s.webdavUser ?? ''
    webdavToken = s.webdavToken ?? ''
    navidromeUrl = s.navidromeUrl ?? ''
    navidromeUser = s.navidromeUser ?? ''
    navidromePassword = s.navidromePassword ?? ''
    preloadTracks = s.preloadTracks ?? 0
    crossfadeDuration = s.crossfadeDuration ?? 0
    tapeMode = s.tapeMode ?? false
    snapTolerance = s.snapTolerance ?? 0.15
  })

  function setPreload(val: number) {
    preloadTracks = val
    updateSetting('preloadTracks', val)
  }

  function setCrossfade(e: Event) {
    const val = Number((e.target as HTMLInputElement).value)
    crossfadeDuration = val
    updateSetting('crossfadeDuration', val)
  }

  function setTapeMode() {
    const val = !tapeMode
    tapeMode = val
    updateSetting('tapeMode', val)
  }

  function setSnapTolerance(e: Event) {
    const val = Number((e.target as HTMLInputElement).value)
    snapTolerance = val
    updateSetting('snapTolerance', val)
  }

  function updateField(field: 'webdavUrl' | 'webdavUser' | 'webdavToken' | 'navidromeUrl' | 'navidromeUser' | 'navidromePassword') {
    return (e: Event) => {
      const val = (e.target as HTMLInputElement).value
      if (field === 'webdavUrl') webdavUrl = val
      if (field === 'webdavUser') webdavUser = val
      if (field === 'webdavToken') webdavToken = val
      if (field === 'navidromeUrl') navidromeUrl = val
      if (field === 'navidromeUser') navidromeUser = val
      if (field === 'navidromePassword') navidromePassword = val
      updateSetting(field, val)
    }
  }

  async function testWebdav() {
    webdavConnection.set({ connected: false, checking: true })
    try {
      const result = await testWebdavConn()
      webdavConnection.set({ ...result, checking: false })
    } catch (err) {
      webdavConnection.set({ connected: false, error: err instanceof Error ? err.message : String(err), checking: false })
    }
  }

  async function connectNavidromeHandler() {
    navidromeConnection.set({ connected: false, checking: true })
    navidromeLoadStatus.set({ loading: true, loaded: 0, failed: 0 })
    try {
      const result = await connectNavidrome()
      navidromeConnection.set({ ...result.connection, checking: false })
      if (result.connection.connected) {
        const tracks: Track[] = result.songs.map(navidromeSongToTrack)
        setLibrary(tracks)
        initMetadataForTracks(tracks)

        navidromeLoadStatus.set({
          loading: false,
          loaded: result.loadResult.loaded,
          failed: result.loadResult.failed,
          error: result.loadResult.error,
        })
      } else {
        navidromeLoadStatus.set({ loading: false, loaded: 0, failed: 0, error: result.connection.error })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      navidromeConnection.set({ connected: false, error: msg, checking: false })
      navidromeLoadStatus.set({ loading: false, loaded: 0, failed: 0, error: msg })
    }
  }

  async function syncNow() {
    syncing = true
    syncResult = ''
    try {
      const result = await runManualWebDAVSync()
      syncResult = `Synced ${result.synced} track(s), ${result.failed} failed`
    } catch (err) {
      syncResult = `Sync failed: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      syncing = false
    }
  }
</script>

<div class="flex h-full flex-col">
  <div class="border-b border-white/10 px-4 py-3">
    <h2 class="text-xs font-medium uppercase tracking-wider text-muted">Settings</h2>
  </div>
  <div class="flex-1 overflow-y-auto pb-24">
    <div class="divide-y divide-white/10">
      <!-- Preload -->
      <section class="px-4 py-4">
        <h3 class="mb-3 text-sm font-medium text-primary">Preloading</h3>
        <p class="mb-2 text-xs text-muted">Number of upcoming tracks to preload</p>
        <div class="flex gap-2">
          {#each [0, 1, 2, 3, 5] as n}
            <button
              onclick={() => setPreload(n)}
              class="rounded-lg px-4 py-2 text-xs font-medium transition-colors"
              class:bg-primary={preloadTracks === n}
              class:text-background={preloadTracks === n}
              class:bg-surface-hover={preloadTracks !== n}
              class:text-muted={preloadTracks !== n}
            >{n === 0 ? 'Off' : n}</button>
          {/each}
        </div>
      </section>

      <!-- Crossfade -->
      <section class="px-4 py-4">
        <h3 class="mb-3 text-sm font-medium text-primary">Crossfade</h3>
        <div class="flex items-center gap-3">
          <input
            type="range"
            min="0"
            max="15"
            step="0.5"
            value={crossfadeDuration}
            oninput={setCrossfade}
            class="h-1 flex-1 accent-yellow-500"
          />
          <span class="w-10 text-right text-xs text-muted">{crossfadeDuration}s</span>
        </div>
      </section>

      <!-- Pitch / Speed -->
      <section class="px-4 py-4">
        <h3 class="mb-3 text-sm font-medium text-primary">Pitch & Speed</h3>
        <div class="space-y-3">
          <label class="flex cursor-pointer items-center gap-3">
            <input type="checkbox" checked={tapeMode} onchange={setTapeMode} class="accent-yellow-500" />
            <div>
              <p class="text-sm text-primary">Tape Mode</p>
              <p class="text-xs text-muted">Link pitch and speed changes together</p>
            </div>
          </label>
          <div>
            <p class="mb-1 text-xs text-muted">Snap tolerance: {snapTolerance.toFixed(2)}</p>
            <input
              type="range"
              min="0"
              max="0.5"
              step="0.01"
              value={snapTolerance}
              oninput={setSnapTolerance}
              class="h-1 w-full accent-yellow-500"
            />
          </div>
        </div>
      </section>

      <!-- WebDAV -->
      <section class="px-4 py-4">
        <h3 class="mb-3 text-sm font-medium text-primary">WebDAV Sync</h3>
        <p class="mb-2 text-xs text-muted">Requires CORS to be configured on the server.</p>
        <div class="space-y-3">
          <input
            type="url"
            placeholder="https://example.com/remote.php/dav/files/user/"
            value={webdavUrl}
            oninput={updateField('webdavUrl')}
            class="w-full rounded-lg bg-surface-hover px-4 py-2 text-sm text-primary placeholder-muted outline-none ring-1 ring-transparent transition-colors focus:ring-white/20"
          />
          <input
            type="text"
            placeholder="Username"
            value={webdavUser}
            oninput={updateField('webdavUser')}
            class="w-full rounded-lg bg-surface-hover px-4 py-2 text-sm text-primary placeholder-muted outline-none ring-1 ring-transparent transition-colors focus:ring-white/20"
          />
          <input
            type="password"
            placeholder="Password / Token"
            value={webdavToken}
            oninput={updateField('webdavToken')}
            class="w-full rounded-lg bg-surface-hover px-4 py-2 text-sm text-primary placeholder-muted outline-none ring-1 ring-transparent transition-colors focus:ring-white/20"
          />
          <div class="flex items-center gap-2">
            <button
              onclick={testWebdav}
              disabled={$webdavConnection.checking}
              class="flex items-center justify-center gap-2 rounded-lg bg-surface-hover px-4 py-2 text-xs font-medium text-primary transition-opacity hover:opacity-80 disabled:opacity-50"
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
              <span class="text-xs text-green-400">Connected</span>
            {:else if $webdavConnection.error}
              <span class="text-xs text-red-400">{$webdavConnection.error}</span>
            {/if}
          </div>
        </div>
      </section>

      <!-- Navidrome -->
      <section class="px-4 py-4">
        <h3 class="mb-3 text-sm font-medium text-primary">Navidrome</h3>
        <div class="space-y-3">
          <input
            type="url"
            placeholder="https://music.example.com"
            value={navidromeUrl}
            oninput={updateField('navidromeUrl')}
            class="w-full rounded-lg bg-surface-hover px-4 py-2 text-sm text-primary placeholder-muted outline-none ring-1 ring-transparent transition-colors focus:ring-white/20"
          />
          <input
            type="text"
            placeholder="Username"
            value={navidromeUser}
            oninput={updateField('navidromeUser')}
            class="w-full rounded-lg bg-surface-hover px-4 py-2 text-sm text-primary placeholder-muted outline-none ring-1 ring-transparent transition-colors focus:ring-white/20"
          />
          <input
            type="password"
            placeholder="Password"
            value={navidromePassword}
            oninput={updateField('navidromePassword')}
            class="w-full rounded-lg bg-surface-hover px-4 py-2 text-sm text-primary placeholder-muted outline-none ring-1 ring-transparent transition-colors focus:ring-white/20"
          />
          <button
            onclick={connectNavidromeHandler}
            disabled={$navidromeConnection.checking || $navidromeLoadStatus.loading}
            class="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-80 disabled:opacity-50"
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
            <p class="text-xs text-green-400">
              Connected{$navidromeConnection.serverVersion ? ' (' + $navidromeConnection.serverVersion + ')' : ''}
            </p>
          {:else if $navidromeConnection.error}
            <p class="text-xs text-red-400">{$navidromeConnection.error}</p>
          {/if}
          {#if $navidromeLoadStatus.loaded > 0 || $navidromeLoadStatus.error}
            <p class="text-xs text-muted">
              {$navidromeLoadStatus.error
                ? `Error: ${$navidromeLoadStatus.error}`
                : `Loaded ${$navidromeLoadStatus.loaded} song(s), ${$navidromeLoadStatus.failed} failed`}
            </p>
          {/if}

          <button
            onclick={syncNow}
            disabled={syncing}
            class="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-80 disabled:opacity-50"
          >
            {#if syncing}
              <svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Syncing…
            {:else}
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>
              Sync Now
            {/if}
          </button>
          {#if syncResult}
            <p class="text-xs text-muted">{syncResult}</p>
          {/if}
        </div>
      </section>
    </div>
  </div>
</div>

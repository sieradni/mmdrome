<script lang="ts">
  import { settings, updateSetting } from '../stores/appState'

  let webdavUrl = $state('')
  let webdavUser = $state('')
  let webdavToken = $state('')
  let preloadTracks = $state(0)
  let crossfadeDuration = $state(0)
  let tapeMode = $state(false)
  let snapTolerance = $state(0.15)
  let syncing = $state(false)

  $effect(() => {
    const s = $settings
    webdavUrl = s.webdavUrl ?? ''
    webdavUser = s.webdavUser ?? ''
    webdavToken = s.webdavToken ?? ''
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

  function updateWebdavField(field: 'webdavUrl' | 'webdavUser' | 'webdavToken') {
    return (e: Event) => {
      const val = (e.target as HTMLInputElement).value
      if (field === 'webdavUrl') webdavUrl = val
      if (field === 'webdavUser') webdavUser = val
      if (field === 'webdavToken') webdavToken = val
      updateSetting(field, val)
    }
  }

  async function syncNow() {
    syncing = true
    await new Promise(r => setTimeout(r, 1000))
    syncing = false
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
        <div class="space-y-3">
          <input
            type="url"
            placeholder="https://example.com/remote.php/dav/files/user/"
            value={webdavUrl}
            oninput={updateWebdavField('webdavUrl')}
            class="w-full rounded-lg bg-surface-hover px-4 py-2 text-sm text-primary placeholder-muted outline-none ring-1 ring-transparent transition-colors focus:ring-white/20"
          />
          <input
            type="text"
            placeholder="Username"
            value={webdavUser}
            oninput={updateWebdavField('webdavUser')}
            class="w-full rounded-lg bg-surface-hover px-4 py-2 text-sm text-primary placeholder-muted outline-none ring-1 ring-transparent transition-colors focus:ring-white/20"
          />
          <input
            type="password"
            placeholder="Password / Token"
            value={webdavToken}
            oninput={updateWebdavField('webdavToken')}
            class="w-full rounded-lg bg-surface-hover px-4 py-2 text-sm text-primary placeholder-muted outline-none ring-1 ring-transparent transition-colors focus:ring-white/20"
          />
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
        </div>
      </section>
    </div>
  </div>
</div>

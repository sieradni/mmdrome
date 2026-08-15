<script lang="ts">
  import { onMount } from 'svelte'
  import { Capacitor, SystemBars, SystemBarType, SystemBarsStyle } from '@capacitor/core'
  import { currentTrack, queue, playbackState, initStores, settings, navidromeConnection, navidromeLoadStatus, shuffleEnabled, currentTime, effectiveDuration, toggleShuffle, loopMode, sleepTimer } from './stores/appState'
  import { initEqStore } from './lib/eq/eqStore'
  import { sleepTimerManager } from './lib/sleepTimer'
  import { loadLibraryFromNavidrome } from './lib/syncEngine'
  import { setCachedConfig } from './lib/navidromeApi'
  import { playbackManager } from './lib/playbackManager'
  import { audioManager } from './lib/audioManager'
  import { engine } from './lib/engineFacade'
  import { getTagLib } from './lib/taglibSingleton'
  import SongsView from './views/SongsView.svelte'
  import AlbumsView from './views/AlbumsView.svelte'
  import ArtistsView from './views/ArtistsView.svelte'
  import SettingsView from './views/SettingsView.svelte'
  import QueueView from './views/QueueView.svelte'
  import TrackOptionsView from './views/TrackOptionsView.svelte'
  import PitchSpeedView from './views/PitchSpeedView.svelte'
  import EQView from './views/EQView.svelte'
  import VolumeView from './views/VolumeView.svelte'
  import DetailView from './views/DetailView.svelte'
  import LazyThumb from './components/LazyThumb.svelte'

  let nowPlayingOpen = $state(false)
  let queueOpen = $state(false)
  let overlay: 'trackOptions' | 'pitchSpeed' | 'eq' | 'volume' | 'detail' | null = $state(null)
  let searchQuery = $state('')
  let view = $state<'songs' | 'albums' | 'artists' | 'settings'>('songs')
  let initError = $state('')
  /** Set only after onMount's async boot chain resolves — the deterministic
   *  "ready" signal for the e2e smoke test (tests/e2e/smoke.spec.ts). Stays
   *  false on a boot failure, which the smoke test treats as a failed boot. */
  let appReady = $state(false)

  onMount(async () => {
    if (Capacitor.isNativePlatform()) {
      // Light status bar content over the app's dark chrome (dynamic island area).
      SystemBars.setStyle({ style: SystemBarsStyle.Dark, bar: SystemBarType.StatusBar }).catch(() => {})
    }
    try {
      await initStores()
    } catch (err) {
      initError = 'Failed to initialize local storage: ' + (err instanceof Error ? err.message : String(err))
      return
    }
    try {
      await initEqStore()
    } catch (err) {
      initError = 'Failed to initialize EQ settings: ' + (err instanceof Error ? err.message : String(err))
      return
    }

    const s = $settings
    if (s.navidromeUrl && s.navidromeUser && s.navidromePassword) {
      setCachedConfig({ baseUrl: s.navidromeUrl, username: s.navidromeUser, password: s.navidromePassword })
      navidromeConnection.set({ connected: false, checking: true })
      navidromeLoadStatus.set({ loading: true, loaded: 0, failed: 0 })
      try {
        // Shared pipeline: connect → library + metadata seeding → server
        // lastScan → automatic incremental WebDAV scan when configured.
        const result = await loadLibraryFromNavidrome()
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

    getTagLib()
    await playbackManager.init()

    if (navigator.storage?.persist) {
      navigator.storage.persist()
    }

    appReady = true
  })

  function toggleNowPlaying() {
    nowPlayingOpen = !nowPlayingOpen
    if (nowPlayingOpen) { queueOpen = false; overlay = null }
  }

  function openQueue() {
    queueOpen = true; nowPlayingOpen = false; overlay = null
  }

  function closeQueue() {
    queueOpen = false; nowPlayingOpen = true
  }

  function openTrackOptions() {
    overlay = 'trackOptions'
  }

  function closeAll() {
    nowPlayingOpen = false; overlay = null; queueOpen = false
  }

  function closeToNowPlaying() {
    overlay = null; nowPlayingOpen = true
  }

  function navigateTo(page: 'pitchSpeed' | 'eq' | 'volume' | 'detail' | 'settings') {
    if (page === 'settings') {
      view = 'settings'; closeAll()
    } else {
      overlay = page
    }
  }

  function formatTime(sec: number): string {
    if (!isFinite(sec) || sec < 0) return '0:00'
    const m = Math.floor(sec / 60)
    const s = Math.floor(sec % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  function toggleLoop() {
    loopMode.update((m) => m === 'none' ? 'one' : m === 'one' ? 'all' : 'none')
  }

  let volOpen = $state(false)
  let volValue = $state(engine.volume)

  function updateVolumePopover() {
    engine.setMasterVolume(volValue)
  }

  $effect(() => {
    if (!volOpen) return
    volValue = engine.volume
    function handler(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest('[data-volume-popover]')) volOpen = false
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  })

  let sleepOpen = $state(false)
  let sleepMinutes = $state(30)

  function toggleSleepPopover(e: MouseEvent) {
    e.stopPropagation()
    sleepMinutes = $sleepTimer.minutes || 30
    sleepOpen = !sleepOpen
    volOpen = false
  }

  function askSleepTimer() {
    sleepTimerManager.set('minutes', sleepMinutes, true)
    sleepOpen = false
  }

  function sleepEndOfTrack() {
    sleepTimerManager.set('endOfTrack', 0, true)
    sleepOpen = false
  }

  function cancelSleepTimer() {
    sleepTimerManager.set('minutes', sleepMinutes, false)
    sleepOpen = false
  }

  $effect(() => {
    if (!sleepOpen) return
    function handler(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest('[data-sleep-popover]')) sleepOpen = false
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  })

  let sleepDisplay = $derived.by(() => {
    const t = $sleepTimer
    if (!t.active) return ''
    if (t.mode === 'endOfTrack') return 'End of track'
    const m = Math.ceil(t.remainingSeconds / 60)
    return `${m} min`
  })

function seek(e: Event) {
     const t = parseFloat((e.target as HTMLInputElement).value)
     playbackManager.seek(t)
   }

  $effect(() => {
    if (Capacitor.isNativePlatform()) return
    const handler = () => currentTime.set(audioManager.playbackElement.currentTime)
    audioManager.a.addEventListener('timeupdate', handler)
    audioManager.b.addEventListener('timeupdate', handler)
    return () => {
      audioManager.a.removeEventListener('timeupdate', handler)
      audioManager.b.removeEventListener('timeupdate', handler)
    }
  })

  let sliderValue = $derived($currentTime)

  let sliderMax = $derived($effectiveDuration > 0 ? $effectiveDuration : 1)

  let queueSize = $derived($queue.userQueue.length)
  let queuePosition = $derived($queue.activeIndex >= 0 ? $queue.activeIndex + 1 : 0)

  const tabs: { id: typeof view; label: string; icon: string }[] = [
    { id: 'songs', label: 'Songs', icon: 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z' },
    { id: 'albums', label: 'Albums', icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z' },
    { id: 'artists', label: 'Artists', icon: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z' },
    { id: 'settings', label: 'Settings', icon: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z' },
  ]

  function miniPlayerTap() {
    if (nowPlayingOpen || overlay) { closeAll(); return }
    toggleNowPlaying()
  }
</script>

<div class="flex h-dvh flex-col bg-background text-primary safe-area-top safe-area-x" data-app-ready={appReady || undefined}>
  <!-- ─── Sticky Header ─── -->
  {#if view !== 'settings'}
    <header class="sticky top-0 z-30 flex flex-col bg-background">
      <div class="flex items-center gap-2 px-4 py-3">
        <div class="relative flex-1">
          <input
            type="search"
            placeholder="Fuzzy Search tracks, artists, albums…"
            bind:value={searchQuery}
            class="w-full rounded-lg bg-white/5 px-4 py-2 text-sm text-primary placeholder-muted outline-none ring-1 ring-white/10 transition-colors focus:ring-white/20"
          />
        </div>
      </div>
    </header>
  {/if}

  {#if initError}
    <div class="mx-4 mt-2 rounded-lg bg-red-900/40 px-4 py-3 text-xs text-red-300 ring-1 ring-red-800/50">
      {initError}
    </div>
  {/if}

  <!-- ─── Main View Container ─── -->
  <main class="flex min-h-0 flex-1 flex-col overflow-hidden">
    {#if view === 'songs'}
      <SongsView {searchQuery} />
    {:else if view === 'albums'}
      <AlbumsView {searchQuery} />
    {:else if view === 'artists'}
      <ArtistsView {searchQuery} />
    {:else if view === 'settings'}
      <SettingsView />
    {/if}
  </main>

  <!-- ─── Bottom Bar: Mini Player + Tab Nav ─── -->
  <div class="flex flex-col overflow-hidden">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      onclick={miniPlayerTap}
      role="button"
      tabindex="0"
      onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') miniPlayerTap(); }}
      class="flex cursor-pointer items-center gap-3 border-t border-white/10 bg-surface px-4 py-2.5 text-left transition-colors hover:bg-surface-hover"
    >
      {#if $currentTrack}
        <LazyThumb track={$currentTrack} wrapperClass="h-12 w-12 flex-shrink-0 rounded-md" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-base font-medium text-primary">{$currentTrack.title}</p>
          <p class="truncate text-sm text-muted">{$currentTrack.artist}</p>
        </div>
      {:else}
        <div class="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-md bg-surface-hover">
          <svg class="h-6 w-6 text-muted" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
        </div>
        <div class="min-w-0 flex-1">
          <p class="truncate text-base font-medium text-primary">Not playing</p>
          <p class="truncate text-sm text-muted">{queueSize > 0 ? `Track ${queuePosition} of ${queueSize} in queue` : 'Queue is empty'}</p>
        </div>
      {/if}
      <div class="flex flex-shrink-0 items-center gap-1">
        <button class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Previous track" onclick={(e) => { e.stopPropagation(); playbackManager.prev() }}>
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
        </button>
        <button class="rounded-full bg-primary p-2 text-background transition-colors hover:opacity-80" aria-label="Play / Pause" onclick={(e) => { e.stopPropagation(); playbackManager.togglePlayPause() }}>
          {#if $playbackState === 'playing'}
            <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>
          {:else}
            <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          {/if}
        </button>
        <button class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Next track" onclick={(e) => { e.stopPropagation(); playbackManager.next() }}>
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z"/></svg>
        </button>
      </div>
    </div>

    <nav class="flex border-t border-white/10 bg-surface safe-area-bottom">
      {#each tabs as tab (tab.id)}
        <button
          onclick={() => view = tab.id}
          class="flex flex-1 flex-col items-center gap-1 py-3 text-xs font-medium transition-colors"
          class:text-primary={view === tab.id}
          class:text-muted={view !== tab.id}
        >
          <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor">
            <path d={tab.icon} />
          </svg>
          <span>{tab.label}</span>
        </button>
      {/each}
    </nav>
  </div>
</div>

<!-- ─── Full-Screen Now Playing Overlay ─── -->
{#if nowPlayingOpen}
  <div class="fixed inset-0 z-40 flex flex-col bg-background safe-area-full">
    <!-- Header -->
    <div class="flex items-center justify-between px-4 py-3">
      <button onclick={toggleNowPlaying} class="rounded-full p-2.5 text-muted transition-colors hover:text-primary" aria-label="Close player">
        <svg class="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5m7-7-7 7 7 7"/></svg>
      </button>
      <span class="text-base font-medium text-muted">Now Playing</span>
      <button onclick={openQueue} class="rounded-full p-2.5 text-muted transition-colors hover:text-primary" aria-label="Open queue">
        <svg class="h-7 w-7" viewBox="0 0 24 24" fill="currentColor"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg>
      </button>
    </div>

    {#if $currentTrack}
      <!-- Album Art -->
      <div class="flex flex-1 items-center justify-center px-8">
        <div class="aspect-square w-full max-w-sm overflow-hidden rounded-2xl bg-surface-hover shadow-2xl">
          <LazyThumb track={$currentTrack} wrapperClass="h-full w-full" />
        </div>
      </div>

      <!-- Utility Row: Loop + Volume -->
      <div class="flex w-full items-center justify-end gap-1 px-6 pt-2">
        <button onclick={toggleLoop} class="rounded-full p-2 transition-colors hover:text-primary" class:text-primary={$loopMode !== 'none'} class:text-muted={$loopMode === 'none'} aria-label="Toggle loop">
          <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>
            {#if $loopMode === 'one'}
              <text x="12" y="16" text-anchor="middle" font-size="7" font-weight="bold" fill="currentColor">1</text>
            {:else if $loopMode === 'all'}
              <text x="12" y="16" text-anchor="middle" font-size="7" font-weight="bold" fill="currentColor">A</text>
            {/if}
          </svg>
        </button>
        <div class="relative" data-volume-popover>
          <button onclick={(e) => { e.stopPropagation(); volOpen = !volOpen }} class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Volume">
            <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
            </svg>
          </button>
          {#if volOpen}
            <div class="absolute bottom-full right-0 z-50 mb-2 flex flex-col items-center rounded-lg bg-surface px-3 py-3 shadow-xl ring-1 ring-white/10">
              <span class="mb-3 text-xs tabular-nums text-muted">{(volValue * 100).toFixed(0)}%</span>
              <div class="flex h-32 w-6 items-center justify-center">
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.01"
                  bind:value={volValue}
                  oninput={updateVolumePopover}
                  class="h-1 w-32 -rotate-90 cursor-pointer accent-white/80"
                />
              </div>
            </div>
          {/if}
        </div>
        <div class="relative" data-sleep-popover>
          <button onclick={toggleSleepPopover} class="rounded-full p-2 transition-colors hover:text-primary" class:text-primary={$sleepTimer.active} class:text-muted={!$sleepTimer.active} aria-label="Sleep timer">
            <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm.5 6a.5.5 0 011 0v4.25l3 1.8a.5.5 0 01-.25.93.5.5 0 01-.25-.07l-3.25-1.95a.5.5 0 01-.25-.43V8a.5.5 0 01.5-.5z"/>
            </svg>
          </button>
          {#if sleepOpen}
            <div class="absolute bottom-full right-0 z-50 mb-2 w-56 rounded-lg bg-surface p-3 shadow-xl ring-1 ring-white/10">
              <p class="mb-2 text-sm font-medium text-primary">Sleep Timer</p>
              {#if $sleepTimer.active}
                <p class="mb-2 text-sm text-muted">Active — {$sleepTimer.mode === 'endOfTrack' ? 'end of track' : sleepDisplay}</p>
              {/if}
              <div class="space-y-2">
                <div class="flex items-center gap-2">
                  <input
                    type="number"
                    min="1"
                    max="120"
                    bind:value={sleepMinutes}
                    class="w-20 rounded bg-surface-hover px-2 py-1.5 text-sm text-primary ring-1 ring-white/10 outline-none"
                  />
                  <span class="text-sm text-muted">minutes</span>
                  <button onclick={askSleepTimer} class="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-background hover:opacity-80">Start</button>
                </div>
                <div class="flex items-center gap-2">
                  <button onclick={sleepEndOfTrack} class="flex-1 rounded-lg bg-surface-hover px-3 py-1.5 text-sm font-medium text-primary hover:opacity-80">End of Track</button>
                  {#if $sleepTimer.active}
                    <button onclick={cancelSleepTimer} class="rounded-lg px-3 py-1.5 text-sm font-medium text-red-400 hover:bg-surface-hover">Cancel</button>
                  {/if}
                </div>
              </div>
            </div>
          {/if}
        </div>
      </div>

      <!-- Track Info -->
      <div class="w-full min-w-0 space-y-0.5 px-6 pt-2">
        <h2 class="truncate text-2xl font-bold text-primary">{$currentTrack.title}</h2>
        <p class="truncate text-base text-muted">{$currentTrack.artist}</p>
      </div>

      <!-- Seek Bar -->
      <div class="flex items-center gap-3 px-6 pt-4">
        <span class="w-10 text-right text-xs tabular-nums text-muted">{formatTime(sliderValue)}</span>
        <input
          type="range"
          min="0"
          max={sliderMax}
          value={sliderValue}
          oninput={seek}
          class="h-1 flex-1 accent-white/80 cursor-pointer"
          step="0.1"
        />
        <span class="w-10 text-xs tabular-nums text-muted">{formatTime($effectiveDuration)}</span>
      </div>
    {:else}
      <!-- Empty State -->
      <div class="flex flex-1 flex-col items-center justify-center gap-3 px-8">
        <div class="flex h-20 w-20 items-center justify-center rounded-full bg-surface-hover">
          <svg class="h-10 w-10 text-muted" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
        </div>
        <h2 class="text-xl font-bold text-primary">No track playing</h2>
        {#if queueSize > 0}
          <p class="text-sm text-muted">Track {queuePosition} of {queueSize} in queue — press Play to start</p>
        {:else}
          <p class="text-sm text-muted">Queue is empty — add songs to get started</p>
        {/if}
      </div>
    {/if}

    <!-- Controls -->
    <div class="flex items-center justify-center gap-3 px-6 pt-4">
      <button onclick={() => { toggleShuffle() }} class="rounded-full p-2.5 transition-colors hover:text-primary" class:text-primary={$shuffleEnabled} class:text-muted={!$shuffleEnabled} aria-label="Toggle shuffle">
        <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>
      </button>
      <button class="rounded-full p-2.5 text-muted transition-colors hover:text-primary" aria-label="Previous track" onclick={() => playbackManager.prev()}>
        <svg class="h-8 w-8" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
      </button>
      <button class="rounded-full bg-primary p-3.5 text-background transition-colors hover:opacity-80" aria-label="Play / Pause" onclick={() => playbackManager.togglePlayPause()}>
        {#if $playbackState === 'playing'}
          <svg class="h-9 w-9" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>
        {:else}
          <svg class="h-9 w-9" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        {/if}
      </button>
      <button class="rounded-full p-2.5 text-muted transition-colors hover:text-primary" aria-label="Next track" onclick={() => playbackManager.next()}>
        <svg class="h-8 w-8" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z"/></svg>
      </button>
      <button onclick={openTrackOptions} class="rounded-full p-2.5 text-muted transition-colors hover:text-primary" aria-label="Options">
        <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
      </button>
    </div>

    <div class="h-6"></div>
  </div>
{/if}

<!-- ─── Queue View ─── -->
{#if queueOpen}
  <div class="fixed inset-0 z-40 flex flex-col bg-background safe-area-full">
    <QueueView onclose={closeQueue} oncloseall={closeAll} />
  </div>
{/if}

<!-- ─── Track Options Overlay ─── -->
{#if overlay === 'trackOptions'}
  <div class="fixed inset-0 z-50 flex flex-col bg-background safe-area-full">
    <TrackOptionsView onclose={closeToNowPlaying} oncloseall={closeAll} onnavigate={navigateTo} />
  </div>
{/if}

<!-- ─── Pitch & Speed Overlay ─── -->
{#if overlay === 'pitchSpeed'}
  <div class="fixed inset-0 z-50 flex flex-col bg-background safe-area-full">
    <PitchSpeedView onback={() => overlay = 'trackOptions'} oncloseall={closeAll} />
  </div>
{/if}

<!-- ─── EQ Overlay ─── -->
{#if overlay === 'eq'}
  <div class="fixed inset-0 z-50 flex flex-col bg-background safe-area-full">
    <EQView onback={() => overlay = 'trackOptions'} oncloseall={closeAll} />
  </div>
{/if}

<!-- ─── Volume Overlay ─── -->
{#if overlay === 'volume'}
  <div class="fixed inset-0 z-50 flex flex-col bg-background safe-area-full">
    <VolumeView onback={() => overlay = 'trackOptions'} oncloseall={closeAll} />
  </div>
{/if}

<!-- ─── Detail Overlay ─── -->
{#if overlay === 'detail'}
  <div class="fixed inset-0 z-50 flex flex-col bg-background safe-area-full">
    <DetailView onback={() => overlay = 'trackOptions'} oncloseall={closeAll} />
  </div>
{/if}

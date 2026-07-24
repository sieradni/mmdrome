<script lang="ts">
  import { onMount } from 'svelte'
  import { currentTrack, queue, playbackState, initStores, settings, setLibrary, initMetadataForTracks, navidromeConnection, navidromeLoadStatus, shuffleEnabled, currentTime, playbackSpeed, toggleShuffle, metadataScanState } from './stores/appState'
  import { connectNavidrome } from './lib/syncEngine'
  import { navidromeSongToTrack, setCachedConfig } from './lib/navidromeApi'
  import { playbackManager } from './lib/playbackManager'
  import { audioManager } from './lib/audioManager'
  import { setWebdavCredentials, ensureIndex, scanAllNow, setServerLastScan, getWebdavConfigured } from './lib/metadataScanner'
  import { getTagLib } from './lib/taglibSingleton'
  import type { Track } from './stores/appState'
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

  onMount(async () => {
    await initStores()

    const s = $settings
    if (s.navidromeUrl && s.navidromeUser && s.navidromePassword) {
      setCachedConfig({ baseUrl: s.navidromeUrl, username: s.navidromeUser, password: s.navidromePassword })
    }

    if (s.navidromeUrl && s.navidromeUser && s.navidromePassword) {
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
          })

          if (result.lastScan) setServerLastScan(result.lastScan)

          const s2 = $settings
          if (s2.webdavUrl && s2.webdavUser && s2.webdavToken) {
            setWebdavCredentials(s2.webdavUrl, s2.webdavUser, s2.webdavToken)
            ensureIndex().then(() => scanAllNow(false))
          }
        } else {
          navidromeLoadStatus.set({ loading: false, loaded: 0, failed: 0, error: result.connection.error })
        }
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

  function seek(e: Event) {
    const el = e.target as HTMLInputElement
    const t = parseFloat(el.value)
    const realTime = $playbackSpeed > 0 ? t * $playbackSpeed : t
    audioManager.activeElement.currentTime = realTime
    currentTime.set(realTime)
  }

  $effect(() => {
    const handler = () => currentTime.set(audioManager.activeElement.currentTime)
    audioManager.a.addEventListener('timeupdate', handler)
    audioManager.b.addEventListener('timeupdate', handler)
    return () => {
      audioManager.a.removeEventListener('timeupdate', handler)
      audioManager.b.removeEventListener('timeupdate', handler)
    }
  })

  let duration = $state(0)
  let effectiveDuration = $derived($playbackSpeed > 0 ? duration / $playbackSpeed : duration)
  let sliderValue = $derived($playbackSpeed > 0 ? $currentTime / $playbackSpeed : $currentTime)
  let sliderMax = $derived(effectiveDuration || 1)

  $effect(() => {
    const handler = () => {
      duration = audioManager.activeElement.duration || 0
    }
    audioManager.a.addEventListener('durationchange', handler)
    audioManager.b.addEventListener('durationchange', handler)
    handler()
    return () => {
      audioManager.a.removeEventListener('durationchange', handler)
      audioManager.b.removeEventListener('durationchange', handler)
    }
  })

  let combinedQueue = $derived([...$queue.userQueue, ...$queue.autoQueue])
  let queueSize = $derived(combinedQueue.length)
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

<div class="grid h-dvh grid-rows-[auto_1fr_auto] bg-background text-primary safe-area-top">
  <!-- ─── Sticky Header ─── -->
  <header class="sticky top-0 z-30 flex flex-col bg-surface/95 backdrop-blur-lg">
    <div class="flex items-center gap-2 px-4 py-3">
      <div class="relative flex-1">
        <input
          type="search"
          placeholder="Fuzzy Search tracks, artists, albums…"
          bind:value={searchQuery}
          class="w-full rounded-lg bg-surface-hover px-4 py-2 text-sm text-primary placeholder-muted outline-none ring-1 ring-transparent transition-colors focus:ring-white/20"
        />
      </div>
    </div>
  </header>

  <!-- ─── Main View Container ─── -->
  <main class="flex flex-col overflow-hidden">
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
  <div class="flex flex-col">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      onclick={miniPlayerTap}
      role="button"
      tabindex="0"
      onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') miniPlayerTap(); }}
      class="flex cursor-pointer items-center gap-3 border-t border-white/10 bg-surface px-4 py-2.5 text-left transition-colors hover:bg-surface-hover"
    >
      {#if $currentTrack}
        <LazyThumb track={$currentTrack} wrapperClass="h-10 w-10 flex-shrink-0 rounded-md" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-primary">{$currentTrack.title}</p>
          <p class="truncate text-xs text-muted">{$currentTrack.artist}</p>
        </div>
      {:else}
        <div class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md bg-surface-hover">
          <svg class="h-5 w-5 text-muted" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
        </div>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-primary">Not playing</p>
          <p class="truncate text-xs text-muted">{queueSize > 0 ? `Track ${queuePosition} of ${queueSize} in queue` : 'Queue is empty'}</p>
        </div>
      {/if}
      <div class="flex flex-shrink-0 items-center gap-1">
        <button class="rounded-full p-1.5 text-muted transition-colors hover:text-primary" aria-label="Previous track" onclick={(e) => { e.stopPropagation(); playbackManager.prev() }}>
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
        </button>
        <button class="rounded-full bg-primary p-1.5 text-background transition-colors hover:opacity-80" aria-label="Play / Pause" onclick={(e) => { e.stopPropagation(); playbackManager.togglePlayPause() }}>
          {#if $playbackState === 'playing'}
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>
          {:else}
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          {/if}
        </button>
        <button class="rounded-full p-1.5 text-muted transition-colors hover:text-primary" aria-label="Next track" onclick={(e) => { e.stopPropagation(); playbackManager.next() }}>
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z"/></svg>
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
      <button onclick={toggleNowPlaying} class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Close player">
        <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5m7-7-7 7 7 7"/></svg>
      </button>
      <span class="text-sm font-medium text-muted">Now Playing</span>
      <button onclick={openQueue} class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Open queue">
        <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg>
      </button>
    </div>

    {#if $currentTrack}
      <!-- Album Art -->
      <div class="flex flex-1 items-center justify-center px-8">
        <div class="aspect-square w-full max-w-sm overflow-hidden rounded-2xl bg-surface-hover shadow-2xl">
          <LazyThumb track={$currentTrack} wrapperClass="h-full w-full" />
        </div>
      </div>

      <!-- Track Info -->
      <div class="space-y-0.5 px-6 pt-2">
        <h2 class="text-xl font-bold text-primary truncate">{$currentTrack.title}</h2>
        <p class="text-sm text-muted truncate">{$currentTrack.artist}</p>
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
        <span class="w-10 text-xs tabular-nums text-muted">{formatTime(effectiveDuration)}</span>
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
    <div class="flex items-center justify-center gap-6 px-6 pt-4">
      <button onclick={() => { toggleShuffle() }} class="rounded-full p-2 transition-colors hover:text-primary" class:text-primary={$shuffleEnabled} class:text-muted={!$shuffleEnabled} aria-label="Toggle shuffle">
        <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>
      </button>
      <button class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Previous track" onclick={() => playbackManager.prev()}>
        <svg class="h-8 w-8" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
      </button>
      <button class="rounded-full bg-primary p-3 text-background transition-colors hover:opacity-80" aria-label="Play / Pause" onclick={() => playbackManager.togglePlayPause()}>
        {#if $playbackState === 'playing'}
          <svg class="h-8 w-8" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>
        {:else}
          <svg class="h-8 w-8" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        {/if}
      </button>
      <button class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Next track" onclick={() => playbackManager.next()}>
        <svg class="h-8 w-8" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z"/></svg>
      </button>
      <button onclick={openTrackOptions} class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Options">
        <svg class="h-6 w-6" viewBox="0 0 24 24" fill="currentColor"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
      </button>
    </div>

    <div class="h-6"></div>
  </div>
{/if}

<!-- ─── Queue View ─── -->
{#if queueOpen}
  <div class="fixed inset-0 z-40 flex flex-col bg-background safe-area-full">
    <QueueView onclose={closeQueue} />
  </div>
{/if}

<!-- ─── Track Options Overlay ─── -->
{#if overlay === 'trackOptions'}
  <div class="fixed inset-0 z-50 flex flex-col bg-background safe-area-full">
    <TrackOptionsView onclose={closeToNowPlaying} onnavigate={navigateTo} />
  </div>
{/if}

<!-- ─── Pitch & Speed Overlay ─── -->
{#if overlay === 'pitchSpeed'}
  <div class="fixed inset-0 z-50 flex flex-col bg-background safe-area-full">
    <PitchSpeedView onback={() => overlay = 'trackOptions'} />
  </div>
{/if}

<!-- ─── EQ Overlay ─── -->
{#if overlay === 'eq'}
  <div class="fixed inset-0 z-50 flex flex-col bg-background safe-area-full">
    <EQView onback={() => overlay = 'trackOptions'} />
  </div>
{/if}

<!-- ─── Volume Overlay ─── -->
{#if overlay === 'volume'}
  <div class="fixed inset-0 z-50 flex flex-col bg-background safe-area-full">
    <VolumeView onback={() => overlay = 'trackOptions'} />
  </div>
{/if}

<!-- ─── Detail Overlay ─── -->
{#if overlay === 'detail'}
  <div class="fixed inset-0 z-50 flex flex-col bg-background safe-area-full">
    <DetailView onback={() => overlay = 'trackOptions'} />
  </div>
{/if}

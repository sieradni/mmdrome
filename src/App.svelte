<script lang="ts">
  import { onMount } from 'svelte'
  import { slide } from 'svelte/transition'
  import { currentTrack, playbackState, initStores } from './stores/appState'
  import SongsView from './views/SongsView.svelte'
  import AlbumsView from './views/AlbumsView.svelte'
  import ArtistsView from './views/ArtistsView.svelte'
  import SettingsView from './views/SettingsView.svelte'

  let nowPlayingOpen = $state(false)
  let searchQuery = $state('')
  let view = $state<'songs' | 'albums' | 'artists' | 'settings'>('songs')

  onMount(() => {
    initStores()
  })

  function toggleNowPlaying() {
    nowPlayingOpen = !nowPlayingOpen
  }

  const tabs: { id: typeof view; label: string; icon: string }[] = [
    { id: 'songs', label: 'Songs', icon: 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z' },
    { id: 'albums', label: 'Albums', icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z' },
    { id: 'artists', label: 'Artists', icon: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z' },
    { id: 'settings', label: 'Settings', icon: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z' },
  ]
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
    {#if $currentTrack}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        onclick={toggleNowPlaying}
        role="button"
        tabindex="0"
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleNowPlaying(); }}
        class="flex cursor-pointer items-center gap-3 border-t border-white/10 bg-surface px-4 py-2.5 text-left transition-colors hover:bg-surface-hover"
      >
        <div class="h-10 w-10 flex-shrink-0 rounded-md bg-surface-hover"></div>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-primary">{$currentTrack.title}</p>
          <p class="truncate text-xs text-muted">{$currentTrack.artist}</p>
        </div>
        <div class="flex flex-shrink-0 items-center gap-1">
          <button class="rounded-full p-1.5 text-muted transition-colors hover:text-primary" aria-label="Previous track" onclick={(e) => e.stopPropagation()}>
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
          </button>
          <button class="rounded-full bg-primary p-1.5 text-background transition-colors hover:opacity-80" aria-label="Play / Pause" onclick={(e) => e.stopPropagation()}>
            {#if $playbackState === 'playing'}
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>
            {:else}
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            {/if}
          </button>
          <button class="rounded-full p-1.5 text-muted transition-colors hover:text-primary" aria-label="Next track" onclick={(e) => e.stopPropagation()}>
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z"/></svg>
          </button>
        </div>
      </div>
    {/if}

    <nav class="flex border-t border-white/10 bg-surface safe-area-bottom">
      {#each tabs as tab (tab.id)}
        <button
          onclick={() => view = tab.id}
          class="flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-colors"
          class:text-primary={view === tab.id}
          class:text-muted={view !== tab.id}
        >
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
            <path d={tab.icon} />
          </svg>
          <span>{tab.label}</span>
        </button>
      {/each}
    </nav>
  </div>
</div>

<!-- ─── Full-Screen Now Playing Overlay ─── -->
{#if nowPlayingOpen && $currentTrack}
  <div
    transition:slide={{ duration: 300 }}
    class="fixed inset-0 z-40 flex flex-col bg-background safe-area-full"
  >
    <!-- Header -->
    <div class="flex items-center justify-between px-4 py-3">
      <button onclick={toggleNowPlaying} class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Close player">
        <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5m7-7-7 7 7 7"/></svg>
      </button>
      <span class="text-sm font-medium text-muted">Now Playing</span>
      <span class="w-10"></span>
    </div>

    <!-- Album Art -->
    <div class="flex flex-1 items-center justify-center px-8">
      <div class="aspect-square w-full max-w-sm rounded-2xl bg-surface-hover shadow-2xl"></div>
    </div>

    <!-- Track Info + Controls -->
    <div class="space-y-1 px-6 pb-10">
      <h2 class="text-xl font-bold text-primary">{$currentTrack.title}</h2>
      <p class="text-sm text-muted">{$currentTrack.artist}</p>
    </div>
  </div>
{/if}

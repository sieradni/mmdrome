<script lang="ts">
  import { onMount } from 'svelte'
  import { slide } from 'svelte/transition'
  import { currentTrack, playbackState, initStores } from './stores/appState'

  let filterPanelOpen = $state(false)
  let sortPanelOpen = $state(false)
  let nowPlayingOpen = $state(false)
  let searchQuery = $state('')

  onMount(() => {
    initStores()
  })

  function toggleFilterPanel() {
    filterPanelOpen = !filterPanelOpen
    if (filterPanelOpen) sortPanelOpen = false
  }

  function toggleSortPanel() {
    sortPanelOpen = !sortPanelOpen
    if (sortPanelOpen) filterPanelOpen = false
  }

  function toggleNowPlaying() {
    nowPlayingOpen = !nowPlayingOpen
  }
</script>

<div class="grid h-dvh grid-rows-[auto_1fr] bg-background text-primary safe-area-top">
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
      <button
        onclick={toggleFilterPanel}
        class="rounded-lg px-3 py-2 text-sm font-medium transition-colors"
        class:bg-surface-hover={filterPanelOpen}
        class:text-primary={filterPanelOpen}
        class:text-muted={!filterPanelOpen}
      >Filter</button>
      <button
        onclick={toggleSortPanel}
        class="rounded-lg px-3 py-2 text-sm font-medium transition-colors"
        class:bg-surface-hover={sortPanelOpen}
        class:text-primary={sortPanelOpen}
        class:text-muted={!sortPanelOpen}
      >Sort</button>
    </div>

    {#if filterPanelOpen}
      <div transition:slide={{ duration: 200 }} class="border-t border-white/10 px-4 pb-4 pt-2">
        <p class="text-sm text-muted">Filter panel — coming soon</p>
      </div>
    {/if}

    {#if sortPanelOpen}
      <div transition:slide={{ duration: 200 }} class="border-t border-white/10 px-4 pb-4 pt-2">
        <p class="text-sm text-muted">Sort panel — coming soon</p>
      </div>
    {/if}
  </header>

  <!-- ─── Main View Container ─── -->
  <main class="overflow-y-auto pb-24">
    <div class="px-4 py-6">
      {#if searchQuery}
        <p class="text-center text-sm text-muted">Results for “{searchQuery}”</p>
      {:else}
        <p class="text-center text-sm text-muted">Your music library</p>
      {/if}
      <!-- placeholder: infinite-scroll list views will be composed here -->
    </div>
  </main>
</div>

<!-- ─── Floating Bottom Playback Bar ─── -->
{#if $currentTrack}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    onclick={toggleNowPlaying}
    role="button"
    tabindex="0"
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleNowPlaying(); }}
    class="fixed bottom-0 left-0 right-0 z-20 flex cursor-pointer items-center gap-3 border-t border-white/10 bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-hover safe-area-bottom"
  >
    <!-- Album Art -->
      <div class="h-12 w-12 flex-shrink-0 rounded-md bg-surface-hover"></div>

    <!-- Track Info -->
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-medium text-primary">{$currentTrack.title}</p>
      <p class="truncate text-xs text-muted">{$currentTrack.artist}</p>
    </div>

    <!-- Playback Controls -->
    <div class="flex flex-shrink-0 items-center gap-1">
      <button class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Previous track" onclick={(e) => e.stopPropagation()}>
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
      </button>
      <button class="rounded-full bg-primary p-2 text-background transition-colors hover:opacity-80" aria-label="Play / Pause" onclick={(e) => e.stopPropagation()}>
        {#if $playbackState === 'playing'}
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>
        {:else}
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        {/if}
      </button>
      <button class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Next track" onclick={(e) => e.stopPropagation()}>
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z"/></svg>
      </button>
    </div>
  </div>
{/if}

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
      <!-- future: progress bar, volume, shuffle/repeat etc. -->
    </div>
  </div>
{/if}

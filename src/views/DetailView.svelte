<script lang="ts">
  import { currentTrack, metadataCache } from '../stores/appState'
  import LazyThumb from '../components/LazyThumb.svelte'

  let { onback }: { onback: () => void } = $props()

  function formatDate(ts?: number): string {
    if (ts == null) return '\u2014'
    return new Date(ts).toLocaleString()
  }

  function formatSize(bytes?: number): string {
    if (bytes == null) return '\u2014'
    const units = ['B', 'KB', 'MB', 'GB']
    let i = 0
    let s = bytes
    while (s >= 1024 && i < units.length - 1) { s /= 1024; i++ }
    return `${s.toFixed(1)} ${units[i]}`
  }
</script>

<div class="flex h-full flex-col bg-background">
  <div class="flex items-center gap-3 px-4 py-3">
    <button onclick={onback} class="rounded-full p-2 text-muted transition-colors hover:text-primary" aria-label="Back">
      <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5m7-7-7 7 7 7"/></svg>
    </button>
    <span class="text-sm font-medium text-primary">Details</span>
  </div>

  <div class="flex-1 overflow-y-auto px-4">
    {#if $currentTrack}
      <div class="flex flex-col items-center pt-2 pb-6">
        <div class="aspect-square w-40 overflow-hidden rounded-xl bg-surface-hover shadow-lg">
          <LazyThumb track={$currentTrack} wrapperClass="h-full w-full" />
        </div>
      </div>

      <div class="space-y-4">
        <div class="grid grid-cols-2 gap-x-4 gap-y-3">
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Title</p>
            <p class="truncate text-sm text-primary">{$currentTrack.title}</p>
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Artist</p>
            <p class="truncate text-sm text-primary">{$currentTrack.artist}</p>
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Album</p>
            <p class="truncate text-sm text-primary">{$currentTrack.album}</p>
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Composer</p>
            <p class="truncate text-sm text-primary">{$currentTrack.composer || '\u2014'}</p>
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Year</p>
            <p class="text-sm text-primary">{$currentTrack.year ?? '\u2014'}</p>
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Duration</p>
            <p class="text-sm text-primary">{Math.floor($currentTrack.duration / 60)}:{String($currentTrack.duration % 60).padStart(2, '0')}</p>
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Format</p>
            <p class="text-sm text-primary uppercase">{$currentTrack.fileType}</p>
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Bitrate</p>
            <p class="text-sm text-primary">{$currentTrack.bitrate != null ? `${$currentTrack.bitrate} kbps` : '\u2014'}</p>
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Size</p>
            <p class="text-sm text-primary">{formatSize($currentTrack.size)}</p>
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Created</p>
            <p class="text-sm text-primary">{formatDate($currentTrack.createdAt)}</p>
          </div>
        </div>

        {#if $currentTrack.filePath}
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">File Path</p>
            <p class="truncate text-xs text-muted/70">{$currentTrack.filePath}</p>
          </div>
        {/if}
      </div>
    {/if}

    <div class="h-8"></div>
  </div>
</div>

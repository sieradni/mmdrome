<script lang="ts">
  import { currentTrack, metadataCache } from '../stores/appState'
  import { get } from 'svelte/store'
  import { debugFetchTrackData, type DebugTrackData } from '../lib/debugTrackData'
  import LazyThumb from '../components/LazyThumb.svelte'

  let { onback }: { onback: () => void } = $props()

  let debugging = $state(false)
  let debugData: DebugTrackData | null = $state(null)
  let debugError: string | null = $state(null)

  async function handleDebug() {
    const track = get(currentTrack)
    if (!track) return
    debugging = true
    debugError = null
    try {
      debugData = await debugFetchTrackData(track.trackId)
    } catch (err) {
      debugError = (err as Error).message
    } finally {
      debugging = false
    }
  }

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

  function formatTime(sec: number): string {
    if (!isFinite(sec) || sec < 0) return '0:00'
    const m = Math.floor(sec / 60)
    const s = Math.floor(sec % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  function starSegments(rating: number): ('full' | 'half' | 'empty')[] {
    const sv = Math.min(5, rating / 20)
    const segs: ('full' | 'half' | 'empty')[] = []
    for (let i = 0; i < 5; i++) {
      const r = Math.max(0, Math.min(1, sv - i))
      if (r >= 0.75) segs.push('full')
      else if (r >= 0.25) segs.push('half')
      else segs.push('empty')
    }
    return segs
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
      {@const meta = $metadataCache.get($currentTrack.trackId)}
      {@const track = $currentTrack}
      <div class="flex flex-col items-center pt-2 pb-6">
        <div class="aspect-square w-40 overflow-hidden rounded-xl bg-surface-hover shadow-lg">
          <LazyThumb track={track} wrapperClass="h-full w-full" />
        </div>
      </div>

      <div class="space-y-4">
        <div class="grid grid-cols-2 gap-x-4 gap-y-3">
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Title</p>
            <p class="truncate text-sm text-primary">{track.title}</p>
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Artist</p>
            <p class="truncate text-sm text-primary">{track.artist}</p>
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Album Artist</p>
            <p class="truncate text-sm text-primary">{track.albumArtist || '\u2014'}</p>
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Album</p>
            <p class="truncate text-sm text-primary">{track.album}</p>
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Track #</p>
            <p class="text-sm text-primary">{track.trackNumber ?? '\u2014'}</p>
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Composer</p>
            <p class="truncate text-sm text-primary">{track.composer || '\u2014'}</p>
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Year</p>
            <p class="text-sm text-primary">{track.year ?? '\u2014'}</p>
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Rating</p>
            <div class="flex items-center gap-0.5">
              {#each starSegments(meta?.rating ?? 0) as seg}
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24">
                  <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26Z" fill={seg === 'full' ? '#facc15' : seg === 'half' ? '#facc15' : 'none'} stroke={seg === 'empty' ? '#555' : '#facc15'} stroke-width="1"/>
                </svg>
              {/each}
              <span class="ml-1 text-xs text-muted">{meta?.rating ?? 0}</span>
            </div>
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Loved</p>
            {#if meta?.loved}
              <svg class="h-5 w-5 text-red-400" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
            {:else}
              <svg class="h-5 w-5 text-muted/50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
            {/if}
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Duration</p>
            <p class="text-sm text-primary">{formatTime(track.duration)}</p>
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Format</p>
            <p class="text-sm text-primary uppercase">{track.fileType}</p>
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Bitrate</p>
            <p class="text-sm text-primary">{track.bitrate != null ? `${track.bitrate} kbps` : '\u2014'}</p>
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Size</p>
            <p class="text-sm text-primary">{formatSize(track.size)}</p>
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Track Gain</p>
            <p class="text-sm text-primary">{track.replayGain != null ? `${track.replayGain} dB` : '\u2014'}</p>
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Album Gain</p>
            <p class="text-sm text-primary">{track.albumReplayGain != null ? `${track.albumReplayGain} dB` : '\u2014'}</p>
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Play Count</p>
            <p class="text-sm text-primary">{meta?.playCount ?? 0}</p>
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Skip Count</p>
            <p class="text-sm text-primary">{meta?.skipCount ?? 0}</p>
          </div>
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Created</p>
            <p class="text-sm text-primary">{formatDate(track.createdAt)}</p>
          </div>
        </div>

        {#if track.comments}
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Comments</p>
            <p class="text-sm text-primary whitespace-pre-wrap">{track.comments}</p>
          </div>
        {/if}

        {#if meta?.comments}
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">File Comments</p>
            <p class="text-sm text-primary whitespace-pre-wrap">{meta.comments}</p>
          </div>
        {/if}

        {#if track.trackId}
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Navidrome ID</p>
            <p class="truncate text-xs text-muted/70">{track.trackId.replace(/^navidrome-/, '')}</p>
          </div>
        {/if}
      </div>

      <div class="px-4 pb-4">
        <button
          onclick={handleDebug}
          disabled={debugging}
          class="flex w-full items-center justify-center gap-2 rounded-lg bg-surface-hover px-3 py-2 text-sm text-muted transition-colors hover:text-primary disabled:opacity-50"
        >
          {#if debugging}
            <svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" opacity="0.25"></circle>
              <path d="M12 2v4m0 12v4M4 12h4m12 0h4" opacity="0.25"></path>
            </svg>
            Fetching...
          {:else}
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2l3 7h7l-5.5 4 2 7-5.5-4-5.5 4 2-7-5.5-4h7z"></path>
            </svg>
            Debug Track Data
          {/if}
        </button>
      </div>

      {#if debugError}
        <div class="px-4 pb-4">
          <pre class="text-xs text-red-400 whitespace-pre-wrap">{debugError}</pre>
        </div>
      {/if}

      {#if debugData}
        <div class="px-4 pb-4 space-y-4">
          {#if debugData.navidromeError}
            <div>
              <p class="text-[10px] font-medium text-red-400 uppercase tracking-wider">Navidrome Error</p>
              <pre class="text-xs text-red-400 whitespace-pre-wrap">{debugData.navidromeError}</pre>
            </div>
          {:else if debugData.navidromeSong}
            <div>
              <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Navidrome Song (replayGain focus)</p>
              <pre class="text-xs text-primary whitespace-pre-wrap">{JSON.stringify({
                id: debugData.navidromeSong.id,
                title: debugData.navidromeSong.title,
                artist: debugData.navidromeSong.artist,
                album: debugData.navidromeSong.album,
                path: debugData.navidromeSong.path,
                replayGain: debugData.navidromeSong.replayGain,
              }, null, 2)}</pre>
            </div>
          {/if}

          {#if debugData.webdavMatchError}
            <div>
              <p class="text-[10px] font-medium text-red-400 uppercase tracking-wider">WebDAV Match Error</p>
              <pre class="text-xs text-red-400 whitespace-pre-wrap">{debugData.webdavMatchError}</pre>
            </div>
          {:else if debugData.webdavMatch}
            <div>
              <p class="text-[10px] font-medium text-muted uppercase tracking-wider">WebDAV Match</p>
              <pre class="text-xs text-primary whitespace-pre-wrap">{JSON.stringify(debugData.webdavMatch, null, 2)}</pre>
            </div>
          {/if}

          {#if debugData.webdavMetadataError}
            <div>
              <p class="text-[10px] font-medium text-red-400 uppercase tracking-wider">WebDAV Metadata Error</p>
              <pre class="text-xs text-red-400 whitespace-pre-wrap">{debugData.webdavMetadataError}</pre>
            </div>
          {:else if debugData.webdavRawMetadata}
            <div>
              <p class="text-[10px] font-medium text-muted uppercase tracking-wider">WebDAV Raw Tags</p>
              <pre class="text-xs text-primary whitespace-pre-wrap">{JSON.stringify(debugData.webdavRawMetadata, null, 2)}</pre>
            </div>
          {/if}

          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Cached Metadata</p>
            <pre class="text-xs text-primary whitespace-pre-wrap">{JSON.stringify(debugData.cachedMeta, null, 2)}</pre>
          </div>
        </div>
      {/if}
    {/if}

    <div class="h-8"></div>
  </div>
</div>

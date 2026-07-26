<script lang="ts">
  import type { Track } from '../stores/appState'
  import type { LocalMetadataStore } from '../lib/db'
  import { debugFetchTrackData, type DebugTrackData } from '../lib/debugTrackData'

  let { track, meta }: { track: Track; meta?: LocalMetadataStore | undefined } = $props()

  let technicalOpen = $state(false)
  let technicalLoading = $state(false)
  let technicalData: DebugTrackData | null = $state(null)
  let technicalError: string | null = $state(null)

  async function toggleTechnical() {
    if (technicalOpen) {
      technicalOpen = false
      return
    }
    technicalOpen = true
    if (technicalData || technicalError) return

    technicalLoading = true
    technicalError = null
    try {
      technicalData = await debugFetchTrackData(track.trackId)
    } catch (err) {
      technicalError = (err as Error).message
    } finally {
      technicalLoading = false
    }
  }

  function formatSize(bytes?: number): string {
    if (bytes == null) return '\u2014'
    const units = ['B', 'KB', 'MB', 'GB']
    let i = 0
    let s = bytes
    while (s >= 1024 && i < units.length - 1) { s /= 1024; i++ }
    return `${s.toFixed(1)} ${units[i]}`
  }

  function formatDate(ts?: number): string {
    if (ts == null) return '\u2014'
    return new Date(ts).toLocaleString()
  }

  function formatTime(sec: number): string {
    if (!isFinite(sec) || sec < 0) return '0:00'
    const m = Math.floor(sec / 60)
    const s = Math.floor(sec % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  function formatReplayGain(rg: unknown): string {
    if (rg == null) return '\u2014'
    if (typeof rg === 'object') {
      const g = rg as { trackGain?: number; albumGain?: number }
      const parts: string[] = []
      if (g.trackGain != null) parts.push(`track: ${g.trackGain} dB`)
      if (g.albumGain != null) parts.push(`album: ${g.albumGain} dB`)
      return parts.join(', ') || '\u2014'
    }
    return String(rg)
  }

  function visibleEntries(obj: Record<string, unknown> | null | undefined): [string, unknown][] {
    if (!obj) return []
    return Object.entries(obj).filter(([, v]) => v != null && v !== '')
  }

  function formatValue(value: unknown): string {
    if (value == null) return '\u2014'
    if (typeof value === 'string') return value
    if (typeof value === 'number') return String(value)
    if (typeof value === 'boolean') return value ? 'Yes' : 'No'
    if (Array.isArray(value)) {
      if (value.length === 0) return '\u2014'
      return value.map(v => formatValue(v)).join(', ')
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v != null && v !== '')
      if (entries.length === 0) return '\u2014'
      return entries.map(([k, v]) => `${k}: ${formatValue(v)}`).join(', ')
    }
    return String(value)
  }
</script>

<div class="space-y-4">
  <div class="grid grid-cols-2 gap-x-4 gap-y-3">
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
      <p class="text-sm text-primary">{meta?.playCount ?? track.playCount ?? 0}</p>
    </div>
    <div>
      <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Skip Count</p>
      <p class="text-sm text-primary">{meta?.skipCount ?? track.skipCount ?? 0}</p>
    </div>
    <div>
      <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Created</p>
      <p class="text-sm text-primary">{formatDate(track.createdAt)}</p>
    </div>
    <div>
      <p class="text-[10px] font-medium text-muted uppercase tracking-wider">Modified</p>
      <p class="text-sm text-primary">{formatDate(track.modifiedAt)}</p>
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

  <!-- Technical Info -->
  <div class="border-t border-white/10 pt-4">
    <button
      onclick={toggleTechnical}
      class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-hover"
    >
      <svg
        class="h-4 w-4 transition-transform"
        class:rotate-90={technicalOpen}
        viewBox="0 0 24 24"
        fill="currentColor"
      >
        <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
      </svg>
      <span>Technical Info</span>
      {#if technicalLoading}
        <svg class="ml-auto h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10" opacity="0.25"></circle>
          <path d="M12 2v4m0 12v4M4 12h4m12 0h4" opacity="0.25"></path>
        </svg>
      {/if}
    </button>

    {#if technicalOpen}
      <div class="mt-3 space-y-4 px-1 pb-2">
        {#if technicalLoading}
          <p class="text-xs text-muted animate-pulse">Loading technical data...</p>
        {:else if technicalError}
          <div>
            <p class="text-[10px] font-medium text-red-400 uppercase tracking-wider">Error</p>
            <p class="text-xs text-red-400">{technicalError}</p>
          </div>
        {:else if technicalData}
          <!-- Navidrome Song -->
          {#if technicalData.navidromeSong}
            <div>
              <p class="text-[10px] font-medium text-muted uppercase tracking-wider mb-1">Navidrome Song</p>
              <div class="rounded-lg bg-surface-hover px-3 py-2 max-h-56 overflow-y-auto">
                {#each visibleEntries(technicalData.navidromeSong as unknown as Record<string, unknown>) as [key, value]}
                  <div class="flex items-start gap-2 py-0.5">
                    <span class="text-xs text-muted shrink-0 capitalize">{key.replace(/([A-Z])/g, ' $1').trim()}:</span>
                    <span class="text-xs text-primary break-all">{key === 'replayGain' ? formatReplayGain(value) : formatValue(value)}</span>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
          {#if technicalData.navidromeError}
            <div>
              <p class="text-[10px] font-medium text-red-400 uppercase tracking-wider">Navidrome Error</p>
              <p class="text-xs text-red-400">{technicalData.navidromeError}</p>
            </div>
          {/if}

          <!-- WebDAV Match -->
          {#if technicalData.webdavMatch}
            <div>
              <p class="text-[10px] font-medium text-muted uppercase tracking-wider mb-1">WebDAV File</p>
              <div class="rounded-lg bg-surface-hover px-3 py-2">
                {#each visibleEntries(technicalData.webdavMatch as unknown as Record<string, unknown>) as [key, value]}
                  <div class="flex items-start gap-2 py-0.5">
                    <span class="text-xs text-muted shrink-0 capitalize">{key}:</span>
                    <span class="text-xs text-primary break-all">{key === 'size' ? formatSize(Number(value)) : formatValue(value)}</span>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
          {#if technicalData.webdavMatchError}
            <div>
              <p class="text-[10px] font-medium text-red-400 uppercase tracking-wider">WebDAV Match Error</p>
              <p class="text-xs text-red-400">{technicalData.webdavMatchError}</p>
            </div>
          {/if}

          <!-- Raw Tags -->
          {#if technicalData.webdavRawMetadata}
            <div>
              <p class="text-[10px] font-medium text-muted uppercase tracking-wider mb-1">Raw File Tags</p>
              <div class="rounded-lg bg-surface-hover px-3 py-2 max-h-48 overflow-y-auto">
                {#each visibleEntries(technicalData.webdavRawMetadata) as [key, value]}
                  <div class="flex items-start gap-2 py-0.5">
                    <span class="text-xs text-muted shrink-0">{key}:</span>
                    <span class="text-xs text-primary break-all">{formatValue(value)}</span>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
          {#if technicalData.webdavMetadataError}
            <div>
              <p class="text-[10px] font-medium text-red-400 uppercase tracking-wider">WebDAV Metadata Error</p>
              <p class="text-xs text-red-400">{technicalData.webdavMetadataError}</p>
            </div>
          {/if}

          <!-- Cached Metadata -->
          <div>
            <p class="text-[10px] font-medium text-muted uppercase tracking-wider mb-1">Cached Metadata</p>
            {#if technicalData.cachedMeta}
              <div class="rounded-lg bg-surface-hover px-3 py-2">
                {#each visibleEntries(technicalData.cachedMeta as unknown as Record<string, unknown>) as [key, value]}
                  <div class="flex items-start gap-2 py-0.5">
                    <span class="text-xs text-muted shrink-0">{key.replace(/([A-Z])/g, ' $1').trim()}:</span>
                    <span class="text-xs text-primary break-all">{formatValue(value)}</span>
                  </div>
                {/each}
              </div>
            {:else}
              <p class="text-xs text-muted/60">No cached metadata stored locally</p>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

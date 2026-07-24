import { buildCoverArtUrl, resolveCoverArtId, type NavidromeConfig } from './navidromeApi'
import type { Track } from '../stores/appState'

const urlCache = new Map<string, string>()

export function getCoverUrl(track: Track, config: NavidromeConfig, size?: number): string {
  const key = track.trackId + '-' + (size ?? 'original')
  let url = urlCache.get(key)
  if (!url) {
    const artId = resolveCoverArtId(track) || track.albumId
    if (!artId) return ''
    url = buildCoverArtUrl(config, artId, size)
    urlCache.set(key, url)
  }
  return url
}

export function clearCoverCache(): void {
  urlCache.clear()
}

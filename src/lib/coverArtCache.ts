import { buildCoverArtUrl, resolveCoverArtId, type NavidromeConfig } from './navidromeApi'
import type { Track } from '../stores/appState'

const urlCache = new Map<string, string>()

export function getCoverUrl(track: Track, config: NavidromeConfig, size?: number): string {
  // Key on the full config too: auth token/salt and baseUrl are baked into the
  // URL, so switching servers or credentials must not reuse stale cached URLs.
  const cfgKey = `${config.baseUrl}|${config.username}|${config.password}`
  const key = `${cfgKey}|${track.trackId}-${size ?? 'original'}`
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

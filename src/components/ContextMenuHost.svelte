<script lang="ts">
  import { get } from 'svelte/store'
  import ContextMenu from './ContextMenu.svelte'
  import {
    contextMenuRequest,
    closeContextMenu,
    type ContextMenuTarget,
  } from '../lib/contextMenuStore'
  import { buildGroupMenu, buildTrackMenu, type ContextMenuEntry } from '../lib/contextMenuCore'
  import { currentTrack, metadataCache, playbackState, queue } from '../stores/appState'
  import type { Track } from '../stores/appState'
  import { commitFeedback } from '../lib/feedbackService'
  import { queueManager } from '../lib/queueManager'
  import { playbackManager } from '../lib/playbackManager'
  // Shared row commands — the same functions the row buttons use.
  import {
    playLibraryTrack,
    playQueueIndex,
    removeUserQueueIndex,
    resolveQueueEntryIndex,
    restartOrResumeCurrent,
  } from '../lib/queueCommands'

  /**
   * The single mount point for the custom context menu (2026-11-04).
   *
   * Surfaces publish a `ContextMenuTarget`; this host turns it into the shared
   * menu model and executes the chosen command. Keeping EXECUTION here means
   * every surface gets identical semantics and the menu can never drift from
   * the row buttons: queue removal/playback go through `queueCommands` (the
   * row's own functions), feedback goes through `commitFeedback` (the single
   * rating/loved commit path, D6), and group playback reuses `playAll`'s
   * validated import.
   *
   * Execution is deferred one tick after closing: the menu must restore focus
   * to its trigger BEFORE a details dialog captures that focus as its return
   * target, and the close must be committed before the dialog opens (otherwise
   * the dialog would be mounted underneath a still-open menu).
   */

  let request = $derived($contextMenuRequest)

  let menu = $derived.by((): { label: string; entries: ContextMenuEntry[] } | null => {
    const req = request
    if (!req) return null
    const target = req.target

    if (target.kind === 'album' || target.kind === 'artist') {
      return {
        label: target.kind === 'album' ? 'Album actions' : 'Artist actions',
        entries: buildGroupMenu({
          kind: target.kind,
          name: target.kind === 'album' ? target.album : target.artist,
          trackCount: target.tracks.length,
        }),
      }
    }

    const track = target.track
    const meta = $metadataCache.get(track.trackId)
    const audible = $currentTrack?.trackId === track.trackId && $playbackState !== 'stopped'
    return {
      label: 'Track actions',
      entries: buildTrackMenu({
        title: track.title,
        subtitle: track.artist,
        isAudible: audible,
        isPlaying: $playbackState === 'playing' || $playbackState === 'buffering',
        loved: meta?.loved ?? false,
        rating: meta?.rating ?? 0,
        queueRow: target.kind === 'queue' ? target.section : undefined,
        canShowDetails: Boolean(target.onDetails),
      }),
    }
  })

  function select(id: string): void {
    const req = request
    if (!req) return
    closeContextMenu()
    const target = req.target
    // One macrotask: Svelte commits the close (and the focus restore) first.
    window.setTimeout(() => execute(id, target), 0)
  }

  function execute(id: string, target: ContextMenuTarget): void {
    if (target.kind === 'album' || target.kind === 'artist') {
      const ids = target.tracks.map((t) => t.trackId)
      if (id === 'play') {
        if (target.onPlayAll) target.onPlayAll()
        else playGroup(ids)
      } else if (id === 'playNext') {
        queueManager.playNextMany(ids)
      } else if (id === 'addToQueue') {
        queueManager.addManyToUserQueue(ids)
      }
      return
    }

    const track = target.track
    if (id === 'details') {
      target.onDetails?.()
      return
    }
    if (id === 'love') {
      toggleLoved(track)
      return
    }
    if (id.startsWith('rate:')) {
      setRating(track, Number(id.slice('rate:'.length)))
      return
    }
    if (id === 'play') {
      const state = get(playbackState)
      if (target.kind === 'queue') {
        const index = resolveQueueEntryIndex(target.entryId)
        if (index < 0) return
        // OCCURRENCE identity, not id equality: another copy of the same song
        // in the queue is not the audible row.
        const isAudible =
          index === get(queue).activeIndex &&
          get(currentTrack)?.trackId === track.trackId &&
          state !== 'stopped'
        if (isAudible) restartOrResumeCurrent()
        else playQueueIndex(index)
        return
      }
      const isAudible =
        get(currentTrack)?.trackId === track.trackId && state !== 'stopped'
      if (isAudible) restartOrResumeCurrent()
      else if (target.onPlay) target.onPlay()
      else playLibraryTrack(track.trackId)
      return
    }
    if (id === 'playNext') {
      queueManager.playNext(track.trackId)
      return
    }
    if (id === 'addToQueue') {
      queueManager.addToUserQueue(track.trackId)
      return
    }

    if (target.kind !== 'queue') return
    const index = resolveQueueEntryIndex(target.entryId)
    if (index < 0) return
    const q = get(queue)
    const inUser = index < q.userQueue.length
    const autoIndex = index - q.userQueue.length

    if (id === 'moveNext') {
      if (inUser) queueManager.moveRowToNext(index)
      else queueManager.promoteToUserNext(autoIndex)
    } else if (id === 'moveEnd') {
      if (inUser) queueManager.moveRowToEnd(index)
      else queueManager.promoteToUser(autoIndex)
    } else if (id === 'addToEnd') {
      if (!inUser) queueManager.promoteToUser(autoIndex)
    } else if (id === 'notNow') {
      if (!inUser) queueManager.removeFromAutoQueue(autoIndex)
    } else if (id === 'removeRow') {
      if (inUser) removeUserQueueIndex(index)
    }
  }

  function playGroup(trackIds: string[]): void {
    const report = queueManager.playAll(trackIds)
    if (report.deferred || report.accepted.length === 0) return
    void playbackManager.playTrackAt(0)
  }

  function toggleLoved(track: Track): void {
    const meta = get(metadataCache).get(track.trackId)
    commitFeedback(track, meta?.rating ?? 0, !(meta?.loved ?? false))
  }

  function setRating(track: Track, rating: number): void {
    const meta = get(metadataCache).get(track.trackId)
    commitFeedback(track, rating, meta?.loved ?? false)
  }
</script>

{#if request && menu}
  {#key request}
    <ContextMenu
      entries={menu.entries}
      label={menu.label}
      x={request.x}
      y={request.y}
      trigger={request.trigger}
      onselect={select}
      onclose={closeContextMenu}
    />
  {/key}
{/if}

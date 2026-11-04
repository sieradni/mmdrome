import { writable } from 'svelte/store'
import type { Track } from '../stores/appState'

/**
 * The context menu's open REQUEST (2026-11-04). Surfaces describe WHAT was
 * targeted and where the gesture happened; the single `ContextMenuHost` in
 * `App.svelte` owns the menu itself. That is what guarantees only one menu can
 * be open at a time and that every surface shares one dismissal/focus
 * contract.
 *
 * `onDetails`/`onPlay`/`onPlayAll` are surface-owned callbacks: the details
 * dialog and the album/artist auto-queue scope live in the view, so the menu
 * must invoke the view's action rather than duplicate its state. Commands with
 * no callback fall back to the shared defaults in `queueCommands.ts`.
 */
export type ContextMenuTarget =
  | {
      kind: 'track'
      track: Track
      onDetails?: () => void
      /** Surface-specific press semantics (detail views scope the auto queue
       *  to the album/artist; a library row clears the scope). */
      onPlay?: () => void
    }
  | {
      kind: 'queue'
      track: Track
      /** Occurrence identity (`user:<id>`, `auto:<id>#<n>`) — never a bare id
       *  and never an index, both of which go stale while the menu is open. */
      entryId: string
      section: 'user' | 'auto'
      onDetails?: () => void
    }
  | {
      kind: 'album'
      album: string
      tracks: Track[]
      onPlayAll?: () => void
    }
  | {
      kind: 'artist'
      artist: string
      tracks: Track[]
      onPlayAll?: () => void
    }

export interface ContextMenuRequest {
  target: ContextMenuTarget
  /** Viewport coordinates of the gesture (right-click, long-press, or the
   *  trigger's centre for a keyboard invocation). */
  x: number
  y: number
  /** The element that opened the menu — focus returns here on close. */
  trigger: HTMLElement | null
}

export const contextMenuRequest = writable<ContextMenuRequest | null>(null)

export function openContextMenu(request: ContextMenuRequest): void {
  contextMenuRequest.set(request)
}

export function closeContextMenu(): void {
  contextMenuRequest.set(null)
}

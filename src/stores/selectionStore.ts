import { writable } from 'svelte/store'
import {
  beginSelection,
  clearedSelection,
  emptySelection,
  planSelectAll,
  planSelectionClick,
  setSelectionOrder,
  type SelectionClickModifiers,
  type SelectionState,
  type SelectionSurface,
} from '../lib/selectionCore'

/**
 * The ONE multi-select store (2026-11-04). Session-only: a selection is a
 * transient interaction state, never persisted — a relaunch must not resurrect
 * a set of rows the user no longer sees.
 *
 * There is deliberately a single state (one surface at a time): the library and
 * the queue are different row identities (`trackId` vs occurrence entry id), so
 * mixing them would make every action ambiguous. Opening a selection on the
 * other surface replaces it.
 */
export const selection = writable<SelectionState>(emptySelection())

/** Publishes a surface's ordered keys; prunes keys the surface lost. Views
 *  call this from an effect over their visible/filtered order. */
export function syncSelectionOrder(surface: SelectionSurface, order: readonly string[]): void {
  selection.update((state) => setSelectionOrder(state, surface, order))
}

export function selectionClick(
  surface: SelectionSurface,
  key: string,
  modifiers: SelectionClickModifiers = {},
): void {
  selection.update((state) => planSelectionClick(state, surface, key, modifiers))
}

export function startSelection(surface: SelectionSurface, key: string): void {
  selection.update((state) => beginSelection(state, surface, key))
}

export function toggleSelection(surface: SelectionSurface, key: string): void {
  selection.update((state) => planSelectionClick(state, surface, key, { toggle: true }))
}

export function selectAllInSurface(surface: SelectionSurface): void {
  selection.update((state) => planSelectAll(state, surface))
}

export function clearSelection(): void {
  selection.update((state) => clearedSelection(state))
}
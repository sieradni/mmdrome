<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import {
    CONTEXT_MENU_ICONS,
    menuNavigableIds,
    placeContextMenu,
    placeSubmenu,
    stepMenuId,
    type ContextMenuEntry,
    type ContextMenuSubmenu,
  } from '../lib/contextMenuCore'
  import { armClickSwallow } from '../lib/clickSwallow'

  /**
   * The app's ONE context menu primitive (2026-11-04).
   *
   * Deliberately NOT a native <dialog>: a menu is a transient popover, not a
   * modal surface — it must not make the page inert or trap focus the way
   * ModalShell does. Instead it owns exactly what a menu needs:
   *  - `role="menu"` + roving `aria-activedescendant` while focus stays on the
   *    panel (no per-item focus churn, one keydown handler);
   *  - edge-aware placement (flip, then clamp) measured from the real element,
   *    so the menu never runs off-screen on a phone;
   *  - dismissal on outside pointerdown, any outside scroll, resize, blur,
   *    Escape, or a new gesture elsewhere — and the outside press is CONSUMED:
   *    the click it would leave behind is swallowed, so a tap meant to dismiss
   *    can never also press the control it landed on;
   *  - focus returned to the trigger on teardown.
   *
   * One level of submenu (Rating) is supported; the wrapper with
   * `pointer-events-none` exists so the submenu can be a SIBLING of the
   * scrolling panel (a fixed descendant of an overflow/transform ancestor would
   * be clipped), while one keydown/dismissal scope still covers both.
   */

  let {
    entries,
    label,
    x,
    y,
    trigger,
    onselect,
    onclose,
  }: {
    entries: ContextMenuEntry[]
    label: string
    x: number
    y: number
    trigger: HTMLElement | null
    onselect: (id: string) => void
    onclose: () => void
  } = $props()

  let rootEl = $state<HTMLDivElement | null>(null)
  let menuEl = $state<HTMLDivElement | null>(null)
  let submenuEl = $state<HTMLDivElement | null>(null)

  let activeId = $state<string | null>(null)
  let subActiveId = $state<string | null>(null)
  let openSubmenuId = $state<string | null>(null)
  let subAnchor = $state<DOMRect | null>(null)

  let pos = $state<{ left: number; top: number } | null>(null)
  let origin = $state('top left')
  let subPos = $state<{ left: number; top: number } | null>(null)

  let openSubmenu = $derived.by((): ContextMenuSubmenu | null => {
    if (!openSubmenuId) return null
    const entry = entries.find((e) => e.type === 'submenu' && e.id === openSubmenuId)
    return entry && entry.type === 'submenu' ? entry : null
  })

  /** Screen readers announce the active row whether it lives in the panel or
   *  the submenu — `aria-activedescendant` may point anywhere in the document. */
  let activeDescendant = $derived.by(() => {
    const id = openSubmenuId ? subActiveId : activeId
    return id ? itemDomId(openSubmenuId ? 'sub' : 'root', id) : undefined
  })

  function itemDomId(level: 'root' | 'sub', id: string): string {
    return `ctx-menu-${level}-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  }

  function viewport(): { width: number; height: number } {
    return {
      width: window.visualViewport?.width ?? window.innerWidth,
      height: window.visualViewport?.height ?? window.innerHeight,
    }
  }

  // First item is active on open (platform convention): Enter immediately runs
  // the safest first action. The guard stops the effect from fighting keyboard
  // navigation afterwards.
  let initialized = $state(false)
  $effect(() => {
    if (initialized) return
    const ids = menuNavigableIds(entries)
    if (ids.length === 0) return
    initialized = true
    activeId = ids[0]
  })

  // Focus the panel once — a menu is not a focus trap, but it must receive the
  // keyboard. Focus is handed back to the trigger in onDestroy.
  //
  // MUST wait for `pos`: the panel starts `visibility:hidden` (so it never
  // flashes in the corner before placement), and a hidden element silently
  // refuses focus — the menu then opened with focus still on the trigger and
  // ArrowDown/Escape did nothing (2026-11-04 live e2e catch). `focused` is only
  // set when the focus actually landed, so a browser that defers it retries on
  // the next flush instead of leaving the menu keyboard-dead.
  let focused = false
  $effect(() => {
    const el = menuEl
    if (!el || !pos || focused) return
    tick().then(() => {
      if (focused || !el.isConnected) return
      el.focus({ preventScroll: true })
      if (document.activeElement === el) focused = true
    })
  })

  // Measure the real menu, then flip/clamp against the viewport. Starts hidden
  // so the first paint never flashes in the top-left corner.
  $effect(() => {
    const el = menuEl
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vp = viewport()
    const placed = placeContextMenu({
      x,
      y,
      width: rect.width,
      height: rect.height,
      viewportWidth: vp.width,
      viewportHeight: vp.height,
    })
    pos = { left: placed.left, top: placed.top }
    origin = `${placed.flippedX ? 'right' : 'left'} ${placed.flippedY ? 'bottom' : 'top'}`
  })

  // Same measurement pass for an open submenu, beside its parent row.
  $effect(() => {
    const el = submenuEl
    const anchor = subAnchor
    if (!el || !anchor) return
    const rect = el.getBoundingClientRect()
    const vp = viewport()
    const placed = placeSubmenu({
      parentLeft: anchor.left,
      parentTop: anchor.top,
      parentWidth: anchor.width,
      parentHeight: anchor.height,
      width: rect.width,
      height: rect.height,
      viewportWidth: vp.width,
      viewportHeight: vp.height,
    })
    subPos = { left: placed.left, top: placed.top }
  })

  function openSubmenuFor(id: string, anchor?: HTMLElement): void {
    const el =
      anchor ??
      rootEl?.querySelector<HTMLElement>(`[data-submenu-anchor="${CSS.escape(id)}"]`) ??
      null
    openSubmenuId = id
    subAnchor = el?.getBoundingClientRect() ?? null
    subPos = null
    const entry = entries.find((e) => e.type === 'submenu' && e.id === id)
    subActiveId =
      entry && entry.type === 'submenu' ? (menuNavigableIds(entry.items)[0] ?? null) : null
  }

  function closeSubmenu(): void {
    openSubmenuId = null
    subActiveId = null
    subAnchor = null
    subPos = null
  }

  function setActive(level: 'root' | 'sub', id: string): void {
    if (level === 'root') {
      activeId = id
      if (openSubmenuId && openSubmenuId !== id) closeSubmenu()
    } else {
      subActiveId = id
    }
  }

  function activate(entry: ContextMenuEntry | undefined): void {
    if (!entry) return
    if (entry.type === 'submenu') {
      openSubmenuFor(entry.id)
      return
    }
    if (entry.type === 'action' && !entry.disabled) onselect(entry.id)
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (openSubmenuId) closeSubmenu()
      else onclose()
      return
    }
    if (event.key === 'Tab') {
      // A menu is transient: leaving it closes it and returns focus.
      event.preventDefault()
      onclose()
      return
    }

    const inSubmenu = openSubmenuId !== null
    const list = inSubmenu ? (openSubmenu?.items ?? []) : entries
    const ids = menuNavigableIds(list)
    const current = inSubmenu ? subActiveId : activeId
    const setCurrent = (id: string | null) => {
      if (inSubmenu) subActiveId = id
      else activeId = id
    }

    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault()
        setCurrent(stepMenuId(ids, current, event.key === 'ArrowDown' ? 1 : -1))
        return
      case 'Home':
        event.preventDefault()
        setCurrent(ids[0] ?? null)
        return
      case 'End':
        event.preventDefault()
        setCurrent(ids[ids.length - 1] ?? null)
        return
      case 'ArrowRight': {
        if (inSubmenu) return
        const entry = entries.find((e) => e.id === current)
        if (entry?.type === 'submenu') {
          event.preventDefault()
          openSubmenuFor(entry.id)
        }
        return
      }
      case 'ArrowLeft': {
        if (!inSubmenu) return
        event.preventDefault()
        const parentId = openSubmenuId
        closeSubmenu()
        activeId = parentId
        return
      }
      case 'Enter':
      case ' ': {
        event.preventDefault()
        activate(list.find((e) => e.id === current))
        return
      }
    }
  }

  // Dismissal scope. Scroll is captured because the page scrolls inside nested
  // containers; a scroll OF THE MENU itself must not close it.
  $effect(() => {
    function onPointerDown(event: PointerEvent): void {
      if (!(event.target instanceof Node)) return
      if (rootEl?.contains(event.target)) return
      // The outside press IS the dismissal — it is never also an activation.
      // Cancel the pointerdown (default + propagation) and swallow the click it
      // leaves behind, so nothing under the finger runs: a tap meant to cancel
      // cannot queue, play or navigate (2026-11-07). The swallow is page-wide
      // and outlives this component, because the menu unmounts before the
      // browser dispatches the click.
      event.preventDefault()
      event.stopPropagation()
      armClickSwallow()
      onclose()
    }
    function onScroll(event: Event): void {
      if (event.target instanceof Node && rootEl?.contains(event.target)) return
      onclose()
    }
    function onResize(): void {
      onclose()
    }
    function onBlur(): void {
      onclose()
    }
    // Escape is a menu-level contract, not a focus-dependent one: the wrapper
    // handles it while focus is inside, and this document fallback covers the
    // frame before focus lands (or any host that steals it).
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (openSubmenuId) closeSubmenu()
      else onclose()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    window.addEventListener('blur', onBlur)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('keydown', onKeyDown)
    }
  })

  onDestroy(() => {
    if (trigger?.isConnected) trigger.focus({ preventScroll: true })
  })

  function entryClasses(active: boolean, danger: boolean, disabled: boolean): string {
    const base =
      'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] leading-5 transition-colors'
    const tone = danger ? 'text-red-400' : 'text-primary'
    const state = active ? (danger ? 'bg-red-500/15' : 'bg-white/10') : ''
    const inert = disabled ? 'pointer-events-none opacity-40' : 'cursor-pointer'
    return [base, tone, state, inert].filter(Boolean).join(' ')
  }
</script>

{#snippet entryList(items: ContextMenuEntry[], level: 'root' | 'sub')}
  {#each items as entry (entry.id)}
    {#if entry.type === 'label'}
      <div class="px-2.5 pb-1.5 pt-1">
        <p class="truncate text-[13px] font-semibold text-primary" title={entry.label}>{entry.label}</p>
        {#if entry.detail}
          <p class="truncate text-[11px] text-muted" title={entry.detail}>{entry.detail}</p>
        {/if}
      </div>
    {:else if entry.type === 'separator'}
      <div class="my-1 h-px bg-white/10" role="separator"></div>
    {:else if entry.type === 'action'}
      {@const active = level === 'root' ? activeId === entry.id : subActiveId === entry.id}
      <div
        id={itemDomId(level, entry.id)}
        role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
        aria-checked={entry.checked}
        aria-label={entry.ariaLabel}
        aria-disabled={entry.disabled || undefined}
        tabindex="-1"
        class={entryClasses(active, entry.danger ?? false, entry.disabled ?? false)}
        onpointerenter={() => setActive(level, entry.id)}
        onclick={(event) => {
          event.stopPropagation()
          if (!entry.disabled) onselect(entry.id)
        }}
      >
        {#if entry.icon}
          <svg class="h-4 w-4 flex-shrink-0 text-muted" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d={CONTEXT_MENU_ICONS[entry.icon]} />
          </svg>
        {:else}
          <span class="h-4 w-4 flex-shrink-0" aria-hidden="true"></span>
        {/if}
        <span class="min-w-0 flex-1 truncate">{entry.label}</span>
        {#if entry.checked}
          <svg class="h-4 w-4 flex-shrink-0 text-accent" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
          </svg>
        {/if}
      </div>
    {:else if entry.type === 'submenu'}
      {@const active = level === 'root' ? activeId === entry.id : subActiveId === entry.id}
      <!-- Keyboard activation is handled ONCE by the wrapper's keydown (the
           menu model has no per-row focus); the click handler is the pointer
           path only, so the a11y warning would ask for a second, conflicting
           key handler. -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        id={itemDomId(level, entry.id)}
        data-submenu-anchor={entry.id}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={openSubmenuId === entry.id}
        aria-disabled={entry.disabled || undefined}
        tabindex="-1"
        class={entryClasses(active, false, entry.disabled ?? false)}
        onpointerenter={(event) => {
          setActive(level, entry.id)
          if (level === 'root') openSubmenuFor(entry.id, event.currentTarget as HTMLElement)
        }}
        onclick={(event) => {
          event.stopPropagation()
          if (entry.disabled) return
          // Always open (never toggle): hovering already opened it on desktop,
          // so a toggle would close the submenu on the very click that selected
          // it. Closing is Escape / ArrowLeft / moving to another row.
          openSubmenuFor(entry.id, event.currentTarget as HTMLElement)
        }}
      >
        {#if entry.icon}
          <svg class="h-4 w-4 flex-shrink-0 text-muted" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d={CONTEXT_MENU_ICONS[entry.icon]} />
          </svg>
        {:else}
          <span class="h-4 w-4 flex-shrink-0" aria-hidden="true"></span>
        {/if}
        <span class="min-w-0 flex-1 truncate">{entry.label}</span>
        <svg class="h-3.5 w-3.5 flex-shrink-0 text-muted/60" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
        </svg>
      </div>
    {/if}
  {/each}
{/snippet}

<!-- A pointer-events-none full-viewport layer holds the panel and its submenu.
     It exists only to give both fixed children ONE dismissal/keydown scope and
     to let the submenu escape the panel's scroll clipping. -->
<div
  bind:this={rootEl}
  class="pointer-events-none fixed inset-0 z-[100]"
  onkeydown={handleKeydown}
  role="presentation"
>
  <div
    bind:this={menuEl}
    class="ui-context-menu pointer-events-auto fixed flex max-h-[min(70dvh,32rem)] w-56 flex-col overflow-y-auto overscroll-contain rounded-xl border border-white/10 bg-surface p-1 shadow-2xl outline-none"
    style:left="{pos?.left ?? 0}px"
    style:top="{pos?.top ?? 0}px"
    style:visibility={pos ? 'visible' : 'hidden'}
    style:transform-origin={origin}
    role="menu"
    aria-label={label}
    aria-activedescendant={activeDescendant}
    tabindex="-1"
  >
    {@render entryList(entries, 'root')}
  </div>

  {#if openSubmenu}
    <div
      bind:this={submenuEl}
      class="ui-context-menu pointer-events-auto fixed flex max-h-[min(70dvh,32rem)] w-52 flex-col overflow-y-auto overscroll-contain rounded-xl border border-white/10 bg-surface p-1 shadow-2xl outline-none"
      style:left="{subPos?.left ?? 0}px"
      style:top="{subPos?.top ?? 0}px"
      style:visibility={subPos ? 'visible' : 'hidden'}
      role="menu"
      aria-label={openSubmenu.label}
    >
      {@render entryList(openSubmenu.items, 'sub')}
    </div>
  {/if}
</div>

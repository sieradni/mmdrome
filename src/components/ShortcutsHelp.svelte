<script lang="ts">
  import ModalShell from './ModalShell.svelte'

  let { onclose }: { onclose: () => void } = $props()

  /**
   * Grouped reference for the shortcuts that ACTUALLY exist in the tree.
   * Every row below mirrors a handler that is wired today — inventing a key
   * here would be the exact failure this sheet exists to prevent.
   */
  // Slugs: aria-labelledby IDs must not contain spaces or `&`.
  const slug = (t: string) => t.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  const groups: { title: string; rows: [string, string][] }[] = [
    {
      title: 'Playback',
      rows: [
        ['← / →', 'Seek −5 s / +5 s (SeekBar; ±1 s on tracks under a minute)'],
        ['Home / End', 'Seek to start / end of the track'],
        ['Enter / Space', 'Play or pause (rows and queue), on focused controls'],
      ],
    },
    {
      title: 'Queue & lists',
      rows: [
        ['Enter / Space', 'Play the focused row (library and queue)'],
        ['Shift + click', 'Select the range of rows from the anchor'],
        ['Ctrl / Cmd + click', 'Toggle one row in the selection'],
        ['ContextMenu / Shift+F10', 'Open the row context menu'],
      ],
    },
    {
      title: 'Menus',
      rows: [
        ['↑ / ↓', 'Move between menu items'],
        ['Home / End', 'Jump to the first / last menu item'],
        ['→ / ←', 'Open / close a submenu'],
        ['Enter / Space', 'Activate the highlighted item'],
        ['Esc', 'Close the submenu, then the menu'],
        ['Tab', 'Leave the menu (focus returns to the trigger)'],
      ],
    },
    {
      title: 'Sliders & EQ',
      rows: [
        ['← / → or ↑ / ↓', 'Nudge the focused slider by one step'],
        ['PgUp / PgDn', 'Nudge by ten steps (×3 on EqSlider)'],
        ['Home / End', 'Jump to the minimum / maximum of the slider'],
        ['Esc (EqSlider)', 'Return the band to 0 dB'],
      ],
    },
    {
      title: 'Dialogs',
      rows: [
        ['Esc', 'Close the dialog, menu, or clear the selection'],
        ['Tab / Shift+Tab', 'Move between dialog controls (trapped inside)'],
        ['?', 'Open this shortcuts sheet'],
      ],
    },
  ]
</script>

<ModalShell onclose={onclose} ariaLabel="Keyboard shortcuts">
  <div class="flex shrink-0 items-center justify-between border-b border-white/10 px-5 py-3">
    <span class="text-base font-bold text-primary">Keyboard shortcuts</span>
    <button onclick={onclose} class="rounded-full p-1.5 text-muted transition-colors hover:text-primary" aria-label="Close shortcuts">
      <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
    </button>
  </div>
  <div class="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
    {#each groups as group (group.title)}
      <section aria-labelledby={`shortcuts-${slug(group.title)}`}>
        <h3 id={`shortcuts-${slug(group.title)}`} class="mb-2 text-[11px] font-semibold uppercase tracking-widest text-muted">{group.title}</h3>
        <dl class="space-y-1.5">
          {#each group.rows as [key, description] (key + description)}
            <div class="flex items-baseline gap-3">
              <dt class="shrink-0 basis-36 text-xs font-medium text-primary tabular-nums">{key}</dt>
              <dd class="min-w-0 flex-1 text-xs text-muted">{description}</dd>
            </div>
          {/each}
        </dl>
      </section>
    {/each}
  </div>
  <div class="flex shrink-0 items-center justify-end border-t border-white/10 px-5 py-3">
    <button onclick={onclose} class="btn-secondary btn-sm">Done</button>
  </div>
</ModalShell>

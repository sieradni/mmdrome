<script lang="ts">
  import type { Snippet } from 'svelte'

  /**
   * The app's ONE modal shell (native `<dialog>`).
   *
   * Why a real `<dialog>`: `showModal()` gives focus containment, an inert
   * background, Esc handling and top-layer stacking for free — and top-layer
   * ORDER is what lets the track-details dialog open ON TOP of the push
   * confirm pane (a plain `fixed z-50` overlay paints BEHIND any modal
   * dialog, no matter its z-index).
   *
   * Sizing is deliberately owned HERE, not by consumers: the pane is capped
   * at 80dvh so a slice of the screen it covers stays visible (and tappable)
   * above and below it on iOS, where a `100dvh`-tall sheet runs under the
   * notch, the home indicator and Safari's bottom bar and its footer buttons
   * become unreachable. 42rem stops the same cap from making desktop dialogs
   * needlessly tall.
   *
   * NO border / outline on the dialog element: iOS Safari paints its own
   * focus ring (a colored rounded outline) around whatever it considers
   * focused, and the old code focused the dialog on open — the ring read as
   * an unremovable colored border around the pane. The dialog is only the
   * focus START point (a container, not a control), so a visible ring there
   * carries no meaning; kill it and keep the ring on real controls.
   */
  let {
    onclose,
    ariaLabel,
    ariaDescribedBy,
    children,
  }: {
    onclose: () => void
    ariaLabel: string
    ariaDescribedBy?: string
    children: Snippet
  } = $props()

  function openModal(node: HTMLDialogElement) {
    const previousFocus = document.activeElement
    node.showModal()
    // Start on the dialog rather than a destructive per-row action. Native
    // modal behavior contains Tab focus and makes the background inert.
    node.focus()
    const observer = new MutationObserver(() => {
      // Removing a discarded row must not strand focus on the document body.
      if (document.activeElement === document.body) node.focus()
    })
    observer.observe(node, { childList: true, subtree: true })
    return {
      destroy() {
        observer.disconnect()
        node.close()
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
      },
    }
  }

  function containTab(event: KeyboardEvent) {
    if (event.key !== 'Tab') return
    const node = event.currentTarget as HTMLDialogElement
    const controls = Array.from(
      node.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
      ),
    ).filter((el) => el.getClientRects().length > 0)
    const first = controls[0]
    const last = controls.at(-1)
    if (!first || !last) {
      event.preventDefault()
      node.focus()
    } else if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  function dismissOutside(event: MouseEvent) {
    if (event.target !== event.currentTarget) return
    const rect = (event.currentTarget as HTMLDialogElement).getBoundingClientRect()
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onclose()
  }
</script>

<dialog
  use:openModal
  aria-label={ariaLabel}
  aria-describedby={ariaDescribedBy}
  tabindex="-1"
  class="m-auto max-h-[min(80dvh,42rem)] w-[calc(100%-2rem)] max-w-lg flex-col overflow-hidden overscroll-contain rounded-xl border-0 bg-surface p-0 text-primary shadow-2xl outline-none backdrop:bg-black/70 open:flex"
  oncancel={(event) => { event.preventDefault(); onclose() }}
  onclick={dismissOutside}
  onkeydown={containTab}
>
  {@render children()}
</dialog>

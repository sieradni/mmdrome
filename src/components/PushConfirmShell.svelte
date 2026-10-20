<script lang="ts">
  import type { Snippet } from 'svelte'

  let { onclose, children }: { onclose: () => void; children: Snippet } = $props()

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
    const controls = Array.from(node.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')).filter((el) => el.getClientRects().length > 0)
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
  aria-label="Write ratings to WebDAV files?"
  aria-describedby="push-confirm-description"
  tabindex="-1"
  class="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg flex-col overflow-hidden rounded-xl border border-white/10 bg-surface p-0 text-primary backdrop:bg-black/70 open:flex"
  oncancel={(event) => { event.preventDefault(); onclose() }}
  onclick={dismissOutside}
  onkeydown={containTab}
>
  {@render children()}
</dialog>

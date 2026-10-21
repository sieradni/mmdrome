<script lang="ts">
  import type { Snippet } from 'svelte'
  import ModalShell from './ModalShell.svelte'

  let {
    onclose,
    count,
    closeLabel = 'Cancel',
    submitLabel = 'Write to files',
    submitDisabled = false,
    onsubmit,
    children,
  }: {
    onclose: () => void
    count: number
    closeLabel?: string
    submitLabel?: string
    submitDisabled?: boolean
    onsubmit?: () => void
    children: Snippet
  } = $props()
</script>

<!-- Shared Push Changes confirmation dialog: owns the header warning,
     scrollable body + file count announcement, and footer actions so
     SettingsView and UiReview cannot drift apart. -->
<ModalShell
  {onclose}
  ariaLabel="Write ratings to WebDAV files?"
  ariaDescribedBy="push-confirm-description"
>
  <header class="shrink-0 border-b border-white/10 px-5 py-4">
    <h2 id="review-title" class="text-base font-semibold text-primary">Write ratings to WebDAV files?</h2>
    <p id="push-confirm-description" class="mt-1 text-xs leading-relaxed text-muted">
      Updates only rating and loved tags. A wrong file link applies these tags to the wrong file. Tags can be corrected later if you know the previous values. Verify the paths below.
    </p>
  </header>
  <div class="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-5 py-3.5 text-sm">
    <p role="status" class="text-xs font-medium uppercase tracking-wider text-muted">
      {count} file{count === 1 ? '' : 's'} will be updated:
    </p>
    {@render children()}
  </div>
  <footer class="flex shrink-0 flex-wrap justify-end gap-2 border-t border-white/10 px-5 py-3.5">
    <button class="btn-secondary btn-md min-h-11" onclick={onclose}>{closeLabel}</button>
    <button class="btn-primary btn-md min-h-11" disabled={submitDisabled} onclick={onsubmit}>{submitLabel}</button>
  </footer>
</ModalShell>

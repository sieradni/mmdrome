<script lang="ts">
  let { title, expanded, disabled = false, onclick, testId }: {
    title: string
    expanded: boolean
    disabled?: boolean
    onclick: () => void
    testId?: string
  } = $props()
</script>

<button
  type="button"
  data-testid={testId}
  class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-white/10 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50"
  aria-label={`Discard pending edit for ${title}`}
  aria-expanded={expanded}
  {disabled}
  {onclick}
>
  <svg aria-hidden="true" class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>
</button>

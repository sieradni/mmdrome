<script lang="ts">
  import type { ActivityStatus } from '../lib/activityStatus'
  let { status, onclick }: { status: ActivityStatus | null; onclick: () => void } = $props()
</script>

{#if status}
  <div role="status" aria-live="polite">
    <button type="button" data-testid="app-activity-status" {onclick}
      class="flex w-full items-center gap-2 px-4 py-2 text-left text-xs text-muted hover:text-primary">
      {#if status.kind === 'cached-offline'}
        <span aria-hidden="true">○</span>
      {:else}
        <span class="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none" aria-hidden="true"></span>
      {/if}
      <span class="min-w-0 flex-1">{status.label}</span>
    </button>
  </div>
{/if}

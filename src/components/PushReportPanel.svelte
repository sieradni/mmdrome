<script lang="ts">
  import type { PushRunReport } from '../lib/pushOutcome'

  /**
   * The retained Push report (W-07/W-09) — the ONE renderer of `PushRunReport`.
   *
   * Data flows DOWN: `SettingsView` reads the store (`lastPushReport`, whose
   * owner is appState and whose lifetime is the run + a persisted row) and hands
   * the value in. The panel owns presentation only: the collapsed count line,
   * the run metadata, the grouped causes with their next action, the per-row
   * `disposition (stage …; remote X, local Y)` detail and the truncation notice
   * that keeps `MAX_RETAINED_REPORT_ROWS` from silently shrinking a run.
   */
  let { report }: { report: PushRunReport | null } = $props()
</script>

{#if report}
  <details class="rounded-lg bg-surface-hover/50 p-3 text-xs text-muted" data-testid="push-report-details">
    <summary class="cursor-pointer select-none font-medium text-primary">
      Last push report ({report.counts.remoteCommitted} written{#if report.counts.failed > 0}, <span class="text-red-300">{report.counts.failed} failed</span>{/if}{#if report.counts.unknownOutcomes > 0}, <span class="text-amber-300">{report.counts.unknownOutcomes} uncertain</span>{/if}{#if report.counts.skipped > 0}, {report.counts.skipped} skipped{/if})
    </summary>
    <div class="mt-2 space-y-2">
      <p class="text-[11px] text-muted/80">
        Run {report.runId} &middot; {report.status} &middot; {report.durationMs}ms &middot; catalog refresh: {report.catalogRefresh}{#if report.catalogRefreshError} ({report.catalogRefreshError}){/if}
      </p>
      {#if report.failureGroups.length > 0}
        <div class="space-y-1.5" data-testid="push-failure-groups">
          {#each report.failureGroups as fg (fg.key)}
            <div class="rounded bg-red-500/10 px-2.5 py-1.5 text-red-200 ring-1 ring-red-500/20">
              <div class="font-medium">{fg.count}&times; [{fg.stage} / {fg.category}{#if fg.status} {fg.status}{/if}] {fg.headline}</div>
              <div class="mt-0.5 text-[11px] text-amber-200/90">{fg.nextAction}</div>
              {#if fg.tracks.length > 0}
                <div class="mt-0.5 text-[11px] text-red-200/80">Tracks: {fg.tracks.map((t) => t.title).join(', ')}</div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
      {#if report.rows.length > 0}
        <ul class="max-h-48 divide-y divide-white/5 overflow-y-auto pr-1" data-testid="push-report-rows">
          {#each report.rows as row (row.trackId + '-' + row.startedAtMs)}
            <li class="py-1 text-[11px]">
              <span class="font-medium text-primary">{row.title}</span>
              <span class="text-muted"> &mdash; {row.disposition} ({row.stage}{#if row.attempts > 1}, {row.attempts} attempts{/if}{#if row.recoveredConflict}, conflict recovered{/if}{#if row.tempCleanup}, temp cleanup: {row.tempCleanup}{/if}; remote {row.remoteState}, local {row.localReconciliation})</span>
              {#if row.error}
                <div class="text-red-300">{row.error.message}{#if row.error.davError} &middot; {row.error.davError}{/if}</div>
              {/if}
            </li>
          {/each}
        </ul>
        {#if report.rowsTruncated > 0}
          <p class="text-[11px] text-muted/70">{report.rowsTruncated} more rows not retained.</p>
        {/if}
      {/if}
    </div>
  </details>
{/if}

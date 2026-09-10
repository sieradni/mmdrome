<script lang="ts">
  /**
   * Indeterminate ring for buffering states.
   * `trackClass`/`headClass` recolor it for non-dark surfaces (e.g. the
   * solid Now Playing play button, where white-on-primary needs inverting).
   */
  interface Props {
    sizeClass?: string
    trackClass?: string
    headClass?: string
  }

  let {
    sizeClass = 'h-6 w-6',
    trackClass = 'border-white/25',
    headClass = 'border-t-white',
  }: Props = $props()
</script>

<span
  class="block animate-spin rounded-full border-2 {trackClass} {headClass} {sizeClass}"
  aria-hidden="true"
></span>

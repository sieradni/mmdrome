<script lang="ts">
  // iOS-style toggle. A real button[role=switch] (not a styled checkbox) so
  // the value stays assertable (`toBeChecked` reads aria-checked) and the
  // wrapping <label> still forwards clicks from the row text.
  let {
    checked = false,
    disabled = false,
    label,
    onchange,
    testid,
  }: {
    checked?: boolean
    disabled?: boolean
    label?: string
    onchange?: (value: boolean) => void
    testid?: string
  } = $props()
</script>

<button
  type="button"
  role="switch"
  aria-checked={checked}
  aria-label={label}
  data-testid={testid}
  {disabled}
  onclick={() => onchange?.(!checked)}
  class={"relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors " +
    (checked ? 'bg-accent ' : 'bg-white/15 ') +
    (disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer')}
>
  <span
    class={"inline-block h-4 w-4 rounded-full bg-black shadow transition-transform " +
      (checked ? 'translate-x-6' : 'translate-x-1')}
  ></span>
</button>

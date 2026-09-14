<script lang="ts">
  /**
   * Search input with an inline clear (×) button — the standard text entry
   * affordance for every search box in the app (the sticky header, the
   * auto-queue filter, File Matching's two pickers). The button renders only
   * while there is text (an empty × is dead chrome), clears in one tap, and
   * returns focus to the input for immediate retyping.
   *
   * Styling mirrors the existing search pills: `class` shapes the INPUT
   * (width/ring/rounded per site), the × rides inside its right padding.
   */
  interface Props {
    /** The query — bind for two-way editing. */
    value?: string
    placeholder?: string
    /** Accessible name (the sticky-header input has no placeholder). */
    label?: string
    /** Fired after the value changes (typing AND clearing). */
    onInput?: (value: string) => void
    /** Fired on Enter (File Matching flushes its debounce + scrolls top). */
    onEnter?: () => void
    /** Fired when the × is pressed (after clearing). */
    onClear?: () => void
    /** Extra classes for the INPUT (width/ring/rounded per site). */
    class?: string
    /** testid for the input (File Matching pins selectors on it). */
    testId?: string
  }

  let {
    value = $bindable(''),
    placeholder,
    label,
    onInput,
    onEnter,
    onClear,
    class: className = '',
    testId,
  }: Props = $props()

  let inputEl: HTMLInputElement | undefined = $state()

  function clear(): void {
    value = ''
    onInput?.('')
    onClear?.()
    inputEl?.focus()
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      onEnter?.()
    }
  }
</script>

<div class="relative flex items-center">
  <input
    bind:this={inputEl}
    bind:value
    type="search"
    placeholder={placeholder}
    aria-label={label}
    data-testid={testId}
    oninput={() => onInput?.(value)}
    onkeydown={handleKeydown}
    class="w-full {className}"
  />
  {#if value && value.length > 0}
    <button
      type="button"
      onclick={clear}
      class="absolute right-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:text-primary"
      aria-label="Clear search"
    >
      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
  {/if}
</div>

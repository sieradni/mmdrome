<script lang="ts">
  // Floating "back to top" affordance for long scrolling lists (home views,
  // queue). Visible only once the bound container is scrolled past a
  // threshold; smooth-scrolls back. Each view passes its own scroll element
  // via `target` — the listener rides the container, so multiple instances
  // (Albums/Artists list + detail) never fight each other. `posClass` is the
  // full position utility string: views drop the button to the corner
  // baseline when the → jump button is hidden (no active track), so ↑ never
  // floats mid-air above nothing.
  let {
    target,
    posClass = 'bottom-20 right-4',
  }: { target: HTMLElement | null; posClass?: string } = $props()

  let visible = $state(false)

  $effect(() => {
    const el = target
    if (!el) {
      visible = false
      return
    }
    const update = () => {
      visible = el.scrollTop > 400
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    return () => el.removeEventListener('scroll', update)
  })

  function toTop() {
    target?.scrollTo({ top: 0, behavior: 'smooth' })
  }
</script>

{#if visible}
  <button
    onclick={toTop}
    class="absolute {posClass} z-20 flex h-12 w-12 items-center justify-center rounded-full bg-[#0f0f0f] text-xl font-medium text-muted ring-1 ring-white/10 transition-colors hover:text-primary hover:ring-white/20"
    aria-label="Scroll to top"
  >↑</button>
{/if}

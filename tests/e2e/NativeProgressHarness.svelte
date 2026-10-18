<script lang="ts">
  import SeekBar from '../../src/components/SeekBar.svelte'
  import { preloadEntries } from '../../src/stores/loadStatus'
  import { currentLoadedFraction } from '../../src/lib/loadStatus'
</script>

<div style="width: 400px">
  <SeekBar value={0} max={218} label="Native progress probe"
    loadedFraction={currentLoadedFraction($preloadEntries.active)} onSeek={() => {}} />
</div>

<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { Capacitor } from '@capacitor/core'
  import { get } from 'svelte/store'
  import { currentTrack, playbackState, queue, currentTime, effectiveDuration, settings, library } from '../stores/appState'
  import { BackgroundAudio } from '../lib/nativePlugin'
  import { audioManager } from '../lib/audioManager'

  let { onclose }: { onclose?: () => void } = $props()

  let nativeState: any = $state(null)
  let nativeDebug: any = $state(null)
  let jsTick = $state(0)
  let lastError = $state('')
  let lastTrackChanged = $state('')
  let errorLog: string[] = $state([])
  let expanded = $state(false)
  let poll: ReturnType<typeof setInterval> | null = null
  let jsPoll: ReturnType<typeof setInterval> | null = null
  let listeners: any[] = []

  function pushError(msg: string) {
    const line = `${new Date().toLocaleTimeString()} ${msg}`
    errorLog = [line, ...errorLog].slice(0, 40)
    lastError = msg
  }

  async function refreshNative() {
    if (!Capacitor.isNativePlatform()) return
    try {
      const s = await BackgroundAudio.getState()
      nativeState = s
    } catch (e: any) {
      nativeState = { error: String(e?.message ?? e) }
    }
    // @ts-ignore optional
    if ((BackgroundAudio as any).getDebugState) {
      try {
        const d = await (BackgroundAudio as any).getDebugState()
        nativeDebug = d
      } catch {}
    }
  }

  onMount(() => {
    void (async () => {
      if (Capacitor.isNativePlatform()) {
        try {
          listeners.push(await BackgroundAudio.addListener('error', (d: any) => pushError(`error: ${d.message}`)))
          listeners.push(await BackgroundAudio.addListener('trackChanged', (d: any) => {
            lastTrackChanged = `${new Date().toLocaleTimeString()} trackChanged ${d.trackId}`
            pushError(`trackChanged ${d.trackId}`)
          }))
          listeners.push(await BackgroundAudio.addListener('playbackStateChanged', (d: any) => pushError(`playbackState ${d.playing ? 'playing' : 'paused'}`)))
          listeners.push(await BackgroundAudio.addListener('ended', () => pushError('ended')))
        } catch {}
        refreshNative()
        poll = setInterval(refreshNative, 500)
      }
    })()
    // tick for JS reactive values even without svelte effect
    jsPoll = setInterval(() => jsTick++, 500)

    // capture console.error
    const origError = console.error
    // @ts-ignore
    console.error = (...args: any[]) => {
      pushError(args.map(String).join(' '))
      origError(...args)
    }
  })

  onDestroy(() => {
    if (poll) clearInterval(poll)
    if (jsPoll) clearInterval(jsPoll)
    listeners.forEach((h) => h.remove?.())
  })

  function copy() {
    const q = get(queue)
    const ct = get(currentTrack)
    const st = get(playbackState)
    const lib = get(library)
    const payload = {
      time: new Date().toISOString(),
      js: {
        currentTrackId: ct?.trackId ?? null,
        currentTrackTitle: ct?.title ?? null,
        playbackState: st,
        currentTime: get(currentTime),
        effectiveDuration: get(effectiveDuration),
        activeIndex: q.activeIndex,
        combinedLen: [...q.userQueue, ...q.autoQueue].length,
        userQueueLen: q.userQueue.length,
        autoQueueLen: q.autoQueue.length,
        activeId: q.activeIndex >=0 ? [...q.userQueue, ...q.autoQueue][q.activeIndex] : null,
        librarySize: lib.length,
        isNative: Capacitor.isNativePlatform(),
        isIOS: audioManager.isIOS,
        engineWidth: typeof (audioManager as any).webAudioReady !== 'undefined' ? (audioManager as any).webAudioReady : null,
      },
      nativeState,
      nativeDebug,
      lastError,
      lastTrackChanged,
      errorLog: errorLog.slice(0, 20),
      settings: get(settings),
    }
    const text = JSON.stringify(payload, null, 2)
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => {})
    // fallback share
    try { (window as any).__debugHudText = text } catch {}
    pushError('copied to clipboard / window.__debugHudText')
  }

  function clearLog() { errorLog = []; lastError=''; lastTrackChanged='' }

  let q = $derived(get(queue))
  // reactive read via jsTick
  let ct = $derived.by(() => { void jsTick; return get(currentTrack) })
  let ps = $derived.by(() => { void jsTick; return get(playbackState) })
  let ctime = $derived.by(() => { void jsTick; return get(currentTime) })
  let edur = $derived.by(() => { void jsTick; return get(effectiveDuration) })
  let combined = $derived.by(() => { void jsTick; const qq=get(queue); return [...qq.userQueue, ...qq.autoQueue] })
</script>

<div class="fixed bottom-20 right-2 z-[70] flex max-h-[70vh] w-[min(420px,calc(100vw-16px))] flex-col rounded-xl bg-black/85 text-[11px] leading-tight text-white shadow-2xl ring-1 ring-white/20 backdrop-blur">
  <div class="flex items-center justify-between gap-2 px-3 py-2">
    <button onclick={() => (expanded = !expanded)} class="flex-1 text-left font-mono text-xs font-bold tracking-wide">
      DEBUG HUD {expanded ? '▾' : '▸'} {Capacitor.isNativePlatform() ? 'NATIVE' : 'WEB'} {ps}
    </button>
    <button onclick={copy} class="rounded bg-white/10 px-2 py-1 text-[10px] hover:bg-white/20">Copy</button>
    <button onclick={clearLog} class="rounded bg-white/10 px-2 py-1 text-[10px] hover:bg-white/20">Clear</button>
    <button onclick={() => onclose?.()} class="rounded bg-white/10 px-2 py-1 text-[10px] hover:bg-white/20">×</button>
  </div>

  <div class="overflow-auto px-3 pb-3 font-mono">
    <!-- JS -->
    <div class="mb-2 rounded bg-white/5 p-2">
      <div class="mb-1 font-bold text-yellow-300">JS</div>
      <div>track: <span class="text-cyan-300">{ct?.trackId ?? 'null'}</span> {ct?.title ?? ''}</div>
      <div>state: {ps} time: {ctime.toFixed(2)} / {edur.toFixed(2)}</div>
      <div>activeIndex: {q.activeIndex} / {combined.length} (u:{q.userQueue.length} a:{q.autoQueue.length})</div>
      <div>activeId: {(combined[q.activeIndex] ?? '—')}</div>
      <div>queue: [{combined.slice(0,6).join(', ')}{combined.length>6?' …':''}]</div>
      {#if lastTrackChanged}<div class="text-green-300">{lastTrackChanged}</div>{/if}
    </div>

    {#if Capacitor.isNativePlatform()}
      <div class="mb-2 rounded bg-white/5 p-2">
        <div class="mb-1 font-bold text-yellow-300">NATIVE getState (500ms)</div>
        {#if nativeState}
          <pre class="whitespace-pre-wrap break-words text-[10px]">{JSON.stringify(nativeState, null, 1)}</pre>
        {:else}
          <div class="text-white/50">loading…</div>
        {/if}
      </div>
      {#if nativeDebug}
        <div class="mb-2 rounded bg-white/5 p-2">
          <div class="mb-1 font-bold text-yellow-300">NATIVE debugState</div>
          <pre class="whitespace-pre-wrap break-words text-[10px]">{JSON.stringify(nativeDebug, null, 1)}</pre>
        </div>
      {/if}
    {:else}
      <div class="mb-2 rounded bg-white/5 p-2">
        <div class="mb-1 font-bold text-yellow-300">WEB audioManager</div>
        <div>ctx: {audioManager.ctx?.state ?? 'no ctx'} ready:{String(audioManager.webAudioReady)} speed:{audioManager.speed} pitch:{audioManager.pitchOctaves}</div>
        <div>active: {audioManager.activeElement?.src ? 'src yes' : 'no src'} paused:{String(audioManager.activeElement?.paused)} ended:{String(audioManager.activeElement?.ended)} time:{audioManager.activeElement?.currentTime?.toFixed(2) ?? '—'}</div>
        <div>gainA:{audioManager.gainA?.gain.value.toFixed(2) ?? '—'} gainB:{audioManager.gainB?.gain.value.toFixed(2) ?? '—'} preamp:{audioManager.preamp?.gain.value.toFixed(2) ?? '—'}</div>
      </div>
    {/if}

    <div class="rounded bg-white/5 p-2">
      <div class="mb-1 flex items-center justify-between"><span class="font-bold text-yellow-300">LOG (40)</span><span class="text-white/50">{errorLog.length}</span></div>
      {#if lastError}<div class="mb-1 text-red-300">last: {lastError}</div>{/if}
      <div class="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-tight">
        {#each errorLog as line}
          <div class="border-t border-white/5 py-0.5">{line}</div>
        {/each}
        {#if errorLog.length===0}<div class="text-white/30">no errors</div>{/if}
      </div>
    </div>

    {#if expanded}
      <div class="mt-2 rounded bg-white/5 p-2">
        <div class="mb-1 font-bold text-yellow-300">INSTRUCTIONS</div>
        <div class="text-[10px] leading-tight text-white/80">
          1) Play first song → wait 2s<br/>
          2) Tap second song (adjacent + non-adjacent)<br/>
          3) Observe: JS activeId vs nativeState.trackId, isPlaying vs playing, position advancing, hasLiveSchedule / isRunning, gain values, error log.<br/>
          4) Press Copy → paste to issue.<br/>
          Tap Copy after pause/play flicker to capture toggle.
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>

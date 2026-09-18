<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { Capacitor } from '@capacitor/core'
  import { get } from 'svelte/store'
  import { currentTrack, playbackState, queue, currentTime, effectiveDuration, settings, library } from '../stores/appState'
  import { effectiveLowData, networkStatusStore } from '../lib/networkMode'
  import { transcodeParams } from '../lib/transcodePolicy'
  import { getCachedConfig } from '../lib/navidromeApi'
  import { getCachedLfmSession } from '../lib/lastfmAuth'
  import { BackgroundAudio } from '../lib/nativePlugin'
  import {
    nativeBridgeTrailSnapshot,
    clearNativeBridgeTrail,
  } from '../lib/playbackCore/nativeBridgeTrail'
  import { thumbLoaderDebugSnapshot } from '../lib/thumbLoader'
  import { audioManager } from '../lib/audioManager'

  let { onclose }: { onclose?: () => void } = $props()

  let nativeState: any = $state(null)
  let nativeDebug: any = $state(null)
  let jsTick = $state(0)
  let lastError = $state('')
  let lastTrackChanged = $state('')
  let errorLog: string[] = $state([])
  let expanded = $state(false)
  // 2026-09-17: section collapse state — the state dumps are bulky; the trail
  // and log are the diagnosis surfaces and stay open. Sections persist only
  // for the session (no Dexie: debug-only preference).
  let openSections = $state<Record<string, boolean>>({ js: false, native: true, trail: true, log: true, thumbs: false })
  let poll: ReturnType<typeof setInterval> | null = null
  let jsPoll: ReturnType<typeof setInterval> | null = null
  let listeners: any[] = []

  function toggleSection(key: string) {
    openSections = { ...openSections, [key]: !openSections[key] }
  }

  /**
   * The Copy payload used to embed `settings` VERBATIM — a dump pasted into
   * an issue or chat shipped the Navidrome password, the WebDAV token and
   * the ListenBrainz token with it. Diagnostics only need PRESENCE, never
   * values. Whitelist the safe fields; logins/tokens are represented by
   * configured-boolean so "is this set up" stays answerable.
   */
  function scrubSettings(s: Record<string, unknown>) {
    return {
      replayGainMode: s.replayGainMode,
      crossfadeDuration: s.crossfadeDuration,
      crossfadeCurve: s.crossfadeCurve,
      iosAudioMixing: s.iosAudioMixing,
      preloadTracks: s.preloadTracks,
      scrobbling: s.scrobbling,
      syncToNavidrome: s.syncToNavidrome,
      lastfmScrobbling: s.lastfmScrobbling,
      listenbrainzScrobbling: s.listenbrainzScrobbling,
      lowDataMode: s.lowDataMode,
      lowDataOnCellular: s.lowDataOnCellular,
      transcodeMode: s.transcodeMode,
      transcodeFormat: s.transcodeFormat,
      transcodeBitrate: s.transcodeBitrate,
      transcodeProbe: s.transcodeProbe,
      navidromeConfigured: !!s.navidromeUrl,
      webdavConfigured: !!s.webdavUrl,
      hasNavidromeCreds: !!(s.navidromeUser && s.navidromePassword),
      hasWebdavCreds: !!(s.webdavUser && s.webdavToken),
      hasListenbrainzToken: !!s.listenbrainzToken,
      // The Last.fm session is a Keychain-diverted secret (2026-09-17c) and
      // was NEVER part of the settings store's hydration list — reading
      // `s.lastfmSession` here always reported false. The live session lives
      // in lastfmAuth's module cache (`getCachedLfmSession`), restored at app
      // init; that is also what scrobbling actually keys on.
      hasLastfmSession: !!getCachedLfmSession(),
    }
  }

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
    const st8 = get(settings)
    // The manager's EXACT transcode decision (same pure function, same live
    // inputs) — "what the app believed the stream params were" for this copy.
    const tp = transcodeParams(
      {
        mode: st8.transcodeMode,
        lowDataActive: get(effectiveLowData),
        hasConfig: !!getCachedConfig(),
        probeFailed: st8.transcodeProbe?.[st8.transcodeFormat ?? 'opus'] === 'unsupported',
      },
      st8.transcodeFormat,
      st8.transcodeBitrate,
    )
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
        lowData: { effective: get(effectiveLowData), network: get(networkStatusStore) },
        transcode: tp ?? 'original',
      },
      nativeState,
      nativeDebug,
      lastError,
      lastTrackChanged,
      errorLog: errorLog.slice(0, 20),
      nativeBridgeTrail: nativeBridgeTrailSnapshot(),
      thumbnails: getThumbDebug(),
      settings: scrubSettings(st8 as unknown as Record<string, unknown>),
    }
    const text = JSON.stringify(payload, null, 2)
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => {})
    // fallback share
    try { (window as any).__debugHudText = text } catch {}
    pushError('copied to clipboard / window.__debugHudText')
  }

  function clearLog() {
    errorLog = []
    lastError = ''
    lastTrackChanged = ''
  }

  /** Thumb-queue counters for the HUD + Copy dump (counters only — no DOM or
   *  credential surface; same scrub posture as `scrubSettings`). */
  function getThumbDebug() {
    try {
      return thumbLoaderDebugSnapshot()
    } catch {
      return null
    }
  }

  function clearAll() {
    clearLog()
    clearNativeBridgeTrail()
  }

  let q = $derived(get(queue))
  // reactive read via jsTick
  let ct = $derived.by(() => { void jsTick; return get(currentTrack) })
  let ps = $derived.by(() => { void jsTick; return get(playbackState) })
  let ctime = $derived.by(() => { void jsTick; return get(currentTime) })
  let edur = $derived.by(() => { void jsTick; return get(effectiveDuration) })
  let combined = $derived.by(() => { void jsTick; const qq=get(queue); return [...qq.userQueue, ...qq.autoQueue] })
  // Live LDM + effective-stream readout (same decision the URL layer makes).
  let ldm = $derived.by(() => { void jsTick; return get(effectiveLowData) })
  let ldmWhy = $derived.by(() => {
    void jsTick
    const s = get(settings)
    const n = get(networkStatusStore)
    if (!get(effectiveLowData)) return 'off'
    if (s.lowDataMode) return 'man'
    if (n.osLowData) return 'os'
    return n.source === 'native' ? 'cell' : 'hint'
  })
  let streamVariant = $derived.by(() => {
    void jsTick
    const s = get(settings)
    const tp = transcodeParams(
      {
        mode: s.transcodeMode,
        lowDataActive: get(effectiveLowData),
        hasConfig: !!getCachedConfig(),
        probeFailed: s.transcodeProbe?.[s.transcodeFormat ?? 'opus'] === 'unsupported',
      },
      s.transcodeFormat,
      s.transcodeBitrate,
    )
    return tp ? `${tp.format}@${tp.maxBitRate}` : 'original'
  })
  // Bridge trail sampled per tick like the other panels (the trail buffer
  // mutates in place; the snapshot array identity changes each poll).
  let bridgeTrail = $derived.by(() => {
    void jsTick
    return nativeBridgeTrailSnapshot()
  })
  // Thumb loader counters sampled per tick (the snapshot is a plain read of
  // module state; identity changes each poll so the section re-renders).
  let thumbDebug = $derived.by(() => {
    void jsTick
    return getThumbDebug()
  })
</script>

<!--
  2026-09-17 non-blocking rework: the old panel was a full-height tap-eating
  card. The wrapper is now pointer-events-none (taps fall through to the app
  everywhere EXCEPT the ribbon itself), and the default state is a one-line
  ribbon: live status with zero interference while reproducing a bug.
-->
<div class="pointer-events-none fixed bottom-20 right-2 z-[70] w-[min(420px,calc(100vw-16px))]">
  <div class="pointer-events-auto flex items-center gap-2 rounded-lg bg-black/80 px-2 py-1 text-[10px] leading-none text-white shadow-lg ring-1 ring-white/20 backdrop-blur">
    <button onclick={() => (expanded = !expanded)} class="flex items-center gap-1 font-mono font-bold tracking-wide">
      <span>{expanded ? '▾' : '▸'}</span>
      <span class="text-yellow-300">DBG</span>
      <span class={ps === 'playing' ? 'text-green-300' : 'text-white/60'}>{ps}</span>
      <span class="text-white/40">{ctime.toFixed(0)}/{edur.toFixed(0)}s</span>
      <span class="text-white/40">#{q.activeIndex}/{combined.length}</span>
    </button>
    {#if lastTrackChanged}<span class="max-w-[110px] truncate text-green-300" title={lastTrackChanged}>{lastTrackChanged.split(' ').slice(-1)[0]}</span>{/if}
    <span class="flex-1"></span>
    <button onclick={copy} class="rounded bg-white/10 px-1.5 py-0.5 hover:bg-white/20">Copy</button>
    <button onclick={() => onclose?.()} class="rounded bg-white/10 px-1.5 py-0.5 hover:bg-white/20">×</button>
  </div>

  {#if expanded}
    <div class="pointer-events-auto mt-1 max-h-[60vh] overflow-auto rounded-lg bg-black/85 px-3 py-2 font-mono text-[11px] leading-tight text-white shadow-2xl ring-1 ring-white/20 backdrop-blur">
      <div class="mb-1 flex items-center justify-between">
        <span class="font-bold text-yellow-300">{Capacitor.isNativePlatform() ? 'NATIVE' : 'WEB'} · {combined.length} rows</span>
        <span class="flex gap-1">
          <button onclick={clearAll} class="rounded bg-white/10 px-1.5 py-0.5 hover:bg-white/20">Clear all</button>
          <button onclick={clearLog} class="rounded bg-white/10 px-1.5 py-0.5 hover:bg-white/20">Clear</button>
        </span>
      </div>

      <!-- JS summary (single compact block; the full dumps live behind toggles) -->
      <div class="mb-1 rounded bg-white/5 p-2">
        <div>track: <span class="text-cyan-300">{ct?.trackId ?? 'null'}</span> {ct?.title ?? ''}</div>
        <div>state: {ps} time: {ctime.toFixed(2)} / {edur.toFixed(2)}</div>
        <div>activeIndex: {q.activeIndex} / {combined.length} (u:{q.userQueue.length} a:{q.autoQueue.length})</div>
        <div>activeId: {(combined[q.activeIndex] ?? '—')}</div>
        <div>ldm: {ldm ? `on-${ldmWhy}` : 'off'} stream: {streamVariant}</div>
        {#if lastTrackChanged}<div class="text-green-300">{lastTrackChanged}</div>{/if}
      </div>

      <!-- Bridge cmd/event trail (advance-bug diagnosis): cmds = JS positioned
           the engine (engage/refreshQueue@index); events = the engine moved
           itself (trackChanged/ended) or JS reacted (js*). Ordering + gaps
           between entries are the signal. -->
      <div class="mb-1 rounded bg-white/5 p-2">
        <button onclick={() => toggleSection('trail')} class="mb-1 flex w-full items-center justify-between font-bold text-yellow-300">
          <span>{openSections.trail ? '▾' : '▸'} BRIDGE TRAIL ({bridgeTrail.length})</span>
        </button>
        {#if openSections.trail}
          <div class="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[10px]">
            {#each bridgeTrail as e}
              <div class="border-t border-white/5 py-0.5" class:text-orange-300={e.kind === 'cmd'}>
                +{((e.t - (bridgeTrail[0]?.t ?? e.t)) / 1000).toFixed(3)}s {e.kind === 'cmd' ? 'CMD' : 'EVT'} {e.name}
              </div>
            {:else}
              <div class="text-white/30">empty — Clear all resets it</div>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Thumb loader (scroll-gating diagnosis): pending = queue depth,
           blocked = the velocity gate's verdict, visible = the nearest row
           is inside the holdout radius (arms even mid-gesture), armed/dropped
           = session totals. A flick should show visible:true for the
           on-screen rows while blocked holds the pre-roll, then a burst of
           arming when it settles. -->
      <div class="mb-1 rounded bg-white/5 p-2">
        <button onclick={() => toggleSection('thumbs')} class="mb-1 flex w-full items-center justify-between font-bold text-yellow-300">
          <span>{openSections.thumbs ? '▾' : '▸'} THUMBS {thumbDebug ? `(${thumbDebug.pending})` : ''}</span>
        </button>
        {#if openSections.thumbs && thumbDebug}
          <div class="text-[10px]">
            <div>pending: {thumbDebug.pending} state: {thumbDebug.blocked ? (thumbDebug.visibleTier ? 'VISIBLE (scrolling)' : 'BLOCKED (scrolling)') : 'open'}{thumbDebug.stationary ? ' · settled' : ''}</div>
            <div>armed: {thumbDebug.armedTotal} cached: {thumbDebug.cachedTotal} dropped: {thumbDebug.droppedTotal}</div>
            <div>last armed: {thumbDebug.lastArmedAt ? `${Math.floor((Date.now() - thumbDebug.lastArmedAt) / 1000)}s ago` : 'never'}</div>
          </div>
        {/if}
      </div>

      <div class="mb-1 rounded bg-white/5 p-2">
        <button onclick={() => toggleSection('log')} class="mb-1 flex w-full items-center justify-between font-bold text-yellow-300">
          <span>{openSections.log ? '▾' : '▸'} LOG ({errorLog.length})</span>
        </button>
        {#if openSections.log}
          {#if lastError}<div class="mb-1 text-red-300">last: {lastError}</div>{/if}
          <div class="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[10px]">
            {#each errorLog as line}
              <div class="border-t border-white/5 py-0.5">{line}</div>
            {:else}
              <div class="text-white/30">no errors</div>
            {/each}
          </div>
        {/if}
      </div>

      {#if Capacitor.isNativePlatform()}
        <div class="mb-1 rounded bg-white/5 p-2">
          <button onclick={() => toggleSection('native')} class="mb-1 flex w-full items-center justify-between font-bold text-yellow-300">
            <span>{openSections.native ? '▾' : '▸'} NATIVE STATE</span>
          </button>
          {#if openSections.native}
            <pre class="whitespace-pre-wrap break-words text-[10px]">{JSON.stringify(nativeState, null, 1) ?? 'loading…'}</pre>
            <div class="mt-1 border-t border-white/10 pt-1"></div>
            <pre class="whitespace-pre-wrap break-words text-[10px]">{JSON.stringify(nativeDebug, null, 1)}</pre>
          {/if}
        </div>
      {:else}
        <div class="mb-1 rounded bg-white/5 p-2">
          <button onclick={() => toggleSection('native')} class="mb-1 flex w-full items-center justify-between font-bold text-yellow-300">
            <span>{openSections.native ? '▾' : '▸'} WEB audioManager</span>
          </button>
          {#if openSections.native}
            <div>ctx: {audioManager.ctx?.state ?? 'no ctx'} ready:{String(audioManager.webAudioReady)} speed:{audioManager.speed} pitch:{audioManager.pitchOctaves}</div>
            <div>active: {audioManager.activeElement?.src ? 'src yes' : 'no src'} paused:{String(audioManager.activeElement?.paused)} ended:{String(audioManager.activeElement?.ended)} time:{audioManager.activeElement?.currentTime?.toFixed(2) ?? '—'}</div>
            <div>gainA:{audioManager.gainA?.gain.value.toFixed(2) ?? '—'} gainB:{audioManager.gainB?.gain.value.toFixed(2) ?? '—'} preamp:{audioManager.preamp?.gain.value.toFixed(2) ?? '—'}</div>
          {/if}
        </div>
      {/if}

      {#if openSections.js}
        <div class="mb-1 rounded bg-white/5 p-2">
          <button onclick={() => toggleSection('js')} class="mb-1 flex w-full items-center justify-between font-bold text-yellow-300">
            <span>▾ FULL JS QUEUE</span>
          </button>
          <div class="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[10px]">{combined.map((id, i) => `${i === q.activeIndex ? '▶' : ' '} ${i} ${id}`).join('\n')}</div>
        </div>
      {/if}

      <div class="rounded bg-white/5 p-2 text-[10px] text-white/70">
        <button onclick={() => toggleSection('js')} class="mr-2 underline">{openSections.js ? 'hide' : 'show'} full JS queue</button>
        Multi-skip repro: clear queue → restart app → skip → let it play through, ribbon stays up the whole time; Copy right after the jump. TRAIL read: engine trackChanged events with NO cmd between them = engine advanced itself; a CMD (engage/refreshQueue) with a far index = JS positioned it.
      </div>
    </div>
  {/if}
</div>

<style>
  pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>

import { mount } from 'svelte'
import './app.css'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource-variable/geist-mono'
import '@fontsource/fira-code/400.css'
import '@fontsource/fira-code/500.css'
import '@fontsource/roboto-mono/400.css'
import '@fontsource/roboto-mono/500.css'
import '@fontsource-variable/inter'
import '@fontsource-variable/space-grotesk'
import { Capacitor } from '@capacitor/core'
import { initAppearance } from './lib/appearance'

document.body.style.backgroundColor = '#000000'

void initAppearance()

// Review fixtures never mount App: no store hydration, queue restore, or
// playback boot. Vite removes this development-only branch from production.
const uiReview = import.meta.env.DEV && new URLSearchParams(location.search).has('uiPreview')
const app = (uiReview
  ? import('./components/UiReview.svelte')
  : import('./App.svelte')
).then(({ default: Root }) => mount(Root, { target: document.getElementById('app')! }))

// Skip service worker in the native Capacitor app (local WKWebView is not network-deployed)
if (!uiReview && 'serviceWorker' in navigator && !Capacitor.isNativePlatform() && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
  navigator.serviceWorker.register('sw.js')
}

export default app

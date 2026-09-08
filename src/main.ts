import { mount } from 'svelte'
import './app.css'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import App from './App.svelte'
import { Capacitor } from '@capacitor/core'
import { initAppearance } from './lib/appearance'

document.body.style.backgroundColor = '#000000'

void initAppearance()

const app = mount(App, {
  target: document.getElementById('app')!,
})

// Skip service worker in the native Capacitor app (local WKWebView is not network-deployed)
if ('serviceWorker' in navigator && !Capacitor.isNativePlatform() && !location.hostname.includes('localhost')) {
  navigator.serviceWorker.register('sw.js')
}

export default app

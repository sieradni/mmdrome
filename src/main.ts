import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { Capacitor } from '@capacitor/core'

document.body.style.backgroundColor = '#000000'

const app = mount(App, {
  target: document.getElementById('app')!,
})

// Skip service worker in the native Capacitor app (local WKWebView is not network-deployed)
if ('serviceWorker' in navigator && !Capacitor.isNativePlatform() && !location.hostname.includes('localhost')) {
  navigator.serviceWorker.register('sw.js')
}

export default app

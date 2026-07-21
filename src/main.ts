import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

document.body.style.backgroundColor = '#000000'

const app = mount(App, {
  target: document.getElementById('app')!,
})

if ('serviceWorker' in navigator && !location.hostname.includes('localhost')) {
  navigator.serviceWorker.register('sw.js')
}

export default app

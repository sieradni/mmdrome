import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

document.body.style.backgroundColor = '#000000'

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app

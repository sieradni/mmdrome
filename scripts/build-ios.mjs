import { execSync } from 'child_process'

// iOS loads the bundle from capacitor://localhost/ (or http://localhost/), so
// absolute paths like /mmdrome/assets/... would 404 and render a white screen.
// Build with a relative base so all asset URLs resolve against the webview root.
execSync('npx vite build', {
  stdio: 'inherit',
  env: { ...process.env, VITE_BASE: './' },
})

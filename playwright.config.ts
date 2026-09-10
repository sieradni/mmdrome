import { defineConfig } from '@playwright/test'

/**
 * Thin production-bundle smoke test. The webServer builds the real deploy
 * artifact (`npm run build`, base `/mmdrome/` — the gh-pages path) and serves
 * it via `vite preview` at `/mmdrome/`, so the spec runs the actual bundled
 * output, not source ESM. That distinction matters: a module-eval cycle that
 * crosses a singleton read throws a TDZ ReferenceError under Node's ESM loader
 * but silently resolves the cyclic binding to `undefined` in the bundle — only
 * this gate exercises the bundled behavior (see AGENTS.md F2b).
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  // `list` keeps CI console output readable; `json` feeds the failure step
  // in test.yml, which surfaces failing specs as check annotations (job
  // logs need auth to read via the API — annotations do not).
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    baseURL: 'http://localhost:4173',
    // Playwright launches Chromium with user-gesture-required autoplay, so
    // every play() past transient-activation expiry (~5 s after the last
    // click) rejects with NotAllowedError. Nothing in this suite tests
    // autoplay denial (the policy behavior is unit-pinned instead), but the
    // expiry window makes recovery paths timing-flaky under load: a
    // decode-failure rescue whose play() lands outside the window dies on
    // policy instead of proving the rescue. Allow autoplay so every play()
    // succeeds-or-decode-fails on its own merits, deterministically — the
    // same posture production has once playback is engaged (crossfade
    // standbys play with zero gestures there too).
    launchOptions: {
      args: ['--autoplay-policy=no-user-gesture-required'],
    },
  },
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173/mmdrome/',
    // Always start a fresh server: this gate's whole point is to boot the JUST
    // built bundle, so silently reusing whatever happens to be on :4173 (e.g.
    // a stale preview serving old dist) would report green against the wrong
    // build. With --strictPort a port conflict fails loudly instead.
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})

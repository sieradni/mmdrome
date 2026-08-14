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
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173',
  },
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173/mmdrome/',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})

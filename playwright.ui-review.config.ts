import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/ui-review',
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5180', browserName: 'chromium' },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5180 --strictPort',
    url: 'http://127.0.0.1:5180/mmdrome/',
    reuseExistingServer: false,
  },
})

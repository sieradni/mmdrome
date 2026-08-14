import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { readFileSync } from 'fs'
import { execSync } from 'child_process'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))
let commitHash = 'unknown'
try {
  commitHash = execSync('git rev-parse --short HEAD').toString().trim()
} catch { /* not a git repo or git unavailable */ }

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  // Web deploy uses '/mmdrome/' (gh-pages); native builds pass VITE_BASE=./ for file/webview loading
  base: process.env.VITE_BASE ?? '/mmdrome/',
  resolve: {
    alias: {
      $lib: path.resolve('./src/lib'),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __COMMIT_HASH__: JSON.stringify(commitHash),
  },
  build: {
    rollupOptions: {
      // Rolldown's circular-dependency check is OFF by default, so a module
      // import cycle ships silently — and a cycle that crosses a module-eval
      // singleton read resolves the cyclic binding to `undefined` in the
      // bundle (the 2026-08-14 `_stm is undefined` outage). Enable the check
      // and escalate the warning to a hard build failure.
      checks: { circularDependency: true },
      onLog(level, log, defaultHandler) {
        if (log.code === 'CIRCULAR_DEPENDENCY') {
          // node_modules packages (e.g. Svelte itself) ship intentional, benign
          // cycles — those are out of scope. Only a cycle touching our own
          // `src/` is the module-eval hazard this gate exists to catch.
          const ids = log.ids ?? (log.id ? [log.id] : [])
          const srcPrefix = path.resolve('src').replace(/\\/g, '/') + '/'
          const projectIds = ids.filter((id) => id.replace(/\\/g, '/').startsWith(srcPrefix))
          if (projectIds.length > 0) {
            const root = process.cwd().replace(/\\/g, '/') + '/'
            throw new Error(
              `Circular dependency detected in src: ${projectIds.map((id) => id.replace(root, '')).join(' -> ')}`,
            )
          }
          return
        }
        defaultHandler(level, log)
      },
    },
  },
})

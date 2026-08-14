/**
 * Minimal ESM resolve hook so `node --test` can import the app's TypeScript
 * modules with extensionless relative specifiers (the Vite-style convention
 * used throughout src/). Node 24's built-in type stripping handles the
 * .ts → JS transform; this hook only appends candidate extensions.
 *
 * Non-relative specifiers (bare package imports like `svelte/store`) and
 * specifiers that already carry an extension are delegated untouched.
 *
 * Usage: `node --test --import ./scripts/test-loader.mjs tests/` — the module
 * self-registers (`module.register`) because `--import` alone only evaluates
 * the module; hooks must be registered explicitly.
 */

import { register } from 'node:module'

register(new URL('./test-loader.mjs', import.meta.url))

const HAS_EXT = /\.[a-z0-9]+$/i

/** Resolves the Vite `$lib` alias (`src/lib/`) so store modules reachable
 *  from tests (e.g. `../stores/appState` → `$lib/db`) load in Node. */
const SRC_DIR = new URL('../src/lib/', import.meta.url)

function candidates(specifier) {
  if (specifier.startsWith('$lib/')) {
    const rest = specifier.slice(5)
    return [new URL(rest, SRC_DIR).href, new URL(`${rest}.ts`, SRC_DIR).href]
  }
  if (!specifier.startsWith('.')) return []
  if (HAS_EXT.test(specifier)) return [specifier]
  return [specifier, `${specifier}.ts`, `${specifier}.js`, `${specifier}/index.ts`, `${specifier}/index.js`]
}

export async function resolve(specifier, context, nextResolve) {
  for (const cand of candidates(specifier)) {
    try {
      return await nextResolve(cand, context)
    } catch (err) {
      if (cand === specifier && HAS_EXT.test(specifier)) throw err
    }
  }
  return nextResolve(specifier, context)
}

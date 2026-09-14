#!/usr/bin/env node
/**
 * Web deploy: `dist/` → the gh-pages branch, WITHOUT the tag spam.
 *
 * The `gh-pages` CLI hardcodes `git push --tags <remote> <branch>`
 * (node_modules/gh-pages/lib/git.js), so every deploy re-pushed EVERY local
 * tag and died on the first one that already existed on the remote under a
 * different commit — the documented `ios-v1.1.0 already exists` rejection.
 * The branch push itself succeeded, so deploys "worked", but every run ended
 * in a git error.
 *
 * This script uses the library API with `push: false`: the branch is
 * prepared inside the module's own cache clone (fetch → checkout → copy →
 * commit), then THAT clone's gh-pages ref is pushed explicitly — tags are
 * never included.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ghpages from 'gh-pages'

const execFileP = promisify(execFile)

await new Promise((resolve, reject) => {
  ghpages.publish('dist', { push: false }, (err) => (err ? reject(err) : resolve()))
})

// The clone lives at <cache>/<filenamified repo URL> — getCacheDir() with no
// args returns only the PARENT (not a git repo; a `git -C` there would climb
// into the source repo and push the WRONG ref). Resolve the repo URL the same
// way the library does (the origin remote of the cwd) and key the cache with
// it, exactly as `getCacheDir(repo)` does inside publish().
const { stdout: repoUrl } = await execFileP('git', ['remote', 'get-url', 'origin'])
const cacheDir = ghpages.getCacheDir(repoUrl.trim())
console.log('Pushing gh-pages (refs only, no tags)...')
// The clone checks out origin/gh-pages as a DETACHED HEAD and commits on it —
// there is no local `gh-pages` branch, so push HEAD to the remote branch.
await execFileP('git', ['-C', cacheDir, 'push', 'origin', 'HEAD:refs/heads/gh-pages'], { stdio: 'inherit' })
console.log('Deployed.')

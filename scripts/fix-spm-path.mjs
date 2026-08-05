/**
 * Post-sync fix: `npx cap sync` regenerates ios/App/CapApp-SPM/Package.swift and
 * computes local plugin paths with Node's `path.relative()`. On Windows that
 * yields backslashes (e.g. "..\..\..\native\BackgroundAudio"), which SPM cannot
 * resolve. This script normalizes backslashes to forward slashes in every
 * `path:` entry of the generated Package.swift. On macOS the output is already
 * POSIX-clean, so this is a no-op there.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const packagePath = resolve('ios/App/CapApp-SPM/Package.swift')
const text = readFileSync(packagePath, 'utf8')
const fixed = text.replace(/path: "([^"]*)"/g, (match, value) => {
  const normalized = value.replace(/\\/g, '/')
  return normalized === value ? match : `path: "${normalized}"`
})
if (fixed !== text) {
  writeFileSync(packagePath, fixed)
  console.log('fix-spm-path: normalized backslash paths in Package.swift')
} else {
  console.log('fix-spm-path: Package.swift already POSIX-clean')
}

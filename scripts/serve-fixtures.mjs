#!/usr/bin/env node
/**
 * Serve the local Navidrome + WebDAV fixtures on the LAN so a REAL device can
 * talk to a real server (`npm run device -- --web --fixtures` starts this for
 * you; run it directly when you only want the servers).
 *
 * Run through the test loader, because the servers are the same ones the e2e
 * suite uses:
 *   node --import ./scripts/test-loader.mjs scripts/serve-fixtures.mjs
 *
 * It binds 0.0.0.0 on ephemeral ports and prints:
 *   FIXTURE_URLS {"subsonicUrl":"http://<lan>:<p>","webdavBaseUrl":"http://<lan>:<p>/dav/"}
 * Point the app's Navidrome URL at the first and its WebDAV URL at the second.
 * Two generated songs are served; any credentials are accepted.
 */

import { networkInterfaces } from 'node:os'
import { startLocalServers } from '../tests/e2e/localServers.ts'

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return '127.0.0.1'
}

const servers = await startLocalServers({ host: '0.0.0.0' })
const lan = lanAddress()
const urls = {
  subsonicUrl: servers.subsonicUrl.replace('127.0.0.1', lan),
  webdavBaseUrl: servers.webdavBaseUrl.replace('127.0.0.1', lan),
}

process.stdout.write(`FIXTURE_URLS ${JSON.stringify(urls)}\n`)
process.stdout.write(`songs: ${servers.storedPaths().join(', ')}\n`)
process.stdout.write('Ctrl+C to stop.\n')

const stop = async () => {
  await servers.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

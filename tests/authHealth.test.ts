// Pins the pure auth-health ledger (Navidrome 0.64.1 companion): a Subsonic
// code 40 is the server's AUTHORITATIVE "credentials rejected" — every gated
// caller must stop hitting the server until the user changes credentials or a
// connect succeeds. Transient failures (code 0 / network) must NEVER park the
// credentials (a blip is not a rejection).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  recordAuthOutcome,
  markAuthSuccess,
  resetCredentials,
  credentialsHealthy,
  authUnhealthyDetail,
  authBaseKey,
  classifyConnectFailure,
  __setAuthHealthClockForTests,
  __resetAuthHealthForTests,
} from '../src/lib/authHealth'

test('classifyConnectFailure: a rejected credential is not an unreachable server', () => {
  // Subsonic code 40 — the server's authoritative rejection (recordAuthOutcome's input).
  assert.equal(classifyConnectFailure(40), 'auth')
  // HTTP 401/403 arrive through the transport branch (code 0), where the STATUS
  // is the only evidence — a proxy rejecting the login, or a WebDAV PROPFIND
  // (which passes no Subsonic code at all).
  assert.equal(classifyConnectFailure(0, 401), 'auth')
  assert.equal(classifyConnectFailure(0, 403), 'auth')
  assert.equal(classifyConnectFailure(undefined, 401), 'auth', 'WebDAV has no Subsonic code')
  // Everything transient stays an outage: a retry may work, and the copy must
  // not send the user to re-type a password that is fine.
  assert.equal(classifyConnectFailure(0), 'unreachable', 'network/timeout (code 0, no status)')
  assert.equal(classifyConnectFailure(undefined, 500), 'unreachable')
  assert.equal(classifyConnectFailure(0, 404), 'unreachable')
  assert.equal(classifyConnectFailure(70), 'unreachable', 'unknown Subsonic code')
  // The rejection wins when both signals are present.
  assert.equal(classifyConnectFailure(40, 500), 'auth')
})

test('recordAuthOutcome discriminates the park transition for the danger log', () => {
  __resetAuthHealthForTests()
  assert.equal(recordAuthOutcome('srv|u', 40, 'no'), 'parked', 'first rejection = the one-time danger transition')
  assert.equal(recordAuthOutcome('srv|u', 40, 'no again'), 'already-parked', 'repeats dedupe — no ring spam')
  assert.equal(recordAuthOutcome('srv|u', 0, 'HTTP 503'), 'ignored', 'transient outcomes are not transitions')
  markAuthSuccess('srv|u')
  assert.equal(recordAuthOutcome('srv|u', 40, 'again after success'), 'parked', 'a fresh park after recovery is a new transition')
})

test('a code-40 outcome marks the credentials unhealthy', () => {
  __resetAuthHealthForTests()
  recordAuthOutcome('srv|u', 40, 'Wrong username or password')
  assert.equal(credentialsHealthy('srv|u'), false)
  assert.equal(authUnhealthyDetail('srv|u'), 'Wrong username or password')
})

test('transient outcomes never park the credentials', () => {
  __resetAuthHealthForTests()
  recordAuthOutcome('srv|u', 0, 'HTTP 503')
  recordAuthOutcome('srv|u', 70, 'Data not found')
  assert.equal(credentialsHealthy('srv|u'), true)
})

test('a successful connect clears the unhealthy state', () => {
  __resetAuthHealthForTests()
  recordAuthOutcome('srv|u', 40, 'no')
  assert.equal(credentialsHealthy('srv|u'), false)
  markAuthSuccess('srv|u')
  assert.equal(credentialsHealthy('srv|u'), true)
  assert.equal(authUnhealthyDetail('srv|u'), undefined)
})

test('resetCredentials clears the state (user committed new credentials)', () => {
  __resetAuthHealthForTests()
  recordAuthOutcome('srv|u', 40, 'no')
  resetCredentials('srv|u')
  assert.equal(credentialsHealthy('srv|u'), true)
})

test('re-recording a rejection keeps the FIRST timestamp (no sliding window)', () => {
  __resetAuthHealthForTests()
  let t = 1000
  __setAuthHealthClockForTests(() => t)
  recordAuthOutcome('srv|u', 40, 'first')
  t = 999_999
  recordAuthOutcome('srv|u', 40, 'second')
  assert.equal(authUnhealthyDetail('srv|u'), 'first', 'first rejection recorded wins')
  __setAuthHealthClockForTests()
})

test('baseKeys are isolated — another server is unaffected', () => {
  __resetAuthHealthForTests()
  recordAuthOutcome('srv-a|u', 40, 'no')
  assert.equal(credentialsHealthy('srv-a|u'), false)
  assert.equal(credentialsHealthy('srv-b|u'), true)
})

test('authBaseKey matches the library-cache identity primitive', () => {
  assert.equal(authBaseKey(' https://srv ', ' u '), 'https://srv|u')
})

test('recordAuthOutcome does not resurrect a parked key via later transient outcomes', () => {
  __resetAuthHealthForTests()
  recordAuthOutcome('srv|u', 40, 'no')
  recordAuthOutcome('srv|u', 0, 'HTTP 500')
  assert.equal(credentialsHealthy('srv|u'), false, 'only markAuthSuccess/resetCredentials clear')
})

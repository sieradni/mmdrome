import { writable } from 'svelte/store'
import { get } from 'svelte/store'
import { Capacitor } from '@capacitor/core'
import { settings } from '../stores/appState'
import { getSetting, setSetting, deleteSetting } from './db'
import {
  AUTH_POLL_INTERVAL_MS,
  AUTH_POLL_TIMEOUT_MS,
  nextAuthStep,
  type AuthPollResult,
  type LfmCreds,
  type LfmSession,
} from './lastfmCore'
import { lfmGetToken, lfmGetSession, lfmAuthUrl, LastfmError } from './lastfmApi'

/**
 * Last.fm account orchestration for the DESKTOP auth flow (the docs bless
 * mobile clients using it): `auth.getToken` -> open the approval page in a
 * browser -> poll `auth.getSession` every 3 s until the token is authorized
 * (error 14) or the window closes. No callback URL is involved - the user
 * simply returns to the app while the poll runs.
 *
 * The session key has no server-side expiry; it lives in Dexie under one
 * settings row and is restored at app init (`restoreLfmSession`).
 */

export const DEFAULT_LFM_API_KEY = '0e701f798ed495a7fa9f9a7660e20d78'
export const DEFAULT_LFM_SECRET = 'e4c8a2dc535e02bbeacfcfd46875fe7e'

const SESSION_SETTING_KEY = 'lastfmSession'

/** BYO override (Settings advanced fields) wins over the compiled defaults. */
export function effectiveLfmCreds(): LfmCreds {
  const s = get(settings)
  return {
    apiKey: typeof s.lastfmApiKey === 'string' && s.lastfmApiKey.trim() ? s.lastfmApiKey.trim() : DEFAULT_LFM_API_KEY,
    secret: typeof s.lastfmApiSecret === 'string' && s.lastfmApiSecret.trim() ? s.lastfmApiSecret.trim() : DEFAULT_LFM_SECRET,
  }
}

let cachedSession: LfmSession | null = null

export function getCachedLfmSession(): LfmSession | null {
  return cachedSession
}

export const lastfmAuthPhase = writable<'idle' | 'awaiting' | 'connected'>('idle')

/**
 * The approval URL of the in-flight connect, exposed so the UI can render a
 * manual link: `window.open` runs AFTER the awaited `getToken` round-trip, and
 * popup blockers may refuse it — the user then taps the link instead.
 */
export const pendingAuthUrl = writable<string | null>(null)

export async function restoreLfmSession(): Promise<void> {
  try {
    const raw = await getSetting<{ key?: unknown; name?: unknown }>(SESSION_SETTING_KEY)
    if (raw && typeof raw.key === 'string' && typeof raw.name === 'string') {
      cachedSession = { key: raw.key, name: raw.name }
      lastfmAuthPhase.set('connected')
    }
  } catch {
    // Non-fatal: scrobbling stays disabled until a successful connect.
  }
}

export async function disconnectLfm(): Promise<void> {
  connectGen++
  cachedSession = null
  pendingAuthUrl.set(null)
  try {
    await deleteSetting(SESSION_SETTING_KEY)
  } catch {
    // The in-memory session is gone regardless; a stale row is inert.
  }
  lastfmAuthPhase.set('idle')
}

interface ConnectDeps {
  now?: () => number
  delay?: (ms: number) => Promise<void>
  openUrl?: (url: string) => void | Promise<void>
  /** Injectable seams for tests — default to the real signed API calls. */
  getToken?: () => Promise<string>
  getSession?: (token: string) => Promise<LfmSession>
}

let connectGen = 0

function defaultOpenUrl(url: string): void | Promise<void> {
  if (Capacitor.isNativePlatform()) {
    void import('@capacitor/browser')
      .then(({ Browser }) => Browser.open({ url }))
      .catch(() => window.open(url, '_blank'))
    return
  }
  window.open(url, '_blank', 'noopener')
}

/**
 * Runs the full connect flow. Resolves once connected; throws with a
 * human-facing reason on denial / fatal error / timeout. A superseded flow
 * (new connect or disconnect mid-flight) silently abandons its generation.
 */
export async function connectLfm(deps?: ConnectDeps): Promise<void> {
  const gen = ++connectGen
  const now = deps?.now ?? Date.now
  const delay = deps?.delay ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const openUrl = deps?.openUrl ?? defaultOpenUrl

  lastfmAuthPhase.set('awaiting')
  try {
    const creds = effectiveLfmCreds()
    const token = deps?.getToken ? await deps.getToken() : await lfmGetToken(creds)
    if (gen !== connectGen) return
    const authUrl = lfmAuthUrl(creds.apiKey, token)
    pendingAuthUrl.set(authUrl)
    await openUrl(authUrl)
    const startedAt = now()

    while (true) {
      await delay(AUTH_POLL_INTERVAL_MS)
      if (gen !== connectGen) return
      let result: AuthPollResult | null = null
      try {
        const session = deps?.getSession ? await deps.getSession(token) : await lfmGetSession(creds, token)
        result = { ok: true, session }
      } catch (err) {
        // Transport-level failures stay silent (keep polling); API errors are
        // fed to the decision machine.
        if (err instanceof LastfmError) result = { ok: false, code: err.code }
      }
      // A disconnect/supersede landing DURING the getSession await must not
      // resurrect the session — re-check before acting on the result.
      if (gen !== connectGen) return
      const elapsed = now() - startedAt
      if (elapsed >= AUTH_POLL_TIMEOUT_MS && (!result || !result.ok)) {
        throw new Error('Timed out waiting for Last.fm authorization')
      }
      const step = nextAuthStep(result, elapsed)
      if (step === 'poll') continue
      if (step.step === 'done') {
        cachedSession = step.session
        await setSetting(SESSION_SETTING_KEY, step.session)
        lastfmAuthPhase.set('connected')
        pendingAuthUrl.set(null)
        return
      }
      throw new Error(step.reason)
    }
  } catch (err) {
    if (gen === connectGen) {
      lastfmAuthPhase.set('idle')
      pendingAuthUrl.set(null)
    }
    throw err instanceof Error ? err : new Error(String(err))
  }
}

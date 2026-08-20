export interface WebdavCredentials {
  url: string
  user: string
  token: string
}

export interface WebdavSession extends WebdavCredentials {
  baseKey: string
  generation: number
}

/** Normalize only the fields whose whitespace is not part of the credential. */
export function normalizeWebdavCredentials(url: string, user: string, token: string): WebdavCredentials {
  return { url: url.trim(), user: user.trim(), token }
}

/** A repeated configuration of the same server identity and token is a no-op. */
export function sameWebdavCredentials(a: WebdavCredentials, b: WebdavCredentials): boolean {
  return a.url === b.url && a.user === b.user && a.token === b.token
}

/** Reject work captured before a generation or credential change. */
export function isCurrentWebdavSession(
  session: WebdavSession,
  current: WebdavCredentials,
  generation: number,
): boolean {
  return session.generation === generation && sameWebdavCredentials(session, current)
}

export function webdavFetch(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer))
}

export function authHeaders(user: string, token: string): Record<string, string> {
  return { Authorization: `Basic ${btoa(`${user}:${token}`)}` }
}

export function normalizeUrl(base: string): string {
  return base.replace(/\/+$/, "")
}

export function buildWebdavUrl(baseUrl: string, filePath: string): string {
  const encodedPath = filePath.split("/").map((s) => encodeURIComponent(s)).join("/")
  return `${normalizeUrl(baseUrl)}/${encodedPath.replace(/^\/+/, "")}`
}

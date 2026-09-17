/**
 * THE PORTAL'S ONE WAY TO CALL ITS OWN API (Codex round 13 #7).
 *
 * The daemon is shared: every browser gets its own profile identity and only the
 * instance OWNER may write settings, control the daemon or decide a change
 * review (plan 6.14, src/channels/web/instance-access.ts). The identity travels
 * as a verified pair — `x-strada-profile-id` / `x-strada-profile-token` — and the
 * portal used to send it over the WebSocket only. Every HTTP call was therefore
 * anonymous, and the moment a second browser appeared the OWNER's own settings
 * page and change-review decisions came back 403: the shared instance locked out
 * the person who set it up. Not sending the credentials was also the reason the
 * server had to grant unattributed requests on a one-identity instance, which is
 * the hole round 13 #9 closed.
 *
 * So the pair is attached HERE, once, and `apiFetch` is what the portal calls —
 * including the modules that used to call `fetch` directly. The credentials go
 * only to SAME-ORIGIN `/api/` requests: a relative path, or an absolute URL whose
 * origin is this page's. An absolute URL to anywhere else gets nothing, so a
 * caller that is handed a foreign base URL cannot leak the session token.
 */
const PROFILE_ID_STORAGE_KEY = 'strada-profileId'
const PROFILE_TOKEN_STORAGE_KEY = 'strada-profileToken'

export interface SessionCredentials {
  profileId: string
  profileToken: string
}

/**
 * The verified pair this browser holds, or null. Both halves are required: an id
 * without its token proves nothing (the id is public — the server sends it to the
 * client and it sits in localStorage), and the server refuses a half pair.
 */
export function readSessionCredentials(): SessionCredentials | null {
  if (typeof window === 'undefined') return null
  try {
    const profileId = window.localStorage.getItem(PROFILE_ID_STORAGE_KEY)?.trim()
    const profileToken = window.localStorage.getItem(PROFILE_TOKEN_STORAGE_KEY)?.trim()
    if (!profileId || !profileToken) return null
    return { profileId, profileToken }
  } catch {
    // Private mode / disabled storage: no credentials, not a crash.
    return null
  }
}

/** Whether `url` addresses this page's own API — the only place credentials go. */
export function isSameOriginApiRequest(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0) return false
  if (url.startsWith('//')) return false
  if (url.startsWith('/')) return url.startsWith('/api/') || url === '/api'
  try {
    const origin = typeof window === 'undefined' ? undefined : window.location.origin
    if (!origin) return false
    const resolved = new URL(url, origin)
    return resolved.origin === origin && resolved.pathname.startsWith('/api')
  } catch {
    return false
  }
}

/** `headers` with the session pair added when this request may carry it. */
function withSessionCredentials(url: string, headers: HeadersInit | undefined): HeadersInit | undefined {
  if (!isSameOriginApiRequest(url)) return headers
  const credentials = readSessionCredentials()
  if (!credentials) return headers
  const merged = new Headers(headers)
  // An explicit header wins: a caller acting for a specific identity (a test, a
  // future admin view) is not overridden by whatever this tab has stored.
  if (!merged.has('x-strada-profile-id')) merged.set('x-strada-profile-id', credentials.profileId)
  if (!merged.has('x-strada-profile-token')) merged.set('x-strada-profile-token', credentials.profileToken)
  return merged
}

/**
 * `fetch` for this portal's own API: identical semantics, plus the identity.
 *
 * Every portal module that talks to `/api/...` must go through this (or through
 * `fetchJson`, which does). A bare `fetch('/api/…')` is an unattributed request
 * and, on a shared instance, a 403 the user cannot explain — `api.identity.test.ts`
 * fails the build when one appears.
 */
export function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const { headers, ...rest } = options
  const withCredentials = withSessionCredentials(url, headers)
  const init: RequestInit = { ...rest, ...(withCredentials ? { headers: withCredentials } : {}) }
  // A pure passthrough when there is nothing to add: `apiFetch(url)` is then
  // exactly `fetch(url)`, one argument included, so a caller (or a test) that
  // inspects the call sees what it wrote.
  return Object.keys(init).length === 0 ? fetch(url) : fetch(url, init)
}

export interface FetchJsonOptions extends RequestInit {
  signal?: AbortSignal
}

export class FetchJsonError extends Error {
  readonly status?: number
  readonly url: string

  constructor(message: string, url: string, status?: number) {
    super(message)
    this.name = 'FetchJsonError'
    this.url = url
    this.status = status
  }
}

async function buildFetchJsonError(url: string, res: Response): Promise<FetchJsonError> {
  let message = `Request failed with status ${res.status}`

  try {
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      const body = await res.json() as { error?: string; message?: string }
      message = body.error ?? body.message ?? message
    } else {
      const text = (await res.text()).trim()
      if (text) message = text
    }
  } catch {
    // Fall back to the default HTTP status message when parsing fails.
  }

  return new FetchJsonError(message, url, res.status)
}

export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T | null> {
  const { headers, cache, ...rest } = options
  let res: Response

  try {
    res = await apiFetch(url, {
      ...rest,
      cache: cache ?? 'no-store',
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
        ...(headers ?? {}),
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Network request failed'
    throw new FetchJsonError(message, url)
  }

  if (res.status === 204) return null
  if (!res.ok) throw await buildFetchJsonError(url, res)

  try {
    return await res.json() as T
  } catch {
    throw new FetchJsonError('Invalid JSON response', url, res.status)
  }
}

export function settledValue<T>(result: PromiseSettledResult<T | null>): T | null {
  return result.status === 'fulfilled' ? result.value : null
}

export function firstSettledError(results: PromiseSettledResult<unknown>[]): string | null {
  for (const result of results) {
    if (result.status === 'rejected') {
      return result.reason instanceof Error ? result.reason.message : String(result.reason)
    }
  }
  return null
}

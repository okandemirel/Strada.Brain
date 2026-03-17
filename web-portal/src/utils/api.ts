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
    res = await fetch(url, {
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

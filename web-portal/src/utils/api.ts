export interface FetchJsonOptions extends RequestInit {
  signal?: AbortSignal
}

export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T | null> {
  const { headers, cache, ...rest } = options

  try {
    const res = await fetch(url, {
      ...rest,
      cache: cache ?? 'no-store',
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
        ...(headers ?? {}),
      },
    })
    if (!res.ok) return null
    return await res.json() as T
  } catch {
    return null
  }
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const parts: string[] = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  parts.push(`${m}m`)
  return parts.join(' ')
}

export function formatTimeAgo(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

type TimeTFunction = (key: string, options?: { count: number }) => string

/**
 * Localized "X {unit} ago" formatter.
 *
 * Takes a **duration** in milliseconds (not a timestamp) — typically
 * `now - lastSyncAt` — and ladders up through the unit scale:
 *   <60s  → `common:time.xSecondsAgo`
 *   <60m  → `common:time.xMinutesAgo`
 *   <24h  → `common:time.xHoursAgo`
 *   else  → `common:time.xDaysAgo`
 *
 * All four keys rely on i18next's pluralization (`_one` / `_other`) so the
 * caller doesn't need to spell out singular vs. plural forms. Pass the `t`
 * bound to the caller's default namespace; the keys are namespaced inline.
 */
export function formatRelativeI18n(ms: number, t: TimeTFunction): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return t('common:time.xSecondsAgo', { count: sec })
  const min = Math.floor(sec / 60)
  if (min < 60) return t('common:time.xMinutesAgo', { count: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('common:time.xHoursAgo', { count: hr })
  return t('common:time.xDaysAgo', { count: Math.floor(hr / 24) })
}

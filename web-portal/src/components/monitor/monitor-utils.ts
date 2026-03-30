export const STATUS_STYLES: Record<string, string> = {
  pending: 'border-white/10 bg-white/5 text-text-secondary',
  executing: 'border-accent/20 bg-accent/10 text-accent',
  verifying: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
  completed: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
  failed: 'border-rose-400/25 bg-rose-400/10 text-rose-300',
  skipped: 'border-white/10 bg-white/5 text-text-tertiary',
  blocked: 'border-orange-400/25 bg-orange-400/10 text-orange-300',
  cancelled: 'border-white/10 bg-white/5 text-text-tertiary',
  paused: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
  waiting_for_input: 'border-sky-400/25 bg-sky-400/10 text-sky-300',
}

export const REVIEW_STYLES: Record<string, string> = {
  none: 'border-white/10 bg-white/5 text-text-secondary',
  spec_review: 'border-sky-400/25 bg-sky-400/10 text-sky-300',
  quality_review: 'border-violet-400/25 bg-violet-400/10 text-violet-300',
  review_passed: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
  passed: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
  failed: 'border-rose-400/25 bg-rose-400/10 text-rose-300',
  review_stuck: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
}

export function formatClockTime(value?: number): string | null {
  if (value == null) return null
  return new Date(value).toLocaleTimeString()
}

export function formatElapsed(value?: number): string | null {
  if (value == null) return null
  if (value < 1000) return `${value}ms`
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`
}

export function normalizeLabel(value: string): string {
  return value.replace(/_/g, ' ')
}

const RESULT_MAX_CHARS = 50_000

export function resultToString(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') {
    return value.length > RESULT_MAX_CHARS ? value.slice(0, RESULT_MAX_CHARS) + '\n... [truncated]' : value
  }
  try {
    const json = JSON.stringify(value, null, 2)
    return json.length > RESULT_MAX_CHARS ? json.slice(0, RESULT_MAX_CHARS) + '\n... [truncated]' : json
  } catch {
    return String(value)
  }
}

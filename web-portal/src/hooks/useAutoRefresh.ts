import { useEffect, useRef } from 'react'

interface UseAutoRefreshOptions {
  intervalMs: number
  enabled?: boolean
}

export function useAutoRefresh(
  refresh: () => void | Promise<void>,
  { intervalMs, enabled = true }: UseAutoRefreshOptions,
): void {
  const refreshRef = useRef(refresh)
  const inFlightRef = useRef(false)

  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  useEffect(() => {
    if (!enabled) return

    const runRefresh = () => {
      if (inFlightRef.current) return
      inFlightRef.current = true
      Promise.resolve(refreshRef.current()).finally(() => {
        inFlightRef.current = false
      })
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        runRefresh()
      }
    }

    runRefresh()

    const interval = window.setInterval(runRefresh, intervalMs)
    window.addEventListener('focus', runRefresh)
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', runRefresh)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [enabled, intervalMs])
}

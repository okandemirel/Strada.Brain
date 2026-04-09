import { useSyncExternalStore, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { TypingAnimation } from './ui/typing-animation'
import { useSessionStore } from '../stores/session-store'

const SLOW_THRESHOLD_MS = 90_000 // 90 seconds
const TICK_INTERVAL_MS = 1000

/** External store for elapsed time — avoids setState inside useEffect. */
const elapsedStore = (() => {
  let elapsed = 0
  let intervalId: ReturnType<typeof setInterval> | undefined
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach(cb => cb())

  return {
    subscribe(cb: () => void) {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
    getSnapshot() { return elapsed },
    start(startedAt: number) {
      if (intervalId) clearInterval(intervalId)
      elapsed = Date.now() - startedAt
      notify()
      intervalId = setInterval(() => {
        elapsed = Date.now() - startedAt
        notify()
      }, TICK_INTERVAL_MS)
    },
    stop() {
      if (intervalId) clearInterval(intervalId)
      intervalId = undefined
      if (elapsed !== 0) { elapsed = 0; notify() }
    },
  }
})()

export default function TypingIndicator() {
  const { t } = useTranslation()
  const typingStartedAt = useSessionStore((s) => s.typingStartedAt)
  const elapsed = useSyncExternalStore(elapsedStore.subscribe, elapsedStore.getSnapshot)

  useEffect(() => {
    if (typingStartedAt) {
      elapsedStore.start(typingStartedAt)
    } else {
      elapsedStore.stop()
    }
    return () => { elapsedStore.stop() }
  }, [typingStartedAt])

  const isSlow = elapsed >= SLOW_THRESHOLD_MS
  const elapsedSec = Math.floor(elapsed / 1000)

  return (
    <div className={`backdrop-blur border rounded-xl px-4 py-2 inline-flex flex-col gap-1 ${
      isSlow
        ? 'bg-amber-500/5 border-amber-400/20'
        : 'bg-white/3 border-white/5'
    }`}>
      <TypingAnimation className="text-sm text-text-secondary" duration={80}>
        {t('chat.thinking', 'Thinking...')}
      </TypingAnimation>
      {isSlow && (
        <span className="text-xs text-amber-400/80">
          {t('chat.thinkingSlow', 'Response is taking longer than expected ({{seconds}}s)', { seconds: elapsedSec })}
        </span>
      )}
    </div>
  )
}

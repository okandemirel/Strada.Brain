import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TypingAnimation } from './ui/typing-animation'
import { useSessionStore } from '../stores/session-store'

const SLOW_THRESHOLD_MS = 90_000 // 90 seconds

export default function TypingIndicator() {
  const { t } = useTranslation()
  const typingStartedAt = useSessionStore((s) => s.typingStartedAt)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!typingStartedAt) { setElapsed(0); return }
    const tick = () => setElapsed(Date.now() - typingStartedAt)
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
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

import { useState, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

// How long the "Copied!" / "Sent!" confirmation state stays visible (ms).
const TRANSIENT_FEEDBACK_MS = 1500

/**
 * Drives a boolean "just happened" flag that flips true on `trigger()` and
 * resets after `durationMs`, cancelling any pending reset and cleaning up the
 * timer on unmount. Shared by CopyButton / RunButton so the transient-feedback
 * skeleton isn't duplicated per button.
 */
function useTransientFlag(durationMs = TRANSIENT_FEEDBACK_MS): [boolean, () => void] {
  const [active, setActive] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const trigger = useCallback(() => {
    setActive(true)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setActive(false), durationMs)
  }, [durationMs])

  useEffect(() => () => clearTimeout(timerRef.current), [])

  return [active, trigger]
}

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const { t } = useTranslation()
  const [copied, flagCopied] = useTransientFlag()

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      flagCopied()
    } catch {
      // clipboard not available
    }
  }, [text, flagCopied])

  return (
    <button
      onClick={handleCopy}
      className={cn(
        'px-2 py-0.5 text-[11px] rounded-md border border-white/10 bg-white/5 text-text-secondary hover:bg-white/10 hover:text-text transition-all duration-150',
        className,
      )}
      title={t('ui.copy')}
    >
      {copied ? t('ui.copied') : t('ui.copy')}
    </button>
  )
}

/**
 * RunButton — mirrors CopyButton's shape/placement, but instead of copying it
 * hands the command back to the caller (which routes it through the chat send
 * path as `/run <command>`, triggering the backend's unconditional confirm).
 * After a click it briefly shows a "sent" state, matching CopyButton's feedback.
 */
export function RunButton({
  command,
  onRun,
  className,
}: {
  command: string
  onRun: (command: string) => void
  className?: string
}) {
  const { t } = useTranslation()
  const [sent, flagSent] = useTransientFlag()

  const handleRun = useCallback(() => {
    onRun(command)
    flagSent()
  }, [command, onRun, flagSent])

  return (
    <button
      onClick={handleRun}
      className={cn(
        'px-2 py-0.5 text-[11px] rounded-md border border-accent/20 bg-accent/10 text-accent hover:bg-accent/20 transition-all duration-150',
        className,
      )}
      title={t('ui.run')}
    >
      {sent ? t('ui.runSent') : t('ui.run')}
    </button>
  )
}

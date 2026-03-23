import { useState, useCallback, useRef, useEffect } from 'react'
import { cn } from '@/lib/utils'

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard not available
    }
  }, [text])

  useEffect(() => () => clearTimeout(timerRef.current), [])

  return (
    <button
      onClick={handleCopy}
      className={cn(
        'px-2 py-0.5 text-[11px] rounded-md border border-white/10 bg-white/5 text-text-secondary hover:bg-white/10 hover:text-text transition-all duration-150',
        className,
      )}
      title="Copy"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  )
}

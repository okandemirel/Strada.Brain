import { useCallback, useEffect, useRef } from 'react'
import type { ConfirmationState } from '../types/messages'

interface ConfirmDialogProps {
  confirmation: ConfirmationState
  onRespond: (confirmId: string, option: string) => void
}

export default function ConfirmDialog({ confirmation, onRespond }: ConfirmDialogProps) {
  const firstBtnRef = useRef<HTMLButtonElement>(null)

  // Close on ESC key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onRespond(confirmation.confirmId, 'timeout')
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [confirmation, onRespond])

  // Auto-focus first button when dialog opens
  useEffect(() => {
    firstBtnRef.current?.focus()
  }, [confirmation])

  const setFirstRef = useCallback(
    (el: HTMLButtonElement | null, index: number) => {
      if (index === 0) {
        (firstBtnRef as React.MutableRefObject<HTMLButtonElement | null>).current = el
      }
    },
    [],
  )

  return (
    <div className="confirmation-overlay">
      <div className="confirmation-dialog">
        <h3>{confirmation.question}</h3>
        {confirmation.details && (
          <div className="details">{confirmation.details}</div>
        )}
        <div className="confirmation-options">
          {confirmation.options.map((option, idx) => (
            <button
              key={option}
              ref={(el) => setFirstRef(el, idx)}
              onClick={() => onRespond(confirmation.confirmId, option)}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

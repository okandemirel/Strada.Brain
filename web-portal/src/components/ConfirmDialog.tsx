import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConfirmationState } from '../types/messages'

interface ConfirmDialogProps {
  confirmation: ConfirmationState
  onRespond: (confirmId: string, option: string) => void
}

function isPlanQuestion(question: string): boolean {
  return question.trimStart().startsWith('**Plan:')
}

function isRecommended(option: string): boolean {
  return option.toLowerCase().includes('(recommended)')
}

/** Parse plan text into numbered steps for visual display */
function parsePlanSteps(question: string): { title: string; steps: string[] } {
  const lines = question.split('\n')
  // First line is the title (e.g. "**Plan: Do something**")
  const title = lines[0].replace(/\*\*/g, '').replace(/^Plan:\s*/, '').trim()
  const steps: string[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    // Strip leading numbers, dashes, bullets
    const cleaned = line.replace(/^[\d]+[.)]\s*/, '').replace(/^[-*]\s*/, '').trim()
    if (cleaned) steps.push(cleaned)
  }
  return { title, steps }
}

export default function ConfirmDialog({ confirmation, onRespond }: ConfirmDialogProps) {
  const firstBtnRef = useRef<HTMLButtonElement>(null)
  const [modifyText, setModifyText] = useState('')
  const [showModifyInput, setShowModifyInput] = useState(false)
  const modifyInputRef = useRef<HTMLTextAreaElement>(null)

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

  // Focus the modify input when it appears
  useEffect(() => {
    if (showModifyInput) {
      modifyInputRef.current?.focus()
    }
  }, [showModifyInput])

  // Reset modify state when confirmation changes
  useEffect(() => {
    setShowModifyInput(false)
    setModifyText('')
  }, [confirmation.confirmId])

  const handleOptionClick = useCallback(
    (option: string) => {
      if (option.toLowerCase() === 'modify') {
        setShowModifyInput(true)
        return
      }
      onRespond(confirmation.confirmId, option)
    },
    [confirmation.confirmId, onRespond],
  )

  const handleModifySubmit = useCallback(() => {
    const trimmed = modifyText.trim()
    if (!trimmed) return
    onRespond(confirmation.confirmId, `Modify: ${trimmed}`)
  }, [confirmation.confirmId, modifyText, onRespond])

  const handleModifyKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleModifySubmit()
      }
    },
    [handleModifySubmit],
  )

  const isPlan = isPlanQuestion(confirmation.question)

  return (
    <div className="confirmation-overlay">
      <div className={`confirmation-dialog ${isPlan ? 'confirmation-plan' : ''}`}>
        {isPlan ? (
          <PlanDisplay question={confirmation.question} />
        ) : (
          <h3>{confirmation.question}</h3>
        )}
        {confirmation.details && (
          <div className="details">{confirmation.details}</div>
        )}

        {showModifyInput && (
          <div className="modify-input-area">
            <textarea
              ref={modifyInputRef}
              className="modify-input"
              value={modifyText}
              onChange={(e) => setModifyText(e.target.value)}
              onKeyDown={handleModifyKeyDown}
              placeholder="Describe your modification..."
              rows={3}
            />
            <div className="modify-actions">
              <button
                className="modify-cancel"
                onClick={() => { setShowModifyInput(false); setModifyText('') }}
              >
                Cancel
              </button>
              <button
                className="modify-submit"
                onClick={handleModifySubmit}
                disabled={!modifyText.trim()}
              >
                Submit
              </button>
            </div>
          </div>
        )}

        <div className="confirmation-options">
          {confirmation.options.map((option, idx) => (
            <button
              key={option}
              ref={idx === 0 ? firstBtnRef : undefined}
              className={isRecommended(option) ? 'recommended' : ''}
              onClick={() => handleOptionClick(option)}
            >
              {isRecommended(option) && <span className="recommended-badge">Recommended</span>}
              {option.replace(/\s*\(recommended\)/i, '')}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function PlanDisplay({ question }: { question: string }) {
  const { title, steps } = parsePlanSteps(question)

  return (
    <div className="plan-display">
      <h3 className="plan-title">Plan: {title}</h3>
      {steps.length > 0 && (
        <ol className="plan-steps">
          {steps.map((step, i) => (
            <li key={i} className="plan-step">
              <span className="plan-step-number">{i + 1}</span>
              <span className="plan-step-text">{step}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

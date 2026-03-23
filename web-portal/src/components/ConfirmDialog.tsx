import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConfirmationState } from '../types/messages'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog'
import { Button } from './ui/button'

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
  return <ConfirmDialogBody key={confirmation.confirmId} confirmation={confirmation} onRespond={onRespond} />
}

function ConfirmDialogBody({ confirmation, onRespond }: ConfirmDialogProps) {
  const firstBtnRef = useRef<HTMLButtonElement>(null)
  const [modifyText, setModifyText] = useState('')
  const [showModifyInput, setShowModifyInput] = useState(false)
  const modifyInputRef = useRef<HTMLTextAreaElement>(null)

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
    <Dialog
      open={!!confirmation}
      onOpenChange={(open) => {
        if (!open) onRespond(confirmation.confirmId, 'timeout')
      }}
    >
      <DialogContent
        hideClose
        className={isPlan ? 'max-w-xl' : ''}
        onOpenAutoFocus={(e) => {
          // Prevent Radix default focus — we handle it manually with firstBtnRef
          e.preventDefault()
          firstBtnRef.current?.focus()
        }}
      >
        {isPlan ? (
          <PlanDisplay question={confirmation.question} />
        ) : (
          <DialogTitle className="mb-4">{confirmation.question}</DialogTitle>
        )}

        {confirmation.details ? (
          <DialogDescription className="mb-4">{confirmation.details}</DialogDescription>
        ) : (
          // Radix warns if no Description is present; provide a hidden one
          <DialogDescription className="sr-only">
            {isPlan ? 'Review the plan steps below' : 'Choose an option'}
          </DialogDescription>
        )}

        {showModifyInput && (
          <div className="mb-4">
            <textarea
              ref={modifyInputRef}
              className="w-full resize-none rounded-lg border border-white/10 bg-white/5 backdrop-blur p-3 text-sm text-text placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent"
              value={modifyText}
              onChange={(e) => setModifyText(e.target.value)}
              onKeyDown={handleModifyKeyDown}
              placeholder="Describe your modification..."
              rows={3}
            />
            <div className="mt-2 flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setShowModifyInput(false); setModifyText('') }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleModifySubmit}
                disabled={!modifyText.trim()}
              >
                Submit
              </Button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {confirmation.options.map((option, idx) => (
            <Button
              key={option}
              ref={idx === 0 ? firstBtnRef : undefined}
              variant={isRecommended(option) ? 'default' : 'outline'}
              onClick={() => handleOptionClick(option)}
              className={`relative ${isRecommended(option) ? 'border-accent shadow-[0_0_0_2px_var(--color-accent-glow)]' : 'hover:bg-white/5'}`}
            >
              {isRecommended(option) && (
                <span className="mr-1.5 rounded-full bg-bg/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase">
                  Recommended
                </span>
              )}
              {option.replace(/\s*\(recommended\)/i, '')}
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function PlanDisplay({ question }: { question: string }) {
  const { title, steps } = parsePlanSteps(question)

  return (
    <div className="mb-4">
      <DialogTitle className="mb-3 text-accent">Plan: {title}</DialogTitle>
      {steps.length > 0 && (
        <ol className="space-y-1.5 rounded-xl border border-white/5 bg-white/[0.03] backdrop-blur p-2">
          {steps.map((step, i) => (
            <li
              key={i}
              className="flex items-start gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-surface-hover"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-bold text-accent">
                {i + 1}
              </span>
              <span className="text-sm text-text">{step}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

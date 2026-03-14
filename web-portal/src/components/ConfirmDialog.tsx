import type { ConfirmationState } from '../types/messages'

interface ConfirmDialogProps {
  confirmation: ConfirmationState
  onRespond: (confirmId: string, option: string) => void
}

export default function ConfirmDialog({ confirmation, onRespond }: ConfirmDialogProps) {
  return (
    <div className="confirmation-overlay active">
      <div className="confirmation-dialog">
        <h3>{confirmation.question}</h3>
        {confirmation.details && (
          <div className="details">{confirmation.details}</div>
        )}
        <div className="confirmation-options">
          {confirmation.options.map((option) => (
            <button
              key={option}
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

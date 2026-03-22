import { useState, useCallback } from 'react'
import { useWS } from '../../hooks/useWS'
import { Send } from 'lucide-react'

export default function MiniChat() {
  const { sendMessage, status } = useWS()
  const [text, setText] = useState('')
  const disabled = status !== 'connected'

  const handleSend = useCallback(() => {
    if (!text.trim() || disabled) return
    sendMessage(text.trim())
    setText('')
  }, [text, disabled, sendMessage])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  return (
    <div className="p-2 border-t border-border">
      <div className="flex items-center gap-1.5 rounded-lg bg-surface border border-border-subtle px-2 py-1">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Quick message..."
          disabled={disabled}
          className="flex-1 bg-transparent text-xs text-text placeholder:text-text-tertiary outline-none min-w-0"
        />
        <button
          onClick={handleSend}
          disabled={disabled || !text.trim()}
          className="p-1 rounded text-text-tertiary hover:text-accent disabled:opacity-30 transition-colors"
          aria-label="Send"
        >
          <Send size={12} />
        </button>
      </div>
    </div>
  )
}

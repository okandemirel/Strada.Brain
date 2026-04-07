import { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useWS } from '../../hooks/useWS'
import { useSessionStore } from '../../stores/session-store'
import { Send } from 'lucide-react'

export default function MiniChat() {
  const { t } = useTranslation()
  const { sendMessage, status } = useWS()
  const messages = useSessionStore((s) => s.messages)
  const isTyping = useSessionStore((s) => s.isTyping)
  const [text, setText] = useState('')
  const [justSent, setJustSent] = useState(false)
  const disabled = status !== 'connected'
  const scrollRef = useRef<HTMLDivElement>(null)

  const recentMessages = messages.slice(-3)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages.length])

  const handleSend = useCallback(() => {
    if (!text.trim() || disabled) return
    sendMessage(text.trim())
    setText('')
    setJustSent(true)
  }, [text, disabled, sendMessage])

  useEffect(() => {
    if (!justSent) return
    const timer = setTimeout(() => setJustSent(false), 2000)
    return () => clearTimeout(timer)
  }, [justSent])

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
    <div className="p-2 border-t border-border flex flex-col gap-1.5">
      {recentMessages.length > 0 && (
        <div ref={scrollRef} className="max-h-[120px] overflow-y-auto space-y-1 px-1">
          {recentMessages.map((msg) => (
            <div
              key={msg.id}
              className={`text-[10px] leading-relaxed rounded-lg px-2 py-1 ${
                msg.sender === 'user'
                  ? 'text-accent/80 bg-accent/5 text-right'
                  : 'text-text-secondary bg-white/[0.03]'
              }`}
            >
              <span className="line-clamp-2">{msg.text}</span>
            </div>
          ))}
          {isTyping && (
            <div className="text-[10px] text-text-tertiary italic px-2">
              {t('workspace.miniChat.typing', 'Typing...')}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-1.5 rounded-xl bg-white/3 backdrop-blur border border-white/5 px-2 py-1">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('workspace.miniChat.placeholder')}
          disabled={disabled}
          maxLength={4000}
          aria-label={t('workspace.miniChat.inputLabel')}
          className="flex-1 bg-transparent text-xs text-text placeholder:text-text-tertiary outline-none min-w-0"
        />
        <button
          onClick={handleSend}
          disabled={disabled || !text.trim()}
          className="p-1 rounded text-text-tertiary hover:text-accent disabled:opacity-30 transition-colors"
          aria-label={t('workspace.miniChat.sendLabel')}
        >
          {justSent ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-success">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <Send size={12} />
          )}
        </button>
      </div>
    </div>
  )
}

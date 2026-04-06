import { useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useWS } from '../hooks/useWS'
import ChatMessage from './ChatMessage'
import ChatInput from './ChatInput'
import ConfirmDialog from './ConfirmDialog'
import TypingIndicator from './TypingIndicator'
import EmptyState from './EmptyState'
import PrimaryWorkerSelector from './PrimaryWorkerSelector'
import { BlurFade } from './ui/blur-fade'
import { useSessionStore } from '../stores/session-store'
import { useVoiceSettings } from '../hooks/use-voice-settings'

export default function ChatView() {
  const { t } = useTranslation()
  const { messages, status, confirmation, isTyping, sendMessage, sendConfirmation, sendRawJSON } = useWS()
  const updateMessage = useSessionStore((s) => s.updateMessage)
  const { voice } = useVoiceSettings()
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const userScrolledUpRef = useRef(false)

  const VISIBLE_BATCH_SIZE = 50
  const [visibleCount, setVisibleCount] = useState(VISIBLE_BATCH_SIZE)
  const prevScrollHeightRef = useRef<number | null>(null)

  const hasHiddenMessages = messages.length > visibleCount
  const visibleMessages = useMemo(
    () => hasHiddenMessages ? messages.slice(messages.length - visibleCount) : messages,
    [messages, visibleCount, hasHiddenMessages],
  )

  const loadMore = useCallback(() => {
    // Capture scroll height before React re-renders with more messages
    prevScrollHeightRef.current = messagesContainerRef.current?.scrollHeight ?? null
    setVisibleCount((prev) => Math.min(prev + VISIBLE_BATCH_SIZE, messages.length))
  }, [messages.length])

  // Preserve scroll position after DOM update from loading older messages
  useLayoutEffect(() => {
    const container = messagesContainerRef.current
    const prevHeight = prevScrollHeightRef.current
    if (container && prevHeight !== null) {
      container.scrollTop += container.scrollHeight - prevHeight
      prevScrollHeightRef.current = null
    }
  }, [visibleCount])

  useEffect(() => {
    const container = messagesContainerRef.current
    if (!container) return

    const handleScroll = () => {
      const threshold = 100
      const atBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight < threshold
      userScrolledUpRef.current = !atBottom
    }

    container.addEventListener('scroll', handleScroll)
    return () => container.removeEventListener('scroll', handleScroll)
  }, [])

  useEffect(() => {
    if (!userScrolledUpRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, isTyping])

  const handleFeedback = useCallback((messageId: string, feedbackType: 'thumbs_up' | 'thumbs_down') => {
    const msg = useSessionStore.getState().messages.find((m) => m.id === messageId)
    if (!msg) return
    if (msg.feedback === feedbackType) return
    updateMessage(messageId, { feedback: feedbackType })
    sendRawJSON({ type: 'feedback', feedbackType, instinctIds: msg.instinctIds ?? [] })
  }, [sendRawJSON, updateMessage])

  const isDisconnected = status !== 'connected'

  return (
    <div className="flex flex-col h-full overflow-hidden min-w-0">
      <div className="flex items-center justify-end px-6 py-2 border-b border-border shrink-0">
        <PrimaryWorkerSelector />
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-6 flex flex-col gap-3 scroll-smooth" ref={messagesContainerRef}>
        {messages.length === 0 && !isTyping ? (
          <div className="flex-1 flex items-center justify-center">
            <BlurFade><EmptyState /></BlurFade>
          </div>
        ) : (
          <div className="w-full max-w-prose mx-auto flex flex-col gap-3" aria-live="polite" aria-relevant="additions">
            {hasHiddenMessages && (
              <button
                onClick={loadMore}
                className="self-center rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-xs text-text-secondary transition-colors hover:border-accent/30 hover:bg-accent/10 hover:text-accent"
              >
                {t('chat.loadEarlier', { count: messages.length - visibleCount })}
              </button>
            )}
            {visibleMessages.map((msg) => (
              <ChatMessage
                key={msg.id}
                message={msg}
                onFeedback={handleFeedback}
                voiceOutputEnabled={voice.outputEnabled}
              />
            ))}
            {(isTyping || messages.some(m => m.isStreaming)) && (
              <div className="flex items-center gap-2">
                {isTyping && <TypingIndicator />}
                <button
                  onClick={() => sendRawJSON({ type: 'cancel_task' })}
                  className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-rose-400/30 hover:bg-rose-400/10 hover:text-rose-300"
                  title={t('chat.stopGeneration')}
                  aria-label={t('chat.stopGeneration')}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="inline mr-1"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                  {t('chat.stop')}
                </button>
              </div>
            )}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {confirmation && (
        <ConfirmDialog confirmation={confirmation} onRespond={sendConfirmation} />
      )}

      <ChatInput onSend={sendMessage} disabled={isDisconnected} />
    </div>
  )
}

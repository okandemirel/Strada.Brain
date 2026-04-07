import { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
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

const VISIBLE_BATCH_SIZE = 50

export default function ChatView() {
  const { t } = useTranslation()
  const { messages, status, confirmation, isTyping, sendMessage, sendConfirmation, sendRawJSON } = useWS()
  const updateMessage = useSessionStore((s) => s.updateMessage)
  const { voice } = useVoiceSettings()
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const userScrolledUpRef = useRef(false)

  const [visibleCount, setVisibleCount] = useState(VISIBLE_BATCH_SIZE)

  const hasHiddenMessages = messages.length > visibleCount
  const visibleMessages = useMemo(
    () => hasHiddenMessages ? messages.slice(messages.length - visibleCount) : messages,
    [messages, visibleCount, hasHiddenMessages],
  )

  const hasStreamingMessage = useMemo(
    () => messages.some((m) => m.isStreaming),
    [messages],
  )

  const virtualizer = useVirtualizer({
    count: visibleMessages.length,
    getScrollElement: () => messagesContainerRef.current,
    estimateSize: () => 80,
    overscan: 5,
  })

  const prevVisibleCountRef = useRef(visibleCount)
  prevVisibleCountRef.current = visibleCount

  const loadMore = useCallback(() => {
    const prevCount = prevVisibleCountRef.current
    setVisibleCount((prev) => Math.min(prev + VISIBLE_BATCH_SIZE, messages.length))
    // Scroll to maintain position after React commits the new items
    requestAnimationFrame(() => {
      const addedCount = Math.min(prevCount + VISIBLE_BATCH_SIZE, messages.length) - prevCount
      if (addedCount > 0) {
        virtualizer.scrollToIndex(addedCount, { align: 'start' })
      }
    })
  }, [messages.length, virtualizer])

  // Detect manual scroll-up on the scroll container
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

  // Auto-scroll to bottom when new messages arrive or typing starts
  useEffect(() => {
    if (!userScrolledUpRef.current && visibleMessages.length > 0) {
      virtualizer.scrollToIndex(visibleMessages.length - 1, { align: 'end', behavior: 'smooth' })
    }
  }, [visibleMessages.length, isTyping, virtualizer])

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
      <div className="flex-1 overflow-y-auto px-6 py-6 scroll-smooth" ref={messagesContainerRef}>
        {messages.length === 0 && !isTyping ? (
          <div className="flex h-full items-center justify-center">
            <BlurFade><EmptyState /></BlurFade>
          </div>
        ) : (
          <div className="w-full max-w-prose mx-auto" aria-live="polite" aria-relevant="additions">
            {hasHiddenMessages && (
              <div className="flex justify-center pb-3">
                <button
                  onClick={loadMore}
                  className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-xs text-text-secondary transition-colors hover:border-accent/30 hover:bg-accent/10 hover:text-accent"
                >
                  {t('chat.loadEarlier', { count: messages.length - visibleCount })}
                </button>
              </div>
            )}
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const msg = visibleMessages[virtualRow.index]
                return (
                  <div
                    key={msg.id}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <div className="pb-3">
                      <ChatMessage
                        message={msg}
                        onFeedback={handleFeedback}
                        voiceOutputEnabled={voice.outputEnabled}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
            {(isTyping || hasStreamingMessage) && (
              <div className="flex items-center gap-2 pt-3">
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
      </div>

      {confirmation && (
        <ConfirmDialog confirmation={confirmation} onRespond={sendConfirmation} />
      )}

      <ChatInput onSend={sendMessage} disabled={isDisconnected} />
    </div>
  )
}

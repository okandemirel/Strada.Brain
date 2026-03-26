import { useCallback, useEffect, useRef } from 'react'
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
  const { messages, status, confirmation, isTyping, sendMessage, sendConfirmation, sendRawJSON } = useWS()
  const updateMessage = useSessionStore((s) => s.updateMessage)
  const { voice } = useVoiceSettings()
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const userScrolledUpRef = useRef(false)

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
          <div className="w-full max-w-prose mx-auto flex flex-col gap-3">
            {messages.map((msg) => (
              <ChatMessage
                key={msg.id}
                message={msg}
                onFeedback={handleFeedback}
                voiceOutputEnabled={voice.outputEnabled}
              />
            ))}
            {isTyping && <TypingIndicator />}
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

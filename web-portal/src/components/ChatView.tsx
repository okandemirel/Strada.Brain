import { useEffect, useRef } from 'react'
import { useWS } from '../hooks/useWS'
import ChatMessage from './ChatMessage'
import ChatInput from './ChatInput'
import ConfirmDialog from './ConfirmDialog'
import TypingIndicator from './TypingIndicator'
import EmptyState from './EmptyState'
import PrimaryWorkerSelector from './PrimaryWorkerSelector'

export default function ChatView() {
  const { messages, status, confirmation, isTyping, sendMessage, sendConfirmation } = useWS()
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

  const isDisconnected = status !== 'connected'

  return (
    <div className="flex flex-col flex-1 overflow-hidden min-w-0">
      <div className="flex items-center justify-end px-6 py-2 border-b border-border shrink-0">
        <PrimaryWorkerSelector />
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-6 flex flex-col gap-3 scroll-smooth" ref={messagesContainerRef}>
        {messages.length === 0 && !isTyping ? (
          <EmptyState />
        ) : (
          <>
            {messages.map((msg) => (
              <ChatMessage key={msg.id} message={msg} />
            ))}
            {isTyping && <TypingIndicator />}
          </>
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

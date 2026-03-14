import { useEffect, useRef } from 'react'
import Header from './components/Header'
import ChatMessage from './components/ChatMessage'
import ChatInput from './components/ChatInput'
import ConfirmDialog from './components/ConfirmDialog'
import TypingIndicator from './components/TypingIndicator'
import EmptyState from './components/EmptyState'
import { useWebSocket } from './hooks/useWebSocket'
import { useTheme } from './hooks/useTheme'

export default function App() {
  const { messages, status, confirmation, isTyping, sendMessage, sendConfirmation } = useWebSocket()
  const { theme, toggleTheme } = useTheme()
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const userScrolledUpRef = useRef(false)

  // Track whether the user has scrolled away from the bottom
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

  // Auto-scroll to bottom when new messages arrive (unless the user scrolled up)
  useEffect(() => {
    if (!userScrolledUpRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, isTyping])

  const isDisconnected = status !== 'connected'

  return (
    <div className="app">
      <Header status={status} theme={theme} onToggleTheme={toggleTheme} />

      <div className="messages" ref={messagesContainerRef}>
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

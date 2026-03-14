import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { ChatMessage as ChatMessageType } from '../types/messages'

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeHighlight]

interface ChatMessageProps {
  message: ChatMessageType
}

function ChatMessageComponent({ message }: ChatMessageProps) {
  const isUser = message.sender === 'user'

  return (
    <div className={`message ${isUser ? 'user' : 'ai'}`}>
      {isUser || !message.isMarkdown ? (
        <span>{message.text}</span>
      ) : (
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
          {message.text}
        </ReactMarkdown>
      )}
      {message.isStreaming && <span className="streaming-cursor" />}
    </div>
  )
}

export default memo(ChatMessageComponent)

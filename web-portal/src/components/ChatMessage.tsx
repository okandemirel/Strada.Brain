import { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { Attachment, ChatMessage as ChatMessageType } from '../types/messages'
import VoiceOutput from './VoiceOutput'

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeHighlight]

interface ChatMessageProps {
  message: ChatMessageType
}

const SAFE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

function isImageType(type: string): boolean {
  return type.startsWith('image/')
}

function AttachmentGallery({ attachments }: { attachments: Attachment[] }) {
  const images = useMemo(() => attachments.filter((a) => isImageType(a.type)), [attachments])
  const others = useMemo(() => attachments.filter((a) => !isImageType(a.type)), [attachments])

  if (images.length === 0 && others.length === 0) return null

  return (
    <div className="message-attachments">
      {images.length > 0 && (
        <div className="message-images">
          {images.map((img, i) =>
            SAFE_IMAGE_TYPES.has(img.type) ? (
              <img
                key={i}
                src={`data:${img.type};base64,${img.data}`}
                alt={img.name}
                className="message-image"
                loading="lazy"
              />
            ) : null,
          )}
        </div>
      )}
      {others.length > 0 && (
        <div className="message-files">
          {others.map((file, i) => (
            <div key={i} className="message-file">
              <span className="message-file-icon">
                {file.name.split('.').pop()?.toUpperCase() || 'FILE'}
              </span>
              <span className="message-file-name">{file.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function hasTextContent(text: string): boolean {
  // Strip markdown code blocks and check if meaningful text remains
  const stripped = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '').trim()
  return stripped.length > 0
}

function ChatMessageComponent({ message }: ChatMessageProps) {
  const isUser = message.sender === 'user'
  const showVoiceOutput = !isUser && !message.isStreaming && hasTextContent(message.text)

  return (
    <div className={`message ${isUser ? 'user' : 'ai'}`}>
      {isUser || !message.isMarkdown ? (
        <span>{message.text}</span>
      ) : (
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
          {message.text}
        </ReactMarkdown>
      )}
      {message.attachments && message.attachments.length > 0 && (
        <AttachmentGallery attachments={message.attachments} />
      )}
      {message.isStreaming && <span className="streaming-cursor" />}
      {showVoiceOutput && (
        <div className="message-actions">
          <VoiceOutput text={message.text} />
        </div>
      )}
    </div>
  )
}

export default memo(ChatMessageComponent)

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
    <div className="mt-2.5">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-1.5">
          {images.map((img, i) =>
            SAFE_IMAGE_TYPES.has(img.type) ? (
              <img
                key={i}
                src={`data:${img.type};base64,${img.data}`}
                alt={img.name}
                className="max-w-[300px] max-h-[240px] rounded-[14px] object-contain border border-border cursor-pointer transition-all duration-200 hover:opacity-90 hover:scale-[1.01]"
                loading="lazy"
              />
            ) : null,
          )}
        </div>
      )}
      {others.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {others.map((file, i) => (
            <div key={i} className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-border rounded-[10px] bg-bg-tertiary text-xs transition-colors hover:bg-bg-elevated">
              <span className="text-[10px] font-bold text-accent uppercase">
                {file.name.split('.').pop()?.toUpperCase() || 'FILE'}
              </span>
              <span className="text-text-secondary max-w-[160px] overflow-hidden text-ellipsis whitespace-nowrap">{file.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function hasTextContent(text: string): boolean {
  const stripped = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '').trim()
  return stripped.length > 0
}

function ChatMessageComponent({ message }: ChatMessageProps) {
  const isUser = message.sender === 'user'
  const showVoiceOutput = !isUser && !message.isStreaming && hasTextContent(message.text)

  return (
    <div
      className={`max-w-[75%] px-[18px] py-[14px] rounded-[18px] leading-relaxed break-words overflow-wrap-break-word animate-[msg-in_0.3s_cubic-bezier(0.25,0.46,0.45,0.94)] text-[15px] backdrop-blur-[20px] ${
        isUser
          ? 'self-end bg-user-msg rounded-br-[6px] border border-accent/15'
          : 'self-start bg-ai-msg rounded-bl-[6px] border border-border prose-ai'
      }`}
    >
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
      {message.isStreaming && (
        <span className="inline-block w-0.5 h-[1em] bg-accent ml-0.5 align-text-bottom animate-[blink_1s_step-end_infinite] rounded-[1px]" />
      )}
      {showVoiceOutput && (
        <div className="flex items-center gap-1.5 mt-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100">
          <VoiceOutput text={message.text} />
        </div>
      )}
    </div>
  )
}

export default memo(ChatMessageComponent)

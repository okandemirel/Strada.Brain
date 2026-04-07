import { memo, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { Components } from 'react-markdown'
import type { Attachment, ChatMessage as ChatMessageType } from '../types/messages'
import VoiceOutput from './VoiceOutput'
import { cn } from '@/lib/utils'
import { CopyButton } from './ui/copy-button'

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeHighlight]

interface ChatMessageProps {
  message: ChatMessageType
  onFeedback?: (messageId: string, type: 'thumbs_up' | 'thumbs_down') => void
  voiceOutputEnabled?: boolean
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString()
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
                {file.name.split('.').pop()?.toUpperCase() || 'FILE' /* static fallback, localized in ChatInput */}
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

function makeComponents(isUser: boolean): Components {
  return {
    pre({ children, ...props }) {
      const codeEl = children as React.ReactElement | null
      const rawText: string = (() => {
        try {
          const el = codeEl as React.ReactElement<{ children?: React.ReactNode; className?: string }>
          const inner = el?.props?.children
          if (typeof inner === 'string') return inner
          return ''
        } catch {
          return ''
        }
      })()

      // Extract language from className (e.g. "hljs language-typescript" -> "typescript")
      const language: string | null = (() => {
        try {
          const el = codeEl as React.ReactElement<{ className?: string }>
          const cls = el?.props?.className ?? ''
          const match = cls.match(/language-(\S+)/)
          return match ? match[1] : null
        } catch {
          return null
        }
      })()

      return (
        <div className="relative group/code">
          {language && (
            <div className="flex items-center justify-between px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary bg-white/[0.04] border-b border-white/5 rounded-t-lg">
              {language}
              {!isUser && rawText && (
                <CopyButton
                  text={rawText}
                  className="opacity-0 group-hover/code:opacity-100 transition-opacity"
                />
              )}
            </div>
          )}
          <pre {...props}>{children}</pre>
          {!language && !isUser && rawText && (
            <CopyButton
              text={rawText}
              className="absolute top-2 right-2 opacity-0 group-hover/code:opacity-100 transition-opacity"
            />
          )}
        </div>
      )
    },
  }
}

const USER_COMPONENTS = makeComponents(true)
const AI_COMPONENTS = makeComponents(false)

const FeedbackToolbar = memo(function FeedbackToolbar({
  messageId,
  feedback,
  onFeedback,
}: {
  messageId: string
  feedback?: 'thumbs_up' | 'thumbs_down'
  onFeedback: (messageId: string, type: 'thumbs_up' | 'thumbs_down') => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => onFeedback(messageId, 'thumbs_up')}
        aria-label={t('chat.goodResponse')}
        className={cn(
          'p-1 rounded-md text-xs transition-all duration-150',
          feedback === 'thumbs_up'
            ? 'text-success bg-success/10'
            : 'text-text-tertiary hover:text-text-secondary hover:bg-white/5',
        )}
      >
        👍
      </button>
      <button
        type="button"
        onClick={() => onFeedback(messageId, 'thumbs_down')}
        aria-label={t('chat.badResponse')}
        className={cn(
          'p-1 rounded-md text-xs transition-all duration-150',
          feedback === 'thumbs_down'
            ? 'text-error bg-error/10'
            : 'text-text-tertiary hover:text-text-secondary hover:bg-white/5',
        )}
      >
        👎
      </button>
    </div>
  )
})

function ChatMessageComponent({ message, onFeedback, voiceOutputEnabled = true }: ChatMessageProps) {
  const { t } = useTranslation()
  const isUser = message.sender === 'user'
  const showVoiceOutput = voiceOutputEnabled && !isUser && !message.isStreaming && hasTextContent(message.text)
  const showFeedback = !isUser && !message.isStreaming && onFeedback
  let deliveryLabel: string | null = null
  if (isUser) {
    if (message.deliveryState === 'pending') {
      deliveryLabel = t('chat.sending')
    } else if (message.deliveryState === 'failed') {
      deliveryLabel = t('chat.notDelivered')
    }
  }

  return (
    <div
      className={cn(
        'group relative max-w-[75%] px-[18px] py-[14px] leading-relaxed break-words overflow-wrap-break-word animate-[msg-in_0.3s_cubic-bezier(0.25,0.46,0.45,0.94)] text-[15px]',
        isUser
          ? 'self-end bg-gradient-to-br from-accent/10 to-accent/5 rounded-2xl rounded-br-[6px] border border-accent/15'
          : 'self-start bg-white/3 backdrop-blur border border-white/5 rounded-2xl rounded-bl-[6px] prose-ai',
      )}
    >
      {isUser || !message.isMarkdown ? (
        <span>{message.text}</span>
      ) : (
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          components={isUser ? USER_COMPONENTS : AI_COMPONENTS}
        >
          {message.text}
        </ReactMarkdown>
      )}
      {message.attachments && message.attachments.length > 0 && (
        <AttachmentGallery attachments={message.attachments} />
      )}
      {message.isStreaming && (
        <span className="inline-block w-0.5 h-[1em] bg-accent ml-0.5 align-text-bottom animate-[blink_1s_step-end_infinite] rounded-[1px]" />
      )}
      {message.timestamp && (
        <div className="mt-1.5 text-[10px] text-text-tertiary opacity-0 transition-opacity duration-200 group-hover:opacity-60 select-none" title={new Date(message.timestamp).toLocaleString()}>
          {formatRelativeTime(message.timestamp)}
        </div>
      )}
      {deliveryLabel && (
        <div
          className={cn(
            'mt-2 text-[11px] font-medium',
            message.deliveryState === 'failed' ? 'text-error' : 'text-text-tertiary',
          )}
        >
          {deliveryLabel}
        </div>
      )}
      {(showVoiceOutput || showFeedback) && (
        <div className="flex items-center gap-1.5 mt-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100">
          {showVoiceOutput && <VoiceOutput text={message.text} />}
          {showFeedback && (
            <FeedbackToolbar
              messageId={message.id}
              feedback={message.feedback}
              onFeedback={onFeedback}
            />
          )}
        </div>
      )}
      <CopyButton
        text={message.text}
        className="absolute -top-3 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
      />
    </div>
  )
}

export default memo(ChatMessageComponent)

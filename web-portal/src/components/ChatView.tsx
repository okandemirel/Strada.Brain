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
import { useSessionHistory } from '../hooks/use-session-history'
import { readSessionMessages } from '../hooks/websocket-storage'

const VISIBLE_BATCH_SIZE = 50

/* ------------------------------------------------------------------ */
/*  SessionPicker                                                      */
/* ------------------------------------------------------------------ */

function SessionPicker() {
  const { t } = useTranslation()
  const sessions = useSessionHistory()
  const profileId = useSessionStore((s) => s.profileId)
  const [open, setOpen] = useState(false)
  const [viewingHistorical, setViewingHistorical] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const loadSession = useCallback((sessionKey: string) => {
    const messages = readSessionMessages(sessionKey)
    useSessionStore.getState().setMessages(messages)
    setViewingHistorical(sessionKey !== profileId)
    setOpen(false)
  }, [profileId])

  const returnToCurrent = useCallback(() => {
    if (profileId) {
      const messages = readSessionMessages(profileId)
      useSessionStore.getState().setMessages(messages)
    }
    setViewingHistorical(false)
  }, [profileId])

  if (sessions.length <= 1) return null

  return (
    <div className="relative" ref={dropdownRef}>
      {viewingHistorical && (
        <button
          onClick={returnToCurrent}
          className="mr-2 rounded-lg border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs text-accent transition-colors hover:bg-accent/20"
        >
          {t('chat.backToCurrent', 'Back to current')}
        </button>
      )}
      <button
        onClick={() => setOpen(!open)}
        className="rounded-lg border border-white/10 bg-white/5 p-2 text-text-tertiary transition-colors hover:text-text hover:border-white/20"
        title={t('chat.sessionHistory', 'Session history')}
        aria-label={t('chat.sessionHistory', 'Session history')}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 w-72 rounded-xl border border-white/10 bg-bg-secondary/95 backdrop-blur-xl shadow-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-white/5 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
            {t('chat.recentSessions', 'Recent Sessions')}
          </div>
          <div className="max-h-[300px] overflow-y-auto">
            {sessions.map((s) => (
              <button
                key={s.sessionKey}
                onClick={() => loadSession(s.sessionKey)}
                className={`w-full text-left px-3 py-2.5 transition-colors hover:bg-white/5 ${
                  s.sessionKey === profileId ? 'bg-accent/5 border-l-2 border-accent' : ''
                }`}
              >
                <div className="text-xs text-text truncate">{s.lastMessage || t('chat.emptySession', 'Empty session')}</div>
                <div className="flex items-center gap-2 mt-1 text-[10px] text-text-tertiary">
                  <span>{t('chat.messageCount', '{{count}} messages', { count: s.messageCount })}</span>
                  <span>{new Date(s.lastTimestamp).toLocaleDateString()}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  ChatView                                                           */
/* ------------------------------------------------------------------ */

export default function ChatView() {
  const { t } = useTranslation()
  const { messages, status, confirmation, isTyping, sendMessage, sendConfirmation, sendRawJSON } = useWS()
  const updateMessage = useSessionStore((s) => s.updateMessage)
  const { voice } = useVoiceSettings()
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const userScrolledUpRef = useRef(false)

  const [visibleCount, setVisibleCount] = useState(VISIBLE_BATCH_SIZE)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)

  const hasHiddenMessages = messages.length > visibleCount
  const visibleMessages = useMemo(
    () => hasHiddenMessages ? messages.slice(messages.length - visibleCount) : messages,
    [messages, visibleCount, hasHiddenMessages],
  )

  const searchFilteredMessages = useMemo(() => {
    if (!searchQuery.trim()) return visibleMessages
    const q = searchQuery.toLowerCase()
    return visibleMessages.filter((m) => m.text.toLowerCase().includes(q))
  }, [visibleMessages, searchQuery])

  const hasStreamingMessage = useMemo(
    () => messages.some((m) => m.isStreaming),
    [messages],
  )

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: searchFilteredMessages.length,
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
    if (!userScrolledUpRef.current && searchFilteredMessages.length > 0) {
      virtualizer.scrollToIndex(searchFilteredMessages.length - 1, { align: 'end', behavior: 'smooth' })
    }
  }, [searchFilteredMessages.length, isTyping, virtualizer])

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
      <div className="flex items-center justify-end gap-2 px-6 py-2 border-b border-border shrink-0">
        <SessionPicker />
        <div className="flex items-center gap-2">
          {searchOpen && (
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('chat.searchMessages', 'Search messages...')}
              className="w-48 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-text outline-none placeholder:text-text-tertiary focus:border-accent"
              autoFocus
            />
          )}
          {searchQuery && (
            <span className="text-[10px] text-text-tertiary">
              {searchFilteredMessages.length} {t('chat.results', 'results')}
            </span>
          )}
          <button
            onClick={() => { setSearchOpen(!searchOpen); if (searchOpen) setSearchQuery('') }}
            className="rounded-lg border border-white/10 bg-white/5 p-2 text-text-tertiary transition-colors hover:text-text hover:border-white/20"
            title={t('chat.search', 'Search')}
            aria-label={t('chat.search', 'Search')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
        </div>
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
                const msg = searchFilteredMessages[virtualRow.index]
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
                    <div className="pb-3 flex flex-col">
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

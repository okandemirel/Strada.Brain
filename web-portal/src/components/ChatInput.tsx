import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ChangeEvent, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Attachment } from '../types/messages'
import { useWorkspaceStore } from '../stores/workspace-store'
import VoiceRecorder from './VoiceRecorder'
import { ShimmerButton } from './ui/shimmer-button'
import { CoolMode } from './ui/cool-mode'
import { useVoiceSettings } from '../hooks/use-voice-settings'

const SLASH_COMMANDS = [
  { command: '/model', description: 'Switch AI model/provider', usage: '/model <provider>[/<model>]' },
  { command: '/autonomous', description: 'Toggle autonomous mode', usage: '/autonomous on|off [hours]' },
  { command: '/cancel', description: 'Cancel current task', usage: '/cancel [taskId]' },
] as const

interface ChatInputProps {
  onSend: (text: string, attachments?: Attachment[]) => boolean | void
  disabled: boolean
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const base64 = result.split(',')[1] || result
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const MAX_FILE_SIZE = 20 * 1024 * 1024
const MAX_FILES = 5
const ALLOWED_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/mp4',
  'application/pdf', 'text/plain', 'text/csv',
])

interface FilePreview {
  id: string
  file: File
  previewUrl: string | null
}

export default function ChatInput({ onSend, disabled }: ChatInputProps) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [files, setFiles] = useState<FilePreview[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [showCommands, setShowCommands] = useState(false)
  const [commandFilter, setCommandFilter] = useState('')
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sendingRef = useRef(false)
  const { voice } = useVoiceSettings()

  const filteredCommands = useMemo(() => {
    if (!showCommands) return []
    return SLASH_COMMANDS.filter(cmd =>
      cmd.command.toLowerCase().includes(commandFilter.toLowerCase())
    )
  }, [showCommands, commandFilter])

  const selectCommand = useCallback((command: string) => {
    setText(command + ' ')
    setShowCommands(false)
    textareaRef.current?.focus()
  }, [])

  const filesRef = useRef(files)
  filesRef.current = files
  useEffect(() => {
    return () => {
      filesRef.current.forEach((f) => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl) })
    }
  }, [])

  const addFiles = useCallback((newFiles: FileList | File[]) => {
    const fileArray = Array.from(newFiles)
    const filtered = fileArray
      .filter((f) => f.size <= MAX_FILE_SIZE)
      .filter((f) => !f.type || ALLOWED_TYPES.has(f.type))
    setFiles((prev) => {
      const remaining = MAX_FILES - prev.length
      if (remaining <= 0) return prev
      const toAdd = filtered.slice(0, remaining)
      const previews: FilePreview[] = toAdd.map((file) => ({
        id: crypto.randomUUID(),
        file,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      }))
      return [...prev, ...previews]
    })
  }, [])

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => {
      const removed = prev[index]
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl)
      return prev.filter((_, i) => i !== index)
    })
  }, [])

  const handleSend = useCallback(async () => {
    if (sendingRef.current) return
    sendingRef.current = true
    try {
      const trimmed = text.trim()
      if (!trimmed && files.length === 0) return

      let attachments: Attachment[] | undefined
      if (files.length > 0) {
        attachments = await Promise.all(
          files.map(async ({ file }) => ({
            name: file.name,
            type: file.type,
            data: await fileToBase64(file),
            size: file.size,
          })),
        )
      }

      const sent = onSend(trimmed || t('chat.fileAttachment'), attachments)
      if (sent === false) return

      setText('')
      setFiles([])

      // Reset mode override so auto-switch resumes after user sends a chat message
      useWorkspaceStore.getState().resetOverride()

      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
    } finally {
      sendingRef.current = false
    }
  }, [text, files, onSend, t])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (showCommands && filteredCommands.length > 0) {
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedCommandIndex(i => Math.max(0, i - 1))
          return
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedCommandIndex(i => Math.min(filteredCommands.length - 1, i + 1))
          return
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault()
          selectCommand(filteredCommands[selectedCommandIndex].command)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setShowCommands(false)
          return
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend, showCommands, filteredCommands, selectedCommandIndex, selectCommand],
  )

  const handleTextChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setText(val)

    if (val.startsWith('/')) {
      const filter = val.slice(1).split(' ')[0] ?? ''
      setCommandFilter(filter)
      setShowCommands(!val.includes(' '))
      setSelectedCommandIndex(0)
    } else {
      setShowCommands(false)
    }

    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [])

  const handleFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        addFiles(e.target.files)
      }
      e.target.value = ''
    },
    [addFiles],
  )

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault()
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false)
    }
  }, [])

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault()
      setIsDragOver(false)
      if (e.dataTransfer.files.length > 0) {
        addFiles(e.dataTransfer.files)
      }
    },
    [addFiles],
  )

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return

    const imageFiles: File[] = []
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) imageFiles.push(file)
      }
    }

    if (imageFiles.length > 0) {
      e.preventDefault() // Prevent pasting image as text
      addFiles(imageFiles)
    }
    // If no images, let the default paste behavior handle text
  }, [addFiles])

  const handleVoiceMessage = useCallback((attachment: Attachment) => {
    const sent = onSend(t('chat.voiceMessage'), [attachment])
    if (sent === false) return false

    useWorkspaceStore.getState().resetOverride()
    return true
  }, [onSend, t])

  const handleVoiceText = useCallback((text: string) => {
    const sent = onSend(text)
    if (sent === false) return false

    useWorkspaceStore.getState().resetOverride()
    return true
  }, [onSend])

  return (
    <div
      className={`relative flex flex-col px-6 pt-3.5 pb-[18px] bg-bg-secondary backdrop-blur-[40px] backdrop-saturate-[180%] border-t border-border shrink-0 transition-all duration-200 ${isDragOver ? 'border-t-accent bg-bg-tertiary shadow-[inset_0_2px_0_0_var(--color-accent)]' : ''}`}
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {showCommands && filteredCommands.length > 0 && (
        <div className="absolute bottom-full left-6 right-6 mb-1 rounded-xl border border-white/10 bg-bg-secondary/95 backdrop-blur-xl shadow-lg overflow-hidden z-10">
          {filteredCommands.map((cmd, i) => (
            <button
              key={cmd.command}
              type="button"
              onClick={() => selectCommand(cmd.command)}
              onMouseEnter={() => setSelectedCommandIndex(i)}
              className={`w-full text-left px-3 py-2 flex flex-col gap-0.5 transition-colors ${
                i === selectedCommandIndex ? 'bg-accent/10' : 'hover:bg-white/5'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-mono font-semibold text-accent">{cmd.command}</span>
                <span className="text-xs text-text-tertiary">{cmd.description}</span>
              </div>
              <span className="text-[10px] font-mono text-text-tertiary/70">{cmd.usage}</span>
            </button>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex gap-2 py-2.5 overflow-x-auto flex-wrap">
          {files.map((fp, i) => (
            <div key={fp.id} className="relative flex flex-col items-center gap-1.5 p-2.5 border border-border rounded-[14px] bg-bg-tertiary min-w-[80px] max-w-[100px] transition-colors hover:bg-bg-elevated">
              {fp.previewUrl ? (
                <img src={fp.previewUrl} alt={fp.file.name} className="w-12 h-12 object-cover rounded-lg" />
              ) : (
                <div className="w-12 h-12 flex items-center justify-center bg-bg-secondary rounded-lg border border-border">
                  <span className="text-[10px] font-bold text-text-secondary uppercase">{fp.file.name.split('.').pop()?.toUpperCase() || t('ui.file')}</span>
                </div>
              )}
              <span className="text-[11px] text-text-secondary text-ellipsis overflow-hidden whitespace-nowrap max-w-[80px] text-center">{fp.file.name}</span>
              <span className="text-[10px] text-text-tertiary">{formatFileSize(fp.file.size)}</span>
              <button
                className="absolute -top-1.5 -right-1.5 w-[22px] h-[22px] rounded-full border-none bg-bg-elevated text-text-secondary text-sm leading-none cursor-pointer flex items-center justify-center transition-all duration-200 shadow-sm hover:bg-error hover:text-white"
                onClick={() => removeFile(i)}
                title={t('chat.removeFile')}
                aria-label={`${t('chat.removeFile')}: ${fp.file.name}`}
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2.5 items-end bg-white/5 backdrop-blur border border-white/10 rounded-xl px-3 py-2 focus-within:border-accent focus-within:shadow-[0_0_15px_rgba(0,229,255,0.15)] transition-all duration-200">
        <button
          className="flex items-center justify-center relative w-[42px] h-[42px] border border-border rounded-xl bg-bg-tertiary text-text-secondary cursor-pointer shrink-0 transition-all duration-200 hover:text-accent hover:border-accent hover:bg-accent-glow disabled:opacity-40 disabled:cursor-not-allowed"
          onClick={() => fileInputRef.current?.click()}
          title={t('chat.attachFile')}
          aria-label={t('chat.attachFile')}
          disabled={disabled}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
          </svg>
          {files.length > 0 && (
            <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] rounded-[9px] bg-accent text-white text-[11px] font-bold flex items-center justify-center px-1 leading-none shadow-[0_2px_4px_rgba(0,229,255,0.3)]">
              {files.length}
            </span>
          )}
        </button>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={t('chat.placeholder')}
          aria-label={t('chat.placeholder')}
          rows={1}
          disabled={disabled}
          className="flex-1 resize-none border-none rounded-[14px] px-4 py-3 font-[inherit] text-[15px] bg-transparent text-text leading-relaxed max-h-[140px] outline-none transition-all duration-200 placeholder:text-text-tertiary disabled:opacity-40"
        />
        {voice.inputEnabled && (
          <VoiceRecorder onVoiceMessage={handleVoiceMessage} onTextMessage={handleVoiceText} disabled={disabled} />
        )}
        <CoolMode options={{ particle: '✦', particleCount: 8, speedUp: 18 }}>
          <ShimmerButton
            shimmerColor="#00e5ff"
            background="rgba(0,229,255,0.12)"
            borderRadius="14px"
            shimmerDuration="2.5s"
            className="self-end px-[22px] py-[11px] text-accent border-accent/30 text-[15px] font-semibold whitespace-nowrap shrink-0 tracking-tight hover:scale-105 hover:shadow-[0_0_20px_rgba(0,229,255,0.3)] active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:scale-100 disabled:shadow-none disabled:hover:scale-100"
            onClick={handleSend}
            aria-label={t('chat.send')}
            disabled={disabled || (!text.trim() && files.length === 0)}
          >
            {t('chat.send')}
          </ShimmerButton>
        </CoolMode>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileChange}
          aria-hidden="true"
          className="hidden"
        />
      </div>
    </div>
  )
}

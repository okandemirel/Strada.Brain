import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ChangeEvent, type DragEvent } from 'react'
import type { Attachment } from '../types/messages'
import { useWorkspaceStore } from '../stores/workspace-store'
import VoiceRecorder from './VoiceRecorder'

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
  const [text, setText] = useState('')
  const [files, setFiles] = useState<FilePreview[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sendingRef = useRef(false)

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
      if (removed.previewUrl) URL.revokeObjectURL(removed.previewUrl)
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

      const sent = onSend(trimmed || '(file attachment)', attachments)
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
  }, [text, files, onSend])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  const handleTextChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value)
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

  const handleVoiceTranscript = useCallback((transcript: string) => {
    setText(prev => prev ? prev + ' ' + transcript : transcript)
  }, [])

  return (
    <div
      className={`flex flex-col px-6 pt-3.5 pb-[18px] bg-bg-secondary backdrop-blur-[40px] backdrop-saturate-[180%] border-t border-border shrink-0 transition-all duration-200 ${isDragOver ? 'border-t-accent bg-bg-tertiary shadow-[inset_0_2px_0_0_var(--color-accent)]' : ''}`}
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {files.length > 0 && (
        <div className="flex gap-2 py-2.5 overflow-x-auto flex-wrap">
          {files.map((fp, i) => (
            <div key={fp.id} className="relative flex flex-col items-center gap-1.5 p-2.5 border border-border rounded-[14px] bg-bg-tertiary min-w-[80px] max-w-[100px] transition-colors hover:bg-bg-elevated">
              {fp.previewUrl ? (
                <img src={fp.previewUrl} alt={fp.file.name} className="w-12 h-12 object-cover rounded-lg" />
              ) : (
                <div className="w-12 h-12 flex items-center justify-center bg-bg-secondary rounded-lg border border-border">
                  <span className="text-[10px] font-bold text-text-secondary uppercase">{fp.file.name.split('.').pop()?.toUpperCase() || 'FILE'}</span>
                </div>
              )}
              <span className="text-[11px] text-text-secondary text-ellipsis overflow-hidden whitespace-nowrap max-w-[80px] text-center">{fp.file.name}</span>
              <span className="text-[10px] text-text-tertiary">{formatFileSize(fp.file.size)}</span>
              <button
                className="absolute -top-1.5 -right-1.5 w-[22px] h-[22px] rounded-full border-none bg-bg-elevated text-text-secondary text-sm leading-none cursor-pointer flex items-center justify-center transition-all duration-200 shadow-sm hover:bg-error hover:text-white"
                onClick={() => removeFile(i)}
                title="Remove file"
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2.5 items-end">
        <button
          className="flex items-center justify-center relative w-[42px] h-[42px] border border-border rounded-xl bg-bg-tertiary text-text-secondary cursor-pointer shrink-0 transition-all duration-200 hover:text-accent hover:border-accent hover:bg-accent-glow disabled:opacity-40 disabled:cursor-not-allowed"
          onClick={() => fileInputRef.current?.click()}
          title="Attach file"
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
          placeholder="Send a message... (Enter to send, Shift+Enter for new line)"
          rows={1}
          disabled={disabled}
          className="flex-1 resize-none border border-border rounded-[14px] px-4 py-3 font-[inherit] text-[15px] bg-input-bg text-text leading-relaxed max-h-[140px] outline-none transition-all duration-200 focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-glow)] placeholder:text-text-tertiary disabled:opacity-40"
        />
        <VoiceRecorder onTranscript={handleVoiceTranscript} disabled={disabled} />
        <button
          className="self-end px-[22px] py-[11px] bg-accent text-white border-none rounded-[14px] cursor-pointer text-[15px] font-semibold transition-all duration-200 whitespace-nowrap shrink-0 tracking-tight hover:bg-accent-hover hover:-translate-y-px hover:shadow-[0_4px_12px_var(--color-accent-glow)] disabled:opacity-40 disabled:cursor-not-allowed disabled:translate-y-0 disabled:shadow-none"
          onClick={handleSend}
          disabled={disabled || (!text.trim() && files.length === 0)}
        >
          Send
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileChange}
          className="hidden"
        />
      </div>
    </div>
  )
}

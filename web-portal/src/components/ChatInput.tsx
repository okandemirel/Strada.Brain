import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ChangeEvent, type DragEvent } from 'react'
import type { Attachment } from '../types/messages'

interface ChatInputProps {
  onSend: (text: string, attachments?: Attachment[]) => boolean | void
  disabled: boolean
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // Strip data URL prefix to get raw base64
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

const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20 MB
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

  // Revoke all remaining blob URLs on unmount
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

      // Reset textarea height
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
    // Auto-resize
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [])

  const handleFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        addFiles(e.target.files)
      }
      // Reset so the same file can be selected again
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

  return (
    <div
      className={`input-area ${isDragOver ? 'drag-over' : ''}`}
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {files.length > 0 && (
        <div className="file-previews">
          {files.map((fp, i) => (
            <div key={fp.id} className="file-preview">
              {fp.previewUrl ? (
                <img src={fp.previewUrl} alt={fp.file.name} />
              ) : (
                <div className="file-icon">
                  <span>{fp.file.name.split('.').pop()?.toUpperCase() || 'FILE'}</span>
                </div>
              )}
              <span className="file-name">{fp.file.name}</span>
              <span className="file-size">{formatFileSize(fp.file.size)}</span>
              <button className="file-remove" onClick={() => removeFile(i)} title="Remove file">
                &times;
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="input-row">
        <button
          className="attach-btn"
          onClick={() => fileInputRef.current?.click()}
          title="Attach file"
          disabled={disabled}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
          </svg>
          {files.length > 0 && <span className="attach-badge">{files.length}</span>}
        </button>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          placeholder="Send a message... (Enter to send, Shift+Enter for new line)"
          rows={1}
          disabled={disabled}
        />
        <button className="send-btn" onClick={handleSend} disabled={disabled || (!text.trim() && files.length === 0)}>
          Send
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileChange}
          style={{ display: 'none' }}
        />
      </div>
    </div>
  )
}

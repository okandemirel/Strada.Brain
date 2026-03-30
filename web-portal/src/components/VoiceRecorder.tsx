import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { Attachment } from '../types/messages'
import { hasVoiceInputSupport } from '../hooks/use-voice-settings'

interface VoiceRecorderProps {
  onVoiceMessage: (attachment: Attachment) => boolean | void
  disabled?: boolean
}

interface RecorderErrorEvent extends Event {
  error?: DOMException
}

const MAX_VOICE_MESSAGE_BYTES = 10 * 1024 * 1024
const PREFERRED_AUDIO_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
]

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      resolve(result.split(',')[1] ?? '')
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read recorded audio'))
    reader.readAsDataURL(blob)
  })
}

function pickRecorderMimeType(): string {
  if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') return ''
  if (typeof window.MediaRecorder.isTypeSupported !== 'function') return ''

  return PREFERRED_AUDIO_TYPES.find((mimeType) => window.MediaRecorder.isTypeSupported(mimeType)) ?? ''
}

export default function VoiceRecorder({ onVoiceMessage, disabled }: VoiceRecorderProps) {
  const { t } = useTranslation()
  const [isRecording, setIsRecording] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const onVoiceMessageRef = useRef(onVoiceMessage)
  const startPendingRef = useRef(false)

  useEffect(() => {
    onVoiceMessageRef.current = onVoiceMessage
  }, [onVoiceMessage])

  const cleanupStream = useCallback(() => {
    if (!streamRef.current) return
    streamRef.current.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }, [])

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try { mediaRecorderRef.current.stop() } catch { /* ignore */ }
      }
      mediaRecorderRef.current = null
      cleanupStream()
    }
  }, [cleanupStream])

  const supported = hasVoiceInputSupport()

  const handleStop = useCallback(async () => {
    const blobType = mediaRecorderRef.current?.mimeType || chunksRef.current[0]?.type || 'audio/webm'
    const audioBlob = new Blob(chunksRef.current, { type: blobType })
    chunksRef.current = []
    mediaRecorderRef.current = null
    cleanupStream()
    setIsRecording(false)

    if (audioBlob.size === 0) {
      toast.error(t('voice.noAudioCaptured'))
      return
    }

    if (audioBlob.size > MAX_VOICE_MESSAGE_BYTES) {
      toast.error(t('voice.messageTooLarge'))
      return
    }

    setIsProcessing(true)
    try {
      const attachment: Attachment = {
        name: `voice-${Date.now()}.${blobType.includes('mp4') ? 'm4a' : blobType.includes('ogg') ? 'ogg' : 'webm'}`,
        type: blobType,
        data: await blobToBase64(audioBlob),
        size: audioBlob.size,
      }
      const sent = onVoiceMessageRef.current(attachment)
      if (sent === false) {
        toast.error(t('voice.couldNotSend'))
        return
      }
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[VoiceRecorder] Failed to prepare audio message:', error)
      }
      toast.error(t('voice.messageFailed'))
    } finally {
      setIsProcessing(false)
    }
  }, [cleanupStream])

  const startRecording = useCallback(async () => {
    if (startPendingRef.current || isProcessing) return
    startPendingRef.current = true

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = pickRecorderMimeType()
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)

      streamRef.current = stream
      chunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data)
        }
      }
      recorder.onerror = (event) => {
        if (import.meta.env.DEV) {
          console.warn('[VoiceRecorder] MediaRecorder error:', (event as RecorderErrorEvent).error)
        }
        toast.error(t('voice.recordingFailed'))
      }
      recorder.onstop = () => {
        void handleStop()
      }

      mediaRecorderRef.current = recorder
      recorder.start(250)
      setIsRecording(true)
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[VoiceRecorder] Failed to start recording:', error)
      }
      cleanupStream()
      toast.error(t('voice.micPermissionDenied'))
    } finally {
      startPendingRef.current = false
    }
  }, [cleanupStream, handleStop, isProcessing])

  const toggleRecording = useCallback(() => {
    if (isRecording) {
      const recorder = mediaRecorderRef.current
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop()
        } catch {
          cleanupStream()
          setIsRecording(false)
        }
      }
      return
    }

    void startRecording()
  }, [cleanupStream, isRecording, startRecording])

  if (!supported) return null

  return (
    <button
      className={`flex items-center justify-center w-[42px] h-[42px] border rounded-xl cursor-pointer shrink-0 transition-all duration-200 ${
        isRecording
          ? 'text-error border-error bg-error/15 animate-[voice-pulse_1.5s_ease-in-out_infinite]'
          : isProcessing
            ? 'text-accent border-accent bg-accent/10'
          : 'border-border bg-bg-tertiary text-text-secondary hover:text-accent hover:border-accent hover:bg-accent-glow'
      } disabled:opacity-40 disabled:cursor-not-allowed`}
      onClick={toggleRecording}
      disabled={disabled || isProcessing}
      title={isRecording ? t('voice.stopRecording') : isProcessing ? t('voice.sendingVoice') : t('voice.voiceInput')}
      type="button"
    >
      {isProcessing ? (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
          <path d="M21 12a9 9 0 11-6.22-8.56" />
        </svg>
      ) : (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="1" width="6" height="12" rx="3" />
          <path d="M19 10v1a7 7 0 01-14 0v-1" />
          <line x1="12" y1="18" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      )}
    </button>
  )
}

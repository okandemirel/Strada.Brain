import { useCallback, useEffect, useRef, useState } from 'react'

interface VoiceRecorderProps {
  onTranscript: (text: string) => void
  disabled?: boolean
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: { results: SpeechRecognitionResultList }) => void) | null
  onerror: ((event: { error: string; message: string }) => void) | null
  onend: (() => void) | null
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance
}

function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  const w = window as unknown as Record<string, unknown>
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as
    | SpeechRecognitionConstructor
    | null
}

export default function VoiceRecorder({ onTranscript, disabled }: VoiceRecorderProps) {
  const [isRecording, setIsRecording] = useState(false)
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null)
  const supported = typeof window !== 'undefined' && getSpeechRecognition() !== null

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try { recognitionRef.current.abort() } catch { /* ignore */ }
        recognitionRef.current = null
      }
    }
  }, [])

  const toggleRecording = useCallback(() => {
    if (isRecording) {
      if (recognitionRef.current) {
        try { recognitionRef.current.stop() } catch { /* ignore */ }
        recognitionRef.current = null
      }
      setIsRecording(false)
      return
    }

    if (recognitionRef.current) return

    const SpeechRecognitionCtor = getSpeechRecognition()
    if (!SpeechRecognitionCtor) return

    const recognition = new SpeechRecognitionCtor()
    recognition.continuous = false
    recognition.interimResults = false
    recognition.lang = navigator.language || 'en-US'

    recognition.onresult = (event) => {
      const result = event.results[0]
      if (result && result[0]) {
        const transcript = result[0].transcript.trim()
        if (transcript) {
          onTranscript(transcript)
        }
      }
    }

    recognition.onerror = (event) => {
      if (event.error !== 'aborted' && event.error !== 'no-speech') {
        if (import.meta.env.DEV) console.warn('[VoiceRecorder] Speech recognition error:', event.error)
      }
      setIsRecording(false)
    }

    recognition.onend = () => {
      setIsRecording(false)
      recognitionRef.current = null
    }

    recognitionRef.current = recognition

    try {
      recognition.start()
      setIsRecording(true)
    } catch (err) {
      if (import.meta.env.DEV) console.warn('[VoiceRecorder] Failed to start speech recognition:', err)
      setIsRecording(false)
    }
  }, [isRecording, onTranscript])

  if (!supported) return null

  return (
    <button
      className={`flex items-center justify-center w-[42px] h-[42px] border rounded-xl cursor-pointer shrink-0 transition-all duration-200 ${
        isRecording
          ? 'text-error border-error bg-error/15 animate-[voice-pulse_1.5s_ease-in-out_infinite]'
          : 'border-border bg-bg-tertiary text-text-secondary hover:text-accent hover:border-accent hover:bg-accent-glow'
      } disabled:opacity-40 disabled:cursor-not-allowed`}
      onClick={toggleRecording}
      disabled={disabled}
      title={isRecording ? 'Stop recording' : 'Voice input'}
      type="button"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="1" width="6" height="12" rx="3" />
        <path d="M19 10v1a7 7 0 01-14 0v-1" />
        <line x1="12" y1="18" x2="12" y2="23" />
        <line x1="8" y1="23" x2="16" y2="23" />
      </svg>
    </button>
  )
}

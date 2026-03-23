import { useCallback, useEffect, useRef, useState, useMemo } from 'react'

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
  onresult: ((event: { resultIndex: number; results: SpeechRecognitionResultList }) => void) | null
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
  const wantRecordingRef = useRef(false)
  const restartCountRef = useRef(0)
  const generationRef = useRef(0)
  const onTranscriptRef = useRef(onTranscript)
  onTranscriptRef.current = onTranscript
  const supported = useMemo(() => typeof window !== 'undefined' && getSpeechRecognition() !== null, [])

  useEffect(() => {
    return () => {
      wantRecordingRef.current = false
      if (recognitionRef.current) {
        try { recognitionRef.current.abort() } catch { /* ignore */ }
        recognitionRef.current = null
      }
    }
  }, [])

  const startRecognition = useCallback(() => {
    const SpeechRecognitionCtor = getSpeechRecognition()
    if (!SpeechRecognitionCtor) return

    const gen = ++generationRef.current
    const recognition = new SpeechRecognitionCtor()
    recognition.continuous = true
    recognition.interimResults = false
    recognition.lang = navigator.language || 'en-US'

    recognition.onresult = (event) => {
      restartCountRef.current = 0
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal && result[0]) {
          const transcript = result[0].transcript.trim()
          if (transcript) {
            onTranscriptRef.current(transcript)
          }
        }
      }
    }

    recognition.onerror = (event) => {
      if (event.error === 'no-speech') {
        return // Ignore — browser fires this on silence; onend will auto-restart
      }
      if (event.error !== 'aborted' && import.meta.env.DEV) {
        console.warn('[VoiceRecorder] Speech recognition error:', event.error)
      }
      wantRecordingRef.current = false
    }

    recognition.onend = () => {
      if (generationRef.current !== gen) return // Stale instance — newer one is active
      recognitionRef.current = null
      if (wantRecordingRef.current && restartCountRef.current < 3) {
        restartCountRef.current++
        setTimeout(() => {
          if (wantRecordingRef.current) {
            try {
              startRecognition()
            } catch {
              wantRecordingRef.current = false
              setIsRecording(false)
            }
          }
        }, 300)
        return
      }
      wantRecordingRef.current = false
      setIsRecording(false)
    }

    recognitionRef.current = recognition
    recognition.start()
  }, [])

  const toggleRecording = useCallback(() => {
    if (isRecording) {
      wantRecordingRef.current = false
      if (recognitionRef.current) {
        try { recognitionRef.current.stop() } catch { /* ignore */ }
      }
      setIsRecording(false)
      return
    }

    if (recognitionRef.current) return

    try {
      wantRecordingRef.current = true
      restartCountRef.current = 0
      startRecognition()
      setIsRecording(true)
    } catch (err) {
      if (import.meta.env.DEV) console.warn('[VoiceRecorder] Failed to start speech recognition:', err)
      wantRecordingRef.current = false
      setIsRecording(false)
    }
  }, [isRecording, startRecognition])

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

import { useCallback, useEffect, useRef, useState } from 'react'

interface VoiceOutputProps {
  text: string
}

export default function VoiceOutput({ text }: VoiceOutputProps) {
  const [isSpeaking, setIsSpeaking] = useState(false)
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null)
  const supported = typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined'

  // Cancel speech on unmount
  useEffect(() => {
    return () => {
      if (window.speechSynthesis) {
        window.speechSynthesis.cancel()
      }
    }
  }, [])

  const toggleSpeech = useCallback(() => {
    if (!window.speechSynthesis) return

    if (isSpeaking) {
      window.speechSynthesis.cancel()
      setIsSpeaking(false)
      return
    }

    if (!text.trim()) return

    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = navigator.language || 'en-US'
    utterance.rate = 1
    utterance.pitch = 1

    utterance.onend = () => {
      setIsSpeaking(false)
      utteranceRef.current = null
    }

    utterance.onerror = (event) => {
      if (event.error !== 'canceled') {
        console.warn('[VoiceOutput] Speech synthesis error:', event.error)
      }
      setIsSpeaking(false)
      utteranceRef.current = null
    }

    utteranceRef.current = utterance
    window.speechSynthesis.speak(utterance)
    setIsSpeaking(true)
  }, [isSpeaking, text])

  if (!supported) return null

  return (
    <button
      className={`voice-output-btn ${isSpeaking ? 'voice-speaking' : ''}`}
      onClick={toggleSpeech}
      title={isSpeaking ? 'Stop speaking' : 'Read aloud'}
      type="button"
    >
      {isSpeaking ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <path d="M15.54 8.46a5 5 0 010 7.07" />
          <path d="M19.07 4.93a10 10 0 010 14.14" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <path d="M15.54 8.46a5 5 0 010 7.07" />
        </svg>
      )}
    </button>
  )
}

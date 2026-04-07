import { useCallback, useEffect, useState } from 'react'

export interface VoiceSettings {
  inputEnabled: boolean
  outputEnabled: boolean
  browserSttEnabled: boolean
}

export const VOICE_STORAGE_KEY = 'strada-voice-settings'
const VOICE_SETTINGS_EVENT = 'strada:voice-settings-changed'
const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  inputEnabled: true,
  outputEnabled: true,
  browserSttEnabled: false, // opt-in: model download is ~40 MB
}

export function loadVoiceSettings(): VoiceSettings {
  if (typeof window === 'undefined') return DEFAULT_VOICE_SETTINGS

  try {
    const raw = window.localStorage.getItem(VOICE_STORAGE_KEY)
    if (!raw) return DEFAULT_VOICE_SETTINGS

    const parsed = JSON.parse(raw) as Partial<VoiceSettings>
    return {
      inputEnabled: parsed.inputEnabled ?? DEFAULT_VOICE_SETTINGS.inputEnabled,
      outputEnabled: parsed.outputEnabled ?? DEFAULT_VOICE_SETTINGS.outputEnabled,
      browserSttEnabled: parsed.browserSttEnabled ?? DEFAULT_VOICE_SETTINGS.browserSttEnabled,
    }
  } catch {
    return DEFAULT_VOICE_SETTINGS
  }
}

export function saveVoiceSettings(settings: VoiceSettings): void {
  if (typeof window === 'undefined') return

  window.localStorage.setItem(VOICE_STORAGE_KEY, JSON.stringify(settings))
  window.dispatchEvent(new Event(VOICE_SETTINGS_EVENT))
}

export function hasVoiceInputSupport(): boolean {
  return typeof window !== 'undefined'
    && typeof window.MediaRecorder !== 'undefined'
    && typeof navigator !== 'undefined'
    && typeof navigator.mediaDevices?.getUserMedia === 'function'
}

export function hasVoiceOutputSupport(): boolean {
  return typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined'
}

type VoiceSettingsUpdater = VoiceSettings | ((prev: VoiceSettings) => VoiceSettings)

export function useVoiceSettings() {
  const [voice, setVoice] = useState<VoiceSettings>(loadVoiceSettings)

  useEffect(() => {
    const refresh = () => setVoice(loadVoiceSettings())
    window.addEventListener('storage', refresh)
    window.addEventListener(VOICE_SETTINGS_EVENT, refresh)
    return () => {
      window.removeEventListener('storage', refresh)
      window.removeEventListener(VOICE_SETTINGS_EVENT, refresh)
    }
  }, [])

  const updateVoiceSettings = useCallback((updater: VoiceSettingsUpdater) => {
    setVoice((prev) => {
      const next = typeof updater === 'function'
        ? (updater as (prev: VoiceSettings) => VoiceSettings)(prev)
        : updater
      saveVoiceSettings(next)
      return next
    })
  }, [])

  return {
    voice,
    updateVoiceSettings,
  }
}

import { useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  hasVoiceInputSupport,
  hasVoiceOutputSupport,
  useVoiceSettings,
} from '../../hooks/use-voice-settings'
import type { VoiceSettings } from '../../hooks/use-voice-settings'

function Toggle({
  enabled,
  disabled,
  onChange,
  label,
  description,
}: {
  enabled: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
  label: string
  description: string
}) {
  return (
    <div className="flex justify-between items-center px-4 py-3 bg-white/3 backdrop-blur border border-white/5 rounded-xl mb-2">
      <div>
        <p className="text-sm font-medium text-text">{label}</p>
        <p className="text-xs text-text-tertiary mt-0.5">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={enabled}
        disabled={disabled}
        onClick={() => onChange(!enabled)}
        className={`settings-toggle relative w-10 h-6 rounded-full transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40 disabled:cursor-not-allowed ${enabled ? 'bg-[var(--color-accent)]' : 'bg-white/10'}`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${enabled ? 'translate-x-4' : 'translate-x-0'}`}
        />
      </button>
    </div>
  )
}

export default function VoiceSection() {
  const { t } = useTranslation('settings')
  const { voice, updateVoiceSettings } = useVoiceSettings()
  const inputSupported = hasVoiceInputSupport()
  const outputSupported = hasVoiceOutputSupport()

  const syncToBackend = useCallback(async (next: VoiceSettings) => {
    try {
      await fetch('/api/settings/voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
    } catch {
      // Best-effort backend sync; local state already saved.
    }
  }, [])

  // Hydrate persisted preferences from the backend on mount (best-effort:
  // an offline backend or null fields must not clobber local settings).
  useEffect(() => {
    let cancelled = false
    fetch('/api/settings/voice')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return
        const serverValues: Partial<VoiceSettings> = {}
        if (typeof d.inputEnabled === 'boolean') serverValues.inputEnabled = d.inputEnabled
        if (typeof d.outputEnabled === 'boolean') serverValues.outputEnabled = d.outputEnabled
        if (typeof d.browserSttEnabled === 'boolean') serverValues.browserSttEnabled = d.browserSttEnabled
        if (Object.keys(serverValues).length > 0) {
          updateVoiceSettings((prev) => ({ ...prev, ...serverValues }))
        }
      })
      .catch(() => {
        // Best-effort hydration; keep local settings when the backend is unreachable.
      })
    return () => {
      cancelled = true
    }
  }, [updateVoiceSettings])

  // Computes the next settings from the rendered value and fires the backend
  // sync OUTSIDE the state updater, so StrictMode's double-invoked updaters
  // cannot double-fire the POST.
  const setAndSync = useCallback(
    (patch: Partial<VoiceSettings>) => {
      const updated = { ...voice, ...patch }
      updateVoiceSettings(updated)
      void syncToBackend(updated)
    },
    [voice, updateVoiceSettings, syncToBackend],
  )

  const handleInputToggle = useCallback(
    (next: boolean) => {
      if (!inputSupported && next) {
        toast.error(t('voice.toastInputUnsupported'))
        return
      }
      setAndSync({ inputEnabled: next })
    },
    [inputSupported, setAndSync, t],
  )

  const handleOutputToggle = useCallback(
    (next: boolean) => {
      if (!outputSupported && next) {
        toast.error(t('voice.toastOutputUnsupported'))
        return
      }
      setAndSync({ outputEnabled: next })
    },
    [outputSupported, setAndSync, t],
  )

  const handleBrowserSttToggle = useCallback(
    (next: boolean) => {
      setAndSync({ browserSttEnabled: next })
    },
    [setAndSync],
  )

  return (
    <div>
      <h2 className="text-lg font-semibold text-text mb-1">{t('voice.title')}</h2>
      <p className="text-sm text-text-tertiary mb-6">{t('voice.description')}</p>

      <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5">
        {t('voice.browserSupport')}
      </p>
      <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl mb-4 overflow-hidden">
        <div className="flex justify-between items-center px-4 py-2.5 border-b border-white/5 text-sm">
          <span className="text-text-secondary">{t('voice.microphone')}</span>
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${inputSupported ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>
            {inputSupported ? t('voice.supported') : t('voice.notSupported')}
          </span>
        </div>
        <div className="flex justify-between items-center px-4 py-2.5 text-sm">
          <span className="text-text-secondary">{t('voice.speechSynthesis')}</span>
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${outputSupported ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>
            {outputSupported ? t('voice.supported') : t('voice.notSupported')}
          </span>
        </div>
      </div>

      <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5">
        {t('voice.settings')}
      </p>
      <Toggle
        label={t('voice.voiceInput')}
        description={inputSupported ? t('voice.voiceInputDescSupported') : t('voice.voiceInputDescUnsupported')}
        enabled={voice.inputEnabled && inputSupported}
        disabled={!inputSupported}
        onChange={handleInputToggle}
      />
      <Toggle
        label={t('voice.voiceOutput')}
        description={outputSupported ? t('voice.voiceOutputDescSupported') : t('voice.voiceOutputDescUnsupported')}
        enabled={voice.outputEnabled && outputSupported}
        disabled={!outputSupported}
        onChange={handleOutputToggle}
      />
      <Toggle
        label={t('voice.browserStt')}
        description={t('voice.browserSttDesc')}
        enabled={voice.browserSttEnabled}
        onChange={handleBrowserSttToggle}
      />
    </div>
  )
}

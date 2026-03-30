import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

interface RateLimitConfig {
  messagesPerMinute: number
  messagesPerHour: number
  tokensPerDay: number
}

function NumericField({
  label,
  description,
  value,
  onChange,
}: {
  label: string
  description: string
  value: number
  onChange: (v: number) => void
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="min-w-0">
        <p className="text-sm text-text">{label}</p>
        <p className="text-xs text-text-tertiary">{description}</p>
      </div>
      <input
        type="number"
        min={0}
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10)
          onChange(Number.isFinite(n) && n >= 0 ? n : 0)
        }}
        className="w-28 ml-4 px-3 py-1.5 border border-border rounded-lg bg-input-bg text-text font-mono text-sm text-center outline-none focus:border-accent flex-shrink-0"
      />
    </div>
  )
}

export default function RateLimitsSection() {
  const { t } = useTranslation('settings')
  const [config, setConfig] = useState<RateLimitConfig>({
    messagesPerMinute: 0,
    messagesPerHour: 0,
    tokensPerDay: 0,
  })
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    fetch('/api/settings/rate-limits')
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (d) {
          setConfig({
            messagesPerMinute: d.messagesPerMinute ?? 0,
            messagesPerHour: d.messagesPerHour ?? 0,
            tokensPerDay: d.tokensPerDay ?? 0,
          })
        }
      })
      .catch(() => {/* use defaults */})
      .finally(() => setLoaded(true))
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/settings/rate-limits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      if (!res.ok) throw new Error('Failed to save')
      toast.success(t('rateLimits.toastSaved'))
    } catch {
      toast.error(t('rateLimits.toastFailed'))
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) {
    return (
      <div>
        <h2 className="text-lg font-semibold text-text mb-1">{t('rateLimits.title')}</h2>
        <p className="text-sm text-text-tertiary">{t('rateLimits.loading')}</p>
      </div>
    )
  }

  return (
    <div>
      <h2 className="text-lg font-semibold text-text mb-1">{t('rateLimits.title')}</h2>
      <p className="text-sm text-text-tertiary mb-6">{t('rateLimits.description')}</p>

      <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-4 space-y-5">
        <NumericField
          label={t('rateLimits.messagesPerMinute')}
          description={t('rateLimits.messagesPerMinuteDesc')}
          value={config.messagesPerMinute}
          onChange={(v) => setConfig((c) => ({ ...c, messagesPerMinute: v }))}
        />
        <div className="border-t border-white/5" />
        <NumericField
          label={t('rateLimits.messagesPerHour')}
          description={t('rateLimits.messagesPerHourDesc')}
          value={config.messagesPerHour}
          onChange={(v) => setConfig((c) => ({ ...c, messagesPerHour: v }))}
        />
        <div className="border-t border-white/5" />
        <NumericField
          label={t('rateLimits.tokensPerDay')}
          description={t('rateLimits.tokensPerDayDesc')}
          value={config.tokensPerDay}
          onChange={(v) => setConfig((c) => ({ ...c, tokensPerDay: v }))}
        />
      </div>

      <button
        onClick={save}
        disabled={saving}
        className="px-5 py-2 bg-accent/20 border border-accent/30 text-accent text-sm font-medium rounded-xl hover:bg-accent/30 transition-colors disabled:opacity-50"
      >
        {saving ? t('rateLimits.saving') : t('rateLimits.saveChanges')}
      </button>
    </div>
  )
}

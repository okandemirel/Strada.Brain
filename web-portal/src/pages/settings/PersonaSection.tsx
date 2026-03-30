import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { usePersonality } from '../../hooks/use-api'

export default function PersonaSection() {
  const { t } = useTranslation('settings')
  const { data, isLoading } = usePersonality()
  const queryClient = useQueryClient()
  const [switching, setSwitching] = useState<string | null>(null)

  const switchProfile = async (profile: string) => {
    setSwitching(profile)
    try {
      const res = await fetch('/api/personality/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile }),
      })
      if (!res.ok) throw new Error('Failed to switch profile')
      toast.success(t('persona.toastSwitched', { profile }))
      queryClient.invalidateQueries({ queryKey: ['personality'] })
      queryClient.invalidateQueries({ queryKey: ['personality-profiles'] })
    } catch {
      toast.error(t('persona.toastSwitchFailed'))
    } finally {
      setSwitching(null)
    }
  }

  if (isLoading || !data) {
    return (
      <div>
        <h2 className="text-lg font-semibold text-text mb-1">{t('persona.title')}</h2>
        <p className="text-sm text-text-tertiary">{t('persona.loading')}</p>
      </div>
    )
  }

  const personality = data.personality
  const activeProfile = personality?.activeProfile ?? null
  const profiles = personality?.profiles ?? []
  const channelOverrides = personality?.channelOverrides ?? {}
  const hasOverrides = Object.keys(channelOverrides).length > 0

  return (
    <div>
      <h2 className="text-lg font-semibold text-text mb-1">{t('persona.title')}</h2>
      <p className="text-sm text-text-tertiary mb-6">{t('persona.description')}</p>

      {/* Active profile */}
      <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-text-tertiary mb-1">{t('persona.activeProfile')}</p>
            <p className="text-sm font-semibold text-accent">
              {activeProfile ?? t('persona.default')}
            </p>
          </div>
          <span className="w-2 h-2 rounded-full bg-green-400 ring-4 ring-green-400/20" />
        </div>
      </div>

      {/* Profiles list */}
      {profiles.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3">
            {t('persona.availableProfiles')}
          </p>
          <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl overflow-hidden mb-4">
            {profiles.map((profile, idx) => {
              const isActive = profile === activeProfile
              return (
                <div
                  key={profile}
                  className={`flex items-center justify-between px-4 py-3 ${idx < profiles.length - 1 ? 'border-b border-white/5' : ''}`}
                >
                  <div className="flex items-center gap-2">
                    {isActive && <span className="w-1.5 h-1.5 rounded-full bg-accent" />}
                    <span className={`text-sm ${isActive ? 'text-text font-medium' : 'text-text-secondary'}`}>
                      {profile}
                    </span>
                    {isActive && (
                      <span className="text-xs text-text-tertiary">{t('persona.active')}</span>
                    )}
                  </div>
                  {!isActive && (
                    <button
                      onClick={() => switchProfile(profile)}
                      disabled={switching === profile}
                      className="px-3 py-1 text-xs bg-white/5 border border-white/10 text-text-secondary rounded-lg hover:border-accent/50 hover:text-accent transition-colors disabled:opacity-50"
                    >
                      {switching === profile ? t('persona.switching') : t('persona.switch')}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* Channel overrides */}
      {hasOverrides && (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3">
            {t('persona.channelOverrides')}
          </p>
          <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl overflow-hidden mb-4">
            {Object.entries(channelOverrides).map(([channel, profile], idx, arr) => (
              <div
                key={channel}
                className={`flex items-center justify-between px-4 py-3 ${idx < arr.length - 1 ? 'border-b border-white/5' : ''}`}
              >
                <span className="text-sm text-text-secondary capitalize">{channel}</span>
                <span className="text-sm text-accent">{profile}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {profiles.length === 0 && !personality?.content && (
        <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 text-center">
          <p className="text-sm text-text-tertiary">{t('persona.noProfiles')}</p>
        </div>
      )}
    </div>
  )
}

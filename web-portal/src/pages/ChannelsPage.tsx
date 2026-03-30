import { useTranslation } from 'react-i18next'
import { formatUptime } from '../utils/format'
import { useChannels, useHealth } from '../hooks/use-api'
import { PageSkeleton } from '../components/ui/page-skeleton'
import { PageError } from '../components/ui/page-error'

interface ChannelInfo {
  name: string
  type: string
  enabled: boolean
  healthy: boolean
  detail?: string
}

const CHANNEL_ICONS: Record<string, string> = {
  web: 'W',
  telegram: 'T',
  discord: 'D',
  slack: 'S',
  whatsapp: 'A',
  cli: '>',
}

function statusDotClass(ch: ChannelInfo): string {
  if (!ch.enabled) return 'bg-text-tertiary'
  return ch.healthy ? 'bg-success shadow-[0_0_6px_var(--color-success)]' : 'bg-warning shadow-[0_0_6px_var(--color-warning)]'
}

export default function ChannelsPage() {
  const { t } = useTranslation('pages')
  const channelsQuery = useChannels()
  const healthQuery = useHealth()

  function statusLabel(ch: ChannelInfo): string {
    if (!ch.enabled) return t('channels.statusDisabled')
    return ch.healthy ? t('channels.statusActive') : t('channels.statusDegraded')
  }

  const loading = channelsQuery.isLoading && healthQuery.isLoading
  const error = channelsQuery.error && healthQuery.error
    ? channelsQuery.error.message
    : null
  const health = healthQuery.data ?? null

  if (error) return <PageError title={t('channels.errorTitle')} message={error} />
  if (loading) return <PageSkeleton />

  let channels: ChannelInfo[] = channelsQuery.data?.channels ?? []
  if (channels.length === 0 && health) {
    const clientCount = health.clients ?? 0
    channels = [{
      name: health.channel || 'web',
      type: health.channel || 'web',
      enabled: true,
      healthy: health.status === 'ok',
      detail: clientCount !== 1 ? t('channels.clientsConnectedPlural', { count: clientCount }) : t('channels.clientsConnected', { count: clientCount }),
    }]
  }

  return (
    <div className="h-full overflow-y-auto p-7 w-full animate-[admin-fade-in_0.3s_ease]">
      <h2 className="text-[22px] font-bold tracking-tight mb-6 text-text">{t('channels.title')}</h2>

      {health && (
        <div className="mb-7">
          <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5 flex items-center gap-2">{t('channels.serverHealth')}</div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3.5">
            <div className="flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl mb-2 text-sm">
              <span className="text-text-secondary">{t('channels.status')}</span>
              <span className="text-text font-semibold flex items-center gap-1.5">
                <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${health.status === 'ok' ? 'bg-success shadow-[0_0_6px_var(--color-success)]' : 'bg-error shadow-[0_0_6px_var(--color-error)]'}`} />
                {health.status}
              </span>
            </div>
            <div className="flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl mb-2 text-sm">
              <span className="text-text-secondary">{t('channels.uptime')}</span>
              <span className="text-text font-semibold">{formatUptime(health.uptime ?? 0)}</span>
            </div>
            <div className="flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl mb-2 text-sm">
              <span className="text-text-secondary">{t('channels.clients')}</span>
              <span className="text-text font-semibold">{health.clients ?? 0}</span>
            </div>
          </div>
        </div>
      )}

      <div className="mb-7">
        <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5 flex items-center gap-2">{t('channels.activeChannels')}</div>
        {channels.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-[200px] gap-2.5 text-text-secondary text-center">
            <h3 className="text-text text-lg font-semibold">{t('channels.noChannelsTitle')}</h3>
            <p className="text-sm max-w-[400px]">{t('channels.noChannelsDescription')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3.5">
            {channels.map(ch => (
              <div key={ch.name} className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-[18px] flex items-center gap-3.5 transition-all duration-200 hover:border-border-hover hover:-translate-y-px hover:shadow-[var(--shadow-sm)]">
                <div className="w-10 h-10 rounded-[10px] bg-accent-glow flex items-center justify-center text-lg shrink-0">
                  {CHANNEL_ICONS[ch.type] ?? ch.type.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[15px] font-semibold text-text tracking-tight">{ch.name}</div>
                  {ch.detail && <div className="text-xs text-text-tertiary mt-0.5">{ch.detail}</div>}
                </div>
                <div className={`flex items-center gap-1.5 text-xs font-medium shrink-0 ${ch.enabled && ch.healthy ? 'text-success' : 'text-text-tertiary'}`}>
                  <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${statusDotClass(ch)}`} />
                  {statusLabel(ch)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

import { formatUptime } from '../utils/format'
import { useChannels, useHealth } from '../hooks/use-api'

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

function statusLabel(ch: ChannelInfo): string {
  if (!ch.enabled) return 'Disabled'
  return ch.healthy ? 'Active' : 'Degraded'
}

export default function ChannelsPage() {
  const channelsQuery = useChannels()
  const healthQuery = useHealth()

  const loading = channelsQuery.isLoading && healthQuery.isLoading
  const error = channelsQuery.error && healthQuery.error
    ? channelsQuery.error.message
    : null
  const health = healthQuery.data ?? null

  if (error) return <div className="flex flex-1 items-center justify-center h-[200px] text-error text-[15px]">Error: {error}</div>
  if (loading) return <div className="flex flex-1 items-center justify-center h-[200px] text-text-secondary text-[15px]">Loading channels...</div>

  let channels: ChannelInfo[] = channelsQuery.data?.channels ?? []
  if (channels.length === 0 && health) {
    const clientCount = health.clients ?? 0
    channels = [{
      name: health.channel || 'web',
      type: health.channel || 'web',
      enabled: true,
      healthy: health.status === 'ok',
      detail: `${clientCount} client${clientCount !== 1 ? 's' : ''} connected`,
    }]
  }

  return (
    <div className="h-full overflow-y-auto p-7 w-full animate-[admin-fade-in_0.3s_ease]">
      <h2 className="text-[22px] font-bold tracking-tight mb-6 text-text">Channels</h2>

      {health && (
        <div className="mb-7">
          <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5 flex items-center gap-2">Server Health</div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3.5">
            <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
              <span className="text-text-secondary">Status</span>
              <span className="text-text font-semibold flex items-center gap-1.5">
                <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${health.status === 'ok' ? 'bg-success shadow-[0_0_6px_var(--color-success)]' : 'bg-error shadow-[0_0_6px_var(--color-error)]'}`} />
                {health.status}
              </span>
            </div>
            <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
              <span className="text-text-secondary">Uptime</span>
              <span className="text-text font-semibold">{formatUptime(health.uptime ?? 0)}</span>
            </div>
            <div className="flex justify-between items-center px-4 py-2.5 bg-bg-secondary border border-border rounded-xl mb-2 text-sm">
              <span className="text-text-secondary">Clients</span>
              <span className="text-text font-semibold">{health.clients ?? 0}</span>
            </div>
          </div>
        </div>
      )}

      <div className="mb-7">
        <div className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3.5 flex items-center gap-2">Active Channels</div>
        {channels.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-[200px] gap-2.5 text-text-secondary text-center">
            <h3 className="text-text text-lg font-semibold">No Channels</h3>
            <p className="text-sm max-w-[400px]">No channel data available. The server may not expose channel information yet.</p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3.5">
            {channels.map(ch => (
              <div key={ch.name} className="bg-bg-secondary border border-border rounded-[14px] p-[18px] flex items-center gap-3.5 transition-all duration-200 hover:border-border-hover hover:-translate-y-px hover:shadow-[var(--shadow-sm)]">
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

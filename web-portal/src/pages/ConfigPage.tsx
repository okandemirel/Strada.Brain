import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfig } from '../hooks/use-api'
import { PageSkeleton } from '../components/ui/page-skeleton'
import { PageError } from '../components/ui/page-error'

interface ConfigEntry {
  key: string
  value: unknown
  category: string
  tier: 'core' | 'advanced' | 'experimental'
  description: string
}

export default function ConfigPage() {
  const { t } = useTranslation('pages')
  const { data, error, isLoading } = useConfig()
  const [filter, setFilter] = useState('')

  if (error) return <PageError title={t('config.errorTitle')} message={error.message} />
  if (isLoading || !data) return <PageSkeleton />

  const normalizedFilter = filter.toLowerCase()
  const fallbackEntries: ConfigEntry[] = Object.entries(data.config).map(([key, value]) => ({
    key,
    value,
    category: t('config.fallbackCategory'),
    tier: 'advanced',
    description: t('config.fallbackDescription'),
  }))
  const rawEntries = (data.entries as ConfigEntry[] | undefined) ?? fallbackEntries
  const filteredEntries = rawEntries.filter((entry) =>
    entry.key.toLowerCase().includes(normalizedFilter) ||
    entry.category.toLowerCase().includes(normalizedFilter) ||
    entry.description.toLowerCase().includes(normalizedFilter)
  )

  const groups: Record<string, ConfigEntry[]> = {}
  for (const entry of filteredEntries) {
    if (!groups[entry.category]) groups[entry.category] = []
    groups[entry.category].push(entry)
  }
  const groupedEntries = Object.entries(groups)

  return (
    <div className="h-full overflow-y-auto p-7 w-full animate-[admin-fade-in_0.3s_ease]">
      <h2 className="text-[22px] font-bold tracking-tight mb-6 text-text">{t('config.title')}</h2>
      {data.summary && (
        <div className="flex gap-2.5 flex-wrap mb-4">
          <div className="flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl text-sm">
            <span className="text-text-secondary">{t('config.core')}</span>
            <span className="text-text font-semibold ml-4">{data.summary.core}</span>
          </div>
          <div className="flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl text-sm">
            <span className="text-text-secondary">{t('config.advanced')}</span>
            <span className="text-text font-semibold ml-4">{data.summary.advanced}</span>
          </div>
          <div className="flex justify-between items-center px-4 py-2.5 bg-white/3 backdrop-blur border border-white/5 rounded-xl text-sm">
            <span className="text-text-secondary">{t('config.experimental')}</span>
            <span className="text-text font-semibold ml-4">{data.summary.experimental}</span>
          </div>
        </div>
      )}
      <input
        className="w-full max-w-[400px] px-4 py-2.5 border border-border rounded-xl bg-input-bg text-text font-[inherit] text-sm outline-none transition-all duration-200 mb-5 focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-glow)] placeholder:text-text-tertiary"
        type="text"
        placeholder={t('config.filterPlaceholder')}
        value={filter}
        onChange={e => setFilter(e.target.value)}
      />
      {groupedEntries.length === 0 ? (
        <div className="mb-6">
          <table className="w-full border-collapse bg-white/3 backdrop-blur border border-white/5 rounded-2xl overflow-hidden" style={{ borderSpacing: 0 }}>
            <tbody>
              <tr>
                <td className="px-4 py-2.5 text-left text-[13px] border-b border-border font-mono text-xs text-accent whitespace-nowrap w-[40%]">{t('config.noMatchingSettings')}</td>
                <td className="px-4 py-2.5 text-left text-[13px] border-b border-border text-text break-all">{t('config.adjustFilter')}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        groupedEntries.map(([category, items]) => (
          <div key={category} className="mb-6">
            <h3 className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-2.5">{category}</h3>
            <table className="w-full bg-white/3 backdrop-blur border border-white/5 rounded-2xl overflow-hidden" style={{ borderSpacing: 0, borderCollapse: 'separate' }}>
              <tbody>
                {items.map((entry) => (
                  <tr key={entry.key} className="hover:bg-white/5">
                    <td className="px-4 py-2.5 text-left text-[13px] border-b border-border font-mono text-xs text-accent whitespace-nowrap w-[40%]">
                      <div>{entry.key}</div>
                      <div className="text-xs opacity-75 mt-1 font-sans text-text-tertiary">{entry.description}</div>
                    </td>
                    <td className="px-4 py-2.5 text-left text-[13px] border-b border-border text-text break-all">
                      <div>{String(entry.value)}</div>
                      <div className="text-xs opacity-75 mt-1">{t('config.tierLabel', { tier: entry.tier })}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </div>
  )
}

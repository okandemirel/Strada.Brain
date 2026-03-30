import { useState, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'

const BudgetSection = lazy(() => import('./settings/BudgetSection'))
const ProvidersSection = lazy(() => import('./settings/ProvidersSection'))
const AgentsSection = lazy(() => import('./settings/AgentsSection'))
const DaemonSection = lazy(() => import('./settings/DaemonSection'))
const VoiceSection = lazy(() => import('./settings/VoiceSection'))
const PersonaSection = lazy(() => import('./settings/PersonaSection'))
const LearningSection = lazy(() => import('./settings/LearningSection'))
const RateLimitsSection = lazy(() => import('./settings/RateLimitsSection'))
const RoutingSection = lazy(() => import('./settings/RoutingSection'))
const AdvancedSection = lazy(() => import('./settings/AdvancedSection'))

interface SidebarItem {
  id: string
  labelKey: string
  icon: string
}

const SIDEBAR_ITEMS: SidebarItem[] = [
  { id: 'budget', labelKey: 'hub.tabs.budget', icon: '💰' },
  { id: 'providers', labelKey: 'hub.tabs.providers', icon: '🔄' },
  { id: 'agents', labelKey: 'hub.tabs.agents', icon: '🤖' },
  { id: 'daemon', labelKey: 'hub.tabs.daemon', icon: '⚡' },
  { id: 'voice', labelKey: 'hub.tabs.voice', icon: '🎤' },
  { id: 'persona', labelKey: 'hub.tabs.persona', icon: '🎭' },
  { id: 'learning', labelKey: 'hub.tabs.learning', icon: '🧠' },
  { id: 'rate-limits', labelKey: 'hub.tabs.rateLimits', icon: '🛡️' },
  { id: 'routing', labelKey: 'hub.tabs.routing', icon: '📊' },
  { id: 'advanced', labelKey: 'hub.tabs.advanced', icon: '⚙️' },
]

function SectionFallback() {
  const { t } = useTranslation('settings')
  return <div className="animate-pulse text-text-tertiary text-sm p-4">{t('hub.loading')}</div>
}

export default function SettingsPage() {
  const { t } = useTranslation('settings')
  const [activeSection, setActiveSection] = useState('budget')

  const renderSection = () => {
    switch (activeSection) {
      case 'budget': return <BudgetSection />
      case 'providers': return <ProvidersSection />
      case 'agents': return <AgentsSection />
      case 'daemon': return <DaemonSection />
      case 'voice': return <VoiceSection />
      case 'persona': return <PersonaSection />
      case 'learning': return <LearningSection />
      case 'rate-limits': return <RateLimitsSection />
      case 'routing': return <RoutingSection />
      case 'advanced': return <AdvancedSection />
      default: return <BudgetSection />
    }
  }

  return (
    <div className="flex h-full overflow-hidden animate-[admin-fade-in_0.3s_ease]">
      <nav className="settings-sidebar">
        <div className="p-4 pb-2">
          <h2 className="text-sm font-semibold text-text">{t('hub.title')}</h2>
        </div>
        {SIDEBAR_ITEMS.map((item) => (
          <button
            key={item.id}
            className={`settings-sidebar-item w-full text-left ${activeSection === item.id ? 'active' : ''}`}
            onClick={() => setActiveSection(item.id)}
          >
            <span>{item.icon}</span>
            <span>{t(item.labelKey)}</span>
          </button>
        ))}
      </nav>
      <main className="settings-content" key={activeSection}>
        <Suspense fallback={<SectionFallback />}>
          {renderSection()}
        </Suspense>
      </main>
    </div>
  )
}

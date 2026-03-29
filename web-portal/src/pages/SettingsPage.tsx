import { useState, lazy, Suspense } from 'react'

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
  label: string
  icon: string
}

const SIDEBAR_ITEMS: SidebarItem[] = [
  { id: 'budget', label: 'Budget', icon: '💰' },
  { id: 'providers', label: 'Providers', icon: '🔄' },
  { id: 'agents', label: 'Agents', icon: '🤖' },
  { id: 'daemon', label: 'Daemon', icon: '⚡' },
  { id: 'voice', label: 'Voice', icon: '🎤' },
  { id: 'persona', label: 'Persona', icon: '🎭' },
  { id: 'learning', label: 'Learning', icon: '🧠' },
  { id: 'rate-limits', label: 'Rate Limits', icon: '🛡️' },
  { id: 'routing', label: 'Routing', icon: '📊' },
  { id: 'advanced', label: 'Advanced', icon: '⚙️' },
]

function SectionFallback() {
  return <div className="animate-pulse text-text-tertiary text-sm p-4">Loading...</div>
}

export default function SettingsPage() {
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
          <h2 className="text-sm font-semibold text-text">Settings</h2>
        </div>
        {SIDEBAR_ITEMS.map((item) => (
          <button
            key={item.id}
            className={`settings-sidebar-item w-full text-left ${activeSection === item.id ? 'active' : ''}`}
            onClick={() => setActiveSection(item.id)}
          >
            <span>{item.icon}</span>
            <span>{item.label}</span>
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

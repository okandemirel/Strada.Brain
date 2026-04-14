import { Suspense, lazy } from 'react'
import { Routes, Route } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import ErrorBoundary from './components/ErrorBoundary'
import AppLayout from './components/layout/AppLayout'
import { detectSetupMode } from './utils/setup-mode'
import { useLanguageSync } from './hooks/useLanguageSync'

const ChatView = lazy(() => import('./components/ChatView'))
const DashboardView = lazy(() => import('./components/DashboardView'))
const ConfigPage = lazy(() => import('./pages/ConfigPage'))
const ToolsPage = lazy(() => import('./pages/ToolsPage'))
const ChannelsPage = lazy(() => import('./pages/ChannelsPage'))
const SessionsPage = lazy(() => import('./pages/SessionsPage'))
const LogsPage = lazy(() => import('./pages/LogsPage'))
const IdentityPage = lazy(() => import('./pages/IdentityPage'))
const PersonalityPage = lazy(() => import('./pages/PersonalityPage'))
const MemoryPage = lazy(() => import('./pages/MemoryPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))
const SkillsPage = lazy(() => import('./pages/SkillsPage'))
const VaultsPage = lazy(() => import('./pages/VaultsPage'))
const SetupWizard = lazy(() => import('./pages/SetupWizard'))

function NotFoundPage() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
      <h1 className="text-6xl font-bold text-text mb-4">{t('errors.notFound.code')}</h1>
      <p className="text-lg mb-6">{t('errors.notFound.message')}</p>
      <a href="/" className="text-accent hover:text-accent-hover transition-colors">
        {t('errors.notFound.backToChat')}
      </a>
    </div>
  )
}

function RouteLoadingFallback() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-1 flex-col items-center justify-center text-text-secondary gap-3">
      <h2 className="text-text text-2xl font-bold tracking-tight">{t('workspace.loading.portal')}</h2>
      <p className="text-[15px] text-text-tertiary">{t('workspace.loading.portalSubtitle')}</p>
    </div>
  )
}

export default function App() {
  useLanguageSync()
  const rootDatasetSetupMode = typeof document !== 'undefined'
    ? document.getElementById('root')?.getAttribute('data-strada-setup') === '1'
    : false
  const setupMode = typeof window !== 'undefined' && detectSetupMode(
    window.location.search,
    rootDatasetSetupMode || Boolean((window as Window & { __STRADA_SETUP__?: boolean }).__STRADA_SETUP__),
  )

  if (setupMode) {
    return (
      <ErrorBoundary>
        <Suspense fallback={<RouteLoadingFallback />}>
          <Routes>
            <Route path="*" element={<SetupWizard />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    )
  }

  return (
    <ErrorBoundary>
      <Suspense fallback={<RouteLoadingFallback />}>
        <Routes>
          <Route path="/setup" element={<SetupWizard />} />
          <Route element={<AppLayout />}>
            <Route index element={<ChatView />} />
            <Route path="admin">
              <Route path="dashboard" element={<DashboardView />} />
              <Route path="config" element={<ConfigPage />} />
              <Route path="tools" element={<ToolsPage />} />
              <Route path="channels" element={<ChannelsPage />} />
              <Route path="sessions" element={<SessionsPage />} />
              <Route path="logs" element={<LogsPage />} />
              <Route path="identity" element={<IdentityPage />} />
              <Route path="personality" element={<PersonalityPage />} />
              <Route path="memory" element={<MemoryPage />} />
              <Route path="vaults" element={<VaultsPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="skills" element={<SkillsPage />} />
            </Route>
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </Suspense>
    </ErrorBoundary>
  )
}

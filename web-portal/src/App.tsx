import { Suspense, lazy } from 'react'
import { Routes, Route } from 'react-router-dom'
import ErrorBoundary from './components/ErrorBoundary'
import AppLayout from './components/layout/AppLayout'
import { detectSetupMode } from './utils/setup-mode'

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
const SetupWizard = lazy(() => import('./pages/SetupWizard'))

function RouteLoadingFallback() {
  return (
    <div className="placeholder-page">
      <h2>Loading Strada portal</h2>
      <p>Preparing the next screen.</p>
    </div>
  )
}

export default function App() {
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
            <Route path="dashboard" element={<DashboardView />} />
            <Route path="config" element={<ConfigPage />} />
            <Route path="tools" element={<ToolsPage />} />
            <Route path="channels" element={<ChannelsPage />} />
            <Route path="sessions" element={<SessionsPage />} />
            <Route path="logs" element={<LogsPage />} />
            <Route path="identity" element={<IdentityPage />} />
            <Route path="personality" element={<PersonalityPage />} />
            <Route path="memory" element={<MemoryPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<ChatView />} />
          </Route>
        </Routes>
      </Suspense>
    </ErrorBoundary>
  )
}

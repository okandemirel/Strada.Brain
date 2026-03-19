import { Routes, Route } from 'react-router-dom'
import ErrorBoundary from './components/ErrorBoundary'
import AppLayout from './components/layout/AppLayout'
import ChatView from './components/ChatView'
import DashboardView from './components/DashboardView'
import ConfigPage from './pages/ConfigPage'
import ToolsPage from './pages/ToolsPage'
import ChannelsPage from './pages/ChannelsPage'
import SessionsPage from './pages/SessionsPage'
import LogsPage from './pages/LogsPage'
import IdentityPage from './pages/IdentityPage'
import PersonalityPage from './pages/PersonalityPage'
import MemoryPage from './pages/MemoryPage'
import SettingsPage from './pages/SettingsPage'
import SetupWizard from './pages/SetupWizard'
import { FIRST_RUN_STORAGE_KEY } from './hooks/useWebSocket'
import { detectSetupMode } from './utils/setup-mode'

export default function App() {
  const rootDatasetSetupMode = typeof document !== 'undefined'
    ? document.getElementById('root')?.getAttribute('data-strada-setup') === '1'
    : false
  const firstRunCommitted = typeof window !== 'undefined'
    ? window.localStorage.getItem(FIRST_RUN_STORAGE_KEY) === '1'
    : false
  const setupMode = typeof window !== 'undefined' && detectSetupMode(
    window.location.search,
    rootDatasetSetupMode || Boolean((window as Window & { __STRADA_SETUP__?: boolean }).__STRADA_SETUP__),
    firstRunCommitted,
  )

  if (setupMode) {
    return (
      <ErrorBoundary>
        <Routes>
          <Route path="*" element={<SetupWizard />} />
        </Routes>
      </ErrorBoundary>
    )
  }

  return (
    <ErrorBoundary>
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
    </ErrorBoundary>
  )
}

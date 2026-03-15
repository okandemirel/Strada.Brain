import { Routes, Route } from 'react-router-dom'
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
import SetupWizard from './pages/SetupWizard'

export default function App() {
  return (
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
        <Route path="*" element={<ChatView />} />
      </Route>
    </Routes>
  )
}

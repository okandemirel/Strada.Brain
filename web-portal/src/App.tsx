import { Routes, Route } from 'react-router-dom'
import AppLayout from './components/layout/AppLayout'
import ChatView from './components/ChatView'
import DashboardView from './components/DashboardView'
import PlaceholderPage from './components/placeholder/PlaceholderPage'
import SetupWizard from './pages/SetupWizard'

export default function App() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupWizard />} />
      <Route element={<AppLayout />}>
        <Route index element={<ChatView />} />
        <Route path="dashboard" element={<DashboardView />} />
        <Route path="config" element={<PlaceholderPage title="Config" />} />
        <Route path="tools" element={<PlaceholderPage title="Tools" />} />
        <Route path="channels" element={<PlaceholderPage title="Channels" />} />
        <Route path="sessions" element={<PlaceholderPage title="Sessions" />} />
        <Route path="logs" element={<PlaceholderPage title="Logs" />} />
        <Route path="identity" element={<PlaceholderPage title="Identity" />} />
        <Route path="personality" element={<PlaceholderPage title="Personality" />} />
        <Route path="memory" element={<PlaceholderPage title="Memory" />} />
        <Route path="*" element={<ChatView />} />
      </Route>
    </Routes>
  )
}

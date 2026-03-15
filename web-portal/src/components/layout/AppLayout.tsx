import { Outlet } from 'react-router-dom'
import { WebSocketProvider } from '../../contexts/WebSocketContext'
import Sidebar from './Sidebar'

export default function AppLayout() {
  return (
    <WebSocketProvider>
      <div className="app-layout">
        <Sidebar />
        <main className="app-main">
          <Outlet />
        </main>
      </div>
    </WebSocketProvider>
  )
}

import { Outlet } from 'react-router-dom'
import { WebSocketProvider } from '../../contexts/WebSocketContext'
import Sidebar from './Sidebar'

export default function AppLayout() {
  return (
    <WebSocketProvider>
      <div className="flex h-full overflow-hidden">
        <Sidebar />
        <main className="flex flex-1 flex-col overflow-hidden min-w-0">
          <Outlet />
        </main>
      </div>
    </WebSocketProvider>
  )
}

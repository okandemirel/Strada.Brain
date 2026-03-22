import { Outlet } from 'react-router-dom'
import { WebSocketProvider } from '../../contexts/WebSocketContext'
import { TooltipProvider } from '../ui/tooltip'
import Sidebar from './Sidebar'
import PanelLayout from '../workspace/PanelLayout'

export default function AppLayout() {
  return (
    <WebSocketProvider>
      <TooltipProvider>
        <div className="flex h-screen bg-bg text-text">
          <Sidebar />
          <div className="flex-1 flex flex-col min-w-0">
            <PanelLayout primary={<Outlet />} />
          </div>
        </div>
      </TooltipProvider>
    </WebSocketProvider>
  )
}

import { Suspense, lazy } from 'react'
import { Outlet } from 'react-router-dom'
import { WebSocketProvider } from '../../contexts/WebSocketContext'
import { TooltipProvider } from '../ui/tooltip'
import Sidebar from './Sidebar'
import PanelLayout from '../workspace/PanelLayout'
import BottomTabBar from './BottomTabBar'
import { useKeyboardShortcuts } from '../../hooks/use-keyboard-shortcuts'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useSidebarStore } from '../../stores/sidebar-store'

const MonitorPanel = lazy(() => import('../monitor/MonitorPanel'))

function PrimaryContent() {
  const mode = useWorkspaceStore((s) => s.mode)

  if (mode === 'monitor') {
    return (
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-full text-text-tertiary text-sm">
            Loading monitor...
          </div>
        }
      >
        <MonitorPanel />
      </Suspense>
    )
  }

  return <Outlet />
}

function AppLayoutInner() {
  const setMode = useWorkspaceStore((s) => s.setMode)
  const toggleSecondary = useWorkspaceStore((s) => s.toggleSecondary)
  const toggleSidebar = useSidebarStore((s) => s.toggle)
  useKeyboardShortcuts({ setMode, toggleSidebar, toggleSecondary })

  return (
    <>
      <div className="flex h-screen bg-bg text-text">
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0 pb-14 md:pb-0">
          <PanelLayout primary={<PrimaryContent />} />
        </div>
      </div>
      <BottomTabBar />
    </>
  )
}

export default function AppLayout() {
  return (
    <WebSocketProvider>
      <TooltipProvider>
        <AppLayoutInner />
      </TooltipProvider>
    </WebSocketProvider>
  )
}

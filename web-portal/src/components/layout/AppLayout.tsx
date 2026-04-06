import { Suspense, lazy, useState, useCallback } from 'react'
import { Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { WebSocketProvider } from '../../contexts/WebSocketContext'
import { TooltipProvider } from '../ui/tooltip'
import PanelErrorBoundary from '../PanelErrorBoundary'
import Sidebar from './Sidebar'
import PanelLayout from '../workspace/PanelLayout'
import BottomTabBar from './BottomTabBar'
import { Toaster } from 'sonner'
import ShortcutsHelp from '../ui/ShortcutsHelp'
import { useKeyboardShortcuts } from '../../hooks/use-keyboard-shortcuts'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useSidebarStore } from '../../stores/sidebar-store'

const MonitorPanel = lazy(() => import('../monitor/MonitorPanel'))
const CanvasPanel = lazy(() => import('../canvas/CanvasPanel'))
const CodePanel = lazy(() => import('../code/CodePanel'))

function PanelFallback({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center h-full text-text-tertiary text-sm">
      {label}
    </div>
  )
}

const PANEL_MAP: Record<string, React.LazyExoticComponent<React.ComponentType>> = {
  monitor: MonitorPanel,
  canvas: CanvasPanel,
  code: CodePanel,
}

function PrimaryContent() {
  const { t } = useTranslation()
  const mode = useWorkspaceStore((s) => s.mode)

  const Panel = PANEL_MAP[mode]
  if (!Panel) return <Outlet />

  return (
    <PanelErrorBoundary panelName={mode}>
      <Suspense fallback={<PanelFallback label={t(`workspace.loading.${mode}`)} />}>
        <Panel />
      </Suspense>
    </PanelErrorBoundary>
  )
}

function AppLayoutInner() {
  const setMode = useWorkspaceStore((s) => s.setMode)
  const toggleSecondary = useWorkspaceStore((s) => s.toggleSecondary)
  const toggleSidebar = useSidebarStore((s) => s.toggle)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const showShortcutsHelp = useCallback(() => setShortcutsOpen((prev) => !prev), [])
  useKeyboardShortcuts({ setMode, toggleSidebar, toggleSecondary, showShortcutsHelp })

  return (
    <>
      <div className="flex h-screen bg-bg text-text">
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0 pb-14 md:pb-0">
          <PanelLayout primary={<PrimaryContent />} />
        </div>
      </div>
      <BottomTabBar />
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: 'var(--color-bg-secondary)',
            border: '1px solid rgba(255,255,255,0.1)',
            color: 'var(--color-text)',
            backdropFilter: 'blur(16px)',
          },
        }}
        visibleToasts={3}
      />
      <ShortcutsHelp open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
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

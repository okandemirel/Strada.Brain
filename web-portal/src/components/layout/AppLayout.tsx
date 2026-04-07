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
import { useOnlineStatus } from '../../hooks/useOnlineStatus'
import { useSessionStore } from '../../stores/session-store'

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

function OfflineBanner() {
  const { t } = useTranslation()
  const { isOnline } = useOnlineStatus()

  if (isOnline) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-14 md:bottom-0 inset-x-0 z-50 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-yellow-600/90 text-white backdrop-blur-sm"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="w-4 h-4 flex-shrink-0"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z"
          clipRule="evenodd"
        />
      </svg>
      {t('connection.offline')}
    </div>
  )
}

function DisconnectBanner() {
  const { t } = useTranslation()
  const reconnectExhausted = useSessionStore((s) => s.reconnectExhausted)
  const status = useSessionStore((s) => s.status)

  if (!reconnectExhausted || status === 'connected') return null

  const handleReload = () => window.location.reload()

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed bottom-14 md:bottom-0 inset-x-0 z-50 flex items-center justify-center gap-3 px-4 py-2.5 text-sm font-medium bg-error/90 text-white backdrop-blur-sm"
    >
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 shrink-0" aria-hidden="true">
        <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
      </svg>
      {t('connection.lost', 'Connection lost. Unable to reconnect.')}
      <button
        onClick={handleReload}
        className="ml-2 rounded-md border border-white/30 bg-white/10 px-3 py-1 text-xs font-semibold transition-colors hover:bg-white/20"
      >
        {t('connection.reload', 'Reload')}
      </button>
    </div>
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
      <OfflineBanner />
      <DisconnectBanner />
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

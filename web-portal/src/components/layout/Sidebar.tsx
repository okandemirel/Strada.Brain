import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Sun, Moon, ChevronLeft, ChevronRight, Bell } from 'lucide-react'
import { useWS } from '../../hooks/useWS'
import { useTheme } from '../../hooks/useTheme'
import { useSidebarStore } from '../../stores/sidebar-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { WORKSPACE_MODES } from '../../config/workspace-modes'
import { CONNECTION_STATUS } from '../../config/connection-status'
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip'
import AdminNav from './AdminNav'
import MiniChat from '../workspace/MiniChat'
import NotificationCenter from './NotificationCenter'
import { SparklesText } from '../ui/sparkles-text'

export default function Sidebar() {
  const { t } = useTranslation()
  const { status } = useWS()
  const { theme, toggleTheme } = useTheme()
  const { collapsed, toggle } = useSidebarStore()
  const currentMode = useWorkspaceStore((s) => s.mode)
  const setMode = useWorkspaceStore((s) => s.setMode)
  const notifications = useWorkspaceStore((s) => s.notifications)
  const notificationCount = notifications.length
  const navigate = useNavigate()
  const location = useLocation()
  const [notifOpen, setNotifOpen] = useState(false)

  const handleModeClick = (mode: typeof currentMode) => {
    setMode(mode)
    if (mode === 'chat' && location.pathname.startsWith('/admin')) {
      navigate('/')
    }
  }

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1439px)')
    if (mq.matches && !useSidebarStore.getState().collapsed) toggle()
    const handler = (e: MediaQueryListEvent) => {
      if (e.matches && !useSidebarStore.getState().collapsed) toggle()
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [toggle])

  return (
    <aside
      className={`hidden md:flex flex-col h-screen bg-bg-secondary/80 backdrop-blur-xl border-r border-white/5 transition-all duration-300 ${collapsed ? 'w-14' : 'w-60'} max-md:fixed max-md:z-[1000]`}
      role="navigation"
      aria-label={t('nav.sidebar')}
    >
      {/* Logo / Brand */}
      <div className={`flex flex-row items-center gap-3 p-4 border-b border-border bg-gradient-to-b from-transparent to-bg-tertiary/30 shrink-0 ${collapsed ? 'justify-center px-2' : ''}`}>
        <img src="/strada-brain-icon.png" alt="" width="28" height="28" className="w-7 h-7 rounded-lg shrink-0 object-contain" />
        {!collapsed && <SparklesText className="text-[17px] font-bold tracking-tight whitespace-nowrap overflow-hidden text-ellipsis" colors={{ first: '#00e5ff', second: '#9E7AFF' }}>Strada.Brain</SparklesText>}
      </div>

      {/* Mode buttons */}
      <TooltipProvider delayDuration={300}>
        <div className="p-2 flex flex-col gap-0.5">
          {WORKSPACE_MODES.map((btn) => {
            const isActive = currentMode === btn.mode
            const Icon = btn.icon
            const modeLabel = t(`modes.${btn.mode}.label`)
            const modeDesc = t(`modes.${btn.mode}.description`)

            if (!btn.enabled) {
              return (
                <Tooltip key={btn.mode}>
                  <TooltipTrigger asChild>
                    <button
                      disabled
                      aria-label={modeLabel}
                      className={`flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-sm font-medium whitespace-nowrap overflow-hidden select-none bg-transparent border-none font-[inherit] text-left w-full opacity-40 cursor-not-allowed ${collapsed ? 'justify-center px-2' : ''}`}
                    >
                      <span className="w-[22px] text-center text-base shrink-0 leading-none">
                        <Icon size={18} />
                      </span>
                      {!collapsed && <span className="whitespace-nowrap overflow-hidden text-ellipsis">{modeLabel}</span>}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right" className="max-w-[220px]">
                    <div className="font-medium text-text">{modeLabel}</div>
                    <p className="mt-1 text-xs leading-5 text-text-secondary">{modeDesc}</p>
                    <p className="mt-2 text-xs text-text-tertiary">{t('sidebar.comingSoon')}</p>
                  </TooltipContent>
                </Tooltip>
              )
            }

            return (
              <Tooltip key={btn.mode}>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => handleModeClick(btn.mode)}
                    aria-label={modeLabel}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-sm font-medium transition-all duration-150 cursor-pointer whitespace-nowrap overflow-hidden select-none bg-transparent border-none font-[inherit] text-left w-full ${
                      collapsed ? 'justify-center px-2' : ''
                    } ${
                      isActive
                        ? 'relative before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:h-5 before:w-0.5 before:bg-accent before:rounded-r bg-accent-glow text-accent font-semibold'
                        : 'text-text-secondary hover:bg-bg-tertiary hover:text-text hover:translate-x-0.5'
                    }`}
                    title={collapsed ? modeLabel : undefined}
                  >
                    <span className="w-[22px] text-center text-base shrink-0 leading-none">
                      <Icon size={18} />
                    </span>
                    {!collapsed && <span className="whitespace-nowrap overflow-hidden text-ellipsis">{modeLabel}</span>}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-[220px]">
                  <div className="font-medium text-text">{modeLabel}</div>
                  <p className="mt-1 text-xs leading-5 text-text-secondary">{modeDesc}</p>
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      </TooltipProvider>

      {/* Admin nav */}
      <div className="px-2">
        <AdminNav collapsed={collapsed} />
      </div>

      {/* Mini chat — only when expanded */}
      {!collapsed && <MiniChat />}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Footer */}
      <div className="p-2 border-t border-border flex flex-col gap-0.5 shrink-0">
        {/* Notifications */}
        <button
          aria-label={t('sidebar.notifications')}
          onClick={() => setNotifOpen((prev) => !prev)}
          className={`relative flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-text-secondary text-sm font-medium whitespace-nowrap overflow-hidden select-none transition-all duration-150 cursor-pointer bg-transparent border-none font-[inherit] text-left w-full hover:bg-bg-tertiary hover:text-text ${collapsed ? 'justify-center px-2' : ''}`}
        >
          <span className="w-[22px] text-center text-base shrink-0 leading-none relative">
            <Bell size={16} />
            {notificationCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 rounded-full bg-accent text-[10px] font-bold text-white flex items-center justify-center leading-none">
                {notificationCount > 9 ? '9+' : notificationCount}
              </span>
            )}
          </span>
          {!collapsed && <span className="whitespace-nowrap overflow-hidden text-ellipsis">{t('sidebar.notifications')}</span>}
        </button>
        <NotificationCenter open={notifOpen} onOpenChange={setNotifOpen} />

        {/* Theme toggle */}
        <button
          className={`flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-text-secondary text-sm font-medium transition-all duration-150 cursor-pointer whitespace-nowrap overflow-hidden select-none bg-transparent border-none font-[inherit] text-left w-full hover:bg-bg-tertiary hover:text-text ${collapsed ? 'justify-center px-2' : ''}`}
          onClick={toggleTheme}
          title={theme === 'dark' ? t('sidebar.lightMode') : t('sidebar.darkMode')}
          aria-label={theme === 'dark' ? t('sidebar.lightMode') : t('sidebar.darkMode')}
        >
          <span className="w-[22px] text-center text-base shrink-0 leading-none">{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</span>
          {!collapsed && <span className="whitespace-nowrap overflow-hidden text-ellipsis">{theme === 'dark' ? t('sidebar.lightMode') : t('sidebar.darkMode')}</span>}
        </button>

        {/* Collapse toggle */}
        <button
          className={`flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-text-secondary text-sm font-medium transition-all duration-150 cursor-pointer whitespace-nowrap overflow-hidden select-none bg-transparent border-none font-[inherit] text-left w-full hover:bg-bg-tertiary hover:text-text ${collapsed ? 'justify-center px-2' : ''}`}
          onClick={toggle}
          title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
        >
          <span className="w-[22px] text-center text-base shrink-0 leading-none">{collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}</span>
          {!collapsed && <span className="whitespace-nowrap overflow-hidden text-ellipsis">{t('sidebar.collapse')}</span>}
        </button>

        {/* Connection health */}
        <div className={`flex flex-row items-center gap-2 px-3 py-2.5 text-xs text-text-tertiary whitespace-nowrap overflow-hidden ${collapsed ? 'justify-center px-2' : ''}`} title={t(`connection.${status}`)}>
          <span className={`w-2 h-2 rounded-full shrink-0 transition-all duration-300 ${CONNECTION_STATUS[status].color}`} />
          {!collapsed && (
            <span className="overflow-hidden text-ellipsis">
              {t(`connection.${status}`)}
            </span>
          )}
        </div>
      </div>
    </aside>
  )
}

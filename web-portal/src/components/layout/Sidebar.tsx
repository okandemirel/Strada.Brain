import { useEffect, useState, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Sun, Moon, ChevronLeft, ChevronRight, Bell } from 'lucide-react'
import { useWS } from '../../hooks/useWS'
import { useTheme } from '../../hooks/useTheme'
import { useSidebarStore } from '../../stores/sidebar-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { WORKSPACE_MODES } from '../../config/workspace-modes'
import { CONNECTION_STATUS } from '../../config/connection-status'
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip'
import AdminDropdown from './AdminDropdown'
import MiniChat from '../workspace/MiniChat'

export default function Sidebar() {
  const { status } = useWS()
  const { theme, toggleTheme } = useTheme()
  const { collapsed, toggle } = useSidebarStore()
  const currentMode = useWorkspaceStore((s) => s.mode)
  const setMode = useWorkspaceStore((s) => s.setMode)
  const notifications = useWorkspaceStore((s) => s.notifications)
  const dismissNotification = useWorkspaceStore((s) => s.dismissNotification)
  const notificationCount = notifications.length
  const navigate = useNavigate()
  const location = useLocation()
  const [notifOpen, setNotifOpen] = useState(false)
  const notifRef = useRef<HTMLDivElement>(null)

  const handleModeClick = (mode: typeof currentMode) => {
    setMode(mode)
    if (mode === 'chat' && location.pathname.startsWith('/admin')) {
      navigate('/')
    }
  }

  // Close notification panel on outside click
  useEffect(() => {
    if (!notifOpen) return
    const handler = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [notifOpen])

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
      className={`hidden md:flex flex-col h-screen bg-bg-secondary border-r border-border transition-all duration-300 ${collapsed ? 'w-14' : 'w-60'} max-md:fixed max-md:z-[1000]`}
    >
      {/* Logo / Brand */}
      <div className={`flex flex-row items-center gap-3 p-4 border-b border-border shrink-0 ${collapsed ? 'justify-center px-2' : ''}`}>
        <img src="/strada-brain-icon.png" alt="" width="28" height="28" className="w-7 h-7 rounded-lg shrink-0 object-contain" />
        {!collapsed && <span className="text-[17px] font-bold text-text tracking-tight whitespace-nowrap overflow-hidden text-ellipsis">Strada.Brain</span>}
      </div>

      {/* Mode buttons */}
      <TooltipProvider delayDuration={300}>
        <div className="p-2 flex flex-col gap-0.5">
          {WORKSPACE_MODES.map((btn) => {
            const isActive = currentMode === btn.mode
            const Icon = btn.icon

            if (!btn.enabled) {
              return (
                <Tooltip key={btn.mode}>
                  <TooltipTrigger asChild>
                    <button
                      disabled
                      className={`flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-sm font-medium whitespace-nowrap overflow-hidden select-none bg-transparent border-none font-[inherit] text-left w-full opacity-40 cursor-not-allowed ${collapsed ? 'justify-center px-2' : ''}`}
                    >
                      <span className="w-[22px] text-center text-base shrink-0 leading-none">
                        <Icon size={18} />
                      </span>
                      {!collapsed && <span className="whitespace-nowrap overflow-hidden text-ellipsis">{btn.label}</span>}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    <p>Coming soon</p>
                  </TooltipContent>
                </Tooltip>
              )
            }

            return (
              <button
                key={btn.mode}
                onClick={() => handleModeClick(btn.mode)}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-sm font-medium transition-all duration-150 cursor-pointer whitespace-nowrap overflow-hidden select-none bg-transparent border-none font-[inherit] text-left w-full ${
                  collapsed ? 'justify-center px-2' : ''
                } ${
                  isActive
                    ? 'bg-accent-glow text-accent font-semibold'
                    : 'text-text-secondary hover:bg-bg-tertiary hover:text-text'
                }`}
                title={collapsed ? btn.label : undefined}
              >
                <span className="w-[22px] text-center text-base shrink-0 leading-none">
                  <Icon size={18} />
                </span>
                {!collapsed && <span className="whitespace-nowrap overflow-hidden text-ellipsis">{btn.label}</span>}
              </button>
            )
          })}
        </div>
      </TooltipProvider>

      {/* Admin dropdown */}
      <div className="px-2">
        <AdminDropdown collapsed={collapsed} />
      </div>

      {/* Mini chat — only when expanded */}
      {!collapsed && <MiniChat />}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Footer */}
      <div className="p-2 border-t border-border flex flex-col gap-0.5 shrink-0">
        {/* Notifications */}
        <div className="relative" ref={notifRef}>
          <button
            aria-label="Notifications"
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
            {!collapsed && <span className="whitespace-nowrap overflow-hidden text-ellipsis">Notifications</span>}
          </button>
          {notifOpen && (
            <div className="absolute bottom-full left-0 mb-2 w-72 max-h-80 overflow-y-auto bg-bg-secondary border border-border rounded-xl shadow-lg z-50">
              <div className="px-3 py-2 border-b border-border text-xs font-semibold text-text-secondary uppercase tracking-wide">
                Notifications {notificationCount > 0 && `(${notificationCount})`}
              </div>
              {notifications.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-text-tertiary">No notifications</div>
              ) : (
                <div className="flex flex-col">
                  {[...notifications].reverse().slice(0, 20).map((n) => (
                    <div key={n.id} className="flex items-start gap-2 px-3 py-2 border-b border-border last:border-b-0 hover:bg-bg-tertiary">
                      <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${n.severity === 'error' ? 'bg-error' : n.severity === 'warning' ? 'bg-warning' : 'bg-accent'}`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold text-text truncate">{n.title}</div>
                        <div className="text-xs text-text-secondary truncate">{n.message}</div>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); dismissNotification(n.id) }}
                        className="shrink-0 text-text-tertiary hover:text-text text-xs px-1 cursor-pointer bg-transparent border-none"
                        aria-label="Dismiss"
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Theme toggle */}
        <button
          className={`flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-text-secondary text-sm font-medium transition-all duration-150 cursor-pointer whitespace-nowrap overflow-hidden select-none bg-transparent border-none font-[inherit] text-left w-full hover:bg-bg-tertiary hover:text-text ${collapsed ? 'justify-center px-2' : ''}`}
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
        >
          <span className="w-[22px] text-center text-base shrink-0 leading-none">{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</span>
          {!collapsed && <span className="whitespace-nowrap overflow-hidden text-ellipsis">{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>}
        </button>

        {/* Collapse toggle */}
        <button
          className={`flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-text-secondary text-sm font-medium transition-all duration-150 cursor-pointer whitespace-nowrap overflow-hidden select-none bg-transparent border-none font-[inherit] text-left w-full hover:bg-bg-tertiary hover:text-text ${collapsed ? 'justify-center px-2' : ''}`}
          onClick={toggle}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          <span className="w-[22px] text-center text-base shrink-0 leading-none">{collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}</span>
          {!collapsed && <span className="whitespace-nowrap overflow-hidden text-ellipsis">Collapse</span>}
        </button>

        {/* Connection health */}
        <div className={`flex flex-row items-center gap-2 px-3 py-2.5 text-xs text-text-tertiary whitespace-nowrap overflow-hidden ${collapsed ? 'justify-center px-2' : ''}`} title={CONNECTION_STATUS[status].label}>
          <span className={`w-2 h-2 rounded-full shrink-0 transition-all duration-300 ${CONNECTION_STATUS[status].color}`} />
          {!collapsed && (
            <span className="overflow-hidden text-ellipsis">
              {CONNECTION_STATUS[status].label}
            </span>
          )}
        </div>
      </div>
    </aside>
  )
}

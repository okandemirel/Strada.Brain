import {
  MessageSquare, Activity, Paintbrush, Code,
  Sun, Moon, ChevronLeft, ChevronRight, Bell,
  type LucideIcon,
} from 'lucide-react'
import { useWS } from '../../hooks/useWS'
import { useTheme } from '../../hooks/useTheme'
import { useSidebarStore } from '../../stores/sidebar-store'
import { useWorkspaceStore, type WorkspaceMode } from '../../stores/workspace-store'
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip'
import AdminDropdown from './AdminDropdown'

interface ModeButton {
  mode: WorkspaceMode
  icon: LucideIcon
  label: string
  enabled: boolean
}

const MODE_BUTTONS: ModeButton[] = [
  { mode: 'chat', icon: MessageSquare, label: 'Chat', enabled: true },
  { mode: 'monitor', icon: Activity, label: 'Monitor', enabled: false },
  { mode: 'canvas', icon: Paintbrush, label: 'Canvas', enabled: false },
  { mode: 'code', icon: Code, label: 'Code', enabled: false },
]

export default function Sidebar() {
  const { status } = useWS()
  const { theme, toggleTheme } = useTheme()
  const { collapsed, toggle } = useSidebarStore()
  const currentMode = useWorkspaceStore((s) => s.mode)
  const setMode = useWorkspaceStore((s) => s.setMode)

  const isConnected = status === 'connected'

  return (
    <aside
      className={`flex flex-col h-screen bg-bg-secondary border-r border-border transition-all duration-300 ${collapsed ? 'w-14' : 'w-60'} max-md:fixed max-md:z-[1000]`}
    >
      {/* Logo / Brand */}
      <div className={`flex flex-row items-center gap-3 p-4 border-b border-border shrink-0 ${collapsed ? 'justify-center px-2' : ''}`}>
        <img src="/strada-brain-icon.png" alt="" width="28" height="28" className="w-7 h-7 rounded-lg shrink-0 object-contain" />
        {!collapsed && <span className="text-[17px] font-bold text-text tracking-tight whitespace-nowrap overflow-hidden text-ellipsis">Strada.Brain</span>}
      </div>

      {/* Mode buttons */}
      <TooltipProvider delayDuration={300}>
        <div className="p-2 flex flex-col gap-0.5">
          {MODE_BUTTONS.map((btn) => {
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
                onClick={() => setMode(btn.mode)}
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

      {/* Spacer */}
      <div className="flex-1" />

      {/* Footer */}
      <div className="p-2 border-t border-border flex flex-col gap-0.5 shrink-0">
        {/* Notifications placeholder */}
        <div
          className={`relative flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-text-secondary text-sm font-medium whitespace-nowrap overflow-hidden select-none ${collapsed ? 'justify-center px-2' : ''}`}
          title="Notifications"
        >
          <span className="w-[22px] text-center text-base shrink-0 leading-none relative">
            <Bell size={16} />
            <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-accent" />
          </span>
          {!collapsed && <span className="whitespace-nowrap overflow-hidden text-ellipsis">Notifications</span>}
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
        <div className={`flex flex-row items-center gap-2 px-3 py-2.5 text-xs text-text-tertiary whitespace-nowrap overflow-hidden ${collapsed ? 'justify-center px-2' : ''}`} title={isConnected ? 'Connected' : status}>
          <span className={`w-2 h-2 rounded-full shrink-0 transition-all duration-300 ${isConnected ? 'bg-success shadow-[0_0_6px_var(--color-success)]' : 'bg-error shadow-[0_0_6px_var(--color-error)]'}`} />
          {!collapsed && (
            <span className="overflow-hidden text-ellipsis">
              {isConnected ? 'Health OK' : status}
            </span>
          )}
        </div>
      </div>
    </aside>
  )
}

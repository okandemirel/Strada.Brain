import { NavLink } from 'react-router-dom'
import {
  MessageSquare, BarChart3, Settings, Wrench, Radio,
  Users, ScrollText, Brain, Theater, Database,
  Sun, Moon, ChevronLeft, ChevronRight,
  type LucideIcon,
} from 'lucide-react'
import { useWS } from '../../hooks/useWS'
import { useTheme } from '../../hooks/useTheme'
import { useSidebar } from '../../hooks/useSidebar'

const SECTIONS: { title: string; items: { to: string; icon: LucideIcon; label: string; end?: boolean }[] }[] = [
  {
    title: 'MAIN',
    items: [
      { to: '/', icon: MessageSquare, label: 'Chat', end: true },
      { to: '/dashboard', icon: BarChart3, label: 'Dashboard' },
    ],
  },
  {
    title: 'ADMIN',
    items: [
      { to: '/config', icon: Settings, label: 'Config' },
      { to: '/tools', icon: Wrench, label: 'Tools' },
      { to: '/channels', icon: Radio, label: 'Channels' },
      { to: '/sessions', icon: Users, label: 'Sessions' },
      { to: '/logs', icon: ScrollText, label: 'Logs' },
    ],
  },
  {
    title: 'AGENT',
    items: [
      { to: '/identity', icon: Brain, label: 'Identity' },
      { to: '/personality', icon: Theater, label: 'Personality' },
      { to: '/memory', icon: Database, label: 'Memory' },
      { to: '/settings', icon: Settings, label: 'Settings' },
    ],
  },
]

export default function Sidebar() {
  const { status } = useWS()
  const { theme, toggleTheme } = useTheme()
  const { collapsed, toggle } = useSidebar()

  const isConnected = status === 'connected'

  return (
    <aside
      className={`${collapsed ? 'w-14' : 'w-60'} h-full flex flex-col bg-bg-secondary backdrop-blur-[40px] backdrop-saturate-[180%] border-r border-border z-[100] transition-[width] duration-300 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] overflow-hidden shrink-0 max-md:fixed max-md:top-0 max-md:left-0 max-md:z-[1000] max-md:shadow-[var(--shadow-lg)] ${collapsed ? 'max-md:-translate-x-full max-md:!w-60' : 'max-md:translate-x-0'}`}
    >
      {/* Header */}
      <div className={`flex flex-row items-center gap-3 p-4 border-b border-border shrink-0 ${collapsed ? 'justify-center px-2' : ''}`}>
        <img src="/strada-brain-icon.png" alt="" width="28" height="28" className="w-7 h-7 rounded-lg shrink-0 object-contain" />
        {!collapsed && <span className="text-[17px] font-bold text-text tracking-tight whitespace-nowrap overflow-hidden text-ellipsis">Strada.Brain</span>}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto p-2 scrollbar-thin" style={{ scrollbarColor: 'var(--color-scrollbar-thumb) transparent' }}>
        {SECTIONS.map((section) => (
          <div key={section.title} className="mb-2">
            {!collapsed && (
              <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary px-3 pt-2 pb-1 whitespace-nowrap overflow-hidden text-ellipsis select-none">
                {section.title}
              </div>
            )}
            {section.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-sm font-medium transition-all duration-150 cursor-pointer relative whitespace-nowrap overflow-hidden select-none no-underline ${
                    collapsed ? 'justify-center px-2' : ''
                  } ${
                    isActive
                      ? 'bg-accent-glow text-accent font-semibold sidebar-item-active'
                      : 'text-text-secondary hover:bg-bg-tertiary hover:text-text'
                  }`
                }
                title={collapsed ? item.label : undefined}
              >
                <span className="w-[22px] text-center text-base shrink-0 leading-none"><item.icon size={18} /></span>
                {!collapsed && <span className="whitespace-nowrap overflow-hidden text-ellipsis">{item.label}</span>}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="p-2 border-t border-border flex flex-col gap-0.5 shrink-0">
        <button
          className={`flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-text-secondary text-sm font-medium transition-all duration-150 cursor-pointer whitespace-nowrap overflow-hidden select-none bg-transparent border-none font-[inherit] text-left w-full hover:bg-bg-tertiary hover:text-text ${collapsed ? 'justify-center' : ''}`}
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
        >
          <span className="w-[22px] text-center text-base shrink-0 leading-none">{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</span>
          {!collapsed && <span className="whitespace-nowrap overflow-hidden text-ellipsis">{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>}
        </button>

        <button
          className={`flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-text-secondary text-sm font-medium transition-all duration-150 cursor-pointer whitespace-nowrap overflow-hidden select-none bg-transparent border-none font-[inherit] text-left w-full hover:bg-bg-tertiary hover:text-text ${collapsed ? 'justify-center' : ''}`}
          onClick={toggle}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          <span className="w-[22px] text-center text-base shrink-0 leading-none">{collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}</span>
          {!collapsed && <span className="whitespace-nowrap overflow-hidden text-ellipsis">Collapse</span>}
        </button>

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

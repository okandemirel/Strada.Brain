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
import '../../styles/sidebar.css'

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
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-header">
        <img src="/strada-brain-icon.png" alt="" width="28" height="28" className="sidebar-logo-icon" />
        {!collapsed && <span className="sidebar-logo-text">Strada.Brain</span>}
      </div>

      <nav className="sidebar-nav">
        {SECTIONS.map((section) => (
          <div key={section.title} className="sidebar-section">
            {!collapsed && <div className="sidebar-section-title">{section.title}</div>}
            {section.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `sidebar-item ${isActive ? 'active' : ''}`
                }
                title={collapsed ? item.label : undefined}
              >
                <span className="sidebar-item-icon"><item.icon size={18} /></span>
                {!collapsed && <span className="sidebar-item-label">{item.label}</span>}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <button className="sidebar-footer-btn" onClick={toggleTheme} title={theme === 'dark' ? 'Light Mode' : 'Dark Mode'}>
          <span className="sidebar-item-icon">{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</span>
          {!collapsed && <span className="sidebar-item-label">{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>}
        </button>

        <button className="sidebar-footer-btn" onClick={toggle} title={collapsed ? 'Expand' : 'Collapse'}>
          <span className="sidebar-item-icon">{collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}</span>
          {!collapsed && <span className="sidebar-item-label">Collapse</span>}
        </button>

        <div className="sidebar-health" title={isConnected ? 'Connected' : status}>
          <span className={`sidebar-health-dot ${isConnected ? 'ok' : 'err'}`} />
          {!collapsed && (
            <span className="sidebar-health-text">
              {isConnected ? 'Health OK' : status}
            </span>
          )}
        </div>
      </div>
    </aside>
  )
}

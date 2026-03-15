import { NavLink } from 'react-router-dom'
import { useWS } from '../../contexts/WebSocketContext'
import { useTheme } from '../../hooks/useTheme'
import { useSidebar } from '../../hooks/useSidebar'
import '../../styles/sidebar.css'

const SECTIONS = [
  {
    title: 'MAIN',
    items: [
      { to: '/', icon: '\uD83D\uDCAC', label: 'Chat', end: true },
      { to: '/dashboard', icon: '\uD83D\uDCCA', label: 'Dashboard' },
    ],
  },
  {
    title: 'ADMIN',
    items: [
      { to: '/config', icon: '\u2699\uFE0F', label: 'Config' },
      { to: '/tools', icon: '\uD83D\uDD27', label: 'Tools' },
      { to: '/channels', icon: '\uD83D\uDCE1', label: 'Channels' },
      { to: '/sessions', icon: '\uD83D\uDC65', label: 'Sessions' },
      { to: '/logs', icon: '\uD83D\uDCDC', label: 'Logs' },
    ],
  },
  {
    title: 'AGENT',
    items: [
      { to: '/identity', icon: '\uD83E\uDDEC', label: 'Identity' },
      { to: '/personality', icon: '\uD83C\uDFAD', label: 'Personality' },
      { to: '/memory', icon: '\uD83E\uDDE0', label: 'Memory' },
      { to: '/settings', icon: '\u2699\uFE0F', label: 'Settings' },
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
                <span className="sidebar-item-icon">{item.icon}</span>
                {!collapsed && <span className="sidebar-item-label">{item.label}</span>}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <button className="sidebar-footer-btn" onClick={toggleTheme} title={theme === 'dark' ? 'Light Mode' : 'Dark Mode'}>
          <span className="sidebar-item-icon">{theme === 'dark' ? '\u2600\uFE0F' : '\uD83C\uDF19'}</span>
          {!collapsed && <span className="sidebar-item-label">{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>}
        </button>

        <button className="sidebar-footer-btn" onClick={toggle} title={collapsed ? 'Expand' : 'Collapse'}>
          <span className="sidebar-item-icon">{collapsed ? '\u203A' : '\u2039'}</span>
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

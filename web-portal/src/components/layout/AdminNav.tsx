import { useState, useEffect } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  BarChart3, Settings, SlidersHorizontal, Wrench, Radio, Users,
  ScrollText, Brain, Theater, Database, Shield, Puzzle, ChevronDown,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWorkspaceStore } from '../../stores/workspace-store'

interface AdminPage {
  to: string
  icon: LucideIcon
  labelKey: string
}

const ADMIN_PAGES: AdminPage[] = [
  { to: '/admin/dashboard', icon: BarChart3, labelKey: 'nav.dashboard' },
  { to: '/admin/config', icon: SlidersHorizontal, labelKey: 'nav.config' },
  { to: '/admin/tools', icon: Wrench, labelKey: 'nav.tools' },
  { to: '/admin/channels', icon: Radio, labelKey: 'nav.channels' },
  { to: '/admin/sessions', icon: Users, labelKey: 'nav.sessions' },
  { to: '/admin/logs', icon: ScrollText, labelKey: 'nav.logs' },
  { to: '/admin/identity', icon: Brain, labelKey: 'nav.identity' },
  { to: '/admin/personality', icon: Theater, labelKey: 'nav.personality' },
  { to: '/admin/memory', icon: Database, labelKey: 'nav.memory' },
  { to: '/admin/settings', icon: Settings, labelKey: 'nav.settings' },
  { to: '/admin/skills', icon: Puzzle, labelKey: 'nav.skills' },
]

interface AdminNavProps {
  collapsed: boolean
}

export default function AdminNav({ collapsed }: AdminNavProps) {
  const { t } = useTranslation()
  const location = useLocation()
  const setMode = useWorkspaceStore((s) => s.setMode)
  const isOnAdmin = location.pathname.startsWith('/admin')
  const [expanded, setExpanded] = useState(isOnAdmin)

  useEffect(() => {
    setExpanded(isOnAdmin)
  }, [isOnAdmin])

  if (collapsed) {
    // In collapsed mode, show just the shield icon that expands on hover
    return (
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="flex items-center justify-center px-2 py-2 rounded-[10px] text-text-secondary text-sm font-medium transition-all duration-150 cursor-pointer bg-transparent border-none w-full hover:bg-bg-tertiary hover:text-text"
        title={t('sidebar.admin')}
      >
        <Shield size={18} />
      </button>
    )
  }

  return (
    <div>
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className={cn(
          'flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-sm font-medium transition-all duration-150 cursor-pointer whitespace-nowrap overflow-hidden select-none bg-transparent border-none font-[inherit] text-left w-full',
          isOnAdmin ? 'text-accent' : 'text-text-secondary hover:bg-bg-tertiary hover:text-text'
        )}
      >
        <span className="w-[22px] text-center text-base shrink-0 leading-none">
          <Shield size={18} />
        </span>
        <span className="flex-1 whitespace-nowrap overflow-hidden text-ellipsis">{t('sidebar.admin')}</span>
        <ChevronDown size={14} className={cn('transition-transform duration-200', expanded && 'rotate-180')} />
      </button>

      <div
        className={cn(
          'overflow-hidden transition-all duration-200',
          expanded ? 'max-h-[500px] opacity-100' : 'max-h-0 opacity-0'
        )}
      >
        <div className="flex flex-col gap-0.5 pl-4 pr-1 py-1">
          {ADMIN_PAGES.map((page) => (
            <NavLink
              key={page.to}
              to={page.to}
              onClick={() => setMode('chat')}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 px-2 py-1.5 rounded-md text-xs no-underline transition-all duration-150',
                  isActive
                    ? 'text-accent font-semibold bg-accent-glow'
                    : 'text-text-secondary hover:text-text hover:bg-bg-tertiary hover:translate-x-0.5'
                )
              }
            >
              <page.icon size={14} className="shrink-0" />
              <span className="truncate">{t(page.labelKey)}</span>
            </NavLink>
          ))}
        </div>
      </div>
    </div>
  )
}

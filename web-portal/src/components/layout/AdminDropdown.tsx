import { NavLink } from 'react-router-dom'
import {
  BarChart3, Settings, SlidersHorizontal, Wrench, Radio, Users,
  ScrollText, Brain, Theater, Database, Shield, Puzzle,
  type LucideIcon,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '../ui/dropdown-menu'
import { useWorkspaceStore } from '../../stores/workspace-store'

interface AdminPage {
  to: string
  icon: LucideIcon
  label: string
}

const ADMIN_PAGES: AdminPage[] = [
  { to: '/admin/dashboard', icon: BarChart3, label: 'Dashboard' },
  { to: '/admin/config', icon: SlidersHorizontal, label: 'Config' },
  { to: '/admin/tools', icon: Wrench, label: 'Tools' },
  { to: '/admin/channels', icon: Radio, label: 'Channels' },
  { to: '/admin/sessions', icon: Users, label: 'Sessions' },
  { to: '/admin/logs', icon: ScrollText, label: 'Logs' },
  { to: '/admin/identity', icon: Brain, label: 'Identity' },
  { to: '/admin/personality', icon: Theater, label: 'Personality' },
  { to: '/admin/memory', icon: Database, label: 'Memory' },
  { to: '/admin/settings', icon: Settings, label: 'Settings' },
  { to: '/admin/skills', icon: Puzzle, label: 'Skills' },
]

interface AdminDropdownProps {
  collapsed: boolean
}

export default function AdminDropdown({ collapsed }: AdminDropdownProps) {
  const setMode = useWorkspaceStore((s) => s.setMode)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={`flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-text-secondary text-sm font-medium transition-all duration-150 cursor-pointer whitespace-nowrap overflow-hidden select-none bg-transparent border-none font-[inherit] text-left w-full hover:bg-bg-tertiary hover:text-text ${collapsed ? 'justify-center px-2' : ''}`}
          title={collapsed ? 'Admin' : undefined}
        >
          <span className="w-[22px] text-center text-base shrink-0 leading-none">
            <Shield size={18} />
          </span>
          {!collapsed && <span className="whitespace-nowrap overflow-hidden text-ellipsis">Admin</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={collapsed ? 'right' : 'bottom'} align="start" className="min-w-[200px]">
        <DropdownMenuLabel>Admin Pages</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {ADMIN_PAGES.map((page) => (
          <DropdownMenuItem key={page.to} asChild>
            <NavLink
              to={page.to}
              onClick={() => setMode('chat')}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-2 py-1.5 rounded-md text-sm no-underline w-full ${
                  isActive
                    ? 'text-accent font-semibold'
                    : 'text-text hover:bg-surface-hover'
                }`
              }
            >
              <page.icon size={16} className="shrink-0" />
              <span>{page.label}</span>
            </NavLink>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

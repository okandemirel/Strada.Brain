import {
  BarChart3, Settings, SlidersHorizontal, Wrench, Radio, Users,
  ScrollText, Brain, Theater, Database, Library, Puzzle, type LucideIcon,
} from 'lucide-react'

export interface AdminPage {
  to: string
  icon: LucideIcon
  labelKey: string
}

/**
 * The admin sub-pages, in sidebar order. Office is intentionally NOT listed —
 * it was promoted to a top-level sidebar tab (see Sidebar.tsx) and lives at
 * /admin/office. Shared by AdminNav (the sidebar list) and TopBar (the
 * route-aware page title), so both stay in lock-step.
 */
export const ADMIN_PAGES: AdminPage[] = [
  { to: '/admin/dashboard', icon: BarChart3, labelKey: 'nav.dashboard' },
  { to: '/admin/config', icon: SlidersHorizontal, labelKey: 'nav.config' },
  { to: '/admin/tools', icon: Wrench, labelKey: 'nav.tools' },
  { to: '/admin/channels', icon: Radio, labelKey: 'nav.channels' },
  { to: '/admin/sessions', icon: Users, labelKey: 'nav.sessions' },
  { to: '/admin/logs', icon: ScrollText, labelKey: 'nav.logs' },
  { to: '/admin/identity', icon: Brain, labelKey: 'nav.identity' },
  { to: '/admin/personality', icon: Theater, labelKey: 'nav.personality' },
  { to: '/admin/memory', icon: Database, labelKey: 'nav.memory' },
  { to: '/admin/vaults', icon: Library, labelKey: 'nav.vaults' },
  { to: '/admin/settings', icon: Settings, labelKey: 'nav.settings' },
  { to: '/admin/skills', icon: Puzzle, labelKey: 'nav.skills' },
]

import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'
import { Building2, type LucideIcon } from 'lucide-react'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { MODE_BY_KEY } from '../../config/workspace-modes'
import { ADMIN_PAGES } from '../../config/admin-pages'

// Admin pages render through the Outlet, not a workspace panel, so the mode
// store stays on 'chat' while you're on /admin/*. Drive the title from the
// route instead. Reuse AdminNav's ADMIN_PAGES as the source of truth and add
// Office (a top-level tab whose route lives under /admin/office, so it isn't in
// ADMIN_PAGES).
const ADMIN_TITLE_BY_PATH: Map<string, { icon: LucideIcon; labelKey: string }> = new Map(
  [...ADMIN_PAGES, { to: '/admin/office', icon: Building2, labelKey: 'nav.office' }].map(
    (p) => [p.to, { icon: p.icon, labelKey: p.labelKey }] as const,
  ),
)

const BAR_CLASS =
  'flex min-h-12 items-center gap-3 border-b border-white/5 bg-bg-secondary/30 px-4 py-2 text-text-secondary backdrop-blur-xl'

export default function TopBar() {
  const { t } = useTranslation()
  const mode = useWorkspaceStore((s) => s.mode)
  const { pathname } = useLocation()

  const adminTitle = ADMIN_TITLE_BY_PATH.get(pathname)
  const config = MODE_BY_KEY[mode]
  const Icon = adminTitle ? adminTitle.icon : config.icon
  const title = adminTitle ? t(adminTitle.labelKey) : t(`modes.${mode}.label`)
  const subtitle = adminTitle ? t('sidebar.admin') : t(`modes.${mode}.description`)

  return (
    <div className={BAR_CLASS}>
      <Icon size={16} className="text-accent" />
      <div className="min-w-0">
        <div className="text-sm font-medium text-text">{title}</div>
        <div className="truncate text-[11px] text-text-tertiary">{subtitle}</div>
      </div>
    </div>
  )
}

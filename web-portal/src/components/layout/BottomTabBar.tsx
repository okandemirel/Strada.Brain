import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { WORKSPACE_MODES } from '../../config/workspace-modes'

export default function BottomTabBar() {
  const { t } = useTranslation()
  const mode = useWorkspaceStore((s) => s.mode)
  const setMode = useWorkspaceStore((s) => s.setMode)
  const navigate = useNavigate()
  const location = useLocation()

  const handleTab = (tabMode: typeof mode) => {
    if (!tabMode) return
    setMode(tabMode)
    if (tabMode === 'chat' && location.pathname.startsWith('/admin')) {
      navigate('/')
    }
  }

  return (
    <nav className="fixed bottom-0 left-0 right-0 h-14 bg-bg-secondary/80 backdrop-blur-xl border-t border-white/5 flex items-center justify-around px-2 z-50 md:hidden">
      {WORKSPACE_MODES.map((tab) => {
        const Icon = tab.icon
        const active = mode === tab.mode
        return (
          <button
            key={tab.mode}
            onClick={() => tab.enabled && handleTab(tab.mode)}
            disabled={!tab.enabled}
            className={`flex flex-col items-center gap-0.5 p-2 rounded-lg transition-all active:scale-95 ${
              active ? 'text-accent drop-shadow-[0_0_8px_rgba(0,229,255,0.3)]' : tab.enabled ? 'text-text-secondary' : 'text-text-tertiary opacity-40'
            }`}
          >
            <Icon size={20} />
            <span className="text-[10px]">{t(`modes.${tab.mode}.label`)}</span>
          </button>
        )
      })}
    </nav>
  )
}

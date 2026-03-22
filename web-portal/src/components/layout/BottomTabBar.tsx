import { useWorkspaceStore } from '../../stores/workspace-store'
import { WORKSPACE_MODES } from '../../config/workspace-modes'

export default function BottomTabBar() {
  const mode = useWorkspaceStore((s) => s.mode)
  const setMode = useWorkspaceStore((s) => s.setMode)

  return (
    <nav className="fixed bottom-0 left-0 right-0 h-14 bg-bg-secondary border-t border-border flex items-center justify-around px-2 z-50 md:hidden">
      {WORKSPACE_MODES.map((tab) => {
        const Icon = tab.icon
        const active = mode === tab.mode
        return (
          <button
            key={tab.mode}
            onClick={() => tab.enabled && setMode(tab.mode)}
            disabled={!tab.enabled}
            className={`flex flex-col items-center gap-0.5 p-2 rounded-lg transition-colors ${
              active ? 'text-accent' : tab.enabled ? 'text-text-secondary' : 'text-text-tertiary opacity-40'
            }`}
          >
            <Icon size={20} />
            <span className="text-[10px]">{tab.label}</span>
          </button>
        )
      })}
    </nav>
  )
}

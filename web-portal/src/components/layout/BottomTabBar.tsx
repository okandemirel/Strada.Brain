import { MessageSquare, Activity, Paintbrush, Code } from 'lucide-react'
import { useWorkspaceStore, type WorkspaceMode } from '../../stores/workspace-store'

const TABS: Array<{ mode: WorkspaceMode; icon: typeof MessageSquare; label: string; enabled: boolean }> = [
  { mode: 'chat', icon: MessageSquare, label: 'Chat', enabled: true },
  { mode: 'monitor', icon: Activity, label: 'Monitor', enabled: false },
  { mode: 'canvas', icon: Paintbrush, label: 'Canvas', enabled: false },
  { mode: 'code', icon: Code, label: 'Code', enabled: false },
]

export default function BottomTabBar() {
  const mode = useWorkspaceStore((s) => s.mode)
  const setMode = useWorkspaceStore((s) => s.setMode)

  return (
    <nav className="fixed bottom-0 left-0 right-0 h-14 bg-bg-secondary border-t border-border flex items-center justify-around px-2 z-50 md:hidden">
      {TABS.map((tab) => {
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

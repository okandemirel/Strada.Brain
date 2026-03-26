import { useWorkspaceStore } from '../../stores/workspace-store'
import { MODE_BY_KEY } from '../../config/workspace-modes'

export default function TopBar() {
  const mode = useWorkspaceStore((s) => s.mode)
  const config = MODE_BY_KEY[mode]
  const Icon = config.icon

  return (
    <div className="flex min-h-12 items-center gap-3 border-b border-white/5 bg-bg-secondary/30 px-4 py-2 text-text-secondary backdrop-blur-xl">
      <Icon size={16} className="text-accent" />
      <div className="min-w-0">
        <div className="text-sm font-medium text-text">{config.label}</div>
        <div className="truncate text-[11px] text-text-tertiary">
          {config.description}
        </div>
      </div>
    </div>
  )
}

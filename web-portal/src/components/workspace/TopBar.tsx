import { useWorkspaceStore } from '../../stores/workspace-store'
import { MODE_BY_KEY } from '../../config/workspace-modes'

export default function TopBar() {
  const mode = useWorkspaceStore((s) => s.mode)
  const config = MODE_BY_KEY[mode]
  const Icon = config.icon

  return (
    <div className="flex h-10 items-center gap-2 border-b bg-bg-secondary/50 px-4 text-sm font-medium text-text-secondary">
      <Icon size={16} className="text-accent" />
      <span>{config.label}</span>
    </div>
  )
}

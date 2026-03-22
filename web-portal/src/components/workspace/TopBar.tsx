import { MessageSquare, Activity, Paintbrush, Code } from 'lucide-react'
import { useWorkspaceStore } from '../../stores/workspace-store'
import type { WorkspaceMode } from '../../stores/workspace-store'

const MODE_CONFIG: Record<WorkspaceMode, { icon: React.ReactNode; label: string }> = {
  chat: { icon: <MessageSquare size={16} />, label: 'Chat' },
  monitor: { icon: <Activity size={16} />, label: 'Monitor' },
  canvas: { icon: <Paintbrush size={16} />, label: 'Canvas' },
  code: { icon: <Code size={16} />, label: 'Code' },
}

export default function TopBar() {
  const mode = useWorkspaceStore((s) => s.mode)
  const { icon, label } = MODE_CONFIG[mode]

  return (
    <div className="flex h-10 items-center gap-2 border-b bg-bg-secondary/50 px-4 text-sm font-medium text-text-secondary">
      {icon}
      <span>{label}</span>
    </div>
  )
}

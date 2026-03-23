import { MessageSquare, Activity, Paintbrush, Code, type LucideIcon } from 'lucide-react'
import type { WorkspaceMode } from '../stores/workspace-store'

export interface ModeConfig {
  mode: WorkspaceMode
  icon: LucideIcon
  label: string
  enabled: boolean
}

export const WORKSPACE_MODES: ModeConfig[] = [
  { mode: 'chat', icon: MessageSquare, label: 'Chat', enabled: true },
  { mode: 'monitor', icon: Activity, label: 'Monitor', enabled: true },
  { mode: 'canvas', icon: Paintbrush, label: 'Canvas', enabled: true },
  { mode: 'code', icon: Code, label: 'Code', enabled: true },
]

export const MODE_BY_KEY: Record<string, ModeConfig> = Object.fromEntries(
  WORKSPACE_MODES.map((m) => [m.mode, m]),
)

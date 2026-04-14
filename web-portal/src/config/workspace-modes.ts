import { MessageSquare, Activity, Paintbrush, Code, Database, type LucideIcon } from 'lucide-react'
import type { WorkspaceMode } from '../stores/workspace-store'

export interface ModeConfig {
  mode: WorkspaceMode
  icon: LucideIcon
  label: string
  description: string
  enabled: boolean
}

export const WORKSPACE_MODES: ModeConfig[] = [
  {
    mode: 'chat',
    icon: MessageSquare,
    label: 'Chat',
    description: 'Talk to the agent and keep the current conversation in view.',
    enabled: true,
  },
  {
    mode: 'monitor',
    icon: Activity,
    label: 'Monitor',
    description: 'Track agent progress, tasks, and live execution signals.',
    enabled: true,
  },
  {
    mode: 'canvas',
    icon: Paintbrush,
    label: 'Canvas',
    description: 'Arrange architecture, notes, and agent visuals on a shared board.',
    enabled: true,
  },
  {
    mode: 'code',
    icon: Code,
    label: 'Code',
    description: 'Inspect files, diffs, and terminal output in one workspace.',
    enabled: true,
  },
  {
    mode: 'vaults',
    icon: Database,
    label: 'Vaults',
    description: 'Browse codebase memory vaults, search indexed content, and inspect dependency graphs.',
    enabled: true,
  },
]

export const MODE_BY_KEY: Record<string, ModeConfig> = Object.fromEntries(
  WORKSPACE_MODES.map((m) => [m.mode, m]),
)

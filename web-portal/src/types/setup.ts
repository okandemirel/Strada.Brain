export interface ProviderDef {
  id: string
  name: string
  envKey: string | null
  placeholder: string | null
  recommended?: boolean
  helpUrl: string
}

export interface PresetDef {
  id: string
  name: string
  cost: string
  desc: string
  providers: string[]
}

export interface ChannelDef {
  id: string
  name: string
  icon: string
  fields: Array<{ domId: string; envKey: string; label: string; placeholder: string }>
}

export interface BrowseEntry {
  name: string
}

export interface BrowseResult {
  path: string
  entries: BrowseEntry[]
  isUnityProject: boolean
  error?: string
}

export type SaveStatus = 'idle' | 'saving' | 'success' | 'error' | 'polling'

export interface WizardState {
  step: number
  selectedPreset: string | null
  checkedProviders: Set<string>
  providerKeys: Record<string, string>
  projectPath: string
  pathValid: boolean | null
  pathError: string | null
  channel: string
  channelConfig: Record<string, string>
  language: string
  ragEnabled: boolean
  saveStatus: SaveStatus
  saveError: string | null
}

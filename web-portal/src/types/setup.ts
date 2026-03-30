import type {
  PostSetupBootstrap,
  SetupProviderFailure as ProviderPreflightFailure,
} from '../../../src/common/setup-contract.ts'
import type { SetupBootstrapViewStatus } from '../../../src/common/setup-state.ts'

export type {
  SetupBootstrapState,
  SetupStatusResponse,
} from '../../../src/common/setup-contract.ts'
export type { ProviderPreflightFailure }

export interface ProviderAuthModeDef {
  id: string
  label: string
  description: string
  requiresSecret?: boolean
  secretEnvKey?: string
  secretLabel?: string
  secretPlaceholder?: string
  helpLabel?: string
  helpUrl?: string
}

export interface ProviderDef {
  id: string
  name: string
  envKey: string | null
  placeholder: string | null
  recommended?: boolean
  embeddingRecommended?: boolean
  helpUrl: string
  authModes?: ProviderAuthModeDef[]
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
  fields: Array<{ domId: string; envKey: string; label: string; labelKey?: string; placeholder: string }>
}

export interface BrowseEntry {
  name: string
}

export type StradaDepInstallSource =
  | 'package-directory'
  | 'manifest'
  | 'project-local'
  | 'configured-path'
  | 'sibling-checkout'
  | 'global-install'

export interface StradaDepsStatus {
  coreInstalled: boolean
  corePath: string | null
  coreVersion?: string | null
  coreSource?: StradaDepInstallSource | null
  modulesInstalled: boolean
  modulesPath: string | null
  modulesVersion?: string | null
  modulesSource?: StradaDepInstallSource | null
  mcpInstalled: boolean
  mcpPath: string | null
  mcpVersion: string | null
  mcpSource?: StradaDepInstallSource | null
  warnings: string[]
}

export interface McpRecommendation {
  recommended: boolean
  reason: string
  featureList: string[]
  discoveryHint?: string
  installHint?: string
}

export type McpInstallTarget = 'assets' | 'packages'

export interface McpInstallPlan {
  target: McpInstallTarget
  submodulePath: string
  unityPackagePath: string
  manifestPath: string
  manifestDependency: string
  npmInstallRan: boolean
}

export interface BrowseResult {
  path: string
  entries: BrowseEntry[]
  isUnityProject: boolean
  stradaDeps?: StradaDepsStatus
  dependencyWarnings?: string[]
  mcpRecommendation?: McpRecommendation
  error?: string
}

export interface PathValidationResult {
  valid: boolean
  error?: string
  isUnityProject?: boolean
  stradaDeps?: StradaDepsStatus
  dependencyWarnings?: string[]
  mcpRecommendation?: McpRecommendation
}

export interface McpInstallResponse {
  success?: boolean
  error?: string
  install?: McpInstallPlan
  isUnityProject?: boolean
  stradaDeps?: StradaDepsStatus
  dependencyWarnings?: string[]
  mcpRecommendation?: McpRecommendation
}

export type StradaDepPackage = 'core' | 'modules'

export interface DepInstallResponse {
  success?: boolean
  error?: string
  installedPath?: string
  isUnityProject?: boolean
  stradaDeps?: StradaDepsStatus
  dependencyWarnings?: string[]
  mcpRecommendation?: McpRecommendation
}

export type SaveStatus = 'idle' | 'saving' | SetupBootstrapViewStatus

export interface SetupSaveResponse {
  success?: boolean
  error?: string
  handoff?: boolean
  readyUrl?: string
  providerFailures?: ProviderPreflightFailure[]
  providerWarnings?: ProviderPreflightFailure[]
  postSetupBootstrap?: PostSetupBootstrap
}

export interface WizardState {
  step: number
  selectedPreset: string | null
  checkedProviders: Set<string>
  providerKeys: Record<string, string>
  providerAuthModes: Record<string, string>
  providerModels: Record<string, string>
  projectPath: string
  pathValid: boolean | null
  pathError: string | null
  pathIsUnityProject: boolean
  pathStradaDeps: StradaDepsStatus | null
  pathDependencyWarnings: string[]
  pathMcpRecommendation: McpRecommendation | null
  mcpInstallStatus: 'idle' | 'installing' | 'success' | 'error'
  mcpInstallError: string | null
  mcpInstallMessage: string | null
  mcpInstallPlan: McpInstallPlan | null
  channel: string
  channelConfig: Record<string, string>
  language: string
  ragEnabled: boolean
  saveStatus: SaveStatus
  saveError: string | null
  saveWarning: string | null
}

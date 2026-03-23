import { useQuery } from '@tanstack/react-query'
import { fetchJson } from '../utils/api'

// ---------------------------------------------------------------------------
// Shared fetcher -- reuses the existing fetchJson utility but throws on null
// so TanStack Query can track errors properly.
// ---------------------------------------------------------------------------

async function fetchApi<T>(url: string): Promise<T> {
  const data = await fetchJson<T>(url)
  if (data === null) {
    throw new Error(`No data returned from ${url}`)
  }
  return data
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

interface ConfigResponse {
  config: Record<string, unknown>
  entries?: Array<{ key: string; value: unknown; category: string; tier: string; description: string }>
  summary?: { core: number; advanced: number; experimental: number }
}

interface ToolsResponse {
  tools: Array<{
    name: string
    description: string
    type: string
    installed?: boolean
    available?: boolean
    requiresBridge?: boolean
    readOnly?: boolean
    availabilityReason?: string
    paramCount?: number
  }>
  toolCallCounts?: Record<string, number>
  toolErrorCounts?: Record<string, number>
}

interface ChannelsResponse {
  channels: Array<{
    name: string
    type: string
    enabled: boolean
    healthy: boolean
    detail?: string
  }>
}

interface HealthResponse {
  status: string
  timestamp: string
  channel: string
  uptime: number
  clients: number
}

interface SessionsResponse {
  sessions: Array<{
    id: string
    channel: string
    agentId?: string
    startedAt: number
    lastActivity: number
    messageCount?: number
  }>
}

interface MetricsResponse {
  uptime: number
  totalMessages: number
  totalTokens: { input: number; output: number }
  activeSessions: number
  recentTokenUsage: Array<{ input: number; output: number; timestamp: number }>
  toolCallCounts: Record<string, number>
  toolErrorCounts: Record<string, number>
  providerName: string
  memoryStats: { totalEntries: number; hasAnalysisCache: boolean } | null
  readOnlyMode: boolean
  securityStats: { secretsSanitized: number; toolsBlocked: number } | null
}

interface LogEntry {
  timestamp: string
  level: string
  message: string
  module?: string
}

type LogsResponse = { logs: LogEntry[] } | LogEntry[]

interface AgentsResponse {
  enabled: boolean
  agents?: Array<{
    id: string
    key: string
    channelType: string
    status: string
    createdAt: number
    lastActivity: number
    budgetCapUsd?: number
  }>
  activeCount?: number
  globalBudget?: { usedUsd: number; limitUsd?: number; pct: number }
}

interface DelegationsResponse {
  enabled: boolean
  active?: Array<{ subAgentId: string; type: string; startedAt: number }>
  history?: unknown[]
  stats?: Array<{
    type: string
    count: number
    avgDurationMs: number
    avgCostUsd: number
    successRate: number
  }>
}

interface ConsolidationResponse {
  enabled: boolean
  perTier?: Record<string, { clustered: number; pending: number; total: number }>
  lifetimeSavings?: number
  totalRuns?: number
  totalCostUsd?: number
}

interface DeploymentResponse {
  enabled: boolean
  stats?: {
    totalDeployments: number
    successful: number
    failed: number
    circuitBreakerState: string
  }
  history?: unknown[]
}

interface MaintenanceResponse {
  decay?: {
    enabled: boolean
    tiers?: Record<string, unknown>
    exemptDomains?: string[]
    totalExempt?: number
  }
  pruning?: {
    retentionDays: number
    lastPrunedCount: number
  }
}

interface PersonalityResponse {
  personality: {
    content?: string
    activeProfile?: string
    profiles?: string[]
    channelOverrides?: Record<string, string>
  } | null
}

interface MemoryStatsResponse {
  memory: {
    totalEntries: number
    hasAnalysisCache: boolean
    entriesByTier?: Record<string, number>
    health?: {
      healthy?: boolean
      issues?: string[]
      indexHealth?: string
      storageUsagePercent?: number
    } | null
  } | null
}

interface TriggerItem {
  id: string
  type: string
  enabled: boolean
  nextRun: number | null
  lastFired: number | null
  fireCount: number
}

interface DaemonResponse {
  running: boolean
  configured?: boolean
  intervalMs?: number
  identity: {
    agentName: string
    version: string
    bootCount: number
    firstBoot: string
    lastBoot: string
    continuityHash: string
    mode: string
  } | null
  triggers: Array<{
    name: string
    type: string
    state: string
    circuitState?: string
    nextRun?: string | null
  }>
  budget: {
    usedUsd: number
    limitUsd: number
    pct: number
  }
  approvalQueue?: Array<{ id: string; toolName: string; triggerName?: string; status: string }>
  startupNotices?: string[]
  capabilityManifest?: Record<string, unknown> | null
}

interface ProvidersResponse {
  active: {
    providerName: string
    model: string
    isDefault: boolean
    selectionMode?: string
    executionPolicyNote?: string
  } | null
  executionPool?: Array<{ name: string; label: string; defaultModel: string }> | null
}

interface RagStatusResponse {
  status: {
    state: string
    ragEnabled: boolean
    configuredProvider: string
    configuredModel?: string
    configuredDimensions?: number
    resolvedProviderName?: string
    resolutionSource?: string
    activeDimensions?: number
    verified: boolean
    usingHashFallback: boolean
    notice?: string
  }
}

interface AutonomousStatusResponse {
  enabled: boolean
  expiresAt?: number
  remainingMs?: number
}

interface AgentActivityResponse {
  routing: Array<{
    provider: string
    reason: string
    task: { type: string; complexity: string; criticality: string }
    timestamp: number
    catalogSignal?: { freshnessScore: number; alignmentScore: number; stale: boolean; updatedAt?: number }
  }>
  execution?: Array<{
    provider: string
    model?: string
    role: string
    phase: string
    source: string
    reason: string
    task: { type: string; complexity: string; criticality: string }
    timestamp: number
  }>
  outcomes?: Array<{
    provider: string
    model?: string
    role: string
    phase: string
    source: string
    status: string
    reason: string
    task: { type: string; complexity: string; criticality: string }
    timestamp: number
  }>
  phaseScores?: Array<{
    provider: string
    role: string
    phase: string
    sampleSize: number
    score: number
    approvedCount: number
    continuedCount: number
    replannedCount: number
    blockedCount: number
    failedCount: number
    verifierSampleSize: number
    verifierCleanRate: number
    rollbackRate: number
    avgRetryCount: number
    avgTokenCost: number
    repeatedFailureCount: number
    latestTimestamp: number
    latestReason: string
  }>
  artifacts?: Array<{
    id: string
    kind: string
    state: string
    name: string
    description: string
    projectWorldFingerprint?: string
    stats: {
      shadowSampleCount: number
      activeUseCount: number
      cleanCount: number
      retryCount: number
      failureCount: number
      blockerCount: number
    }
    lastStateReason?: string
    updatedAt: number
  }>
  preset?: string
}

interface BootReportResponse {
  bootReport: {
    goldenPath: { channels: string[]; recommendedPreset: string }
    stages: Array<{ id: string; label: string; status: string; detail: string }>
    capabilities: Array<{ id: string; name: string; tier: string; status: string; truth: string; detail: string }>
  } | null
}

// ---------------------------------------------------------------------------
// Individual query hooks
// ---------------------------------------------------------------------------

/** GET /api/config */
export function useConfig() {
  return useQuery<ConfigResponse>({
    queryKey: ['config'],
    queryFn: () => fetchApi<ConfigResponse>('/api/config'),
  })
}

/** GET /api/tools */
export function useTools() {
  return useQuery<ToolsResponse>({
    queryKey: ['tools'],
    queryFn: () => fetchApi<ToolsResponse>('/api/tools'),
    refetchInterval: 10_000,
  })
}

/** GET /api/channels */
export function useChannels() {
  return useQuery<ChannelsResponse>({
    queryKey: ['channels'],
    queryFn: () => fetchApi<ChannelsResponse>('/api/channels'),
    refetchInterval: 10_000,
  })
}

/** GET /health */
export function useHealth() {
  return useQuery<HealthResponse>({
    queryKey: ['health'],
    queryFn: () => fetchApi<HealthResponse>('/health'),
  })
}

/** GET /api/sessions */
export function useSessions() {
  return useQuery<SessionsResponse>({
    queryKey: ['sessions'],
    queryFn: () => fetchApi<SessionsResponse>('/api/sessions'),
    refetchInterval: 10_000,
  })
}

/** GET /api/metrics */
export function useMetrics() {
  return useQuery<MetricsResponse>({
    queryKey: ['metrics'],
    queryFn: () => fetchApi<MetricsResponse>('/api/metrics'),
  })
}

/** GET /api/logs */
export function useLogs() {
  return useQuery<LogsResponse>({
    queryKey: ['logs'],
    queryFn: () => fetchApi<LogsResponse>('/api/logs'),
  })
}

/** GET /api/agents */
export function useAgents() {
  return useQuery<AgentsResponse>({
    queryKey: ['agents'],
    queryFn: () => fetchApi<AgentsResponse>('/api/agents'),
  })
}

/** GET /api/delegations */
export function useDelegations() {
  return useQuery<DelegationsResponse>({
    queryKey: ['delegations'],
    queryFn: () => fetchApi<DelegationsResponse>('/api/delegations'),
  })
}

/** GET /api/consolidation */
export function useConsolidation() {
  return useQuery<ConsolidationResponse>({
    queryKey: ['consolidation'],
    queryFn: () => fetchApi<ConsolidationResponse>('/api/consolidation'),
  })
}

/** GET /api/deployment */
export function useDeployment() {
  return useQuery<DeploymentResponse>({
    queryKey: ['deployment'],
    queryFn: () => fetchApi<DeploymentResponse>('/api/deployment'),
  })
}

/** GET /api/maintenance */
export function useMaintenance() {
  return useQuery<MaintenanceResponse>({
    queryKey: ['maintenance'],
    queryFn: () => fetchApi<MaintenanceResponse>('/api/maintenance'),
  })
}

/** GET /api/personality */
export function usePersonality() {
  return useQuery<PersonalityResponse>({
    queryKey: ['personality'],
    queryFn: () => fetchApi<PersonalityResponse>('/api/personality'),
    refetchInterval: false, // personality rarely changes; mutations will invalidate
    refetchOnMount: 'always', // ensure fresh data after onboarding or profile switch
  })
}

/** GET /api/memory */
export function useMemoryStats() {
  return useQuery<MemoryStatsResponse>({
    queryKey: ['memory'],
    queryFn: () => fetchApi<MemoryStatsResponse>('/api/memory'),
    refetchInterval: 15_000,
  })
}

/** GET /api/triggers */
export function useTriggers() {
  return useQuery<TriggerItem[]>({
    queryKey: ['triggers'],
    queryFn: () => fetchApi<TriggerItem[]>('/api/triggers'),
  })
}

/** GET /api/daemon */
export function useDaemon() {
  return useQuery<DaemonResponse>({
    queryKey: ['daemon'],
    queryFn: () => fetchApi<DaemonResponse>('/api/daemon'),
    refetchInterval: 10_000,
  })
}

/** GET /api/providers/active (requires identity query string) */
export function useProviders(identityQuery: string | null) {
  return useQuery<ProvidersResponse>({
    queryKey: ['providers', identityQuery],
    queryFn: () => fetchApi<ProvidersResponse>(`/api/providers/active?${identityQuery}`),
    enabled: Boolean(identityQuery),
    refetchInterval: 30_000,
  })
}

/** GET /api/rag/status */
export function useRagStatus() {
  return useQuery<RagStatusResponse>({
    queryKey: ['rag-status'],
    queryFn: () => fetchApi<RagStatusResponse>('/api/rag/status'),
    refetchInterval: 30_000,
  })
}

/** GET /api/user/autonomous (requires identity query string) */
export function useAutonomousStatus(identityQuery: string | null) {
  return useQuery<AutonomousStatusResponse>({
    queryKey: ['autonomous', identityQuery],
    queryFn: () => fetchApi<AutonomousStatusResponse>(`/api/user/autonomous?${identityQuery}`),
    enabled: Boolean(identityQuery),
    refetchInterval: 30_000,
  })
}

/** GET /api/agent-activity (requires identity query string) */
export function useAgentActivity(identityQuery: string | null) {
  return useQuery<AgentActivityResponse>({
    queryKey: ['agent-activity', identityQuery],
    queryFn: () => fetchApi<AgentActivityResponse>(`/api/agent-activity?${identityQuery}`),
    enabled: Boolean(identityQuery),
    refetchInterval: 30_000,
  })
}

/** GET /api/system/boot */
export function useBootReport() {
  return useQuery<BootReportResponse>({
    queryKey: ['boot-report'],
    queryFn: () => fetchApi<BootReportResponse>('/api/system/boot'),
    refetchInterval: 30_000,
  })
}

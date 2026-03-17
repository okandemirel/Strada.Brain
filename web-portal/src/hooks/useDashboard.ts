import { useCallback, useEffect, useRef, useState } from 'react'
import { useAutoRefresh } from './useAutoRefresh'
import { fetchJson, firstSettledError, settledValue } from '../utils/api'

const POLL_INTERVAL = 5000

/** Health response from web channel (same origin, port 3000) */
export interface HealthData {
  status: string
  timestamp: string
  channel: string
  uptime: number
  clients: number
}

/** Metrics snapshot from dashboard server (port 3100 by default) */
export interface MetricsData {
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

/** Trigger data from dashboard server */
export interface TriggerData {
  id: string
  type: string
  enabled: boolean
  nextRun: number | null
  lastFired: number | null
  fireCount: number
}

/** Agents data from dashboard server */
export interface AgentsData {
  enabled: boolean
  agents?: Array<{
    id: string
    key: string
    channelType: string
    status: string
    createdAt: number
    lastActivity: number
    budgetCapUsd: number
  }>
  activeCount?: number
  globalBudget?: { usedUsd: number; limitUsd?: number; pct: number }
}

/** Delegation stats from dashboard server */
export interface DelegationsData {
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

/** Consolidation stats from dashboard server */
export interface ConsolidationData {
  enabled: boolean
  perTier?: Record<string, { clustered: number; pending: number; total: number }>
  lifetimeSavings?: number
  totalRuns?: number
  totalCostUsd?: number
}

/** Deployment stats from dashboard server */
export interface DeploymentData {
  enabled: boolean
  stats?: {
    totalDeployments: number
    successful: number
    failed: number
    circuitBreakerState: string
  }
  history?: unknown[]
}

/** Maintenance stats from dashboard server */
export interface MaintenanceData {
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

export interface DashboardData {
  health: HealthData | null
  metrics: MetricsData | null
  triggers: TriggerData[] | null
  agents: AgentsData | null
  delegations: DelegationsData | null
  consolidation: ConsolidationData | null
  deployment: DeploymentData | null
  maintenance: MaintenanceData | null
}

export interface UseDashboardReturn {
  data: DashboardData
  loading: boolean
  error: string | null
  dashboardEnabled: boolean
  lastUpdated: number | null
}

// Dashboard API is proxied through the web channel on the same origin (/api/*)
// No cross-origin fetch needed — web channel forwards to dashboard server internally

export function useDashboard(): UseDashboardReturn {
  const [data, setData] = useState<DashboardData>({
    health: null,
    metrics: null,
    triggers: null,
    agents: null,
    delegations: null,
    consolidation: null,
    deployment: null,
    maintenance: null,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dashboardEnabled, setDashboardEnabled] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const mountedRef = useRef(true)

  const fetchAll = useCallback(async () => {
    try {
      const results = await Promise.allSettled([
        fetchJson<HealthData>('/health'),
        fetchJson<MetricsData>('/api/metrics'),
        fetchJson<TriggerData[]>('/api/triggers'),
        fetchJson<AgentsData>('/api/agents'),
        fetchJson<DelegationsData>('/api/delegations'),
        fetchJson<ConsolidationData>('/api/consolidation'),
        fetchJson<DeploymentData>('/api/deployment'),
        fetchJson<MaintenanceData>('/api/maintenance'),
      ])
      const [
        healthResult, metricsResult, triggersResult,
        agentsResult, delegationsResult, consolidationResult, deploymentResult, maintenanceResult,
      ] = results
      const health = settledValue(healthResult)
      const metrics = settledValue(metricsResult)
      const triggers = settledValue(triggersResult)
      const agents = settledValue(agentsResult)
      const delegations = settledValue(delegationsResult)
      const consolidation = settledValue(consolidationResult)
      const deployment = settledValue(deploymentResult)
      const maintenance = settledValue(maintenanceResult)

      if (!mountedRef.current) return

      // If metrics fetch failed, dashboard is likely disabled
      const isDashboardUp = metrics !== null
      setDashboardEnabled(isDashboardUp)
      setError(!isDashboardUp && !health
        ? firstSettledError(results) ?? 'Dashboard not enabled and web channel unreachable'
        : null)

      setData({
        health,
        metrics,
        triggers,
        agents,
        delegations,
        consolidation,
        deployment,
        maintenance,
      })
      if (mountedRef.current) {
        setLoading(false)
        setLastUpdated(Date.now())
      }
    } catch (error) {
      if (mountedRef.current) {
        setError(error instanceof Error ? error.message : 'Failed to load dashboard data')
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useAutoRefresh(() => fetchAll(), { intervalMs: POLL_INTERVAL })

  return { data, loading, error, dashboardEnabled, lastUpdated }
}

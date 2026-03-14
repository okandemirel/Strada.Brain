import { useCallback, useEffect, useRef, useState } from 'react'

const POLL_INTERVAL = 5000

/** Health response from web channel (same origin, port 3000) */
export interface HealthData {
  status: string
  timestamp: string
  channel: string
  uptime: number
  clients: number
}

/** Metrics snapshot from dashboard server (port 3001) */
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

function getDashboardBaseUrl(): string {
  const stored = localStorage.getItem('strada-dashboard-port')
  const port = stored && /^\d{1,5}$/.test(stored) ? stored : '3100'
  return `http://localhost:${port}`
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const res = await fetch(url, { signal })
    if (!res.ok) return null
    return await res.json() as T
  } catch {
    return null
  }
}

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

  const fetchAll = useCallback(async (signal?: AbortSignal) => {
    try {
      const baseUrl = getDashboardBaseUrl()

      // Fetch health from same origin (web channel port)
      const healthPromise = fetchJson<HealthData>('/health', signal)

      // Fetch all dashboard endpoints (separate port)
      const metricsPromise = fetchJson<MetricsData>(`${baseUrl}/api/metrics`, signal)
      const triggersPromise = fetchJson<TriggerData[]>(`${baseUrl}/api/triggers`, signal)
      const agentsPromise = fetchJson<AgentsData>(`${baseUrl}/api/agents`, signal)
      const delegationsPromise = fetchJson<DelegationsData>(`${baseUrl}/api/delegations`, signal)
      const consolidationPromise = fetchJson<ConsolidationData>(`${baseUrl}/api/consolidation`, signal)
      const deploymentPromise = fetchJson<DeploymentData>(`${baseUrl}/api/deployment`, signal)
      const maintenancePromise = fetchJson<MaintenanceData>(`${baseUrl}/api/maintenance`, signal)

      const [
        health, metrics, triggers,
        agents, delegations, consolidation, deployment, maintenance,
      ] = await Promise.all([
        healthPromise, metricsPromise, triggersPromise,
        agentsPromise, delegationsPromise, consolidationPromise, deploymentPromise, maintenancePromise,
      ])

      if (!mountedRef.current) return

      // If metrics fetch failed, dashboard is likely disabled
      const isDashboardUp = metrics !== null
      setDashboardEnabled(isDashboardUp)
      setError(!isDashboardUp && !health ? 'Dashboard not enabled and web channel unreachable' : null)

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
      if (mountedRef.current) setLoading(false)
      setLastUpdated(Date.now())
    } catch {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    const controller = new AbortController()

    // Initial fetch
    fetchAll(controller.signal)

    // Polling
    const interval = setInterval(() => {
      if (mountedRef.current) {
        fetchAll(controller.signal)
      }
    }, POLL_INTERVAL)

    return () => {
      mountedRef.current = false
      controller.abort()
      clearInterval(interval)
    }
  }, [fetchAll])

  return { data, loading, error, dashboardEnabled, lastUpdated }
}

import { create } from 'zustand'

export interface SupervisorNode {
  id: string
  status: string // pending | running | done | failed | skipped | verifying
  provider?: string
  model?: string
  wave?: number
  duration?: number
  cost?: number
  verdict?: string
}

export interface SupervisorAlertEvent {
  kind: 'failed' | 'escalation'
  nodeId: string
  message: string
}

export interface SupervisorSummary {
  totalNodes: number
  succeeded: number
  failed: number
  skipped: number
  cost: number
  duration: number
}

interface SupervisorState {
  active: boolean
  nodes: SupervisorNode[]
  providers: Record<string, { count: number }>
  waveIndex: number
  totalWaves: number
  summary: SupervisorSummary | null
  events: SupervisorAlertEvent[]

  activate: (taskId: string, nodeCount: number) => void
  setPlan: (assignments: Record<string, { provider: string; model: string }>) => void
  setWaveStart: (waveIndex: number, waveNodes: Array<{ nodeId: string; provider: string }>) => void
  updateNode: (nodeId: string, updates: Partial<SupervisorNode>) => void
  addAlert: (evt: SupervisorAlertEvent) => void
  setComplete: (summary: SupervisorSummary) => void
  setAborted: () => void
  clear: () => void
}

const MAX_ALERTS = 50

const initialState = {
  active: false,
  nodes: [] as SupervisorNode[],
  providers: {} as Record<string, { count: number }>,
  waveIndex: 0,
  totalWaves: 0,
  summary: null as SupervisorSummary | null,
  events: [] as SupervisorAlertEvent[],
}

export const useSupervisorStore = create<SupervisorState>()((set) => ({
  ...initialState,

  activate: (_taskId, nodeCount) =>
    set({
      active: true,
      nodes: Array.from({ length: nodeCount }, (_, i) => ({
        id: `node-${i}`,
        status: 'pending',
      })),
      providers: {},
      waveIndex: 0,
      totalWaves: 0,
      summary: null,
      events: [],
    }),

  setPlan: (assignments) =>
    set((s) => {
      const providers: Record<string, { count: number }> = {}
      const nodeMap = new Map(s.nodes.map((n) => [n.id, n]))
      for (const [nodeId, assign] of Object.entries(assignments)) {
        const node = nodeMap.get(nodeId)
        if (node) {
          nodeMap.set(nodeId, { ...node, provider: assign.provider, model: assign.model })
        } else {
          nodeMap.set(nodeId, { id: nodeId, status: 'pending', provider: assign.provider, model: assign.model })
        }
        providers[assign.provider] = { count: (providers[assign.provider]?.count ?? 0) + 1 }
      }
      return { nodes: Array.from(nodeMap.values()), providers }
    }),

  setWaveStart: (waveIndex, waveNodes) =>
    set((s) => {
      const nodeMap = new Map(s.nodes.map((n) => [n.id, n]))
      for (const wn of waveNodes) {
        const existing = nodeMap.get(wn.nodeId)
        nodeMap.set(wn.nodeId, {
          ...(existing ?? { id: wn.nodeId, status: 'pending' }),
          status: 'running',
          provider: wn.provider,
          wave: waveIndex,
        })
      }
      return { nodes: Array.from(nodeMap.values()), waveIndex, totalWaves: Math.max(s.totalWaves, waveIndex + 1) }
    }),

  updateNode: (nodeId, updates) =>
    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === nodeId ? { ...n, ...updates } : n)),
    })),

  addAlert: (evt) =>
    set((s) => ({
      events: [...s.events, evt].slice(-MAX_ALERTS),
    })),

  setComplete: (summary) => set({ summary }),

  setAborted: () =>
    set((s) => ({
      summary: {
        totalNodes: s.nodes.length,
        succeeded: s.nodes.filter((n) => n.status === 'done').length,
        failed: s.nodes.filter((n) => n.status === 'failed').length,
        skipped: s.nodes.filter((n) => n.status === 'pending' || n.status === 'skipped').length,
        cost: 0,
        duration: 0,
      },
    })),

  clear: () => set({ ...initialState }),
}))

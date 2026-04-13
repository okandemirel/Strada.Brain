import { create } from 'zustand'

export type MonitorTaskStatus =
  | 'pending'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'skipped'
  | 'cancelled'
  | 'paused'
  | 'waiting_for_input'
  | 'verifying'

export type MonitorReviewStatus =
  | 'none'
  | 'spec_review'
  | 'quality_review'
  | 'review_passed'
  | 'review_stuck'
  | 'passed'
  | 'failed'

export interface MonitorTask {
  id: string
  nodeId: string
  rootId?: string
  title: string
  status: MonitorTaskStatus | string
  reviewStatus: MonitorReviewStatus | string
  agentId?: string
  startedAt?: number
  completedAt?: number
  dependencies?: string[]
  implementationResult?: unknown
  specReviewResult?: unknown
  qualityReviewResult?: unknown
  phase?: 'planning' | 'acting' | 'observing' | 'reflecting'
  progress?: { current: number; total: number; unit: string }
  elapsed?: number
  narrative?: string
  milestone?: {
    current: number
    total: number
    label: string
  }
  substeps?: Array<{
    id: string
    label: string
    status: 'active' | 'done' | 'skipped'
    order: number
    files?: string[]
  }>
  expandedByUser?: boolean
}

export interface DagState {
  nodes: Array<{ id: string; [key: string]: unknown }>
  edges: Array<{ source: string; target: string }>
}

export interface ActivityEntry {
  taskId?: string
  action: string
  tool?: string
  detail: string
  timestamp: number
}

// --- Level Completion Verifier state ---

export type VerifyCheckStatus = 'pass' | 'warn' | 'fail' | 'pending'
export type VerifyCheckType = 'build' | 'test' | 'manual'
export type VerifyGateVerdict = 'approve' | 'request_changes' | 'escalate'

export interface CriterionState {
  id: string
  label: string
  checkType: VerifyCheckType
  status: VerifyCheckStatus
  evidence?: string
  error?: string
}

export interface CheckResult {
  criterionId: string
  status: VerifyCheckStatus
  evidence?: string
  error?: string
  timestamp: number
}

export interface VerificationState {
  active: boolean
  taskId?: string
  criteria: CriterionState[]
  results: CheckResult[]
  gateDecision?: {
    verdict: VerifyGateVerdict
    note?: string
    submittedAt: number
    accepted?: boolean
    supervisorVerdict?: string
  }
}

export const DEFAULT_VERIFICATION_CRITERIA: CriterionState[] = [
  { id: 'build', label: 'Compiles without errors', checkType: 'build', status: 'pending' },
  { id: 'tests', label: 'Tests pass', checkType: 'test', status: 'pending' },
  { id: 'review', label: 'Manual code review complete', checkType: 'manual', status: 'pending' },
  { id: 'security', label: 'No security flags', checkType: 'manual', status: 'pending' },
]

interface MonitorState {
  tasks: Record<string, MonitorTask>
  dag: DagState | null
  activities: ActivityEntry[]
  activeRootId: string | null
  selectedTaskId: string | null
  verification: VerificationState

  addTask: (task: MonitorTask) => void
  updateTask: (id: string, updates: Partial<MonitorTask>) => void
  setDAG: (dag: DagState) => void
  addActivity: (entry: ActivityEntry) => void
  setActiveRootId: (id: string | null) => void
  setSelectedTask: (id: string | null) => void
  clearMonitor: () => void

  openVerifier: (taskId: string) => void
  closeVerifier: () => void
  recordCheck: (
    criterionId: string,
    result: { status: VerifyCheckStatus; evidence?: string; error?: string },
  ) => void
  submitGateDecision: (verdict: VerifyGateVerdict, note?: string) => void
  acknowledgeGate: (accepted: boolean, supervisorVerdict?: string) => void
}

const MAX_ACTIVITIES = 200
const MAX_TASKS = 500

const initialVerification: VerificationState = {
  active: false,
  criteria: DEFAULT_VERIFICATION_CRITERIA.map((c) => ({ ...c })),
  results: [],
}

const initialState = {
  tasks: {} as Record<string, MonitorTask>,
  dag: null as DagState | null,
  activities: [] as ActivityEntry[],
  activeRootId: null as string | null,
  selectedTaskId: null as string | null,
  verification: initialVerification,
}

export const useMonitorStore = create<MonitorState>()((set) => ({
  ...initialState,

  addTask: (task) =>
    set((s) => ({ tasks: { ...s.tasks, [task.id]: task } })),

  updateTask: (id, updates) =>
    set((s) => {
      // Auto-create a placeholder task when an update arrives before dag_init
      // (e.g. WS reconnect, late-arriving nodes, or race conditions).
      // DAG sync is intentionally skipped — the DAG is not yet initialized.
      // When dag_init arrives later, setDAG will populate it.
      if (!s.tasks[id]) {
        if ((updates.status || updates.title) && Object.keys(s.tasks).length < MAX_TASKS) {
          const created: MonitorTask = {
            id,
            nodeId: updates.nodeId ?? id,
            title: updates.title ?? id,
            status: updates.status ?? 'executing',
            reviewStatus: updates.reviewStatus ?? 'none',
            ...updates,
          }
          return { tasks: { ...s.tasks, [id]: created } }
        }
        return s
      }
      const newTasks = { ...s.tasks, [id]: { ...s.tasks[id], ...updates } }
      // Sync status into dag.nodes so DAGView re-renders
      let newDag = s.dag
      if (s.dag && ('status' in updates || 'reviewStatus' in updates)) {
        const idx = s.dag.nodes.findIndex((n) => n.id === id)
        if (idx >= 0) {
          const updatedNodes = [...s.dag.nodes]
          const dagUpdates: Record<string, unknown> = {}
          if (updates.status !== undefined) dagUpdates.status = updates.status
          if (updates.reviewStatus !== undefined) dagUpdates.reviewStatus = updates.reviewStatus
          updatedNodes[idx] = { ...updatedNodes[idx], ...dagUpdates }
          newDag = { ...s.dag, nodes: updatedNodes }
        }
      }
      return { tasks: newTasks, dag: newDag }
    }),

  setDAG: (dag) => set({ dag }),

  addActivity: (entry) =>
    set((s) => ({
      activities: [...s.activities, entry].slice(-MAX_ACTIVITIES),
    })),

  setActiveRootId: (activeRootId) => set({ activeRootId }),
  setSelectedTask: (selectedTaskId) => set({ selectedTaskId }),
  clearMonitor: () =>
    set({
      ...initialState,
      verification: {
        active: false,
        criteria: DEFAULT_VERIFICATION_CRITERIA.map((c) => ({ ...c })),
        results: [],
      },
    }),

  openVerifier: (taskId) =>
    set({
      verification: {
        active: true,
        taskId,
        criteria: DEFAULT_VERIFICATION_CRITERIA.map((c) => ({ ...c })),
        results: [],
      },
    }),

  closeVerifier: () =>
    set((s) => ({
      verification: { ...s.verification, active: false },
    })),

  recordCheck: (criterionId, result) =>
    set((s) => {
      const criteria = s.verification.criteria.map((c) =>
        c.id === criterionId
          ? { ...c, status: result.status, evidence: result.evidence, error: result.error }
          : c,
      )
      const results = [
        ...s.verification.results.filter((r) => r.criterionId !== criterionId),
        {
          criterionId,
          status: result.status,
          evidence: result.evidence,
          error: result.error,
          timestamp: Date.now(),
        },
      ]
      return { verification: { ...s.verification, criteria, results } }
    }),

  submitGateDecision: (verdict, note) =>
    set((s) => ({
      verification: {
        ...s.verification,
        gateDecision: {
          verdict,
          note,
          submittedAt: Date.now(),
        },
      },
    })),

  acknowledgeGate: (accepted, supervisorVerdict) =>
    set((s) => {
      if (!s.verification.gateDecision) return s
      return {
        verification: {
          ...s.verification,
          gateDecision: { ...s.verification.gateDecision, accepted, supervisorVerdict },
        },
      }
    }),
}))

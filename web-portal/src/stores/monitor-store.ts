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

/**
 * A single top-level request's view: its DAG topology + its own task map.
 * The monitor keeps one RootView per root id so concurrent/sequential requests
 * never intermix their tasks or clobber each other's DAG.
 */
export interface RootView {
  dag: DagState | null
  tasks: Record<string, MonitorTask>
  /**
   * Conversation/chat scope this root belongs to (from the dag_init payload's
   * optional `conversationId`). Used to group request-roots per conversation in
   * the root-switcher. First-wins so a later root-node-less dag_init (e.g. a
   * decomposition restructure) never blanks it.
   */
  conversationId?: string
  /**
   * Human-readable label for this root (the original request/goal text), derived
   * from the root node's title when the topology first arrives. First-wins so a
   * decomposition's later dag_init (which drops the root node) keeps the label.
   */
  label?: string
}

/** Optional per-root metadata captured when a root's topology first arrives. */
export interface RootMeta {
  conversationId?: string
  label?: string
}

/** One conversation group for the root-switcher: its roots, newest-last. */
export interface RootSwitcherGroup {
  conversationId: string
  roots: Array<{ rootId: string; label: string; isActive: boolean }>
}

interface MonitorState {
  // Per-root buckets — the source of truth. Keyed by the top-level request rootId.
  rootsById: Record<string, RootView>
  // Mirror of the active root's view, so components/selectors and existing
  // callers can keep reading `tasks`/`dag` directly (single-root = byte-identical).
  tasks: Record<string, MonitorTask>
  dag: DagState | null
  activities: ActivityEntry[]
  activeRootId: string | null
  selectedTaskId: string | null
  verification: VerificationState

  addTask: (task: MonitorTask) => void
  updateTask: (id: string, updates: Partial<MonitorTask>) => void
  setDAG: (dag: DagState, rootId?: string, meta?: RootMeta) => void
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
// Cap on retained per-root buckets. Each distinct top-level request mints a
// fresh rootId, so without a ceiling rootsById would grow unbounded over a
// long-lived portal session. When the cap is exceeded, the oldest non-active
// buckets are evicted (insertion order); the active root is always retained
// so the mirrored tasks/dag never go blank.
const MAX_ROOTS = 20

const initialVerification: VerificationState = {
  active: false,
  criteria: DEFAULT_VERIFICATION_CRITERIA.map((c) => ({ ...c })),
  results: [],
}

// Single shared bucket key used when no root id is known yet (pre-dag_init
// races, late nodes, reconnects). Keeps the legacy single-root flow intact.
const DEFAULT_ROOT_KEY = '__default__'

const initialState = {
  rootsById: {} as Record<string, RootView>,
  tasks: {} as Record<string, MonitorTask>,
  dag: null as DagState | null,
  activities: [] as ActivityEntry[],
  activeRootId: null as string | null,
  selectedTaskId: null as string | null,
  verification: initialVerification,
}

/** A fresh, empty per-root bucket. */
function emptyView(): RootView {
  return { dag: null, tasks: {} }
}

/** The bucket key for the currently active root (falls back to the default bucket). */
function activeKey(s: { activeRootId: string | null }): string {
  return s.activeRootId ?? DEFAULT_ROOT_KEY
}

/**
 * Evict the oldest non-active buckets when the root cap is exceeded so a
 * long-lived session does not accumulate buckets without bound. Object keys
 * preserve insertion order, so the leading keys are the oldest roots. The
 * active root (and the default bucket, which absorbs root-less updates) are
 * never evicted — the mirror reads the active bucket, so it never goes blank.
 */
function evictStaleRoots(rootsById: Record<string, RootView>, activeRootId: string | null): Record<string, RootView> {
  const keys = Object.keys(rootsById)
  if (keys.length <= MAX_ROOTS) return rootsById
  const active = activeRootId ?? DEFAULT_ROOT_KEY
  const pruned = { ...rootsById }
  for (const key of keys) {
    if (Object.keys(pruned).length <= MAX_ROOTS) break
    if (key === active || key === DEFAULT_ROOT_KEY) continue
    delete pruned[key]
  }
  return pruned
}

/** Persist the updated buckets (capped) and re-derive the active-root mirror. */
function commit(
  rootsById: Record<string, RootView>,
  activeRootId: string | null,
): { rootsById: Record<string, RootView>; tasks: Record<string, MonitorTask>; dag: DagState | null } {
  const capped = evictStaleRoots(rootsById, activeRootId)
  return { rootsById: capped, ...mirrorActive(capped, activeRootId) }
}

/** Find which bucket key currently owns a task id (active root first, then any). */
function ownerKey(rootsById: Record<string, RootView>, activeRootId: string | null, id: string): string | null {
  const active = activeRootId ?? DEFAULT_ROOT_KEY
  if (rootsById[active]?.tasks[id]) return active
  for (const key in rootsById) {
    if (rootsById[key].tasks[id]) return key
  }
  return null
}

/**
 * Re-derive the mirrored top-level `tasks`/`dag` from the active root's bucket.
 * Components read these directly, so a single-root session is byte-identical
 * to the prior flat-map behavior.
 */
function mirrorActive(rootsById: Record<string, RootView>, activeRootId: string | null): { tasks: Record<string, MonitorTask>; dag: DagState | null } {
  const view = rootsById[activeRootId ?? DEFAULT_ROOT_KEY]
  return { tasks: view?.tasks ?? {}, dag: view?.dag ?? null }
}

export const useMonitorStore = create<MonitorState>()((set) => ({
  ...initialState,

  addTask: (task) =>
    set((s) => {
      // Route the task into its own root bucket so tasks from different
      // top-level requests never intermix. Fall back to the active root, then
      // the default bucket when no root id is known.
      const key = task.rootId ?? activeKey(s)
      const bucket = s.rootsById[key] ?? emptyView()
      const rootsById = {
        ...s.rootsById,
        [key]: { ...bucket, tasks: { ...bucket.tasks, [task.id]: task } },
      }
      return commit(rootsById, s.activeRootId)
    }),

  updateTask: (id, updates) =>
    set((s) => {
      // Resolve which root bucket owns this task. Updates from background roots
      // land in their own bucket; only the active root's update reaches the mirror.
      const owner = ownerKey(s.rootsById, s.activeRootId, id)

      if (!owner) {
        // Auto-create a placeholder task when an update arrives before dag_init
        // (e.g. WS reconnect, late-arriving nodes, or race conditions). It is
        // scoped to the active root bucket. DAG sync is intentionally skipped —
        // the DAG is not yet initialized; when dag_init arrives, setDAG populates it.
        const key = updates.rootId ?? activeKey(s)
        const bucket = s.rootsById[key] ?? emptyView()
        if ((updates.status || updates.title) && Object.keys(bucket.tasks).length < MAX_TASKS) {
          const created: MonitorTask = {
            id,
            nodeId: updates.nodeId ?? id,
            title: updates.title ?? id,
            status: updates.status ?? 'executing',
            reviewStatus: updates.reviewStatus ?? 'none',
            ...updates,
          }
          const rootsById = {
            ...s.rootsById,
            [key]: { ...bucket, tasks: { ...bucket.tasks, [id]: created } },
          }
          return commit(rootsById, s.activeRootId)
        }
        return s
      }

      const bucket = s.rootsById[owner]
      const newTasks = { ...bucket.tasks, [id]: { ...bucket.tasks[id], ...updates } }
      // Sync status into that bucket's dag.nodes so DAGView re-renders
      let newDag = bucket.dag
      if (bucket.dag && ('status' in updates || 'reviewStatus' in updates)) {
        const idx = bucket.dag.nodes.findIndex((n) => n.id === id)
        if (idx >= 0) {
          const updatedNodes = [...bucket.dag.nodes]
          const dagUpdates: Record<string, unknown> = {}
          if (updates.status !== undefined) dagUpdates.status = updates.status
          if (updates.reviewStatus !== undefined) dagUpdates.reviewStatus = updates.reviewStatus
          updatedNodes[idx] = { ...updatedNodes[idx], ...dagUpdates }
          newDag = { ...bucket.dag, nodes: updatedNodes }
        }
      }
      const rootsById = { ...s.rootsById, [owner]: { dag: newDag, tasks: newTasks } }
      return commit(rootsById, s.activeRootId)
    }),

  setDAG: (dag, rootId, meta) =>
    set((s) => {
      // dag_init / dag_restructure replace ONE root's topology. Other roots'
      // buckets are preserved (no cross-request clobber).
      const key = rootId ?? activeKey(s)
      const bucket = s.rootsById[key] ?? emptyView()
      // Persist conversation/label metadata FIRST-WINS: a decomposition's later
      // dag_init drops the root node (so it carries no label) — keeping the
      // original prevents it from blanking the switcher entry.
      const conversationId = bucket.conversationId ?? meta?.conversationId
      const label = bucket.label ?? meta?.label
      const rootsById = {
        ...s.rootsById,
        [key]: {
          ...bucket,
          dag,
          ...(conversationId !== undefined ? { conversationId } : {}),
          ...(label !== undefined ? { label } : {}),
        },
      }
      return commit(rootsById, s.activeRootId)
    }),

  addActivity: (entry) =>
    set((s) => ({
      activities: [...s.activities, entry].slice(-MAX_ACTIVITIES),
    })),

  setActiveRootId: (activeRootId) =>
    set((s) => ({ activeRootId, ...commit(s.rootsById, activeRootId) })),
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

/**
 * The human-readable label for a root bucket: the original request text, falling
 * back to its first task's title, else `undefined`. Single source of the label
 * rule so callers can pick their own final fallback (rootId vs null).
 */
function rootLabel(bucket: RootView): string | undefined {
  return bucket.label ?? Object.values(bucket.tasks)[0]?.title
}

/**
 * Build the root-switcher view: every real (non-default) root, grouped by its
 * conversation. Each root carries a human-readable label (the original request
 * text), falling back to its first task's title, then to a short id. Roots with
 * no `conversationId` fall back to being their own group (keyed by rootId), so
 * the switcher is legacy-safe before the backend ships `conversationId` (each
 * root is simply its own group — a flat recent-roots list).
 *
 * Pure grouping over the raw inputs (no hook). Kept separate from any selector so
 * the component can subscribe to `rootsById`/`activeRootId` (stable references
 * under shallow equality) and memoize the freshly-allocated group array —
 * subscribing to the array directly would re-render on every store change.
 */
export function buildRootGroups(
  rootsById: Record<string, RootView> | undefined,
  activeRootId: string | null,
): RootSwitcherGroup[] {
  const groups = new Map<string, RootSwitcherGroup>()
  for (const [rootId, bucket] of Object.entries(rootsById ?? {})) {
    if (rootId === DEFAULT_ROOT_KEY) continue
    const label = rootLabel(bucket) ?? rootId
    const conversationId = bucket.conversationId ?? rootId
    const entry = { rootId, label, isActive: rootId === activeRootId }
    const group = groups.get(conversationId)
    if (group) {
      group.roots.push(entry)
    } else {
      groups.set(conversationId, { conversationId, roots: [entry] })
    }
  }
  return [...groups.values()]
}

/**
 * Pure selector (no hook) so callers can `useMonitorStore(selectRootSwitcher)`
 * or compute it from a snapshot in tests.
 */
export function selectRootSwitcher(s: MonitorState): RootSwitcherGroup[] {
  return buildRootGroups(s.rootsById, s.activeRootId)
}

/** Total count of real (non-default) roots — drives showing/hiding the switcher. */
export function selectRootCount(s: MonitorState): number {
  let count = 0
  for (const rootId in s.rootsById ?? {}) {
    if (rootId !== DEFAULT_ROOT_KEY) count++
  }
  return count
}

/** The active root's human-readable label (request/goal text), if any. */
export function selectActiveRootLabel(s: MonitorState): string | null {
  if (!s.activeRootId) return null
  const bucket = s.rootsById?.[s.activeRootId]
  if (!bucket) return null
  return rootLabel(bucket) ?? null
}

import { create } from 'zustand'

export interface MonitorTask {
  id: string
  nodeId: string
  title: string
  status: string
  reviewStatus: string
  agentId?: string
  startedAt?: number
  completedAt?: number
  dependencies?: string[]
  implementationResult?: unknown
  specReviewResult?: unknown
  qualityReviewResult?: unknown
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

interface MonitorState {
  tasks: Record<string, MonitorTask>
  dag: DagState | null
  activities: ActivityEntry[]
  activeRootId: string | null
  selectedTaskId: string | null

  addTask: (task: MonitorTask) => void
  updateTask: (id: string, updates: Partial<MonitorTask>) => void
  setDAG: (dag: DagState) => void
  addActivity: (entry: ActivityEntry) => void
  setActiveRootId: (id: string | null) => void
  setSelectedTask: (id: string | null) => void
  clearMonitor: () => void
}

const MAX_ACTIVITIES = 200

const initialState = {
  tasks: {} as Record<string, MonitorTask>,
  dag: null as DagState | null,
  activities: [] as ActivityEntry[],
  activeRootId: null as string | null,
  selectedTaskId: null as string | null,
}

export const useMonitorStore = create<MonitorState>()((set) => ({
  ...initialState,

  addTask: (task) =>
    set((s) => ({ tasks: { ...s.tasks, [task.id]: task } })),

  updateTask: (id, updates) =>
    set((s) =>
      s.tasks[id]
        ? { tasks: { ...s.tasks, [id]: { ...s.tasks[id], ...updates } } }
        : s,
    ),

  setDAG: (dag) => set({ dag }),

  addActivity: (entry) =>
    set((s) => ({
      activities: [...s.activities, entry].slice(-MAX_ACTIVITIES),
    })),

  setActiveRootId: (activeRootId) => set({ activeRootId }),
  setSelectedTask: (selectedTaskId) => set({ selectedTaskId }),
  clearMonitor: () => set({ ...initialState }),
}))

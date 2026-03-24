import { Suspense, lazy, useState } from 'react'
import ActivityFeed from './ActivityFeed'
import TaskDetailPanel from './TaskDetailPanel'
import InterventionToolbar from './InterventionToolbar'
import GateDialog from './GateDialog'
import SupervisorPanel from './SupervisorPanel'

const DAGView = lazy(() => import('./DAGView'))
const KanbanBoard = lazy(() => import('./KanbanBoard'))

type ViewMode = 'dag' | 'kanban'

export default function MonitorPanel() {
  const [viewMode, setViewMode] = useState<ViewMode>('dag')

  return (
    <div className="flex h-full min-h-0">
      {/* Left: main view (DAG or Kanban) */}
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
          <button
            onClick={() => setViewMode('dag')}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              viewMode === 'dag'
                ? 'bg-white/5 text-accent'
                : 'text-text-secondary hover:text-text'
            }`}
          >
            DAG
          </button>
          <button
            onClick={() => setViewMode('kanban')}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              viewMode === 'kanban'
                ? 'bg-white/5 text-accent'
                : 'text-text-secondary hover:text-text'
            }`}
          >
            Kanban
          </button>
          <div className="ml-auto">
            <InterventionToolbar />
          </div>
        </div>
        <div className="flex-1 min-h-0">
          {viewMode === 'dag' ? (
            <Suspense
              fallback={
                <div className="flex items-center justify-center h-full text-text-tertiary text-sm">
                  Loading DAG view...
                </div>
              }
            >
              <DAGView />
            </Suspense>
          ) : (
            <Suspense
              fallback={
                <div className="flex items-center justify-center h-full text-text-tertiary text-sm">
                  Loading Kanban...
                </div>
              }
            >
              <KanbanBoard />
            </Suspense>
          )}
        </div>
      </div>

      {/* Right: Activity feed + task detail */}
      <div className="flex flex-col w-64 shrink-0 bg-white/3 backdrop-blur border-l border-white/5 min-h-0">
        {/* Supervisor panel */}
        <div className="shrink-0 border-b border-border overflow-y-auto max-h-64 px-2 py-2">
          <SupervisorPanel />
        </div>
        {/* Task detail */}
        <div className="flex flex-col shrink-0 max-h-48 border-b border-border overflow-y-auto">
          <div className="px-3 py-2 text-xs font-semibold text-text-secondary uppercase tracking-wide shrink-0">
            Task Detail
          </div>
          <TaskDetailPanel />
        </div>
        {/* Activity feed */}
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
          <div className="px-3 py-2 text-xs font-semibold text-text-secondary uppercase tracking-wide shrink-0 border-b border-border">
            Activity
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            <ActivityFeed />
          </div>
        </div>
      </div>
      <GateDialog />
    </div>
  )
}

import { Suspense, lazy, useState } from 'react'

const DAGView = lazy(() => import('./DAGView'))

type ViewMode = 'dag' | 'kanban'

export default function MonitorPanel() {
  const [viewMode, setViewMode] = useState<ViewMode>('dag')

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
        <button
          onClick={() => setViewMode('dag')}
          className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
            viewMode === 'dag'
              ? 'bg-surface text-accent'
              : 'text-text-secondary hover:text-text'
          }`}
        >
          DAG
        </button>
        <button
          onClick={() => setViewMode('kanban')}
          className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
            viewMode === 'kanban'
              ? 'bg-surface text-accent'
              : 'text-text-secondary hover:text-text'
          }`}
        >
          Kanban
        </button>
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
          <div className="flex items-center justify-center h-full text-text-secondary text-sm">
            Kanban view coming in next task
          </div>
        )}
      </div>
    </div>
  )
}

import { Suspense, lazy, useState, useCallback, useRef } from 'react'
import ActivityFeed from './ActivityFeed'
import TaskDetailPanel from './TaskDetailPanel'
import InterventionToolbar from './InterventionToolbar'
import GateDialog from './GateDialog'
import SupervisorPanel from './SupervisorPanel'
import ResizeHandle from './ResizeHandle'

const DAGView = lazy(() => import('./DAGView'))
const KanbanBoard = lazy(() => import('./KanbanBoard'))

type ViewMode = 'dag' | 'kanban'

const STORAGE_KEY_SIDEBAR = 'strada-monitor-sidebar-width'
const STORAGE_KEY_DETAIL = 'strada-monitor-detail-height'
const STORAGE_KEY_SUPERVISOR = 'strada-monitor-supervisor-height'

const SIDEBAR_DEFAULT = 320
const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 600

const DETAIL_DEFAULT = 220
const DETAIL_MIN = 80
const DETAIL_MAX = 500

const SUPERVISOR_DEFAULT = 160
const SUPERVISOR_MIN = 60
const SUPERVISOR_MAX = 350

function readStored(key: string, fallback: number): number {
  try {
    const v = localStorage.getItem(key)
    return v ? Number(v) : fallback
  } catch {
    return fallback
  }
}

function writeStored(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(Math.round(value)))
  } catch {
    // localStorage unavailable
  }
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val))
}

export default function MonitorPanel() {
  const [viewMode, setViewMode] = useState<ViewMode>('dag')

  // Resizable sidebar width (horizontal)
  const [sidebarWidth, setSidebarWidth] = useState(() => readStored(STORAGE_KEY_SIDEBAR, SIDEBAR_DEFAULT))

  // Resizable section heights within sidebar (vertical)
  const [supervisorHeight, setSupervisorHeight] = useState(() =>
    readStored(STORAGE_KEY_SUPERVISOR, SUPERVISOR_DEFAULT),
  )
  const [detailHeight, setDetailHeight] = useState(() =>
    readStored(STORAGE_KEY_DETAIL, DETAIL_DEFAULT),
  )

  // Refs for tracking drag state to avoid excessive localStorage writes
  const sidebarRef = useRef(sidebarWidth)
  const supervisorRef = useRef(supervisorHeight)
  const detailRef = useRef(detailHeight)

  const onSidebarResize = useCallback((delta: number) => {
    // Negative delta = dragging left = making sidebar wider (handle is on the left edge of sidebar)
    setSidebarWidth((prev) => {
      const next = clamp(prev - delta, SIDEBAR_MIN, SIDEBAR_MAX)
      sidebarRef.current = next
      return next
    })
  }, [])

  const onSidebarResizeEnd = useCallback(() => {
    writeStored(STORAGE_KEY_SIDEBAR, sidebarRef.current)
  }, [])

  const onSupervisorResize = useCallback((delta: number) => {
    setSupervisorHeight((prev) => {
      const next = clamp(prev + delta, SUPERVISOR_MIN, SUPERVISOR_MAX)
      supervisorRef.current = next
      return next
    })
  }, [])

  const onSupervisorResizeEnd = useCallback(() => {
    writeStored(STORAGE_KEY_SUPERVISOR, supervisorRef.current)
  }, [])

  const onDetailResize = useCallback((delta: number) => {
    setDetailHeight((prev) => {
      const next = clamp(prev + delta, DETAIL_MIN, DETAIL_MAX)
      detailRef.current = next
      return next
    })
  }, [])

  const onDetailResizeEnd = useCallback(() => {
    writeStored(STORAGE_KEY_DETAIL, detailRef.current)
  }, [])

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

      {/* Horizontal resize handle (between main view and sidebar) */}
      <ResizeHandle direction="horizontal" onResize={onSidebarResize} onResizeEnd={onSidebarResizeEnd} />

      {/* Right: resizable sidebar */}
      <div
        className="flex flex-col shrink-0 bg-white/3 backdrop-blur border-l border-white/5 min-h-0 overflow-hidden"
        style={{ width: sidebarWidth }}
      >
        {/* Supervisor panel — resizable height */}
        <div
          className="shrink-0 overflow-y-auto px-2 py-2"
          style={{ height: supervisorHeight }}
        >
          <SupervisorPanel />
        </div>

        {/* Vertical resize handle (between supervisor and task detail) */}
        <ResizeHandle
          direction="vertical"
          onResize={onSupervisorResize}
          onResizeEnd={onSupervisorResizeEnd}
          className="border-y border-border"
        />

        {/* Task detail — resizable height */}
        <div
          className="flex flex-col shrink-0 overflow-y-auto"
          style={{ height: detailHeight }}
        >
          <div className="px-3 py-2 text-xs font-semibold text-text-secondary uppercase tracking-wide shrink-0">
            Task Detail
          </div>
          <TaskDetailPanel />
        </div>

        {/* Vertical resize handle (between task detail and activity feed) */}
        <ResizeHandle
          direction="vertical"
          onResize={onDetailResize}
          onResizeEnd={onDetailResizeEnd}
          className="border-y border-border"
        />

        {/* Activity feed — fills remaining space */}
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
          <div className="px-3 py-2 text-xs font-semibold text-text-secondary uppercase tracking-wide shrink-0">
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

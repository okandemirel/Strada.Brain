import { Suspense, lazy, useCallback, useRef, useState } from 'react'
import ActivityFeed from './ActivityFeed'
import GateDialog from './GateDialog'
import InterventionToolbar from './InterventionToolbar'
import MonitorOverview from './MonitorOverview'
import ResizeHandle from './ResizeHandle'
import SupervisorPanel from './SupervisorPanel'
import TaskDetailPanel from './TaskDetailPanel'

const DAGView = lazy(() => import('./DAGView'))
const KanbanBoard = lazy(() => import('./KanbanBoard'))

type ViewMode = 'dag' | 'kanban'

const STORAGE_KEY_SIDEBAR = 'strada-monitor-sidebar-width'
const STORAGE_KEY_OVERVIEW = 'strada-monitor-overview-height'
const STORAGE_KEY_OVERVIEW_COLLAPSED = 'strada-monitor-overview-collapsed'
const STORAGE_KEY_DETAIL = 'strada-monitor-detail-height'
const STORAGE_KEY_SUPERVISOR = 'strada-monitor-supervisor-height'

const SIDEBAR_DEFAULT = 320
const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 600

const OVERVIEW_DEFAULT = 188
const OVERVIEW_MIN = 104
const OVERVIEW_MAX = 360

const DETAIL_DEFAULT = 220
const DETAIL_MIN = 80
const DETAIL_MAX = 500

const SUPERVISOR_DEFAULT = 160
const SUPERVISOR_MIN = 60
const SUPERVISOR_MAX = 350

function readStored(key: string, fallback: number): number {
  try {
    const value = localStorage.getItem(key)
    return value ? Number(value) : fallback
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

function readStoredBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key)
    return value == null ? fallback : value === 'true'
  } catch {
    return fallback
  }
}

function writeStoredBoolean(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? 'true' : 'false')
  } catch {
    // localStorage unavailable
  }
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val))
}

function SummaryStrip({ onExpand }: { onExpand: () => void }) {
  return (
    <div className="shrink-0 border-b border-white/6 bg-black/10 px-4 py-2">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-tertiary">
            Summary Hidden
          </div>
          <div className="mt-0.5 text-xs text-text-secondary">
            Workspace is expanded. Show the summary strip again when needed.
          </div>
        </div>
        <button
          onClick={onExpand}
          className="shrink-0 rounded-md border border-white/8 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:text-text"
        >
          Show Summary
        </button>
      </div>
    </div>
  )
}

export default function MonitorPanel() {
  const [viewMode, setViewMode] = useState<ViewMode>('dag')
  const [sidebarWidth, setSidebarWidth] = useState(() => readStored(STORAGE_KEY_SIDEBAR, SIDEBAR_DEFAULT))
  const [overviewHeight, setOverviewHeight] = useState(() =>
    readStored(STORAGE_KEY_OVERVIEW, OVERVIEW_DEFAULT),
  )
  const [overviewCollapsed, setOverviewCollapsed] = useState(() =>
    readStoredBoolean(STORAGE_KEY_OVERVIEW_COLLAPSED, false),
  )
  const [supervisorHeight, setSupervisorHeight] = useState(() =>
    readStored(STORAGE_KEY_SUPERVISOR, SUPERVISOR_DEFAULT),
  )
  const [detailHeight, setDetailHeight] = useState(() =>
    readStored(STORAGE_KEY_DETAIL, DETAIL_DEFAULT),
  )

  const sidebarRef = useRef(sidebarWidth)
  const overviewRef = useRef(overviewHeight)
  const supervisorRef = useRef(supervisorHeight)
  const detailRef = useRef(detailHeight)

  const onSidebarResize = useCallback((delta: number) => {
    setSidebarWidth((prev) => {
      const next = clamp(prev - delta, SIDEBAR_MIN, SIDEBAR_MAX)
      sidebarRef.current = next
      return next
    })
  }, [])

  const onSidebarResizeEnd = useCallback(() => {
    writeStored(STORAGE_KEY_SIDEBAR, sidebarRef.current)
  }, [])

  const onOverviewResize = useCallback((delta: number) => {
    setOverviewHeight((prev) => {
      const next = clamp(prev + delta, OVERVIEW_MIN, OVERVIEW_MAX)
      overviewRef.current = next
      return next
    })
  }, [])

  const onOverviewResizeEnd = useCallback(() => {
    writeStored(STORAGE_KEY_OVERVIEW, overviewRef.current)
  }, [])

  const toggleOverview = useCallback(() => {
    setOverviewCollapsed((prev) => {
      const next = !prev
      writeStoredBoolean(STORAGE_KEY_OVERVIEW_COLLAPSED, next)
      return next
    })
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/6 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-lg border border-white/8 bg-white/[0.03] p-1">
              <button
                onClick={() => setViewMode('dag')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  viewMode === 'dag'
                    ? 'bg-white/8 text-text'
                    : 'text-text-secondary hover:text-text'
                }`}
              >
                DAG
              </button>
              <button
                onClick={() => setViewMode('kanban')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  viewMode === 'kanban'
                    ? 'bg-white/8 text-text'
                    : 'text-text-secondary hover:text-text'
                }`}
              >
                Kanban
              </button>
            </div>

            <button
              onClick={toggleOverview}
              className="rounded-md border border-white/8 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:text-text"
            >
              {overviewCollapsed ? 'Summary Hidden' : 'Hide Summary'}
            </button>
          </div>

          <InterventionToolbar />
        </div>

        {overviewCollapsed ? (
          <SummaryStrip onExpand={toggleOverview} />
        ) : (
          <>
            <div className="shrink-0 overflow-y-auto" style={{ height: overviewHeight }}>
              <MonitorOverview />
            </div>

            <ResizeHandle
              direction="vertical"
              onResize={onOverviewResize}
              onResizeEnd={onOverviewResizeEnd}
              className="border-y border-white/6 bg-white/[0.02]"
            />
          </>
        )}

        <div className="min-h-0 flex-1 overflow-hidden">
          {viewMode === 'dag' ? (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-text-tertiary">
                  Loading DAG view...
                </div>
              }
            >
              <DAGView />
            </Suspense>
          ) : (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-text-tertiary">
                  Loading Kanban...
                </div>
              }
            >
              <KanbanBoard />
            </Suspense>
          )}
        </div>
      </div>

      <ResizeHandle direction="horizontal" onResize={onSidebarResize} onResizeEnd={onSidebarResizeEnd} />

      <div
        className="flex min-h-0 shrink-0 flex-col overflow-hidden border-l border-white/6 bg-white/[0.02] backdrop-blur"
        style={{ width: sidebarWidth }}
      >
        <div className="shrink-0 overflow-y-auto px-2 py-2" style={{ height: supervisorHeight }}>
          <SupervisorPanel />
        </div>

        <ResizeHandle
          direction="vertical"
          onResize={onSupervisorResize}
          onResizeEnd={onSupervisorResizeEnd}
          className="border-y border-border"
        />

        <div className="flex shrink-0 flex-col overflow-y-auto" style={{ height: detailHeight }}>
          <div className="shrink-0 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
            Task Detail
          </div>
          <TaskDetailPanel />
        </div>

        <ResizeHandle
          direction="vertical"
          onResize={onDetailResize}
          onResizeEnd={onDetailResizeEnd}
          className="border-y border-border"
        />

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="shrink-0 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
            Activity
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <ActivityFeed />
          </div>
        </div>
      </div>

      <GateDialog />
    </div>
  )
}

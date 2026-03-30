import { useEffect, useMemo, useRef } from 'react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cn } from '@/lib/utils'
import {
  useMonitorStore,
  type MonitorTask,
  type MonitorTaskStatus,
  type MonitorReviewStatus,
} from '../../stores/monitor-store'
import { useWS } from '../../hooks/useWS'
import { normalizeLabel } from './monitor-utils'

/** Maps each Kanban column to the default status when a task is dropped there. */
const COLUMN_STATUS_MAP: Record<string, { status: MonitorTaskStatus; reviewStatus: MonitorReviewStatus }> = {
  backlog: { status: 'pending', reviewStatus: 'none' },
  working: { status: 'executing', reviewStatus: 'none' },
  review: { status: 'executing', reviewStatus: 'spec_review' },
  done: { status: 'completed', reviewStatus: 'review_passed' },
  issues: { status: 'failed', reviewStatus: 'none' },
}

const COLUMNS = [
  { id: 'backlog', label: 'Backlog', filter: (task: MonitorTask) => task.status === 'pending' },
  { id: 'working', label: 'Working', filter: (task: MonitorTask) => task.status === 'executing' },
  {
    id: 'review',
    label: 'Review',
    filter: (task: MonitorTask) =>
      task.status === 'verifying' ||
      task.reviewStatus === 'spec_review' ||
      task.reviewStatus === 'quality_review',
  },
  {
    id: 'done',
    label: 'Done',
    filter: (task: MonitorTask) =>
      task.status === 'completed' &&
      task.reviewStatus !== 'spec_review' &&
      task.reviewStatus !== 'quality_review' &&
      task.reviewStatus !== 'review_stuck',
  },
  {
    id: 'issues',
    label: 'Issues',
    filter: (task: MonitorTask) =>
      task.status === 'failed' || task.status === 'skipped' || task.reviewStatus === 'review_stuck',
  },
]

const TASK_CARD_TONES: Record<string, string> = {
  pending: 'border-white/10 bg-black/20',
  executing: 'border-accent/20 bg-accent/10',
  completed: 'border-emerald-400/20 bg-emerald-400/10',
  failed: 'border-rose-400/20 bg-rose-400/10',
  skipped: 'border-white/10 bg-white/[0.04]',
  verifying: 'border-amber-400/20 bg-amber-400/10',
}

const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 5 } }

function TaskCard({ task }: { task: MonitorTask }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { task },
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
    zIndex: isDragging ? 50 : undefined,
  }
  const setSelectedTask = useMonitorStore((s) => s.setSelectedTask)

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => setSelectedTask(task.id)}
      className={cn(
        'cursor-pointer rounded-xl border px-3 py-2.5 text-xs transition-all hover:border-accent/30',
        TASK_CARD_TONES[task.status] ?? TASK_CARD_TONES.pending,
        isDragging && 'scale-[1.01] shadow-[0_12px_24px_rgba(0,0,0,0.18)]',
      )}
    >
      <div className="truncate text-sm font-medium text-text">{task.title}</div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-secondary">
          {normalizeLabel(task.status)}
        </span>
        {task.reviewStatus !== 'none' && (
          <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-secondary">
            {normalizeLabel(task.reviewStatus)}
          </span>
        )}
      </div>
    </div>
  )
}

interface KanbanColumnProps {
  id: string
  label: string
  tasks: MonitorTask[]
}

function KanbanColumn({ id, label, tasks }: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id })

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex min-w-[220px] flex-1 flex-col overflow-hidden rounded-2xl border bg-white/[0.02] transition-colors',
        isOver ? 'border-accent/40 bg-accent/[0.04]' : 'border-white/8',
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/8 px-3 py-3">
        <span className="text-xs font-semibold uppercase tracking-[0.18em] text-text-secondary">
          {label}
        </span>
        <span className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-[10px] font-semibold text-text-secondary">
          {tasks.length}
        </span>
      </div>

      <SortableContext items={tasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2.5">
          {tasks.length === 0 ? (
            <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-white/8 bg-black/10 px-3 py-6 text-center text-xs text-text-tertiary">
              No tasks
            </div>
          ) : (
            tasks.map((task) => <TaskCard key={task.id} task={task} />)
          )}
        </div>
      </SortableContext>
    </div>
  )
}

/** Resolve which column a task currently belongs to based on its status. */
function resolveColumnId(task: MonitorTask): string | null {
  for (const col of COLUMNS) {
    if (col.filter(task)) return col.id
  }
  return null
}

export default function KanbanBoard() {
  const tasks = useMonitorStore((s) => s.tasks)
  const updateTask = useMonitorStore((s) => s.updateTask)
  const activeRootId = useMonitorStore((s) => s.activeRootId)
  const { sendRawJSON } = useWS()

  // Refs so handleDragEnd reads latest values without being in deps
  const tasksRef = useRef(tasks)
  const activeRootIdRef = useRef(activeRootId)
  useEffect(() => {
    tasksRef.current = tasks
    activeRootIdRef.current = activeRootId
  })

  const sensors = useSensors(useSensor(PointerSensor, POINTER_SENSOR_OPTIONS))

  const columns = useMemo(() => {
    const taskList = Object.values(tasks)
    return COLUMNS.map((column) => ({ ...column, tasks: taskList.filter(column.filter) }))
  }, [tasks])

  // Stable callback — only depends on store actions and WS sender (both stable refs)
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over) return

    const taskId = active.id as string
    const task = tasksRef.current[taskId]
    if (!task) return

    const rootId = task.rootId ?? activeRootIdRef.current
    if (!rootId) return

    // Determine target column: column droppable or task card's column
    let targetColumnId: string | null = null
    if (COLUMN_STATUS_MAP[over.id as string]) {
      targetColumnId = over.id as string
    } else {
      const overTask = tasksRef.current[over.id as string]
      targetColumnId = overTask ? resolveColumnId(overTask) : null
    }
    if (!targetColumnId) return

    const sourceColumnId = resolveColumnId(task)
    if (sourceColumnId === targetColumnId) return

    const mapping = COLUMN_STATUS_MAP[targetColumnId]
    if (!mapping) return

    // Preserve original status when it's valid for the target column
    // (e.g., skipped tasks dragged to issues keep 'skipped', quality_review keeps its type)
    let newStatus: MonitorTaskStatus = mapping.status
    let newReviewStatus: MonitorReviewStatus = mapping.reviewStatus

    if (targetColumnId === 'issues' && task.status === 'skipped') {
      newStatus = 'skipped'
    }
    if (targetColumnId === 'review' && task.reviewStatus === 'quality_review') {
      newReviewStatus = 'quality_review'
    }

    const updates: Partial<MonitorTask> = { status: newStatus, reviewStatus: newReviewStatus }

    // Optimistic update with rollback on WS failure
    const prevStatus = task.status
    const prevReviewStatus = task.reviewStatus
    updateTask(taskId, updates)

    const sent = sendRawJSON({
      type: 'monitor:move_task',
      rootId,
      taskId: task.id,
      nodeId: task.nodeId,
      fromColumn: sourceColumnId,
      toColumn: targetColumnId,
      newStatus,
      newReviewStatus,
    })

    if (!sent) {
      updateTask(taskId, { status: prevStatus, reviewStatus: prevReviewStatus })
    }
  }

  return (
    <div className="h-full overflow-hidden p-3">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <div className="grid h-full min-h-0 auto-cols-[minmax(220px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-1">
          {columns.map((column) => (
            <KanbanColumn
              key={column.id}
              id={column.id}
              label={column.label}
              tasks={column.tasks}
            />
          ))}
        </div>
      </DndContext>
    </div>
  )
}

import { useMemo } from 'react'
import { DndContext, closestCenter } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cn } from '@/lib/utils'
import { useMonitorStore, type MonitorTask } from '../../stores/monitor-store'
import { normalizeLabel } from './monitor-utils'

const COLUMNS = [
  { id: 'backlog', label: 'Backlog', filter: (task: MonitorTask) => task.status === 'pending' },
  { id: 'working', label: 'Working', filter: (task: MonitorTask) => task.status === 'executing' },
  {
    id: 'review',
    label: 'Review',
    filter: (task: MonitorTask) =>
      task.reviewStatus === 'spec_review' || task.reviewStatus === 'quality_review',
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


function TaskCard({ task }: { task: MonitorTask }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  })
  const style = { transform: CSS.Transform.toString(transform), transition }
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
  return (
    <div className="flex min-w-[220px] flex-1 flex-col overflow-hidden rounded-2xl border border-white/8 bg-white/[0.02]">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/8 px-3 py-3">
        <span className="text-xs font-semibold uppercase tracking-[0.18em] text-text-secondary">
          {label}
        </span>
        <span className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-[10px] font-semibold text-text-secondary">
          {tasks.length}
        </span>
      </div>

      <DndContext
        id={id}
        collisionDetection={closestCenter}
        onDragEnd={() => {
          // Column-local reorder is visual-only; no store mutation needed
        }}
      >
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
      </DndContext>
    </div>
  )
}

export default function KanbanBoard() {
  const tasks = useMonitorStore((s) => s.tasks)

  const columns = useMemo(() => {
    const taskList = Object.values(tasks)
    return COLUMNS.map((column) => ({ ...column, tasks: taskList.filter(column.filter) }))
  }, [tasks])

  return (
    <div className="h-full overflow-hidden p-3">
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
    </div>
  )
}

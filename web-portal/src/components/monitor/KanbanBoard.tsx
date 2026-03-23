import { DndContext, closestCenter } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useMonitorStore, type MonitorTask } from '../../stores/monitor-store'

const COLUMNS = [
  { id: 'backlog', label: 'Backlog', filter: (t: MonitorTask) => t.status === 'pending' },
  { id: 'working', label: 'Working', filter: (t: MonitorTask) => t.status === 'executing' },
  {
    id: 'review',
    label: 'Review',
    filter: (t: MonitorTask) =>
      t.reviewStatus === 'spec_review' || t.reviewStatus === 'quality_review',
  },
  {
    id: 'done',
    label: 'Done',
    filter: (t: MonitorTask) =>
      t.status === 'completed' && t.reviewStatus === 'review_passed',
  },
  {
    id: 'issues',
    label: 'Issues',
    filter: (t: MonitorTask) =>
      t.status === 'failed' || t.status === 'skipped' || t.reviewStatus === 'review_stuck',
  },
]

function TaskCard({ task }: { task: MonitorTask }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
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
      className="rounded-lg border border-border bg-bg p-2 text-xs cursor-pointer hover:border-accent transition-colors"
    >
      <div className="font-medium text-text truncate">{task.title}</div>
      <div className="text-text-tertiary mt-1">{task.status}</div>
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
    <div className="flex flex-col min-w-0 flex-1">
      <div className="flex items-center gap-1.5 px-2 py-1.5 mb-2 shrink-0">
        <span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
          {label}
        </span>
        <span className="text-xs text-text-tertiary">({tasks.length})</span>
      </div>
      <DndContext
        id={id}
        collisionDetection={closestCenter}
        onDragEnd={() => {
          // Column-local reorder is visual-only; no store mutation needed
        }}
      >
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-1.5 overflow-y-auto px-1 flex-1">
            {tasks.length === 0 ? (
              <div className="text-xs text-text-tertiary px-1 py-2 text-center">—</div>
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
  const taskList = Object.values(tasks)

  return (
    <div className="flex gap-2 h-full px-3 py-2 overflow-x-auto">
      {COLUMNS.map((col) => (
        <KanbanColumn key={col.id} id={col.id} label={col.label} tasks={taskList.filter(col.filter)} />
      ))}
    </div>
  )
}

import { useMonitorStore } from '../../stores/monitor-store'

export default function TaskDetailPanel() {
  const selectedTaskId = useMonitorStore((s) => s.selectedTaskId)
  const tasks = useMonitorStore((s) => s.tasks)
  const task = selectedTaskId ? tasks[selectedTaskId] : null

  if (!task) {
    return (
      <div className="p-4 text-sm text-text-tertiary">Select a task to see details.</div>
    )
  }

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      <h3 className="text-sm font-semibold text-text">{task.title}</h3>
      <div className="space-y-2 text-xs">
        <div>
          <span className="text-text-tertiary">Status:</span>{' '}
          <span className="text-text">{task.status}</span>
        </div>
        <div>
          <span className="text-text-tertiary">Review:</span>{' '}
          <span className="text-text">{task.reviewStatus}</span>
        </div>
        {task.agentId && (
          <div>
            <span className="text-text-tertiary">Agent:</span>{' '}
            <span className="text-text">{task.agentId}</span>
          </div>
        )}
        {task.startedAt && (
          <div>
            <span className="text-text-tertiary">Started:</span>{' '}
            <span className="text-text">{new Date(task.startedAt).toLocaleTimeString()}</span>
          </div>
        )}
        {task.completedAt && (
          <div>
            <span className="text-text-tertiary">Completed:</span>{' '}
            <span className="text-text">{new Date(task.completedAt).toLocaleTimeString()}</span>
          </div>
        )}
        {task.dependencies && task.dependencies.length > 0 && (
          <div>
            <span className="text-text-tertiary">Dependencies:</span>{' '}
            <span className="text-text">{task.dependencies.join(', ')}</span>
          </div>
        )}
      </div>
    </div>
  )
}

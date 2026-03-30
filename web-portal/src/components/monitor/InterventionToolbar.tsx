import { RotateCcw, Play, Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useWS } from '../../hooks/useWS'
import { useMonitorStore } from '../../stores/monitor-store'
import { Button } from '../ui/button'

const RETRYABLE_STATUSES = new Set(['failed', 'skipped'])
const RESUMABLE_STATUSES = new Set(['blocked', 'paused', 'waiting_for_input'])
const CANCELLABLE_STATUSES = new Set(['pending', 'executing', 'verifying'])

export default function InterventionToolbar() {
  const { t } = useTranslation('monitor')
  const { sendRawJSON } = useWS()
  const selectedTaskId = useMonitorStore((s) => s.selectedTaskId)
  const activeRootId = useMonitorStore((s) => s.activeRootId)
  const tasks = useMonitorStore((s) => s.tasks)
  const selectedTask = selectedTaskId ? tasks[selectedTaskId] : null
  const rootId = selectedTask?.rootId ?? activeRootId

  const send = (payload: Record<string, unknown>) => {
    void sendRawJSON(payload)
  }

  const retryVisible = Boolean(selectedTask && rootId && RETRYABLE_STATUSES.has(selectedTask.status))
  const resumeVisible = Boolean(
    rootId && (
      (selectedTask && RESUMABLE_STATUSES.has(selectedTask.status)) ||
      (!selectedTask && activeRootId)
    ),
  )
  const cancelVisible = Boolean(
    rootId && (
      (selectedTask && CANCELLABLE_STATUSES.has(selectedTask.status)) ||
      (!selectedTask && activeRootId)
    ),
  )

  if (!retryVisible && !resumeVisible && !cancelVisible) {
    return (
      <div className="flex items-center gap-2 text-xs text-text-tertiary">
        {t('intervention.hint')}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      {retryVisible && selectedTask && rootId && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => send({
            type: 'monitor:retry_task',
            rootId,
            taskId: selectedTask.id,
            nodeId: selectedTask.nodeId,
          })}
        >
          <RotateCcw size={14} />
          <span className="ml-1 text-xs">{t('intervention.retry')}</span>
        </Button>
      )}

      {resumeVisible && rootId && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => send({
            type: 'monitor:resume_task',
            rootId,
            ...(selectedTask ? { taskId: selectedTask.id, nodeId: selectedTask.nodeId } : {}),
          })}
        >
          <Play size={14} />
          <span className="ml-1 text-xs">{t('intervention.resume')}</span>
        </Button>
      )}

      {cancelVisible && rootId && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => send({
            type: 'monitor:cancel_task',
            rootId,
            ...(selectedTask ? { taskId: selectedTask.id, nodeId: selectedTask.nodeId } : {}),
          })}
        >
          <Square size={14} />
          <span className="ml-1 text-xs">{t('intervention.cancel')}</span>
        </Button>
      )}
    </div>
  )
}

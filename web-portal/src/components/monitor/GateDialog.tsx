import { useTranslation } from 'react-i18next'
import { useMonitorStore } from '../../stores/monitor-store'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog'
import { Button } from '../ui/button'

export default function GateDialog() {
  const { t } = useTranslation('monitor')
  const tasks = useMonitorStore((s) => s.tasks)
  const stuckTask = Object.values(tasks).find((t) => t.reviewStatus === 'review_stuck')

  if (!stuckTask) return null

  const handleApprove = () => {
    useMonitorStore.getState().updateTask(stuckTask.id, { reviewStatus: 'review_passed' })
  }

  const handleSkip = () => {
    useMonitorStore.getState().updateTask(stuckTask.id, { status: 'skipped', reviewStatus: 'none' })
  }

  return (
    <Dialog open={true}>
      <DialogContent hideClose>
        <DialogTitle>{t('gate.title')}</DialogTitle>
        <DialogDescription>
          {t('gate.description', { title: stuckTask.title })}
        </DialogDescription>
        <div className="flex gap-2 mt-4">
          <Button onClick={handleApprove}>{t('gate.approve')}</Button>
          <Button variant="outline" onClick={handleSkip}>
            {t('gate.skip')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

import { useMonitorStore } from '../../stores/monitor-store'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog'
import { Button } from '../ui/button'

export default function GateDialog() {
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
        <DialogTitle>Review Gate</DialogTitle>
        <DialogDescription>
          Task &quot;{stuckTask.title}&quot; is stuck after maximum review iterations. What would you
          like to do?
        </DialogDescription>
        <div className="flex gap-2 mt-4">
          <Button onClick={handleApprove}>Approve Anyway</Button>
          <Button variant="outline" onClick={handleSkip}>
            Skip Task
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

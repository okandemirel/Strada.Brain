import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMonitorStore } from '../../stores/monitor-store'
import { fetchJson } from '../../utils/api'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog'
import { Button } from '../ui/button'

type GateAction = 'approve' | 'skip'

/**
 * Review-gate dialog for a task stuck at `review_stuck`.
 *
 * Audit 11.6 (plan 0-A.30): this used to flip the local store and close
 * itself — the daemon never heard the decision. The server exposes
 * POST /api/monitor/task/:id/approve|skip (src/dashboard/monitor-routes.ts),
 * which emit monitor:gate_response on the workspace bus and answer 503 when
 * nothing is listening. So the dialog now POSTs the decision, mirrors it
 * into the store only once the server confirmed it reached a consumer, and
 * otherwise shows the refusal and stays open — no green that the backend
 * did not earn.
 */
export default function GateDialog() {
  const { t } = useTranslation('monitor')
  const tasks = useMonitorStore((s) => s.tasks)
  const stuckTask = Object.values(tasks).find((t) => t.reviewStatus === 'review_stuck')
  const [pending, setPending] = useState<GateAction | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!stuckTask) return null

  const decide = async (action: GateAction) => {
    setPending(action)
    setError(null)
    try {
      await fetchJson(`/api/monitor/task/${encodeURIComponent(stuckTask.id)}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootId: stuckTask.rootId ?? '' }),
      })
      if (action === 'approve') {
        useMonitorStore.getState().updateTask(stuckTask.id, { reviewStatus: 'review_passed' })
      } else {
        useMonitorStore.getState().updateTask(stuckTask.id, { status: 'skipped', reviewStatus: 'none' })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(null)
    }
  }

  return (
    <Dialog open={true}>
      <DialogContent hideClose>
        <DialogTitle>{t('gate.title')}</DialogTitle>
        <DialogDescription>
          {t('gate.description', { title: stuckTask.title })}
        </DialogDescription>
        {error && (
          <p role="alert" className="mt-3 text-xs text-error">
            {t('gate.failed', { error })}
          </p>
        )}
        <div className="flex gap-2 mt-4">
          <Button onClick={() => { void decide('approve') }} disabled={pending !== null}>
            {pending === 'approve' ? t('gate.sending') : t('gate.approve')}
          </Button>
          <Button variant="outline" onClick={() => { void decide('skip') }} disabled={pending !== null}>
            {pending === 'skip' ? t('gate.sending') : t('gate.skip')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/shallow'
import { useMonitorStore, type CriterionState, type VerifyGateVerdict } from '../../stores/monitor-store'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/dialog'
import { Button } from '../ui/button'
import { cn } from '@/lib/utils'

interface VerificationEditorProps {
  taskId: string
  open: boolean
  onClose: () => void
  send: (payload: Record<string, unknown>) => boolean
}

const STATUS_ICON: Record<CriterionState['status'], { icon: string; cls: string; label: string }> = {
  pass: { icon: '\u2713', cls: 'text-emerald-400', label: 'Pass' },
  warn: { icon: '\u26A0', cls: 'text-amber-400', label: 'Warn' },
  fail: { icon: '\u2717', cls: 'text-rose-400', label: 'Fail' },
  pending: { icon: '\u25CB', cls: 'text-text-tertiary', label: 'Pending' },
}

function CriterionRow({ criterion }: { criterion: CriterionState }) {
  const s = STATUS_ICON[criterion.status]
  return (
    <div className="flex items-start gap-3 rounded-lg border border-white/8 bg-black/15 px-3 py-2.5">
      <span className={cn('mt-0.5 text-base leading-none', s.cls)}>{s.icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm text-text">{criterion.label}</div>
          <span
            className={cn(
              'rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
              criterion.status === 'pass' && 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
              criterion.status === 'warn' && 'border-amber-400/30 bg-amber-400/10 text-amber-300',
              criterion.status === 'fail' && 'border-rose-400/30 bg-rose-400/10 text-rose-300',
              criterion.status === 'pending' && 'border-white/10 bg-white/5 text-text-tertiary',
            )}
          >
            {s.label}
          </span>
        </div>
        {criterion.evidence && (
          <div className="mt-1.5 rounded bg-white/[0.03] px-2 py-1.5 font-mono text-[11px] leading-relaxed text-text-secondary whitespace-pre-wrap break-words max-h-24 overflow-auto">
            {criterion.evidence}
          </div>
        )}
        {criterion.error && (
          <div className="mt-1.5 rounded border border-rose-400/20 bg-rose-400/5 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-rose-300 whitespace-pre-wrap break-words max-h-24 overflow-auto">
            {criterion.error}
          </div>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.03]">
      <div className="px-4 py-2.5">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-tertiary">
          {title}
        </div>
      </div>
      <div className="border-t border-white/6 px-4 py-3">{children}</div>
    </div>
  )
}

export default function VerificationEditor({ taskId, open, onClose, send }: VerificationEditorProps) {
  const { verification, recordCheck, submitGateDecision } = useMonitorStore(
    useShallow((s) => ({
      verification: s.verification,
      recordCheck: s.recordCheck,
      submitGateDecision: s.submitGateDecision,
    })),
  )

  const [note, setNote] = useState('')
  const [running, setRunning] = useState<string | null>(null)

  const { passCount, failCount, warnCount, pendingCount } = useMemo(() => {
    const c = verification.criteria
    return {
      passCount: c.filter((x) => x.status === 'pass').length,
      failCount: c.filter((x) => x.status === 'fail').length,
      warnCount: c.filter((x) => x.status === 'warn').length,
      pendingCount: c.filter((x) => x.status === 'pending').length,
    }
  }, [verification.criteria])

  const allClear = failCount === 0 && pendingCount === 0

  // Derive criterion ids by checkType so button state never relies on id strings
  // happening to match DEFAULT_VERIFICATION_CRITERIA literals.
  const { buildCriterionId, testCriterionId } = useMemo(() => ({
    buildCriterionId: verification.criteria.find((c) => c.checkType === 'build')?.id ?? null,
    testCriterionId: verification.criteria.find((c) => c.checkType === 'test')?.id ?? null,
  }), [verification.criteria])

  // Clear the running spinner when the backend result arrives (status leaves 'pending').
  // Without this the 35s fallback would keep the button label stale after every check.
  useEffect(() => {
    if (!running) return
    const criterion = verification.criteria.find((c) => c.id === running)
    if (criterion && criterion.status !== 'pending') {
      setRunning(null)
    }
  }, [verification.criteria, running])

  const runCheck = (checkType: 'build' | 'test' | 'manual') => {
    const criterion = verification.criteria.find((c) => c.checkType === checkType)
    if (!criterion) return
    // Optimistic UI: mark pending while waiting (backend will send verify:check_result)
    recordCheck(criterion.id, { status: 'pending' })
    setRunning(criterion.id)
    send({
      type: 'verify:check_criterion',
      taskId,
      criterionId: criterion.id,
      checkType,
    })
    // Auto-clear running flag after 35s in case backend misses response
    setTimeout(() => setRunning((r) => (r === criterion.id ? null : r)), 35_000)
  }

  const markManual = (status: 'pass' | 'fail') => {
    const criterion = verification.criteria.find((c) => c.checkType === 'manual')
    if (!criterion) return
    recordCheck(criterion.id, {
      status,
      evidence: status === 'pass' ? 'Marked pass by operator' : 'Marked fail by operator',
    })
  }

  const handleGate = (verdict: VerifyGateVerdict) => {
    submitGateDecision(verdict, note || undefined)
    send({
      type: 'verify:gate_decision',
      taskId,
      verdict,
      ...(note ? { note } : {}),
    })
  }

  const gateDecision = verification.gateDecision

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="!max-w-2xl !w-[90vw] !max-h-[85vh] flex flex-col !p-0 overflow-hidden">
        <div className="shrink-0 border-b border-white/8 px-5 pt-5 pb-4">
          <DialogTitle className="text-base font-semibold text-text leading-snug">
            Level Completion Verifier &mdash; Task #{taskId}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Verify that this level (task) meets acceptance criteria before approval.
          </DialogDescription>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
            <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2 py-0.5 text-emerald-300">
              {passCount} pass
            </span>
            <span className="rounded-full border border-amber-400/20 bg-amber-400/10 px-2 py-0.5 text-amber-300">
              {warnCount} warn
            </span>
            <span className="rounded-full border border-rose-400/20 bg-rose-400/10 px-2 py-0.5 text-rose-300">
              {failCount} fail
            </span>
            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-text-tertiary">
              {pendingCount} pending
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <Section title="Acceptance Criteria">
            <div className="space-y-2">
              {verification.criteria.map((c) => (
                <CriterionRow key={c.id} criterion={c} />
              ))}
            </div>
          </Section>

          <Section title="Automated Checks">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => runCheck('build')}
                disabled={running === buildCriterionId}
              >
                {running === buildCriterionId ? 'Running build...' : 'Run Build Check'}
              </Button>
              <Button
                variant="outline"
                onClick={() => runCheck('test')}
                disabled={running === testCriterionId}
              >
                {running === testCriterionId ? 'Running tests...' : 'Run Tests Check'}
              </Button>
              <Button variant="ghost" onClick={() => markManual('pass')}>
                Mark Manual Pass
              </Button>
              <Button variant="ghost" onClick={() => markManual('fail')}>
                Mark Manual Fail
              </Button>
            </div>
          </Section>

          <Section title="Results">
            {verification.results.length === 0 ? (
              <div className="py-2 text-center text-xs text-text-tertiary">
                No checks executed yet.
              </div>
            ) : (
              <ul className="space-y-1.5">
                {verification.results
                  .slice()
                  .sort((a, b) => b.timestamp - a.timestamp)
                  .map((r) => {
                    const crit = verification.criteria.find((c) => c.id === r.criterionId)
                    return (
                      <li
                        key={`${r.criterionId}-${r.timestamp}`}
                        className="flex items-center justify-between gap-3 text-xs"
                      >
                        <span className="text-text-secondary">
                          {crit?.label ?? r.criterionId}
                        </span>
                        <span
                          className={cn(
                            'font-semibold uppercase tracking-wide',
                            STATUS_ICON[r.status].cls,
                          )}
                        >
                          {r.status}
                        </span>
                      </li>
                    )
                  })}
              </ul>
            )}
          </Section>

          <Section title="Gate Decision">
            <div className="space-y-3">
              <textarea
                className="w-full resize-y rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-text placeholder:text-text-tertiary focus:border-accent/50 focus:outline-none"
                rows={3}
                placeholder="Optional note (reason, caveats, follow-ups)..."
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={2000}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="default"
                  onClick={() => handleGate('approve')}
                  disabled={!allClear}
                  title={!allClear ? 'Resolve failures and pending checks first' : undefined}
                >
                  Approve
                </Button>
                <Button variant="outline" onClick={() => handleGate('request_changes')}>
                  Request Changes
                </Button>
                <Button variant="destructive" onClick={() => handleGate('escalate')}>
                  Escalate
                </Button>
              </div>
              {gateDecision && (
                <div
                  className={cn(
                    'rounded-lg border px-3 py-2 text-xs',
                    gateDecision.accepted === true && 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300',
                    gateDecision.accepted === false && 'border-rose-400/20 bg-rose-400/10 text-rose-300',
                    gateDecision.accepted === undefined && 'border-white/10 bg-white/5 text-text-secondary',
                  )}
                >
                  <div className="font-semibold uppercase tracking-wide">
                    Submitted: {gateDecision.verdict.replace(/_/g, ' ')}
                  </div>
                  {gateDecision.note && (
                    <div className="mt-1 text-text-secondary">{gateDecision.note}</div>
                  )}
                  {gateDecision.supervisorVerdict && (
                    <div className="mt-1">Supervisor: {gateDecision.supervisorVerdict}</div>
                  )}
                  {gateDecision.accepted === undefined && (
                    <div className="mt-1 italic">Waiting for server acknowledgement...</div>
                  )}
                </div>
              )}
            </div>
          </Section>
        </div>

        <div className="shrink-0 border-t border-white/8 px-5 py-3 flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

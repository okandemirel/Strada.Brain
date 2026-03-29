import { useLearningHealth, useLearningDecisions } from '../../hooks/use-api'

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const OUTCOME_COLORS: Record<string, string> = {
  success: 'text-green-400',
  failure: 'text-red-400',
  skipped: 'text-yellow-400',
}

export default function LearningSection() {
  const { data, isLoading } = useLearningHealth()
  const { data: decisionsData } = useLearningDecisions(20)

  if (isLoading || !data) {
    return (
      <div>
        <h2 className="text-lg font-semibold text-text mb-1">Learning</h2>
        <p className="text-sm text-text-tertiary">Loading...</p>
      </div>
    )
  }

  const aggregates = data.aggregates
  const runtime = data.runtime
  const decisions = decisionsData?.decisions ?? []

  // Derive health status from runtime stats
  const issues: string[] = []
  if (runtime.reflection.overrideRate > 0.5) issues.push(`High reflection override rate: ${(runtime.reflection.overrideRate * 100).toFixed(0)}%`)
  if (runtime.consensus.agreementRate < 0.5 && runtime.consensus.totalVerifications > 0) issues.push(`Low consensus agreement rate: ${(runtime.consensus.agreementRate * 100).toFixed(0)}%`)
  if (aggregates?.lowPerformers && aggregates.lowPerformers.length > 3) issues.push(`${aggregates.lowPerformers.length} low-performing instincts detected`)
  const healthy = issues.length === 0

  return (
    <div>
      <h2 className="text-lg font-semibold text-text mb-1">Learning</h2>
      <p className="text-sm text-text-tertiary mb-6">Self-improvement diagnostics and recent decisions</p>

      {/* Health status */}
      <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-4">
        <div className="flex items-center gap-3">
          {healthy ? (
            <>
              <span className="flex-shrink-0 w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center text-green-400 text-lg">✓</span>
              <div>
                <p className="text-sm font-medium text-text">System Healthy</p>
                <p className="text-xs text-text-tertiary">Learning pipeline operating normally</p>
              </div>
            </>
          ) : (
            <>
              <span className="flex-shrink-0 w-8 h-8 rounded-full bg-red-500/20 flex items-center justify-center text-red-400 text-lg">✗</span>
              <div>
                <p className="text-sm font-medium text-red-400">Issues Detected</p>
                <p className="text-xs text-text-tertiary">{issues.length} issue{issues.length !== 1 ? 's' : ''} found</p>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Issues */}
      {issues.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3">Issues</p>
          <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl overflow-hidden mb-4">
            {issues.map((issue, idx) => (
              <div key={idx} className={`flex items-start gap-3 px-4 py-3 ${idx < issues.length - 1 ? 'border-b border-white/5' : ''}`}>
                <span className="flex-shrink-0 w-1.5 h-1.5 mt-1.5 rounded-full bg-red-400" />
                <span className="text-sm text-text-secondary">{issue}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Instinct Summary */}
      {aggregates && (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3">Instincts</p>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-4 text-center">
              <p className="text-2xl font-semibold text-text">{aggregates.instinctSummary.active}</p>
              <p className="text-xs text-text-tertiary mt-1">Active</p>
            </div>
            <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-4 text-center">
              <p className="text-2xl font-semibold text-text">{aggregates.instinctSummary.total}</p>
              <p className="text-xs text-text-tertiary mt-1">Total</p>
            </div>
            <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-4 text-center">
              <p className="text-2xl font-semibold text-accent">{(aggregates.instinctSummary.avgConfidence * 100).toFixed(0)}%</p>
              <p className="text-xs text-text-tertiary mt-1">Avg Confidence</p>
            </div>
          </div>
        </>
      )}

      {/* Runtime Stats */}
      <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3">Runtime</p>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-4 text-center">
          <p className="text-2xl font-semibold text-text">{runtime.reflection.totalDone}</p>
          <p className="text-xs text-text-tertiary mt-1">Reflections</p>
        </div>
        <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-4 text-center">
          <p className="text-2xl font-semibold text-text">{runtime.consensus.totalVerifications}</p>
          <p className="text-xs text-text-tertiary mt-1">Verifications</p>
        </div>
        <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-4 text-center">
          <p className="text-2xl font-semibold text-text">{runtime.outcome.totalTracked}</p>
          <p className="text-xs text-text-tertiary mt-1">Outcomes</p>
        </div>
      </div>

      {/* Recent decisions */}
      {decisions.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3">Recent Decisions</p>
          <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl overflow-hidden mb-4">
            {decisions.map((decision, idx) => (
              <div key={idx} className={`flex items-center justify-between px-4 py-3 ${idx < decisions.length - 1 ? 'border-b border-white/5' : ''}`}>
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-sm text-text-secondary capitalize truncate">{decision.type}</span>
                  <span className={`text-xs font-medium ${OUTCOME_COLORS[decision.outcome] ?? 'text-text-secondary'}`}>
                    {decision.outcome}
                  </span>
                </div>
                <span className="text-xs text-text-tertiary flex-shrink-0 ml-4">
                  {formatTimestamp(decision.timestamp)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {decisions.length === 0 && healthy && (
        <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 text-center">
          <p className="text-sm text-text-tertiary">No recent decisions recorded</p>
        </div>
      )}
    </div>
  )
}

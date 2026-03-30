import { useTranslation } from 'react-i18next'
import { useLearningHealth, useLearningDecisions } from '../../hooks/use-api'
import { PageError } from '../../components/ui/page-error'

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
  const { t } = useTranslation('settings')
  const { data, isLoading, error } = useLearningHealth()
  const { data: decisionsData } = useLearningDecisions(20)

  if (isLoading) {
    return (
      <div>
        <h2 className="text-lg font-semibold text-text mb-1">{t('learning.title')}</h2>
        <p className="text-sm text-text-tertiary">{t('learning.loading')}</p>
      </div>
    )
  }

  if (error || !data) {
    return <PageError title={t('learning.errorTitle')} message={error instanceof Error ? error.message : t('learning.errorFallback')} />
  }

  const aggregates = data.aggregates
  const runtime = data.runtime
  const decisions = decisionsData?.decisions ?? []

  // Derive health status from runtime stats
  const issues: string[] = []
  if (runtime.reflection.overrideRate > 0.5) issues.push(t('learning.highReflectionOverride', { rate: (runtime.reflection.overrideRate * 100).toFixed(0) }))
  if (runtime.consensus.agreementRate < 0.5 && runtime.consensus.totalVerifications > 0) issues.push(t('learning.lowConsensusAgreement', { rate: (runtime.consensus.agreementRate * 100).toFixed(0) }))
  const trueLowPerformers = aggregates?.lowPerformers?.filter((p) => p.confidence < 0.5) ?? []
  if (trueLowPerformers.length > 3) issues.push(t('learning.lowPerformingInstincts', { count: trueLowPerformers.length }))
  const healthy = issues.length === 0

  return (
    <div>
      <h2 className="text-lg font-semibold text-text mb-1">{t('learning.title')}</h2>
      <p className="text-sm text-text-tertiary mb-6">{t('learning.description')}</p>

      {/* Health status */}
      <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-5 mb-4">
        <div className="flex items-center gap-3">
          {healthy ? (
            <>
              <span className="flex-shrink-0 w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center text-green-400 text-lg">✓</span>
              <div>
                <p className="text-sm font-medium text-text">{t('learning.systemHealthy')}</p>
                <p className="text-xs text-text-tertiary">{t('learning.healthyDescription')}</p>
              </div>
            </>
          ) : (
            <>
              <span className="flex-shrink-0 w-8 h-8 rounded-full bg-red-500/20 flex items-center justify-center text-red-400 text-lg">✗</span>
              <div>
                <p className="text-sm font-medium text-red-400">{t('learning.issuesDetected')}</p>
                <p className="text-xs text-text-tertiary">{issues.length !== 1 ? t('learning.issueCountPlural', { count: issues.length }) : t('learning.issueCount', { count: issues.length })}</p>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Issues */}
      {issues.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3">{t('learning.issues')}</p>
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
          <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3">{t('learning.instincts')}</p>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-4 text-center">
              <p className="text-2xl font-semibold text-text">{aggregates.instinctSummary.active}</p>
              <p className="text-xs text-text-tertiary mt-1">{t('learning.instinctsActive')}</p>
            </div>
            <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-4 text-center">
              <p className="text-2xl font-semibold text-text">{aggregates.instinctSummary.total}</p>
              <p className="text-xs text-text-tertiary mt-1">{t('learning.instinctsTotal')}</p>
            </div>
            <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-4 text-center">
              <p className="text-2xl font-semibold text-accent">{(aggregates.instinctSummary.avgConfidence * 100).toFixed(0)}%</p>
              <p className="text-xs text-text-tertiary mt-1">{t('learning.avgConfidence')}</p>
            </div>
          </div>
        </>
      )}

      {/* Runtime Stats */}
      <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3">{t('learning.runtime')}</p>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-4 text-center">
          <p className="text-2xl font-semibold text-text">{runtime.reflection.totalDone}</p>
          <p className="text-xs text-text-tertiary mt-1">{t('learning.reflections')}</p>
        </div>
        <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-4 text-center">
          <p className="text-2xl font-semibold text-text">{runtime.consensus.totalVerifications}</p>
          <p className="text-xs text-text-tertiary mt-1">{t('learning.verifications')}</p>
        </div>
        <div className="bg-white/3 backdrop-blur border border-white/5 rounded-2xl p-4 text-center">
          <p className="text-2xl font-semibold text-text">{runtime.outcome.totalTracked}</p>
          <p className="text-xs text-text-tertiary mt-1">{t('learning.outcomes')}</p>
        </div>
      </div>

      {/* Recent decisions */}
      {decisions.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-3">{t('learning.recentDecisions')}</p>
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
          <p className="text-sm text-text-tertiary">{t('learning.noRecentDecisions')}</p>
        </div>
      )}
    </div>
  )
}

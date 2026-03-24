import { useState } from 'react'
import { Badge } from '../ui/badge'
import { useSupervisorStore } from '../../stores/supervisor-store'

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-white/10 text-text-tertiary',
  running: 'bg-blue-500/20 text-blue-400',
  done: 'bg-success/20 text-success',
  failed: 'bg-error/20 text-error',
  skipped: 'bg-warning/20 text-warning',
  verifying: 'bg-purple-500/20 text-purple-400',
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatCost(c: number): string {
  return `$${c.toFixed(4)}`
}

export default function SupervisorPanel() {
  const active = useSupervisorStore((s) => s.active)
  const nodes = useSupervisorStore((s) => s.nodes)
  const providers = useSupervisorStore((s) => s.providers)
  const summary = useSupervisorStore((s) => s.summary)
  const waveIndex = useSupervisorStore((s) => s.waveIndex)
  const totalWaves = useSupervisorStore((s) => s.totalWaves)
  const events = useSupervisorStore((s) => s.events)
  const [logOpen, setLogOpen] = useState(false)

  if (!active) return null

  // Provider usage bars
  const providerEntries = Object.entries(providers)
  const maxNodes = Math.max(1, ...providerEntries.map(([, v]) => v.count))

  // Filter to failure/escalation events only
  const alertEvents = events.filter(
    (e) => e.kind === 'failed' || e.kind === 'escalation',
  )

  return (
    <div className="bg-white/3 backdrop-blur border border-white/5 rounded-xl p-3 space-y-3 animate-[admin-fade-in_0.3s_ease]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
          Supervisor
        </h3>
        {summary ? (
          <Badge variant={summary.failed > 0 ? 'destructive' : 'success'} className="text-[10px]">
            {summary.failed > 0 ? 'Completed with errors' : 'Completed'}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[10px]">
            Wave {waveIndex + 1}{totalWaves > 0 ? ` / ${totalWaves}` : ''}
          </Badge>
        )}
      </div>

      {/* DAG node status grid */}
      <div className="flex flex-wrap gap-1.5">
        {nodes.map((node) => (
          <div
            key={node.id}
            className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-mono ${STATUS_COLORS[node.status] ?? STATUS_COLORS.pending}`}
            title={`${node.id} — ${node.provider ?? 'unassigned'}`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />
            <span className="truncate max-w-[80px]">{node.id}</span>
            {node.provider && (
              <span className="text-[9px] opacity-60 ml-0.5">{node.provider}</span>
            )}
          </div>
        ))}
      </div>

      {/* Provider usage */}
      {providerEntries.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] text-text-tertiary uppercase tracking-wide">Providers</div>
          {providerEntries.map(([name, info]) => (
            <div key={name} className="flex items-center gap-2 text-[11px]">
              <span className="w-16 text-text-secondary truncate">{name}</span>
              <div className="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent/60 rounded-full transition-all duration-300"
                  style={{ width: `${(info.count / maxNodes) * 100}%` }}
                />
              </div>
              <span className="text-text-tertiary w-6 text-right">{info.count}</span>
            </div>
          ))}
        </div>
      )}

      {/* Summary stats */}
      {summary && (
        <div className="grid grid-cols-3 gap-2 text-[11px]">
          <div className="bg-white/3 rounded-lg p-2 text-center">
            <div className="text-text-tertiary">Succeeded</div>
            <div className="text-success font-semibold">{summary.succeeded}/{summary.totalNodes}</div>
          </div>
          <div className="bg-white/3 rounded-lg p-2 text-center">
            <div className="text-text-tertiary">Cost</div>
            <div className="text-text font-semibold">{formatCost(summary.cost)}</div>
          </div>
          <div className="bg-white/3 rounded-lg p-2 text-center">
            <div className="text-text-tertiary">Duration</div>
            <div className="text-text font-semibold">{formatDuration(summary.duration)}</div>
          </div>
        </div>
      )}

      {/* Collapsible failure/escalation log */}
      {alertEvents.length > 0 && (
        <div>
          <button
            onClick={() => setLogOpen(!logOpen)}
            className="text-[10px] text-warning hover:text-warning/80 transition-colors"
          >
            {logOpen ? 'Hide' : 'Show'} {alertEvents.length} alert{alertEvents.length !== 1 ? 's' : ''}
          </button>
          {logOpen && (
            <div className="mt-1.5 space-y-1 max-h-32 overflow-y-auto">
              {alertEvents.map((evt, i) => (
                <div
                  key={i}
                  className={`text-[10px] px-2 py-1 rounded ${
                    evt.kind === 'failed'
                      ? 'bg-error/10 text-error'
                      : 'bg-warning/10 text-warning'
                  }`}
                >
                  <span className="font-mono">{evt.nodeId}</span>{' '}
                  <span className="opacity-70">{evt.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

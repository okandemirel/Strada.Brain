import type { RendererProps } from '../card-registry'

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-400/20 text-yellow-300',
  planned: 'bg-yellow-400/20 text-yellow-300',
  executing: 'bg-blue-400/20 text-blue-300',
  verifying: 'bg-purple-400/20 text-purple-300',
  completed: 'bg-emerald-400/20 text-emerald-300',
  failed: 'bg-red-400/20 text-red-300',
  passed: 'bg-emerald-400/20 text-emerald-300',
  warning: 'bg-amber-400/20 text-amber-300',
  error: 'bg-red-400/20 text-red-300',
}

export default function StatusContentRenderer({ type, props }: RendererProps) {
  const title = String(props.title ?? props.name ?? props.message ?? '')
  const status = String(props.status ?? props.severity ?? '')
  const priority = String(props.priority ?? '')
  const colorClass = STATUS_COLORS[status] ?? STATUS_COLORS.pending

  return (
    <div className="space-y-1.5">
      {title && <div className="text-xs font-medium text-text truncate">{title}</div>}
      <div className="flex items-center gap-1.5">
        {status && <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${colorClass}`}>{status}</span>}
        {priority && priority !== 'undefined' && <span className="text-[9px] text-text-tertiary">{priority}</span>}
      </div>
      {type === 'error-card' && props.stack && (
        <pre className="text-[9px] font-mono text-red-300/70 line-clamp-3 overflow-hidden">{String(props.stack)}</pre>
      )}
      {type === 'test-result' && (
        <div className="flex gap-2 text-[10px]">
          {props.passed != null && <span className="text-emerald-400">{String(props.passed)} passed</span>}
          {props.failed != null && <span className="text-red-400">{String(props.failed)} failed</span>}
        </div>
      )}
    </div>
  )
}

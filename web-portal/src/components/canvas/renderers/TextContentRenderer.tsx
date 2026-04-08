import type { RendererProps } from '../card-registry'

export default function TextContentRenderer({ type, props }: RendererProps) {
  const title = String(props.title ?? props.name ?? '')
  const content = String(props.content ?? props.text ?? props.description ?? '')
  const url = type === 'link-card' ? String(props.url ?? '') : undefined
  const progress = type === 'goal-summary' && typeof props.taskCount === 'number' && props.taskCount > 0
    ? ((Number(props.completedCount ?? 0) / props.taskCount) * 100)
    : undefined

  return (
    <div className="space-y-1.5">
      {title && <div className="text-xs font-semibold text-text truncate">{title}</div>}
      {content && <div className="text-[11px] text-text-secondary line-clamp-4 whitespace-pre-wrap">{content}</div>}
      {url && <div className="text-[10px] text-accent/70 truncate">{url}</div>}
      {progress != null && (
        <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
        </div>
      )}
    </div>
  )
}

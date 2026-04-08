import type { RendererProps } from '../card-registry'

export default function MediaContentRenderer({ type, props }: RendererProps) {
  if (type === 'image-block') {
    const src = String(props.src ?? props.url ?? '')
    const alt = String(props.alt ?? props.title ?? 'Image')
    const isSafe = src.startsWith('data:') || src.startsWith('blob:')
    return isSafe
      ? <img src={src} alt={alt} className="rounded-lg max-h-48 w-full object-contain" />
      : <div className="text-[10px] text-text-tertiary italic">Image source blocked (security)</div>
  }
  const path = String(props.path ?? props.name ?? '')
  const language = String(props.language ?? '')
  const lines = props.lines != null ? Number(props.lines) : undefined
  return (
    <div className="space-y-1">
      <div className="text-xs font-mono text-text truncate">{path || 'Unknown file'}</div>
      <div className="flex gap-2 text-[9px] text-text-tertiary">
        {language && <span>{language}</span>}
        {lines != null && <span>{lines} lines</span>}
      </div>
    </div>
  )
}

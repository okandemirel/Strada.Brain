import type { RendererProps } from '../card-registry'

export default function CodeContentRenderer({ type, props }: RendererProps) {
  const code = String(props.code ?? props.content ?? props.diff ?? props.output ?? '')
  const language = String(props.language ?? props.lang ?? '')
  const command = type === 'terminal-block' ? String(props.command ?? '') : undefined
  const isDiff = type === 'diff-block'

  return (
    <div className="space-y-1">
      {command && (
        <div className="text-[10px] font-mono text-accent/80 bg-white/5 rounded px-1.5 py-0.5 truncate">$ {command}</div>
      )}
      {language && !command && (
        <div className="text-[9px] text-text-tertiary uppercase tracking-wide">{language}</div>
      )}
      <pre className={`text-[10px] font-mono leading-relaxed overflow-hidden max-h-40 ${isDiff ? 'text-orange-300/80' : 'text-text-secondary'}`}>
        {code || '(empty)'}
      </pre>
    </div>
  )
}

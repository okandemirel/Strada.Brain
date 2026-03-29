import { useState } from 'react'
import type { ResolvedShape } from './canvas-types'

interface CardProps {
  shape: ResolvedShape
}

// Shared components
function AiBadge({ source }: { source?: string }) {
  if (source !== 'agent') return null
  return (
    <span className="absolute top-2.5 right-2.5 z-10 inline-flex items-center gap-1.5 rounded-full border border-sky-400/20 bg-sky-400/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-sky-300/90 pointer-events-none">
      <span className="h-1.5 w-1.5 rounded-full bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.5)]" />
      AI
    </span>
  )
}

function CardBadge({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.12em] ${className}`}>
      {children}
    </span>
  )
}

const cardBase = 'relative overflow-hidden rounded-2xl border backdrop-blur-2xl shadow-lg transition-shadow hover:shadow-xl'

function diffLineColor(line: string): string {
  if (line.startsWith('+')) return 'text-green-300'
  if (line.startsWith('-')) return 'text-red-300'
  if (line.startsWith('@')) return 'text-sky-300'
  return 'text-slate-400'
}

// 1. CodeBlock
export function CodeBlockCard({ shape }: CardProps) {
  const { code = '', language = 'text', title = 'Snippet' } = shape.props as Record<string, string>
  return (
    <div className={`${cardBase} border-sky-400/15 bg-gradient-to-b from-sky-400/[0.06] to-[#0a0e16]/95`} style={{ width: shape.w, height: shape.h }}>
      <AiBadge source={shape.source} />
      <div className="border-b border-sky-400/10 bg-gradient-to-b from-white/[0.035] to-white/[0.01] px-3.5 py-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardBadge className="border-sky-400/20 bg-sky-400/10 text-sky-300">Code</CardBadge>
            <div className="mt-2 text-sm font-semibold tracking-tight text-white">{title}</div>
          </div>
          <CardBadge className="border-white/8 bg-white/[0.04] text-slate-300">{language}</CardBadge>
        </div>
      </div>
      <pre className="flex-1 overflow-auto p-3.5 font-mono text-[11px] leading-relaxed text-slate-300">{code}</pre>
    </div>
  )
}

// 2. DiffBlock
export function DiffBlockCard({ shape }: CardProps) {
  const { diff = '', filePath = 'diff' } = shape.props as Record<string, string>
  return (
    <div className={`${cardBase} border-amber-400/15 bg-gradient-to-b from-amber-400/[0.04] to-[#0a0e16]/95`} style={{ width: shape.w, height: shape.h }}>
      <AiBadge source={shape.source} />
      <div className="border-b border-amber-400/10 bg-gradient-to-b from-white/[0.035] to-white/[0.01] px-3.5 py-3">
        <CardBadge className="border-amber-400/20 bg-amber-400/10 text-amber-300">Diff</CardBadge>
        <div className="mt-2 text-sm font-semibold tracking-tight text-white">{filePath}</div>
      </div>
      <div className="flex-1 overflow-auto p-3.5 font-mono text-[11px] leading-relaxed">
        {diff.split('\n').map((line, i) => (
          <div key={`${shape.id}-l${i}`} className={diffLineColor(line)}>
            {line || '\u00A0'}
          </div>
        ))}
      </div>
    </div>
  )
}

// 3. FileCard
export function FileCardCard({ shape }: CardProps) {
  const { filePath = '', language = '', lineCount = 0 } = shape.props as Record<string, unknown>
  const filename = String(filePath).split('/').pop() ?? String(filePath)
  return (
    <div className={`${cardBase} border-white/10 bg-gradient-to-b from-white/[0.03] to-[#0a0e16]/95 p-4`} style={{ width: shape.w, height: shape.h }}>
      <AiBadge source={shape.source} />
      <div className="flex h-full flex-col justify-between">
        <div>
          <CardBadge className="border-sky-400/15 bg-sky-400/[0.08] text-sky-200">File</CardBadge>
          <div className="mt-3 text-base font-semibold tracking-tight text-white">{filename}</div>
          <div className="mt-1.5 text-[11px] text-slate-500">{String(filePath)}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <CardBadge className="border-white/8 bg-white/[0.04] text-slate-400">{String(language) || 'File'}</CardBadge>
          <CardBadge className="border-white/8 bg-white/[0.04] text-slate-400">{String(lineCount)} lines</CardBadge>
        </div>
      </div>
    </div>
  )
}

// 4. DiagramNode
export function DiagramNodeCard({ shape }: CardProps) {
  const { label = 'Node', nodeType = 'default', status = 'idle' } = shape.props as Record<string, string>
  const statusColors: Record<string, string> = {
    active: 'bg-emerald-400/12 text-emerald-300 border-emerald-400/20',
    idle: 'bg-slate-400/12 text-slate-300 border-slate-400/20',
    error: 'bg-red-400/12 text-red-300 border-red-400/20',
    pending: 'bg-amber-400/12 text-amber-300 border-amber-400/20',
  }
  const dotColors: Record<string, string> = {
    active: 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]',
    idle: 'bg-slate-400',
    error: 'bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.6)]',
    pending: 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]',
  }
  return (
    <div className={`${cardBase} border-violet-400/15 bg-gradient-to-b from-violet-400/[0.04] to-[#0a0e16]/95 p-4`} style={{ width: shape.w, height: shape.h }}>
      <AiBadge source={shape.source} />
      <div className="flex h-full flex-col justify-between">
        <div className="flex items-center justify-between gap-2">
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.12em] ${statusColors[status] ?? statusColors.idle}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${dotColors[status] ?? dotColors.idle}`} />
            {status}
          </span>
          <span className="text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-600">{nodeType}</span>
        </div>
        <div className="text-lg font-semibold tracking-tight text-white">{label}</div>
      </div>
    </div>
  )
}

// 5. TerminalBlock
export function TerminalBlockCard({ shape }: CardProps) {
  const { command = '', output = '' } = shape.props as Record<string, string>
  return (
    <div className={`${cardBase} border-emerald-400/15 bg-gradient-to-b from-emerald-400/[0.04] to-[#050810]/95`} style={{ width: shape.w, height: shape.h }}>
      <AiBadge source={shape.source} />
      <div className="border-b border-emerald-400/10 bg-gradient-to-b from-white/[0.035] to-white/[0.01] px-3.5 py-3">
        <CardBadge className="border-emerald-400/20 bg-emerald-400/10 text-emerald-300">Terminal</CardBadge>
        <div className="mt-2 flex items-center gap-2 font-mono text-xs text-white">
          <span className="text-emerald-400">$</span>
          <span>{command}</span>
        </div>
      </div>
      <pre className="flex-1 overflow-auto p-3.5 font-mono text-[11px] leading-relaxed text-slate-400">{output}</pre>
    </div>
  )
}

// 6. ImageBlock
export function ImageBlockCard({ shape }: CardProps) {
  const { src = '', alt = '' } = shape.props as Record<string, string>
  const safeSrc = /^data:image\/(png|jpeg|gif|webp|avif|bmp);/.test(src) || /^blob:/.test(src) ? src : ''
  return (
    <div className={`${cardBase} border-white/10 bg-gradient-to-b from-white/[0.03] to-[#0a0e16]/95`} style={{ width: shape.w, height: shape.h }}>
      <AiBadge source={shape.source} />
      {safeSrc ? (
        <img src={safeSrc} alt={alt} className="h-full w-full rounded-2xl object-cover" />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2.5">
          <CardBadge className="border-sky-400/15 bg-sky-400/[0.08] text-sky-200">Image</CardBadge>
          <span className="text-xs text-slate-500">{alt || 'No image'}</span>
        </div>
      )}
    </div>
  )
}

// 7. TaskCard
export function TaskCardCard({ shape }: CardProps) {
  const { title = 'Task', status = 'todo', priority = 'medium' } = shape.props as Record<string, string>
  const barColors: Record<string, string> = {
    low: 'from-emerald-400',
    medium: 'from-amber-400',
    high: 'from-orange-400',
    critical: 'from-red-400',
  }
  const priorityBadge: Record<string, string> = {
    low: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300',
    medium: 'border-amber-400/20 bg-amber-400/10 text-amber-300',
    high: 'border-orange-400/20 bg-orange-400/10 text-orange-300',
    critical: 'border-red-400/20 bg-red-400/10 text-red-300',
  }
  return (
    <div className={`${cardBase} border-sky-400/15 bg-gradient-to-b from-sky-400/[0.04] to-[#0a0e16]/95`} style={{ width: shape.w, height: shape.h }}>
      <AiBadge source={shape.source} />
      <div className={`h-1 bg-gradient-to-r ${barColors[priority] ?? barColors.medium} to-transparent`} />
      <div className="p-4">
        <div className="flex flex-wrap gap-2">
          <CardBadge className="border-white/8 bg-white/[0.04] text-slate-300">{status}</CardBadge>
          <CardBadge className={priorityBadge[priority] ?? priorityBadge.medium}>{priority}</CardBadge>
        </div>
        <div className="mt-3 text-base font-semibold leading-snug tracking-tight text-white">{title}</div>
      </div>
    </div>
  )
}

// 8. NoteBlock
export function NoteBlockCard({ shape }: CardProps) {
  const { content = '', color = '#fbbf24' } = shape.props as Record<string, string>
  const safeColor = /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : '#fbbf24'
  return (
    <div
      className={`${cardBase} border-amber-400/15 bg-gradient-to-b from-amber-400/[0.04] to-[#0a0e16]/95 p-4`}
      style={{ width: shape.w, height: shape.h, borderColor: `${safeColor}33` }}
    >
      <AiBadge source={shape.source} />
      <CardBadge className="border-amber-400/20 bg-amber-400/10 text-amber-300" >Note</CardBadge>
      <div className="mt-3 text-sm leading-relaxed text-slate-200 whitespace-pre-wrap">{content}</div>
    </div>
  )
}

// 9. GoalSummary (NEW)
export function GoalSummaryCard({ shape }: CardProps) {
  const p = shape.props as Record<string, unknown>
  const title = String(p.title ?? 'Goal')
  const taskCount = Number(p.taskCount ?? 0)
  const completedCount = Number(p.completedCount ?? 0)
  const failedCount = Number(p.failedCount ?? 0)
  const executingCount = Number(p.executingCount ?? 0)
  const skippedCount = Number(p.skippedCount ?? 0)
  const progress = taskCount > 0 ? Math.round((completedCount / taskCount) * 100) : 0
  return (
    <div className={`${cardBase} border-cyan-400/20 bg-gradient-to-b from-cyan-400/[0.08] to-[#0a0e16]/95 p-5`} style={{ width: shape.w, height: shape.h }}>
      <AiBadge source={shape.source} />
      <div className="flex h-full flex-col justify-between">
        <div>
          <CardBadge className="border-cyan-400/20 bg-cyan-400/10 text-cyan-300">Goal</CardBadge>
          <div className="mt-3 text-lg font-bold tracking-tight text-white">{title}</div>
        </div>
        <div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <span className="text-slate-400">Tasks: <span className="font-semibold text-white">{taskCount}</span></span>
            {executingCount > 0 && <span className="text-emerald-400">Running: {executingCount}</span>}
            {failedCount > 0 && <span className="text-red-400">Failed: {failedCount}</span>}
            {skippedCount > 0 && <span className="text-slate-500">Skipped: {skippedCount}</span>}
            <span className="text-cyan-400">Done: {completedCount}</span>
          </div>
          <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-sky-400 transition-all duration-500" style={{ width: `${progress}%` }} />
          </div>
          <div className="mt-1 text-right text-[10px] font-semibold text-cyan-400/80">{progress}%</div>
        </div>
      </div>
    </div>
  )
}

// 10. ErrorCard (NEW)
export function ErrorCardComponent({ shape }: CardProps) {
  const [expanded, setExpanded] = useState(false)
  const { message = 'Error', stack = '', severity = 'error' } = shape.props as Record<string, string>
  const isWarning = severity === 'warning'
  const cardCls = isWarning
    ? 'border-amber-400/15 bg-gradient-to-b from-amber-400/[0.06] to-[#0a0e16]/95'
    : 'border-red-400/15 bg-gradient-to-b from-red-400/[0.06] to-[#0a0e16]/95'
  const badgeCls = isWarning
    ? 'border-amber-400/20 bg-amber-400/10 text-amber-300'
    : 'border-red-400/20 bg-red-400/10 text-red-300'
  return (
    <div className={`${cardBase} ${cardCls}`} style={{ width: shape.w, height: shape.h }}>
      <AiBadge source={shape.source} />
      <div className="p-4">
        <CardBadge className={badgeCls}>
          {isWarning ? 'Warning' : 'Error'}
        </CardBadge>
        <div className="mt-3 text-sm font-semibold leading-snug text-red-200">{message}</div>
        {stack && (
          <>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
              className="mt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-300 transition-colors"
            >
              {expanded ? 'Hide' : 'Show'} Stack Trace
            </button>
            {expanded && (
              <pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-black/30 border border-white/[0.04] p-2.5 font-mono text-[10px] leading-relaxed text-slate-400">
                {stack}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// 11. TestResult (NEW)
export function TestResultCard({ shape }: CardProps) {
  const p = shape.props as Record<string, unknown>
  const passed = Number(p.passed ?? 0)
  const failed = Number(p.failed ?? 0)
  const skipped = Number(p.skipped ?? 0)
  const coverage = Number(p.coverage ?? 0)
  const failedTests = Array.isArray(p.failedTests) ? p.failedTests.map(String) : []
  const total = passed + failed + skipped
  const allPassed = failed === 0 && total > 0
  return (
    <div className={`${cardBase} ${allPassed ? 'border-emerald-400/15 bg-gradient-to-b from-emerald-400/[0.06]' : 'border-red-400/15 bg-gradient-to-b from-red-400/[0.06]'} to-[#0a0e16]/95 p-4`} style={{ width: shape.w, height: shape.h }}>
      <AiBadge source={shape.source} />
      <CardBadge className={allPassed ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300' : 'border-red-400/20 bg-red-400/10 text-red-300'}>
        {allPassed ? 'Tests Passed' : 'Tests Failed'}
      </CardBadge>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg bg-emerald-400/[0.06] border border-emerald-400/10 px-2.5 py-2 text-center">
          <div className="text-lg font-bold text-emerald-300">{passed}</div>
          <div className="text-emerald-400/60 text-[10px] font-semibold uppercase">Passed</div>
        </div>
        <div className="rounded-lg bg-red-400/[0.06] border border-red-400/10 px-2.5 py-2 text-center">
          <div className="text-lg font-bold text-red-300">{failed}</div>
          <div className="text-red-400/60 text-[10px] font-semibold uppercase">Failed</div>
        </div>
      </div>
      {coverage > 0 && (
        <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
          <span>Coverage</span>
          <span className="font-semibold text-white">{coverage}%</span>
        </div>
      )}
      {failedTests.length > 0 && (
        <div className="mt-2 max-h-16 overflow-auto text-[10px] text-red-300/80">
          {failedTests.map((t, i) => <div key={i} className="truncate">• {t}</div>)}
        </div>
      )}
    </div>
  )
}

// 12. LinkCard (NEW)
export function LinkCardComponent({ shape }: CardProps) {
  const { url = '', title = 'Link', description = '' } = shape.props as Record<string, string>
  return (
    <div className={`${cardBase} border-blue-400/15 bg-gradient-to-b from-blue-400/[0.04] to-[#0a0e16]/95 p-4`} style={{ width: shape.w, height: shape.h }}>
      <AiBadge source={shape.source} />
      <div className="flex h-full flex-col justify-between">
        <div>
          <CardBadge className="border-blue-400/20 bg-blue-400/10 text-blue-300">Link</CardBadge>
          <div className="mt-3 text-sm font-semibold tracking-tight text-white">{title}</div>
          {description && <div className="mt-1.5 text-xs leading-relaxed text-slate-400 line-clamp-2">{description}</div>}
        </div>
        <div className="mt-2 truncate text-[11px] text-blue-400/70 font-mono">{url}</div>
      </div>
    </div>
  )
}

// 13. MetricCard (NEW)
export function MetricCardComponent({ shape }: CardProps) {
  const p = shape.props as Record<string, unknown>
  const label = String(p.label ?? 'Metric')
  const value = p.value != null ? Number(p.value) : 0
  const unit = String(p.unit ?? '')
  const trend = String(p.trend ?? '')
  const trendIcons: Record<string, string> = { up: '\u2191', down: '\u2193' }
  const trendColors: Record<string, string> = { up: 'text-emerald-400', down: 'text-red-400' }
  const trendIcon = trendIcons[trend] ?? ''
  const trendColor = trendColors[trend] ?? 'text-slate-500'
  return (
    <div className={`${cardBase} border-purple-400/15 bg-gradient-to-b from-purple-400/[0.04] to-[#0a0e16]/95 p-4`} style={{ width: shape.w, height: shape.h }}>
      <AiBadge source={shape.source} />
      <div className="flex h-full flex-col justify-between">
        <CardBadge className="border-purple-400/20 bg-purple-400/10 text-purple-300">Metric</CardBadge>
        <div className="text-center">
          <div className="flex items-baseline justify-center gap-1.5">
            <span className="text-3xl font-bold tracking-tight text-white">{typeof value === 'number' && !Number.isNaN(value) ? value.toLocaleString() : '—'}</span>
            {unit && <span className="text-sm font-medium text-slate-500">{unit}</span>}
            {trendIcon && <span className={`text-sm font-bold ${trendColor}`}>{trendIcon}</span>}
          </div>
          <div className="mt-1 text-xs font-medium text-slate-500">{label}</div>
        </div>
        <div />
      </div>
    </div>
  )
}


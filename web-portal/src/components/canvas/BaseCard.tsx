import { memo, Suspense } from 'react'
import { Handle, Position, NodeResizer, type NodeProps } from '@xyflow/react'
import { cn } from '@/lib/utils'
import { CARD_RENDERERS } from './card-registry'
import type { CanvasNode } from './canvas-types'

const ACCENT_COLORS: Record<string, string> = {
  'code-block': 'border-sky-400/20',
  'diff-block': 'border-orange-400/20',
  'file-card': 'border-slate-400/20',
  'diagram-node': 'border-violet-400/20',
  'terminal-block': 'border-emerald-400/20',
  'image-block': 'border-pink-400/20',
  'task-card': 'border-blue-400/20',
  'note-block': 'border-amber-400/20',
  'goal-summary': 'border-cyan-400/20',
  'error-card': 'border-red-400/20',
  'test-result': 'border-green-400/20',
  'link-card': 'border-indigo-400/20',
  'metric-card': 'border-teal-400/20',
}

function BaseCardInner({ data, selected }: NodeProps<CanvasNode>) {
  const { cardType, props, source } = data
  const Renderer = CARD_RENDERERS[cardType]
  const accentBorder = ACCENT_COLORS[cardType] ?? 'border-white/10'

  return (
    <>
      <NodeResizer
        isVisible={!!selected}
        minWidth={120}
        minHeight={80}
        lineClassName="!border-accent/40"
        handleClassName="!w-2.5 !h-2.5 !bg-accent/60 !border-accent"
      />
      <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-accent/50 !border-0" />
      <Handle type="source" position={Position.Right} className="!w-2 !h-2 !bg-accent/50 !border-0" />

      <div
        className={cn(
          'rounded-2xl border backdrop-blur-2xl shadow-lg overflow-hidden bg-gradient-to-b from-white/[0.06] to-[#0a0e16]/95',
          accentBorder,
          selected && 'ring-1 ring-accent/40',
        )}
      >
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/5">
          <span className="text-[9px] font-semibold text-text-tertiary uppercase tracking-wide">
            {cardType}
          </span>
          {source === 'agent' && (
            <span className="text-[8px] font-bold text-accent/70 bg-accent/10 px-1.5 py-0.5 rounded-full">
              AI
            </span>
          )}
        </div>
        <div className="px-3 py-2 min-h-[2rem]">
          {Renderer ? (
            <Suspense fallback={<div className="text-[10px] text-text-tertiary">...</div>}>
              <Renderer type={cardType} props={props} />
            </Suspense>
          ) : (
            <div className="text-[10px] text-text-tertiary italic">
              Unknown type: {cardType}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

const BaseCard = memo(BaseCardInner)
export default BaseCard

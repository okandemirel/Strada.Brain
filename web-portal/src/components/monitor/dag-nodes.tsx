import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-text-tertiary',
  executing: 'bg-accent',
  completed: 'bg-success',
  failed: 'bg-error',
  skipped: 'bg-text-tertiary opacity-50',
}

const STATUS_BORDER_COLORS: Record<string, string> = {
  pending: 'border-l-text-tertiary',
  executing: 'border-l-accent animate-pulse',
  completed: 'border-l-success',
  failed: 'border-l-error',
  review_stuck: 'border-l-warning',
}

function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${STATUS_COLORS[status] || 'bg-text-tertiary'}`}
    />
  )
}

type TaskNodeData = {
  label: string
  status: string
  reviewStatus?: string
}

type TaskNodeType = Node<TaskNodeData, 'task'>

export function TaskNode({ data }: NodeProps<TaskNodeType>) {
  const { t } = useTranslation('monitor')
  return (
    <div className="relative">
      <Handle
        type="target"
        position={Position.Top}
        className="!min-h-0 !min-w-0 !h-1.5 !w-1.5 !bg-border !opacity-0"
      />
      <div
        className={cn(
          'min-w-[172px] max-w-[240px] rounded-xl border border-white/10 bg-black/30 px-3 py-2 shadow-[0_10px_24px_rgba(0,0,0,0.14)] border-l-[3px]',
          STATUS_BORDER_COLORS[data.status] || 'border-l-text-tertiary',
          data.status === 'executing' && 'ring-1 ring-accent/20',
        )}
      >
        <div className="flex items-center gap-2">
          <StatusDot status={data.status} />
          <span className="truncate text-xs font-medium text-text">{data.label}</span>
        </div>
        {data.reviewStatus && data.reviewStatus !== 'none' && (
          <div className="mt-1 text-[10px] text-text-secondary">{t('dag.nodeReviewPrefix')}{data.reviewStatus}</div>
        )}
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!min-h-0 !min-w-0 !h-1.5 !w-1.5 !bg-border !opacity-0"
      />
    </div>
  )
}

const REVIEW_COLORS: Record<string, string> = {
  pending: 'bg-text-tertiary',
  in_progress: 'bg-warning',
  spec_review: 'bg-warning',
  quality_review: 'bg-warning',
  review_stuck: 'bg-error',
  approved: 'bg-success',
  rejected: 'bg-error',
}

type ReviewNodeData = {
  label: string
  status: string
  reviewType?: string
}

type ReviewNodeType = Node<ReviewNodeData, 'review'>

export function ReviewNode({ data }: NodeProps<ReviewNodeType>) {
  return (
    <div className="relative">
      <Handle
        type="target"
        position={Position.Top}
        className="!min-h-0 !min-w-0 !h-1.5 !w-1.5 !bg-warning !opacity-0"
      />
      <div className="min-w-[172px] max-w-[240px] rounded-xl border border-warning/40 bg-black/30 px-3 py-2 shadow-[0_10px_24px_rgba(0,0,0,0.14)]">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${REVIEW_COLORS[data.status] || 'bg-warning'}`}
          />
          <span className="truncate text-xs font-medium text-text">{data.label}</span>
        </div>
        {data.reviewType && (
          <div className="mt-1 text-[10px] text-text-secondary">{data.reviewType}</div>
        )}
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!min-h-0 !min-w-0 !h-1.5 !w-1.5 !bg-warning !opacity-0"
      />
    </div>
  )
}

const GATE_COLORS: Record<string, string> = {
  waiting: 'border-warning',
  approved: 'border-success',
  rejected: 'border-error',
}

const GATE_DOT_COLORS: Record<string, string> = {
  waiting: 'bg-warning',
  approved: 'bg-success',
  rejected: 'bg-error',
}

type GateNodeData = {
  label: string
  status: string
}

type GateNodeType = Node<GateNodeData, 'gate'>

export function GateNode({ data }: NodeProps<GateNodeType>) {
  const borderColor = GATE_COLORS[data.status] || 'border-warning'
  const dotColor = GATE_DOT_COLORS[data.status] || 'bg-warning'

  return (
    <div className="relative">
      <Handle
        type="target"
        position={Position.Top}
        className="!min-h-0 !min-w-0 !h-1.5 !w-1.5 !bg-border !opacity-0"
      />
      <div
        className={`min-w-[132px] max-w-[240px] rounded-xl border ${borderColor} bg-black/30 px-3 py-2 text-center shadow-[0_10px_24px_rgba(0,0,0,0.14)]`}
      >
        <div className="flex items-center justify-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${dotColor}`} />
          <span className="text-xs font-semibold text-text">{data.label}</span>
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!min-h-0 !min-w-0 !h-1.5 !w-1.5 !bg-border !opacity-0"
      />
    </div>
  )
}

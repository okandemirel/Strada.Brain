import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-text-tertiary',
  executing: 'bg-accent',
  completed: 'bg-success',
  failed: 'bg-error',
  skipped: 'bg-text-tertiary opacity-50',
}

function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[status] || 'bg-text-tertiary'}`}
    />
  )
}

/* ------------------------------------------------------------------ */
/*  TaskNode                                                           */
/* ------------------------------------------------------------------ */

type TaskNodeData = {
  label: string
  status: string
  reviewStatus?: string
}

type TaskNodeType = Node<TaskNodeData, 'task'>

export function TaskNode({ data }: NodeProps<TaskNodeType>) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 min-w-[160px] shadow-sm">
      <Handle type="target" position={Position.Top} className="!bg-border" />
      <div className="flex items-center gap-2">
        <StatusDot status={data.status} />
        <span className="text-xs font-medium text-text truncate">{data.label}</span>
      </div>
      {data.reviewStatus && data.reviewStatus !== 'none' && (
        <div className="mt-1 text-[10px] text-text-secondary">
          Review: {data.reviewStatus}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-border" />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  ReviewNode                                                         */
/* ------------------------------------------------------------------ */

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
    <div className="rounded-lg border-2 border-warning bg-surface px-3 py-2 min-w-[160px] shadow-sm">
      <Handle type="target" position={Position.Top} className="!bg-warning" />
      <div className="flex items-center gap-2">
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${REVIEW_COLORS[data.status] || 'bg-warning'}`}
        />
        <span className="text-xs font-medium text-text truncate">{data.label}</span>
      </div>
      {data.reviewType && (
        <div className="mt-1 text-[10px] text-text-secondary">{data.reviewType}</div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-warning" />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  GateNode                                                           */
/* ------------------------------------------------------------------ */

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
    <div
      className={`rounded-lg border-2 ${borderColor} bg-surface px-3 py-2 min-w-[120px] shadow-sm text-center`}
    >
      <Handle type="target" position={Position.Top} className="!bg-border" />
      <div className="flex items-center justify-center gap-2">
        <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
        <span className="text-xs font-semibold text-text">{data.label}</span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-border" />
    </div>
  )
}

import { memo } from 'react'
import { getBezierPath, type EdgeProps } from '@xyflow/react'

function GradientBezierEdgeInner({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, data,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition,
  })

  const gradientId = `edge-gradient-${id}`
  const label = data?.label as string | undefined

  return (
    <>
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="rgb(74, 222, 128)" stopOpacity={0.6} />
          <stop offset="100%" stopColor="rgb(56, 189, 248)" stopOpacity={0.6} />
        </linearGradient>
      </defs>
      <path
        id={id}
        d={edgePath}
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth={2}
        className="react-flow__edge-path"
      />
      {label && (
        <foreignObject
          x={labelX - 40}
          y={labelY - 10}
          width={80}
          height={20}
          requiredExtensions="http://www.w3.org/1999/xhtml"
        >
          <div className="text-[9px] text-text-tertiary text-center bg-bg-primary/80 rounded px-1 truncate">
            {label}
          </div>
        </foreignObject>
      )}
    </>
  )
}

const GradientBezierEdge = memo(GradientBezierEdgeInner)
export default GradientBezierEdge

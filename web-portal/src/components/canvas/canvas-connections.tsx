import { useId } from 'react'
import type { CanvasConnection, ResolvedShape } from './canvas-types'

interface CanvasConnectionsProps {
  connections: CanvasConnection[]
  shapes: ResolvedShape[]
}

function getShapeCenter(shape: ResolvedShape): { x: number; y: number } {
  return { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 }
}

function getEdgePoint(shape: ResolvedShape, targetCenter: { x: number; y: number }): { x: number; y: number } {
  const cx = shape.x + shape.w / 2
  const cy = shape.y + shape.h / 2
  const dx = targetCenter.x - cx
  const dy = targetCenter.y - cy

  // Guard: overlapping centers
  if (dx === 0 && dy === 0) return { x: cx, y: cy }

  const angle = Math.atan2(dy, dx)

  // Find intersection with rectangle border
  const hw = shape.w / 2
  const hh = shape.h / 2
  const tanAngle = Math.abs(Math.tan(angle))

  let ix: number, iy: number
  if (tanAngle <= hh / hw) {
    ix = dx > 0 ? hw : -hw
    iy = ix * Math.tan(angle)
  } else {
    iy = dy > 0 ? hh : -hh
    ix = iy / Math.tan(angle)
  }

  return { x: cx + ix, y: cy + iy }
}

export default function CanvasConnections({ connections, shapes }: CanvasConnectionsProps) {
  const gradientId = useId()
  if (connections.length === 0) return null

  const shapeMap = new Map(shapes.map(s => [s.id, s]))

  return (
    <svg className="absolute inset-0 pointer-events-none" style={{ width: '100%', height: '100%', overflow: 'visible' }}>
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="rgba(52,211,153,0.35)" />
          <stop offset="100%" stopColor="rgba(125,211,252,0.35)" />
        </linearGradient>
      </defs>
      {connections.map(conn => {
        const fromShape = shapeMap.get(conn.from)
        const toShape = shapeMap.get(conn.to)
        if (!fromShape || !toShape) return null

        const toCenter = getShapeCenter(toShape)
        const fromCenter = getShapeCenter(fromShape)
        const start = getEdgePoint(fromShape, toCenter)
        const end = getEdgePoint(toShape, fromCenter)

        // Bezier control points
        const dx = end.x - start.x
        const cx1 = start.x + dx * 0.4
        const cy1 = start.y
        const cx2 = end.x - dx * 0.4
        const cy2 = end.y

        return (
          <g key={conn.id}>
            <path
              d={`M ${start.x} ${start.y} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${end.x} ${end.y}`}
              stroke={`url(#${gradientId})`}
              strokeWidth={1.5}
              fill="none"
              strokeDasharray="5 4"
              opacity={0.8}
            />
            <circle cx={end.x} cy={end.y} r={3} fill="rgba(125,211,252,0.4)" />
            {conn.label && (
              <text
                x={(start.x + end.x) / 2}
                y={(start.y + end.y) / 2 - 6}
                textAnchor="middle"
                fill="rgba(148,163,184,0.6)"
                fontSize={10}
                fontWeight={600}
              >
                {conn.label}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

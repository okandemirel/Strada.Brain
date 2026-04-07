import type { ResolvedShape } from './canvas-types'

interface SelectionOverlayProps {
  shape: ResolvedShape
  onResizeStart: (id: string, handle: string, e: React.PointerEvent) => void
}

const HANDLE_SIZE = 8
const handles = ['nw', 'ne', 'sw', 'se'] as const
const handleCursors: Record<string, string> = {
  nw: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  se: 'nwse-resize',
}

export default function SelectionOverlay({ shape, onResizeStart }: SelectionOverlayProps) {
  return (
    <>
      {/* Selection border */}
      <div
        className="absolute pointer-events-none rounded-2xl"
        style={{
          left: shape.x - 2,
          top: shape.y - 2,
          width: shape.w + 4,
          height: shape.h + 4,
          border: '2px solid rgba(56, 189, 248, 0.6)',
          boxShadow: '0 0 12px rgba(56, 189, 248, 0.15)',
        }}
      />
      {/* Resize handles */}
      {handles.map((h) => {
        const isRight = h.includes('e')
        const isBottom = h.includes('s')
        return (
          <div
            key={h}
            className="absolute z-30 rounded-sm border border-sky-400/80 bg-sky-500/60 backdrop-blur-sm hover:bg-sky-400"
            style={{
              left: (isRight ? shape.x + shape.w : shape.x) - HANDLE_SIZE / 2,
              top: (isBottom ? shape.y + shape.h : shape.y) - HANDLE_SIZE / 2,
              width: HANDLE_SIZE,
              height: HANDLE_SIZE,
              cursor: handleCursors[h],
            }}
            onPointerDown={(e) => {
              e.stopPropagation()
              e.preventDefault()
              onResizeStart(shape.id, h, e)
            }}
          />
        )
      })}
    </>
  )
}

/* ── Lasso / marquee selection rectangle ──────────────────────────── */

interface LassoOverlayProps {
  rect: { x: number; y: number; w: number; h: number } | null
}

export function LassoOverlay({ rect }: LassoOverlayProps) {
  if (!rect) return null
  return (
    <div
      className="absolute pointer-events-none rounded border border-sky-400/40 bg-sky-400/[0.06]"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    />
  )
}

import type { ResolvedShape, ViewportState } from './canvas-types'

interface CanvasMinimapProps {
  shapes: ResolvedShape[]
  viewport: ViewportState
  containerWidth: number
  containerHeight: number
}

export default function CanvasMinimap({ shapes, viewport, containerWidth, containerHeight }: CanvasMinimapProps) {
  if (shapes.length === 0) return null

  const MINIMAP_W = 120
  const MINIMAP_H = 80
  const PAD = 40

  // Calculate bounds of all shapes
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of shapes) {
    minX = Math.min(minX, s.x)
    minY = Math.min(minY, s.y)
    maxX = Math.max(maxX, s.x + s.w)
    maxY = Math.max(maxY, s.y + s.h)
  }
  minX -= PAD; minY -= PAD; maxX += PAD; maxY += PAD

  const worldW = maxX - minX || 1
  const worldH = maxY - minY || 1
  const scale = Math.min(MINIMAP_W / worldW, MINIMAP_H / worldH)

  // Viewport rectangle in minimap coordinates
  const vpX = (-viewport.x / viewport.zoom - minX) * scale
  const vpY = (-viewport.y / viewport.zoom - minY) * scale
  const vpW = (containerWidth / viewport.zoom) * scale
  const vpH = (containerHeight / viewport.zoom) * scale

  return (
    <div className="absolute bottom-3 right-3 z-20 overflow-hidden rounded-lg border border-white/8 bg-black/50 backdrop-blur-xl" style={{ width: MINIMAP_W, height: MINIMAP_H }}>
      <svg width={MINIMAP_W} height={MINIMAP_H} className="block">
        {/* Shape dots */}
        {shapes.map(s => {
          const sx = (s.x - minX) * scale
          const sy = (s.y - minY) * scale
          const sw = Math.max(s.w * scale, 3)
          const sh = Math.max(s.h * scale, 2)
          return <rect key={s.id} x={sx} y={sy} width={sw} height={sh} rx={1} fill="rgba(125,211,252,0.3)" />
        })}
        {/* Viewport indicator */}
        <rect x={vpX} y={vpY} width={vpW} height={vpH} rx={2} fill="none" stroke="rgba(125,211,252,0.4)" strokeWidth={1.5} />
      </svg>
    </div>
  )
}

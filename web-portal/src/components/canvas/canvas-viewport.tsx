import { useCallback, useEffect, useRef, type ReactNode } from 'react'

interface CanvasViewportProps {
  x: number
  y: number
  zoom: number
  onPan: (dx: number, dy: number) => void
  onZoom: (nextZoom: number, cx: number, cy: number) => void
  onClick?: () => void
  children: ReactNode
}

const MIN_ZOOM = 0.1
const MAX_ZOOM = 3.0
const ZOOM_SENSITIVITY = 0.001

export default function CanvasViewport({ x, y, zoom, onPan, onZoom, onClick, children }: CanvasViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const isPanning = useRef(false)
  const lastPointer = useRef({ x: 0, y: 0 })

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const delta = -e.deltaY * ZOOM_SENSITIVITY
    const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * (1 + delta)))
    onZoom(nextZoom, cx, cy)
  }, [zoom, onZoom])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  const didPan = useRef(false)

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Only pan on background click (not on cards) or middle mouse
    if (e.button === 1 || (e.button === 0 && (e.target as HTMLElement).dataset.canvasBg !== undefined)) {
      isPanning.current = true
      didPan.current = false
      lastPointer.current = { x: e.clientX, y: e.clientY }
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    }
  }, [])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isPanning.current) return
    const dx = e.clientX - lastPointer.current.x
    const dy = e.clientY - lastPointer.current.y
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) didPan.current = true
    lastPointer.current = { x: e.clientX, y: e.clientY }
    onPan(dx, dy)
  }, [onPan])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const wasPanning = isPanning.current
    isPanning.current = false
    // Fire onClick only on clean background click (no drag)
    if (wasPanning && !didPan.current && (e.target as HTMLElement).dataset.canvasBg !== undefined) {
      onClick?.()
    }
  }, [onClick])

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      data-canvas-bg
      style={{ cursor: 'grab' }}
    >
      {/* Dot grid background */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.12) 1px, transparent 1px)',
          backgroundSize: `${28 * zoom}px ${28 * zoom}px`,
          backgroundPosition: `${x}px ${y}px`,
          opacity: 0.25,
        }}
        data-canvas-bg
      />

      {/* Transformed content layer */}
      <div
        className="absolute origin-top-left"
        style={{
          transform: `translate(${x}px, ${y}px) scale(${zoom})`,
          willChange: 'transform',
        }}
      >
        {children}
      </div>
    </div>
  )
}

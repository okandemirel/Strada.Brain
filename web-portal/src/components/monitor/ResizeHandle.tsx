import { useCallback, useRef, useEffect } from 'react'
import { cn } from '@/lib/utils'

export type ResizeDirection = 'horizontal' | 'vertical'

interface ResizeHandleProps {
  direction: ResizeDirection
  onResize: (delta: number) => void
  onResizeEnd?: () => void
  className?: string
}

/**
 * A draggable resize handle for splitting panels.
 *
 * - `horizontal`: dragging left/right, renders as a thin vertical bar
 * - `vertical`: dragging up/down, renders as a thin horizontal bar
 *
 * Reports pixel delta on every pointer-move and fires onResizeEnd on release.
 */
export default function ResizeHandle({
  direction,
  onResize,
  onResizeEnd,
  className,
}: ResizeHandleProps) {
  const dragging = useRef(false)
  const lastPos = useRef(0)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragging.current = true
      lastPos.current = direction === 'horizontal' ? e.clientX : e.clientY
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    },
    [direction],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return
      const current = direction === 'horizontal' ? e.clientX : e.clientY
      const delta = current - lastPos.current
      if (delta !== 0 && Number.isFinite(delta)) {
        lastPos.current = current
        onResize(delta)
      }
    },
    [direction, onResize],
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return
      dragging.current = false
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
      onResizeEnd?.()
    },
    [onResizeEnd],
  )

  // Prevent text selection globally while dragging
  useEffect(() => {
    const onSelectStart = (e: Event) => {
      if (dragging.current) e.preventDefault()
    }
    document.addEventListener('selectstart', onSelectStart)
    return () => document.removeEventListener('selectstart', onSelectStart)
  }, [])

  const isHorizontal = direction === 'horizontal'

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className={cn(
        'shrink-0 select-none touch-none transition-colors',
        isHorizontal
          ? 'w-1.5 cursor-col-resize hover:bg-accent/30 active:bg-accent/50'
          : 'h-1.5 cursor-row-resize hover:bg-accent/30 active:bg-accent/50',
        className,
      )}
      role="separator"
      aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
    />
  )
}

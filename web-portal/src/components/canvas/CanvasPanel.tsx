import { useCallback, useEffect, useRef, useState } from 'react'
import { DndContext, useDraggable, type DragEndEvent } from '@dnd-kit/core'
import { useCanvasStore, type CanvasShape } from '../../stores/canvas-store'
import { useMonitorStore } from '../../stores/monitor-store'
import { useSessionStore } from '../../stores/session-store'
import { normalizeCanvasIncomingShape } from './canvas-shape-normalizer'
import { CARD_COMPONENTS } from './card-components'
import { getDefaultDimensions, type ResolvedShape } from './canvas-types'
import CanvasViewport from './canvas-viewport'
import CanvasControls from './canvas-controls'
import CanvasMinimap from './canvas-minimap'
import CanvasConnections from './canvas-connections'
import CanvasEmptyState from './canvas-empty-state'
import {
  formatLastSync,
  formatSessionLabel,
  canvasShapeToResolved,
  buildMonitorFallbackShapes,
  buildFallbackConnections,
} from './canvas-helpers'

/* ── Style constants ───────────────────────────────────────────────── */

const toolbarBtnCls =
  'inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-slate-400 transition-colors hover:border-white/20 hover:bg-white/[0.08]'
const toolbarCls =
  'relative overflow-hidden border-b border-white/6 bg-[#0b1018]/92 px-4 py-3 backdrop-blur-2xl'

const SAVE_DEBOUNCE_MS = 5_000

/* ── Draggable card wrapper ────────────────────────────────────────── */

function DraggableCard({ shape, zoom }: { shape: ResolvedShape; zoom: number }) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({ id: shape.id })
  const CardComponent = CARD_COMPONENTS[shape.type]
  if (!CardComponent) return null

  const tx = transform ? transform.x / zoom : 0
  const ty = transform ? transform.y / zoom : 0

  return (
    <div
      ref={setNodeRef}
      className="absolute touch-none"
      style={{
        left: shape.x + tx,
        top: shape.y + ty,
        width: shape.w,
        zIndex: transform ? 50 : 1,
      }}
      {...listeners}
      {...attributes}
    >
      <CardComponent shape={shape} />
    </div>
  )
}

/* ── Main component ────────────────────────────────────────────────── */

export default function CanvasPanel() {
  /* Store selectors */
  const shapes = useCanvasStore((s) => s.shapes)
  const connections = useCanvasStore((s) => s.connections)
  const viewport = useCanvasStore((s) => s.viewport)
  const pendingShapes = useCanvasStore((s) => s.pendingShapes)
  const pendingUpdates = useCanvasStore((s) => s.pendingUpdates)
  const pendingRemovals = useCanvasStore((s) => s.pendingRemovals)
  const pendingViewport = useCanvasStore((s) => s.pendingViewport)
  const pendingLayout = useCanvasStore((s) => s.pendingLayout)
  const isDirty = useCanvasStore((s) => s.isDirty)
  const setShapes = useCanvasStore((s) => s.setShapes)
  const setViewport = useCanvasStore((s) => s.setViewport)
  const addShape = useCanvasStore((s) => s.addShape)
  const updateShape = useCanvasStore((s) => s.updateShape)
  const removeShapes = useCanvasStore((s) => s.removeShapes)
  const setDirty = useCanvasStore((s) => s.setDirty)
  const clearPendingShapes = useCanvasStore((s) => s.clearPendingShapes)
  const clearPendingUpdates = useCanvasStore((s) => s.clearPendingUpdates)
  const clearPendingRemovals = useCanvasStore((s) => s.clearPendingRemovals)
  const clearPendingViewport = useCanvasStore((s) => s.clearPendingViewport)
  const clearPendingLayout = useCanvasStore((s) => s.clearPendingLayout)

  const sessionId = useSessionStore((s) => s.sessionId)
  const tasks = useMonitorStore((s) => s.tasks)
  const dag = useMonitorStore((s) => s.dag)
  const activeRootId = useMonitorStore((s) => s.activeRootId)

  /* Local state */
  const [loading, setLoading] = useState(false)
  const [agentVisualCount, setAgentVisualCount] = useState(0)
  const [lastAgentSyncAt, setLastAgentSyncAt] = useState<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const pendingMutationCount =
    pendingShapes.length + pendingUpdates.length + pendingRemovals.length +
    (pendingViewport ? 1 : 0) + (pendingLayout ? 1 : 0)

  /* ── Apply pending mutations ──────────────────────────────────── */

  useEffect(() => {
    if (pendingMutationCount === 0) return
    let agentAdded = 0

    if (pendingShapes.length > 0) {
      for (const raw of pendingShapes) {
        const normalized = normalizeCanvasIncomingShape(raw)
        if (!normalized) continue
        addShape(canvasShapeToResolved(normalized))
        if (normalized.source === 'agent') agentAdded++
      }
      clearPendingShapes()
    }

    if (pendingUpdates.length > 0) {
      for (const raw of pendingUpdates) {
        const normalized = normalizeCanvasIncomingShape(raw as CanvasShape)
        if (!normalized) continue
        const resolved = canvasShapeToResolved(normalized)
        updateShape(normalized.id, resolved)
        if (normalized.source === 'agent') agentAdded++
      }
      clearPendingUpdates()
    }

    if (pendingRemovals.length > 0) {
      removeShapes(pendingRemovals)
      clearPendingRemovals()
    }

    if (pendingViewport) {
      setViewport({ x: pendingViewport.x, y: pendingViewport.y, zoom: pendingViewport.zoom })
      clearPendingViewport()
    }

    if (pendingLayout) {
      // Read shapes from store to avoid stale closure
      const currentShapes = useCanvasStore.getState().shapes
      if (currentShapes.length > 0 && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect()
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const s of currentShapes) {
          minX = Math.min(minX, s.x); minY = Math.min(minY, s.y)
          maxX = Math.max(maxX, s.x + s.w); maxY = Math.max(maxY, s.y + s.h)
        }
        const PAD = 60
        const worldW = (maxX - minX) + PAD * 2
        const worldH = (maxY - minY) + PAD * 2
        const fitZoom = Math.min(rect.width / worldW, rect.height / worldH, 1.5)
        setViewport({
          x: (rect.width - worldW * fitZoom) / 2 - (minX - PAD) * fitZoom,
          y: (rect.height - worldH * fitZoom) / 2 - (minY - PAD) * fitZoom,
          zoom: fitZoom,
        })
      }
      clearPendingLayout()
    }

    if (agentAdded > 0) {
      setAgentVisualCount((c) => c + agentAdded)
      setLastAgentSyncAt(Date.now())
    }
    setDirty(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMutationCount])

  /* ── Load saved canvas on session change ──────────────────────── */

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    setLoading(true)

    fetch(`/api/canvas/${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return
        if (!data?.canvas?.shapes) return

        try {
          const parsed = JSON.parse(data.canvas.shapes)
          if (parsed && typeof parsed === 'object' && 'store' in parsed) {
            // Migrate tldraw snapshot format
            const store = parsed.store as Record<string, unknown>
            const migrated: ResolvedShape[] = []
            let idx = 0
            for (const entry of Object.values(store)) {
              if (!entry || typeof entry !== 'object') continue
              const e = entry as Record<string, unknown>
              if (e.typeName !== 'shape') continue
              const dims = getDefaultDimensions(String(e.type ?? 'note-block'))
              const props = (e.props as Record<string, unknown>) ?? {}
              migrated.push({
                id: String(e.id ?? `migrated-${idx++}`),
                type: String(e.type ?? 'note-block'),
                x: typeof e.x === 'number' ? e.x : idx * 260,
                y: typeof e.y === 'number' ? e.y : 100,
                w: typeof props.w === 'number' ? props.w : dims.w,
                h: typeof props.h === 'number' ? props.h : dims.h,
                props,
                source: props.source as 'agent' | 'user' | undefined,
              })
            }
            if (migrated.length > 0) setShapes(migrated)
          } else if (Array.isArray(parsed) && parsed.length > 0) {
            setShapes(parsed as ResolvedShape[])
          }
        } catch { /* invalid JSON */ }

        try {
          if (data.canvas.viewport) {
            const vp = JSON.parse(data.canvas.viewport)
            if (vp && typeof vp.x === 'number') setViewport(vp)
          }
        } catch { /* ignore */ }
      })
      .catch(() => { /* network error */ })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  /* ── Auto-save (debounced) ────────────────────────────────────── */

  useEffect(() => {
    if (!isDirty || !sessionId) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      const { shapes: currentShapes, viewport: currentViewport } = useCanvasStore.getState()
      fetch(`/api/canvas/${encodeURIComponent(sessionId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shapes: JSON.stringify(currentShapes), viewport: JSON.stringify(currentViewport) }),
      })
        .then(() => setDirty(false))
        .catch(() => { /* silent */ })
    }, SAVE_DEBOUNCE_MS)
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, sessionId, shapes, viewport])

  /* ── Pan / Zoom handlers ──────────────────────────────────────── */

  const onPan = useCallback((dx: number, dy: number) => {
    setViewport({ x: viewport.x + dx, y: viewport.y + dy, zoom: viewport.zoom })
  }, [viewport, setViewport])

  const onZoom = useCallback((nextZoom: number, cx: number, cy: number) => {
    const ratio = nextZoom / viewport.zoom
    setViewport({ x: cx - (cx - viewport.x) * ratio, y: cy - (cy - viewport.y) * ratio, zoom: nextZoom })
  }, [viewport, setViewport])

  const onZoomIn = useCallback(() => {
    setViewport({ ...viewport, zoom: Math.min(3.0, viewport.zoom * 1.2) })
  }, [viewport, setViewport])

  const onZoomOut = useCallback(() => {
    setViewport({ ...viewport, zoom: Math.max(0.1, viewport.zoom / 1.2) })
  }, [viewport, setViewport])

  const zoomToFit = useCallback(() => {
    if (shapes.length === 0) return
    const el = containerRef.current
    if (!el) return
    const cw = el.clientWidth
    const ch = el.clientHeight - 48
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const s of shapes) {
      minX = Math.min(minX, s.x); minY = Math.min(minY, s.y)
      maxX = Math.max(maxX, s.x + s.w); maxY = Math.max(maxY, s.y + s.h)
    }
    const pad = 60
    const ww = maxX - minX + pad * 2, wh = maxY - minY + pad * 2
    const z = Math.min(1.2, Math.max(0.1, Math.min(cw / ww, ch / wh)))
    setViewport({ x: (cw - ww * z) / 2 - (minX - pad) * z, y: (ch - wh * z) / 2 - (minY - pad) * z, zoom: z })
  }, [shapes, setViewport])

  /* ── Monitor fallback visualize ───────────────────────────────── */

  const handleVisualize = useCallback(() => {
    const fallback = buildMonitorFallbackShapes(activeRootId, dag, tasks)
    if (fallback.length === 0) return
    const shapeIdSet = new Set(fallback.map((s) => s.id))
    setShapes(fallback)
    useCanvasStore.getState().setConnections(buildFallbackConnections(dag, shapeIdSet))
    setAgentVisualCount(fallback.length)
    setLastAgentSyncAt(Date.now())
    setDirty(true)
    requestAnimationFrame(() => zoomToFit())
  }, [activeRootId, dag, tasks, setShapes, setDirty, zoomToFit])

  /* ── Drag end ─────────────────────────────────────────────────── */

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, delta } = event
    if (!delta) return
    const id = String(active.id)
    const shape = shapes.find((s) => s.id === id)
    if (!shape) return
    updateShape(id, { x: shape.x + delta.x / viewport.zoom, y: shape.y + delta.y / viewport.zoom })
    setDirty(true)
  }, [shapes, viewport.zoom, updateShape, setDirty])

  /* ── Render ───────────────────────────────────────────────────── */

  const cw = containerRef.current?.clientWidth ?? 800
  const ch = containerRef.current?.clientHeight ?? 600

  return (
    <div ref={containerRef} className="relative flex h-full w-full flex-col bg-[#060a10]">
      {/* Toolbar header */}
      <div className={toolbarCls}>
        <div className="flex items-center gap-3">
          <span className={toolbarBtnCls}>
            <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]" />
            CANVAS
          </span>
          <span className="text-[10px] font-medium text-slate-600">{formatSessionLabel(sessionId)}</span>
          <div className="flex-1" />
          {agentVisualCount > 0 && <span className={toolbarBtnCls}>Agent visuals {agentVisualCount}</span>}
          <span className={toolbarBtnCls}>Agent sync {formatLastSync(lastAgentSyncAt)}</span>
          {pendingMutationCount > 0 && <span className={toolbarBtnCls}>Queue {pendingMutationCount}</span>}
        </div>
      </div>

      {/* Canvas area */}
      <div className="relative flex-1 overflow-hidden">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-slate-500">
              <div className="h-4 w-4 rounded-full border-2 border-sky-400/30 border-t-sky-400 animate-spin" />
              Loading canvas...
            </div>
          </div>
        ) : shapes.length === 0 ? (
          <CanvasEmptyState onVisualize={handleVisualize} />
        ) : (
          <DndContext onDragEnd={handleDragEnd}>
            <CanvasViewport x={viewport.x} y={viewport.y} zoom={viewport.zoom} onPan={onPan} onZoom={onZoom}>
              <CanvasConnections connections={connections} shapes={shapes} />
              {shapes.map((shape) => (
                <DraggableCard key={shape.id} shape={shape} zoom={viewport.zoom} />
              ))}
            </CanvasViewport>
          </DndContext>
        )}

        <CanvasControls zoom={viewport.zoom} onZoomIn={onZoomIn} onZoomOut={onZoomOut} onZoomFit={zoomToFit} />
        {shapes.length > 0 && (
          <CanvasMinimap shapes={shapes} viewport={viewport} containerWidth={cw} containerHeight={ch} />
        )}
      </div>
    </div>
  )
}

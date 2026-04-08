import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DndContext, useDraggable, type DragEndEvent } from '@dnd-kit/core'
import { useCanvasStore, isValidResolvedShape, type CanvasShape } from '../../stores/canvas-store'
import { useMonitorStore } from '../../stores/monitor-store'
import { useSessionStore } from '../../stores/session-store'
import { normalizeCanvasIncomingShape } from './canvas-shape-normalizer'
import { CARD_COMPONENTS } from './card-components'
import { getDefaultDimensions, type ResolvedShape } from './canvas-types'
import CanvasViewport from './canvas-viewport'
import CanvasControls from './canvas-controls'
import CanvasMinimap from './canvas-minimap'
import CanvasConnections, { TempConnection } from './canvas-connections'
import CanvasEmptyState from './canvas-empty-state'
import CanvasToolbar from './canvas-toolbar'
import CanvasContextMenu from './canvas-context-menu'
import SelectionOverlay, { LassoOverlay } from './selection-overlay'
import EditableCard from './editable-card'
import {
  formatLastSync,
  formatSessionLabel,
  canvasShapeToResolved,
  buildMonitorFallbackShapes,
  buildFallbackConnections,
  snapToGrid,
} from './canvas-helpers'

/* ── Style constants ───────────────────────────────────────────────── */

const toolbarBtnCls =
  'inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-slate-400 transition-colors hover:border-white/20 hover:bg-white/[0.08]'
const toolbarCls =
  'relative overflow-hidden border-b border-white/6 bg-[#0b1018]/92 px-4 py-3 backdrop-blur-2xl'

const SAVE_DEBOUNCE_MS = 5_000
const MIN_SHAPE_SIZE = 120

/* ── Draggable card wrapper ────────────────────────────────────────── */

interface DraggableCardProps {
  shape: ResolvedShape
  zoom: number
  isSelected: boolean
  isConnecting: boolean
  onSelect: (id: string, multi: boolean) => void
  onDoubleClick: (id: string) => void
  onContextMenu: (id: string, e: React.MouseEvent) => void
  onConnectTarget: (id: string) => void
}

function DraggableCard({
  shape,
  zoom,
  isSelected,
  isConnecting,
  onSelect,
  onDoubleClick,
  onContextMenu,
  onConnectTarget,
}: DraggableCardProps) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({ id: shape.id })
  const CardComponent = CARD_COMPONENTS[shape.type]
  if (!CardComponent) return null

  const tx = transform ? transform.x / zoom : 0
  const ty = transform ? transform.y / zoom : 0

  return (
    <div
      ref={setNodeRef}
      className={`absolute touch-none ${isConnecting ? 'cursor-crosshair' : ''}`}
      style={{
        left: shape.x + tx,
        top: shape.y + ty,
        width: shape.w,
        height: shape.h,
        zIndex: transform ? 50 : isSelected ? 10 : 1,
      }}
      {...listeners}
      {...attributes}
      onClick={(e) => {
        e.stopPropagation()
        if (isConnecting) {
          onConnectTarget(shape.id)
        } else {
          onSelect(shape.id, e.shiftKey)
        }
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onDoubleClick(shape.id)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onContextMenu(shape.id, e)
      }}
    >
      <CardComponent shape={shape} />
    </div>
  )
}

/* ── Main component ────────────────────────────────────────────────── */

export default function CanvasPanel() {
  const { t } = useTranslation('canvas')
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
  const selectedIds = useCanvasStore((s) => s.selectedIds)
  const editingShapeId = useCanvasStore((s) => s.editingShapeId)
  const connectingFromId = useCanvasStore((s) => s.connectingFromId)
  const gridSnap = useCanvasStore((s) => s.gridSnap)

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
  const selectShape = useCanvasStore((s) => s.selectShape)
  const deselectAll = useCanvasStore((s) => s.deselectAll)
  const selectAll = useCanvasStore((s) => s.selectAll)
  const setEditingShape = useCanvasStore((s) => s.setEditingShape)
  const startConnecting = useCanvasStore((s) => s.startConnecting)
  const finishConnecting = useCanvasStore((s) => s.finishConnecting)
  const cancelConnecting = useCanvasStore((s) => s.cancelConnecting)
  const pushUndo = useCanvasStore((s) => s.pushUndo)
  const undo = useCanvasStore((s) => s.undo)
  const redo = useCanvasStore((s) => s.redo)
  const deleteSelected = useCanvasStore((s) => s.deleteSelected)
  const duplicateSelected = useCanvasStore((s) => s.duplicateSelected)
  const bringToFront = useCanvasStore((s) => s.bringToFront)
  const sendToBack = useCanvasStore((s) => s.sendToBack)

  const sessionId = useSessionStore((s) => s.sessionId)
  const tasks = useMonitorStore((s) => s.tasks)
  const dag = useMonitorStore((s) => s.dag)
  const activeRootId = useMonitorStore((s) => s.activeRootId)

  /* Local state */
  const [loading, setLoading] = useState(false)
  const [agentVisualCount, setAgentVisualCount] = useState(0)
  const [lastAgentSyncAt, setLastAgentSyncAt] = useState<number | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; shapeId: string | null } | null>(null)
  const [mouseWorldPos, setMouseWorldPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [lassoRect, setLassoRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [resizing, setResizing] = useState<{ id: string; handle: string; startX: number; startY: number; origShape: ResolvedShape } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lassoStartRef = useRef<{ x: number; y: number } | null>(null)

  const pendingMutationCount =
    pendingShapes.length + pendingUpdates.length + pendingRemovals.length +
    (pendingViewport ? 1 : 0) + (pendingLayout ? 1 : 0)

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  /* ── Viewport center (for toolbar add) ───────────────────────── */

  const getViewportCenter = useCallback((): { x: number; y: number } => {
    const el = containerRef.current
    if (!el) return { x: 400, y: 300 }
    const rect = el.getBoundingClientRect()
    return {
      x: (rect.width / 2 - viewport.x) / viewport.zoom,
      y: (rect.height / 2 - viewport.y) / viewport.zoom,
    }
  }, [viewport])

  /* ── Apply pending mutations ──────────────────────────────────── */

  useEffect(() => {
    if (pendingMutationCount === 0) return
    let agentAdded = 0

    if (pendingShapes.length > 0) {
      let placementIdx = shapes.length
      for (const raw of pendingShapes) {
        const normalized = normalizeCanvasIncomingShape(raw)
        if (!normalized) continue
        addShape(canvasShapeToResolved(normalized, placementIdx))
        placementIdx++
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
            const validated = parsed.filter(isValidResolvedShape)
            if (validated.length > 0) setShapes(validated)
          }
        } catch { /* invalid JSON */ }

        try {
          if (data.canvas.viewport) {
            const vp = JSON.parse(data.canvas.viewport)
            if (vp && typeof vp.x === 'number' && Number.isFinite(vp.x) &&
                typeof vp.y === 'number' && Number.isFinite(vp.y) &&
                typeof vp.zoom === 'number' && Number.isFinite(vp.zoom) && vp.zoom > 0) {
              setViewport({ x: vp.x, y: vp.y, zoom: vp.zoom })
            }
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
    pushUndo()
    let nx = shape.x + delta.x / viewport.zoom
    let ny = shape.y + delta.y / viewport.zoom
    if (gridSnap) {
      const snapped = snapToGrid(nx, ny)
      nx = snapped.x
      ny = snapped.y
    }
    updateShape(id, { x: nx, y: ny })
    setDirty(true)
  }, [shapes, viewport.zoom, updateShape, setDirty, pushUndo, gridSnap])

  /* ── Selection handlers ──────────────────────────────────────── */

  const handleDoubleClick = useCallback((id: string) => {
    pushUndo()
    setEditingShape(id)
  }, [setEditingShape, pushUndo])

  const handleBackgroundClick = useCallback(() => {
    if (connectingFromId) {
      cancelConnecting()
    } else {
      deselectAll()
    }
    setContextMenu(null)
  }, [connectingFromId, cancelConnecting, deselectAll])

  /* ── Context menu ────────────────────────────────────────────── */

  const handleCardContextMenu = useCallback((id: string, e: React.MouseEvent) => {
    selectShape(id)
    setContextMenu({ x: e.clientX, y: e.clientY, shapeId: id })
  }, [selectShape])

  const handleBgContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, shapeId: null })
  }, [])

  const getContextMenuActions = useCallback(() => {
    if (!contextMenu) return []
    const { shapeId } = contextMenu

    if (shapeId) {
      return [
        { label: t('contextMenu.edit'), icon: '\u270E', action: () => { pushUndo(); setEditingShape(shapeId) } },
        { label: t('contextMenu.duplicate'), icon: '\u2398', action: () => { pushUndo(); duplicateSelected() } },
        { label: t('contextMenu.connectTo'), icon: '\u2192', action: () => startConnecting(shapeId) },
        { label: t('contextMenu.bringToFront'), icon: '\u2191', action: () => bringToFront(shapeId), divider: true },
        { label: t('contextMenu.sendToBack'), icon: '\u2193', action: () => sendToBack(shapeId) },
        { label: t('contextMenu.delete'), icon: '\u2717', action: () => { pushUndo(); deleteSelected() }, danger: true, divider: true },
      ]
    }

    // Background context menu -- compute world position
    const el = containerRef.current
    const rect = el?.getBoundingClientRect()
    const worldX = rect ? (contextMenu.x - rect.left - viewport.x) / viewport.zoom : 0
    const worldY = rect ? (contextMenu.y - rect.top - viewport.y) / viewport.zoom : 0

    return [
      {
        label: t('contextMenu.addNoteHere'), icon: 'M',
        action: () => {
          pushUndo()
          const dims = getDefaultDimensions('note-block')
          addShape({
            id: `user-note-block-${Date.now()}`, type: 'note-block',
            x: worldX - dims.w / 2, y: worldY - dims.h / 2,
            w: dims.w, h: dims.h, props: { content: '', color: '#fbbf24' }, source: 'user',
          })
          setDirty(true)
        },
      },
      {
        label: t('contextMenu.addCodeHere'), icon: '<>',
        action: () => {
          pushUndo()
          const dims = getDefaultDimensions('code-block')
          addShape({
            id: `user-code-block-${Date.now()}`, type: 'code-block',
            x: worldX - dims.w / 2, y: worldY - dims.h / 2,
            w: dims.w, h: dims.h, props: { code: '', language: 'text', title: '' }, source: 'user',
          })
          setDirty(true)
        },
      },
      { label: t('contextMenu.selectAll'), icon: '\u2610', action: selectAll, divider: true },
    ]
  }, [contextMenu, t, pushUndo, setEditingShape, duplicateSelected, startConnecting, bringToFront, sendToBack, deleteSelected, addShape, setDirty, selectAll, viewport])

  /* ── Connection target click ─────────────────────────────────── */

  const handleConnectTarget = useCallback((toId: string) => {
    if (!connectingFromId) return
    pushUndo()
    finishConnecting(toId)
    setDirty(true)
  }, [connectingFromId, pushUndo, finishConnecting, setDirty])

  /* ── Inline editing save ─────────────────────────────────────── */

  const handleEditSave = useCallback((id: string, props: Record<string, unknown>) => {
    updateShape(id, { props })
    setEditingShape(null)
    setDirty(true)
  }, [updateShape, setEditingShape, setDirty])

  const handleEditCancel = useCallback(() => {
    setEditingShape(null)
  }, [setEditingShape])

  /* ── Resize handlers ─────────────────────────────────────────── */

  const handleResizeStart = useCallback((id: string, handle: string, e: React.PointerEvent) => {
    const shape = shapes.find((s) => s.id === id)
    if (!shape) return
    pushUndo()
    setResizing({ id, handle, startX: e.clientX, startY: e.clientY, origShape: { ...shape } })
  }, [shapes, pushUndo])

  useEffect(() => {
    if (!resizing) return
    function handleMove(e: PointerEvent): void {
      const dx = (e.clientX - resizing!.startX) / viewport.zoom
      const dy = (e.clientY - resizing!.startY) / viewport.zoom
      const { origShape, handle } = resizing!

      let nx = origShape.x, ny = origShape.y
      let nw = origShape.w, nh = origShape.h

      if (handle.includes('e')) nw = Math.max(MIN_SHAPE_SIZE, origShape.w + dx)
      if (handle.includes('s')) nh = Math.max(80, origShape.h + dy)
      if (handle.includes('w')) {
        const delta = Math.min(dx, origShape.w - MIN_SHAPE_SIZE)
        nx = origShape.x + delta
        nw = origShape.w - delta
      }
      if (handle.includes('n')) {
        const delta = Math.min(dy, origShape.h - 80)
        ny = origShape.y + delta
        nh = origShape.h - delta
      }

      if (gridSnap) {
        const snapped = snapToGrid(nx, ny)
        nx = snapped.x
        ny = snapped.y
      }

      updateShape(resizing!.id, { x: nx, y: ny, w: nw, h: nh })
    }
    function handleUp(): void {
      setResizing(null)
      setDirty(true)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
  }, [resizing, viewport.zoom, updateShape, setDirty, gridSnap])

  /* ── Mouse tracking for temp connection line ─────────────────── */

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!connectingFromId) return
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    setMouseWorldPos({
      x: (e.clientX - rect.left - viewport.x) / viewport.zoom,
      y: (e.clientY - rect.top - viewport.y) / viewport.zoom,
    })
  }, [connectingFromId, viewport])

  /* ── Lasso select ────────────────────────────────────────────── */

  const handleLassoStart = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 || connectingFromId) return
    const target = e.target as HTMLElement
    if (target.dataset.canvasBg === undefined) return
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    lassoStartRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }, [connectingFromId])

  const handleLassoMove = useCallback((e: React.PointerEvent) => {
    if (!lassoStartRef.current) return
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const x = Math.min(lassoStartRef.current.x, cx)
    const y = Math.min(lassoStartRef.current.y, cy)
    const w = Math.abs(cx - lassoStartRef.current.x)
    const h = Math.abs(cy - lassoStartRef.current.y)
    if (w > 5 || h > 5) setLassoRect({ x, y, w, h })
  }, [])

  const handleLassoEnd = useCallback(() => {
    if (lassoRect && lassoRect.w > 5 && lassoRect.h > 5) {
      const worldX = (lassoRect.x - viewport.x) / viewport.zoom
      const worldY = (lassoRect.y - viewport.y) / viewport.zoom
      const worldW = lassoRect.w / viewport.zoom
      const worldH = lassoRect.h / viewport.zoom

      const selected = shapes.filter((s) => {
        const cx = s.x + s.w / 2
        const cy = s.y + s.h / 2
        return cx >= worldX && cx <= worldX + worldW && cy >= worldY && cy <= worldY + worldH
      })
      for (const s of selected) selectShape(s.id, true)
    }
    lassoStartRef.current = null
    setLassoRect(null)
  }, [lassoRect, viewport, shapes, selectShape])

  /* ── Keyboard shortcuts ──────────────────────────────────────── */

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (editingShapeId) return
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return

      const isCmd = e.metaKey || e.ctrlKey

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length > 0) {
        e.preventDefault()
        pushUndo()
        deleteSelected()
        return
      }
      if (e.key === 'z' && isCmd && !e.shiftKey) {
        e.preventDefault()
        undo()
        return
      }
      if ((e.key === 'z' && isCmd && e.shiftKey) || (e.key === 'y' && isCmd)) {
        e.preventDefault()
        redo()
        return
      }
      if (e.key === 'a' && isCmd) {
        e.preventDefault()
        selectAll()
        return
      }
      if (e.key === 'd' && isCmd) {
        e.preventDefault()
        if (selectedIds.length > 0) {
          pushUndo()
          duplicateSelected()
        }
        return
      }
      if (e.key === 'Escape') {
        if (connectingFromId) cancelConnecting()
        else deselectAll()
        setContextMenu(null)
        return
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [editingShapeId, selectedIds, pushUndo, deleteSelected, undo, redo, selectAll, duplicateSelected, connectingFromId, cancelConnecting, deselectAll])

  /* ── Render ───────────────────────────────────────────────────── */

  const cw = containerRef.current?.clientWidth ?? 800
  const ch = containerRef.current?.clientHeight ?? 600
  const connectingFromShape = connectingFromId ? shapes.find((s) => s.id === connectingFromId) : null
  const editingShape = editingShapeId ? shapes.find((s) => s.id === editingShapeId) : null

  return (
    <div
      ref={containerRef}
      className="relative flex h-full w-full flex-col bg-[#060a10]"
      onMouseMove={handleMouseMove}
    >
      {/* Toolbar header */}
      <div className={toolbarCls}>
        <div className="flex items-center gap-3">
          <span className={toolbarBtnCls}>
            <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]" />
            {t('panel.title')}
          </span>
          <span className="text-[10px] font-medium text-slate-600">{formatSessionLabel(sessionId)}</span>

          {/* Card add toolbar */}
          {shapes.length > 0 && <CanvasToolbar viewportCenter={getViewportCenter()} />}

          <div className="flex-1" />
          {agentVisualCount > 0 && <span className={toolbarBtnCls}>{t('panel.agentVisuals', { count: agentVisualCount })}</span>}
          <span className={toolbarBtnCls}>{t('panel.agentSync', { time: formatLastSync(lastAgentSyncAt) })}</span>
          {pendingMutationCount > 0 && <span className={toolbarBtnCls}>{t('panel.queue', { count: pendingMutationCount })}</span>}
          {selectedIds.length > 0 && (
            <span className={toolbarBtnCls}>
              {t('panel.selected', { count: selectedIds.length })}
            </span>
          )}
        </div>
      </div>

      {/* Canvas area */}
      <div
        className="relative flex-1 overflow-hidden"
        onPointerDown={handleLassoStart}
        onPointerMove={handleLassoMove}
        onPointerUp={handleLassoEnd}
        onContextMenu={handleBgContextMenu}
      >
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-slate-500">
              <div className="h-4 w-4 rounded-full border-2 border-sky-400/30 border-t-sky-400 animate-spin" />
              {t('panel.loading')}
            </div>
          </div>
        ) : shapes.length === 0 ? (
          <CanvasEmptyState onVisualize={handleVisualize} />
        ) : (
          <DndContext onDragEnd={handleDragEnd}>
            <CanvasViewport
              x={viewport.x}
              y={viewport.y}
              zoom={viewport.zoom}
              onPan={onPan}
              onZoom={onZoom}
              onClick={handleBackgroundClick}
            >
              <CanvasConnections connections={connections} shapes={shapes} />
              {connectingFromShape && (
                <TempConnection fromShape={connectingFromShape} mousePos={mouseWorldPos} />
              )}
              {shapes.map((shape) => (
                editingShapeId === shape.id ? null : (
                  <DraggableCard
                    key={shape.id}
                    shape={shape}
                    zoom={viewport.zoom}
                    isSelected={selectedSet.has(shape.id)}
                    isConnecting={!!connectingFromId}
                    onSelect={selectShape}
                    onDoubleClick={handleDoubleClick}
                    onContextMenu={handleCardContextMenu}
                    onConnectTarget={handleConnectTarget}
                  />
                )
              ))}
              {/* Selection overlays */}
              {selectedIds.map((id) => {
                const shape = shapes.find((s) => s.id === id)
                if (!shape || editingShapeId === id) return null
                return <SelectionOverlay key={`sel-${id}`} shape={shape} onResizeStart={handleResizeStart} />
              })}
              {/* Editing card */}
              {editingShape && (
                <EditableCard shape={editingShape} onSave={handleEditSave} onCancel={handleEditCancel} />
              )}
            </CanvasViewport>
            {/* Lasso overlay (screen space) */}
            <LassoOverlay rect={lassoRect} />
          </DndContext>
        )}

        <CanvasControls zoom={viewport.zoom} onZoomIn={onZoomIn} onZoomOut={onZoomOut} onZoomFit={zoomToFit} />
        {shapes.length > 0 && (
          <CanvasMinimap shapes={shapes} viewport={viewport} containerWidth={cw} containerHeight={ch} />
        )}
      </div>

      {/* Context menu */}
      <CanvasContextMenu
        position={contextMenu}
        actions={getContextMenuActions()}
        onClose={() => setContextMenu(null)}
      />

      {/* Connecting mode indicator */}
      {connectingFromId && (
        <div className="absolute bottom-14 left-1/2 z-30 -translate-x-1/2 rounded-full border border-sky-400/30 bg-sky-400/10 px-4 py-2 text-xs font-medium text-sky-300 backdrop-blur-xl">
          {t('connecting.hint')} <span className="text-slate-500">ESC {t('connecting.cancel')}</span>
        </div>
      )}
    </div>
  )
}

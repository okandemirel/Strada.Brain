import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  BackgroundVariant,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { useCanvasStore, isValidResolvedShape, type CanvasShape } from '../../stores/canvas-store'
import { useMonitorStore } from '../../stores/monitor-store'
import { useSessionStore } from '../../stores/session-store'
import { normalizeCanvasIncomingShape } from './canvas-shape-normalizer'
import { getDefaultDimensions, type ResolvedShape } from './canvas-types'
import {
  CanvasSaveScheduler,
  canvasSavePayload,
  parseCanvasConnections,
  readCanvasVersion,
  saveCanvasState,
} from './canvas-persistence'
import { useCanvasBridge, shapesToNodes, connectionsToEdges } from '../../hooks/use-canvas-bridge'
import { useCanvasShortcuts } from '../../hooks/use-canvas-shortcuts'
import { useWS } from '../../hooks/useWS'
import {
  applyLayout,
  canvasShapeToResolved,
  buildMonitorFallbackShapes,
  buildFallbackConnections,
} from './layout-engine'
import BaseCard from './BaseCard'
import GradientBezierEdge from './GradientBezierEdge'
import CanvasToolbar from './canvas-toolbar'
import CanvasContextMenu from './canvas-context-menu'
import CanvasEmptyState from './canvas-empty-state'

/* ── Constants ───────────────────────────────────────────────────── */

const SAVE_DEBOUNCE_MS = 5_000

const NODE_TYPES = { baseCard: BaseCard } as const
const EDGE_TYPES = { gradientBezier: GradientBezierEdge } as const

/* ── Inner component (must be inside ReactFlowProvider) ──────────── */

function CanvasWorkspaceInner() {
  const { t } = useTranslation('canvas')
  const { fitView, getViewport, screenToFlowPosition } = useReactFlow()

  /* ── Store selectors ────────────────────────────────────────────── */
  const shapes = useCanvasStore((s) => s.shapes)
  const pendingShapes = useCanvasStore((s) => s.pendingShapes)
  const pendingUpdates = useCanvasStore((s) => s.pendingUpdates)
  const pendingRemovals = useCanvasStore((s) => s.pendingRemovals)
  const pendingViewport = useCanvasStore((s) => s.pendingViewport)
  const pendingLayout = useCanvasStore((s) => s.pendingLayout)
  const layoutMode = useCanvasStore((s) => s.layoutMode)

  const addShape = useCanvasStore((s) => s.addShape)
  const updateShape = useCanvasStore((s) => s.updateShape)
  const removeShapes = useCanvasStore((s) => s.removeShapes)
  const setShapes = useCanvasStore((s) => s.setShapes)
  const setViewport = useCanvasStore((s) => s.setViewport)
  const setDirty = useCanvasStore((s) => s.setDirty)
  const clearPendingShapes = useCanvasStore((s) => s.clearPendingShapes)
  const clearPendingUpdates = useCanvasStore((s) => s.clearPendingUpdates)
  const clearPendingRemovals = useCanvasStore((s) => s.clearPendingRemovals)
  const clearPendingViewport = useCanvasStore((s) => s.clearPendingViewport)
  const clearPendingLayout = useCanvasStore((s) => s.clearPendingLayout)
  const addConnection = useCanvasStore((s) => s.addConnection)
  const setConnections = useCanvasStore((s) => s.setConnections)
  const pushUndo = useCanvasStore((s) => s.pushUndo)

  const sessionId = useSessionStore((s) => s.sessionId)
  const tasks = useMonitorStore((s) => s.tasks)
  const dag = useMonitorStore((s) => s.dag)
  const activeRootId = useMonitorStore((s) => s.activeRootId)

  /* ── Bridge: store <-> ReactFlow ─────────────────────────────── */
  const { nodes, edges, onNodesChange, onEdgesChange } = useCanvasBridge()

  /* ── Keyboard shortcuts ─────────────────────────────────────── */
  useCanvasShortcuts()

  /* ── Local state ─────────────────────────────────────────────── */
  const [loading, setLoading] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const prevShapeIdsRef = useRef(new Set<string>())
  const [saveConflict, setSaveConflict] = useState(false)

  /* ── The one writer for this canvas ──────────────────────────────
     A single scheduler owns the debounce, the outstanding PUT and the
     version the server acknowledged. Two windows, a second edit during a
     save, a connection drawn mid-flight and a session switch are all the
     same problem — who is allowed to write what next — and it is answered
     in one place (round 9 #17-#20). */
  const schedulerRef = useRef<CanvasSaveScheduler | null>(null)
  if (!schedulerRef.current) {
    schedulerRef.current = new CanvasSaveScheduler({
      debounceMs: SAVE_DEBOUNCE_MS,
      readRevision: () => {
        const state = useCanvasStore.getState()
        return canvasSavePayload(state.shapes, state.connections, state.viewport)
      },
      save: (args) => saveCanvasState(args),
      onSaved: ({ upToDate }) => {
        setSaveConflict(false)
        // DIRTY IS CLEARED FOR THE ACKED REVISION ONLY: an edit made while the
        // request was in flight must survive (Codex #25) — and it is already
        // queued for the next write (#18/#19).
        if (upToDate) useCanvasStore.getState().setDirty(false)
      },
      // Someone else wrote this canvas: keep the work dirty and say so.
      onConflict: () => setSaveConflict(true),
    })
  }
  const scheduler = schedulerRef.current

  const { sendRawJSON } = useWS()

  const pendingMutationCount =
    pendingShapes.length + pendingUpdates.length + pendingRemovals.length +
    (pendingViewport ? 1 : 0) + (pendingLayout ? 1 : 0)

  /* ── Apply pending mutations ──────────────────────────────────── */

  useEffect(() => {
    if (pendingMutationCount === 0) return

    if (pendingShapes.length > 0) {
      let placementIdx = useCanvasStore.getState().shapes.length
      for (const raw of pendingShapes) {
        const normalized = normalizeCanvasIncomingShape(raw)
        if (!normalized) continue
        addShape(canvasShapeToResolved(normalized, placementIdx))
        placementIdx++
      }
      clearPendingShapes()
    }

    if (pendingUpdates.length > 0) {
      for (const raw of pendingUpdates) {
        const normalized = normalizeCanvasIncomingShape(raw as CanvasShape)
        if (!normalized) continue
        const resolved = canvasShapeToResolved(normalized)
        updateShape(normalized.id, resolved)
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
      requestAnimationFrame(() => fitView({ padding: 0.15, duration: 300 }))
      clearPendingLayout()
    }

    setDirty(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMutationCount])

  /* ── Apply layout when layoutMode changes ─────────────────────── */

  useEffect(() => {
    if (shapes.length === 0) return
    const currentNodes = shapesToNodes(useCanvasStore.getState().shapes)
    const currentEdges = connectionsToEdges(useCanvasStore.getState().connections)
    const { nodes: layoutedNodes } = applyLayout(currentNodes, currentEdges, layoutMode)
    for (const node of layoutedNodes) {
      updateShape(node.id, { x: node.position.x, y: node.position.y })
    }
    requestAnimationFrame(() => fitView({ padding: 0.15 }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutMode])

  /* ── Load saved canvas on session change ──────────────────────── */

  useEffect(() => {
    // Every response below is answered against THIS generation: a load or an
    // acknowledgement from a session the user has left changes nothing (#20).
    const generation = scheduler.startSession(sessionId ?? null)
    if (!sessionId) return
    let cancelled = false
    setLoading(true)

    fetch(`/api/canvas/${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return
        // A GET that failed says nothing: the version stays unknown.
        if (!data) return
        if (!data.canvas) {
          // No canvas yet. The next save must CREATE, not overwrite whatever a
          // second window has put there in the meantime (#17).
          scheduler.adoptVersion('absent', generation)
          return
        }
        // The version is what the server holds either way; the CONTENT is only
        // applied while it is still the newest thing we know (#20).
        scheduler.adoptVersion(readCanvasVersion(data.canvas), generation)
        if (!scheduler.canApplyContent(generation)) return
        // Connections were drawn and then lost on every reload: they are part
        // of the saved canvas now (2.6 / D33).
        setConnections(parseCanvasConnections(data.canvas.connections))
        if (!data.canvas.shapes) return

        try {
          const parsed = JSON.parse(data.canvas.shapes)
          if (parsed && typeof parsed === 'object' && 'store' in parsed) {
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
      .finally(() => {
        // Read or not, writing this session is allowed from here on: an edit
        // made while the GET was open goes out now (#20).
        scheduler.finishLoad(generation)
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  /* ── Auto-save (debounced) ────────────────────────────────────── */

  // The STORE schedules saves, not a dependency array: a connection drawn
  // while isDirty was already true changed nothing the old effect watched, so
  // it was never saved (#19). Anything that makes the canvas dirty — a shape, a
  // connection, the viewport — schedules the next write here, and the scheduler
  // decides when it may go out.
  useEffect(() => {
    const unsubscribe = useCanvasStore.subscribe((state, prev) => {
      if (!state.isDirty) return
      const becameDirty = !prev.isDirty
      const changed =
        state.shapes !== prev.shapes ||
        state.connections !== prev.connections ||
        state.viewport !== prev.viewport
      if (becameDirty || changed) scheduler.requestSave()
    })
    return () => { unsubscribe(); scheduler.dispose() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── Emit canvas:user_shapes when user adds shapes ───────────── */

  useEffect(() => {
    const currentIds = new Set(shapes.map((s) => s.id))
    const newUserShapes = shapes.filter(
      (s) => s.source === 'user' && !prevShapeIdsRef.current.has(s.id),
    )
    prevShapeIdsRef.current = currentIds

    if (newUserShapes.length === 0) return

    const payload = JSON.stringify(newUserShapes)
    if (payload.length > 256_000) return // drop oversized snapshots
    sendRawJSON({ type: 'canvas:user_shapes', snapshot: payload })
  // sendRawJSON is stable (useCallback) — omitting it avoids spurious re-runs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes])

  /* ── Viewport center computed on demand (no stale closure) ──── */

  const getViewportCenter = useCallback(() => {
    const vp = getViewport()
    const container = document.querySelector('.react-flow')
    const w = container?.clientWidth ?? 800
    const h = container?.clientHeight ?? 600
    return { x: -vp.x / vp.zoom + w / 2, y: -vp.y / vp.zoom + h / 2 }
  }, [getViewport])

  /* ── Connection handler ──────────────────────────────────────── */

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return
    pushUndo()
    addConnection({
      id: `conn-${connection.source}-${connection.target}-${Date.now()}`,
      from: connection.source,
      to: connection.target,
    })
    setDirty(true)
  }, [pushUndo, addConnection, setDirty])

  /* ── Monitor fallback visualize ──────────────────────────────── */

  const handleVisualize = useCallback(() => {
    const fallback = buildMonitorFallbackShapes(activeRootId, dag, tasks)
    if (fallback.length === 0) return
    const shapeIdSet = new Set(fallback.map((s) => s.id))
    setShapes(fallback)
    useCanvasStore.getState().setConnections(buildFallbackConnections(dag, shapeIdSet))
    setDirty(true)
    requestAnimationFrame(() => fitView({ padding: 0.15, duration: 300 }))
  }, [activeRootId, dag, tasks, setShapes, setDirty, fitView])

  /* ── Context menu ────────────────────────────────────────────── */

  const handlePaneContextMenu = useCallback((event: MouseEvent | React.MouseEvent) => {
    event.preventDefault()
    setContextMenu({ x: event.clientX, y: event.clientY })
  }, [])

  const contextMenuActions = useMemo(() => {
    if (!contextMenu) return []
    const worldPos = screenToFlowPosition({ x: contextMenu.x, y: contextMenu.y })
    return [
      {
        label: t('contextMenu.addNoteHere'), icon: 'M',
        action: () => {
          pushUndo()
          const dims = getDefaultDimensions('note-block')
          addShape({
            id: `user-note-block-${Date.now()}`, type: 'note-block',
            x: worldPos.x - dims.w / 2, y: worldPos.y - dims.h / 2,
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
            x: worldPos.x - dims.w / 2, y: worldPos.y - dims.h / 2,
            w: dims.w, h: dims.h, props: { code: '', language: 'text', title: '' }, source: 'user',
          })
          setDirty(true)
        },
      },
    ]
  }, [contextMenu, t, pushUndo, addShape, setDirty, screenToFlowPosition])

  /* ── Render ──────────────────────────────────────────────────── */

  if (loading) {
    return (
      <div className="relative flex h-full w-full items-center justify-center bg-[#060a10]">
        <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-slate-500">
          <div className="h-4 w-4 rounded-full border-2 border-sky-400/30 border-t-sky-400 animate-spin" />
          {t('panel.loading')}
        </div>
      </div>
    )
  }

  if (shapes.length === 0 && !sessionId) {
    return (
      <div className="relative flex h-full w-full flex-col bg-[#060a10]">
        <CanvasEmptyState onVisualize={handleVisualize} />
      </div>
    )
  }

  return (
    <div className="relative flex h-full w-full flex-col bg-[#060a10]">
      {/* A save the server refused: someone else wrote this canvas. The work
          stays dirty, so nothing is lost while the person decides. */}
      {saveConflict && (
        <div className="absolute top-3 left-3 z-20 max-w-sm rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          {t('panel.saveConflict')}
        </div>
      )}

      {/* Floating toolbar */}
      <div className="absolute top-3 left-1/2 z-10 -translate-x-1/2">
        <CanvasToolbar getViewportCenter={getViewportCenter} />
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onPaneContextMenu={handlePaneContextMenu}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        fitView
        minZoom={0.1}
        maxZoom={3}
        proOptions={{ hideAttribution: true }}
        className="[&_.react-flow__renderer]:!bg-transparent"
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={1} color="rgba(255,255,255,0.06)" />
        <Controls
          showInteractive={false}
          className="!bg-black/50 !border-white/10 !backdrop-blur-xl [&>button]:!bg-transparent [&>button]:!border-white/6 [&>button]:!text-slate-400 [&>button:hover]:!bg-white/[0.06]"
        />
        {shapes.length > 0 && <MiniMap
          nodeColor={() => 'rgba(125,211,252,0.3)'}
          maskColor="rgba(0,0,0,0.7)"
          className="!bg-black/60 !border-white/8 !backdrop-blur-xl"
        />}
      </ReactFlow>

      {/* Empty state overlay when no shapes */}
      {shapes.length === 0 && (
        <div className="pointer-events-auto absolute inset-0 z-[5]">
          <CanvasEmptyState onVisualize={handleVisualize} />
        </div>
      )}

      {/* Context menu */}
      <CanvasContextMenu
        position={contextMenu}
        actions={contextMenuActions}
        onClose={() => setContextMenu(null)}
      />
    </div>
  )
}

/* ── Outer wrapper with provider ───────────────────────────────── */

export default function CanvasWorkspace() {
  return (
    <ReactFlowProvider>
      <CanvasWorkspaceInner />
    </ReactFlowProvider>
  )
}

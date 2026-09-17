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
import { getDefaultDimensions, type ResolvedShape, type ViewportState } from './canvas-types'
import {
  CanvasSaveScheduler,
  canvasSavePayload,
  parseCanvasConnections,
  readCanvasVersion,
  replayCanvasEdits,
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

/**
 * A read that failed is retried, because until it succeeds NOTHING may be
 * written: a PUT with no version is an unconditional upsert that destroys the
 * version another window holds (r10 #9). The edits made meanwhile are kept and
 * replayed onto the canvas the successful read returns (#10).
 */
const LOAD_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000] as const

const NODE_TYPES = { baseCard: BaseCard } as const
const EDGE_TYPES = { gradientBezier: GradientBezierEdge } as const

/* ── Reading what the server stored ──────────────────────────────────────── */

/**
 * The shapes a stored canvas holds, or `null` when the payload carries none we
 * can use — which is NOT the same as "the canvas is empty": a row we cannot read
 * must leave the local canvas alone rather than clear it.
 */
function parseStoredShapes(raw: unknown): ResolvedShape[] | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  // The tldraw-era format: a keyed store of records, one per shape.
  if (parsed && typeof parsed === 'object' && 'store' in parsed) {
    const store = (parsed as { store: Record<string, unknown> }).store
    const migrated: ResolvedShape[] = []
    let idx = 0
    for (const entry of Object.values(store ?? {})) {
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
    return migrated.length > 0 ? migrated : null
  }
  if (!Array.isArray(parsed)) return null
  const validated = parsed.filter(isValidResolvedShape)
  return validated.length > 0 ? validated : null
}

/** The stored viewport, or `null` when it is missing or not a viewport. */
function parseStoredViewport(raw: unknown): ViewportState | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    const vp = JSON.parse(raw) as Partial<ViewportState>
    if (typeof vp?.x === 'number' && Number.isFinite(vp.x) &&
        typeof vp.y === 'number' && Number.isFinite(vp.y) &&
        typeof vp.zoom === 'number' && Number.isFinite(vp.zoom) && vp.zoom > 0) {
      return { x: vp.x, y: vp.y, zoom: vp.zoom }
    }
  } catch { /* not a viewport */ }
  return null
}

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
  // A canvas that could not be READ cannot be written to either (#9). The work
  // is kept in this browser, and the person is told — silence here looked
  // exactly like a canvas that was being saved.
  const [loadFailed, setLoadFailed] = useState(false)

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
    if (!sessionId) {
      setLoading(false)
      return
    }
    // The canvas as it is at the moment the read starts. Everything that happens
    // from here until the read lands — a user edit, an agent drawing — is work
    // the read must not discard, and it is `local` minus `base` (#10).
    const opening = useCanvasStore.getState()
    const base = { shapes: opening.shapes, connections: opening.connections }

    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    setLoading(true)

    /** Take what the read returned. `false` = it told us nothing usable. */
    const takeCanvas = (canvas: Record<string, unknown>): boolean => {
      const version = readCanvasVersion(canvas)
      // A row whose version we cannot read cannot be written CONDITIONALLY, and
      // an unconditional write is exactly what must never happen (#9). Treat it
      // as an unread canvas.
      if (version === undefined) return false

      const loadedShapes = parseStoredShapes(canvas.shapes)
      // Connections were drawn and then lost on every reload: they are part of
      // the saved canvas now (2.6 / D33).
      const loadedConnections = parseCanvasConnections(canvas.connections)

      if (scheduler.canApplyContent(generation)) {
        scheduler.adoptVersion(version, generation)
        setConnections(loadedConnections)
        if (loadedShapes) setShapes(loadedShapes)
        const viewport = parseStoredViewport(canvas.viewport)
        if (viewport) setViewport(viewport)
        return true
      }

      if (scheduler.canMergeContent(generation)) {
        // The read lost the race against an edit. Adopting its version while
        // dropping its content made the next save delete the server's canvas
        // (#10): the work done meanwhile is replayed onto what it returned
        // instead, and saved against the version it reported.
        scheduler.adoptVersion(version, generation)
        const current = useCanvasStore.getState()
        const merged = replayCanvasEdits({
          base,
          local: { shapes: current.shapes, connections: current.connections },
          loaded: { shapes: loadedShapes ?? current.shapes, connections: loadedConnections },
        })
        setShapes(merged.shapes)
        setConnections(merged.connections)
        // The viewport is NOT replaced: the view the person is looking at wins.
        setDirty(true)
        return true
      }

      // This window has already written this canvas, so the read is older than
      // what the server holds: neither its content nor its version applies, and
      // our own acknowledged version already authorizes the next write.
      return true
    }

    const attempt = (index: number): void => {
      fetch(`/api/canvas/${encodeURIComponent(sessionId)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`canvas GET ${r.status}`))))
        .then((data: unknown) => {
          if (cancelled) return
          if (!data || typeof data !== 'object') throw new Error('canvas GET: empty body')
          const canvas = (data as { canvas?: unknown }).canvas
          if (!canvas || typeof canvas !== 'object') {
            // No canvas yet. The next save must CREATE, not overwrite whatever a
            // second window has put there in the meantime (#17).
            scheduler.adoptVersion('absent', generation)
          } else if (!takeCanvas(canvas as Record<string, unknown>)) {
            throw new Error('canvas GET: no readable version')
          }
          // The canvas IS read: an edit made while the GET was open goes out now,
          // against the version the read established (#20).
          scheduler.finishLoad(generation)
          setLoadFailed(false)
          setLoading(false)
        })
        .catch(() => {
          if (cancelled) return
          // A read that did not happen says NOTHING about what the server holds.
          // Unblocking writes here turned the next save into an unconditional
          // upsert that destroyed the other window's version (#9). Writes stay
          // blocked; the edits stay pending and are replayed once a read lands.
          scheduler.failLoad(generation)
          // The canvas itself stays usable — work is kept locally, not saved.
          setLoading(false)
          const delay = LOAD_RETRY_DELAYS_MS[index]
          if (delay === undefined) {
            // Out of retries: writes stay blocked, so say so.
            setLoadFailed(true)
            return
          }
          retryTimer = setTimeout(() => {
            retryTimer = null
            attempt(index + 1)
          }, delay)
        })
    }

    attempt(0)

    setLoadFailed(false)

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
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
      {loadFailed && (
        <div className="absolute top-3 left-3 z-20 max-w-sm rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {t('panel.loadFailed')}
        </div>
      )}

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

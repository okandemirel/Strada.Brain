import { useMemo, useCallback } from 'react'
import type { NodeChange, EdgeChange } from '@xyflow/react'
import type { ResolvedShape, CanvasConnection, CanvasNode, CanvasEdge } from '../components/canvas/canvas-types'
import { useCanvasStore } from '../stores/canvas-store'

// ---------------------------------------------------------------------------
// Pure converter functions
// ---------------------------------------------------------------------------

/**
 * Converts a ResolvedShape array to ReactFlow Node array.
 * Filters out connection-arrow shapes, which are represented as edges instead.
 */
export function shapesToNodes(shapes: ResolvedShape[]): CanvasNode[] {
  return shapes
    .filter((shape) => shape.type !== 'connection-arrow')
    .map((shape) => ({
      id: shape.id,
      type: 'baseCard' as const,
      position: { x: shape.x, y: shape.y },
      style: { width: shape.w, height: shape.h },
      data: {
        cardType: shape.type,
        props: shape.props,
        ...(shape.source !== undefined ? { source: shape.source } : {}),
      },
    }))
}

/**
 * Converts a CanvasConnection array to ReactFlow Edge array.
 * Only attaches `data` when a label is present to keep edges lean.
 */
export function connectionsToEdges(connections: CanvasConnection[]): CanvasEdge[] {
  return connections.map((conn) => ({
    id: conn.id,
    source: conn.from,
    target: conn.to,
    type: 'gradientBezier' as const,
    ...(conn.label !== undefined ? { data: { label: conn.label } } : {}),
  }))
}

/**
 * Extracts the store-relevant update from a single ReactFlow NodeChange.
 * Returns null for change types that do not map to store mutations
 * (select, add, replace, remove — remove is handled separately).
 *
 * Position changes are only applied when dragging is complete
 * (`dragging === false` or undefined).
 * Dimension changes are only applied when resizing is complete
 * (`resizing === false` or undefined).
 */
export function nodeChangeToStoreUpdate(
  change: NodeChange,
): { id: string; x: number; y: number } | { id: string; w: number; h: number } | null {
  if (change.type === 'position') {
    if (change.dragging === true) return null
    if (change.position === undefined) return null
    return { id: change.id, x: change.position.x, y: change.position.y }
  }

  if (change.type === 'dimensions') {
    if (change.resizing === true) return null
    if (change.dimensions === undefined) return null
    return { id: change.id, w: change.dimensions.width, h: change.dimensions.height }
  }

  return null
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/**
 * Bridges the Zustand canvas store with ReactFlow's node/edge format.
 *
 * Returns:
 * - `nodes`         — memoised ReactFlow node array derived from store shapes
 * - `edges`         — memoised ReactFlow edge array derived from store connections
 * - `onNodesChange` — stable callback wiring ReactFlow change events back to the store
 * - `onEdgesChange` — stable callback wiring ReactFlow edge change events back to the store
 */
export function useCanvasBridge() {
  const shapes = useCanvasStore((s) => s.shapes)
  const connections = useCanvasStore((s) => s.connections)
  const updateShape = useCanvasStore((s) => s.updateShape)
  const selectShape = useCanvasStore((s) => s.selectShape)
  const removeShapes = useCanvasStore((s) => s.removeShapes)
  const pushUndo = useCanvasStore((s) => s.pushUndo)

  const nodes = useMemo(() => shapesToNodes(shapes), [shapes])
  const edges = useMemo(() => connectionsToEdges(connections), [connections])

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      let undoPushed = false
      for (const change of changes) {
        // Handle select changes (no undo needed)
        if (change.type === 'select') {
          if (change.selected) {
            selectShape(change.id, true)
          } else {
            // Remove specific node from selection without wiping editing/connecting state
            const current = useCanvasStore.getState().selectedIds
            if (current.includes(change.id)) {
              useCanvasStore.setState({ selectedIds: current.filter((sid) => sid !== change.id) })
            }
          }
          continue
        }
        // Push undo once for the entire batch
        if (!undoPushed) {
          pushUndo()
          undoPushed = true
        }
        if (change.type === 'remove') {
          removeShapes([change.id])
          continue
        }
        // Position/dimensions updates
        if (change.type === 'position' && change.dragging === false && change.position) {
          updateShape(change.id, { x: change.position.x, y: change.position.y })
        }
        if (change.type === 'dimensions' && change.resizing === false && change.dimensions) {
          updateShape(change.id, { w: change.dimensions.width, h: change.dimensions.height })
        }
      }
    },
    [pushUndo, updateShape, selectShape, removeShapes],
  )

  const onEdgesChange = useCallback(
    (_changes: EdgeChange[]) => {
      // Edge mutations (remove/select) are currently managed through the store's
      // removeConnections / selectShape actions triggered by explicit UI controls.
      // ReactFlow edge change events are intentionally not forwarded to avoid
      // double-mutations; this callback exists to satisfy the ReactFlow API contract.
    },
    [],
  )

  return { nodes, edges, onNodesChange, onEdgesChange }
}

# Canvas Redevelopment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the custom canvas engine with ReactFlow, adding dagre layout, extensible card system, bidirectional agent communication, and accessibility.

**Architecture:** ReactFlow handles pan/zoom/drag/selection/minimap natively. Zustand store and backend (API, WS, SQLite) are preserved. BaseCard + TypeRenderer pattern replaces 13 monolithic card components. dagre computes Flow/Kanban layouts.

**Tech Stack:** @xyflow/react, @dagrejs/dagre, React 19, Zustand 5, TypeScript, Tailwind CSS, Vitest

**Spec:** `docs/superpowers/specs/2026-04-08-canvas-redevelopment-design.md`

---

## File Map

### New files

| File | Responsibility |
|---|---|
| `web-portal/src/components/canvas/CanvasWorkspace.tsx` | Thin orchestrator replacing CanvasPanel (ReactFlow provider, pending queue, auto-save) |
| `web-portal/src/components/canvas/BaseCard.tsx` | Shared card node: glassmorphism shell, header, content slot, footer, React.memo |
| `web-portal/src/components/canvas/renderers/TextContentRenderer.tsx` | note-block, goal-summary, link-card |
| `web-portal/src/components/canvas/renderers/CodeContentRenderer.tsx` | code-block, diff-block, terminal-block |
| `web-portal/src/components/canvas/renderers/StatusContentRenderer.tsx` | task-card, error-card, test-result |
| `web-portal/src/components/canvas/renderers/DataContentRenderer.tsx` | metric-card, diagram-node |
| `web-portal/src/components/canvas/renderers/MediaContentRenderer.tsx` | image-block, file-card |
| `web-portal/src/components/canvas/card-registry.ts` | Type string → renderer component mapping |
| `web-portal/src/components/canvas/GradientBezierEdge.tsx` | Custom ReactFlow edge with gradient + label |
| `web-portal/src/components/canvas/layout-engine.ts` | dagre adapter: Flow, Kanban, Freeform auto-arrange |
| `web-portal/src/hooks/use-canvas-bridge.ts` | Zustand store ↔ ReactFlow nodes/edges bidirectional sync |
| `web-portal/src/hooks/use-canvas-shortcuts.ts` | Keyboard shortcuts (delete, undo, redo, select-all, duplicate) |
| `web-portal/src/components/canvas/CanvasWorkspace.test.tsx` | Workspace orchestration tests |
| `web-portal/src/components/canvas/BaseCard.test.tsx` | Card rendering tests for all 13 types |
| `web-portal/src/components/canvas/layout-engine.test.ts` | Layout algorithm tests |
| `web-portal/src/hooks/use-canvas-bridge.test.ts` | Store ↔ ReactFlow conversion tests |

### Modified files

| File | Change |
|---|---|
| `web-portal/package.json` | Add @xyflow/react, @dagrejs/dagre |
| `web-portal/src/components/layout/AppLayout.tsx:19` | Change lazy import from CanvasPanel → CanvasWorkspace |
| `web-portal/src/stores/canvas-store.ts` | Add `layoutMode` field + `setLayoutMode` action |
| `web-portal/src/components/canvas/canvas-types.ts` | Add ReactFlow node/edge type definitions |
| `web-portal/src/components/canvas/canvas-toolbar.tsx` | Add layout mode selector |
| `web-portal/src/components/canvas/canvas-context-menu.tsx` | Minor cleanup |
| `web-portal/src/hooks/use-dashboard-socket.ts` | Emit canvas:user_shapes for user-added shapes |

### Deleted files (Phase 2)

| File | Reason |
|---|---|
| `web-portal/src/components/canvas/CanvasPanel.tsx` | Replaced by CanvasWorkspace |
| `web-portal/src/components/canvas/canvas-viewport.tsx` | ReactFlow native viewport |
| `web-portal/src/components/canvas/canvas-minimap.tsx` | ReactFlow `<MiniMap>` |
| `web-portal/src/components/canvas/canvas-controls.tsx` | Replaced by CanvasControls in workspace |
| `web-portal/src/components/canvas/selection-overlay.tsx` | ReactFlow native selection + node-resizer |
| `web-portal/src/components/canvas/canvas-cards.tsx` | Replaced by BaseCard + renderers |
| `web-portal/src/components/canvas/canvas-connections.tsx` | Replaced by GradientBezierEdge |
| `web-portal/src/components/canvas/card-components.ts` | Replaced by card-registry.ts |
| `web-portal/src/components/canvas/canvas-helpers.ts` | Replaced by layout-engine.ts |
| `web-portal/src/components/canvas/CanvasPanel.test.tsx` | Replaced by CanvasWorkspace.test.tsx |

---

## Phase 1: Foundation

### Task 1: Install dependencies

**Files:**
- Modify: `web-portal/package.json`

- [ ] **Step 1: Install ReactFlow and dagre**

```bash
npm --prefix web-portal install @xyflow/react @dagrejs/dagre
npm --prefix web-portal install -D @types/dagre
```

- [ ] **Step 2: Verify installation**

```bash
node -e "require('@xyflow/react'); console.log('xyflow OK')"
node -e "require('@dagrejs/dagre'); console.log('dagre OK')"
```

Expected: Both print OK.

- [ ] **Step 3: Commit**

```bash
git add web-portal/package.json web-portal/package-lock.json
git commit -m "chore(portal): add @xyflow/react and @dagrejs/dagre dependencies"
```

---

### Task 2: Extend canvas types for ReactFlow

**Files:**
- Modify: `web-portal/src/components/canvas/canvas-types.ts`
- Test: existing `canvas-shape-normalizer.test.ts` (must still pass)

- [ ] **Step 1: Add ReactFlow type mappings to canvas-types.ts**

Add these types after the existing `getDefaultDimensions` function:

```typescript
import type { Node, Edge } from '@xyflow/react'

/** ReactFlow node carrying a canvas shape's data. */
export interface CanvasNode extends Node {
  type: 'baseCard'
  data: {
    cardType: string
    props: Record<string, unknown>
    source?: 'agent' | 'user'
  }
}

/** ReactFlow edge carrying a canvas connection's data. */
export interface CanvasEdge extends Edge {
  type: 'gradientBezier'
  data?: {
    label?: string
  }
}

/** Layout modes for the canvas workspace. */
export type LayoutMode = 'flow' | 'kanban' | 'freeform'
```

- [ ] **Step 2: Run existing tests to verify no breakage**

```bash
npx vitest run web-portal/src/components/canvas/canvas-shape-normalizer.test.ts
```

Expected: All 14+ tests pass.

- [ ] **Step 3: Run TypeScript check**

```bash
npx tsc --noEmit --pretty
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add web-portal/src/components/canvas/canvas-types.ts
git commit -m "feat(canvas): add ReactFlow node/edge type definitions"
```

---

### Task 3: Add layoutMode to canvas store

**Files:**
- Modify: `web-portal/src/stores/canvas-store.ts`
- Test: `web-portal/src/stores/canvas-store.test.ts`

- [ ] **Step 1: Write failing test for layoutMode**

Add to `canvas-store.test.ts`:

```typescript
it('manages layoutMode with default freeform', () => {
  const store = useCanvasStore.getState()
  expect(store.layoutMode).toBe('freeform')

  store.setLayoutMode('kanban')
  expect(useCanvasStore.getState().layoutMode).toBe('kanban')

  store.setLayoutMode('flow')
  expect(useCanvasStore.getState().layoutMode).toBe('flow')
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run web-portal/src/stores/canvas-store.test.ts
```

Expected: FAIL — `layoutMode` not found on store.

- [ ] **Step 3: Add layoutMode to canvas store**

In `canvas-store.ts`, add to the state interface and initial state:

```typescript
// In state interface:
layoutMode: LayoutMode

// In initial state:
layoutMode: 'freeform' as LayoutMode,

// In actions:
setLayoutMode: (mode: LayoutMode) => set({ layoutMode: mode }),
```

Import `LayoutMode` from `../components/canvas/canvas-types.js`.

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run web-portal/src/stores/canvas-store.test.ts
```

Expected: All tests pass including the new one.

- [ ] **Step 5: Commit**

```bash
git add web-portal/src/stores/canvas-store.ts web-portal/src/stores/canvas-store.test.ts
git commit -m "feat(canvas): add layoutMode state to canvas store"
```

---

### Task 4: Store ↔ ReactFlow bridge hook

**Files:**
- Create: `web-portal/src/hooks/use-canvas-bridge.ts`
- Create: `web-portal/src/hooks/use-canvas-bridge.test.ts`

- [ ] **Step 1: Write failing tests for the bridge**

Create `web-portal/src/hooks/use-canvas-bridge.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { shapesToNodes, connectionsToEdges, nodeChangeToStoreUpdate } from '../hooks/use-canvas-bridge'
import type { ResolvedShape, CanvasConnection } from '../components/canvas/canvas-types'

describe('use-canvas-bridge', () => {
  const mockShape: ResolvedShape = {
    id: 'shape-1',
    type: 'task-card',
    x: 100,
    y: 200,
    w: 240,
    h: 130,
    props: { title: 'Test Task', status: 'pending' },
    source: 'agent',
  }

  const mockConnection: CanvasConnection = {
    id: 'conn-1',
    from: 'shape-1',
    to: 'shape-2',
    label: 'depends on',
  }

  describe('shapesToNodes', () => {
    it('converts ResolvedShape to ReactFlow Node', () => {
      const nodes = shapesToNodes([mockShape])
      expect(nodes).toHaveLength(1)
      expect(nodes[0]).toMatchObject({
        id: 'shape-1',
        type: 'baseCard',
        position: { x: 100, y: 200 },
        style: { width: 240, height: 130 },
        data: {
          cardType: 'task-card',
          props: { title: 'Test Task', status: 'pending' },
          source: 'agent',
        },
      })
    })

    it('converts connection-arrow shapes to null (filtered out)', () => {
      const arrowShape: ResolvedShape = {
        id: 'arrow-1', type: 'connection-arrow',
        x: 0, y: 0, w: 120, h: 40, props: { from: 'a', to: 'b' },
      }
      const nodes = shapesToNodes([arrowShape])
      expect(nodes).toHaveLength(0)
    })
  })

  describe('connectionsToEdges', () => {
    it('converts CanvasConnection to ReactFlow Edge', () => {
      const edges = connectionsToEdges([mockConnection])
      expect(edges).toHaveLength(1)
      expect(edges[0]).toMatchObject({
        id: 'conn-1',
        source: 'shape-1',
        target: 'shape-2',
        type: 'gradientBezier',
        data: { label: 'depends on' },
      })
    })
  })

  describe('nodeChangeToStoreUpdate', () => {
    it('extracts position from node drag', () => {
      const update = nodeChangeToStoreUpdate({
        id: 'shape-1',
        type: 'position',
        position: { x: 300, y: 400 },
      })
      expect(update).toEqual({ id: 'shape-1', x: 300, y: 400 })
    })

    it('extracts dimensions from node resize', () => {
      const update = nodeChangeToStoreUpdate({
        id: 'shape-1',
        type: 'dimensions',
        dimensions: { width: 500, height: 300 },
      })
      expect(update).toEqual({ id: 'shape-1', w: 500, h: 300 })
    })

    it('returns null for non-relevant changes', () => {
      const update = nodeChangeToStoreUpdate({
        id: 'shape-1',
        type: 'select',
        selected: true,
      })
      expect(update).toBeNull()
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run web-portal/src/hooks/use-canvas-bridge.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the bridge**

Create `web-portal/src/hooks/use-canvas-bridge.ts`:

```typescript
import { useMemo, useCallback } from 'react'
import type { NodeChange, EdgeChange } from '@xyflow/react'
import { useCanvasStore } from '../stores/canvas-store'
import type { ResolvedShape, CanvasConnection, CanvasNode, CanvasEdge } from '../components/canvas/canvas-types'

/** Convert store shapes to ReactFlow nodes. Filters out connection-arrow (rendered as edges). */
export function shapesToNodes(shapes: ResolvedShape[]): CanvasNode[] {
  const nodes: CanvasNode[] = []
  for (const s of shapes) {
    if (s.type === 'connection-arrow') continue
    nodes.push({
      id: s.id,
      type: 'baseCard',
      position: { x: s.x, y: s.y },
      style: { width: s.w, height: s.h },
      data: {
        cardType: s.type,
        props: s.props,
        source: s.source,
      },
    })
  }
  return nodes
}

/** Convert store connections to ReactFlow edges. */
export function connectionsToEdges(connections: CanvasConnection[]): CanvasEdge[] {
  return connections.map((c) => ({
    id: c.id,
    source: c.from,
    target: c.to,
    type: 'gradientBezier' as const,
    data: c.label ? { label: c.label } : undefined,
  }))
}

/** Extract store-relevant updates from ReactFlow node changes. */
export function nodeChangeToStoreUpdate(
  change: NodeChange,
): { id: string; x?: number; y?: number; w?: number; h?: number } | null {
  if (change.type === 'position' && change.position) {
    return { id: change.id, x: change.position.x, y: change.position.y }
  }
  if (change.type === 'dimensions' && change.dimensions) {
    return { id: change.id, w: change.dimensions.width, h: change.dimensions.height }
  }
  return null
}

/** Hook that bridges Zustand canvas store ↔ ReactFlow state. */
export function useCanvasBridge() {
  const shapes = useCanvasStore((s) => s.shapes)
  const connections = useCanvasStore((s) => s.connections)
  const updateShape = useCanvasStore((s) => s.updateShape)
  const selectShape = useCanvasStore((s) => s.selectShape)
  const deselectAll = useCanvasStore((s) => s.deselectAll)
  const removeShapes = useCanvasStore((s) => s.removeShapes)
  const pushUndo = useCanvasStore((s) => s.pushUndo)

  const nodes = useMemo(() => shapesToNodes(shapes), [shapes])
  const edges = useMemo(() => connectionsToEdges(connections), [connections])

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      for (const change of changes) {
        if (change.type === 'position' && change.dragging === false && change.position) {
          pushUndo()
          updateShape(change.id, { x: change.position.x, y: change.position.y })
        }
        if (change.type === 'dimensions' && change.dimensions && change.resizing === false) {
          pushUndo()
          updateShape(change.id, { w: change.dimensions.width, h: change.dimensions.height })
        }
        if (change.type === 'select') {
          if (change.selected) {
            selectShape(change.id)
          } else {
            deselectAll()
          }
        }
        if (change.type === 'remove') {
          pushUndo()
          removeShapes([change.id])
        }
      }
    },
    [pushUndo, updateShape, selectShape, deselectAll, removeShapes],
  )

  const onEdgesChange = useCallback((_changes: EdgeChange[]) => {
    // Edge changes handled through store actions (addConnection, removeConnections)
  }, [])

  return { nodes, edges, onNodesChange, onEdgesChange }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run web-portal/src/hooks/use-canvas-bridge.test.ts
```

Expected: All 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add web-portal/src/hooks/use-canvas-bridge.ts web-portal/src/hooks/use-canvas-bridge.test.ts
git commit -m "feat(canvas): add store-to-ReactFlow bridge hook with tests"
```

---

### Task 5: Layout engine with dagre

**Files:**
- Create: `web-portal/src/components/canvas/layout-engine.ts`
- Create: `web-portal/src/components/canvas/layout-engine.test.ts`

- [ ] **Step 1: Write failing tests**

Create `web-portal/src/components/canvas/layout-engine.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { applyLayout } from './layout-engine'
import type { Node, Edge } from '@xyflow/react'

const makeNode = (id: string, w = 240, h = 130, data = {}): Node => ({
  id,
  type: 'baseCard',
  position: { x: 0, y: 0 },
  style: { width: w, height: h },
  data: { cardType: 'task-card', props: {}, ...data },
})

const makeEdge = (id: string, source: string, target: string): Edge => ({
  id, source, target, type: 'gradientBezier',
})

describe('layout-engine', () => {
  describe('flow layout', () => {
    it('positions nodes left-to-right based on edges', () => {
      const nodes = [makeNode('a'), makeNode('b'), makeNode('c')]
      const edges = [makeEdge('e1', 'a', 'b'), makeEdge('e2', 'b', 'c')]
      const result = applyLayout(nodes, edges, 'flow')
      // a should be leftmost, c rightmost
      expect(result.nodes[0]!.position.x).toBeLessThan(result.nodes[1]!.position.x)
      expect(result.nodes[1]!.position.x).toBeLessThan(result.nodes[2]!.position.x)
    })

    it('handles nodes without edges (isolated nodes)', () => {
      const nodes = [makeNode('a'), makeNode('b')]
      const result = applyLayout(nodes, [], 'flow')
      expect(result.nodes).toHaveLength(2)
      // Both should have valid positions
      for (const n of result.nodes) {
        expect(Number.isFinite(n.position.x)).toBe(true)
        expect(Number.isFinite(n.position.y)).toBe(true)
      }
    })
  })

  describe('kanban layout', () => {
    it('groups task-cards by status into columns', () => {
      const nodes = [
        makeNode('a', 240, 130, { cardType: 'task-card', props: { status: 'pending' } }),
        makeNode('b', 240, 130, { cardType: 'task-card', props: { status: 'completed' } }),
        makeNode('c', 240, 130, { cardType: 'task-card', props: { status: 'pending' } }),
      ]
      const result = applyLayout(nodes, [], 'kanban')
      // a and c (pending) should have same x, b (completed) different x
      const ax = result.nodes.find((n) => n.id === 'a')!.position.x
      const bx = result.nodes.find((n) => n.id === 'b')!.position.x
      const cx = result.nodes.find((n) => n.id === 'c')!.position.x
      expect(ax).toBe(cx)
      expect(ax).not.toBe(bx)
    })
  })

  describe('freeform layout', () => {
    it('arranges overlapping nodes in collision-free grid', () => {
      const nodes = [
        { ...makeNode('a'), position: { x: 0, y: 0 } },
        { ...makeNode('b'), position: { x: 0, y: 0 } }, // overlaps a
        { ...makeNode('c'), position: { x: 0, y: 0 } }, // overlaps both
      ]
      const result = applyLayout(nodes, [], 'freeform')
      const positions = result.nodes.map((n) => `${n.position.x},${n.position.y}`)
      // All positions should be unique (no overlaps)
      expect(new Set(positions).size).toBe(3)
    })

    it('preserves positions of non-overlapping nodes', () => {
      const nodes = [
        { ...makeNode('a'), position: { x: 0, y: 0 } },
        { ...makeNode('b'), position: { x: 500, y: 500 } },
      ]
      const result = applyLayout(nodes, [], 'freeform')
      expect(result.nodes[0]!.position).toEqual({ x: 0, y: 0 })
      expect(result.nodes[1]!.position).toEqual({ x: 500, y: 500 })
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run web-portal/src/components/canvas/layout-engine.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement layout engine**

Create `web-portal/src/components/canvas/layout-engine.ts`:

```typescript
import dagre from '@dagrejs/dagre'
import type { Node, Edge } from '@xyflow/react'
import type { LayoutMode } from './canvas-types'

const RANK_SEP = 200
const NODE_SEP = 80
const KANBAN_COL_WIDTH = 300
const KANBAN_ROW_HEIGHT = 160
const GRID_GAP = 40

const KANBAN_COLUMNS = ['planned', 'pending', 'executing', 'verifying', 'completed', 'failed'] as const

function nodeWidth(node: Node): number {
  return (node.style?.width as number) ?? 240
}
function nodeHeight(node: Node): number {
  return (node.style?.height as number) ?? 130
}

function applyDagreLayout(nodes: Node[], edges: Edge[], direction: 'LR' | 'TB'): Node[] {
  const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: direction, ranksep: RANK_SEP, nodesep: NODE_SEP })

  for (const node of nodes) {
    g.setNode(node.id, { width: nodeWidth(node), height: nodeHeight(node) })
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target)
  }

  dagre.layout(g)

  return nodes.map((node) => {
    const pos = g.node(node.id)
    return {
      ...node,
      position: {
        x: pos.x - nodeWidth(node) / 2,
        y: pos.y - nodeHeight(node) / 2,
      },
    }
  })
}

function applyKanbanLayout(nodes: Node[]): Node[] {
  const columns = new Map<string, Node[]>()

  for (const node of nodes) {
    const status = String(node.data?.props?.status ?? 'pending')
    const col = KANBAN_COLUMNS.includes(status as typeof KANBAN_COLUMNS[number])
      ? status : 'pending'
    if (!columns.has(col)) columns.set(col, [])
    columns.get(col)!.push(node)
  }

  const result: Node[] = []
  let colIndex = 0
  for (const colName of KANBAN_COLUMNS) {
    const colNodes = columns.get(colName)
    if (!colNodes?.length) continue
    for (let row = 0; row < colNodes.length; row++) {
      result.push({
        ...colNodes[row]!,
        position: {
          x: 80 + colIndex * KANBAN_COL_WIDTH,
          y: 80 + row * KANBAN_ROW_HEIGHT,
        },
      })
    }
    colIndex++
  }

  // Non-task nodes go in a "Notes" column at the end
  const nonTask = nodes.filter(
    (n) => !KANBAN_COLUMNS.includes(String(n.data?.props?.status ?? '') as typeof KANBAN_COLUMNS[number])
      && !result.some((r) => r.id === n.id),
  )
  for (let row = 0; row < nonTask.length; row++) {
    result.push({
      ...nonTask[row]!,
      position: {
        x: 80 + colIndex * KANBAN_COL_WIDTH,
        y: 80 + row * KANBAN_ROW_HEIGHT,
      },
    })
  }

  return result
}

function applyFreeformLayout(nodes: Node[]): Node[] {
  const occupied = new Set<string>()
  const result: Node[] = []

  for (const node of nodes) {
    const key = `${node.position.x},${node.position.y}`
    if (!occupied.has(key)) {
      occupied.add(key)
      result.push(node)
      continue
    }
    // Collision — find next free position in 4-column grid
    const w = nodeWidth(node)
    const h = nodeHeight(node)
    let placed = false
    for (let attempt = 0; attempt < 100; attempt++) {
      const col = attempt % 4
      const row = Math.floor(attempt / 4)
      const nx = 80 + col * (w + GRID_GAP)
      const ny = 80 + row * (h + GRID_GAP)
      const nKey = `${nx},${ny}`
      if (!occupied.has(nKey)) {
        occupied.add(nKey)
        result.push({ ...node, position: { x: nx, y: ny } })
        placed = true
        break
      }
    }
    if (!placed) {
      result.push(node) // fallback: keep original position
    }
  }

  return result
}

/** Apply a layout algorithm to ReactFlow nodes. Returns new nodes with updated positions. */
export function applyLayout(
  nodes: Node[],
  edges: Edge[],
  mode: LayoutMode,
  options?: { direction?: 'LR' | 'TB' },
): { nodes: Node[]; edges: Edge[] } {
  if (nodes.length === 0) return { nodes, edges }

  switch (mode) {
    case 'flow':
      return { nodes: applyDagreLayout(nodes, edges, options?.direction ?? 'LR'), edges }
    case 'kanban':
      return { nodes: applyKanbanLayout(nodes), edges }
    case 'freeform':
      return { nodes: applyFreeformLayout(nodes), edges }
    default:
      return { nodes, edges }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run web-portal/src/components/canvas/layout-engine.test.ts
```

Expected: All 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add web-portal/src/components/canvas/layout-engine.ts web-portal/src/components/canvas/layout-engine.test.ts
git commit -m "feat(canvas): add dagre-based layout engine with flow/kanban/freeform modes"
```

---

### Task 6: Card registry and TypeRenderers

**Files:**
- Create: `web-portal/src/components/canvas/card-registry.ts`
- Create: `web-portal/src/components/canvas/renderers/TextContentRenderer.tsx`
- Create: `web-portal/src/components/canvas/renderers/CodeContentRenderer.tsx`
- Create: `web-portal/src/components/canvas/renderers/StatusContentRenderer.tsx`
- Create: `web-portal/src/components/canvas/renderers/DataContentRenderer.tsx`
- Create: `web-portal/src/components/canvas/renderers/MediaContentRenderer.tsx`

- [ ] **Step 1: Create the renderer interface and registry**

Create `web-portal/src/components/canvas/card-registry.ts`:

```typescript
import type { ComponentType } from 'react'
import { lazy } from 'react'

export interface RendererProps {
  type: string
  props: Record<string, unknown>
}

const TextContentRenderer = lazy(() => import('./renderers/TextContentRenderer'))
const CodeContentRenderer = lazy(() => import('./renderers/CodeContentRenderer'))
const StatusContentRenderer = lazy(() => import('./renderers/StatusContentRenderer'))
const DataContentRenderer = lazy(() => import('./renderers/DataContentRenderer'))
const MediaContentRenderer = lazy(() => import('./renderers/MediaContentRenderer'))

export const CARD_RENDERERS: Record<string, ComponentType<RendererProps>> = {
  'note-block': TextContentRenderer,
  'goal-summary': TextContentRenderer,
  'link-card': TextContentRenderer,
  'code-block': CodeContentRenderer,
  'diff-block': CodeContentRenderer,
  'terminal-block': CodeContentRenderer,
  'task-card': StatusContentRenderer,
  'error-card': StatusContentRenderer,
  'test-result': StatusContentRenderer,
  'metric-card': DataContentRenderer,
  'diagram-node': DataContentRenderer,
  'image-block': MediaContentRenderer,
  'file-card': MediaContentRenderer,
}
```

- [ ] **Step 2: Create all 5 TypeRenderers**

Create each renderer in `web-portal/src/components/canvas/renderers/`. Each is a default export component receiving `RendererProps`.

**TextContentRenderer.tsx:**
```tsx
import { useTranslation } from 'react-i18next'
import type { RendererProps } from '../card-registry'

export default function TextContentRenderer({ type, props }: RendererProps) {
  const { t } = useTranslation('canvas')
  const title = String(props.title ?? props.name ?? '')
  const content = String(props.content ?? props.text ?? props.description ?? '')
  const url = type === 'link-card' ? String(props.url ?? '') : undefined
  const progress = type === 'goal-summary' ? Number(props.progress ?? 0) : undefined

  return (
    <div className="space-y-1.5">
      {title && <div className="text-xs font-semibold text-text truncate">{title}</div>}
      {content && <div className="text-[11px] text-text-secondary line-clamp-4 whitespace-pre-wrap">{content}</div>}
      {url && (
        <div className="text-[10px] text-accent/70 truncate">{url}</div>
      )}
      {progress != null && (
        <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
          <div
            className="h-full rounded-full bg-accent transition-all"
            style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
          />
        </div>
      )}
    </div>
  )
}
```

**CodeContentRenderer.tsx:**
```tsx
import type { RendererProps } from '../card-registry'

export default function CodeContentRenderer({ type, props }: RendererProps) {
  const code = String(props.code ?? props.content ?? props.diff ?? props.output ?? '')
  const language = String(props.language ?? props.lang ?? '')
  const command = type === 'terminal-block' ? String(props.command ?? '') : undefined
  const isDiff = type === 'diff-block'

  return (
    <div className="space-y-1">
      {command && (
        <div className="text-[10px] font-mono text-accent/80 bg-white/5 rounded px-1.5 py-0.5 truncate">
          $ {command}
        </div>
      )}
      {language && !command && (
        <div className="text-[9px] text-text-tertiary uppercase tracking-wide">{language}</div>
      )}
      <pre className={`text-[10px] font-mono leading-relaxed overflow-hidden max-h-40 ${isDiff ? 'diff-colors' : 'text-text-secondary'}`}>
        {code || '(empty)'}
      </pre>
    </div>
  )
}
```

**StatusContentRenderer.tsx:**
```tsx
import { useTranslation } from 'react-i18next'
import type { RendererProps } from '../card-registry'

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-400/20 text-yellow-300',
  planned: 'bg-yellow-400/20 text-yellow-300',
  executing: 'bg-blue-400/20 text-blue-300',
  verifying: 'bg-purple-400/20 text-purple-300',
  completed: 'bg-emerald-400/20 text-emerald-300',
  failed: 'bg-red-400/20 text-red-300',
  passed: 'bg-emerald-400/20 text-emerald-300',
  warning: 'bg-amber-400/20 text-amber-300',
  error: 'bg-red-400/20 text-red-300',
}

export default function StatusContentRenderer({ type, props }: RendererProps) {
  const { t } = useTranslation('canvas')
  const title = String(props.title ?? props.name ?? props.message ?? '')
  const status = String(props.status ?? props.severity ?? '')
  const priority = String(props.priority ?? '')
  const colorClass = STATUS_COLORS[status] ?? STATUS_COLORS.pending

  return (
    <div className="space-y-1.5">
      {title && <div className="text-xs font-medium text-text truncate">{title}</div>}
      <div className="flex items-center gap-1.5">
        {status && (
          <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${colorClass}`}>
            {t(`cards.status.${status}`, status)}
          </span>
        )}
        {priority && priority !== 'undefined' && (
          <span className="text-[9px] text-text-tertiary">{t(`cards.priority.${priority}`, priority)}</span>
        )}
      </div>
      {type === 'error-card' && props.stack && (
        <pre className="text-[9px] font-mono text-red-300/70 line-clamp-3 overflow-hidden">
          {String(props.stack)}
        </pre>
      )}
      {type === 'test-result' && (
        <div className="flex gap-2 text-[10px]">
          {props.passed != null && <span className="text-emerald-400">{String(props.passed)} passed</span>}
          {props.failed != null && <span className="text-red-400">{String(props.failed)} failed</span>}
        </div>
      )}
    </div>
  )
}
```

**DataContentRenderer.tsx:**
```tsx
import type { RendererProps } from '../card-registry'

export default function DataContentRenderer({ type, props }: RendererProps) {
  if (type === 'metric-card') {
    const value = String(props.value ?? '—')
    const label = String(props.label ?? props.title ?? '')
    const trend = String(props.trend ?? '')
    return (
      <div className="flex flex-col items-center justify-center py-1">
        <div className="text-2xl font-bold text-text">{value}</div>
        {label && <div className="text-[10px] text-text-tertiary mt-0.5">{label}</div>}
        {trend && <div className="text-[10px] text-accent/70">{trend}</div>}
      </div>
    )
  }

  // diagram-node
  const label = String(props.label ?? props.title ?? props.name ?? '')
  const status = String(props.status ?? '')
  return (
    <div className="flex items-center gap-2">
      {status && (
        <span className={`w-2 h-2 rounded-full shrink-0 ${status === 'active' ? 'bg-emerald-400' : 'bg-white/20'}`} />
      )}
      <div className="text-xs text-text truncate">{label || 'Node'}</div>
    </div>
  )
}
```

**MediaContentRenderer.tsx:**
```tsx
import type { RendererProps } from '../card-registry'

export default function MediaContentRenderer({ type, props }: RendererProps) {
  if (type === 'image-block') {
    const src = String(props.src ?? props.url ?? '')
    const alt = String(props.alt ?? props.title ?? 'Image')
    const isSafe = src.startsWith('data:') || src.startsWith('blob:')
    return isSafe
      ? <img src={src} alt={alt} className="rounded-lg max-h-48 w-full object-contain" />
      : <div className="text-[10px] text-text-tertiary italic">Image source blocked (security)</div>
    }

  // file-card
  const path = String(props.path ?? props.name ?? '')
  const language = String(props.language ?? '')
  const lines = props.lines != null ? Number(props.lines) : undefined
  return (
    <div className="space-y-1">
      <div className="text-xs font-mono text-text truncate">{path || 'Unknown file'}</div>
      <div className="flex gap-2 text-[9px] text-text-tertiary">
        {language && <span>{language}</span>}
        {lines != null && <span>{lines} lines</span>}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Run TypeScript check**

```bash
npx tsc --noEmit --pretty
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add web-portal/src/components/canvas/card-registry.ts web-portal/src/components/canvas/renderers/
git commit -m "feat(canvas): add card-registry and 5 TypeRenderers for all 13 card types"
```

---

### Task 7: BaseCard component

**Files:**
- Create: `web-portal/src/components/canvas/BaseCard.tsx`
- Create: `web-portal/src/components/canvas/BaseCard.test.tsx`

- [ ] **Step 1: Write failing tests for BaseCard**

Create `web-portal/src/components/canvas/BaseCard.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import BaseCard from './BaseCard'

function renderCard(cardType: string, props: Record<string, unknown> = {}) {
  return render(
    <ReactFlowProvider>
      <BaseCard
        id="test-1"
        data={{ cardType, props, source: 'agent' }}
        type="baseCard"
        positionAbsoluteX={0}
        positionAbsoluteY={0}
        isConnectable={true}
        zIndex={1}
      />
    </ReactFlowProvider>,
  )
}

describe('BaseCard', () => {
  it('renders task-card type badge', () => {
    renderCard('task-card', { title: 'My Task', status: 'pending' })
    expect(screen.getByText('task-card')).toBeTruthy()
  })

  it('renders note-block content', () => {
    renderCard('note-block', { content: 'Hello world' })
    expect(screen.getByText('Hello world')).toBeTruthy()
  })

  it('shows agent badge for agent-sourced cards', () => {
    renderCard('code-block', { code: 'console.log("hi")' })
    expect(screen.getByText('AI')).toBeTruthy()
  })

  it('renders all 13 card types without crashing', () => {
    const types = [
      'code-block', 'diff-block', 'file-card', 'diagram-node',
      'terminal-block', 'image-block', 'task-card', 'note-block',
      'goal-summary', 'error-card', 'test-result', 'link-card', 'metric-card',
    ]
    for (const type of types) {
      const { unmount } = renderCard(type)
      unmount()
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run web-portal/src/components/canvas/BaseCard.test.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement BaseCard**

Create `web-portal/src/components/canvas/BaseCard.tsx`:

```tsx
import { memo, Suspense } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { NodeResizer } from '@xyflow/react'
import { useTranslation } from 'react-i18next'
import { CARD_RENDERERS } from './card-registry'
import type { CanvasNode } from './canvas-types'

const ACCENT_COLORS: Record<string, string> = {
  'code-block': 'border-sky-400/20',
  'diff-block': 'border-orange-400/20',
  'file-card': 'border-slate-400/20',
  'diagram-node': 'border-violet-400/20',
  'terminal-block': 'border-emerald-400/20',
  'image-block': 'border-pink-400/20',
  'task-card': 'border-blue-400/20',
  'note-block': 'border-amber-400/20',
  'goal-summary': 'border-cyan-400/20',
  'error-card': 'border-red-400/20',
  'test-result': 'border-green-400/20',
  'link-card': 'border-indigo-400/20',
  'metric-card': 'border-teal-400/20',
}

function BaseCardInner({ data, selected }: NodeProps<CanvasNode>) {
  const { t } = useTranslation('canvas')
  const { cardType, props, source } = data
  const Renderer = CARD_RENDERERS[cardType]
  const accentBorder = ACCENT_COLORS[cardType] ?? 'border-white/10'

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={120}
        minHeight={80}
        lineClassName="!border-accent/40"
        handleClassName="!w-2.5 !h-2.5 !bg-accent/60 !border-accent"
      />
      <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-accent/50 !border-0" />
      <Handle type="source" position={Position.Right} className="!w-2 !h-2 !bg-accent/50 !border-0" />

      <div
        className={`rounded-2xl border backdrop-blur-2xl shadow-lg overflow-hidden
          bg-gradient-to-b from-white/[0.06] to-[#0a0e16]/95 ${accentBorder}
          ${selected ? 'ring-1 ring-accent/40' : ''}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/5">
          <span className="text-[9px] font-semibold text-text-tertiary uppercase tracking-wide">
            {cardType}
          </span>
          {source === 'agent' && (
            <span className="text-[8px] font-bold text-accent/70 bg-accent/10 px-1.5 py-0.5 rounded-full">
              AI
            </span>
          )}
        </div>

        {/* Content */}
        <div className="px-3 py-2 min-h-[2rem]">
          {Renderer ? (
            <Suspense fallback={<div className="text-[10px] text-text-tertiary">...</div>}>
              <Renderer type={cardType} props={props} />
            </Suspense>
          ) : (
            <div className="text-[10px] text-text-tertiary italic">
              Unknown type: {cardType}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

const BaseCard = memo(BaseCardInner)
export default BaseCard
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run web-portal/src/components/canvas/BaseCard.test.tsx
```

Expected: All 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add web-portal/src/components/canvas/BaseCard.tsx web-portal/src/components/canvas/BaseCard.test.tsx
git commit -m "feat(canvas): add BaseCard component with React.memo and NodeResizer"
```

---

### Task 8: GradientBezierEdge

**Files:**
- Create: `web-portal/src/components/canvas/GradientBezierEdge.tsx`

- [ ] **Step 1: Create custom edge component**

Create `web-portal/src/components/canvas/GradientBezierEdge.tsx`:

```tsx
import { memo } from 'react'
import { getBezierPath, type EdgeProps } from '@xyflow/react'

function GradientBezierEdgeInner({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, data,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition,
  })

  const gradientId = `edge-gradient-${id}`
  const label = data?.label as string | undefined

  return (
    <>
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="rgb(74, 222, 128)" stopOpacity={0.6} />
          <stop offset="100%" stopColor="rgb(56, 189, 248)" stopOpacity={0.6} />
        </linearGradient>
      </defs>
      <path
        id={id}
        d={edgePath}
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth={2}
        className="react-flow__edge-path"
      />
      {label && (
        <foreignObject
          x={labelX - 40}
          y={labelY - 10}
          width={80}
          height={20}
          requiredExtensions="http://www.w3.org/1999/xhtml"
        >
          <div className="text-[9px] text-text-tertiary text-center bg-bg-primary/80 rounded px-1 truncate">
            {label}
          </div>
        </foreignObject>
      )}
    </>
  )
}

const GradientBezierEdge = memo(GradientBezierEdgeInner)
export default GradientBezierEdge
```

- [ ] **Step 2: Run TypeScript check**

```bash
npx tsc --noEmit --pretty
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add web-portal/src/components/canvas/GradientBezierEdge.tsx
git commit -m "feat(canvas): add GradientBezierEdge with gradient stroke and label"
```

---

### Task 9: Keyboard shortcuts hook

**Files:**
- Create: `web-portal/src/hooks/use-canvas-shortcuts.ts`

- [ ] **Step 1: Create keyboard shortcuts hook**

Create `web-portal/src/hooks/use-canvas-shortcuts.ts`:

```typescript
import { useEffect, useCallback } from 'react'
import { useCanvasStore } from '../stores/canvas-store'

export function useCanvasShortcuts() {
  const deleteSelected = useCanvasStore((s) => s.deleteSelected)
  const undo = useCanvasStore((s) => s.undo)
  const redo = useCanvasStore((s) => s.redo)
  const selectAll = useCanvasStore((s) => s.selectAll)
  const duplicateSelected = useCanvasStore((s) => s.duplicateSelected)
  const deselectAll = useCanvasStore((s) => s.deselectAll)

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Skip if user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return

      const mod = e.metaKey || e.ctrlKey

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        deleteSelected()
      } else if (mod && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if (mod && (e.key === 'Z' || e.key === 'y') && (e.shiftKey || e.key === 'y')) {
        e.preventDefault()
        redo()
      } else if (mod && e.key === 'a') {
        e.preventDefault()
        selectAll()
      } else if (mod && e.key === 'd') {
        e.preventDefault()
        duplicateSelected()
      } else if (e.key === 'Escape') {
        deselectAll()
      }
    },
    [deleteSelected, undo, redo, selectAll, duplicateSelected, deselectAll],
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])
}
```

- [ ] **Step 2: Run TypeScript check**

```bash
npx tsc --noEmit --pretty
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add web-portal/src/hooks/use-canvas-shortcuts.ts
git commit -m "feat(canvas): add keyboard shortcuts hook for canvas workspace"
```

---

## Phase 2: Swap

### Task 10: Create CanvasWorkspace and wire ReactFlow

**Files:**
- Create: `web-portal/src/components/canvas/CanvasWorkspace.tsx`
- Modify: `web-portal/src/components/layout/AppLayout.tsx:19`

- [ ] **Step 1: Create CanvasWorkspace**

Create `web-portal/src/components/canvas/CanvasWorkspace.tsx`:

```tsx
import { useCallback, useEffect, useRef, useMemo, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  useReactFlow,
  addEdge,
  type OnConnect,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useTranslation } from 'react-i18next'
import { useCanvasStore } from '../../stores/canvas-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useCanvasBridge } from '../../hooks/use-canvas-bridge'
import { useCanvasShortcuts } from '../../hooks/use-canvas-shortcuts'
import { applyLayout } from './layout-engine'
import {
  normalizeCanvasIncomingShape,
  normalizeCanvasConnection,
} from './canvas-shape-normalizer'
import { canvasShapeToResolved } from './canvas-helpers'
import BaseCard from './BaseCard'
import GradientBezierEdge from './GradientBezierEdge'
import CanvasToolbar from './canvas-toolbar'
import CanvasContextMenu from './canvas-context-menu'
import CanvasEmptyState from './canvas-empty-state'
import type { LayoutMode } from './canvas-types'

const nodeTypes = { baseCard: BaseCard }
const edgeTypes = { gradientBezier: GradientBezierEdge }

const SAVE_DEBOUNCE_MS = 5_000

function CanvasInner() {
  const { t } = useTranslation('canvas')
  const { fitView } = useReactFlow()
  const { nodes, edges, onNodesChange, onEdgesChange } = useCanvasBridge()
  useCanvasShortcuts()

  // Store selectors
  const sessionId = useCanvasStore((s) => s.sessionId)
  const shapes = useCanvasStore((s) => s.shapes)
  const isDirty = useCanvasStore((s) => s.isDirty)
  const setDirty = useCanvasStore((s) => s.setDirty)
  const layoutMode = useCanvasStore((s) => s.layoutMode)
  const addShape = useCanvasStore((s) => s.addShape)
  const setShapes = useCanvasStore((s) => s.setShapes)
  const setConnections = useCanvasStore((s) => s.setConnections)
  const addConnection = useCanvasStore((s) => s.addConnection)
  const setViewport = useCanvasStore((s) => s.setViewport)
  const pendingShapes = useCanvasStore((s) => s.pendingShapes)
  const pendingUpdates = useCanvasStore((s) => s.pendingUpdates)
  const pendingRemovals = useCanvasStore((s) => s.pendingRemovals)
  const pendingViewport = useCanvasStore((s) => s.pendingViewport)
  const pendingLayout = useCanvasStore((s) => s.pendingLayout)
  const clearPendingShapes = useCanvasStore((s) => s.clearPendingShapes)
  const clearPendingUpdates = useCanvasStore((s) => s.clearPendingUpdates)
  const clearPendingRemovals = useCanvasStore((s) => s.clearPendingRemovals)
  const clearPendingViewport = useCanvasStore((s) => s.clearPendingViewport)
  const clearPendingLayout = useCanvasStore((s) => s.clearPendingLayout)
  const updateShape = useCanvasStore((s) => s.updateShape)
  const removeShapes = useCanvasStore((s) => s.removeShapes)

  const [agentVisualCount, setAgentVisualCount] = useState(0)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Pending queue drain
  const pendingMutationCount =
    pendingShapes.length + pendingUpdates.length + pendingRemovals.length
    + (pendingViewport ? 1 : 0) + (pendingLayout ? 1 : 0)

  useEffect(() => {
    if (pendingMutationCount === 0) return

    let addedCount = 0
    if (pendingShapes.length > 0) {
      const baseIndex = shapes.length
      for (let i = 0; i < pendingShapes.length; i++) {
        const normalized = normalizeCanvasIncomingShape(pendingShapes[i])
        if (!normalized) continue
        const resolved = canvasShapeToResolved(normalized, baseIndex + i)
        addShape(resolved)
        addedCount++
      }
      clearPendingShapes()
    }
    if (pendingUpdates.length > 0) {
      for (const update of pendingUpdates) {
        updateShape(update.id, update)
      }
      clearPendingUpdates()
    }
    if (pendingRemovals.length > 0) {
      removeShapes(pendingRemovals)
      clearPendingRemovals()
    }
    if (pendingViewport) {
      setViewport(pendingViewport)
      clearPendingViewport()
    }
    if (pendingLayout) {
      clearPendingLayout()
      // Layout will be applied through the layout engine
      requestAnimationFrame(() => fitView({ padding: 0.15 }))
    }

    setAgentVisualCount((c) => c + addedCount)
    setDirty(true)
  }, [pendingMutationCount])

  // Auto-save
  useEffect(() => {
    if (!isDirty || !sessionId) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      try {
        await fetch(`/api/canvas/${sessionId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shapes: JSON.stringify(shapes), viewport: JSON.stringify(useCanvasStore.getState().viewport) }),
        })
        setDirty(false)
      } catch { /* silent */ }
    }, SAVE_DEBOUNCE_MS)
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [isDirty, sessionId, shapes])

  // Session load
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/canvas/${sessionId}`)
        if (cancelled) return
        const data = await res.json()
        if (!data?.canvas) return
        const parsed = typeof data.canvas.shapes === 'string'
          ? JSON.parse(data.canvas.shapes)
          : data.canvas.shapes
        if (Array.isArray(parsed)) {
          setShapes(parsed)
        }
        if (data.canvas.viewport) {
          const vp = typeof data.canvas.viewport === 'string'
            ? JSON.parse(data.canvas.viewport)
            : data.canvas.viewport
          if (vp) setViewport(vp)
        }
      } catch { /* silent */ }
    })()
    return () => { cancelled = true }
  }, [sessionId])

  // Connect handler
  const onConnect: OnConnect = useCallback(
    (connection) => {
      addConnection({
        id: `conn-${connection.source}-${connection.target}-${Date.now()}`,
        from: connection.source!,
        to: connection.target!,
      })
    },
    [addConnection],
  )

  // Context menu
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const onPaneContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    setContextMenu({ x: event.clientX, y: event.clientY })
  }, [])

  if (!sessionId && shapes.length === 0) {
    return (
      <div className="flex-1 relative">
        <CanvasToolbar />
        <CanvasEmptyState />
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col relative bg-[#060a10]">
      <CanvasToolbar agentVisualCount={agentVisualCount} />
      <div className="flex-1 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onPaneContextMenu={onPaneContextMenu}
          onPaneClick={() => setContextMenu(null)}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          minZoom={0.1}
          maxZoom={3}
          defaultEdgeOptions={{ type: 'gradientBezier' }}
          proOptions={{ hideAttribution: true }}
          className="canvas-flow"
        >
          <Background variant={BackgroundVariant.Dots} gap={28} size={1} color="rgba(255,255,255,0.05)" />
          <Controls showInteractive={false} className="!bg-bg-secondary/80 !border-white/10 !shadow-lg" />
          <MiniMap
            nodeColor={() => 'rgba(56, 189, 248, 0.3)'}
            maskColor="rgba(0, 0, 0, 0.7)"
            className="!bg-bg-secondary/60 !border-white/10"
          />
        </ReactFlow>
        {contextMenu && (
          <CanvasContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={() => setContextMenu(null)}
          />
        )}
      </div>
    </div>
  )
}

export default function CanvasWorkspace() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  )
}
```

- [ ] **Step 2: Update AppLayout lazy import**

In `web-portal/src/components/layout/AppLayout.tsx`, change line 19:

```typescript
// Old:
const CanvasPanel = lazy(() => import('../canvas/CanvasPanel'))
// New:
const CanvasWorkspace = lazy(() => import('../canvas/CanvasWorkspace'))
```

Also update the JSX reference from `<CanvasPanel />` to `<CanvasWorkspace />`.

- [ ] **Step 3: Run TypeScript check**

```bash
npx tsc --noEmit --pretty
```

Expected: No errors (old CanvasPanel still exists, just not imported).

- [ ] **Step 4: Run portal lint**

```bash
npm run lint:portal
```

Expected: Clean.

- [ ] **Step 5: Commit**

```bash
git add web-portal/src/components/canvas/CanvasWorkspace.tsx web-portal/src/components/layout/AppLayout.tsx
git commit -m "feat(canvas): create CanvasWorkspace with ReactFlow replacing CanvasPanel"
```

---

### Task 11: Delete old canvas files

**Files:**
- Delete: 8 old files (see file map)

- [ ] **Step 1: Delete replaced files**

```bash
cd web-portal/src/components/canvas
rm canvas-viewport.tsx canvas-minimap.tsx canvas-controls.tsx selection-overlay.tsx
rm canvas-cards.tsx canvas-connections.tsx card-components.ts canvas-helpers.ts
rm CanvasPanel.tsx CanvasPanel.test.tsx
```

- [ ] **Step 2: Verify no imports reference deleted files**

```bash
cd /Users/okanunico/Documents/Strada/Strada.Brain
grep -r "from.*canvas-viewport\|from.*canvas-minimap\|from.*canvas-controls\|from.*selection-overlay\|from.*canvas-cards\|from.*canvas-connections\|from.*card-components\|from.*canvas-helpers\|from.*CanvasPanel" web-portal/src/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".test."
```

Fix any remaining imports. `CanvasWorkspace.tsx` imports `canvasShapeToResolved` from `canvas-helpers` — this function needs to be moved to `layout-engine.ts` or a small utility file before deletion.

- [ ] **Step 3: Move canvasShapeToResolved to layout-engine.ts**

Copy the `canvasShapeToResolved` function from the old `canvas-helpers.ts` to `layout-engine.ts` and export it. Update the import in `CanvasWorkspace.tsx`.

- [ ] **Step 4: Run TypeScript check and tests**

```bash
npx tsc --noEmit --pretty
npx vitest run web-portal/src/components/canvas/ web-portal/src/stores/canvas-store.test.ts web-portal/src/hooks/use-canvas-bridge.test.ts
```

Expected: All tests pass, no TS errors.

- [ ] **Step 5: Commit**

```bash
git add -A web-portal/src/components/canvas/ web-portal/src/hooks/
git commit -m "refactor(canvas): remove old canvas engine files replaced by ReactFlow"
```

---

## Phase 3: Layout Engine Integration

### Task 12: Add layout selector to toolbar

**Files:**
- Modify: `web-portal/src/components/canvas/canvas-toolbar.tsx`

- [ ] **Step 1: Add layout mode buttons to toolbar**

In `canvas-toolbar.tsx`, add a layout selector section after the existing toolbar buttons:

```tsx
import { useCanvasStore } from '../../stores/canvas-store'
import type { LayoutMode } from './canvas-types'

// Inside the toolbar component, add:
const layoutMode = useCanvasStore((s) => s.layoutMode)
const setLayoutMode = useCanvasStore((s) => s.setLayoutMode)

const LAYOUT_OPTIONS: { mode: LayoutMode; label: string; icon: string }[] = [
  { mode: 'freeform', label: t('toolbar.freeform', 'Free'), icon: '⊞' },
  { mode: 'flow', label: t('toolbar.flow', 'Flow'), icon: '→' },
  { mode: 'kanban', label: t('toolbar.kanban', 'Board'), icon: '⫍' },
]

// Render layout toggle group:
<div className="flex items-center gap-0.5 bg-white/5 rounded-lg p-0.5">
  {LAYOUT_OPTIONS.map(({ mode, label }) => (
    <button
      key={mode}
      onClick={() => setLayoutMode(mode)}
      className={`px-2 py-1 text-[10px] font-medium rounded-md transition-colors
        ${layoutMode === mode
          ? 'bg-accent/20 text-accent'
          : 'text-text-tertiary hover:text-text-secondary'}`}
      aria-label={`Switch to ${label} layout`}
    >
      {label}
    </button>
  ))}
</div>
```

- [ ] **Step 2: Wire layout application in CanvasWorkspace**

In `CanvasWorkspace.tsx`, add layout application when `layoutMode` changes:

```tsx
// After the pending queue drain effect, add:
useEffect(() => {
  if (shapes.length === 0 || layoutMode === 'freeform') return
  const { nodes: layoutedNodes } = applyLayout(
    shapesToNodes(shapes),
    connectionsToEdges(useCanvasStore.getState().connections),
    layoutMode,
  )
  // Update store positions from layouted nodes
  for (const node of layoutedNodes) {
    updateShape(node.id, { x: node.position.x, y: node.position.y })
  }
  requestAnimationFrame(() => fitView({ padding: 0.15 }))
}, [layoutMode])
```

- [ ] **Step 3: Add i18n keys for layout modes**

Add to all 8 locale `canvas.json` files under `toolbar`:

```json
"freeform": "Free",
"flow": "Flow",
"kanban": "Board"
```

- [ ] **Step 4: Run TypeScript check and lint**

```bash
npx tsc --noEmit --pretty
npm run lint:portal
```

Expected: Clean.

- [ ] **Step 5: Commit**

```bash
git add web-portal/src/components/canvas/canvas-toolbar.tsx web-portal/src/components/canvas/CanvasWorkspace.tsx web-portal/src/i18n/
git commit -m "feat(canvas): add layout mode selector (Flow/Kanban/Freeform) to toolbar"
```

---

### Task 13: Context-aware layout defaults

**Files:**
- Modify: `web-portal/src/hooks/use-dashboard-socket.ts`

- [ ] **Step 1: Add layout auto-selection based on agent intent**

In `use-dashboard-socket.ts`, in the `canvas:agent_draw` handler, add layout inference logic:

```typescript
// After shapes are added to pending queue:
const intent = payload.intent as string | undefined
const canvasStore = useCanvasStore.getState()

// Don't override if user has manually selected a layout
if (!canvasStore.userLayoutOverride) {
  if (intent?.includes('plan') || intent?.includes('supervisor')) {
    canvasStore.setLayoutMode('flow')
  } else if (
    payload.shapes?.every((s: { type?: string }) => s.type === 'task-card')
    && !payload.shapes?.some((_: unknown, __: number, arr: unknown[]) => (arr as { connections?: unknown[] }[]).some(s => s.connections?.length))
  ) {
    canvasStore.setLayoutMode('kanban')
  }
}
```

- [ ] **Step 2: Add userLayoutOverride flag to store**

In `canvas-store.ts`, add:

```typescript
userLayoutOverride: boolean
// initial: false
// Set to true when user manually changes layout via toolbar
// Reset to false on session change
```

Update `setLayoutMode` to set `userLayoutOverride: true` when called from toolbar.

- [ ] **Step 3: Run TypeScript check**

```bash
npx tsc --noEmit --pretty
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add web-portal/src/hooks/use-dashboard-socket.ts web-portal/src/stores/canvas-store.ts
git commit -m "feat(canvas): add context-aware layout defaults based on agent intent"
```

---

## Phase 4: Bidirectional Communication

### Task 14: Activate canvas:user_shapes WS event

**Files:**
- Modify: `web-portal/src/components/canvas/CanvasWorkspace.tsx`
- Modify: `web-portal/src/hooks/use-dashboard-socket.ts`

- [ ] **Step 1: Emit user shapes over WebSocket**

In `CanvasWorkspace.tsx`, add an effect that detects user-added shapes and emits them:

```typescript
const wsRef = useWorkspaceStore((s) => s.wsRef)

// Track previous shapes count to detect additions
const prevShapeCountRef = useRef(shapes.length)
useEffect(() => {
  const prevCount = prevShapeCountRef.current
  prevShapeCountRef.current = shapes.length
  if (shapes.length <= prevCount) return

  // Find newly added user shapes
  const newUserShapes = shapes.slice(prevCount).filter((s) => s.source === 'user')
  if (newUserShapes.length === 0 || !wsRef?.current) return

  wsRef.current.send(JSON.stringify({
    type: 'canvas:user_shapes',
    payload: {
      shapes: newUserShapes,
      sessionId,
    },
  }))
}, [shapes.length, sessionId])
```

- [ ] **Step 2: Handle canvas:user_shapes on backend**

The `canvas:user_shapes` event is already defined in `workspace-events.ts:144` and routed in `web/channel.ts:973`. Verify the backend relays this to the orchestrator context. If not, add a handler in `monitor-bridge.ts` or the channel handler that appends user shapes to the agent's context.

- [ ] **Step 3: Run TypeScript check**

```bash
npx tsc --noEmit --pretty
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add web-portal/src/components/canvas/CanvasWorkspace.tsx
git commit -m "feat(canvas): emit canvas:user_shapes WS event for bidirectional communication"
```

---

## Phase 5: Polish + Tests

### Task 15: CanvasWorkspace integration tests

**Files:**
- Create: `web-portal/src/components/canvas/CanvasWorkspace.test.tsx`

- [ ] **Step 1: Write workspace tests**

Create `web-portal/src/components/canvas/CanvasWorkspace.test.tsx` with tests covering:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'

// Mock ReactFlow
vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ children }: { children: React.ReactNode }) => <div data-testid="reactflow">{children}</div>,
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MiniMap: () => <div data-testid="minimap" />,
  Controls: () => <div data-testid="controls" />,
  Background: () => <div data-testid="background" />,
  BackgroundVariant: { Dots: 'dots' },
  useReactFlow: () => ({ fitView: vi.fn() }),
  addEdge: vi.fn(),
  Handle: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  NodeResizer: () => null,
  getBezierPath: () => ['M0 0', 0, 0],
}))

describe('CanvasWorkspace', () => {
  it('renders empty state when no session and no shapes', () => { /* ... */ })
  it('renders ReactFlow when shapes exist', () => { /* ... */ })
  it('drains pending shapes into store', () => { /* ... */ })
  it('auto-saves after 5s debounce', () => { /* ... */ })
  it('loads shapes on session change', () => { /* ... */ })
})
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run web-portal/src/components/canvas/CanvasWorkspace.test.tsx
```

Expected: All pass.

- [ ] **Step 3: Commit**

```bash
git add web-portal/src/components/canvas/CanvasWorkspace.test.tsx
git commit -m "test(canvas): add CanvasWorkspace integration tests"
```

---

### Task 16: Expand canvas-store test coverage

**Files:**
- Modify: `web-portal/src/stores/canvas-store.test.ts`

- [ ] **Step 1: Add tests for untested store actions**

Add tests for: `selectShape`, `deselectAll`, `selectAll`, `deleteSelected`, `duplicateSelected`, `bringToFront`, `sendToBack`, `undo`, `redo`, `pushUndo`, `toggleGridSnap`, `addConnection`, `removeConnections`, `startConnecting`, `finishConnecting`, `cancelConnecting`, `layoutMode`, `setLayoutMode`.

- [ ] **Step 2: Run all store tests**

```bash
npx vitest run web-portal/src/stores/canvas-store.test.ts
```

Expected: All pass.

- [ ] **Step 3: Commit**

```bash
git add web-portal/src/stores/canvas-store.test.ts
git commit -m "test(canvas): expand canvas-store test coverage for untested actions"
```

---

### Task 17: Accessibility improvements

**Files:**
- Modify: `web-portal/src/components/canvas/canvas-toolbar.tsx`
- Modify: `web-portal/src/components/canvas/canvas-context-menu.tsx`
- Modify: `web-portal/src/components/canvas/BaseCard.tsx`

- [ ] **Step 1: Add ARIA labels to toolbar buttons**

Ensure all toolbar buttons have `aria-label` attributes. Add `role="toolbar"` to the toolbar container.

- [ ] **Step 2: Add ARIA roles to context menu**

Add `role="menu"` to the context menu container and `role="menuitem"` to each item.

- [ ] **Step 3: Add aria-label to BaseCard handles**

Add `aria-label="Connect from this card"` to source Handle and `aria-label="Connect to this card"` to target Handle.

- [ ] **Step 4: Run lint and TypeScript**

```bash
npx tsc --noEmit --pretty
npm run lint:portal
```

Expected: Clean.

- [ ] **Step 5: Commit**

```bash
git add web-portal/src/components/canvas/
git commit -m "a11y(canvas): add ARIA labels, roles, and keyboard navigation support"
```

---

### Task 18: Final verification

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run web-portal/
```

Expected: All tests pass.

- [ ] **Step 2: Run full TypeScript check**

```bash
npx tsc --noEmit --pretty
```

Expected: No errors.

- [ ] **Step 3: Run portal lint**

```bash
npm run lint:portal
```

Expected: Clean.

- [ ] **Step 4: Run backend tests to verify no breakage**

```bash
npx vitest run src/
```

Expected: All backend tests pass (canvas backend untouched).

- [ ] **Step 5: Final commit and tag**

```bash
git add -A
git commit -m "feat(canvas): complete ReactFlow canvas redevelopment

- ReactFlow replaces custom canvas engine
- BaseCard + 5 TypeRenderers for all 13 card types
- dagre layout engine: Flow, Kanban, Freeform modes
- Bidirectional agent-user communication via canvas:user_shapes
- Full accessibility: ARIA labels, keyboard navigation
- React.memo, ReactFlow virtualization for performance
- Comprehensive test coverage"
```

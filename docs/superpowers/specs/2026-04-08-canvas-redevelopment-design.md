# Canvas Redevelopment Design Spec

**Date:** 2026-04-08
**Status:** Draft
**Approach:** ReactFlow-based rebuild with dagre layout engine and 21st.dev components

## Problem Statement

The Canvas workspace has critical UX and architecture issues:
- Cards overlap (no collision detection in auto-placement)
- No group drag for multi-selection
- Layout engine stub (`pendingLayout` values ignored)
- No card-level memoization or virtualization
- Zero accessibility (ARIA, keyboard navigation)
- God component (`CanvasPanel.tsx` at 781 LOC)
- 12 of 15 components untested

## Design Decisions (from brainstorm)

| Decision | Choice |
|---|---|
| Primary use case | Agent workspace + light user interaction |
| Communication | Bidirectional: user shapes notify agent via `canvas:user_shapes` |
| Layout modes | Switchable: Flow / Kanban / Freeform with context-aware defaults |
| Card system | Extensible BaseCard + TypeRenderer pattern (all 13 types preserved) |
| External deps | ReactFlow (@xyflow/react) + dagre (@dagrejs/dagre) + 21st.dev components |

## Architecture

```
CanvasWorkspace (~150 LOC, thin orchestrator)
 ├── CanvasToolbar (add shapes, undo/redo, layout selector, grid snap)
 ├── ReactFlowProvider
 │    └── ReactFlowCanvas
 │         ├── Custom Nodes: BaseCard → TypeRenderer
 │         ├── Custom Edges: GradientBezierEdge
 │         └── Background (dot grid)
 ├── MiniMap (ReactFlow native)
 └── CanvasControls (zoom +/-, fit, fullscreen)
```

### Preserved (no changes)

- `canvas-store.ts` — Zustand store, pending queue, undo/redo, localStorage persistence
- `canvas-shape-normalizer.ts` — Agent payload validation/coercion (14 types, tested)
- `canvas-shape-normalizer.test.ts` — 394 LOC test suite
- `canvas-store.test.ts` — 153 LOC test suite
- Backend: `canvas-routes.ts`, `canvas-storage.ts` (SQLite), `monitor-bridge.ts`
- WS protocol: all `canvas:*` events unchanged
- Supervisor integration: `supervisor-feedback.ts` canvas shape builders
- i18n: `canvas.json` across 8 locales

### Rewritten

| Old file | New file(s) | Reason |
|---|---|---|
| `CanvasPanel.tsx` (781 LOC) | `CanvasWorkspace.tsx` (~150 LOC) | ReactFlow handles pan/zoom/drag/selection |
| `canvas-viewport.tsx` (105 LOC) | Deleted | ReactFlow native viewport |
| `canvas-cards.tsx` (398 LOC) | `BaseCard.tsx` + 5 TypeRenderers | Extensible pattern, React.memo |
| `canvas-connections.tsx` (130 LOC) | `GradientBezierEdge.tsx` (~60 LOC) | ReactFlow custom edge |
| `canvas-minimap.tsx` (53 LOC) | Deleted | ReactFlow `<MiniMap>` |
| `canvas-controls.tsx` (29 LOC) | `CanvasControls.tsx` (~40 LOC) | ReactFlow `<Controls>` + layout selector |
| `selection-overlay.tsx` (73 LOC) | Deleted | ReactFlow native selection + `@reactflow/node-resizer` |
| `canvas-helpers.ts` (192 LOC) | `layout-engine.ts` (~120 LOC) | dagre-based Flow/Kanban layout |
| `editable-card.tsx` (226 LOC) | `EditableCard.tsx` (~150 LOC) | Simplified with BaseCard integration |
| `canvas-context-menu.tsx` (73 LOC) | `CanvasContextMenu.tsx` (~60 LOC) | Preserved, minor cleanup |
| `canvas-toolbar.tsx` (152 LOC) | `CanvasToolbar.tsx` (~120 LOC) | + layout mode selector |
| `canvas-empty-state.tsx` (87 LOC) | `CanvasEmptyState.tsx` (~80 LOC) | Preserved, minor cleanup |
| `canvas-types.ts` (48 LOC) | `canvas-types.ts` (~60 LOC) | + ReactFlow node/edge type mappings |
| `card-components.ts` (34 LOC) | `card-registry.ts` (~30 LOC) | TypeRenderer registry |

### New files

| File | Purpose | LOC est. |
|---|---|---|
| `BaseCard.tsx` | Shared card shell: glassmorphism, header, content slot, footer | ~150 |
| `renderers/TextContentRenderer.tsx` | note-block, goal-summary, link-card | ~50 |
| `renderers/CodeContentRenderer.tsx` | code-block, diff-block, terminal-block | ~60 |
| `renderers/StatusContentRenderer.tsx` | task-card, error-card, test-result | ~50 |
| `renderers/DataContentRenderer.tsx` | metric-card, diagram-node | ~40 |
| `renderers/MediaContentRenderer.tsx` | image-block, file-card | ~40 |
| `layout-engine.ts` | dagre adapter: Flow, Kanban, Freeform auto-arrange | ~120 |
| `use-canvas-bridge.ts` | Hook: store ↔ ReactFlow node/edge sync | ~80 |
| `use-canvas-shortcuts.ts` | Hook: keyboard shortcuts (del, undo, redo, select-all) | ~40 |
| `GradientBezierEdge.tsx` | Custom edge with gradient + optional label | ~60 |

## Component Design

### BaseCard

```tsx
interface BaseCardProps {
  type: string           // card type string
  props: Record<string, unknown>
  source?: 'agent' | 'user'
  selected?: boolean
}

// Renders:
// ┌──────────────────────────┐
// │ [TypeBadge] [SourceDot]  │  ← header (type badge + agent/user indicator)
// │                          │
// │  <TypeRenderer />        │  ← content slot (from card-registry)
// │                          │
// │ [metadata]    [actions]  │  ← footer (optional)
// └──────────────────────────┘
```

- Wrapped in `React.memo` with shallow props comparison
- Glassmorphism: `backdrop-blur-2xl bg-white/[0.04] border-white/10 rounded-2xl`
- Each type has a unique accent color in header border
- `@reactflow/node-resizer` for resize handles (shown on selection)
- Double-click → inline edit mode (EditableCard overlay)

### TypeRenderer Registry

```tsx
// card-registry.ts
const RENDERERS: Record<string, ComponentType<RendererProps>> = {
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

Each renderer receives `{ type, props }` and renders type-specific content. The renderer distinguishes subtypes via the `type` field (e.g., CodeContentRenderer checks `type === 'diff-block'` to show diff coloring).

**Note:** The existing `connection-arrow` type (defined in normalizer + `getDefaultDimensions`) has no card component. In the new system, connections are ReactFlow edges — `connection-arrow` shapes from agents will be converted to edges in `use-canvas-bridge.ts` rather than rendered as nodes.

### Layout Engine

```tsx
// layout-engine.ts
type LayoutMode = 'flow' | 'kanban' | 'freeform'

function applyLayout(
  nodes: Node[],
  edges: Edge[],
  mode: LayoutMode,
  options?: { direction?: 'TB' | 'LR' }
): { nodes: Node[], edges: Edge[] }
```

**Flow layout (dagre):**
- Direction: LR (left-to-right) or TB (top-to-bottom)
- dagre computes positions based on edge relationships
- Goal-summary nodes get rank 0 (leftmost/topmost)
- Node spacing: `ranksep: 200, nodesep: 80`

**Kanban layout:**
- Columns by task status: `planned → in_progress → verifying → completed → failed`
- dagre with `rankdir: 'LR'`, status mapped to rank
- Non-task shapes placed in a "Notes" column at the right
- Column headers rendered as annotation nodes

**Freeform:**
- No auto-layout applied
- Grid snap (20px) available via toolbar toggle
- "Auto-arrange" button runs collision-free grid placement:
  - 4-column grid, sorted by type then creation order
  - Collision detection: if target position occupied, offset by (w + gap)

### Context-Aware Layout Defaults

When agent sends shapes, layout auto-selects based on context:

| Agent event | Default layout | Reason |
|---|---|---|
| `supervisor:plan` intent | Flow | Show task dependency graph |
| Multiple task-cards without connections | Kanban | Show status-based organization |
| Mixed shape types | Freeform | Don't force structure on diverse content |
| `canvas:arrange` with explicit layout | Use specified layout | Agent knows best |

User can override anytime via toolbar. Override persists until session change.

## Data Flow

### Store ↔ ReactFlow Bridge (`use-canvas-bridge.ts`)

The store keeps `ResolvedShape[]` and `CanvasConnection[]`. The bridge hook converts bidirectionally:

```
ResolvedShape → ReactFlow Node
  { id, type, x, y, w, h, props, source }
  →
  { id, type: 'baseCard', position: {x, y}, data: { type, props, source }, style: { width: w, height: h } }

CanvasConnection → ReactFlow Edge
  { id, from, to, label }
  →
  { id, source: from, target: to, type: 'gradientBezier', label }
```

ReactFlow changes (drag, resize, delete) → update store via `onNodesChange` / `onEdgesChange` callbacks.

### Bidirectional Agent Communication

**Agent → Canvas (existing, unchanged):**
```
Agent emits canvas:agent_draw → MonitorBridge → WS → use-dashboard-socket
→ addPendingShapes → CanvasWorkspace useEffect drains queue → store.addShape
→ use-canvas-bridge syncs to ReactFlow nodes
```

**Canvas → Agent (new):**
```
User adds shape via toolbar → store.addShape(source: 'user')
→ WS emit canvas:user_shapes { shapes, sessionId }
→ Backend relays to orchestrator
→ Agent sees user note in next reflection cycle
→ Agent incorporates into plan/backlog
```

Implementation: activate the existing `canvas:user_shapes` event type already defined in `workspace-events.ts`. Add a `useEffect` in `CanvasWorkspace` that detects new user-sourced shapes and emits the WS event.

## New Dependencies

| Package | Size (gzip) | Purpose |
|---|---|---|
| `@xyflow/react` | ~45 KB | Canvas engine: pan/zoom/drag/selection/minimap/controls |
| `@dagrejs/dagre` | ~15 KB | Graph layout algorithm for Flow/Kanban modes |

Both are well-maintained, widely used, and have TypeScript support.

21st.dev components will be evaluated during implementation for specific card animations and glassmorphism effects. If no suitable components are found, we fall back to custom Tailwind + Framer Motion.

## Accessibility

ReactFlow provides built-in:
- Keyboard navigation between nodes (Tab, Arrow keys)
- ARIA roles on nodes and edges
- Focus management
- Screen reader announcements for node selection

We add:
- `aria-label` on all toolbar/control buttons
- `role="menu"` / `role="menuitem"` on context menu
- Keyboard shortcut hints in tooltips
- Focus ring styling consistent with portal design system

## Performance

- **React.memo on BaseCard** — prevents re-render when props unchanged
- **ReactFlow built-in virtualization** — only renders nodes in viewport
- **dagre layout computed once** — cached until shapes/edges change
- **Debounced auto-save** — preserved 5s debounce from current implementation
- **Memoized selectors** — Zustand selectors for derived state (selectedSet, etc.)

## Testing Strategy

### Preserved tests (no changes needed)
- `canvas-shape-normalizer.test.ts` (394 LOC) — normalizer logic unchanged
- `canvas-store.test.ts` (153 LOC) — store actions unchanged

### Updated tests
- `CanvasPanel.test.tsx` (426 LOC) → `CanvasWorkspace.test.tsx` — mock ReactFlow, test orchestration logic (pending queue drain, auto-save, session load, layout switching)

### New tests
- `BaseCard.test.tsx` — render each of 13 types, selection state, edit mode trigger
- `layout-engine.test.ts` — dagre adapter for Flow/Kanban, collision-free freeform
- `use-canvas-bridge.test.ts` — store ↔ ReactFlow conversion, bidirectional sync
- `GradientBezierEdge.test.tsx` — edge rendering with/without labels
- `canvas-store.test.ts` additions — untested actions: selectShape, undo/redo, deleteSelected, duplicateSelected, bringToFront/sendToBack, toggleGridSnap, connections

## Migration Plan

### Phase 1: Foundation (no visual changes)
1. Install `@xyflow/react` and `@dagrejs/dagre`
2. Create `use-canvas-bridge.ts` (store ↔ ReactFlow adapter)
3. Create `layout-engine.ts` (dagre adapter)
4. Create `BaseCard.tsx` + 5 TypeRenderers
5. Create `GradientBezierEdge.tsx`

### Phase 2: Swap (visual change)
1. Create `CanvasWorkspace.tsx` replacing `CanvasPanel.tsx`
2. Wire ReactFlow: nodes, edges, minimap, controls, background
3. Wire pending queue drain, auto-save, session load
4. Delete old files: `canvas-viewport.tsx`, `canvas-minimap.tsx`, `selection-overlay.tsx`
5. Update `AppLayout.tsx` lazy import

### Phase 3: Layout Engine
1. Implement Flow layout (dagre LR/TB)
2. Implement Kanban layout (status columns)
3. Implement Freeform auto-arrange (collision-free grid)
4. Add layout selector to toolbar
5. Wire context-aware defaults
6. Activate `pendingLayout` handler in workspace

### Phase 4: Bidirectional Communication
1. Activate `canvas:user_shapes` WS event
2. Add user-shape detection in workspace
3. Backend relay to orchestrator context
4. Test agent awareness of user-added shapes

### Phase 5: Polish + Tests
1. 21st.dev component integration (card animations, transitions)
2. Accessibility audit and fixes
3. Full test suite (BaseCard, layout engine, bridge, workspace)
4. Expand canvas-store tests for untested actions
5. Performance profiling with 100+ shapes

## Success Criteria

- [ ] No card overlap on auto-placement
- [ ] Group drag works for multi-selection
- [ ] Layout switching (Flow/Kanban/Freeform) works from toolbar
- [ ] Agent shapes auto-layout based on context
- [ ] User can add shapes and agent is notified
- [ ] Keyboard navigation between cards (Tab/Arrow)
- [ ] ARIA labels on all interactive elements
- [ ] ReactFlow minimap, controls, background working
- [ ] All 13 card types render correctly in BaseCard
- [ ] Resize works via node-resizer
- [ ] Undo/redo preserved
- [ ] Auto-save preserved (5s debounce)
- [ ] 100+ shapes render without jank
- [ ] All existing normalizer and store tests still pass
- [ ] New test coverage for BaseCard, layout engine, bridge

## LOC Impact Estimate

| Category | Before | After | Delta |
|---|---|---|---|
| Canvas components | ~2,400 | ~1,100 | -1,300 |
| Canvas tests | ~970 | ~1,800 | +830 |
| New dependencies | 0 | 2 packages | +2 |
| Total canvas LOC | ~3,370 | ~2,900 | -470 |

Net reduction of ~470 LOC while gaining: layout engine, accessibility, virtualization, group drag, bidirectional communication, and significantly better test coverage.

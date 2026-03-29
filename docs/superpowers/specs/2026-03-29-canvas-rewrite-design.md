# Canvas Rewrite — Spatial Workspace

**Date:** 2026-03-29
**Status:** Approved
**Scope:** Replace tldraw-based canvas with custom spatial workspace

## Summary

Remove tldraw (~2MB) and replace with a custom infinite spatial canvas built on existing project dependencies (@dnd-kit, motion, tailwind). The canvas becomes a "thinking surface" — spatially positioned cards with connection lines, pan/zoom navigation, and agent-first content population.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Interaction model | Hybrid read-first, edit-optional | Agent output rendered beautifully by default; user edits when needed |
| Canvas engine | Custom (remove tldraw) | ~2MB bundle savings; full styling control; eliminate tldraw UI glitches |
| Layout paradigm | Infinite spatial canvas | Differentiated from chat (linear) and monitor (structured); spatial freedom |
| Empty state | Smart — agent context aware | Show active agent tasks with "Visualize" prompt; minimal when idle |
| Card count | 13 types + SVG connections | 9 original + goal-summary, error-card, test-result, link-card, metric-card |

## Architecture

```
CanvasPanel (main container — replaces tldraw wrapper)
├── CanvasEmptyState (smart empty — shown when no shapes)
│   ├── Agent context banner ("Agent working on N tasks — Visualize?")
│   └── Minimal idle state (dot grid + hint text)
├── CanvasViewport (pan/zoom layer — CSS transform: translate + scale)
│   ├── DotGrid (background — CSS radial-gradient pattern)
│   ├── ConnectionLayer (SVG overlay — dashed gradient bezier curves)
│   └── CardLayer (absolutely positioned React components)
│       └── 13 card type components (draggable via @dnd-kit)
├── CanvasControls (bottom-center — zoom in/out/fit/percentage)
└── CanvasMinimap (bottom-right — viewport indicator)
```

## Pan/Zoom System

- **Implementation:** CSS `transform: translate(panX, panY) scale(zoom)` on viewport div
- **Pan:** Pointer drag on background (not on cards) or middle-mouse drag
- **Zoom:** Wheel event with smooth interpolation toward cursor position
- **Bounds:** Min zoom 0.1, max zoom 3.0
- **Animations:** motion library for smooth camera transitions (zoom-to-fit, viewport restore)
- **Touch:** Pinch-to-zoom via pointer events

## Card Types (13)

### Existing (adapted from tldraw shapes)
1. **code-block** — Syntax-highlighted code with language badge and title
2. **diff-block** — Git diff with green/red line coloring
3. **file-card** — File path, language, line count reference
4. **diagram-node** — Architecture node with status indicator (active/idle/error/pending)
5. **terminal-block** — Shell command + output with green prompt
6. **image-block** — Image display with safe-src validation
7. **task-card** — Task with status pill and priority color bar
8. **note-block** — Free-text note with customizable accent color

### New
9. **goal-summary** — Hero card: active goal title, task progress bar, status counts (executing/failed/completed). Replaces the manual note-block workaround in `buildMonitorFallbackShapes()`.
10. **error-card** — Error message + collapsible stack trace. Red-themed. Common agent output.
11. **test-result** — Pass/fail counts, coverage percentage, failed test names. Green/red themed.
12. **link-card** — URL + title + description snippet. For documentation references.
13. **metric-card** — Numeric value + label + optional trend indicator. For budget/performance/coverage stats.

### Card Shared Behavior
- All cards are absolutely positioned on the canvas coordinate system
- All cards support drag-to-reposition via @dnd-kit
- All agent-sourced cards show an "AI" badge (top-right)
- Cards use glassmorphism styling consistent with the rest of the portal
- Each card type has a distinct border/glow color for quick visual identification
- Cards are resizable in edit mode (drag corner handle)

## Connection Lines

- Rendered as SVG in a layer between the grid and cards
- Dashed gradient lines with bezier curve auto-routing
- Defined by `{ id, from: cardId, to: cardId, label?: string }`
- Agent can specify connections via WebSocket (`canvas:connections_add`)
- Small animated dot at the target end of each connection
- Connections follow card positions when cards are dragged

## Smart Empty State

When canvas has no shapes:
1. **Check monitor store** — if `activeRootId` exists and tasks are present:
   - Show: "Agent is working on {N} tasks" with task status summary
   - "Visualize on Canvas" button → generates goal-summary + task-cards from DAG
2. **No agent context:**
   - Minimal dot grid background
   - Centered: "Drop blocks here or let the agent draw" + keyboard shortcut hints
   - Subtle "+" button for manual card creation

## Data Flow (unchanged WebSocket protocol)

```
Agent → WebSocket → dispatchWorkspaceMessage() → canvas-store
  ├── canvas:shapes_add → addPendingShapes()
  ├── canvas:shapes_update → updatePendingShapes()
  ├── canvas:shapes_remove → removePendingShapeIds()
  ├── canvas:viewport → setPendingViewport()
  ├── canvas:arrange → setPendingLayout()
  └── canvas:agent_draw → addPendingShapes() / updatePendingShapes()

canvas-store → CanvasPanel reads pending queues → applies to internal shape state
```

The WebSocket protocol and `use-dashboard-socket.ts` dispatch logic remain unchanged.

## Store Changes (canvas-store.ts)

### Remove
- `CanvasDraftState` (tldraw snapshot-based) — replace with simple shape array persistence
- `readPersistedCanvasDraft` / `persistCanvasDraft` / `clearPersistedCanvasDraft` — replace with JSON-based equivalents

### Add
- `shapes: CanvasShape[]` — current rendered shapes (moved from tldraw editor to store)
- `connections: CanvasConnection[]` — connection line definitions
- `viewport: { x: number; y: number; zoom: number }` — current viewport state
- `applyPendingMutations()` — batch-apply pending shapes/updates/removals to `shapes`

### Keep
- All pending queues (pendingShapes, pendingUpdates, pendingRemovals, pendingViewport, pendingLayout)
- localStorage persistence logic
- Session ID management

## Shape Normalizer Updates

Add cases for 4 new card types in `normalizeCanvasIncomingShape()`:
- `goal-summary`: { title, taskCount, completedCount, failedCount, executingCount }
- `error-card`: { message, stack, severity }
- `test-result`: { passed, failed, skipped, coverage, failedTests }
- `link-card`: { url, title, description }
- `metric-card`: { label, value, unit, trend }

Add connection normalization:
- `connection`: { from, to, label }

## Persistence

### Local (localStorage)
- Key: `strada-canvas-shapes:{sessionId}` — JSON array of shapes with positions
- Key: `strada-canvas-viewport:{sessionId}` — viewport { x, y, zoom }
- Draft auto-save: 250ms debounce after any change

### Server (unchanged)
- PUT `/api/canvas/:sessionId` — saves shapes JSON + viewport JSON
- GET `/api/canvas/:sessionId` — returns saved state
- The shapes field now contains simple `{ id, type, position, props }[]` instead of tldraw snapshots
- Backend routes and storage are format-agnostic (shapes is a string field) — no backend changes needed

### Migration
- On load, detect if `shapes` field contains tldraw snapshot format (has `store` key with `typeName: 'shape'` entries)
- If tldraw format: extract shapes, convert `{ type, x, y, props }` → `{ id, type, position: {x, y}, props }`
- Re-save in new format automatically

## File Changes

### Delete
- `canvas-overrides.tsx` — tldraw toolbar/context menu (replaced by CanvasControls + context menu)
- `canvas-overrides.test.tsx` — tests for tldraw overrides
- `canvas-templates.ts` — tldraw Editor-dependent templates (replaced by template data)
- `canvas-styles.css` — tldraw CSS overrides (replaced by tailwind classes)

### Rewrite
- `CanvasPanel.tsx` — complete rewrite (tldraw → custom spatial canvas)
- `CanvasPanel.test.tsx` — tests for new canvas
- `custom-shapes.tsx` → rename to `canvas-cards.tsx` — 13 React card components (no tldraw BaseBoxShapeUtil)
- `custom-shapes.test.ts` → rename to `canvas-cards.test.ts`

### New
- `canvas-viewport.tsx` — pan/zoom viewport component
- `canvas-controls.tsx` — zoom controls component
- `canvas-minimap.tsx` — minimap navigation component
- `canvas-connections.tsx` — SVG connection line layer
- `canvas-empty-state.tsx` — smart empty state component
- `canvas-types.ts` — shared TypeScript types for canvas system

### Modify
- `canvas-store.ts` — add shapes/connections/viewport state, remove tldraw draft logic
- `canvas-shape-normalizer.ts` — add 4 new card type normalizers + connection normalizer
- `canvas-welcome.tsx` — simplify or remove (replaced by canvas-empty-state)
- `use-dashboard-socket.ts` — no changes needed (protocol unchanged)
- `web-portal/package.json` — remove tldraw dependency

### Backend (no changes)
- `canvas-routes.ts` — format-agnostic, works with any JSON string
- `canvas-storage.ts` — no changes needed

## Testing Strategy

- Unit test each card component renders correctly
- Unit test pan/zoom math (transform calculations)
- Unit test shape normalizer for all 13 types + connections
- Integration test: pending shapes → rendered cards
- Integration test: smart empty state transitions
- Integration test: drag-and-drop repositioning updates store
- Keep existing canvas-store tests, update for new state shape

## Success Criteria

1. Canvas renders agent-pushed shapes as styled cards on a spatial surface
2. Pan/zoom works smoothly (wheel, drag, pinch)
3. Cards are draggable to reposition
4. Connection lines render between related cards
5. Smart empty state shows agent context when available
6. tldraw fully removed from bundle (~2MB savings)
7. All existing WebSocket canvas messages work without protocol changes
8. Existing saved canvases are migrated on load
9. All tests pass

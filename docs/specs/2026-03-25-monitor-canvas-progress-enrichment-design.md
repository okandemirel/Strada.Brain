# Monitor, Canvas & Progress Enrichment — Unified Design Spec

**Date:** 2026-03-25
**Status:** Approved
**Scope:** Event pipeline enrichment → Monitor DAG/Kanban detail, Canvas agent integration, Progress messaging

## Overview

Three interconnected improvements sharing a single enriched event pipeline:

1. **Monitor DAG/Kanban** — ExpandableNode with sub-steps, progress bars, PAOR phase indicators
2. **Canvas Agent Integration** — `draw_canvas` tool, bidirectional feedback, auto-render plans/goals, mermaid rendering
3. **Progress Messaging** — Jarvis-style narrative with milestone counters, phase-driven timing

Architecture: **Event-First** — enrich the existing WorkspaceBus event schema. All consumers (Monitor, Canvas, Chat) subscribe to the same enriched events. Zero breaking changes; all new fields are optional, all new event types are additive.

---

## 1. Enriched Event Schema

### 1.1 Extended Existing Events

**`monitor:task_update`** — existing fields preserved, new optional fields added:

```typescript
'monitor:task_update': {
  rootId: string
  nodeId: string
  status: string
  reviewStatus?: string
  // NEW (optional, backward-compatible)
  phase?: 'planning' | 'acting' | 'observing' | 'reflecting'
  progress?: { current: number; total: number; unit: string }
  elapsed?: number // ms since node started
}
```

### 1.2 New Event Types

**`monitor:substep`** — tracks steps within a node:

```typescript
'monitor:substep': {
  rootId: string
  nodeId: string
  substep: {
    id: string
    label: string        // "auth middleware analiz ediliyor"
    status: 'active' | 'done' | 'skipped'
    order: number
    files?: string[]     // ["auth.ts", "session.ts"]
  }
}
```

Consumers: Monitor (node mini-timeline), Chat (milestone counter)

**`progress:narrative`** — Jarvis-style contextual messaging:

```typescript
'progress:narrative': {
  nodeId?: string
  narrative: string      // "auth.ts'deki race condition'ı düzeltiyorum..."
  lang: string
  milestone?: {
    current: number
    total: number
    label: string        // "3/5 task tamamlandı"
  }
}
```

Consumer: Chat (streaming transient message)

**`canvas:agent_draw`** — agent's high-level drawing command (translated to existing canvas events):

```typescript
'canvas:agent_draw': {
  action: 'draw' | 'update' | 'clear' | 'annotate' | 'highlight'
  shapes: Array<{
    type: string         // existing 9 shape types
    id: string
    props: Record<string, unknown>
    position?: { x: number; y: number }
    connections?: string[] // shape IDs to connect with arrows
  }>
  layout?: 'auto' | 'grid' | 'tree' | 'flow'
  viewport?: { x: number; y: number; zoom: number }
  intent?: string        // "Architecture overview çiziyorum"
}
```

**Translation to existing pipeline:** `canvas:agent_draw` is a high-level event that gets translated in `use-dashboard-socket.ts` to the existing `canvas:shapes_add` / `canvas:shapes_update` / `canvas:shapes_remove` store methods. The translation adapter:
- `action: 'draw'` → `useCanvasStore.addPendingShapes(shapes)` (same as `canvas:shapes_add`)
- `action: 'update'` → `useCanvasStore.updatePendingShapes(shapes)` (same as `canvas:shapes_update`)
- `action: 'clear'` → `useCanvasStore.removePendingShapeIds(shapes.map(s => s.id))` (same as `canvas:shapes_remove`)
- `action: 'annotate' | 'highlight'` → `useCanvasStore.updatePendingShapes(shapes)` with highlight props
- `layout` and `viewport` fields are passed to a new `applyAgentLayout()` function in `CanvasPanel.tsx`
- `intent` is stored in `canvas-store.ts` for display as a toast notification

This avoids duplicating the existing pendingShapes pipeline while adding the richer action/layout/intent semantics.

Consumer: Canvas (via existing pendingShapes pipeline)

**`canvas:user_feedback`** — user canvas interaction → agent:

```typescript
'canvas:user_feedback': {
  action: 'select' | 'delete' | 'annotate' | 'connect'
  shapeIds: string[]
  annotation?: string    // user's note text
  snapshot?: {           // lightweight metadata, not full tldraw state
    shapeCount: number
    selectedTypes: string[]
  }
}
```

Consumer: Orchestrator (context injection)

### 1.3 Backward Compatibility

- Existing event type fields unchanged — new fields always optional
- Old frontend versions silently ignore new events
- New event types are purely additive to `workspace-events.ts`
- Existing interfaces never break

---

## 2. Monitor — DAG & Kanban Detail

### 2.1 ExpandableNode (DAG)

Replace the current flat `TaskNode` with `ExpandableNode`:

**Collapsed state (default for completed/pending nodes):**
- Label + PAOR mini-badges (4 squares) + thin progress bar
- Compact: similar height to current TaskNode

**Expanded state (auto for executing nodes):**
- Header: label + elapsed time + PAOR badge (active phase glows)
- Progress bar: gradient fill based on `progress.current / progress.total`
- Sub-step list from `monitor:substep` events:
  - Done steps: green dot, strikethrough label, file names dimmed
  - Active step: cyan pulsing dot, bold label, file name shown
  - Pending steps: hollow circle, dimmed label
- Footer: progress counter ("3/7 files") + percentage

**Behavior:**
- Executing nodes auto-expand, auto-collapse on completion
- Click-to-toggle on any node (view history of completed nodes)
- Failed nodes show red sub-step indicating where failure occurred

**PAOR Badge Colors:**
- P (Planning) = purple `#a855f7`
- A (Acting) = cyan `#22d3ee`
- O (Observing) = yellow `#fbbf24`
- R (Reflecting) = green `#4ade80`
- Active phase: glow effect + bright fill
- Completed phase: solid muted fill
- Pending phase: dim outline only

**Layout strategy:** DAGView uses two fixed height constants instead of measuring rendered DOM:
- `NODE_H_COLLAPSED = 80` (same as current `NODE_H`)
- `NODE_H_EXPANDED = 200` (accommodates header + progress bar + ~4 substeps + footer)

Kahn's algorithm layout selects height based on node status: `status === 'executing'` → `NODE_H_EXPANDED`, otherwise → `NODE_H_COLLAPSED`. When a user manually expands a completed node (`expandedByUser: true`), the layout recalculates with the expanded height for that node. This avoids ResizeObserver complexity while maintaining correct positioning.

### 2.2 Kanban Card Enhancement

Current card: title + status text only.

New card:
- Header: title + PAOR dots (6px colored circles, same color scheme)
- Active substep label: "● Fix uygulanıyor — session.ts" in cyan
- Progress bar: thin gradient bar below header
- Footer: progress counter ("3/7 files") + elapsed time
- Failed cards: red border accent + error substep shown

### 2.3 Monitor Store Changes

`monitor-store.ts` additions:

```typescript
interface MonitorTask {
  // ... existing fields
  phase?: string
  progress?: { current: number; total: number; unit: string }
  elapsed?: number
  substeps?: Array<{
    id: string
    label: string
    status: 'active' | 'done' | 'skipped'
    order: number
    files?: string[]
  }>
  expandedByUser?: boolean // manual toggle override
}
```

New event handlers in `use-dashboard-socket.ts`:
- `monitor:substep` → push to task's substeps array, sort by order
- `monitor:task_update` with phase/progress → merge into task

---

## 3. Canvas — Agent Integration

### 3.1 `draw_canvas` Tool

New tool registered in ToolRegistry:

**File:** `src/agents/tools/draw-canvas.ts`

```typescript
{
  name: 'draw_canvas',
  description: 'Draw shapes on the visual canvas for the user',
  parameters: {
    action: { type: 'string', enum: ['draw', 'update', 'clear', 'annotate', 'highlight'] },
    shapes: { type: 'array', items: { /* shape schema */ } },
    layout: { type: 'string', enum: ['auto', 'grid', 'tree', 'flow'], optional: true },
    intent: { type: 'string', optional: true }
  }
}
```

**Execution:** Emits `canvas:agent_draw` event on WorkspaceBus. Returns confirmation with shape IDs for later reference (update/annotate).

**Use cases:**
- Architecture diagrams (diagram-node + connection-arrow)
- Code review visuals (diff-block + note-block)
- Bug trace (file-card + connection chain)
- Plan visualization (task-card DAG)

### 3.2 Bidirectional Feedback

**Frontend → Backend:**

New hook `use-canvas-feedback.ts`:
- Listens to tldraw editor events (select, delete, create note-block, connect)
- Filters: move/resize are silent (layout preference, not semantic)
- 2-second debounce + batch: multiple actions collapse into single event
- Emits `canvas:user_feedback` via WebSocket to backend

**Backend processing — full routing chain:**

1. tldraw editor event → `use-canvas-feedback.ts` (debounce + filter + batch)
2. → WebSocket message `{ type: 'canvas:user_feedback', ... }` to server
3. → `src/channels/web/channel.ts` — `canvas:user_feedback` is added to the existing fall-through group at lines ~789-800 alongside `canvas:user_shapes` and `canvas:save`, which all route to `this.workspaceBusEmitter(data.type, data)`
4. → WorkspaceBus propagates to subscribers
5. → `context-builder.ts` picks up latest feedback and adds a `[Canvas Context]` section:

```
[Canvas Context]
The user selected 2 shapes on canvas: diagram-node "AuthService", diagram-node "SessionManager"
They may want to discuss or modify these components.
```

Lightweight: only action + shape metadata, never full tldraw snapshot.

### 3.3 Auto-Render: Plans & Goals

**`show_plan` enhancement:**

Canvas emission is handled by the **orchestrator post-tool-execution**, not inside `show-plan.ts` itself. This follows the established pattern (orchestrator.ts ~line 5151 already inspects tool output for `canvas:shapes_add`). The `show-plan.ts` file does not need modification.

When `show_plan` tool execution completes, the orchestrator:
1. Text plan sent to chat (existing behavior, unchanged)
2. Orchestrator inspects the plan structure and emits `canvas:agent_draw` with:
   - Each plan step → `task-card` shape
   - Step dependencies → `connection-arrow`
   - Layout: `'tree'` (top-down flow)
3. Emits `workspace:mode_suggest` { mode: 'canvas', reason: 'Plan visualization drawn on canvas' }

**Goal decomposition mirroring:**

When `monitor:dag_init` fires:
1. Monitor DAG created (existing behavior)
2. Canvas receives mirrored shapes via new handler in `CanvasPanel.tsx`
3. Each DAG node → `task-card` shape with status coloring
4. Layout: `'flow'` (left-to-right)
5. Status updates (`monitor:task_update`) sync canvas shape colors

Canvas version is an interactive copy — user can annotate, rearrange, add notes. Monitor DAG remains the authoritative real-time view.

### 3.4 Mermaid Rendering

**Current:** Mermaid code stored as text in `diagram-node` shape — not rendered.

**New:** Client-side rendering with `mermaid` npm package:

- New file: `canvas/mermaid-renderer.ts` — lazy-loads mermaid (~200KB gzipped)
- When a `diagram-node` shape has `language: 'mermaid'`, renderer converts code to SVG
- SVG is converted to a blob URL and rendered using tldraw's built-in `image` shape type (native support for URL/blob images with pan/zoom). The conversion chain: mermaid code → `mermaid.render()` → SVG string → `Blob` → `URL.createObjectURL()` → tldraw `image` shape's `src` prop
- The original `diagram-node` shape is replaced with the rendered `image` shape (same ID preserved for updates)
- Renders on shape creation and on prop update (re-renders if mermaid code changes)

**Scope boundary:** PlantUML requires server-side rendering — out of scope. Only mermaid supported.

**Dependency:** `mermaid` added to `web-portal/package.json` with lazy import to avoid first-load impact.

---

## 4. Progress Messaging — Jarvis Narrative

### 4.1 Phase-Driven Timing Model

Replace silent-first mode with phase-driven events:

| Trigger | Action |
|---------|--------|
| Phase transition (P→A, A→O, O→R) | Emit narrative message |
| Milestone change during Acting | Update existing message (no new message) |
| Short tasks (<30s) | At minimum 1 Planning narrative always sent |
| Max frequency | 1 message / 8 seconds throttle preserved |

**Config changes in `config.ts`:**

```typescript
export const DEFAULT_INTERACTION_CONFIG: InteractionConfig = {
  mode: "phase-driven",           // NEW: replaces "silent-first"
  heartbeatAfterMs: 120_000,      // Fallback only (if no phase events)
  heartbeatIntervalMs: 300_000,   // Fallback only
  narrativeEnabled: true,          // NEW
  narrativeThrottleMs: 8_000,     // NEW: min gap between messages
  escalationPolicy: "hard-blockers-only",
}
```

**Required Zod schema update:** The `InteractionConfig` Zod schema must be updated from `z.enum(["silent-first", "standard"])` to `z.enum(["silent-first", "standard", "phase-driven"])`. The TypeScript union type must match. Without this, `INTERACTION_MODE=phase-driven` will fail Zod validation and crash at startup.

**ProgressReporter guard update:** The existing guard at `progress-reporter.ts` line ~139 must be changed from:

```typescript
if (this.interaction.mode !== "silent-first" || this.interaction.heartbeatAfterMs <= 0) {
  return;
}
```

to:

```typescript
if (!["silent-first", "phase-driven"].includes(this.interaction.mode) || this.interaction.heartbeatAfterMs <= 0) {
  return;
}
```

This allows `"phase-driven"` mode into the heartbeat scheduling path. Additionally, the scheduled heartbeat callback must check a `lastNarrativeAt` timestamp (new field on ProgressReporter): if a `progress:narrative` event was emitted within the last `heartbeatAfterMs` window, the heartbeat fire is skipped. This makes the heartbeat a true fallback — it only fires when the narrative pipeline is silent.

Backward-compatible: `silent-first` and `standard` modes still work if configured explicitly.

### 4.2 Narrative Generation

**Primary: LLM-generated**

System prompt addition:

```
When transitioning between reasoning phases, emit a <progress_narrative> tag with a
brief (1-2 sentence) user-facing status update. Include what you're doing, why, and
relevant file/pattern names. Do not mention tool names. Match the user's language.
```

Parser in orchestrator extracts `<progress_narrative>` content and emits `progress:narrative` event. No extra LLM call — tag is part of the existing reasoning output.

**Fallback: Enriched templates**

When LLM doesn't produce the tag, `buildTaskProgressSummary` in `progress-signals.ts` generates template-based messages with enhancements:

- Multiple file names (up to 3, was limited to 2)
- Milestone counter from progress data: "2/4 dosya tamamlandı"
- Phase-aware prefix
- All 8 languages preserved

### 4.3 Chat UI: Narrative Bubble

New message type in web channel and frontend:

```typescript
{ type: "narrative", phase: string, narrative: string, milestone?: { current, total, label } }
```

**Render:**
- Colored left border matching phase color (P=purple, A=cyan, O=yellow, R=green)
- Phase label (uppercase, small) + milestone counter (right-aligned, monospace)
- Narrative text body
- Pulsing dot indicator for active phase

**Transient behavior:** Narrative messages disappear when final response arrives. They don't pollute chat history. Detailed history always available in Activity Feed.

**Milestone updates:** During Acting phase, milestone counter changes (1/4 → 2/4 → 3/4) update the existing narrative message in-place via `stream_update`. No new messages sent.

### 4.4 Multi-Channel Delivery

**Web channel:** Receives `progress:narrative` via WorkspaceBus → WebSocket → NarrativeBubble component (transient).

**Non-web channels (Telegram, Discord, Slack, CLI, etc.):** These channels do NOT subscribe to WorkspaceBus. Narrative delivery for non-web channels goes through the existing `ProgressReporter` which already has per-channel adapter awareness. The phase-driven timing model is implemented inside `ProgressReporter` itself — when a `progress:narrative` event fires on WorkspaceBus, `ProgressReporter` also receives it and routes to the active channel's adapter using the existing `sendProgressMessage()` method.

Rendering per channel:

| Channel | Delivery | Rendering |
|---------|----------|-----------|
| Web | WorkspaceBus → WebSocket | Styled narrative bubble (transient) |
| Telegram | ProgressReporter → adapter | Edit previous message with updated text |
| Discord | ProgressReporter → adapter | Edit embed with phase color |
| Slack | ProgressReporter → adapter | Update message via `chat.update` |
| CLI | ProgressReporter → adapter | Inline progress line (overwrite) |
| Others | ProgressReporter → adapter | Fallback to simple text |

---

## 5. File Changes Summary

### New Files

| File | Purpose |
|------|---------|
| `src/agents/tools/draw-canvas.ts` | draw_canvas tool implementation |
| `src/agents/tools/draw-canvas.test.ts` | Tool unit tests |
| `web-portal/src/hooks/use-canvas-feedback.ts` | Debounced canvas feedback emitter |
| `web-portal/src/components/canvas/mermaid-renderer.ts` | Lazy mermaid SVG renderer |
| `web-portal/src/components/monitor/ExpandableNode.tsx` | New DAG node component |
| `web-portal/src/components/chat/NarrativeBubble.tsx` | Narrative message UI |

### Modified Files

**Backend:**

| File | Changes |
|------|---------|
| `src/dashboard/workspace-events.ts` | New event type definitions |
| `src/dashboard/monitor-bridge.ts` | Forward new events + reverse route user_feedback |
| `src/dashboard/monitor-lifecycle.ts` | Enriched dag_init with phase/progress |
| `src/tasks/background-executor.ts` | Emit substep + phase with task_update |
| `src/goals/goal-executor.ts` | Progress counter emission |
| `src/agents/orchestrator.ts` | `<progress_narrative>` tag parser + canvas feedback context |
| `src/core/orchestrator-helpers/context-builder.ts` | Canvas state section |
| `src/agents/orchestrator.ts` | Also: post-`show_plan` canvas emit (existing visual detection pattern) |
| `src/agents/tool-registry.ts` | Register draw_canvas |
| `src/tasks/progress-signals.ts` | Enriched templates + milestone |
| `src/tasks/progress-reporter.ts` | Phase-driven timing model |
| `src/config/config.ts` | New timing defaults |
| `src/channels/web/channel.ts` | Narrative message type + `canvas:user_feedback` case in WS switch |

**Frontend:**

| File | Changes |
|------|---------|
| `web-portal/src/components/monitor/dag-nodes.tsx` | ExpandableNode replaces TaskNode |
| `web-portal/src/components/monitor/DAGView.tsx` | Dynamic node height layout |
| `web-portal/src/components/monitor/KanbanBoard.tsx` | Enriched card with substep/progress/PAOR |
| `web-portal/src/stores/monitor-store.ts` | Substep state tracking |
| `web-portal/src/stores/canvas-store.ts` | Feedback state + batch queue |
| `web-portal/src/components/canvas/CanvasPanel.tsx` | agent_draw handler + goal mirror + feedback |
| `web-portal/src/components/canvas/custom-shapes.tsx` | Update diagram-node to trigger mermaid render |
| `web-portal/src/hooks/use-dashboard-socket.ts` | New event dispatch handlers |
| `web-portal/package.json` | mermaid dependency |

---

## 6. Implementation Order

Recommended phased implementation:

1. **Event Schema** — Define all new types in `workspace-events.ts`, update MonitorBridge forwarding
2. **Monitor Backend** — Emit substep/phase/progress from GoalExecutor and BackgroundExecutor
3. **Monitor Frontend** — ExpandableNode, enriched Kanban cards, store changes
4. **Progress Backend** — Narrative tag parser, phase-driven timing, enriched templates
5. **Progress Frontend** — NarrativeBubble component, transient message handling
6. **Canvas Backend** — draw_canvas tool, show_plan enhancement, feedback reverse route
7. **Canvas Frontend** — agent_draw handler, feedback hook, goal mirroring, mermaid renderer

Each phase is independently testable and deployable. Earlier phases don't depend on later ones.

---

## 7. Testing Strategy

- **Event schema:** Unit tests for new type definitions and backward compatibility
- **Monitor:** Snapshot tests for ExpandableNode states (collapsed, expanded, failed), Kanban card variants
- **Progress:** Unit tests for narrative parser, template enrichment, timing model. Integration test for end-to-end phase→narrative→chat flow
- **Canvas:** Unit tests for draw_canvas tool, feedback debounce logic, mermaid renderer. Integration test for bidirectional flow
- **E2E:** Active session with goal decomposition → verify all three consumers update correctly

---

## 8. Out of Scope

- PlantUML server-side rendering (only mermaid supported)
- Collaborative multi-user canvas (single session per canvas)
- Canvas version history / undo across sessions
- Voice narration of progress messages
- Custom user-defined progress verbosity levels (future: may add verbose/normal/silent toggle)

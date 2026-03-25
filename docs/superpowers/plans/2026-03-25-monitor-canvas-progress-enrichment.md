# Monitor, Canvas & Progress Enrichment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the event pipeline to power detailed DAG/Kanban monitoring, full canvas agent integration, and Jarvis-style progress messaging.

**Architecture:** Event-First — extend WorkspaceBus with new event types (`monitor:substep`, `progress:narrative`, `canvas:agent_draw`, `canvas:user_feedback`) and enrich `monitor:task_update` with phase/progress/elapsed fields. All three consumers (Monitor, Canvas, Chat) subscribe to the same enriched events via the existing pipeline.

**Tech Stack:** TypeScript, React 19, @xyflow/react 12, tldraw 3.15, Zustand 5, mermaid (new), Zod

**Spec:** `docs/specs/2026-03-25-monitor-canvas-progress-enrichment-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/agents/tools/draw-canvas.ts` | draw_canvas tool — emits `canvas:agent_draw` events |
| `src/tests/unit/draw-canvas.test.ts` | Unit tests for draw_canvas tool |
| `web-portal/src/components/monitor/ExpandableNode.tsx` | DAG node with sub-steps, progress bar, PAOR badges |
| `web-portal/src/components/chat/NarrativeBubble.tsx` | Transient narrative message with phase color + milestone |
| `web-portal/src/hooks/use-canvas-feedback.ts` | Debounced canvas feedback emitter (tldraw to WS) |
| `web-portal/src/components/canvas/mermaid-renderer.ts` | Lazy mermaid-js SVG renderer |
| `web-portal/src/stores/narrative-store.ts` | Zustand store for transient narrative state |

### Modified Files

| File | Lines | What Changes |
|------|-------|-------------|
| `src/dashboard/workspace-events.ts` | 166 | Add 4 new event types + extend `monitor:task_update` |
| `src/dashboard/monitor-bridge.ts` | 66 | Add new events to FORWARDED_EVENTS array (lines 17-49) |
| `src/dashboard/monitor-lifecycle.ts` | 89 | Enrich `dag_init` payload |
| `src/tasks/background-executor.ts` | 951 | Emit substep + phase in onStatusChange (line 580) |
| `src/goals/goal-executor.ts` | 473 | Add progress counter to wave execution loop |
| `src/config/config.ts` | 3415 | Add `"phase-driven"` to Zod enum (line 582), new config fields |
| `src/tasks/progress-signals.ts` | 119 | Enrich templates with milestone counters |
| `src/tasks/progress-reporter.ts` | 282 | Phase-driven timing model, fix heartbeat guard (line 139) |
| `src/agents/orchestrator.ts` | 5422 | narrative tag parser + show_plan canvas emit + canvas feedback context |
| `src/agents/orchestrator-context-builder.ts` | 525 | Add `[Canvas Context]` section |
| `src/core/tool-registry.ts` | 806 | Register draw_canvas tool |
| `src/channels/web/channel.ts` | 1075 | Add `canvas:user_feedback` to WS switch (line 790) + narrative msg type |
| `web-portal/src/stores/monitor-store.ts` | 111 | Add substeps, phase, progress to MonitorTask (line 20) |
| `web-portal/src/stores/canvas-store.ts` | 47 | Add feedback state + intent + layout request |
| `web-portal/src/hooks/use-dashboard-socket.ts` | 368 | Add handlers for 4 new event types |
| `web-portal/src/components/monitor/dag-nodes.tsx` | 157 | Replace TaskNode with ExpandableNode import |
| `web-portal/src/components/monitor/DAGView.tsx` | 174 | Variable height layout (NODE_H_COLLAPSED/EXPANDED) |
| `web-portal/src/components/monitor/KanbanBoard.tsx` | 115 | Enriched card with substep, progress bar, PAOR dots |
| `web-portal/src/components/canvas/CanvasPanel.tsx` | 220 | agent_draw handler, layout engine, feedback hooks |
| `web-portal/src/components/canvas/custom-shapes.tsx` | 644 | Mermaid render trigger in DiagramNodeShapeUtil |
| `web-portal/src/components/ChatMessage.tsx` | 195 | NarrativeBubble integration |
| `web-portal/src/types/messages.ts` | 148 | Add NarrativeMessage type |
| `web-portal/package.json` | 72 | Add mermaid dependency |

---

## Phase 1: Event Schema

### Task 1: Extend WorkspaceEventMap with new event types

**Files:**
- Modify: `src/dashboard/workspace-events.ts:44-166`
- Test: `src/tests/unit/workspace-events.test.ts` (create if not exists)

- [ ] **Step 1: Write type-check test for new events**

Create `src/tests/unit/workspace-events.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { WorkspaceEventMap } from "../../dashboard/workspace-events.js";

describe("WorkspaceEventMap enrichments", () => {
  it("monitor:task_update accepts optional phase, progress, elapsed", () => {
    const event: WorkspaceEventMap["monitor:task_update"] = {
      rootId: "r1",
      nodeId: "n1",
      status: "executing",
      phase: "acting",
      progress: { current: 3, total: 7, unit: "files" },
      elapsed: 12000,
    };
    expect(event.phase).toBe("acting");
    expect(event.progress?.current).toBe(3);
    expect(event.elapsed).toBe(12000);
  });

  it("monitor:task_update works without new fields (backward compat)", () => {
    const event: WorkspaceEventMap["monitor:task_update"] = {
      rootId: "r1",
      nodeId: "n1",
      status: "completed",
    };
    expect(event.phase).toBeUndefined();
  });

  it("monitor:substep has required fields", () => {
    const event: WorkspaceEventMap["monitor:substep"] = {
      rootId: "r1",
      nodeId: "n1",
      substep: {
        id: "s1",
        label: "Analyzing auth.ts",
        status: "active",
        order: 1,
        files: ["auth.ts"],
      },
    };
    expect(event.substep.status).toBe("active");
  });

  it("progress:narrative has required fields", () => {
    const event: WorkspaceEventMap["progress:narrative"] = {
      narrative: "Fixing auth middleware",
      lang: "en",
      milestone: { current: 2, total: 5, label: "2/5 tasks" },
    };
    expect(event.milestone?.current).toBe(2);
  });

  it("canvas:agent_draw has required fields", () => {
    const event: WorkspaceEventMap["canvas:agent_draw"] = {
      action: "draw",
      shapes: [{ type: "task-card", id: "tc1", props: { title: "Fix bug" } }],
      layout: "tree",
      intent: "Plan visualization",
    };
    expect(event.action).toBe("draw");
    expect(event.shapes).toHaveLength(1);
  });

  it("canvas:user_feedback has required fields", () => {
    const event: WorkspaceEventMap["canvas:user_feedback"] = {
      action: "select",
      shapeIds: ["s1", "s2"],
      annotation: "Focus on this",
    };
    expect(event.shapeIds).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails (types don't exist yet)**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx vitest run src/tests/unit/workspace-events.test.ts`
Expected: TypeScript compilation errors for new fields/types.

- [ ] **Step 3: Add new types to WorkspaceEventMap**

In `src/dashboard/workspace-events.ts`, extend the `monitor:task_update` payload (after line 57) and add 4 new event types (before the closing brace):

Extend `monitor:task_update` — add after `reviewStatus?` field:
```typescript
  phase?: 'planning' | 'acting' | 'observing' | 'reflecting'
  progress?: { current: number; total: number; unit: string }
  elapsed?: number
```

Add new event types before closing brace (after line ~114):
```typescript
  'monitor:substep': {
    rootId: string
    nodeId: string
    substep: {
      id: string
      label: string
      status: 'active' | 'done' | 'skipped'
      order: number
      files?: string[]
    }
  }

  'progress:narrative': {
    nodeId?: string
    narrative: string
    lang: string
    milestone?: {
      current: number
      total: number
      label: string
    }
  }

  'canvas:agent_draw': {
    action: 'draw' | 'update' | 'clear' | 'annotate' | 'highlight'
    shapes: Array<{
      type: string
      id: string
      props: Record<string, unknown>
      position?: { x: number; y: number }
      connections?: string[]
    }>
    layout?: 'auto' | 'grid' | 'tree' | 'flow'
    viewport?: { x: number; y: number; zoom: number }
    intent?: string
  }

  'canvas:user_feedback': {
    action: 'select' | 'delete' | 'annotate' | 'connect'
    shapeIds: string[]
    annotation?: string
    snapshot?: {
      shapeCount: number
      selectedTypes: string[]
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx vitest run src/tests/unit/workspace-events.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/workspace-events.ts src/tests/unit/workspace-events.test.ts
git commit -m "feat(events): add substep, narrative, agent_draw, user_feedback event types"
```

### Task 2: Update MonitorBridge to forward new events

**Files:**
- Modify: `src/dashboard/monitor-bridge.ts:17-49`

- [ ] **Step 1: Add new events to FORWARDED_EVENTS array**

In `src/dashboard/monitor-bridge.ts`, add to the FORWARDED_EVENTS array (lines 17-49):

```typescript
'monitor:substep',
'progress:narrative',
'canvas:agent_draw',
```

Note: `canvas:user_feedback` is client-to-server, NOT forwarded server-to-client.

- [ ] **Step 2: Run existing monitor-bridge tests**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx vitest run src/tests/unit/monitor-bridge`
Expected: PASS (additive change).

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/monitor-bridge.ts
git commit -m "feat(bridge): forward substep, narrative, agent_draw events to WS clients"
```

---

## Phase 2: Monitor Backend

### Task 3: Emit phase and progress with monitor:task_update

**Files:**
- Modify: `src/tasks/background-executor.ts:560-597`
- Modify: `src/goals/goal-executor.ts:213-226`

- [ ] **Step 1: Add phase and progress tracking to BackgroundExecutor**

In `src/tasks/background-executor.ts`, add class fields near constructor:

```typescript
private currentPhase?: 'planning' | 'acting' | 'observing' | 'reflecting';
private nodeProgress?: Map<string, { current: number; total: number; unit: string }>;

setPhase(phase: 'planning' | 'acting' | 'observing' | 'reflecting'): void {
  this.currentPhase = phase;
}

setNodeProgress(nodeId: string, current: number, total: number, unit: string): void {
  if (!this.nodeProgress) this.nodeProgress = new Map();
  this.nodeProgress.set(nodeId, { current, total, unit });
}
```

- [ ] **Step 2: Enrich monitor:task_update emission (line 580)**

Replace the emit block at lines 577-584:

```typescript
if (this.workspaceBus) {
  this.workspaceBus.emit("monitor:task_update", {
    rootId: String(updatedTree.rootId),
    nodeId: String(updatedNode.id),
    status: String(updatedNode.status),
    reviewStatus: updatedNode.reviewStatus,
    phase: updatedNode.status === "executing"
      ? (this.currentPhase ?? "acting")
      : undefined,
    progress: this.nodeProgress?.get(String(updatedNode.id)),
    elapsed: updatedNode.startedAt
      ? Date.now() - updatedNode.startedAt
      : undefined,
  });
}
```

- [ ] **Step 3: Add progress tracking in goal-executor.ts wave loop**

In `src/goals/goal-executor.ts`, add `onProgress` to ExecutionOpts type:

```typescript
onProgress?: (nodeId: string, current: number, total: number, unit: string) => void;
```

Inside the wave execution loop (~line 412), after a node completes:

```typescript
const completedCount = [...completedIds].length + [...skippedIds].length;
const totalNodes = tree.nodes.filter(n => n.id !== tree.rootId).length;
if (opts?.onProgress) {
  opts.onProgress(String(node.id), completedCount, totalNodes, "tasks");
}
```

- [ ] **Step 4: Run existing tests**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx vitest run src/tests/unit/goal-executor src/tests/unit/background-executor`
Expected: PASS (new fields optional, additive changes).

- [ ] **Step 5: Commit**

```bash
git add src/tasks/background-executor.ts src/goals/goal-executor.ts
git commit -m "feat(monitor): emit phase, progress, elapsed with task_update events"
```

### Task 4: Emit monitor:substep events

**Files:**
- Modify: `src/tasks/background-executor.ts`
- Modify: `src/core/orchestrator-helpers/tool-execution.ts` (if exists, otherwise orchestrator.ts)

- [ ] **Step 1: Add substep emission method to BackgroundExecutor**

```typescript
emitSubstep(
  rootId: string,
  nodeId: string,
  substep: {
    id: string;
    label: string;
    status: "active" | "done" | "skipped";
    order: number;
    files?: string[];
  },
): void {
  if (this.workspaceBus) {
    this.workspaceBus.emit("monitor:substep", { rootId, nodeId, substep });
  }
}
```

- [ ] **Step 2: Hook substep emission into tool execution flow**

Before each tool call within a node, emit an "active" substep. After tool completion, emit the same substep with status "done".

The `buildSubstepLabel` helper generates user-facing labels:
- `file_read` -> "Dosya analiz ediliyor" / "Analyzing file"
- `file_write` -> "Duzenleme uygulanyor" / "Applying changes"
- `bash` -> "Komut calistirilyor" / "Running command"
- `grep_search` -> "Arama yapiliyor" / "Searching codebase"

```typescript
function buildSubstepLabel(toolName: string, lang: string): string {
  const labels: Record<string, Record<string, string>> = {
    file_read: { en: "Analyzing file", tr: "Dosya analiz ediliyor" },
    file_write: { en: "Applying changes", tr: "Duzenleme uygulaniyor" },
    bash: { en: "Running command", tr: "Komut calistiriliyor" },
    grep_search: { en: "Searching codebase", tr: "Arama yapiliyor" },
  };
  return labels[toolName]?.[lang] ?? labels[toolName]?.en ?? "Processing";
}
```

- [ ] **Step 3: Run tests**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx vitest run src/tests/unit/background-executor`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/tasks/background-executor.ts
git commit -m "feat(monitor): emit substep events during tool execution"
```

---

## Phase 3: Monitor Frontend

### Task 5: Extend MonitorTask interface and store

**Files:**
- Modify: `web-portal/src/stores/monitor-store.ts:20-33`

- [ ] **Step 1: Add new fields to MonitorTask interface**

In `web-portal/src/stores/monitor-store.ts`, extend MonitorTask (line 20):

```typescript
export interface MonitorTask {
  id: string
  nodeId: string
  title: string
  status: MonitorTaskStatus | string
  reviewStatus: MonitorReviewStatus | string
  agentId?: string
  startedAt?: number
  completedAt?: number
  dependencies?: string[]
  implementationResult?: unknown
  specReviewResult?: unknown
  qualityReviewResult?: unknown
  phase?: 'planning' | 'acting' | 'observing' | 'reflecting'
  progress?: { current: number; total: number; unit: string }
  elapsed?: number
  substeps?: Array<{
    id: string
    label: string
    status: 'active' | 'done' | 'skipped'
    order: number
    files?: string[]
  }>
  expandedByUser?: boolean
}
```

- [ ] **Step 2: Run existing store tests**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx vitest run web-portal/src/stores/monitor-store`
Expected: PASS (all new fields optional).

- [ ] **Step 3: Commit**

```bash
git add web-portal/src/stores/monitor-store.ts
git commit -m "feat(store): extend MonitorTask with phase, progress, substeps, elapsed"
```

### Task 6: Add new event handlers to use-dashboard-socket.ts

**Files:**
- Modify: `web-portal/src/hooks/use-dashboard-socket.ts:60-359`

- [ ] **Step 1: Add monitor:substep handler (after line 82)**

```typescript
case 'monitor:substep': {
  const { nodeId, substep } = payload as {
    nodeId: string
    substep: { id: string; label: string; status: 'active' | 'done' | 'skipped'; order: number; files?: string[] }
  }
  const task = useMonitorStore.getState().tasks[nodeId]
  if (task) {
    const existing = task.substeps ?? []
    const idx = existing.findIndex((s) => s.id === substep.id)
    const updated = idx >= 0
      ? existing.map((s, i) => (i === idx ? substep : s))
      : [...existing, substep].sort((a, b) => a.order - b.order)
    useMonitorStore.getState().updateTask(nodeId, { substeps: updated })
  }
  break
}
```

- [ ] **Step 2: Enrich monitor:task_update handler (line 80) to pass new fields**

```typescript
case 'monitor:task_update': {
  const { nodeId, ...updates } = payload as {
    nodeId: string; status?: string; reviewStatus?: string
    phase?: string; progress?: { current: number; total: number; unit: string }; elapsed?: number
  }
  useMonitorStore.getState().updateTask(nodeId, updates)
  break
}
```

- [ ] **Step 3: Add canvas:agent_draw translation handler (after line 141)**

```typescript
case 'canvas:agent_draw': {
  const { action, shapes, layout, intent } = payload as {
    action: string; shapes: Array<{ type: string; id: string; props: Record<string, unknown> }>
    layout?: string; intent?: string
  }
  const store = useCanvasStore.getState()
  if (action === 'draw') {
    store.addPendingShapes(shapes.map((s) => ({ ...s, source: 'agent' as const })))
  } else if (action === 'update' || action === 'annotate' || action === 'highlight') {
    store.updatePendingShapes(shapes.map((s) => ({ ...s, source: 'agent' as const })))
  } else if (action === 'clear') {
    store.removePendingShapeIds(shapes.map((s) => s.id))
  }
  if (intent) store.setAgentIntent(intent)
  if (layout) store.setRequestedLayout(layout)
  break
}
```

- [ ] **Step 4: Add progress:narrative handler**

```typescript
case 'progress:narrative': {
  const { narrative, milestone, nodeId } = payload as {
    narrative: string; nodeId?: string
    milestone?: { current: number; total: number; label: string }
  }
  const phase = nodeId ? useMonitorStore.getState().tasks[nodeId]?.phase : undefined
  useNarrativeStore.getState().setNarrative({ narrative, phase, milestone })
  break
}
```

- [ ] **Step 5: Write tests for new socket handlers**

Add test cases in `web-portal/src/hooks/use-dashboard-socket.test.ts` (create if not exists):

```typescript
describe("new event handlers", () => {
  it("monitor:substep merges substep into task", () => {
    // Setup: add a task to store, dispatch substep event
    // Assert: task.substeps array contains the substep, sorted by order
  });

  it("monitor:substep updates existing substep by id", () => {
    // Setup: task with existing substep, dispatch update with same id
    // Assert: substep updated in-place, not duplicated
  });

  it("canvas:agent_draw translates draw action to addPendingShapes", () => {
    // Dispatch agent_draw with action='draw', verify addPendingShapes called
    // Verify shapes have source='agent'
  });

  it("canvas:agent_draw translates clear action to removePendingShapeIds", () => {
    // Dispatch agent_draw with action='clear', verify removePendingShapeIds called
  });

  it("progress:narrative sets narrative store", () => {
    // Dispatch narrative event, verify useNarrativeStore state updated
  });
});
```

- [ ] **Step 6: Run all socket tests**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx vitest run web-portal/src/hooks/use-dashboard-socket`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web-portal/src/hooks/use-dashboard-socket.ts web-portal/src/hooks/use-dashboard-socket.test.ts
git commit -m "feat(socket): add handlers for substep, agent_draw, narrative events

Include unit tests for all new event handler paths."
```

### Task 7: Create ExpandableNode component

**Files:**
- Create: `web-portal/src/components/monitor/ExpandableNode.tsx`
- Modify: `web-portal/src/components/monitor/dag-nodes.tsx`
- Modify: `web-portal/src/components/monitor/DAGView.tsx:14,24-27,82-92`

- [ ] **Step 1: Create ExpandableNode.tsx**

Create `web-portal/src/components/monitor/ExpandableNode.tsx` with:
- PaorBadge sub-component (4 colored squares: P=purple, A=cyan, O=yellow, R=green; active glows, done solid, pending dim)
- SubstepList sub-component (green done dots with strikethrough, cyan active dot with pulse, hollow pending)
- ExpandableNode main component:
  - Collapsed: label + PAOR mini-badges + thin progress bar (same height as current TaskNode ~80px)
  - Expanded: header with elapsed time + PAOR badge, gradient progress bar, substep list, footer with counter + percentage
  - Auto-expand when status=executing, auto-collapse on completion
  - Click-to-toggle manual expand (stores `manualExpand` in local state)
  - Failed nodes show red substep at failure point
  - Uses existing BorderBeam for executing animation

Component structure skeleton:

```tsx
// ExpandableNode.tsx — key exports and sub-components

// Sub-component: PaorBadge({ phase, compact })
// - Renders 4 squares/dots for P/A/O/R phases
// - Colors: planning=#a855f7, acting=#22d3ee, observing=#fbbf24, reflecting=#4ade80
// - Active phase: glow + bright, done: solid muted, pending: dim outline
// - compact mode: 6px circles (for Kanban), normal: 16px labeled squares

// Sub-component: SubstepList({ substeps })
// - Renders ordered list of substeps
// - Done: green dot, strikethrough label, dimmed file name
// - Active: cyan pulsing dot, bold label, file name shown
// - Pending: hollow circle, dimmed label

// Main: ExpandableNode({ data }: NodeProps<ExpandableNodeType>)
// - data: { label, status, reviewStatus?, phase?, progress?, elapsed?, substeps? }
// - Local state: manualExpand (null=auto, true/false=override)
// - isExpanded = manualExpand ?? (status === 'executing')
// - Click toggles manualExpand
// - Collapsed: label + PaorBadge(compact) + thin progress bar (~80px)
// - Expanded: header(label+elapsed+PaorBadge) + progress bar + SubstepList + footer(counter+%)
// - Uses BorderBeam for executing animation (existing import)
// - STATUS_BORDER map: pending=tertiary, executing=accent, completed=success, failed=error
```

See brainstorming mockup at `.superpowers/brainstorm/72411-1774453840/design-2-monitor-detail.html` for exact visual specification. The implementor should match the glassmorphism styling of existing dag-nodes.tsx components (bg-surface/95, backdrop-blur, border-l-[3px]).

- [ ] **Step 2: Update DAGView.tsx**

Update nodeTypes registration (line 14):
```typescript
import { ExpandableNode } from './ExpandableNode'
const nodeTypes = { task: ExpandableNode, review: ReviewNode, gate: GateNode }
```

Update layout constants (lines 24-27):
```typescript
const NODE_W = 200
const NODE_H_COLLAPSED = 80
const NODE_H_EXPANDED = 200
const GAP_X = 60
const GAP_Y = 100
```

Update layoutNodes position calculation to select height based on status:
```typescript
const nodeHeight = (n.status === 'executing') ? NODE_H_EXPANDED : NODE_H_COLLAPSED
```

Update node data mapping (lines 82-92) to pass phase, progress, elapsed, substeps.

- [ ] **Step 3: Run monitor component tests**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx vitest run web-portal/src/components/monitor/`
Expected: PASS (update snapshots if needed).

- [ ] **Step 4: Commit**

```bash
git add web-portal/src/components/monitor/ExpandableNode.tsx web-portal/src/components/monitor/DAGView.tsx web-portal/src/components/monitor/dag-nodes.tsx
git commit -m "feat(monitor): ExpandableNode with substeps, progress bar, PAOR badges"
```

### Task 8: Enrich Kanban cards

**Files:**
- Modify: `web-portal/src/components/monitor/KanbanBoard.tsx:36-59`

- [ ] **Step 1: Update TaskCard component**

Replace TaskCard body with enriched version including:
- PAOR dots (4 colored 6px circles in header)
- Active substep label with cyan dot
- Thin gradient progress bar
- Footer with progress counter + elapsed time
- Failed cards with red border accent

- [ ] **Step 2: Run tests**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx vitest run web-portal/src/components/monitor/KanbanBoard`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add web-portal/src/components/monitor/KanbanBoard.tsx
git commit -m "feat(kanban): enriched cards with PAOR dots, active substep, progress bar"
```

---

## Phase 4: Progress Backend

### Task 9: Add "phase-driven" mode to config

**Files:**
- Modify: `src/config/config.ts:581-621,1661`

- [ ] **Step 1: Update InteractionConfig type (line 582)**

```typescript
readonly mode: "silent-first" | "standard" | "phase-driven";
```

- [ ] **Step 2: Update Zod schema enum (~line 1661)**

```typescript
z.enum(["silent-first", "standard", "phase-driven"])
```

- [ ] **Step 3: Add new fields to InteractionConfig**

```typescript
readonly narrativeEnabled?: boolean;
readonly narrativeThrottleMs?: number;
```

- [ ] **Step 4: Update DEFAULT_INTERACTION_CONFIG (line 616)**

```typescript
export const DEFAULT_INTERACTION_CONFIG: InteractionConfig = {
  mode: "phase-driven",
  heartbeatAfterMs: 120_000,
  heartbeatIntervalMs: 300_000,
  narrativeEnabled: true,
  narrativeThrottleMs: 8_000,
  escalationPolicy: "hard-blockers-only",
};
```

- [ ] **Step 5: Run config tests**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx vitest run src/tests/unit/config`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config/config.ts
git commit -m "feat(config): add phase-driven interaction mode with narrative settings"
```

### Task 10: Update ProgressReporter for phase-driven mode

**Files:**
- Modify: `src/tasks/progress-reporter.ts:139-156,191-243`

- [ ] **Step 1: Fix heartbeat guard (line 139)**

Replace lines 139-141:
```typescript
if (!["silent-first", "phase-driven"].includes(this.interaction.mode) || this.interaction.heartbeatAfterMs <= 0) {
  return;
}
```

- [ ] **Step 2: Add lastNarrativeAt tracking**

```typescript
private lastNarrativeAt = 0;

onNarrativeEmitted(): void {
  this.lastNarrativeAt = Date.now();
}
```

- [ ] **Step 3: Add fallback check in maybeSendLiveStatus**

At the start of `maybeSendLiveStatus`:
```typescript
if (this.interaction.mode === "phase-driven" &&
    Date.now() - this.lastNarrativeAt < this.interaction.heartbeatAfterMs) {
  return;
}
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx vitest run src/tests/unit/progress-reporter`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tasks/progress-reporter.ts
git commit -m "feat(progress): phase-driven timing with heartbeat fallback"
```

### Task 11: Add narrative tag parser to orchestrator

**Files:**
- Modify: `src/agents/orchestrator.ts`

- [ ] **Step 1: Add progress_narrative regex and extraction function**

```typescript
function extractNarratives(output: string): string[] {
  const re = /<progress_narrative>([\s\S]*?)<\/progress_narrative>/g;
  const narratives: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(output)) !== null) {
    const text = match[1].trim();
    if (text) narratives.push(text);
  }
  return narratives;
}
```

- [ ] **Step 2: Emit progress:narrative in the main output processing loop**

After extracting tool calls from LLM output:
```typescript
const narratives = extractNarratives(rawOutput);
for (const narrative of narratives) {
  if (this.workspaceBus) {
    this.workspaceBus.emit("progress:narrative", {
      nodeId: currentNodeId,
      narrative,
      lang: detectedLanguage ?? "en",
      milestone: this.currentProgress
        ? { current: this.currentProgress.current, total: this.currentProgress.total,
            label: `${this.currentProgress.current}/${this.currentProgress.total} ${this.currentProgress.unit}` }
        : undefined,
    });
  }
  if (this.progressReporter) {
    this.progressReporter.onNarrativeEmitted();
  }
}
```

- [ ] **Step 3: Add narrative instruction to system prompt**

Add to the PAOR system prompt section:
```
When transitioning between reasoning phases, emit a <progress_narrative> tag with a
brief (1-2 sentence) user-facing status update. Include what you're doing, why, and
relevant file/pattern names. Do not mention tool names. Match the user's language.
```

- [ ] **Step 4: Run orchestrator tests**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx vitest run src/tests/unit/orchestrator`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/orchestrator.ts
git commit -m "feat(narrative): parse <progress_narrative> tags from LLM output"
```

### Task 12: Enrich template fallback in progress-signals.ts

**Files:**
- Modify: `src/tasks/progress-signals.ts:30-90`

- [ ] **Step 1: Add milestone counter and increase file limit**

Add an optional 4th parameter `progress` to the existing `buildTaskProgressSummary` signature. Do NOT change the existing parameter types — only append:

```typescript
// Existing signature (line 30) — keep task, update, defaultLanguage unchanged:
export function buildTaskProgressSummary(
  task: Pick<Task, "title" | "prompt">,
  update: TaskProgressUpdate | undefined,
  defaultLanguage: ProgressLanguage = "en",
  progress?: { current: number; total: number; unit: string },  // NEW optional 4th param
): string {
```

At the end of the function, before returning `summary`, append milestone if available:
```typescript
if (progress) {
  summary = `${summary} — ${progress.current}/${progress.total} ${progress.unit}`;
}
```

Change file display limit from 2 to 3:
```typescript
const displayFiles = files.slice(0, 3)
```

Update all existing callers of `buildTaskProgressSummary` (in `progress-reporter.ts`) to pass the new 4th argument when progress data is available. Existing callers that don't pass it will continue to work (parameter is optional).

- [ ] **Step 2: Run tests**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx vitest run src/tests/unit/progress-signals`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tasks/progress-signals.ts
git commit -m "feat(progress): add milestone counter to template fallback"
```

---

## Phase 5: Progress Frontend

### Task 13: Create NarrativeBubble and narrative store

**Files:**
- Create: `web-portal/src/stores/narrative-store.ts`
- Create: `web-portal/src/components/chat/NarrativeBubble.tsx`
- Modify: `web-portal/src/types/messages.ts`
- Modify: `web-portal/src/components/ChatMessage.tsx`

- [ ] **Step 1: Add NarrativeMessage type to messages.ts**

After TypingMessage (line 55):
```typescript
export interface NarrativeMessage {
  type: 'narrative'
  phase?: string
  narrative: string
  milestone?: { current: number; total: number; label: string }
}
```

- [ ] **Step 2: Create narrative-store.ts**

```typescript
import { create } from 'zustand'

interface NarrativeState {
  narrative: string | null
  phase?: string
  milestone?: { current: number; total: number; label: string }
  setNarrative: (data: { narrative: string; phase?: string; milestone?: { current: number; total: number; label: string } }) => void
  clear: () => void
}

export const useNarrativeStore = create<NarrativeState>((set) => ({
  narrative: null,
  phase: undefined,
  milestone: undefined,
  setNarrative: (data) => set({ narrative: data.narrative, phase: data.phase, milestone: data.milestone }),
  clear: () => set({ narrative: null, phase: undefined, milestone: undefined }),
}))
```

- [ ] **Step 3: Create NarrativeBubble.tsx**

Phase-colored left border (P=purple, A=cyan, O=yellow, R=green), pulsing dot, phase label uppercase, milestone counter right-aligned monospace, narrative text body. Full component as designed in brainstorming visual mockup.

- [ ] **Step 4: Integrate NarrativeBubble in chat area**

In the chat message list, render NarrativeBubble at the bottom when narrative state exists. Clear narrative store when a final TextMessage/MarkdownMessage arrives (transient behavior).

- [ ] **Step 5: Commit**

```bash
git add web-portal/src/stores/narrative-store.ts web-portal/src/components/chat/NarrativeBubble.tsx web-portal/src/types/messages.ts web-portal/src/components/ChatMessage.tsx
git commit -m "feat(chat): NarrativeBubble with phase colors, milestone counter, transient display"
```

---

## Phase 6: Canvas Backend

### Task 14: Create draw_canvas tool

**Files:**
- Create: `src/agents/tools/draw-canvas.ts`
- Create: `src/tests/unit/draw-canvas.test.ts`
- Modify: `src/core/tool-registry.ts`

- [ ] **Step 1: Write failing test**

Create `src/tests/unit/draw-canvas.test.ts` with tests for:
- Correct name and description
- Emits `canvas:agent_draw` on draw action
- Returns shape IDs in result
- Rejects invalid action
- Rejects empty shapes on draw

- [ ] **Step 2: Run test to verify failure**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx vitest run src/tests/unit/draw-canvas.test.ts`
Expected: FAIL — DrawCanvasTool not found.

- [ ] **Step 3: Implement DrawCanvasTool**

Create `src/agents/tools/draw-canvas.ts`:
- Validates action against allowed set: draw, update, clear, annotate, highlight
- Validates shapes non-empty for draw action
- Emits `canvas:agent_draw` on WorkspaceBus
- Returns success with shape IDs summary

- [ ] **Step 4: Run test to verify pass**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx vitest run src/tests/unit/draw-canvas.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Register in ToolRegistry**

In `src/core/tool-registry.ts`, register DrawCanvasTool when WorkspaceBus is available:
```typescript
if (this.workspaceBus) {
  this.register(new DrawCanvasTool(this.workspaceBus), {
    category: "canvas",
    dangerous: false,
    readOnly: false,
    requiresConfirmation: false,
  });
}
```

- [ ] **Step 6: Commit**

```bash
git add src/agents/tools/draw-canvas.ts src/tests/unit/draw-canvas.test.ts src/core/tool-registry.ts
git commit -m "feat(canvas): add draw_canvas tool for agent-driven canvas drawing"
```

### Task 15: Canvas feedback ingestion + show_plan canvas emit

**Files:**
- Modify: `src/channels/web/channel.ts:789-800`
- Modify: `src/agents/orchestrator.ts:3854-3887,5150-5165`
- Modify: `src/agents/orchestrator-context-builder.ts`

- [ ] **Step 1: Add canvas:user_feedback to WS switch fall-through (line 790)**

```typescript
case "canvas:user_shapes":
case "canvas:save":
case "canvas:user_feedback":
```

- [ ] **Step 2: Add show_plan canvas emit in orchestrator post-execution**

After show_plan tool completes (~line 3887), orchestrator inspects result and emits:
```typescript
if (toolName === "show_plan" && toolResult.success && this.workspaceBus) {
  // Extract plan steps from result, emit canvas:agent_draw with tree layout
  // Emit workspace:mode_suggest { mode: 'canvas', reason: 'Plan visualization drawn on canvas' }
}
```

- [ ] **Step 3: Extend ContextBuilderDeps and add [Canvas Context] to context-builder**

First, in `src/agents/orchestrator-context-builder.ts`, extend the `ContextBuilderDeps` interface (~line 42) to accept canvas feedback:

```typescript
// Add to ContextBuilderDeps interface:
canvasFeedback?: Array<{ action: string; shapeIds: string[]; annotation?: string }>;
```

Then, in `buildContextLayers`, add a canvas context section:
```typescript
if (deps.canvasFeedback && deps.canvasFeedback.length > 0) {
  const feedback = deps.canvasFeedback[deps.canvasFeedback.length - 1];
  layers.push({
    label: "Canvas Context",
    content: `The user ${feedback.action}ed ${feedback.shapeIds.length} shape(s) on canvas: ${feedback.shapeIds.join(", ")}.${feedback.annotation ? ` Note: "${feedback.annotation}"` : ""} They may want to discuss or modify these elements.`,
    priority: 0.7,
  });
}
```

Finally, in the orchestrator where `buildContextLayers` is called, pass the accumulated canvas feedback from the WorkspaceBus listener:
```typescript
// In orchestrator.ts, where buildContextLayers is invoked:
canvasFeedback: this.canvasFeedbackBuffer,
```

Add a field and listener in the orchestrator constructor:
```typescript
private canvasFeedbackBuffer: Array<{ action: string; shapeIds: string[]; annotation?: string }> = [];

// In constructor or init:
if (this.workspaceBus) {
  this.workspaceBus.on("canvas:user_feedback", (payload) => {
    this.canvasFeedbackBuffer.push(payload);
    if (this.canvasFeedbackBuffer.length > 5) this.canvasFeedbackBuffer.shift();
  });
}
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx vitest run src/tests/unit/orchestrator`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/channels/web/channel.ts src/agents/orchestrator.ts src/agents/orchestrator-context-builder.ts
git commit -m "feat(canvas): bidirectional feedback + show_plan canvas visualization"
```

---

## Phase 7: Canvas Frontend

### Task 16: Extend canvas-store with feedback and layout state

**Files:**
- Modify: `web-portal/src/stores/canvas-store.ts`

- [ ] **Step 1: Add new state fields**

```typescript
agentIntent: null as string | null,
requestedLayout: null as string | null,
feedbackQueue: [] as Array<{ action: string; shapeIds: string[]; annotation?: string }>,
setAgentIntent: (intent: string | null) => set({ agentIntent: intent }),
setRequestedLayout: (layout: string | null) => set({ requestedLayout: layout }),
addFeedback: (fb: { action: string; shapeIds: string[]; annotation?: string }) =>
  set((s) => ({ feedbackQueue: [...s.feedbackQueue, fb] })),
clearFeedback: () => set({ feedbackQueue: [] }),
```

- [ ] **Step 2: Commit**

```bash
git add web-portal/src/stores/canvas-store.ts
git commit -m "feat(canvas-store): add agent intent, layout request, feedback queue"
```

### Task 17: Create use-canvas-feedback hook

**Files:**
- Create: `web-portal/src/hooks/use-canvas-feedback.ts`

- [ ] **Step 1: Create debounced feedback hook**

Implements:
- 2s debounce with batch merging
- Filters move/resize (non-semantic actions)
- Sends `canvas:user_feedback` via WebSocket
- Listens to tldraw editor select/delete events
- Includes lightweight snapshot (shapeCount, selectedTypes)

- [ ] **Step 2: Commit**

```bash
git add web-portal/src/hooks/use-canvas-feedback.ts
git commit -m "feat(canvas): debounced feedback hook for bidirectional interaction"
```

### Task 18: Create mermaid renderer + add dependency

**Files:**
- Create: `web-portal/src/components/canvas/mermaid-renderer.ts`
- Modify: `web-portal/src/components/canvas/custom-shapes.tsx`
- Modify: `web-portal/package.json`

- [ ] **Step 1: Install mermaid**

```bash
cd /Users/okanunico/Documents/Strada/Strada.Brain/web-portal && npm install mermaid
```

- [ ] **Step 2: Create mermaid-renderer.ts**

Lazy-loads mermaid (~200KB gzipped), initializes with dark theme and Strada colors. Exports:
- `renderMermaidToSvg(code: string): Promise<string | null>` — renders code to SVG string
- `svgToBlobUrl(svg: string): string` — converts SVG to blob URL

- [ ] **Step 3: Update DiagramNodeShapeUtil to trigger render**

In `custom-shapes.tsx`, DiagramNodeShapeUtil's component method: when `language === 'mermaid'`, call `renderMermaidToSvg`, convert to blob URL, display as `<img>` instead of raw text.

- [ ] **Step 4: Commit**

```bash
git add web-portal/package.json web-portal/package-lock.json web-portal/src/components/canvas/mermaid-renderer.ts web-portal/src/components/canvas/custom-shapes.tsx
git commit -m "feat(canvas): mermaid diagram rendering with lazy-loaded mermaid-js"
```

### Task 19: Update CanvasPanel with layout engine and feedback integration

**Files:**
- Modify: `web-portal/src/components/canvas/CanvasPanel.tsx:132-157`

- [ ] **Step 1: Update pending shapes useEffect with layout support**

Replace the existing layout logic (lines 132-157) with layout-aware positioning:
- `tree`: top-down grid layout (for plans)
- `flow`: left-to-right horizontal layout (for DAGs)
- `auto`/default: existing centered layout

Extract `createOrUpdateShape` helper to avoid duplication.

- [ ] **Step 2: Add intent toast**

When `agentIntent` changes, show toast via Sonner: `toast.info(agentIntent, { duration: 3000 })`

- [ ] **Step 3: Integrate useCanvasFeedback hook**

Connect hook to editor ref and WebSocket ref after editor mount.

- [ ] **Step 4: Run canvas tests**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx vitest run web-portal/src/components/canvas/ web-portal/src/stores/canvas-store`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web-portal/src/components/canvas/CanvasPanel.tsx
git commit -m "feat(canvas): layout engine (tree/flow/auto) + intent toast + feedback hook"
```

### Task 20: Build, deploy, and final verification

- [ ] **Step 1: Run full test suite**

```bash
cd /Users/okanunico/Documents/Strada/Strada.Brain && npx vitest run
```
Expected: All tests PASS.

- [ ] **Step 2: Build web portal**

```bash
cd /Users/okanunico/Documents/Strada/Strada.Brain/web-portal && npm run build
```
Expected: Build succeeds.

- [ ] **Step 3: Deploy static assets**

```bash
rm -rf /Users/okanunico/Documents/Strada/Strada.Brain/src/channels/web/static/assets && cp -r /Users/okanunico/Documents/Strada/Strada.Brain/web-portal/dist/* /Users/okanunico/Documents/Strada/Strada.Brain/src/channels/web/static/
```

- [ ] **Step 4: Final commit**

```bash
git add src/channels/web/static/
git commit -m "build: deploy enriched monitor, canvas, and progress UI to static assets"
```

---

## Summary

| Phase | Tasks | Focus |
|-------|-------|-------|
| 1. Event Schema | 1-2 | Type definitions + bridge forwarding |
| 2. Monitor Backend | 3-4 | Phase/progress/substep emissions |
| 3. Monitor Frontend | 5-8 | ExpandableNode, enriched Kanban, store updates |
| 4. Progress Backend | 9-12 | Phase-driven timing, narrative parser, template enrichment |
| 5. Progress Frontend | 13 | NarrativeBubble component + narrative store |
| 6. Canvas Backend | 14-15 | draw_canvas tool, feedback ingestion, show_plan emit |
| 7. Canvas Frontend | 16-20 | Feedback hook, mermaid renderer, layout engine, build |

**Total: 20 tasks, ~70 steps, 7 phases**

Each phase is independently testable. Run `npx vitest run` after each phase to catch regressions early.

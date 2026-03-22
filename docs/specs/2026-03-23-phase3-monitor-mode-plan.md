# Phase 3: Monitor Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the agent executes a goal, a real-time DAG appears in Monitor mode with mandatory review pipeline, activity feed, and intervention controls.

**Architecture:** Backend-first — WorkspaceEventMap defines all event types, a bridge relays LearningEventMap/DaemonEventMap events to the workspace bus, the monitor-bridge forwards them to WS clients via port 3000. GoalNode gets a `reviewStatus` field (separate from GoalStatus). Frontend consumes events via `useDashboardSocket` hook, renders ReactFlow DAG + dnd-kit Kanban, and provides intervention controls. ~160 new tests total.

**Tech Stack:** TypedEventBus (existing), ReactFlow (@xyflow/react 12), dnd-kit (core 6 + sortable 9), Zustand (existing), Tailwind (existing)

**Spec:** `docs/specs/2026-03-22-canvas-monitor-workspace-phased.md` (Phase 3 section)

**Rollback:** Each task commits. Final tag: `workspace-phase-3-complete`.

---

## File Structure

### New Backend Files

```
src/
  dashboard/
    workspace-events.ts                 # WorkspaceEventMap type definitions (all namespaces)
    workspace-bus.ts                    # createWorkspaceBus() factory
    learning-workspace-bridge.ts        # LearningEventMap/DaemonEventMap → WorkspaceEventMap relay
    monitor-bridge.ts                   # WorkspaceEventMap → WS client forwarding
    monitor-routes.ts                   # Monitor REST endpoints (/api/monitor/*)
```

### New Frontend Files

```
web-portal/src/
  stores/
    monitor-store.ts                    # Tasks, DAG state, activity feed
    monitor-store.test.ts
  hooks/
    use-dashboard-socket.ts             # Subscribe to workspace:* WS messages
    use-dashboard-socket.test.ts
  components/
    monitor/
      MonitorPanel.tsx                  # Main monitor view (DAG/Kanban toggle)
      DAGView.tsx                       # ReactFlow DAG visualization
      KanbanBoard.tsx                   # dnd-kit Kanban board
      ActivityFeed.tsx                  # Real-time activity stream
      TaskDetailPanel.tsx               # Task detail in secondary panel
      InterventionToolbar.tsx           # Pause/Resume/Skip/Cancel controls
      GateDialog.tsx                    # Approval gate dialog
      dag-nodes.tsx                     # Custom ReactFlow node types (Task, Review, Gate)
```

### Modified Backend Files

```
src/
  goals/types.ts                        # Add reviewStatus to GoalNode
  goals/goal-executor.ts                # Enforce review pipeline, emit workspace events
  agents/orchestrator.ts                # Receive workspace bus, emit monitor:activity
  core/bootstrap.ts                     # Create workspace bus, wire bridges
  channels/web/channel.ts               # Route workspace:* WS messages
```

### Modified Frontend Files

```
web-portal/
  package.json                          # Add @xyflow/react, @dnd-kit/core, @dnd-kit/sortable
  src/
    config/workspace-modes.ts           # Enable monitor mode
    components/workspace/PanelLayout.tsx # Route monitor mode to MonitorPanel
    App.tsx                             # Lazy import MonitorPanel
```

---

## Task 1: WorkspaceEventMap + EventBus (3a, 3b partial)

**Files:**
- Create: `src/dashboard/workspace-events.ts`
- Create: `src/dashboard/workspace-bus.ts`

- [ ] **Step 1: Define WorkspaceEventMap**

Create `src/dashboard/workspace-events.ts` with ALL namespaces upfront:

```typescript
// Monitor events (full payloads)
'monitor:dag_init': { rootId: string; nodes: unknown[]; edges: unknown[] }
'monitor:task_update': { rootId: string; nodeId: string; status: string; reviewStatus?: string }
'monitor:review_result': { rootId: string; nodeId: string; reviewType: 'spec_review' | 'quality_review'; passed: boolean; issues: unknown[]; iteration: number }
'monitor:agent_activity': { taskId?: string; action: string; tool?: string; detail: string; timestamp: number }
'monitor:gate_request': { rootId: string; nodeId: string; gateType: string; message: string }
'monitor:dag_restructure': { rootId: string; nodes: unknown[]; edges: unknown[] }

// Canvas stubs (Phase 4)
'canvas:shapes_add': unknown
'canvas:shapes_update': unknown
'canvas:shapes_remove': unknown
'canvas:viewport': unknown
'canvas:arrange': unknown

// Code stubs (Phase 5)
'code:file_open': unknown
'code:file_update': unknown
'code:terminal_output': unknown
'code:terminal_clear': unknown
'code:annotation_add': unknown
'code:annotation_clear': unknown

// Workspace
'workspace:mode_suggest': { mode: string; reason: string }
'workspace:notification': { title: string; message: string; severity: 'info' | 'warning' | 'error' }
```

- [ ] **Step 2: Create workspace bus factory**

Create `src/dashboard/workspace-bus.ts`:

```typescript
import { TypedEventBus } from '../core/event-bus'
import type { WorkspaceEventMap } from './workspace-events'

export function createWorkspaceBus(): TypedEventBus<WorkspaceEventMap> {
  return new TypedEventBus<WorkspaceEventMap>('workspace')
}
```

- [ ] **Step 3: Run backend tests (regression check)**

```bash
npm test -- --grep "event-bus" 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/workspace-events.ts src/dashboard/workspace-bus.ts
git commit -m "feat(dashboard): add WorkspaceEventMap type definitions and bus factory"
```

---

## Task 2: Learning-to-Workspace Bridge (3b)

**Files:**
- Create: `src/dashboard/learning-workspace-bridge.ts`
- Create: `src/tests/unit/learning-workspace-bridge.test.ts`

- [ ] **Step 1: Write bridge tests**

Test that:
- `tool:result` on learning bus emits `monitor:agent_activity` on workspace bus
- `goal:status-changed` on learning bus emits `monitor:task_update` on workspace bus
- `goal:started` on daemon bus emits `workspace:mode_suggest` with mode='monitor'
- Bridge can be started and stopped

- [ ] **Step 2: Implement bridge**

Create `src/dashboard/learning-workspace-bridge.ts`:

```typescript
import type { IEventBus } from '../core/event-bus'
import type { LearningEventMap } from '../core/event-bus'
import type { DaemonEventMap } from '../daemon/daemon-events'
import type { WorkspaceEventMap } from './workspace-events'

export function createLearningWorkspaceBridge(
  learningBus: IEventBus<LearningEventMap>,
  daemonBus: IEventBus<DaemonEventMap>,
  workspaceBus: IEventBus<WorkspaceEventMap>,
): { start(): void; stop(): void } {
  // Subscribe to learning events, re-emit as workspace events
  // tool:result → monitor:agent_activity
  // goal:status-changed → monitor:task_update
  // goal:started → workspace:mode_suggest { mode: 'monitor' }
}
```

- [ ] **Step 3: Run tests**
- [ ] **Step 4: Commit**

---

## Task 3: Monitor Bridge — WS Forwarding (3c)

**Files:**
- Create: `src/dashboard/monitor-bridge.ts`
- Modify: `src/channels/web/channel.ts`
- Modify: `src/core/bootstrap.ts`

- [ ] **Step 1: Create monitor bridge**

`src/dashboard/monitor-bridge.ts` subscribes to workspace bus and broadcasts `workspace:*` prefixed messages to all connected WS clients via the web channel's WebSocket.

- [ ] **Step 2: Add workspace message routing to web channel**

Modify `src/channels/web/channel.ts` to handle incoming `workspace:*` messages from clients (monitor:pause, monitor:resume, etc.) and route them to the workspace bus.

- [ ] **Step 3: Wire in bootstrap**

Modify `src/core/bootstrap.ts`:
- Create workspace bus via `createWorkspaceBus()`
- Create learning-workspace bridge
- Create monitor bridge
- Pass workspace bus to orchestrator and goal executor

- [ ] **Step 4: Run backend tests**
- [ ] **Step 5: Commit**

---

## Task 4: Review Pipeline — reviewStatus on GoalNode (3e)

**Files:**
- Modify: `src/goals/types.ts`
- Modify: `src/goals/goal-executor.ts`
- Create: `src/tests/unit/review-pipeline.test.ts`

- [ ] **Step 1: Write review pipeline tests**

Test:
- GoalNode starts with `reviewStatus: 'none'`
- After node completes, reviewStatus transitions: none → spec_review → quality_review → review_passed
- If review fails 3 times, reviewStatus becomes 'review_stuck' + gate request emitted
- Node is not considered "truly done" until reviewStatus === 'review_passed'

- [ ] **Step 2: Add reviewStatus to GoalNode type**

Modify `src/goals/types.ts`:

```typescript
export type ReviewStatus = 'none' | 'spec_review' | 'quality_review' | 'review_passed' | 'review_stuck'

// Add to GoalNode interface:
reviewStatus: ReviewStatus
reviewIterations: number
```

- [ ] **Step 3: Implement review enforcement in GoalExecutor**

Modify `src/goals/goal-executor.ts`:
- After a node reaches `completed` status, if `reviewStatus !== 'review_passed'`, initiate review
- `onStatusChange` callback now includes reviewStatus
- Add `maxReviewIterations = 3` config
- If exceeded, set `reviewStatus = 'review_stuck'` and emit `monitor:gate_request`

- [ ] **Step 4: Run tests**
- [ ] **Step 5: Commit**

---

## Task 5: Monitor REST Endpoints (3f)

**Files:**
- Create: `src/dashboard/monitor-routes.ts`
- Modify: `src/dashboard/server.ts`

- [ ] **Step 1: Create monitor routes**

`src/dashboard/monitor-routes.ts` exports a function that registers routes on the dashboard server:

```
GET  /api/monitor/dag         — current DAG state (nodes + edges)
GET  /api/monitor/tasks       — task list with status + reviewStatus
GET  /api/monitor/task/:id    — single task detail with diff + review results
GET  /api/monitor/activity    — last N activity entries
POST /api/monitor/task/:id/approve  — approve gate
POST /api/monitor/task/:id/skip     — skip task
```

- [ ] **Step 2: Register routes in dashboard server**

Modify `src/dashboard/server.ts` to call the registration function.

- [ ] **Step 3: Write route tests**
- [ ] **Step 4: Commit**

---

## Task 6: Orchestrator Workspace Event Emission (3d)

**Files:**
- Modify: `src/agents/orchestrator.ts`
- Modify: `src/goals/goal-executor.ts`

- [ ] **Step 1: Orchestrator emits monitor:activity**

Orchestrator receives workspace bus reference. On tool execution (alongside existing `tool:result`), emit `monitor:agent_activity` with tool name, action, detail.

- [ ] **Step 2: GoalExecutor emits monitor:task_update**

GoalExecutor receives workspace bus. On node status changes, emit `monitor:task_update` with nodeId, status, reviewStatus.

- [ ] **Step 3: GoalExecutor emits monitor:dag_init on goal start**

When a new goal tree is created, emit `monitor:dag_init` with full node/edge serialization.

- [ ] **Step 4: Run backend tests**
- [ ] **Step 5: Commit**

---

## Task 7: Frontend Foundation — Deps + Stores + Socket Hook (3h, 3i)

**Files:**
- Modify: `web-portal/package.json`
- Create: `web-portal/src/stores/monitor-store.ts`
- Create: `web-portal/src/stores/monitor-store.test.ts`
- Create: `web-portal/src/hooks/use-dashboard-socket.ts`

- [ ] **Step 1: Install dependencies**

```bash
cd /Users/okanunico/Documents/Strada/Strada.Brain/web-portal && npm install @xyflow/react@^12.0 @dnd-kit/core@^6.3 @dnd-kit/sortable@^9.0
```

- [ ] **Step 2: Write monitor store tests (TDD)**

Test: initial state (empty tasks, no activeRootId), addTask, updateTask, setDAG, addActivity, setActiveRootId, clearMonitor.

- [ ] **Step 3: Implement useMonitorStore**

Zustand store with:
- `tasks: Map<string, MonitorTask>` (id, nodeId, title, status, reviewStatus, etc.)
- `dag: { nodes: DagNode[], edges: DagEdge[] } | null`
- `activities: ActivityEntry[]` (max 200)
- `activeRootId: string | null`
- Actions: addTask, updateTask, setDAG, addActivity, setActiveRootId, clearMonitor

- [ ] **Step 4: Implement useDashboardSocket**

Hook that subscribes to `workspace:*` messages on the existing port 3000 WS. Uses `useWS()` to access the WebSocket, adds a message listener for workspace events, and dispatches to `useMonitorStore`.

- [ ] **Step 5: Run tests**
- [ ] **Step 6: Commit**

---

## Task 8: ReactFlow DAG View (3j)

**Files:**
- Create: `web-portal/src/components/monitor/dag-nodes.tsx`
- Create: `web-portal/src/components/monitor/DAGView.tsx`
- Create: `web-portal/src/components/monitor/MonitorPanel.tsx`
- Modify: `web-portal/src/config/workspace-modes.ts` (enable monitor)
- Modify: `web-portal/src/components/workspace/PanelLayout.tsx` (route to MonitorPanel)

- [ ] **Step 1: Create custom DAG node types**

`dag-nodes.tsx`: Three custom ReactFlow node components:
- **TaskNode**: Shows task title + status badge. Colors: pending=gray, executing=blue, completed=green, failed=red, skipped=dim
- **ReviewNode**: Shows review type + status. Colors: spec_review/quality_review=yellow, review_stuck=orange
- **GateNode**: Shows gate message. Color: waiting=orange, approved=green

- [ ] **Step 2: Create DAGView**

`DAGView.tsx`: Wraps `ReactFlow` with custom node types, edge styles, auto-layout (dagre or elkjs). Subscribes to `useMonitorStore` DAG state. Click node → emit selected task event.

- [ ] **Step 3: Create MonitorPanel**

`MonitorPanel.tsx`: Container with DAG/Kanban toggle, renders DAGView or KanbanBoard. Activity feed in secondary panel.

- [ ] **Step 4: Enable monitor mode + wire routing**

Update `workspace-modes.ts`: set monitor `enabled: true`.
Update `PanelLayout.tsx`: when mode is 'monitor', render `MonitorPanel` as primary.

- [ ] **Step 5: Verify build**
- [ ] **Step 6: Commit**

---

## Task 9: Kanban Board + Activity Feed (3k, 3l)

**Files:**
- Create: `web-portal/src/components/monitor/KanbanBoard.tsx`
- Create: `web-portal/src/components/monitor/ActivityFeed.tsx`
- Create: `web-portal/src/components/monitor/TaskDetailPanel.tsx`

- [ ] **Step 1: Create KanbanBoard**

5 columns: Backlog (pending), Working (executing), Review (spec_review/quality_review), Done (completed), Issues (failed/skipped/review_stuck). Uses `@dnd-kit/sortable` for drag reorder within same column. Cards show task title + status badge.

- [ ] **Step 2: Create ActivityFeed**

Real-time activity stream component. Shows entries from `useMonitorStore.activities`. Each entry: timestamp, icon, action description. Clickable → navigate to task.

- [ ] **Step 3: Create TaskDetailPanel**

Secondary panel showing selected task details: description, status, reviewStatus, implementation result (files, diff), review findings, gate actions.

- [ ] **Step 4: Wire secondary panel**

In MonitorPanel, when a task is selected, show TaskDetailPanel in PanelLayout's secondary slot.

- [ ] **Step 5: Verify build**
- [ ] **Step 6: Commit**

---

## Task 10: Intervention Controls + Mode Activation (3m, 3n)

**Files:**
- Create: `web-portal/src/components/monitor/InterventionToolbar.tsx`
- Create: `web-portal/src/components/monitor/GateDialog.tsx`
- Modify: `web-portal/src/hooks/use-dashboard-socket.ts`

- [ ] **Step 1: Create InterventionToolbar**

Toolbar in MonitorPanel header: Pause/Resume toggle, context menu (right-click on task) with Skip/Cancel options.

Sends WS commands: `monitor:pause`, `monitor:resume`, `monitor:skip_task { nodeId }`, `monitor:cancel_task { nodeId }`.

- [ ] **Step 2: Create GateDialog**

Radix Dialog that appears when `monitor:gate_request` event arrives. Shows gate message, Approve/Reject buttons. Sends `monitor:approve_gate { nodeId }` or `monitor:reject_gate { nodeId }`.

- [ ] **Step 3: Mode activation**

In `useDashboardSocket`, when `workspace:mode_suggest { mode: 'monitor' }` arrives, call `useWorkspaceStore.getState().suggestMode('monitor')`.

- [ ] **Step 4: Verify build + manual test flow**
- [ ] **Step 5: Commit**

---

## Task 11: Test Coverage (~160 new tests)

**Backend tests (~85):**
- `src/tests/unit/workspace-events.test.ts`: WorkspaceEventMap type validation (~5)
- `src/tests/unit/learning-workspace-bridge.test.ts`: Event bridging (~10)
- `src/tests/unit/monitor-bridge.test.ts`: WS forwarding (~10)
- `src/tests/unit/review-pipeline.test.ts`: Review status transitions (~20)
- `src/tests/unit/monitor-routes.test.ts`: REST endpoints (~25)
- `src/tests/unit/orchestrator-workspace.test.ts`: Workspace event emission (~15)

**Frontend tests (~75):**
- `web-portal/src/stores/monitor-store.test.ts`: Store operations (~15)
- `web-portal/src/hooks/use-dashboard-socket.test.ts`: Event subscription (~10)
- `web-portal/src/components/monitor/DAGView.test.tsx`: Node rendering, click (~10)
- `web-portal/src/components/monitor/KanbanBoard.test.tsx`: Column rendering, drag (~10)
- `web-portal/src/components/monitor/ActivityFeed.test.tsx`: Entry rendering, scroll (~8)
- `web-portal/src/components/monitor/InterventionToolbar.test.tsx`: Button actions (~7)
- `web-portal/src/components/monitor/GateDialog.test.tsx`: Open/close, approve/reject (~5)
- `web-portal/src/components/monitor/MonitorPanel.test.tsx`: DAG/Kanban toggle, mode activation (~10)

- [ ] **Step 1-8: Write all test files (one per step)**
- [ ] **Step 9: Run all tests**

Expected: 228 existing + ~160 new = ~388 tests pass.

- [ ] **Step 10: Commit**

---

## Task 12: Final Verification

- [ ] **Step 1: TypeScript check**

```bash
npm run --prefix web-portal typecheck && npx tsc --noEmit -p tsconfig.json
```

- [ ] **Step 2: Build**

```bash
npm run --prefix web-portal build
```

- [ ] **Step 3: All tests**

```bash
npm test && npm run --prefix web-portal test
```

- [ ] **Step 4: Git tag**

```bash
git tag workspace-phase-3-complete
```

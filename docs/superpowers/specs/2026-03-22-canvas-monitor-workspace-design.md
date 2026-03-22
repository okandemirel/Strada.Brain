# Canvas + Monitor + Code Workspace: Full AI Workspace

**Date:** 2026-03-22
**Status:** Approved
**Approach:** Clean rebuild of web portal with canvas-native architecture

---

## Context

The current web portal has 11 pages (Chat, Dashboard, Memory, Tools, Logs, etc.), WebSocket streaming, 40+ API endpoints, and a solid backend. However, the UI layer (plain CSS, emoji icons, inline styles, inconsistent patterns) cannot support the complexity of a full workspace. A comprehensive audit found 30 issues (5 critical, 11 important, 14 minor/cosmetic).

This design replaces the UI layer with a modern stack while preserving all backend APIs and page logic. It adds three new workspace modes (Monitor, Canvas, Code) alongside the existing Chat, creating a context-adaptive AI workspace.

## Design Decisions

- **Layout:** Context-adaptive — agent activity determines visible workspace, user can override
- **Canvas interaction:** Context-dependent — agent-driven in Monitor, collaborative in Chat, user-initiated in Code
- **Task model:** DAG (GoalDecomposer) + Agile review pipeline (implement → spec review → quality review)
- **Tech stack:** Full framework — tldraw, ReactFlow, Monaco, xterm.js, Tailwind, Zustand, TanStack Query, Radix/shadcn
- **Rebuild strategy:** Clean rebuild — fix 30 existing issues naturally during reconstruction

---

## 1. UI Foundation Overhaul

### 1a. Styling: Plain CSS → Tailwind CSS

All 4 CSS files (index.css, admin.css, sidebar.css, setup.css) replaced with Tailwind CSS + `@tailwindcss/typography`.

Dark/light theme via Tailwind `dark:` variant. CSS variables retained for custom properties but accessed through Tailwind utilities.

**Issues resolved:** #11 (inline styles), #17 (!important), #26 (emoji icons), #27 (theme flash), #28 (ErrorBoundary colors), #29 (undefined CSS class).

### 1b. Icons: Emoji → Lucide React

`lucide-react` — tree-shakeable SVG icon library. Only used icons enter the bundle.

Sidebar, toolbar, buttons all use consistent, theme-aware SVG icons.

### 1c. State Management: useState → Zustand

`zustand` — minimal, TypeScript-native state management.

**Stores:**
- `useWorkspaceStore` — active layout mode, panel visibilities, panel sizes, user override flag
- `useSessionStore` — chat messages, WebSocket state, active session
- `useMonitorStore` — tasks, DAG state, agent activity feed
- `useCanvasStore` — canvas snapshot reference, selection state
- `useCodeStore` — open files, active tab, terminal history

Existing `useWebSocket` hook preserved but state moved to Zustand stores.

### 1d. Data Fetching: Raw fetch → TanStack Query

`@tanstack/react-query` — caching, auto-refetch, stale-while-revalidate, automatic abort on unmount.

**Issues resolved:** #2-3 (fetch cleanup), #6-7 (auto-refresh), #13 (WS error), #15 (CSRF), #25 (excessive polling), #30 (inconsistent patterns).

Every API endpoint becomes a `useQuery` hook. Mutations via `useMutation` with automatic CSRF token header.

### 1e. UI Primitives: Custom → Radix + shadcn/ui

- `@radix-ui/react-dialog` — replaces ConfirmDialog and native `confirm()` (#4)
- `@radix-ui/react-dropdown-menu` — provider selector, context menus
- `@radix-ui/react-tabs` — tabbed panels
- `@radix-ui/react-tooltip` — tooltips
- shadcn/ui patterns (copy-paste components) — Button, Card, Badge, Input, Select

**Issues resolved:** #4 (native confirm), #18 (ARIA/accessibility — Radix is accessible by default).

### 1f. Additional Issue Fixes

| Issue | Fix |
|-------|-----|
| #1 No 404 page | Dedicated `NotFoundPage` route |
| #5 WebSocket scope | WebSocketProvider wraps entire app, setup wizard checks connection before use |
| #8 PlaceholderPage dead code | Removed |
| #9-10 Mobile nav broken | Responsive sidebar + hamburger menu + bottom tab bar |
| #12 Hardcoded cost | Provider-aware cost map from `/api/providers/capabilities` |
| #14 HMR reconnect | Stable `connect` reference via `useRef` |
| #16 SettingsPage 1000 lines | Decomposed into sub-components per section |
| #19 Array index keys | Unique log entry IDs |
| #20 console.warn | Debug flag guard |
| #21 Empty toolbar | Conditional render |
| #22 Clickable image no handler | Lightbox on click (Radix Dialog) |
| #23 Cross-boundary imports | Shared types package or API contract |
| #24 sessionStorage | `localStorage` with explicit "clear session" option |

### 1g. New Dependencies

```json
{
  "dependencies": {
    "tailwindcss": "^4.0",
    "@tailwindcss/typography": "^0.5",
    "lucide-react": "^0.500",
    "zustand": "^5.0",
    "@tanstack/react-query": "^6.0",
    "@radix-ui/react-dialog": "^1.1",
    "@radix-ui/react-dropdown-menu": "^2.1",
    "@radix-ui/react-tabs": "^1.1",
    "@radix-ui/react-tooltip": "^1.1",
    "react-resizable-panels": "^2.1",
    "@xyflow/react": "^12.0",
    "@tldraw/tldraw": "^3.0",
    "@monaco-editor/react": "^4.7",
    "@xterm/xterm": "^5.5",
    "@xterm/addon-fit": "^0.10",
    "@dnd-kit/core": "^6.3",
    "@dnd-kit/sortable": "^9.0"
  }
}
```

### 1h. Bundle Size & Lazy Loading Strategy

**Estimated bundle impact (gzipped):**
- Always loaded (~200KB): Tailwind, Zustand, TanStack Query, Radix, lucide, react-resizable-panels
- Lazy (Monitor mode): ReactFlow (~80KB), dnd-kit (~30KB)
- Lazy (Canvas mode): tldraw (~700KB-2MB)
- Lazy (Code mode): Monaco (~1-3MB loads workers separately), xterm.js (~200KB)

**Lazy loading via `React.lazy()` + `Suspense`:**

```typescript
const MonitorPanel = lazy(() => import('./components/monitor/MonitorPanel'));
const CanvasPanel = lazy(() => import('./components/canvas/CanvasPanel'));
const CodePanel = lazy(() => import('./components/code/CodePanel'));
```

Heavy dependencies (tldraw, Monaco, xterm) are ONLY loaded when their workspace mode activates for the first time. Initial page load remains lightweight (~200KB + existing React bundle). Vite automatically code-splits lazy imports into separate chunks.

Monaco workers loaded via `@monaco-editor/react`'s built-in CDN worker loader (no bundle impact).

---

## 2. Context-Adaptive Workspace Layout

### 2a. Layout Engine

`react-resizable-panels` provides the panel structure:

```
┌──────────────────────────────────────────────────┐
│ TopBar (breadcrumb, mode indicator, quick actions)│
├────────┬─────────────────────────┬───────────────┤
│        │                         │               │
│Sidebar │     Primary Panel       │  Secondary    │
│(nav +  │  (context-dependent)    │   Panel       │
│mini    │                         │  (optional)   │
│chat)   │                         │               │
│        │                         │               │
├────────┴─────────────────────────┴───────────────┤
│ StatusBar (connection, agent status, token usage) │
└──────────────────────────────────────────────────┘
```

All panels resizable, collapsible, keyboard-shortcut toggleable.

### 2b. Four Workspace Modes

| Mode | Primary Panel | Secondary Panel | Trigger |
|------|--------------|-----------------|---------|
| **Chat** | Chat view (enhanced) | — (hidden) | Default, user typing |
| **Monitor** | DAG graph + Kanban board | Activity feed + logs | Agent starts autonomous task |
| **Canvas** | tldraw workspace | Properties / preview | Visual content generated |
| **Code** | Monaco Editor (tabs) | Terminal (xterm.js) + file tree | Code review, file changes |

### 2c. Automatic Mode Switching

```typescript
interface WorkspaceState {
  mode: 'chat' | 'monitor' | 'canvas' | 'code';
  userOverride: boolean;
  panelSizes: Record<string, number>;
}
```

Auto-switch rules (via WebSocket events):
- `goal:started` event (from DaemonEventMap) → Monitor mode
- `tool:result` where `toolName` is `file_write`/`file_edit`/`git_diff` → Code mode
- Agent produces visual output (diagram, mockup) → Canvas mode
- Agent idle / task complete → Chat mode
- **User selects mode manually** → `userOverride = true`, auto-switch stops
- **User sends chat message** → override resets, returns to Chat mode

### 2d. Sidebar Redesign

Compact multi-function sidebar replacing current 11-page nav:

**Top section:** 4 mode buttons (Chat, Tasks, Canvas, Code) — always visible
**Middle section:** Admin dropdown — Dashboard, Config, Memory, Tools, Channels, Sessions, Logs, Identity, Personality, Settings (all 11 existing pages preserved)
**Bottom section:** Notifications badge, user profile/identity

**Mini chat:** Small chat input always visible in sidebar — write to agent from any mode.

### 2e. Responsive Breakpoints

| Breakpoint | Layout |
|-----------|--------|
| `≥1440px` | Full: sidebar + primary + secondary |
| `1024–1439px` | Compact: collapsed sidebar + primary + secondary as tabs |
| `768–1023px` | Tablet: bottom tab bar + single primary panel |
| `<768px` | Mobile: bottom tab bar + full screen panel + sheet overlays. **Canvas mode is view-only on mobile** (no drawing — tldraw touch precision insufficient). Code mode is read-only on mobile. |

Mobile hamburger menu for admin pages. Sheet overlays for secondary panels.

---

## 3. Monitor — DAG + Agile Review Pipeline

### 3a. DAG Visualization

`@xyflow/react` (ReactFlow) renders the interactive DAG:

**Node types:**
- **Task node** — single work unit from GoalDecomposer
- **Review node** — spec compliance or code quality review step
- **Gate node** — user approval required

**Node colors:** pending (gray), in_progress (blue), reviewing (yellow), passed (green), failed (red), blocked (orange)

Clicking a node opens task detail in the secondary panel (description, agent output, diff, review findings).

### 3b. Per-Task Mandatory Review Pipeline

Every task passes through 3 stages. **Reviews are mandatory and cannot be skipped by the agent.** Only the user can skip a review via explicit intervention (section 3d).

```
Implement → Spec Review → Code Quality Review → Done
    ↑           │ fail         │ fail
    └───────────┘              └──→ Fix → Re-review
```

**Review execution:**
- **Spec Review:** LLM call with dedicated prompt — "Does this implementation match the task spec? Check for missing requirements, extra work, misunderstandings." Uses the reviewer provider from `SupervisorExecutionStrategy`.
- **Code Quality Review:** LLM call with dedicated prompt — "Review for bugs, security, performance, maintainability." Uses the reviewer provider (different from executor when multi-provider is active).
- **Max iterations:** `maxReviewIterations = 3` per review type. If a review fails 3 times, the task status becomes `review_stuck` and a gate request is sent to the user for manual decision (approve anyway, provide guidance, or cancel).

**Enforcement:** The `GoalExecutor` transition logic enforces: `implementing → spec_review → quality_review → done`. There is no direct path from `implementing` to `done`. The agent cannot emit `monitor:task_update` with status `done` without both reviews passing. This is enforced in the backend, not the frontend.

**Backend data model:**

```typescript
interface MonitorTask {
  id: string;
  goalNodeId: string;
  title: string;
  description: string;
  status: 'pending' | 'implementing' | 'spec_review' | 'quality_review' | 'done' | 'failed' | 'skipped' | 'review_stuck';
  implementationResult?: {
    files: string[];
    diff: string;
    testsPassed?: number;
    testsFailed?: number;
  };
  specReviewResult?: {
    passed: boolean;
    issues: Array<{ file: string; line: number; message: string }>;
    iteration: number;
    maxIterations: number;
  };
  qualityReviewResult?: {
    passed: boolean;
    issues: Array<{ severity: 'critical' | 'important' | 'minor'; message: string }>;
    iteration: number;
    maxIterations: number;
  };
  agentId?: string;
  startedAt?: number;
  completedAt?: number;
  dependencies: string[];
}
```

### 3c. Activity Feed

Real-time activity stream in secondary panel:

```
15:32:04  🔨 Implementing "Create MediatR handler"
15:32:06  📄 Reading src/Handlers/PlayerHandler.cs
15:32:08  ✏️  Writing src/Handlers/InventoryHandler.cs
15:32:12  🧪 Running dotnet test --filter Inventory
15:32:15  ✅ 4/4 tests passed
15:32:16  📋 Spec compliance review starting...
15:32:20  ✅ Spec review passed
15:32:21  🔍 Code quality review starting...
15:32:25  ⚠️  1 issue: missing null check (line 42)
15:32:26  🔧 Fixing issue...
```

Each entry clickable → navigates to relevant file, diff, or review detail.

### 3d. Intervention Controls

| Action | Trigger | Result |
|--------|---------|--------|
| **Pause** | Toolbar button / `Ctrl+P` | Agent finishes current task, doesn't start next |
| **Resume** | Toolbar button | Continues from where it stopped |
| **Skip** | Right-click node → Skip | Task skipped, dependents unblocked |
| **Cancel** | Right-click node → Cancel | Task cancelled, dependents fail |
| **Redirect** | Chat message with new instructions | Agent updates plan, DAG restructures |
| **Approve gate** | Click gate node → Approve/Reject | Manual approval gate passes |
| **Reorder** | Drag task in Kanban view | Priority within same wave updated (cannot violate DAG dependencies) |

### 3e. Kanban View (Alternative)

Toggle between DAG graph and Kanban board:

4 columns: Backlog, Working, Review, Done. Cards draggable via `@dnd-kit/sortable`. Agent-driven tasks move automatically. User can add manual tasks.

---

## 4. Canvas Workspace

### 4a. Canvas Engine

`@tldraw/tldraw` — production-ready canvas with:
- Freeform drawing + shapes + text + images + embeds
- Built-in undo/redo, selection, zoom, pan
- Custom shape API for Strada-specific nodes
- Programmatic API for agent control
- Collaborative editing foundation

### 4b. Custom Canvas Shapes

| Shape | Content | Interaction |
|-------|---------|-------------|
| **CodeBlock** | Syntax-highlighted code (highlight.js — lightweight, canvas-appropriate; Monaco used only in Code mode) | Click → open in Monaco, copy button |
| **DiffBlock** | Side-by-side or inline diff | Before/after toggle, accept/reject buttons |
| **FileCard** | Filename, size, last modified | Click → open in Code mode |
| **DiagramNode** | Mermaid/PlantUML rendered SVG | Agent-generated |
| **TerminalBlock** | Command output (ANSI rendered) | Scroll, copy |
| **ImageBlock** | Screenshot, UI mockup | Zoom, annotate |
| **TaskCard** | Monitor task summary | Click → open in Monitor mode |
| **NoteBlock** | User freeform text | Markdown editing |
| **ConnectionArrow** | Relationship between blocks | Agent or user drawn |

### 4c. Agent Canvas Control

New WebSocket events:

```typescript
// Server → Client
interface CanvasCommand {
  type: 'canvas:shapes_add' | 'canvas:shapes_update' | 'canvas:shapes_remove' | 'canvas:arrange';
  shapes: CanvasShape[];
  layout?: 'auto' | 'grid' | 'tree' | 'flow';
  viewport?: { x: number; y: number; zoom: number };
}

// Client → Server
interface CanvasInteraction {
  type: 'canvas:user_shapes' | 'canvas:save';
  snapshot: string;  // tldraw JSON snapshot
}
```

Agent adds shapes based on actions:
- Writing code → CodeBlock added
- Generating diff → DiffBlock added
- Architecture analysis → DiagramNode + ConnectionArrow added

### 4d. Context-Dependent Behavior

| Mode | Canvas Behavior |
|------|----------------|
| Chat | Hidden. Auto-opens if agent produces visual content. |
| Monitor | Separate — Monitor uses ReactFlow, Canvas uses tldraw. |
| Canvas | Full workspace. User freeform + agent blocks. |
| Code | Hidden. DiffBlocks shown in secondary panel, draggable to canvas. |

### 4e. Canvas Persistence

```sql
CREATE TABLE IF NOT EXISTS canvas_states (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT,
  project_fingerprint TEXT,
  shapes TEXT NOT NULL,
  viewport TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_canvas_session ON canvas_states(session_id);
CREATE INDEX IF NOT EXISTS idx_canvas_project ON canvas_states(project_fingerprint);
```

- Per-session canvas state
- Project-level canvases shareable (same project, different sessions)
- Auto-save: debounced every 5 seconds
- API: `GET /api/canvas/:sessionId`, `PUT /api/canvas/:sessionId`

### 4f. Export

- PNG/SVG (tldraw built-in)
- Markdown (shapes → markdown document)
- JSON (raw tldraw state for backup/sharing)

---

## 5. Code Workspace

### 5a. Monaco Editor

`@monaco-editor/react` — VS Code's editor engine:

- Syntax highlighting: C#, TypeScript, JSON, YAML, XML, ShaderLab (Unity stack)
- Multi-tab: multiple files open simultaneously
- Minimap, line numbers, bracket matching, find/replace
- Read-only mode (reviewing agent output) and edit mode (user editing)
- Theme synced with Tailwind dark/light

No IntelliSense/LSP — out of scope. Syntax-level autocomplete only.

### 5b. Diff Viewer

Monaco built-in diff editor:

- Side-by-side or inline mode (toggle)
- Per-hunk accept/reject for review pipeline diffs
- Agent review findings shown as inline annotations (warning/error markers)

### 5c. Terminal

`@xterm/xterm` + `@xterm/addon-fit`:

- Renders agent's `shell_exec` output with ANSI colors
- Read-only by default (security — user instructs agent via chat)
- Build output, test results, git log rendered in terminal
- Scrollback buffer, copy support

### 5d. File Tree

Lightweight custom component (no extra dependency):

- Agent-touched files highlighted (modified: yellow, new: green, deleted: red)
- Click file → opens in Monaco
- Backend: `GET /api/workspace/files?path=<dir>` (lazy-loaded per directory)
- **Security:** Path sanitization enforced — reject `../` sequences, resolve symlinks, sandbox to project root. Denylist: `.env*`, `node_modules/`, `.git/objects/`. Max depth: 10 levels.
- Project root scan with depth limit

### 5e. Code Mode Layout

```
┌──────────┬──────────────────────────┬──────────────┐
│          │  Monaco Editor (tabs)    │  Terminal    │
│  File    │  ┌──────┬──────┬──────┐  │  (xterm.js) │
│  Tree    │  │ P.cs │ I.cs │ T.cs │  │             │
│          │  ├──────┴──────┴──────┤  │  $ dotnet   │
│  (left)  │  │                    │  │    test     │
│          │  │  code here         │  │  ✅ 4/4    │
│          │  │                    │  │  passed    │
│          │  └────────────────────┘  │             │
└──────────┴──────────────────────────┴──────────────┘
```

All panels resizable. Terminal collapsible.

### 5f. Agent Integration

| Agent Action | Code Mode Response |
|-------------|-------------------|
| `file_write` / `file_edit` | File opens in Monaco, changes highlighted |
| `shell_exec` | Output appears in terminal |
| `git_diff` | Diff viewer opens |
| `code_quality` review | Findings as inline Monaco annotations |
| `dotnet_build` / `dotnet_test` | Build/test output in terminal |

---

## 6. Backend Integration & API Layer

### 6a. WebSocket Architecture — Two Servers, Clear Separation

The codebase has **two separate WebSocket servers** with distinct responsibilities:

- **Chat WS (port 3000)** — `WebChannel` in `src/channels/web/channel.ts`. Simple text/stream protocol for chat messages, confirmations, reconnect. Remains unchanged.
- **Dashboard WS (port 3100)** — `WebSocketDashboardServer` in `src/dashboard/websocket-server.ts`. Authenticated, typed `WSMessage` protocol with command handler registry. This is where ALL new workspace events go.

**Why Dashboard WS:** It already has typed message routing (`type`/`payload`), authentication, and a command registry. The chat WS is tightly coupled to `IChannelAdapter` and should remain chat-only.

**Frontend connection:** The web portal already proxies both ports. Chat events via existing `useWebSocket` hook (port 3000). Workspace events via new `useDashboardSocket` hook (port 3100's `/ws` path).

### 6b. Dashboard WS Events (New)

**Server → Client:**

```typescript
// Monitor
'monitor:dag_init'           // full DAG state on connect
'monitor:task_update'        // single task status change
'monitor:review_result'      // spec/quality review result
'monitor:agent_activity'     // real-time agent action
'monitor:gate_request'       // approval gate waiting
'monitor:dag_restructure'    // DAG restructured (tasks added/removed)

// Canvas
'canvas:shapes_add'          // add shapes
'canvas:shapes_update'       // update shapes
'canvas:shapes_remove'       // remove shapes
'canvas:viewport'            // camera position change
'canvas:arrange'             // trigger auto-layout

// Code
'code:file_open'             // open file (path, content, language)
'code:file_update'           // update file (incremental diff)
'code:terminal_output'       // terminal output (ANSI string)
'code:terminal_clear'        // clear terminal
'code:annotation_add'        // add inline annotation
'code:annotation_clear'      // clear annotations

// Workspace
'workspace:mode_suggest'     // agent suggests mode change
'workspace:notification'     // toast notification
```

**Client → Server (registered as dashboard commands):**

```typescript
// Monitor
'monitor:pause'              // pause agent
'monitor:resume'             // resume agent
'monitor:skip_task'          // skip task (user override only)
'monitor:cancel_task'        // cancel task
'monitor:approve_gate'       // approve gate
'monitor:reject_gate'        // reject gate
'monitor:reorder'            // reorder within wave

// Canvas
'canvas:user_shapes'         // user modified shapes
'canvas:save'                // manual save

// Code
'code:accept_diff'           // accept diff hunk
'code:reject_diff'           // reject diff hunk
'code:request_file'          // request file content

// Feedback (Learning Pipeline v2)
'feedback:thumbs_up'         // positive feedback
'feedback:thumbs_down'       // negative feedback
'feedback:correction'        // correction submitted
```

### 6b. New REST Endpoints

```
Canvas:
  GET    /api/canvas/:sessionId              — load canvas state
  PUT    /api/canvas/:sessionId              — save canvas state
  DELETE /api/canvas/:sessionId              — clear canvas
  GET    /api/canvas/project/:fingerprint    — list project canvases
  POST   /api/canvas/:sessionId/export       — export to PNG/SVG/JSON

Monitor:
  GET    /api/monitor/dag                    — current DAG state
  GET    /api/monitor/tasks                  — task list (filterable)
  GET    /api/monitor/task/:id               — task detail with diff + review
  GET    /api/monitor/activity               — last N activity entries
  POST   /api/monitor/task/:id/approve       — gate approval
  POST   /api/monitor/task/:id/skip          — skip task
  POST   /api/monitor/export                 — export report to markdown

Code:
  GET    /api/workspace/files                — project file tree (lazy, path param)
  GET    /api/workspace/file                 — file content (path query param)
  GET    /api/workspace/diff/:taskId         — diff for specific task
```

### 6c. EventBus Architecture — New WorkspaceEventMap

The codebase has two event maps: `LearningEventMap` (orchestrator/learning) and `DaemonEventMap` (heartbeat/goals/triggers). Workspace events belong to neither — they are UI-facing events. A new `WorkspaceEventMap` is created:

```typescript
// src/dashboard/workspace-events.ts
export interface WorkspaceEventMap {
  // Monitor
  'monitor:activity': { taskId: string; action: string; tool?: string; detail: string; timestamp: number };
  'monitor:task_update': { taskId: string; status: string; agentId?: string };
  'monitor:review_result': { taskId: string; reviewType: 'spec_compliance' | 'code_quality'; passed: boolean; issues: unknown[] };
  'monitor:gate_request': { taskId: string; gateType: string; message: string };
  'monitor:dag_restructure': { dag: unknown };

  // Canvas
  'canvas:shapes_add': { shapes: unknown[] };
  'canvas:shapes_update': { shapes: unknown[] };
  'canvas:shapes_remove': { shapeIds: string[] };

  // Code
  'code:file_open': { path: string; content: string; language: string };
  'code:file_update': { path: string; diff: string };
  'code:terminal_output': { content: string };
  'code:annotation_add': { path: string; line: number; message: string; severity: string };

  // Workspace
  'workspace:mode_suggest': { mode: string; reason: string };
}
```

A new `TypedEventBus<WorkspaceEventMap>` instance is created at bootstrap and passed to the dashboard server. The `monitor-bridge.ts` module subscribes to this bus and forwards events to all connected Dashboard WebSocket clients.

**Orchestrator integration** — emits to workspace bus during execution:

```typescript
// In orchestrator tool execution
this.workspaceBus.emit('monitor:activity', {
  taskId, action: 'tool_execute', tool: toolName,
  detail: `Reading ${filePath}`, timestamp: Date.now(),
});

// In GoalExecutor — task lifecycle
this.workspaceBus.emit('monitor:task_update', {
  taskId: node.id, status: 'implementing', agentId: this.agentId,
});

// Canvas commands emitted as events (not response fields)
this.workspaceBus.emit('canvas:shapes_add', {
  shapes: [{ type: 'CodeBlock', content: generatedCode, language: 'csharp' }],
});
```

This replaces the fictional `OrchestratorResponse` extension — all workspace commands flow through the EventBus, consistent with existing architecture. The dashboard WS bridge forwards them to clients.

### 6d. System Prompt Additions

System prompt extended with workspace awareness:

```
When producing visual content (architecture diagrams, component relationships,
data flow), emit canvas shapes. When writing/editing files, the workspace will
automatically show the code editor. When running commands, terminal output is
shown automatically.
```

This guides the LLM to produce structured output that triggers appropriate workspace events.

---

## New Files Summary (Frontend)

| File/Directory | Purpose |
|---------------|---------|
| `web-portal/src/stores/` | Zustand stores (workspace, session, monitor, canvas, code) |
| `web-portal/src/components/workspace/` | Layout engine, TopBar, StatusBar, panel containers |
| `web-portal/src/components/monitor/` | DAGView, KanbanBoard, TaskCard, ActivityFeed, GateDialog, ReviewPanel |
| `web-portal/src/components/canvas/` | CanvasWorkspace, custom shapes (CodeBlock, DiffBlock, etc.) |
| `web-portal/src/components/code/` | CodeEditor, DiffViewer, Terminal, FileTree |
| `web-portal/src/components/ui/` | shadcn/ui primitives (Button, Card, Dialog, etc.) |
| `web-portal/src/hooks/useMonitor.ts` | Monitor WebSocket event handling |
| `web-portal/src/hooks/useCanvas.ts` | Canvas WebSocket event handling |
| `web-portal/src/hooks/useCode.ts` | Code WebSocket event handling |
| `web-portal/src/hooks/useWorkspace.ts` | Mode switching logic |
| `web-portal/src/api/` | TanStack Query hooks per endpoint |

## New Files Summary (Backend)

| File | Purpose |
|------|---------|
| `src/dashboard/monitor-routes.ts` | Monitor REST endpoints |
| `src/dashboard/canvas-routes.ts` | Canvas REST endpoints |
| `src/dashboard/workspace-routes.ts` | File tree / workspace endpoints (with path sanitization) |
| `src/dashboard/canvas-storage.ts` | Canvas SQLite persistence |
| `src/dashboard/monitor-bridge.ts` | WorkspaceEventMap → Dashboard WebSocket bridge |
| `src/dashboard/workspace-events.ts` | WorkspaceEventMap type definitions |

## Modified Files (Backend)

| File | Changes |
|------|---------|
| `src/dashboard/server.ts` | Register new route modules |
| `src/dashboard/websocket-server.ts` | Handle new event namespaces |
| `src/channels/web/channel.ts` | Proxy dashboard WS path for same-origin access |
| `src/agents/orchestrator.ts` | Emit workspace events (monitor activity, canvas shapes, code annotations) |
| `src/goals/goal-executor.ts` | Emit task lifecycle events, enforce mandatory review pipeline |
| `src/dashboard/websocket-server.ts` | Register new workspace event handlers and command handlers |

## Test Strategy

- **Zero regression:** All 3,919 existing tests must pass
- **Frontend tests (~300 tests):**
  - Component tests with Vitest + React Testing Library for each new component
  - Zustand store unit tests (5 stores × ~15 tests = ~75)
  - WebSocket event handling tests — mock Dashboard WS (~30)
  - Custom tldraw shape tests (~40)
  - Monitor DAG/Kanban interaction tests (~40)
  - Code workspace integration tests (~30)
  - Responsive layout tests at each breakpoint (~20)
  - Mode switching logic tests (~25)
  - Lazy loading / code splitting tests (~15)
- **Backend tests (~120 tests):**
  - REST endpoint tests for all new routes (~40 tests)
  - WebSocket event bridge tests (~25 tests)
  - Canvas persistence tests (~15 tests)
  - Monitor data model + review enforcement tests (~25 tests)
  - File tree security tests — path traversal, denylist, symlinks (~15 tests)
- **Integration tests:**
  - Full flow: user gives goal → DAG created → monitor shows progress → review pipeline → completion
  - Canvas: agent adds shapes → user sees them → user edits → agent receives changes
  - Code: agent writes file → Monaco shows it → user accepts diff → file updated
  - Mode switching: auto-switch on events, user override, override reset
- **Performance:**
  - Monitor DAG renders 50+ nodes at 60fps
  - Canvas handles 100+ shapes without lag
  - Monaco opens files up to 10K lines instantly
  - WebSocket event latency < 50ms end-to-end

## Out of Scope

- LSP / IntelliSense in Monaco (requires language server infrastructure)
- Multi-user collaborative editing (tldraw supports it but needs CRDT backend)
- User executing commands in terminal (security — agent-only)
- Plugin system for custom canvas shapes
- Mobile-native app (responsive web only)
- Video/screen recording of agent work

# Canvas + Monitor + Code Workspace: Phased Implementation Design

**Date:** 2026-03-22
**Status:** Approved
**Strategy:** Incremental (Foundation-First) — portal works after every phase
**Base spec:** git show 3aefcfa:docs/superpowers/specs/2026-03-22-canvas-monitor-workspace-design.md

---

## Overview

Clean rebuild of the Strada.Brain web portal into a full AI workspace with 4 context-adaptive modes (Chat, Monitor, Canvas, Code). Each phase delivers a working portal with progressively more capability.

**Current state:** 41 source files, 11 test files, React 19 + Vite 8, plain CSS (4 files), vanilla state (useState), raw fetch, 11 page routes, WebSocket chat (port 3000) + Dashboard polling (port 3100). No event bus wiring to dashboard.

**Target state:** Tailwind + Zustand + TanStack Query + Radix UI foundation. 4 workspace modes with auto-switching. ReactFlow DAG monitor with mandatory review pipeline. tldraw canvas with 9 custom shapes. Monaco editor + xterm.js terminal. ~420 new frontend + ~120 new backend tests.

---

## Phase 1: UI Foundation Overhaul

**Goal:** Migrate existing 11 pages + chat + setup wizard to modern stack. Portal looks better, works the same.

### New Dependencies

```json
{
  "tailwindcss": "^4.0",
  "@tailwindcss/typography": "^0.5",
  "lucide-react": "^0.500",
  "zustand": "^5.0",
  "@tanstack/react-query": "^6.0",
  "@radix-ui/react-dialog": "^1.1",
  "@radix-ui/react-dropdown-menu": "^2.1",
  "@radix-ui/react-tabs": "^1.1",
  "@radix-ui/react-tooltip": "^1.1"
}
```

### Work Items

| # | Item | Detail |
|---|------|--------|
| 1a | Tailwind setup | Vite plugin config, dark/light theme via `dark:` variant, CSS variables mapped to Tailwind utilities |
| 1b | CSS migration | index.css, admin.css, sidebar.css, setup.css -> Tailwind classes. Old CSS files deleted |
| 1c | Lucide icons | All emoji icons -> Lucide SVG components |
| 1d | Zustand stores | `useSessionStore` (chat messages, WS state), `useSidebarStore` (nav state). Existing useState/useContext -> Zustand |
| 1e | TanStack Query | `useDashboard` hook -> `useQuery` hooks. Raw fetch -> TanStack mutation/query. CSRF token header |
| 1f | Radix primitives | `ConfirmDialog` -> Radix Dialog, dropdown menus, tooltips |
| 1g | Existing issue fixes | #1 (404 page), #4 (native confirm), #8 (PlaceholderPage dead code), #11 (inline styles), #14 (HMR reconnect), #17 (!important), #18 (ARIA), #19 (array index keys), #20 (console.warn), #24 (sessionStorage), #26 (emoji icons), #27 (theme flash), #28 (ErrorBoundary colors), #29 (undefined CSS) |

### Not Touched

- WebSocket chat logic (useWebSocket.ts) — continues working, state moved to Zustand
- Setup wizard flow — same 5 steps, only CSS/components updated
- Dashboard polling -> TanStack Query but same endpoints

### Tests (~150 new)

- Zustand store unit tests (2 stores x ~15 = ~30)
- Radix component tests (~20)
- TanStack Query hook tests (~25)
- Migrated page snapshot/interaction tests (~50)
- Theme switching, responsive, a11y (~25)

### Exit Criteria

Portal visually improved (modern icons, consistent spacing, proper dark/light theme, accessible components), `npm run build` succeeds, 3919 backend + ~160 frontend tests pass.

---

## Phase 2: Layout Engine + Chat Mode

**Goal:** Context-adaptive panel layout. Existing 11 pages move to admin dropdown. 4 mode buttons in sidebar (only Chat active).

### New Dependencies

```json
{
  "react-resizable-panels": "^2.1"
}
```

### Work Items

| # | Item | Detail |
|---|------|--------|
| 2a | Panel layout | TopBar (breadcrumb, mode indicator, quick actions) + Primary Panel + Secondary Panel + StatusBar (connection, agent status, token usage). All resizable, collapsible |
| 2b | Sidebar redesign | Top: 4 mode buttons (Chat, Tasks, Canvas, Code) — only Chat active, others "coming soon" badge. Middle: Admin dropdown — all 11 existing pages. Bottom: Notification badge, user profile |
| 2c | Mini chat | Small chat input in sidebar — write to agent from any mode |
| 2d | `useWorkspaceStore` | Zustand store — `mode: 'chat'`, `userOverride: boolean`, `panelSizes`, panel visibilities |
| 2e | Chat mode integration | Existing ChatView -> Primary Panel. Enhanced message layout, code block styling |
| 2f | Responsive breakpoints | >=1440px: full layout. 1024-1439: collapsed sidebar + tabs. 768-1023: bottom tab bar + single panel. <768: mobile sheet overlays |
| 2g | Keyboard shortcuts | `Cmd+1/2/3/4` mode switch, `Cmd+B` sidebar toggle, `Cmd+\` secondary panel toggle |

### Not Touched

- Monitor/Canvas/Code modes — buttons exist but disabled
- Backend — no changes
- WebSocket — continues working

### Tests (~60 new)

- Layout engine panel resize/collapse (~15)
- Sidebar navigation + admin dropdown (~10)
- Mode switching logic + store (~15)
- Responsive breakpoint render tests (~10)
- Keyboard shortcut tests (~10)

### Exit Criteria

New panel-based layout works, sidebar admin dropdown provides access to all pages, mini chat functional, responsive breakpoints work, existing + ~60 new tests pass.

---

## Phase 3: Monitor Mode (Backend + Frontend)

**Goal:** When agent executes a goal, DAG appears in real-time. Review pipeline is mandatory. Activity feed streams agent actions.

### New Dependencies

```json
{
  "@xyflow/react": "^12.0",
  "@dnd-kit/core": "^6.3",
  "@dnd-kit/sortable": "^9.0"
}
```

### Backend Work Items

| # | Item | Detail |
|---|------|--------|
| 3a | `WorkspaceEventMap` | New event map — `monitor:*`, `canvas:*`, `code:*`, `workspace:*` event types. `src/dashboard/workspace-events.ts` |
| 3b | Workspace EventBus | New `TypedEventBus<WorkspaceEventMap>` instance, created at bootstrap, passed to dashboard server |
| 3c | Monitor bridge | `src/dashboard/monitor-bridge.ts` — subscribes to workspace bus, forwards to Dashboard WS clients |
| 3d | Orchestrator integration | `tool:result` also emits `monitor:activity`. `goal:status-changed` -> `monitor:task_update`. GoalExecutor review pipeline enforcement |
| 3e | Review pipeline | GoalExecutor transition: `implementing -> spec_review -> quality_review -> done`. No direct path to done. `maxReviewIterations = 3`, then `review_stuck` + gate request |
| 3f | Monitor REST endpoints | `GET /api/monitor/dag`, `GET /api/monitor/tasks`, `GET /api/monitor/task/:id`, `GET /api/monitor/activity`, `POST /api/monitor/task/:id/approve`, `POST /api/monitor/task/:id/skip` |
| 3g | Dashboard WS events | Server->Client: `monitor:dag_init`, `monitor:task_update`, `monitor:review_result`, `monitor:agent_activity`, `monitor:gate_request`, `monitor:dag_restructure`. Client->Server: `monitor:pause`, `monitor:resume`, `monitor:skip_task`, `monitor:cancel_task`, `monitor:approve_gate`, `monitor:reject_gate` |

### Frontend Work Items

| # | Item | Detail |
|---|------|--------|
| 3h | `useMonitorStore` | Zustand — tasks, DAG state, activity feed |
| 3i | `useDashboardSocket` | Dashboard WS hook (port 3100) — monitor event subscription |
| 3j | DAG View | ReactFlow interactive DAG. Node types: Task (blue/green/red), Review (yellow), Gate (orange). Click -> detail panel |
| 3k | Activity Feed | Secondary panel real-time stream. Each entry clickable -> navigate to task/file |
| 3l | Kanban View | Toggle: DAG <-> Kanban. 4 columns: Backlog, Working, Review, Done. dnd-kit drag |
| 3m | Intervention controls | Pause/Resume toolbar, right-click Skip/Cancel, gate Approve/Reject dialog |
| 3n | Mode activation | Tasks sidebar button active. `goal:started` event -> auto-switch to Monitor mode |

### Tests (~160 new)

- Backend: REST endpoints (~25), WS event bridge (~15), review enforcement (~20), monitor data model (~15)
- Frontend: DAG render + interaction (~25), Kanban drag (~15), activity feed (~15), intervention controls (~15), store tests (~15)

### Exit Criteria

When agent executes a goal, Monitor mode auto-opens, DAG updates in real-time, review pipeline is mandatory, pause/resume/skip/approve work, all tests pass.

---

## Phase 4: Canvas Mode

**Goal:** Agent visual output (diagrams, code blocks, diffs) triggers canvas. User can freeform draw. Canvas persists per-session.

### New Dependencies

```json
{
  "@tldraw/tldraw": "^3.0"
}
```

Lazy loaded (~700KB-2MB) — only loads when canvas mode first activates.

### Backend Work Items

| # | Item | Detail |
|---|------|--------|
| 4a | Canvas persistence | `src/dashboard/canvas-storage.ts` — SQLite table `canvas_states` (id, session_id, user_id, project_fingerprint, shapes, viewport, timestamps). Indexes: session_id, project_fingerprint |
| 4b | Canvas REST endpoints | `GET /api/canvas/:sessionId`, `PUT /api/canvas/:sessionId`, `DELETE /api/canvas/:sessionId`, `GET /api/canvas/project/:fingerprint`, `POST /api/canvas/:sessionId/export` |
| 4c | Canvas WS events | Server->Client: `canvas:shapes_add`, `canvas:shapes_update`, `canvas:shapes_remove`, `canvas:viewport`, `canvas:arrange`. Client->Server: `canvas:user_shapes`, `canvas:save` |
| 4d | Orchestrator canvas emit | Code write -> CodeBlock shape, diff -> DiffBlock shape, architecture analysis -> DiagramNode + ConnectionArrow. `workspaceBus.emit('canvas:shapes_add', ...)` |

### Frontend Work Items

| # | Item | Detail |
|---|------|--------|
| 4e | `useCanvasStore` | Zustand — canvas snapshot ref, selection state, dirty flag |
| 4f | Canvas panel | `React.lazy(() => import('./canvas/CanvasPanel'))` + Suspense. tldraw full workspace |
| 4g | 9 custom shapes | CodeBlock (syntax highlighted), DiffBlock (before/after toggle), FileCard, DiagramNode, TerminalBlock, ImageBlock, TaskCard, NoteBlock, ConnectionArrow |
| 4h | Agent canvas control | `useDashboardSocket` canvas event subscription -> tldraw programmatic API for shape add/update/remove |
| 4i | Auto-save | Debounced every 5 seconds `PUT /api/canvas/:sessionId` |
| 4j | Export | PNG/SVG (tldraw built-in), Markdown, JSON |
| 4k | Mode activation | Canvas sidebar button active. Agent visual output -> auto Canvas mode. Mobile: view-only (no drawing) |

### Tests (~70 new)

- Backend: Canvas persistence CRUD (~15), REST endpoints (~10), WS events (~10)
- Frontend: Custom shape render tests (~20), agent shape control (~10), auto-save + export (~5)

### Exit Criteria

Agent code/diff/diagram output triggers canvas mode, shapes visible, user can freeform draw, canvas persists per-session, lazy load works (canvas bundle not loaded on initial page load), all tests pass.

---

## Phase 5: Code Mode

**Goal:** Agent file writes/edits open Monaco editor. Terminal shows shell output. File tree navigates project.

### New Dependencies

```json
{
  "@monaco-editor/react": "^4.7",
  "@xterm/xterm": "^5.5",
  "@xterm/addon-fit": "^0.10"
}
```

Both lazy loaded — Monaco workers from CDN, xterm ~200KB.

### Backend Work Items

| # | Item | Detail |
|---|------|--------|
| 5a | Workspace REST endpoints | `GET /api/workspace/files?path=<dir>` (lazy per-directory file tree), `GET /api/workspace/file?path=<file>` (file content), `GET /api/workspace/diff/:taskId` (task diff) |
| 5b | Path security | Directory traversal reject (`../`), symlink resolve, project root sandbox, denylist (`.env*`, `node_modules/`, `.git/objects/`), max depth 10 |
| 5c | Code WS events | Server->Client: `code:file_open`, `code:file_update`, `code:terminal_output`, `code:terminal_clear`, `code:annotation_add`, `code:annotation_clear`. Client->Server: `code:accept_diff`, `code:reject_diff`, `code:request_file` |
| 5d | Orchestrator code emit | `file_write`/`file_edit` -> `code:file_open` + `code:file_update`. `shell_exec` -> `code:terminal_output`. Quality review findings -> `code:annotation_add` |

### Frontend Work Items

| # | Item | Detail |
|---|------|--------|
| 5e | `useCodeStore` | Zustand — open files (tabs), active tab, terminal history |
| 5f | Monaco editor panel | `React.lazy` + Suspense. Multi-tab, syntax highlighting (C#, TS, JSON, YAML, XML, ShaderLab), minimap, line numbers, bracket matching. Theme synced with Tailwind dark/light |
| 5g | Diff viewer | Monaco built-in diff editor — side-by-side/inline toggle, per-hunk accept/reject, review findings as inline annotations |
| 5h | Terminal | xterm.js — read-only, ANSI color rendering, agent `shell_exec` output, scrollback buffer, copy support |
| 5i | File tree | Lightweight custom component (no extra dep). Agent-touched files highlighted (modified: yellow, new: green, deleted: red). Click -> open in Monaco. Lazy-load per directory |
| 5j | Code mode layout | File tree (left) + Monaco tabs (center) + Terminal (right). All resizable, terminal collapsible |
| 5k | Mode activation | Code sidebar button active. `file_write`/`file_edit`/`git_diff` event -> auto Code mode. Mobile: read-only |

### Tests (~80 new)

- Backend: File tree security (path traversal, denylist, symlinks — ~15), REST endpoints (~10), WS events (~10)
- Frontend: Monaco tab management (~15), diff accept/reject (~10), terminal render (~10), file tree interaction (~10)

### Exit Criteria

Agent file write triggers code mode, file visible in Monaco, diff review per-hunk accept/reject works, terminal shows build/test output, file tree protected against path traversal, lazy load works, all tests pass.

---

## Phase 6: Auto Mode Switching + Polish

**Goal:** Intelligent auto-switching between 4 modes. User override. Final integration tests. Performance validation.

### New Dependencies

None — all dependencies added in previous phases.

### Work Items

| # | Item | Detail |
|---|------|--------|
| 6a | Auto-switch rules | `goal:started` -> Monitor, `file_write`/`file_edit`/`git_diff` -> Code, visual output -> Canvas, agent idle/task complete -> Chat. Triggered via WS events |
| 6b | User override | User selects mode -> `userOverride = true`, auto-switch stops. User sends chat message -> override resets, returns to Chat |
| 6c | `workspace:mode_suggest` | Backend -> frontend mode suggestion (with reason). Frontend shows toast, user accepts/declines |
| 6d | Keyboard shortcuts finalize | All mode shortcuts (`Cmd+1-4`), panel toggles, Monitor intervention shortcuts (`Ctrl+P` pause). Conflict check |
| 6e | Mobile polish | Bottom tab bar, sheet overlays, Canvas view-only, Code read-only. Touch gesture compatibility |
| 6f | Notification system | `workspace:notification` event -> toast. Badge count in sidebar |
| 6g | Monitor export | `POST /api/monitor/export` -> markdown report. DAG + task summary + review results |
| 6h | Performance validation | DAG 50+ nodes @ 60fps, Canvas 100+ shapes lag-free, Monaco 10K line instant open, WS event latency <50ms |
| 6i | E2E integration tests | Full flow: goal -> DAG -> monitor -> review pipeline -> completion. Canvas: agent shapes -> user edit -> persist. Code: file write -> Monaco -> accept diff. Mode switching: auto + override + reset |

### Tests (~60 new)

- Auto-switch logic + override (~20)
- Keyboard shortcuts (~10)
- Notification system (~5)
- E2E integration flows (~15)
- Performance benchmarks (~10)

### Exit Criteria

Intelligent switching between 4 modes works, user override behaves correctly, mobile responsive, all exports work, performance targets met, total ~420 new frontend + ~120 new backend tests all pass.

---

## Dependency Graph

```
Phase 1 (UI Foundation)
  |
  v
Phase 2 (Layout + Chat Mode)
  |
  v
Phase 3 (Monitor Mode) -----> Phase 4 (Canvas Mode) -----> Phase 6 (Auto Switch + Polish)
                        \                                  ^
                         -----> Phase 5 (Code Mode) ------/
```

Phase 3 must complete before 4 and 5 (WorkspaceEventMap + monitor-bridge needed by all modes). Phases 4 and 5 are independent of each other and could be parallelized. Phase 6 requires all prior phases.

## Out of Scope

- LSP / IntelliSense in Monaco (requires language server infrastructure)
- Multi-user collaborative editing (tldraw supports it but needs CRDT backend)
- User executing commands in terminal (security — agent-only)
- Plugin system for custom canvas shapes
- Mobile-native app (responsive web only)
- Video/screen recording of agent work

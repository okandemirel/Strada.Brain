# Canvas + Monitor + Code Workspace: Phased Implementation Design

**Date:** 2026-03-22
**Status:** Approved
**Strategy:** Incremental (Foundation-First) — portal works after every phase
**Rollback:** Git tag at each phase boundary (`workspace-phase-N-complete`). Revert = checkout tag.
**Base spec:** git show 3aefcfa:docs/superpowers/specs/2026-03-22-canvas-monitor-workspace-design.md

---

## Overview

Clean rebuild of the Strada.Brain web portal into a full AI workspace with 4 context-adaptive modes (Chat, Monitor, Canvas, Code). Each phase delivers a working portal with progressively more capability.

**Current state:** 41 source files, 11 test files, React 19 + Vite 8, plain CSS (4 files), vanilla state (useState), raw fetch, 11 page routes, WebSocket chat (port 3000) + Dashboard polling (port 3100). No event bus wiring to dashboard.

**Target state:** Tailwind + Zustand + TanStack Query + Radix UI foundation. 4 workspace modes with auto-switching. ReactFlow DAG monitor with mandatory review pipeline. tldraw canvas with 9 custom shapes. Monaco editor + xterm.js terminal. ~420 new frontend + ~120 new backend tests.

### Zustand Store Boundaries

| Store | Owner Phase | Responsibility | Does NOT contain |
|-------|------------|----------------|------------------|
| `useSessionStore` | Phase 1 | Chat messages, WS connection state, active session, profile | Mode, layout |
| `useSidebarStore` | Phase 1 | Sidebar open/collapsed, admin dropdown state | Mode state |
| `useWorkspaceStore` | Phase 2 | Active mode, userOverride, panelSizes, panel visibilities | Chat messages, task data |
| `useMonitorStore` | Phase 3 | Tasks, DAG state, activity feed, review results | Canvas shapes, open files |
| `useCanvasStore` | Phase 4 | Canvas snapshot ref, selection state, dirty flag | Tasks, code tabs |
| `useCodeStore` | Phase 5 | Open files (tabs), active tab, terminal history | Canvas, tasks |

### WebSocket Strategy: Single Connection

All workspace events (monitor, canvas, code) are proxied through the existing **port 3000** WebSocket connection via the web channel. The web channel already proxies Dashboard REST API on the same origin. A new `workspace:*` message namespace is added to the existing chat WS protocol. This avoids a second WS connection (battery, mobile, complexity).

The `useDashboardSocket` hook (Phase 3) connects to the same port 3000 WS but subscribes to `workspace:*` prefixed messages. The web channel's WS handler routes these to the Dashboard server internally.

### Routing Strategy

`react-router-dom` is retained. Routes are reorganized:

- `/` — Workspace (mode-based: Chat/Monitor/Canvas/Code)
- `/admin/dashboard`, `/admin/config`, `/admin/tools`, `/admin/channels`, `/admin/sessions`, `/admin/logs`, `/admin/identity`, `/admin/personality`, `/admin/memory`, `/admin/settings` — Admin pages (rendered in Primary Panel when accessed via sidebar dropdown)
- `/setup` — Setup wizard (unchanged)
- `/*` — 404 page (new, fixes issue #1)

Deep linking and browser back/forward preserved. Mode state is URL-independent (managed by Zustand).

---

## Phase 1: UI Foundation Overhaul

**Goal:** Migrate existing 11 pages + chat + setup wizard to modern stack. Portal looks better, works the same.

### New Dependencies

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
    "@radix-ui/react-tooltip": "^1.1"
  },
  "devDependencies": {
    "@testing-library/react": "^16.0",
    "@testing-library/user-event": "^14.0",
    "@testing-library/jest-dom": "^6.0",
    "jsdom": "^25.0"
  }
}
```

### Work Items

| # | Item | Detail |
|---|------|--------|
| 1a-pre | Test infrastructure | Install testing-library, jest-dom, jsdom. Create `web-portal/vitest.config.ts` with jsdom environment. Verify existing 11 test files still pass |
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

Portal visually improved (modern icons, consistent spacing, proper dark/light theme, accessible components), `npm run build` succeeds, 3919 backend + ~160 frontend tests pass. Git tag: `workspace-phase-1-complete`.

---

## Phase 2: Layout Engine + Chat Mode

**Goal:** Context-adaptive panel layout. Existing 11 pages move to admin dropdown under `/admin/*` routes. 4 mode buttons in sidebar (only Chat active).

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
| 2b | Sidebar redesign | Top: 4 mode buttons (Chat, Monitor, Canvas, Code) — only Chat active, others "coming soon" badge. Middle: Admin dropdown — all 11 existing pages under `/admin/*` routes. Bottom: Notification badge, user profile |
| 2c | Mini chat | Small chat input in sidebar — sends messages through the same `useSessionStore` WS connection, responses appear in main Chat panel (not inline). Shares conversation context |
| 2d | `useWorkspaceStore` | Zustand store — `mode: 'chat'`, `userOverride: boolean`, `panelSizes`, panel visibilities |
| 2e | AppLayout rewrite | Replace current `Sidebar + <Outlet />` AppLayout with panel-based layout using `react-resizable-panels`. `WebSocketProvider` wrapping preserved. React Router `<Outlet />` renders inside Primary Panel |
| 2f | Chat mode integration | Existing ChatView -> Primary Panel. Enhanced message layout, code block styling |
| 2g | Responsive breakpoints | >=1440px: full layout. 1024-1439: collapsed sidebar + tabs. 768-1023: bottom tab bar + single panel. <768: mobile sheet overlays |
| 2h | Keyboard shortcuts | `Cmd+1/2/3/4` mode switch, `Cmd+B` sidebar toggle, `Cmd+\` secondary panel toggle |

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

New panel-based layout works, sidebar admin dropdown provides access to all pages via `/admin/*` routes, mini chat functional, responsive breakpoints work, existing + ~60 new tests pass. Git tag: `workspace-phase-2-complete`.

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
| 3a | `WorkspaceEventMap` | New event map in `src/dashboard/workspace-events.ts`. Declares ALL namespaces upfront: `monitor:*` (full payloads), `canvas:*` (stub payloads — `unknown` until Phase 4), `code:*` (stub payloads — `unknown` until Phase 5), `workspace:*` (full payloads). This prevents merge conflicts if Phase 4/5 run in parallel |
| 3b | Workspace EventBus + learning bridge | New `TypedEventBus<WorkspaceEventMap>` instance created at bootstrap. A `learning-to-workspace-bridge.ts` module subscribes to `LearningEventMap` events (`tool:result`, `goal:status-changed`) on the learning bus and re-emits corresponding `monitor:activity` / `monitor:task_update` events on the workspace bus. Similarly bridges `DaemonEventMap` `goal:started` -> `workspace:mode_suggest` |
| 3c | Monitor bridge | `src/dashboard/monitor-bridge.ts` — subscribes to workspace bus, forwards to WS clients via port 3000 `workspace:*` message namespace |
| 3d | Orchestrator integration | Orchestrator receives workspace bus reference at construction. Emits `monitor:activity` on tool execution alongside existing `tool:result`. GoalExecutor emits `monitor:task_update` on node status changes |
| 3e | Review pipeline | New `reviewStatus` field on `GoalNode` (separate from existing `GoalStatus`). Type: `'none' \| 'spec_review' \| 'quality_review' \| 'review_passed' \| 'review_stuck'`. Existing `GoalStatus` (`pending \| executing \| completed \| failed \| skipped`) is unchanged. GoalExecutor enforces: after node reaches `executing` -> `completed`, `reviewStatus` must progress through `spec_review` -> `quality_review` -> `review_passed` before the node is considered truly done. `maxReviewIterations = 3` per review type; if exceeded, `reviewStatus = 'review_stuck'` + gate request. No SQLite migration needed — `reviewStatus` defaults to `'none'` for existing rows |
| 3f | Monitor REST endpoints | `GET /api/monitor/dag`, `GET /api/monitor/tasks`, `GET /api/monitor/task/:id`, `GET /api/monitor/activity`, `POST /api/monitor/task/:id/approve`, `POST /api/monitor/task/:id/skip` |
| 3g | Dashboard WS events | Server->Client (via port 3000 `workspace:*`): `monitor:dag_init`, `monitor:task_update`, `monitor:review_result`, `monitor:agent_activity`, `monitor:gate_request`, `monitor:dag_restructure`. Client->Server: `monitor:pause`, `monitor:resume`, `monitor:skip_task`, `monitor:cancel_task`, `monitor:approve_gate`, `monitor:reject_gate` |

### Frontend Work Items

| # | Item | Detail |
|---|------|--------|
| 3h | `useMonitorStore` | Zustand — tasks, DAG state, activity feed |
| 3i | `useDashboardSocket` | Hook subscribing to `workspace:*` messages on the existing port 3000 WS connection. No second WS connection needed |
| 3j | DAG View | ReactFlow interactive DAG. Node types: Task node (pending: gray, executing: blue, completed: green, failed: red, skipped: dim), Review node (spec_review/quality_review: yellow, review_stuck: orange), Gate node (waiting: orange). Click -> detail panel |
| 3k | Activity Feed | Secondary panel real-time stream. Each entry clickable -> navigate to task/file |
| 3l | Kanban View | Toggle: DAG <-> Kanban. 5 columns: Backlog (pending), Working (executing), Review (spec_review/quality_review), Done (completed), Issues (failed/skipped/review_stuck). dnd-kit drag for reorder within same wave |
| 3m | Intervention controls | Pause/Resume toolbar, right-click Skip/Cancel, gate Approve/Reject dialog |
| 3n | Mode activation | Monitor sidebar button active. `goal:started` event (bridged from `DaemonEventMap` via `learning-to-workspace-bridge`) -> auto-switch to Monitor mode |

### Tests (~160 new)

- Backend: REST endpoints (~25), WS event bridge (~15), review enforcement (~20), monitor data model (~15), learning-to-workspace bridge (~10)
- Frontend: DAG render + interaction (~25), Kanban drag (~15), activity feed (~15), intervention controls (~15), store tests (~15)

### Exit Criteria

When agent executes a goal, Monitor mode auto-opens, DAG updates in real-time, review pipeline is mandatory (via `reviewStatus` field — existing `GoalStatus` unchanged), pause/resume/skip/approve work, all tests pass. Git tag: `workspace-phase-3-complete`.

---

## Phase 4: Canvas Mode

**Goal:** Agent visual output triggers canvas. User can freeform draw. Canvas persists per-session.

**Visual output definition:** Canvas mode triggers when the orchestrator produces: (1) Mermaid/PlantUML code fences, (2) outputs from architecture/diagram-related tools, (3) code diffs > 50 lines, or (4) explicit `canvas:shapes_add` events. The orchestrator checks output content against these patterns and emits `workspace:mode_suggest` with `mode: 'canvas'`.

### New Dependencies

```json
{
  "@tldraw/tldraw": "^3.0"
}
```

Lazy loaded (~700KB-2MB) — only loads when canvas mode first activates. Preload strategy: `<link rel="prefetch">` for the canvas chunk is injected after initial page load. Additionally, hovering the Canvas mode button triggers `import('./canvas/CanvasPanel')` to warm the cache.

### Backend Work Items

| # | Item | Detail |
|---|------|--------|
| 4a | Canvas persistence | `src/dashboard/canvas-storage.ts` — SQLite table `canvas_states` (id, session_id, user_id, project_fingerprint, shapes, viewport, timestamps). Indexes: session_id, project_fingerprint |
| 4b | Canvas REST endpoints | `GET /api/canvas/:sessionId`, `PUT /api/canvas/:sessionId`, `DELETE /api/canvas/:sessionId`, `GET /api/canvas/project/:fingerprint`, `POST /api/canvas/:sessionId/export` |
| 4c | Canvas WS events | Fill in `canvas:*` stub payloads in `WorkspaceEventMap`. Server->Client: `canvas:shapes_add`, `canvas:shapes_update`, `canvas:shapes_remove`, `canvas:viewport`, `canvas:arrange`. Client->Server: `canvas:user_shapes`, `canvas:save` |
| 4d | Orchestrator canvas emit | Code write -> CodeBlock shape, diff -> DiffBlock shape, Mermaid/PlantUML -> DiagramNode + ConnectionArrow. `workspaceBus.emit('canvas:shapes_add', ...)` |

### Frontend Work Items

| # | Item | Detail |
|---|------|--------|
| 4e | `useCanvasStore` | Zustand — canvas snapshot ref, selection state, dirty flag |
| 4f | Canvas panel | `React.lazy(() => import('./canvas/CanvasPanel'))` + Suspense. tldraw full workspace. Prefetch on hover |
| 4g | 9 custom shapes | CodeBlock (syntax highlighted), DiffBlock (before/after toggle), FileCard, DiagramNode, TerminalBlock, ImageBlock, TaskCard, NoteBlock, ConnectionArrow |
| 4h | Agent canvas control | `useDashboardSocket` canvas event subscription -> tldraw programmatic API for shape add/update/remove |
| 4i | Auto-save | Debounced every 5 seconds `PUT /api/canvas/:sessionId` |
| 4j | Export | PNG/SVG (tldraw built-in), Markdown, JSON |
| 4k | Mode activation | Canvas sidebar button active. Visual output detected -> auto Canvas mode. Mobile: view-only (no drawing) |

### Tests (~70 new)

- Backend: Canvas persistence CRUD (~15), REST endpoints (~10), WS events (~10)
- Frontend: Custom shape render tests (~20), agent shape control (~10), auto-save + export (~5)

### Exit Criteria

Agent code/diff/diagram output triggers canvas mode, shapes visible, user can freeform draw, canvas persists per-session, lazy load works (canvas bundle not loaded on initial page load, prefetched after load), all tests pass. Git tag: `workspace-phase-4-complete`.

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
| 5b | Path security | Directory traversal reject (`../`), symlink resolve, project root sandbox (uses `PROJECT_PATH` from config — the user's configured Unity project directory), denylist (`.env*`, `node_modules/`, `.git/objects/`), max depth 10 |
| 5c | Code WS events | Fill in `code:*` stub payloads in `WorkspaceEventMap`. Server->Client: `code:file_open`, `code:file_update`, `code:terminal_output`, `code:terminal_clear`, `code:annotation_add`, `code:annotation_clear`. Client->Server: `code:accept_diff`, `code:reject_diff`, `code:request_file` |
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

Agent file write triggers code mode, file visible in Monaco, diff review per-hunk accept/reject works, terminal shows build/test output, file tree protected against path traversal, lazy load works, all tests pass. Git tag: `workspace-phase-5-complete`.

---

## Phase 6: Auto Mode Switching + Polish

**Goal:** Intelligent auto-switching between 4 modes. User override. Final integration tests. Performance validation.

### New Dependencies

None — all dependencies added in previous phases.

### Work Items

| # | Item | Detail |
|---|------|--------|
| 6a | Auto-switch rules | All triggers come through the workspace bus (via `learning-to-workspace-bridge` from Phase 3). `goal:started` (bridged from DaemonEventMap) -> Monitor. `code:file_open` (workspace bus) -> Code. `canvas:shapes_add` (workspace bus) -> Canvas. No workspace events for 30s -> Chat. Frontend subscribes to `workspace:mode_suggest` events via `useDashboardSocket` |
| 6b | User override | User selects mode -> `userOverride = true`, auto-switch stops. User sends chat message -> override resets, returns to Chat |
| 6c | `workspace:mode_suggest` | Backend -> frontend mode suggestion (with reason). Frontend shows toast, user accepts/declines |
| 6d | Keyboard shortcuts finalize | All mode shortcuts (`Cmd+1-4`), panel toggles, Monitor intervention shortcuts (`Ctrl+P` pause). Conflict check |
| 6e | Mobile polish | Bottom tab bar, sheet overlays, Canvas view-only, Code read-only. Touch gesture compatibility |
| 6f | Notification system | `workspace:notification` event -> toast. Badge count in sidebar |
| 6g | Monitor export | `POST /api/monitor/export` -> markdown report. DAG + task summary + review results |
| 6h | Performance validation | DAG 50+ nodes @ 60fps, Canvas 100+ shapes lag-free, Monaco 10K line instant open, WS event latency <50ms. Measured via: React DevTools Profiler for FPS, `performance.now()` delta for WS latency, Playwright `page.evaluate` for automated benchmarks |
| 6i | E2E integration tests | Full flow: goal -> DAG -> monitor -> review pipeline -> completion. Canvas: agent shapes -> user edit -> persist. Code: file write -> Monaco -> accept diff. Mode switching: auto + override + reset |

### Tests (~60 new)

- Auto-switch logic + override (~20)
- Keyboard shortcuts (~10)
- Notification system (~5)
- E2E integration flows (~15)
- Performance benchmarks (~10)

### Exit Criteria

Intelligent switching between 4 modes works, user override behaves correctly, mobile responsive, all exports work, performance targets met, total ~420 new frontend + ~120 new backend tests all pass. Git tag: `workspace-phase-6-complete`.

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

Phase 3 must complete before 4 and 5 (WorkspaceEventMap + monitor-bridge needed by all modes). Phase 3 pre-declares all event namespaces (`canvas:*`, `code:*` as stubs) so Phases 4 and 5 can run in parallel without merge conflicts. Phase 6 requires all prior phases.

## Out of Scope

- LSP / IntelliSense in Monaco (requires language server infrastructure)
- Multi-user collaborative editing (tldraw supports it but needs CRDT backend)
- User executing commands in terminal (security — agent-only)
- Plugin system for custom canvas shapes
- Mobile-native app (responsive web only)
- Video/screen recording of agent work

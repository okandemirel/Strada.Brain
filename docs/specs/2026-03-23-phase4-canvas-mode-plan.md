# Phase 4: Canvas Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Agent visual output (Mermaid, diffs, diagrams) triggers a tldraw canvas workspace. User can freeform draw. Canvas persists per-session in SQLite.

**Architecture:** Backend: canvas-storage.ts (SQLite CRUD), canvas-routes.ts (REST API), fill canvas:* WS event stubs. Frontend: tldraw lazy-loaded CanvasPanel, 9 custom shapes, useCanvasStore (Zustand), auto-save, export. Orchestrator detects visual output patterns and emits canvas events.

**Tech Stack:** tldraw 3.0 (lazy), SQLite (existing), TypedEventBus (existing), Zustand (existing)

**Rollback:** Each task commits. Tag: `workspace-phase-4-complete`.

---

## Tasks (8 total)

### Task 1: Canvas Storage (SQLite)
- Create `src/dashboard/canvas-storage.ts` — `canvas_states` table (id, session_id, user_id, project_fingerprint, shapes JSON, viewport JSON, created_at, updated_at). CRUD: getBySession, save, delete, listByProject.
- Use existing SQLite pattern from `src/memory/agentdb-sqlite.ts`.
- Tests: ~15 (CRUD, missing session, project list)

### Task 2: Canvas REST Endpoints
- Create `src/dashboard/canvas-routes.ts` — GET/PUT/DELETE /api/canvas/:sessionId, GET /api/canvas/project/:fingerprint, POST /api/canvas/:sessionId/export
- Register in `src/dashboard/server.ts`
- Tests: ~10

### Task 3: Canvas WS Events
- Fill `canvas:*` stub payloads in `src/dashboard/workspace-events.ts` with real types
- Add canvas event handling to `src/channels/web/channel.ts` (client→server: canvas:user_shapes, canvas:save)
- Add canvas events to monitor-bridge forwarding

### Task 4: Orchestrator Canvas Emit
- Detect visual output patterns in orchestrator: Mermaid/PlantUML fences, diffs >50 lines
- Emit `canvas:shapes_add` and `workspace:mode_suggest { mode: 'canvas' }`

### Task 5: Frontend Foundation (dep + store + routing)
- Install `@tldraw/tldraw@^3.0`
- Create `web-portal/src/stores/canvas-store.ts` (useCanvasStore) — snapshot ref, dirty flag, sessionId
- Enable canvas mode in workspace-modes.ts
- Wire CanvasPanel to PanelLayout (lazy loaded)

### Task 6: tldraw CanvasPanel + Custom Shapes
- Create `web-portal/src/components/canvas/CanvasPanel.tsx` — tldraw editor wrapper
- Create `web-portal/src/components/canvas/custom-shapes.ts` — 9 shape definitions: CodeBlock, DiffBlock, FileCard, DiagramNode, TerminalBlock, ImageBlock, TaskCard, NoteBlock, ConnectionArrow
- Agent canvas control: subscribe to canvas:* events via useDashboardSocket, use tldraw API to add/update/remove shapes

### Task 7: Auto-save + Export
- Debounced auto-save (5s) to PUT /api/canvas/:sessionId
- Export: PNG/SVG (tldraw built-in), JSON snapshot
- Load canvas state on mount from GET /api/canvas/:sessionId

### Task 8: Tests (~70) + Final Verification
- Backend: storage CRUD (~15), REST endpoints (~10), WS events (~10)
- Frontend: store tests (~10), shape rendering (~15), auto-save/export (~5), panel tests (~5)
- Typecheck + build + all tests + tag

# Phase 5: Code Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Agent file writes/edits open Monaco editor with tabs. Terminal shows shell output via xterm.js. File tree navigates project with path security.

**Architecture:** Backend: workspace-routes.ts (file tree + file content + diff endpoints with path sanitization), fill code:* WS event stubs, orchestrator emits code events on file_write/shell_exec. Frontend: Monaco editor (lazy, tabs, diff viewer), xterm.js terminal (lazy, read-only), custom file tree component, useCodeStore (Zustand).

**Tech Stack:** Monaco Editor React 4.7 (lazy), xterm.js 5.5 (lazy), react-resizable-panels (existing), Zustand (existing)

**Rollback:** Each task commits. Tag: `workspace-phase-5-complete`.

---

## Tasks (8 total)

### Task 1: Workspace File Endpoints + Path Security
- Create `src/dashboard/workspace-routes.ts` — GET /api/workspace/files?path=<dir>, GET /api/workspace/file?path=<file>, GET /api/workspace/diff/:taskId
- Path security: reject `../`, resolve symlinks, sandbox to PROJECT_PATH, denylist (.env*, node_modules/, .git/objects/), max depth 10
- Tests: ~15 (path traversal, denylist, symlinks, valid paths)

### Task 2: Code WS Events
- Fill `code:*` stub payloads in `src/dashboard/workspace-events.ts` with real types
- Add code event handling to web channel (client→server: code:accept_diff, code:reject_diff, code:request_file)
- Add code events to monitor-bridge forwarding

### Task 3: Orchestrator Code Emit
- On file_write/file_edit tool results → emit `code:file_open` + `code:file_update`
- On shell_exec → emit `code:terminal_output`
- On quality review findings → emit `code:annotation_add`
- Emit `workspace:mode_suggest { mode: 'code' }` on file operations

### Task 4: Frontend Foundation (deps + store + routing)
- Install `@monaco-editor/react@^4.7`, `@xterm/xterm@^5.5`, `@xterm/addon-fit@^0.10`
- Create `web-portal/src/stores/code-store.ts` (useCodeStore) — open files (tabs), active tab, terminal history
- Enable code mode in workspace-modes.ts
- Wire CodePanel to PanelLayout (lazy loaded)

### Task 5: Monaco Editor Panel
- Create `web-portal/src/components/code/CodeEditor.tsx` — Monaco wrapper with multi-tab, syntax highlighting (C#, TS, JSON, YAML, XML, ShaderLab), theme synced with Tailwind dark/light
- Create `web-portal/src/components/code/DiffViewer.tsx` — Monaco diff editor, side-by-side/inline toggle

### Task 6: Terminal + File Tree
- Create `web-portal/src/components/code/Terminal.tsx` — xterm.js read-only, ANSI colors, scrollback
- Create `web-portal/src/components/code/FileTree.tsx` — lazy-loaded per directory, agent-touched highlights (modified: yellow, new: green, deleted: red)
- Create `web-portal/src/components/code/CodePanel.tsx` — layout: FileTree (left) + CodeEditor tabs (center) + Terminal (right), all resizable

### Task 7: Code Event Integration
- Subscribe to code:* events in useDashboardSocket
- file_open → add tab in CodeEditor
- terminal_output → append to Terminal
- annotation_add → Monaco inline markers

### Task 8: Tests (~80) + Final Verification
- Backend: path security (~15), REST endpoints (~10), WS events (~10)
- Frontend: store tests (~10), editor tab management (~15), diff viewer (~10), terminal (~10), file tree (~10)
- Typecheck + build + all tests + tag

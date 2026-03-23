# Phase 6: Auto Mode Switching + Polish — Implementation Plan

> **Base spec:** docs/specs/2026-03-22-canvas-monitor-workspace-phased.md (Phase 6 section)

## Wave 1: Auto-Switch + Notification UI (6a, 6b, 6c, 6f)

### Task 1: Auto-switch backend — goal:started emit
- In `learning-workspace-bridge.ts`, emit `workspace:mode_suggest { mode: 'monitor' }` when goal starts
- Verify existing emits: `code:file_open` -> code suggest, `canvas:shapes_add` -> canvas suggest already exist

### Task 2: Chat override reset
- In `ChatInput.tsx` `handleSend`, call `useWorkspaceStore.getState().resetOverride()` after sending
- This returns user to auto-switch mode after they send a chat message

### Task 3: Toast notification component
- Create `web-portal/src/components/ui/Toast.tsx` — renders notifications from workspace store
- Auto-dismiss after 5s, manual dismiss via X button
- Severity colors: info=accent, warning=yellow, error=red
- Position: bottom-right, stacked

### Task 4: Mode suggest toast
- When `workspace:mode_suggest` arrives, show toast: "Switching to {mode} — {reason}" with undo button
- Undo button calls `setMode(previousMode)` to override back

### Task 5: Sidebar notification badge
- Enable notification bell button in Sidebar
- Show unread count badge from `notifications.length`
- Click opens notification panel/dropdown

### Task 6: Tests (~20)
- Auto-switch: goal event -> mode suggest (~5)
- Chat override reset (~3)
- Toast component rendering + auto-dismiss (~5)
- Mode suggest with undo (~4)
- Notification badge count (~3)

## Wave 2: Shortcuts + Mobile + Export (6d, 6e, 6g)

### Task 7: Keyboard shortcuts finalize
- Add Ctrl+P for monitor pause (if intervention toolbar is visible)
- Document all shortcuts in a help overlay (Cmd+?)

### Task 8: Mobile polish
- Canvas: read-only on mobile (disable shape editing)
- Code: read-only on mobile (already is)
- Responsive: panel collapses to full-screen single panel

### Task 9: Monitor export
- POST /api/monitor/export -> markdown report
- DAG summary + task statuses + review results

### Task 10: Tests (~15)
- Shortcuts (~5), mobile responsive (~5), export endpoint (~5)

## Wave 3: Validation (6h, 6i)

### Task 11: Performance validation
- Verify DAG 50+ nodes, Canvas 100+ shapes, Monaco 10K lines
- Document results

### Task 12: E2E integration tests (~25)
- Full flow: goal -> DAG -> monitor -> review -> completion
- Canvas: agent shapes -> persist
- Code: file write -> Monaco
- Mode switching: auto + override + reset

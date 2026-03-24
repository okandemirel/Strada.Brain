# Canvas Page Overhaul Design

**Date:** 2026-03-24
**Status:** Approved
**Scope:** Fix broken canvas UI + full UX overhaul with context menu, toolbar integration, agent feedback, and theme harmony

## Problem

The Canvas page renders tldraw but is non-functional:
- Global CSS reset (`* { margin: 0; padding: 0; }`) destroys tldraw's internal UI layout
- Drawing toolbar (left side) is invisible/missing
- Right sidebar panels are extremely faint
- Users cannot draw, add shapes, or interact with the canvas
- 9 custom shapes exist but are inaccessible from the UI

## Solution Overview

Hybrid canvas model: AI agent proactively pushes visual content + user freely creates their own. Professional UX with right-click context menu, toolbar-integrated custom shapes, agent push feedback, and Strada theme harmony.

## 1. CSS Isolation & Core Fix

**File:** `web-portal/src/styles/globals.css`

The global reset `*, *::before, *::after { margin: 0; padding: 0; }` overrides tldraw's internal styles. Fix by reverting margin/padding inside tldraw's container:

```css
.tl-container, .tl-container *, .tl-container *::before, .tl-container *::after {
  box-sizing: revert;
  margin: revert;
  padding: revert;
}
```

- tldraw container gets `position: relative; width: 100%; height: 100%`
- tldraw dark theme via `colorScheme: 'dark'` already works correctly
- `tldraw/tldraw.css` is already imported — no additional CSS import needed

## 2. Right-Click Context Menu

**File:** `web-portal/src/components/canvas/canvas-overrides.tsx`

Extend tldraw's native context menu via the `components` prop (not `overrides` — tldraw v3's `TLUiOverrides` has no `contextMenu` method). Custom `ContextMenu` component wraps `DefaultContextMenu` + `DefaultContextMenuContent` to preserve native items:

```tsx
function CustomContextMenu(props: TLUiContextMenuProps) {
  return (
    <DefaultContextMenu {...props}>
      {/* Strada custom items */}
      <DefaultContextMenuContent />
    </DefaultContextMenu>
  )
}
// Usage: <Tldraw components={{ ContextMenu: CustomContextMenu }} />
```

```
Right-click on canvas
├── Add Shape >
│   ├── Code
│   │   ├── Code Block
│   │   ├── Diff Block
│   │   └── Terminal Block
│   ├── Diagram
│   │   ├── Diagram Node
│   │   ├── Connection Arrow
│   │   └── File Card
│   ├── Planning
│   │   ├── Task Card
│   │   └── Note Block
│   └── Media
│       └── Image Block
├── ─────────────
├── Select All
├── Zoom to Fit
└── Export JSON
```

- Shapes placed at cursor position (x, y from right-click event)
- Each category has a Lucide icon
- tldraw's native context menu items preserved below custom items

## 3. Toolbar Custom Tools

**File:** `web-portal/src/components/canvas/canvas-overrides.tsx`

Override tldraw's toolbar via the `components.Toolbar` slot. The override must explicitly render `DefaultToolbar` + `DefaultToolbarContent` to preserve native tools — omitting this causes all default tools to disappear:

```tsx
function CustomToolbar() {
  return (
    <DefaultToolbar>
      <DefaultToolbarContent />
      {/* separator + Strada shape buttons */}
    </DefaultToolbar>
  )
}
// Usage: <Tldraw components={{ Toolbar: CustomToolbar, ContextMenu: CustomContextMenu }} />
```

- All tldraw default tools preserved via `DefaultToolbarContent`
- Separator + "Strada Shapes" group appended below
- Frequently-used custom shapes get toolbar buttons:
  - CodeBlock (`</>`)
  - DiagramNode (`◇`)
  - TaskCard (`☐`)
  - NoteBlock (`📝`)
  - TerminalBlock (`>_`)
  - FileCard (`📄`)
- Click creates shape at viewport center and enters edit mode
- Less common shapes (DiffBlock, ImageBlock, ConnectionArrow) accessible only via context menu

## 4. Agent Shape Push & Visual Feedback

**Files:** `canvas-overrides.tsx`, `canvas-styles.css`, `canvas-store.ts`

Existing `pendingShapes` store → `useEffect` pipeline is preserved. Additions:

- **Glow animation:** Agent-pushed shapes get a 1s border pulse (`--color-accent` glow)
- **Auto-layout:** Multiple agent shapes arranged in horizontal grid (no overlap)
- **Zoom to fit suggestion:** After agent push, optional auto-zoom to show all shapes
- **AI badge:** Small "AI" indicator on agent-created shapes (subtle, hover to reveal)
- **Source tracking:** `CanvasShape` type gets optional `source?: 'agent' | 'user'` field (defaults to `'user'` when absent — backward compatible with existing serialized data and backend callers). The AI badge renders only when `source === 'agent'`. Badge is rendered inside the shape's `component()` method as an absolutely-positioned overlay within the `HTMLContainer`, avoiding tldraw selection/transform clipping issues.

## 5. Strada Theme Harmony & UX Polish

**Files:** `canvas-styles.css`, `canvas-overrides.tsx`, `CanvasPanel.tsx`

### Theme
- tldraw dark mode (`colorScheme: 'dark'`) as base
- Custom shapes retain Catppuccin Mocha palette (`#1e1e2e`, `#45475a`, `#cdd6f4`) — already portal-consistent
- Context menu + toolbar buttons: glassmorphism (`backdrop-filter: blur(12px)`), subtle border, `bg-bg-secondary`
- Toolbar icon hover: `accent-glow` effect

### Animations
- Shape creation: `scale(0.9) → scale(1)`, 200ms ease-out
- Agent push glow: `box-shadow` pulse with `--color-accent`, 1s
- Context menu open: `opacity 0→1 + translateY(4px→0)`, 150ms

### Toolbar Header Updates
- Existing "Canvas" + "Export JSON" + "unsaved" toolbar preserved
- "unsaved" → green dot when saved (currently only shows "unsaved")
- New "Zoom to Fit" button added to toolbar

## File Changes

### Modified
| File | Changes |
|------|---------|
| `web-portal/src/styles/globals.css` | tldraw CSS isolation (revert box-sizing/margin/padding) |
| `web-portal/src/components/canvas/CanvasPanel.tsx` | Toolbar update (saved indicator, zoom-to-fit), tldraw overrides integration |
| `web-portal/src/components/canvas/custom-shapes.tsx` | AI source badge, glow animation classes |
| `web-portal/src/stores/canvas-store.ts` | `source` field on `CanvasShape` |

### New
| File | Purpose |
|------|---------|
| `web-portal/src/components/canvas/canvas-overrides.tsx` | tldraw `components` config: `CustomContextMenu` (wraps `DefaultContextMenu` + `DefaultContextMenuContent`) and `CustomToolbar` (wraps `DefaultToolbar` + `DefaultToolbarContent` + Strada shape buttons) |
| `web-portal/src/components/canvas/canvas-styles.css` | Canvas-specific animations (glow, scale-in, context menu transitions) |

## Out of Scope

- Canvas API endpoints (save/load) — already working
- WebSocket real-time shape push — already via `pendingShapes` store
- Multi-user collaboration — Strada.Brain is single-user
- Shape resize/edit UX — tldraw handles natively

## Testing

- Existing canvas tests updated for new overrides
- Context menu + toolbar integration tests added
- CSS isolation verified (tldraw UI renders correctly)
- Agent shape push + glow animation verified
- Build verification (TypeScript + Vite production build)

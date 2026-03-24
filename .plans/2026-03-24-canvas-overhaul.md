# Canvas Page Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the broken Canvas page and deliver a polished hybrid canvas with context menu, toolbar integration, agent push feedback, and Strada theme harmony.

**Architecture:** tldraw v3.15.6 `components` prop for UI customization (ContextMenu + Toolbar slots), CSS isolation via `revert` for global reset compatibility, optional `source` field on `CanvasShape` for agent/user attribution.

**Tech Stack:** React 19, tldraw v3.15.6, Zustand, Tailwind CSS, Vitest

**Spec:** `docs/superpowers/specs/2026-03-24-canvas-overhaul-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `web-portal/src/styles/globals.css` | Modify | Add tldraw CSS isolation rule |
| `web-portal/src/stores/canvas-store.ts` | Modify | Add optional `source` field to `CanvasShape` |
| `web-portal/src/stores/canvas-store.test.ts` | Modify | Test `source` field |
| `web-portal/src/components/canvas/canvas-styles.css` | Create | Animations: glow, scale-in, context menu |
| `web-portal/src/components/canvas/canvas-overrides.tsx` | Create | CustomContextMenu + CustomToolbar components |
| `web-portal/src/components/canvas/canvas-overrides.test.tsx` | Create | Tests for overrides |
| `web-portal/src/components/canvas/custom-shapes.tsx` | Modify | Add AI badge to shape components |
| `web-portal/src/components/canvas/custom-shapes.test.ts` | Modify | Test AI badge rendering |
| `web-portal/src/components/canvas/CanvasPanel.tsx` | Modify | Wire overrides, zoom-to-fit, saved indicator, auto-layout |
| `web-portal/src/components/canvas/CanvasPanel.test.tsx` | Modify | Test new toolbar features |

---

### Task 1: CSS Isolation for tldraw

**Files:**
- Modify: `web-portal/src/styles/globals.css:225`

- [ ] **Step 1: Add tldraw CSS isolation rule**

In `globals.css`, immediately after the global reset on line 225, add:

```css
  /* Restore tldraw's own styling inside its container */
  .tl-container, .tl-container *, .tl-container *::before, .tl-container *::after {
    box-sizing: revert;
    margin: revert;
    padding: revert;
  }
```

This goes inside the existing `@layer base { }` block, right after line 225 (`*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }`).

- [ ] **Step 2: Verify tldraw container has proper dimensions**

In `CanvasPanel.tsx`, change the tldraw wrapper div from:
```tsx
<div className="flex-1">
```
to:
```tsx
<div className="relative flex-1">
```

This ensures tldraw's absolutely-positioned internal elements have a positioning context.

- [ ] **Step 3: Run existing tests**

Run: `cd web-portal && npx vitest run src/components/canvas/`
Expected: All existing canvas tests pass (no regressions from CSS change).

- [ ] **Step 4: Build verification**

Run: `cd web-portal && npx vite build`
Expected: Build succeeds with no errors.

- [ ] **Step 5: Commit**

```bash
git add web-portal/src/styles/globals.css web-portal/src/components/canvas/CanvasPanel.tsx
git commit -m "fix: add CSS isolation for tldraw to restore toolbar visibility"
```

---

### Task 2: Canvas Store — Add Source Field

**Files:**
- Modify: `web-portal/src/stores/canvas-store.ts:3-7`
- Modify: `web-portal/src/stores/canvas-store.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `canvas-store.test.ts`:

```typescript
it('preserves source field on pending shapes', () => {
  const { addPendingShapes } = useCanvasStore.getState()
  addPendingShapes([
    { type: 'code-block', id: 'cb1', props: { code: 'test' }, source: 'agent' },
  ])
  const shapes = useCanvasStore.getState().pendingShapes
  expect(shapes[0].source).toBe('agent')
})

it('allows shapes without source field (backward compat)', () => {
  const { addPendingShapes } = useCanvasStore.getState()
  addPendingShapes([
    { type: 'code-block', id: 'cb2', props: { code: 'test' } },
  ])
  const shapes = useCanvasStore.getState().pendingShapes
  expect(shapes[0].source).toBeUndefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-portal && npx vitest run src/stores/canvas-store.test.ts`
Expected: FAIL — TypeScript error, `source` doesn't exist on `CanvasShape`.

- [ ] **Step 3: Add source field to CanvasShape**

In `canvas-store.ts`, update the interface:

```typescript
export interface CanvasShape {
  type: string
  id: string
  props: Record<string, unknown>
  source?: 'agent' | 'user'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-portal && npx vitest run src/stores/canvas-store.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add web-portal/src/stores/canvas-store.ts web-portal/src/stores/canvas-store.test.ts
git commit -m "feat: add optional source field to CanvasShape for agent/user attribution"
```

---

### Task 3: Canvas Animations CSS

**Files:**
- Create: `web-portal/src/components/canvas/canvas-styles.css`

- [ ] **Step 1: Create animation stylesheet**

Create `canvas-styles.css`:

```css
/* Agent push glow animation */
@keyframes strada-shape-glow {
  0% { box-shadow: 0 0 0 0 rgba(0, 229, 255, 0.4); }
  50% { box-shadow: 0 0 12px 4px rgba(0, 229, 255, 0.25); }
  100% { box-shadow: 0 0 0 0 rgba(0, 229, 255, 0); }
}

/* Shape creation scale-in */
@keyframes strada-shape-in {
  from { opacity: 0; transform: scale(0.9); }
  to { opacity: 1; transform: scale(1); }
}

.strada-shape-glow {
  animation: strada-shape-glow 1s ease-out;
}

.strada-shape-in {
  animation: strada-shape-in 200ms ease-out;
}

/* AI badge on agent-created shapes */
.strada-ai-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  font-size: 9px;
  font-weight: 700;
  color: rgba(0, 229, 255, 0.4);
  background: rgba(0, 229, 255, 0.08);
  border: 1px solid rgba(0, 229, 255, 0.15);
  border-radius: 4px;
  padding: 1px 4px;
  pointer-events: none;
  transition: opacity 0.2s;
  opacity: 0.5;
  z-index: 1;
}

.strada-ai-badge:hover,
*:hover > .strada-ai-badge {
  opacity: 1;
  color: rgba(0, 229, 255, 0.8);
}

/* Custom toolbar shape buttons */
.strada-toolbar-separator {
  width: 100%;
  height: 1px;
  background: rgba(255, 255, 255, 0.1);
  margin: 4px 0;
}

.strada-toolbar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: #a6adc8;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.strada-toolbar-btn:hover {
  background: rgba(0, 229, 255, 0.1);
  color: #cdd6f4;
  box-shadow: 0 0 8px rgba(0, 229, 255, 0.15);
}

.strada-toolbar-btn:active {
  transform: scale(0.95);
}

/* Context menu Strada section */
.strada-ctx-group {
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  padding-top: 4px;
  margin-top: 4px;
}

/* Glassmorphism for toolbar buttons and context menu */
.strada-toolbar-btn {
  backdrop-filter: blur(12px);
}

.tl-container .tlui-popover__content {
  backdrop-filter: blur(12px);
  background: rgba(18, 18, 26, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.08);
}
```

- [ ] **Step 2: Commit**

```bash
git add web-portal/src/components/canvas/canvas-styles.css
git commit -m "feat: add canvas animation styles for glow, scale-in, AI badge, toolbar"
```

---

### Task 4: Custom Toolbar Component

**Files:**
- Create: `web-portal/src/components/canvas/canvas-overrides.tsx`
- Create: `web-portal/src/components/canvas/canvas-overrides.test.tsx`

- [ ] **Step 1: Write the test for CustomToolbar**

Create `canvas-overrides.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// Mock tldraw — toolbar components are rendered outside tldraw context in tests
vi.mock('tldraw', () => ({
  DefaultToolbar: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="default-toolbar">{children}</div>
  ),
  DefaultToolbarContent: () => <div data-testid="default-toolbar-content" />,
  DefaultContextMenu: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="default-context-menu">{children}</div>
  ),
  DefaultContextMenuContent: () => <div data-testid="default-context-menu-content" />,
  TldrawUiMenuGroup: ({ children, id }: { children: React.ReactNode; id: string }) => (
    <div data-testid={`menu-group-${id}`}>{children}</div>
  ),
  TldrawUiMenuSubmenu: ({ children, id, label }: { children: React.ReactNode; id: string; label: string }) => (
    <div data-testid={`menu-submenu-${id}`} data-label={label}>{children}</div>
  ),
  TldrawUiMenuItem: ({ id, label, onSelect }: { id: string; label: string; onSelect: () => void }) => (
    <button data-testid={`menu-item-${id}`} data-label={label} onClick={onSelect} />
  ),
  useEditor: () => ({
    createShape: vi.fn(),
    getViewportPageBounds: () => ({ center: { x: 500, y: 400 } }),
    zoomToFit: vi.fn(),
    selectAll: vi.fn(),
  }),
}))
vi.mock('./canvas-styles.css', () => ({}))

import { CustomToolbar, CustomContextMenu } from './canvas-overrides'

describe('CustomToolbar', () => {
  it('renders default toolbar content', () => {
    render(<CustomToolbar />)
    expect(screen.getByTestId('default-toolbar')).toBeInTheDocument()
    expect(screen.getByTestId('default-toolbar-content')).toBeInTheDocument()
  })

  it('renders Strada shape buttons', () => {
    render(<CustomToolbar />)
    expect(screen.getByTestId('strada-btn-code-block')).toBeInTheDocument()
    expect(screen.getByTestId('strada-btn-diagram-node')).toBeInTheDocument()
    expect(screen.getByTestId('strada-btn-task-card')).toBeInTheDocument()
    expect(screen.getByTestId('strada-btn-note-block')).toBeInTheDocument()
    expect(screen.getByTestId('strada-btn-terminal-block')).toBeInTheDocument()
    expect(screen.getByTestId('strada-btn-file-card')).toBeInTheDocument()
  })
})

describe('CustomContextMenu', () => {
  it('renders default context menu content', () => {
    render(<CustomContextMenu />)
    expect(screen.getByTestId('default-context-menu')).toBeInTheDocument()
    expect(screen.getByTestId('default-context-menu-content')).toBeInTheDocument()
  })

  it('renders Add Shape submenu with categories', () => {
    render(<CustomContextMenu />)
    expect(screen.getByTestId('menu-submenu-strada-add-shape')).toBeInTheDocument()
    expect(screen.getByTestId('menu-submenu-strada-code')).toBeInTheDocument()
    expect(screen.getByTestId('menu-submenu-strada-diagram')).toBeInTheDocument()
    expect(screen.getByTestId('menu-submenu-strada-planning')).toBeInTheDocument()
    expect(screen.getByTestId('menu-submenu-strada-media')).toBeInTheDocument()
  })

  it('renders utility items (Select All, Zoom to Fit)', () => {
    render(<CustomContextMenu />)
    expect(screen.getByTestId('menu-item-strada-select-all')).toBeInTheDocument()
    expect(screen.getByTestId('menu-item-strada-zoom-to-fit')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-portal && npx vitest run src/components/canvas/canvas-overrides.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement canvas-overrides.tsx**

Create `canvas-overrides.tsx`:

```tsx
import {
  DefaultToolbar,
  DefaultToolbarContent,
  DefaultContextMenu,
  DefaultContextMenuContent,
  TldrawUiMenuGroup,
  TldrawUiMenuItem,
  TldrawUiMenuSubmenu,
  useEditor,
  type TLUiContextMenuProps,
} from 'tldraw'
import { SHAPE_TYPES } from './custom-shapes'
import './canvas-styles.css'

/** Export JSON callback — passed from CanvasPanel via context or prop */
let _exportJsonFn: (() => void) | null = null
export function setExportJsonFn(fn: () => void) { _exportJsonFn = fn }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createShapeAtCenter(editor: ReturnType<typeof useEditor>, type: string) {
  const center = editor.getViewportPageBounds().center
  editor.createShape({
    type,
    x: center.x - 100,
    y: center.y - 50,
  })
}

function createShapeAtPointer(editor: ReturnType<typeof useEditor>, type: string) {
  const point = editor.inputs.currentPagePoint
  editor.createShape({
    type,
    x: point.x - 100,
    y: point.y - 50,
  })
}

// ---------------------------------------------------------------------------
// Toolbar shape button definitions
// ---------------------------------------------------------------------------

const TOOLBAR_SHAPES = [
  { type: SHAPE_TYPES.codeBlock, label: '</>', title: 'Code Block' },
  { type: SHAPE_TYPES.diagramNode, label: '◇', title: 'Diagram Node' },
  { type: SHAPE_TYPES.taskCard, label: '☐', title: 'Task Card' },
  { type: SHAPE_TYPES.noteBlock, label: '✎', title: 'Note Block' },
  { type: SHAPE_TYPES.terminalBlock, label: '>_', title: 'Terminal' },
  { type: SHAPE_TYPES.fileCard, label: '📄', title: 'File Card' },
] as const

// ---------------------------------------------------------------------------
// CustomToolbar
// ---------------------------------------------------------------------------

export function CustomToolbar() {
  const editor = useEditor()

  return (
    <DefaultToolbar>
      <DefaultToolbarContent />
      <div className="strada-toolbar-separator" />
      {TOOLBAR_SHAPES.map(({ type, label, title }) => (
        <button
          key={type}
          type="button"
          className="strada-toolbar-btn"
          data-testid={`strada-btn-${type}`}
          title={title}
          onClick={() => createShapeAtCenter(editor, type)}
        >
          {label}
        </button>
      ))}
    </DefaultToolbar>
  )
}

// ---------------------------------------------------------------------------
// Context menu shape definitions (all 9 shapes, categorized)
// ---------------------------------------------------------------------------

const CTX_CATEGORIES = [
  {
    id: 'strada-code',
    label: 'Code',
    shapes: [
      { type: SHAPE_TYPES.codeBlock, label: 'Code Block' },
      { type: SHAPE_TYPES.diffBlock, label: 'Diff Block' },
      { type: SHAPE_TYPES.terminalBlock, label: 'Terminal Block' },
    ],
  },
  {
    id: 'strada-diagram',
    label: 'Diagram',
    shapes: [
      { type: SHAPE_TYPES.diagramNode, label: 'Diagram Node' },
      { type: SHAPE_TYPES.connectionArrow, label: 'Connection Arrow' },
      { type: SHAPE_TYPES.fileCard, label: 'File Card' },
    ],
  },
  {
    id: 'strada-planning',
    label: 'Planning',
    shapes: [
      { type: SHAPE_TYPES.taskCard, label: 'Task Card' },
      { type: SHAPE_TYPES.noteBlock, label: 'Note Block' },
    ],
  },
  {
    id: 'strada-media',
    label: 'Media',
    shapes: [
      { type: SHAPE_TYPES.imageBlock, label: 'Image Block' },
    ],
  },
]

// ---------------------------------------------------------------------------
// CustomContextMenu
// ---------------------------------------------------------------------------

export function CustomContextMenu(props: TLUiContextMenuProps) {
  const editor = useEditor()

  return (
    <DefaultContextMenu {...props}>
      <TldrawUiMenuGroup id="strada-shapes">
        <TldrawUiMenuSubmenu id="strada-add-shape" label="Add Shape">
          {CTX_CATEGORIES.map((cat) => (
            <TldrawUiMenuSubmenu key={cat.id} id={cat.id} label={cat.label}>
              {cat.shapes.map((shape) => (
                <TldrawUiMenuItem
                  key={shape.type}
                  id={`strada-add-${shape.type}`}
                  label={shape.label}
                  onSelect={(_source) => createShapeAtPointer(editor, shape.type)}
                />
              ))}
            </TldrawUiMenuSubmenu>
          ))}
        </TldrawUiMenuSubmenu>
        <TldrawUiMenuItem
          id="strada-select-all"
          label="Select All"
          onSelect={(_source) => editor.selectAll()}
        />
        <TldrawUiMenuItem
          id="strada-zoom-to-fit"
          label="Zoom to Fit"
          onSelect={(_source) => editor.zoomToFit()}
        />
        <TldrawUiMenuItem
          id="strada-export-json"
          label="Export JSON"
          onSelect={(_source) => _exportJsonFn?.()}
        />
      </TldrawUiMenuGroup>
      <DefaultContextMenuContent />
    </DefaultContextMenu>
  )
}
```

- [ ] **Step 4: Run tests**

Run: `cd web-portal && npx vitest run src/components/canvas/canvas-overrides.test.tsx`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add web-portal/src/components/canvas/canvas-overrides.tsx web-portal/src/components/canvas/canvas-overrides.test.tsx
git commit -m "feat: add CustomToolbar and CustomContextMenu for tldraw canvas"
```

---

### Task 5: AI Badge on Custom Shapes

**Files:**
- Modify: `web-portal/src/components/canvas/custom-shapes.tsx`
- Modify: `web-portal/src/components/canvas/custom-shapes.test.ts`

- [ ] **Step 1: Write the test**

Add to `custom-shapes.test.ts`:

```typescript
describe('AI badge helper', () => {
  it('is exported for use in shape components', async () => {
    const mod = await import('./custom-shapes')
    expect(typeof mod.AiBadge).toBe('function')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-portal && npx vitest run src/components/canvas/custom-shapes.test.ts`
Expected: FAIL — `AiBadge` not exported.

- [ ] **Step 3: Add AiBadge component to custom-shapes.tsx**

Add near the top of `custom-shapes.tsx`, after the imports:

```tsx
import './canvas-styles.css'

/** Renders a small "AI" badge when source is 'agent'. Used inside custom shape components. */
export function AiBadge({ source }: { source?: string }) {
  if (source !== 'agent') return null
  return <span className="strada-ai-badge">AI</span>
}
```

Then update each shape's `component()` method to accept and pass through `source`. Since tldraw shapes pass `props` via the shape object, the badge reads from `shape.props.source` if present. However, `source` is NOT a tldraw shape prop (it's on our `CanvasShape` store type). The badge will be added by `CanvasPanel` when processing pending shapes — shapes pushed by the agent will get a CSS class instead.

**Simplified approach:** Instead of modifying all 9 shapes, add a wrapper in `CanvasPanel` that applies the glow class to newly created agent shapes. The `AiBadge` component will be used as a standalone overlay in the shape `component()` methods for shapes that have a `source` prop.

Add `source` to all shape prop definitions. For `CodeBlockShape` as example:

```tsx
type CodeBlockShape = TLBaseShape<
  typeof SHAPE_TYPES.codeBlock,
  { w: number; h: number; code: string; language: string; title: string; source?: string }
>
```

And in `CodeBlockShapeUtil`:
```tsx
static override props = {
  w: T.number,
  h: T.number,
  code: T.string,
  language: T.string,
  title: T.string,
  source: T.string.optional(),
}
```

Then in the `component()` method, after the opening `<HTMLContainer>`:
```tsx
component(shape: CodeBlockShape) {
  return (
    <HTMLContainer>
      <div style={{ ...baseContainerStyle, /* existing styles */ }}>
        <AiBadge source={shape.props.source} />
        {/* rest of existing content */}
      </div>
    </HTMLContainer>
  )
}
```

Repeat this pattern for ALL 9 shape utils.

**Confirmed:** `T.string.optional()` is valid in tldraw v3.15.6 — the `Validator` base class exposes `optional(): Validator<T | undefined>`. Use `T.string.optional()` for the `source` prop.

- [ ] **Step 4: Run tests**

Run: `cd web-portal && npx vitest run src/components/canvas/`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add web-portal/src/components/canvas/custom-shapes.tsx web-portal/src/components/canvas/custom-shapes.test.ts
git commit -m "feat: add AI badge to all custom shapes for agent attribution"
```

---

### Task 6: Wire Overrides into CanvasPanel

**Files:**
- Modify: `web-portal/src/components/canvas/CanvasPanel.tsx`
- Modify: `web-portal/src/components/canvas/CanvasPanel.test.tsx`

- [ ] **Step 1: Write test for components prop**

Add to `CanvasPanel.test.tsx`, update the tldraw mock to capture `components`:

Update the mock at the top:
```tsx
vi.mock('tldraw', () => ({
  Tldraw: (props: { onMount?: (editor: unknown) => void; shapeUtils?: unknown[]; components?: Record<string, unknown> }) => {
    if (props.onMount) {
      setTimeout(() => props.onMount!(mockEditor), 0)
    }
    return (
      <div
        data-testid="tldraw-canvas"
        data-shape-utils={props.shapeUtils?.length ?? 0}
        data-has-components={props.components ? 'true' : 'false'}
        data-component-keys={props.components ? Object.keys(props.components).join(',') : ''}
      />
    )
  },
}))
```

Add test:
```tsx
it('passes Toolbar and ContextMenu components to tldraw', () => {
  render(<CanvasPanel />)
  const canvas = screen.getByTestId('tldraw-canvas')
  expect(canvas.getAttribute('data-has-components')).toBe('true')
  expect(canvas.getAttribute('data-component-keys')).toContain('Toolbar')
  expect(canvas.getAttribute('data-component-keys')).toContain('ContextMenu')
})
```

- [ ] **Step 2: Write test for Zoom to Fit button**

```tsx
it('renders Zoom to Fit button in toolbar', () => {
  render(<CanvasPanel />)
  expect(screen.getByTestId('canvas-zoom-to-fit')).toBeInTheDocument()
})
```

- [ ] **Step 3: Write test for saved indicator**

```tsx
it('shows green saved indicator when not dirty', () => {
  useCanvasStore.getState().setDirty(false)
  render(<CanvasPanel />)
  expect(screen.getByTestId('canvas-saved-indicator')).toBeInTheDocument()
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd web-portal && npx vitest run src/components/canvas/CanvasPanel.test.tsx`
Expected: FAIL — components not passed, new elements missing.

- [ ] **Step 5: Update CanvasPanel.tsx**

Import and wire the overrides:

```tsx
import { Tldraw, type Editor, type TLShapeId } from 'tldraw'
import 'tldraw/tldraw.css'
import { useCanvasStore } from '../../stores/canvas-store'
import { useSessionStore } from '../../stores/session-store'
import { useTheme } from '../../hooks/useTheme'
import { customShapeUtils } from './custom-shapes'
import { CustomToolbar, CustomContextMenu } from './canvas-overrides'
```

Add `components` useMemo:
```tsx
import { useCallback, useEffect, useMemo, useRef } from 'react'

// Inside the component:
const tldrawComponents = useMemo(() => ({
  Toolbar: CustomToolbar,
  ContextMenu: CustomContextMenu,
}), [])
```

Update the Tldraw element:
```tsx
<Tldraw
  onMount={handleMount}
  shapeUtils={customShapeUtils}
  components={tldrawComponents}
/>
```

Add Zoom to Fit button in toolbar:
```tsx
<button
  type="button"
  className="rounded bg-[#313244] px-2 py-0.5 text-xs text-[#cdd6f4] hover:bg-[#45475a]"
  onClick={() => editorRef.current?.zoomToFit()}
  data-testid="canvas-zoom-to-fit"
>
  Zoom to Fit
</button>
```

Update the dirty/saved indicator to show both states:
```tsx
{isDirty ? (
  <span className="text-[10px] text-[#f9e2af]" data-testid="canvas-dirty-indicator">
    unsaved
  </span>
) : (
  <span className="flex items-center gap-1 text-[10px] text-[#a6e3a1]" data-testid="canvas-saved-indicator">
    <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#a6e3a1]" />
    saved
  </span>
)}
```

- [ ] **Step 6: Update pending shapes processing for agent glow + auto-layout**

Update the pendingShapes `useEffect` in CanvasPanel.tsx:

```tsx
useEffect(() => {
  const editor = editorRef.current
  if (!editor || pendingShapes.length === 0) return

  const GAP = 20
  const bounds = editor.getViewportPageBounds()
  let nextX = bounds.center.x - ((pendingShapes.length - 1) * (200 + GAP)) / 2
  const baseY = bounds.center.y - 50

  editor.run(() => {
    for (const pending of pendingShapes) {
      const existing = editor.getShape(pending.id as TLShapeId)
      if (existing) {
        editor.updateShape({ id: pending.id as TLShapeId, type: pending.type, props: pending.props })
      } else {
        editor.createShape({
          id: pending.id as TLShapeId,
          type: pending.type,
          x: nextX,
          y: baseY,
          props: {
            ...pending.props,
            ...(pending.source === 'agent' ? { source: 'agent' } : {}),
          },
        })
        nextX += 200 + GAP
      }
    }
  })

  clearPendingShapes()
}, [pendingShapes, clearPendingShapes])
```

- [ ] **Step 7: Run all canvas tests**

Run: `cd web-portal && npx vitest run src/components/canvas/`
Expected: All tests PASS.

- [ ] **Step 8: Commit**

```bash
git add web-portal/src/components/canvas/CanvasPanel.tsx web-portal/src/components/canvas/CanvasPanel.test.tsx
git commit -m "feat: wire CustomToolbar + CustomContextMenu, add zoom-to-fit and saved indicator"
```

---

### Task 7: Full Test Suite + Build Verification

**Files:** None (verification only)

- [ ] **Step 1: Run full web-portal test suite**

Run: `cd web-portal && npx vitest run`
Expected: All tests pass (canvas + all other portal tests).

- [ ] **Step 2: TypeScript compilation check**

Run: `cd web-portal && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Production build**

Run: `cd web-portal && npx vite build`
Expected: Build succeeds, tldraw-vendor chunk generated.

- [ ] **Step 4: Run backend test suite**

Run: `cd /Users/okanunico/Documents/Strada/Strada.Brain && npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: All backend tests pass (canvas store changes don't break anything).

- [ ] **Step 5: Final commit (if any remaining changes)**

```bash
git add -A
git status
# Only commit if there are unstaged fixes
```

---

### Task 8: Manual Verification Checklist

After all automated tests pass, verify in browser:

- [ ] tldraw toolbar visible on left side (Select, Hand, Draw, Eraser, Arrow, Text, etc.)
- [ ] Strada shape buttons visible below separator in toolbar
- [ ] Right-click on canvas shows context menu with "Add Shape" submenu
- [ ] Clicking a shape button creates shape at viewport center
- [ ] Context menu "Add Shape > Code > Code Block" creates a code block at cursor
- [ ] "Zoom to Fit" button in header works
- [ ] Saved/unsaved indicator shows correct state
- [ ] Dark theme renders correctly (no washed-out elements)
- [ ] tldraw minimap visible on right side
- [ ] Drawing with pen/shape tools works normally

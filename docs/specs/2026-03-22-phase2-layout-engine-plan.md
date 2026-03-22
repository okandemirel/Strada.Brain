# Phase 2: Layout Engine + Chat Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current flat sidebar+content layout with a context-adaptive panel system. 4 mode buttons in sidebar (Chat active, others disabled). Admin pages move to `/admin/*` routes. Mini chat in sidebar.

**Architecture:** `react-resizable-panels` provides the panel skeleton (TopBar + Primary + Secondary + StatusBar). `useWorkspaceStore` (Zustand) manages mode and panel state. Sidebar is redesigned with mode buttons at top, admin dropdown in middle. Routes reorganized: `/` is workspace, `/admin/*` for existing pages. Each task produces a buildable, testable portal.

**Tech Stack:** react-resizable-panels 2, Zustand 5 (existing), Radix DropdownMenu (existing), Lucide (existing), Tailwind CSS 4 (existing)

**Spec:** `docs/specs/2026-03-22-canvas-monitor-workspace-phased.md` (Phase 2 section)

**Rollback:** Each task ends with a commit. Revert = checkout previous commit. Final tag: `workspace-phase-2-complete`.

---

## File Structure

### New Files

```
web-portal/src/
  stores/
    workspace-store.ts                      # Mode, panel sizes, panel visibility, userOverride
    workspace-store.test.ts
  components/
    workspace/
      TopBar.tsx                            # Breadcrumb, mode indicator, quick actions
      StatusBar.tsx                         # Connection status, agent status, token usage
      PanelLayout.tsx                       # react-resizable-panels skeleton
      MiniChat.tsx                          # Small chat input for sidebar
    layout/
      AdminDropdown.tsx                     # Radix dropdown for admin pages
  hooks/
    use-keyboard-shortcuts.ts              # Cmd+1-4, Cmd+B, Cmd+\
    use-keyboard-shortcuts.test.ts
```

### Modified Files

```
web-portal/
  package.json                              # Add react-resizable-panels
  src/
    App.tsx                                 # Reorganize routes: / = workspace, /admin/* = pages
    components/
      layout/AppLayout.tsx                  # Rewrite with PanelLayout
      layout/Sidebar.tsx                    # Mode buttons + admin dropdown + mini chat
      ChatView.tsx                          # Enhanced message layout, code block styling (2f)
```

### Notes
- `sidebar-store.ts` already exists as a Zustand store from Phase 1. AdminDropdown uses local Radix state (no store needed).
- Spec 2b "notification badge, user profile" are deferred to Phase 3 (requires backend notification events). Sidebar bottom shows placeholder badge icon.
- Route migration and sidebar link update are done atomically in Task 4 to avoid broken link window.

---

## Task 1: Workspace Store (2d)

**Files:**
- Create: `web-portal/src/stores/workspace-store.ts`
- Create: `web-portal/src/stores/workspace-store.test.ts`

- [ ] **Step 1: Write workspace store tests**

Create `web-portal/src/stores/workspace-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { useWorkspaceStore } from './workspace-store'

describe('useWorkspaceStore', () => {
  beforeEach(() => {
    useWorkspaceStore.getState().reset()
  })

  it('starts in chat mode', () => {
    expect(useWorkspaceStore.getState().mode).toBe('chat')
  })

  it('switches mode', () => {
    useWorkspaceStore.getState().setMode('monitor')
    expect(useWorkspaceStore.getState().mode).toBe('monitor')
  })

  it('sets userOverride when mode is set manually', () => {
    useWorkspaceStore.getState().setMode('monitor')
    expect(useWorkspaceStore.getState().userOverride).toBe(true)
  })

  it('suggestMode does not override when userOverride is true', () => {
    useWorkspaceStore.getState().setMode('monitor')
    useWorkspaceStore.getState().suggestMode('code')
    expect(useWorkspaceStore.getState().mode).toBe('monitor')
  })

  it('suggestMode works when userOverride is false', () => {
    useWorkspaceStore.getState().suggestMode('canvas')
    expect(useWorkspaceStore.getState().mode).toBe('canvas')
    expect(useWorkspaceStore.getState().userOverride).toBe(false)
  })

  it('resetOverride clears override and returns to chat', () => {
    useWorkspaceStore.getState().setMode('monitor')
    useWorkspaceStore.getState().resetOverride()
    expect(useWorkspaceStore.getState().userOverride).toBe(false)
    expect(useWorkspaceStore.getState().mode).toBe('chat')
  })

  it('toggles secondary panel visibility', () => {
    expect(useWorkspaceStore.getState().secondaryVisible).toBe(false)
    useWorkspaceStore.getState().toggleSecondary()
    expect(useWorkspaceStore.getState().secondaryVisible).toBe(true)
  })

  it('stores panel sizes', () => {
    useWorkspaceStore.getState().setPanelSizes({ sidebar: 20, primary: 60, secondary: 20 })
    expect(useWorkspaceStore.getState().panelSizes.primary).toBe(60)
  })

  it('reset returns to initial state', () => {
    useWorkspaceStore.getState().setMode('canvas')
    useWorkspaceStore.getState().toggleSecondary()
    useWorkspaceStore.getState().reset()
    expect(useWorkspaceStore.getState().mode).toBe('chat')
    expect(useWorkspaceStore.getState().secondaryVisible).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests — verify fail**

```bash
cd web-portal && npx vitest run src/stores/workspace-store.test.ts
```

- [ ] **Step 3: Implement workspace store**

Create `web-portal/src/stores/workspace-store.ts`:

```typescript
import { create } from 'zustand'

export type WorkspaceMode = 'chat' | 'monitor' | 'canvas' | 'code'

interface PanelSizes {
  sidebar: number
  primary: number
  secondary: number
}

interface WorkspaceState {
  mode: WorkspaceMode
  userOverride: boolean
  secondaryVisible: boolean
  panelSizes: PanelSizes

  setMode: (mode: WorkspaceMode) => void
  suggestMode: (mode: WorkspaceMode) => void
  resetOverride: () => void
  toggleSecondary: () => void
  setPanelSizes: (sizes: Partial<PanelSizes>) => void
  reset: () => void
}

const initialState = {
  mode: 'chat' as WorkspaceMode,
  userOverride: false,
  secondaryVisible: false,
  panelSizes: { sidebar: 15, primary: 70, secondary: 15 } as PanelSizes,
}

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
  ...initialState,

  setMode: (mode) => set({ mode, userOverride: true }),

  suggestMode: (mode) =>
    set((state) => (state.userOverride ? state : { mode })),

  resetOverride: () => set({ userOverride: false, mode: 'chat' }),

  toggleSecondary: () =>
    set((state) => ({ secondaryVisible: !state.secondaryVisible })),

  setPanelSizes: (sizes) =>
    set((state) => ({ panelSizes: { ...state.panelSizes, ...sizes } })),

  reset: () => set(initialState),
}))
```

- [ ] **Step 4: Run tests — all pass**

- [ ] **Step 5: Commit**

```bash
git add web-portal/src/stores/workspace-store*
git commit -m "feat(web-portal): add useWorkspaceStore for mode and panel state"
```

---

## Task 2: Install react-resizable-panels + Panel Layout Components (2a)

**Files:**
- Modify: `web-portal/package.json`
- Create: `web-portal/src/components/workspace/TopBar.tsx`
- Create: `web-portal/src/components/workspace/StatusBar.tsx`
- Create: `web-portal/src/components/workspace/PanelLayout.tsx`

- [ ] **Step 1: Install dependency**

```bash
cd web-portal && npm install react-resizable-panels@^2.1
```

- [ ] **Step 2: Create TopBar component**

Create `web-portal/src/components/workspace/TopBar.tsx`:

```typescript
import { useWorkspaceStore, type WorkspaceMode } from '../../stores/workspace-store'
import { MessageSquare, Activity, Paintbrush, Code } from 'lucide-react'

const MODE_LABELS: Record<WorkspaceMode, { icon: typeof MessageSquare; label: string }> = {
  chat: { icon: MessageSquare, label: 'Chat' },
  monitor: { icon: Activity, label: 'Monitor' },
  canvas: { icon: Paintbrush, label: 'Canvas' },
  code: { icon: Code, label: 'Code' },
}

export default function TopBar() {
  const mode = useWorkspaceStore((s) => s.mode)
  const { icon: ModeIcon, label } = MODE_LABELS[mode]

  return (
    <div className="flex items-center justify-between h-10 px-4 border-b border-border bg-bg-secondary/50 shrink-0">
      <div className="flex items-center gap-2 text-sm text-text-secondary">
        <ModeIcon size={14} className="text-accent" />
        <span className="font-medium text-text">{label}</span>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Create StatusBar component**

Create `web-portal/src/components/workspace/StatusBar.tsx`:

```typescript
import { useWS } from '../../hooks/useWS'
import type { ConnectionStatus } from '../../types/messages'

const STATUS_COLORS: Record<ConnectionStatus, string> = {
  connected: 'bg-success',
  connecting: 'bg-warning',
  reconnecting: 'bg-warning',
  disconnected: 'bg-error',
}

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting...',
  reconnecting: 'Reconnecting...',
  disconnected: 'Disconnected',
}

export default function StatusBar() {
  const { status } = useWS()

  return (
    <div className="flex items-center h-6 px-4 border-t border-border bg-bg-secondary/50 text-xs text-text-tertiary shrink-0">
      <div className="flex items-center gap-1.5">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${STATUS_COLORS[status]}`} />
        <span>{STATUS_LABELS[status]}</span>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Create PanelLayout component**

Create `web-portal/src/components/workspace/PanelLayout.tsx`:

```typescript
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { type ReactNode } from 'react'
import { useWorkspaceStore } from '../../stores/workspace-store'
import TopBar from './TopBar'
import StatusBar from './StatusBar'

interface PanelLayoutProps {
  primary: ReactNode
  secondary?: ReactNode
}

export default function PanelLayout({ primary, secondary }: PanelLayoutProps) {
  const secondaryVisible = useWorkspaceStore((s) => s.secondaryVisible)
  const setPanelSizes = useWorkspaceStore((s) => s.setPanelSizes)

  return (
    <div className="flex flex-col h-full">
      <TopBar />
      <PanelGroup
        direction="horizontal"
        className="flex-1"
        onLayout={(sizes) => {
          if (sizes.length === 2) {
            setPanelSizes({ primary: sizes[0], secondary: sizes[1] })
          }
        }}
      >
        <Panel id="primary" order={1} minSize={40}>
          {primary}
        </Panel>
        {secondaryVisible && secondary && (
          <>
            <PanelResizeHandle className="w-1 bg-border hover:bg-accent transition-colors cursor-col-resize" />
            <Panel id="secondary" order={2} minSize={20} defaultSize={30}>
              {secondary}
            </Panel>
          </>
        )}
      </PanelGroup>
      <StatusBar />
    </div>
  )
}
```

- [ ] **Step 5: Verify build**

```bash
cd web-portal && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add web-portal/
git commit -m "feat(web-portal): add TopBar, StatusBar, PanelLayout with react-resizable-panels"
```

---

## Task 3: Sidebar Redesign + Admin Dropdown (2b)

**Files:**
- Create: `web-portal/src/components/layout/AdminDropdown.tsx`
- Modify: `web-portal/src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Create AdminDropdown**

Create `web-portal/src/components/layout/AdminDropdown.tsx`:

Radix DropdownMenu listing all 11 admin pages. Uses existing `DropdownMenu` primitive from `components/ui/dropdown-menu.tsx`. Each item is a NavLink to `/admin/<page>`.

```typescript
import { NavLink } from 'react-router-dom'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '../ui/dropdown-menu'
import {
  BarChart3, Settings, Wrench, Radio, Users, ScrollText,
  Brain, Theater, Database, ChevronDown,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

const ADMIN_ITEMS: Array<{ path: string; icon: LucideIcon; label: string }> = [
  { path: '/admin/dashboard', icon: BarChart3, label: 'Dashboard' },
  { path: '/admin/config', icon: Settings, label: 'Config' },
  { path: '/admin/tools', icon: Wrench, label: 'Tools' },
  { path: '/admin/channels', icon: Radio, label: 'Channels' },
  { path: '/admin/sessions', icon: Users, label: 'Sessions' },
  { path: '/admin/logs', icon: ScrollText, label: 'Logs' },
  { path: '/admin/identity', icon: Brain, label: 'Identity' },
  { path: '/admin/personality', icon: Theater, label: 'Personality' },
  { path: '/admin/memory', icon: Database, label: 'Memory' },
  { path: '/admin/settings', icon: Settings, label: 'Settings' },
]

interface AdminDropdownProps {
  collapsed: boolean
}

export default function AdminDropdown({ collapsed }: AdminDropdownProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-text-secondary hover:bg-surface-hover hover:text-text transition-colors text-sm">
          <Settings size={18} />
          {!collapsed && (
            <>
              <span className="flex-1 text-left">Admin</span>
              <ChevronDown size={14} />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={collapsed ? 'right' : 'bottom'} align="start" className="w-48">
        {ADMIN_ITEMS.map((item) => (
          <DropdownMenuItem key={item.path} asChild>
            <NavLink to={item.path} className="flex items-center gap-2 w-full">
              <item.icon size={14} />
              <span>{item.label}</span>
            </NavLink>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
```

- [ ] **Step 2: Rewrite Sidebar with mode buttons + admin dropdown**

Read `web-portal/src/components/layout/Sidebar.tsx` first. Then rewrite:

**Top section:** 4 mode buttons (Chat, Monitor, Canvas, Code). Only Chat is active. Others show "Coming soon" tooltip.

```typescript
import { useWorkspaceStore, type WorkspaceMode } from '../../stores/workspace-store'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '../ui/tooltip'

const MODES: Array<{ mode: WorkspaceMode; icon: LucideIcon; label: string; enabled: boolean }> = [
  { mode: 'chat', icon: MessageSquare, label: 'Chat', enabled: true },
  { mode: 'monitor', icon: Activity, label: 'Monitor', enabled: false },
  { mode: 'canvas', icon: Paintbrush, label: 'Canvas', enabled: false },
  { mode: 'code', icon: Code, label: 'Code', enabled: false },
]
```

Each mode button: if enabled, clicking sets mode via `useWorkspaceStore`. If disabled, show tooltip "Coming soon".

**Middle section:** `<AdminDropdown collapsed={collapsed} />`

**Bottom section:** Theme toggle, collapse button, health status (keep existing).

- [ ] **Step 3: Verify build**

```bash
cd web-portal && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add web-portal/
git commit -m "feat(web-portal): redesign sidebar with mode buttons and admin dropdown"
```

---

## Task 4: AppLayout Rewrite + Route Restructuring + Chat Enhancement (2e + 2f + routes)

**NOTE:** This task combines AppLayout rewrite, route restructuring, AND sidebar link update atomically. Task 3's AdminDropdown already uses `/admin/*` paths but they won't work until this task moves the routes. Both changes are committed together to avoid a broken portal window.

**Files:**
- Modify: `web-portal/src/components/layout/AppLayout.tsx`
- Modify: `web-portal/src/App.tsx`

- [ ] **Step 1: Rewrite AppLayout**

Read `web-portal/src/components/layout/AppLayout.tsx` and `web-portal/src/App.tsx` first.

Replace AppLayout to use PanelLayout:

```typescript
import { Outlet } from 'react-router-dom'
import { WebSocketProvider } from '../../contexts/WebSocketContext'
import { TooltipProvider } from '../ui/tooltip'
import Sidebar from './Sidebar'
import PanelLayout from '../workspace/PanelLayout'

export default function AppLayout() {
  return (
    <WebSocketProvider>
      <TooltipProvider>
        <div className="flex h-screen bg-bg text-text">
          <Sidebar />
          <div className="flex-1 flex flex-col min-w-0">
            <PanelLayout
              primary={<Outlet />}
            />
          </div>
        </div>
      </TooltipProvider>
    </WebSocketProvider>
  )
}
```

- [ ] **Step 2: Reorganize routes in App.tsx**

Move existing page routes under `/admin/*` path. Keep `/` as ChatView (workspace default). Keep `/setup` as-is:

```typescript
// Inside AppLayout routes:
<Route index element={<ChatView />} />
<Route path="admin">
  <Route path="dashboard" element={<DashboardView />} />
  <Route path="config" element={<ConfigPage />} />
  <Route path="tools" element={<ToolsPage />} />
  <Route path="channels" element={<ChannelsPage />} />
  <Route path="sessions" element={<SessionsPage />} />
  <Route path="logs" element={<LogsPage />} />
  <Route path="identity" element={<IdentityPage />} />
  <Route path="personality" element={<PersonalityPage />} />
  <Route path="memory" element={<MemoryPage />} />
  <Route path="settings" element={<SettingsPage />} />
</Route>
<Route path="*" element={<NotFoundPage />} />
```

Remove old flat routes (`/dashboard`, `/config`, etc.). The `NotFoundPage` stays as catch-all.

- [ ] **Step 3: Update AdminDropdown paths to match**

Ensure AdminDropdown paths match the new `/admin/*` routes (already done in Task 3).

- [ ] **Step 4: Verify build + test**

```bash
cd web-portal && npm run build && npm test
```

Some existing tests may need route path updates if they reference old routes.

- [ ] **Step 5: Enhance ChatView for panel context (2f)**

Read `web-portal/src/components/ChatView.tsx`. Now that ChatView renders inside PanelLayout's Primary Panel:
- Remove any redundant outer chrome (page title, container padding already provided by PanelLayout)
- Enhance code block styling: add `prose-ai` class or improve Tailwind classes on the message container for better typography
- Ensure message bubbles have proper max-width that adapts to panel width (use `max-w-prose` or percentage-based)
- Improve empty state to fill the panel appropriately

- [ ] **Step 6: Commit**

```bash
git add web-portal/
git commit -m "feat(web-portal): rewrite AppLayout with panels, move pages to /admin/* routes"
```

---

## Task 5: Mini Chat (2c)

**Files:**
- Create: `web-portal/src/components/workspace/MiniChat.tsx`
- Modify: `web-portal/src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Create MiniChat component**

Create `web-portal/src/components/workspace/MiniChat.tsx`:

Small chat input that sends messages through the existing WebSocket. Responses appear in the main Chat panel (not inline).

```typescript
import { useState, useCallback } from 'react'
import { useWS } from '../../hooks/useWS'
import { Send } from 'lucide-react'

export default function MiniChat() {
  const { sendMessage, status } = useWS()
  const [text, setText] = useState('')
  const disabled = status !== 'connected'

  const handleSend = useCallback(() => {
    if (!text.trim() || disabled) return
    sendMessage(text.trim())
    setText('')
  }, [text, disabled, sendMessage])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  return (
    <div className="p-2 border-t border-border">
      <div className="flex items-center gap-1.5 rounded-lg bg-surface border border-border-subtle px-2 py-1">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Quick message..."
          disabled={disabled}
          className="flex-1 bg-transparent text-xs text-text placeholder:text-text-tertiary outline-none min-w-0"
        />
        <button
          onClick={handleSend}
          disabled={disabled || !text.trim()}
          className="p-1 rounded text-text-tertiary hover:text-accent disabled:opacity-30 transition-colors"
        >
          <Send size={12} />
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add MiniChat to Sidebar**

Import and render `<MiniChat />` in the sidebar, above the footer (theme toggle + collapse), below the admin dropdown. Only show when sidebar is not collapsed.

- [ ] **Step 3: Verify build**

```bash
cd web-portal && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add web-portal/
git commit -m "feat(web-portal): add mini chat input in sidebar"
```

---

## Task 6: Responsive Breakpoints (2g)

**Files:**
- Modify: `web-portal/src/components/layout/AppLayout.tsx`
- Modify: `web-portal/src/components/layout/Sidebar.tsx`

Breakpoints: `>=1440px` full, `1024-1439px` auto-collapsed sidebar, `768-1023px` bottom tab bar, `<768px` full-screen panels.

- [ ] **Step 1: Add auto-collapse to Sidebar**

Add `useEffect` in Sidebar that listens to `matchMedia('(max-width: 1439px)')` and auto-collapses when viewport shrinks. Sidebar already has `max-md:fixed max-md:z-[1000]` from Phase 1.

- [ ] **Step 2: Create BottomTabBar component**

Create `web-portal/src/components/layout/BottomTabBar.tsx`: Horizontal bar with 4 mode icons + Admin icon. Uses same `useWorkspaceStore` for mode switching. Fixed to bottom, shows on `md:hidden`.

- [ ] **Step 3: Wire conditional rendering in AppLayout**

In AppLayout, render Sidebar with `hidden md:flex` and BottomTabBar with `flex md:hidden`. This switches between sidebar (desktop) and bottom bar (mobile).

- [ ] **Step 4: Verify build**

```bash
cd /Users/okanunico/Documents/Strada/Strada.Brain && npm run --prefix web-portal build
```

- [ ] **Step 5: Commit**

```bash
git add web-portal/
git commit -m "feat(web-portal): add responsive breakpoints with auto-collapse and mobile tab bar"
```

---

## Task 7: Keyboard Shortcuts (2h)

**Files:**
- Create: `web-portal/src/hooks/use-keyboard-shortcuts.ts`
- Create: `web-portal/src/hooks/use-keyboard-shortcuts.test.ts`
- Modify: `web-portal/src/components/layout/AppLayout.tsx`

- [ ] **Step 1: Write keyboard shortcut tests**

Create `web-portal/src/hooks/use-keyboard-shortcuts.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useKeyboardShortcuts } from './use-keyboard-shortcuts'

describe('useKeyboardShortcuts', () => {
  it('calls setMode on Cmd+1', () => {
    const setMode = vi.fn()
    const toggleSidebar = vi.fn()
    const toggleSecondary = vi.fn()

    renderHook(() => useKeyboardShortcuts({ setMode, toggleSidebar, toggleSecondary }))

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', metaKey: true }))
    expect(setMode).toHaveBeenCalledWith('chat')
  })

  it('calls toggleSidebar on Cmd+B', () => {
    const setMode = vi.fn()
    const toggleSidebar = vi.fn()
    const toggleSecondary = vi.fn()

    renderHook(() => useKeyboardShortcuts({ setMode, toggleSidebar, toggleSecondary }))

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true }))
    expect(toggleSidebar).toHaveBeenCalled()
  })

  it('calls toggleSecondary on Cmd+\\', () => {
    const setMode = vi.fn()
    const toggleSidebar = vi.fn()
    const toggleSecondary = vi.fn()

    renderHook(() => useKeyboardShortcuts({ setMode, toggleSidebar, toggleSecondary }))

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', metaKey: true }))
    expect(toggleSecondary).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Implement keyboard shortcuts hook**

Create `web-portal/src/hooks/use-keyboard-shortcuts.ts`:

```typescript
import { useEffect } from 'react'
import type { WorkspaceMode } from '../stores/workspace-store'

const MODE_KEYS: Record<string, WorkspaceMode> = {
  '1': 'chat',
  '2': 'monitor',
  '3': 'canvas',
  '4': 'code',
}

interface ShortcutHandlers {
  setMode: (mode: WorkspaceMode) => void
  toggleSidebar: () => void
  toggleSecondary: () => void
}

export function useKeyboardShortcuts({ setMode, toggleSidebar, toggleSecondary }: ShortcutHandlers) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      const mode = MODE_KEYS[e.key]
      if (mode) {
        e.preventDefault()
        setMode(mode)
        return
      }

      if (e.key === 'b') {
        e.preventDefault()
        toggleSidebar()
        return
      }

      if (e.key === '\\') {
        e.preventDefault()
        toggleSecondary()
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setMode, toggleSidebar, toggleSecondary])
}
```

- [ ] **Step 3: Wire into AppLayout**

In AppLayout, call `useKeyboardShortcuts` with handlers from workspace store and sidebar store.

- [ ] **Step 4: Run tests**

```bash
cd web-portal && npm test
```

- [ ] **Step 5: Commit**

```bash
git add web-portal/
git commit -m "feat(web-portal): add keyboard shortcuts (Cmd+1-4, Cmd+B, Cmd+\\)"
```

---

## Task 8: Test Coverage (~60 new tests)

**Files:**
- Create: `web-portal/src/components/workspace/TopBar.test.tsx`
- Create: `web-portal/src/components/workspace/StatusBar.test.tsx`
- Create: `web-portal/src/components/workspace/PanelLayout.test.tsx`
- Create: `web-portal/src/components/workspace/MiniChat.test.tsx`
- Create: `web-portal/src/components/layout/AdminDropdown.test.tsx`
- Create: `web-portal/src/components/layout/Sidebar.test.tsx` (extend existing)
- Create: `web-portal/src/components/layout/AppLayout.test.tsx` (extend existing)

- [ ] **Step 1: Workspace store tests** — already done in Task 1 (~10 tests)

- [ ] **Step 2: TopBar + StatusBar tests (~6 tests)**

TopBar: renders current mode icon and label, updates on mode change.
StatusBar: renders connection status with correct color dot, shows connected/disconnected labels.

- [ ] **Step 3: PanelLayout tests (~5 tests)**

Renders primary content, hides secondary when not visible, shows resize handle when secondary visible.

- [ ] **Step 4: MiniChat tests (~6 tests)**

Renders input, send button disabled when empty, sends message on Enter, clears after send, disabled when disconnected.

- [ ] **Step 5: AdminDropdown tests (~5 tests)**

Renders trigger button, opens dropdown with all 10 admin items, items have correct paths, collapsed shows icon only.

- [ ] **Step 6: Sidebar integration tests (~8 tests)**

Mode buttons rendered, only chat enabled, clicking chat sets mode, admin dropdown present, mini chat visible when expanded, theme toggle works, collapse toggle works.

- [ ] **Step 7: Keyboard shortcut tests** — already done in Task 7 (~3 tests, extend to ~5)

Add: Cmd+2/3/4 for other modes, ignores shortcuts when typing in input.

- [ ] **Step 8: AppLayout integration tests (~5 tests)**

Renders sidebar + panel layout, routes to admin pages, chat view is default route.

- [ ] **Step 9: Responsive tests (~5 tests)**

Auto-collapse on narrow viewport, bottom tab bar visible on mobile.

- [ ] **Step 10: Run all tests**

```bash
cd web-portal && npm test
```

Expected: 150 existing + ~60 new = ~210 tests pass.

- [ ] **Step 11: Commit**

```bash
git add web-portal/
git commit -m "test(web-portal): add Phase 2 test coverage (~60 new tests)"
```

---

## Task 9: Final Verification

- [ ] **Step 1: TypeScript check**

```bash
cd web-portal && npm run typecheck
```

- [ ] **Step 2: Build**

```bash
cd web-portal && npm run build
```

- [ ] **Step 3: All tests**

```bash
cd web-portal && npm test
```

- [ ] **Step 4: Visual smoke test**

```bash
cd web-portal && npm run preview
```

Verify:
- [ ] Panel layout visible (TopBar + content + StatusBar)
- [ ] Sidebar shows 4 mode buttons (Chat active, others disabled with tooltip)
- [ ] Admin dropdown opens and lists all 10 pages
- [ ] Admin pages load at `/admin/*` routes
- [ ] Chat is default view at `/`
- [ ] Mini chat sends messages
- [ ] Sidebar collapse works
- [ ] Keyboard shortcuts work (Cmd+1, Cmd+B, Cmd+\\)
- [ ] Responsive: narrow browser auto-collapses sidebar
- [ ] 404 page for invalid routes
- [ ] StatusBar shows connection status

- [ ] **Step 5: Git tag**

```bash
git tag workspace-phase-2-complete
```

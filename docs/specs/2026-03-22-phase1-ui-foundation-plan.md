# Phase 1: UI Foundation Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the web portal's 11 pages + chat + setup wizard to Tailwind CSS + Zustand + TanStack Query + Radix UI. Portal looks better, works the same.

**Architecture:** Incremental migration — each task produces a buildable, testable portal. CSS files are replaced one at a time. State management migrates hook-by-hook. API layer migrates page-by-page. No big-bang rewrite. Old CSS imports are kept alongside Tailwind until CSS migration completes, preventing visual breakage during intermediate tasks.

**Rollback:** Each task ends with a commit. If a task fails QA, revert to previous commit. Final tag: `workspace-phase-1-complete`.

**Tech Stack:** Tailwind CSS 4, Zustand 5, TanStack Query 6, Radix UI, Lucide React, Vitest + Testing Library

**Spec:** `docs/specs/2026-03-22-canvas-monitor-workspace-phased.md` (Phase 1 section)

---

## File Structure

### New Files

```
web-portal/
  src/test-setup.ts                           # Testing library setup
  src/
    stores/
      session-store.ts                      # Chat messages, WS state, profile
      session-store.test.ts
      sidebar-store.ts                      # Sidebar collapsed state
      sidebar-store.test.ts
    components/
      ui/
        button.tsx                          # shadcn-style Button primitive
        dialog.tsx                          # Radix Dialog wrapper
        dropdown-menu.tsx                   # Radix DropdownMenu wrapper
        tooltip.tsx                         # Radix Tooltip wrapper
        tabs.tsx                            # Radix Tabs wrapper
    hooks/
      use-api.ts                            # TanStack Query hooks (useConfig, useTools, etc.)
      use-api.test.ts
    lib/
      query-client.ts                       # TanStack QueryClient singleton
    styles/
      globals.css                           # Tailwind base + theme CSS variables
```

### Modified Files

```
web-portal/
  package.json                              # New deps + devDeps
  vite.config.ts                            # Tailwind plugin
  src/
    main.tsx                                # Import globals.css, wrap QueryClientProvider
    App.tsx                                 # Add 404 route, remove PlaceholderPage
    components/
      layout/Sidebar.tsx                    # Emoji → Lucide, CSS classes → Tailwind
      layout/AppLayout.tsx                  # CSS classes → Tailwind
      ChatView.tsx                          # CSS classes → Tailwind
      ChatMessage.tsx                       # CSS classes → Tailwind
      ChatInput.tsx                         # CSS classes → Tailwind, remove inline styles
      ConfirmDialog.tsx                     # → Radix Dialog
      DashboardView.tsx                     # CSS → Tailwind, useDashboard → useQuery
      EmptyState.tsx                        # CSS → Tailwind
      ErrorBoundary.tsx                     # Hardcoded colors → Tailwind theme
      MetricCard.tsx                        # CSS → Tailwind
      TypingIndicator.tsx                   # CSS → Tailwind
      PrimaryWorkerSelector.tsx             # CSS → Tailwind, inline styles removed
      VoiceOutput.tsx                       # CSS → Tailwind
      VoiceRecorder.tsx                     # CSS → Tailwind
    hooks/
      useWebSocket.ts                       # Remove message state (→ useSessionStore)
      useWS.ts                              # Keep as-is (thin context wrapper)
      useDashboard.ts                       # → TanStack Query hooks in use-api.ts
      useTheme.ts                           # CSS → Tailwind dark: variant
      useSidebar.ts                         # → useSidebarStore (Zustand)
      useAutoRefresh.ts                     # Replaced by TanStack Query refetchInterval
    contexts/
      WebSocketContext.tsx                   # Simplified (messages moved to store)
    pages/
      ConfigPage.tsx                        # CSS → Tailwind, fetch → useQuery
      ToolsPage.tsx                         # CSS → Tailwind, fetch → useQuery
      ChannelsPage.tsx                      # CSS → Tailwind, fetch → useQuery
      SessionsPage.tsx                      # CSS → Tailwind, inline styles removed
      LogsPage.tsx                          # CSS → Tailwind, inline styles removed
      IdentityPage.tsx                      # CSS → Tailwind, inline styles removed
      PersonalityPage.tsx                   # CSS → Tailwind, extensive inline styles removed
      MemoryPage.tsx                        # CSS → Tailwind, fetch → useQuery
      SettingsPage.tsx                      # CSS → Tailwind
      SetupWizard.tsx                       # CSS → Tailwind
      setup/*.tsx                           # CSS → Tailwind (8 component files: WelcomeStep, ProgressBar, ChannelRagStep, ReviewStep, ProvidersStep, ProjectPathStep, DirectoryBrowser, McpInstallPanel)
```

### Deleted Files

```
web-portal/src/styles/index.css             # Replaced by globals.css
web-portal/src/styles/admin.css             # Inlined as Tailwind classes
web-portal/src/styles/sidebar.css           # Inlined as Tailwind classes
web-portal/src/styles/setup.css             # Inlined as Tailwind classes
web-portal/src/components/placeholder/PlaceholderPage.tsx  # Dead code (issue #8)
web-portal/src/hooks/useAutoRefresh.ts      # Replaced by TanStack Query refetchInterval
```

---

## Task 1: Test Infrastructure (1a-pre)

**Files:**
- Modify: `web-portal/package.json`
- Modify: `web-portal/vitest.config.ts` (exists with `environment: 'node'` — changing to `jsdom`)
- Create: `web-portal/src/test-setup.ts`
- Test: existing 11 test files must still pass

- [ ] **Step 1: Install test dependencies**

```bash
cd web-portal && npm install -D @testing-library/react@^16.0 @testing-library/user-event@^14.0 @testing-library/jest-dom@^6.0 jsdom@^25.0
```

- [ ] **Step 2: Modify vitest.config.ts**

Update `web-portal/vitest.config.ts` (currently uses `environment: 'node'`):

```typescript
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
```

Create `web-portal/src/test-setup.ts`:

```typescript
import '@testing-library/jest-dom/vitest'
```

- [ ] **Step 3: Update package.json test script**

Change the `test` script in `web-portal/package.json`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Run existing tests to verify no regression**

```bash
cd web-portal && npm test
```

Expected: all 11 existing test files pass.

- [ ] **Step 5: Commit**

```bash
git add web-portal/package.json web-portal/package-lock.json web-portal/vitest.config.ts web-portal/src/test-setup.ts
git commit -m "chore(web-portal): add testing-library + jsdom test infrastructure"
```

---

## Task 2: Tailwind CSS Setup (1a)

**Files:**
- Modify: `web-portal/package.json`
- Modify: `web-portal/vite.config.ts`
- Create: `web-portal/src/styles/globals.css`
- Modify: `web-portal/src/main.tsx`

- [ ] **Step 1: Install Tailwind dependencies**

```bash
cd web-portal && npm install tailwindcss@^4.0 @tailwindcss/typography@^0.5 @tailwindcss/vite@^4.0
```

- [ ] **Step 2: Add Tailwind Vite plugin**

Modify `web-portal/vite.config.ts` — add import and plugin:

```typescript
import tailwindcss from '@tailwindcss/vite'

// In plugins array, add:
plugins: [tailwindcss(), react()],
```

- [ ] **Step 3: Create globals.css with theme variables**

Create `web-portal/src/styles/globals.css`:

```css
@import "tailwindcss";
@plugin "@tailwindcss/typography";

@theme {
  --color-bg: #0a0a0f;
  --color-bg-secondary: #12121a;
  --color-bg-tertiary: #1a1a25;
  --color-text: #e8e8ed;
  --color-text-secondary: #a0a0b0;
  --color-text-tertiary: #6a6a7a;
  --color-accent: #00e5ff;
  --color-accent-hover: #33ecff;
  --color-success: #34d399;
  --color-warning: #fbbf24;
  --color-error: #f87171;
  --color-border: #2a2a3a;
  --color-border-subtle: #1f1f2f;
  --color-surface: #16161f;
  --color-surface-hover: #1e1e2a;

  --color-user-msg: #1a1a2e;
  --color-ai-msg: #0f0f1a;
}

@variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));
@variant light (&:where([data-theme="light"], [data-theme="light"] *));

@layer base {
  :root[data-theme="light"] {
    --color-bg: #fafafa;
    --color-bg-secondary: #f0f0f5;
    --color-bg-tertiary: #e8e8ed;
    --color-text: #1a1a2e;
    --color-text-secondary: #4a4a5a;
    --color-text-tertiary: #8a8a9a;
    --color-accent: #0091a3;
    --color-accent-hover: #007a8a;
    --color-success: #059669;
    --color-warning: #d97706;
    --color-error: #dc2626;
    --color-border: #d0d0dd;
    --color-border-subtle: #e0e0ea;
    --color-surface: #ffffff;
    --color-surface-hover: #f5f5fa;

    --color-user-msg: #e8f0fe;
    --color-ai-msg: #f0f0f5;
  }

  body {
    @apply bg-bg text-text font-sans antialiased;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
  }
}
```

- [ ] **Step 4: Update main.tsx imports**

Modify `web-portal/src/main.tsx` — add globals.css BEFORE existing CSS imports:

```typescript
import './styles/globals.css'        // Tailwind base — add this first
import 'highlight.js/styles/github-dark.css'
import './styles/index.css'          // Keep old CSS — will be removed in Task 7
import './styles/admin.css'          // Keep old CSS — will be removed in Task 7
```

Old CSS files are kept alongside Tailwind during intermediate tasks so the portal remains visually functional. They will be deleted in Task 7 after all components are migrated to Tailwind classes.

- [ ] **Step 5: Verify build succeeds**

```bash
cd web-portal && npm run build
```

Expected: builds with no errors. Portal looks the same as before (old CSS still loaded). Tailwind utilities are now available for use.

- [ ] **Step 6: Commit**

```bash
git add web-portal/package.json web-portal/package-lock.json web-portal/vite.config.ts web-portal/src/styles/globals.css web-portal/src/main.tsx
git commit -m "feat(web-portal): add Tailwind CSS 4 with dark/light theme system"
```

---

## Task 3: Zustand Stores (1d)

**Files:**
- Modify: `web-portal/package.json`
- Create: `web-portal/src/stores/session-store.ts`
- Create: `web-portal/src/stores/session-store.test.ts`
- Create: `web-portal/src/stores/sidebar-store.ts`
- Create: `web-portal/src/stores/sidebar-store.test.ts`
- Modify: `web-portal/src/hooks/useWebSocket.ts`
- Modify: `web-portal/src/contexts/WebSocketContext.tsx`
- Modify: `web-portal/src/hooks/useSidebar.ts`

- [ ] **Step 1: Install Zustand**

```bash
cd web-portal && npm install zustand@^5.0
```

- [ ] **Step 2: Write session store tests**

**IMPORTANT:** The store reuses existing types from `types/messages.ts`: `ChatMessage` (fields: `id`, `sender`, `text`, `isMarkdown`, `isStreaming?`, `streamId?`, `timestamp`, `attachments?`), `ConnectionStatus` (`'connecting' | 'connected' | 'disconnected' | 'reconnecting'`), and `ConfirmationState` (`confirmId`, `question`, `options`, `details?`). Do NOT redefine these types.

Create `web-portal/src/stores/session-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { useSessionStore } from './session-store'

describe('useSessionStore', () => {
  beforeEach(() => {
    useSessionStore.getState().reset()
  })

  it('starts with empty messages', () => {
    expect(useSessionStore.getState().messages).toEqual([])
  })

  it('adds a message', () => {
    useSessionStore.getState().addMessage({ id: '1', sender: 'user', text: 'hello', isMarkdown: false, timestamp: 1 })
    expect(useSessionStore.getState().messages).toHaveLength(1)
    expect(useSessionStore.getState().messages[0].text).toBe('hello')
  })

  it('updates a streaming message', () => {
    useSessionStore.getState().addMessage({ id: '1', sender: 'assistant', text: 'hel', isMarkdown: true, timestamp: 1 })
    useSessionStore.getState().updateMessage('1', { text: 'hello world' })
    expect(useSessionStore.getState().messages[0].text).toBe('hello world')
  })

  it('removes a message by id', () => {
    useSessionStore.getState().addMessage({ id: '1', sender: 'user', text: 'a', isMarkdown: false, timestamp: 1 })
    useSessionStore.getState().addMessage({ id: '2', sender: 'assistant', text: 'b', isMarkdown: true, timestamp: 2 })
    useSessionStore.getState().removeMessage('1')
    expect(useSessionStore.getState().messages).toHaveLength(1)
    expect(useSessionStore.getState().messages[0].id).toBe('2')
  })

  it('sets connection status', () => {
    useSessionStore.getState().setStatus('connected')
    expect(useSessionStore.getState().status).toBe('connected')
  })

  it('handles reconnecting status', () => {
    useSessionStore.getState().setStatus('reconnecting')
    expect(useSessionStore.getState().status).toBe('reconnecting')
  })

  it('sets session identity', () => {
    useSessionStore.getState().setSession({ sessionId: 's1', profileId: 'p1' })
    expect(useSessionStore.getState().sessionId).toBe('s1')
    expect(useSessionStore.getState().profileId).toBe('p1')
  })

  it('sets typing indicator', () => {
    useSessionStore.getState().setTyping(true)
    expect(useSessionStore.getState().isTyping).toBe(true)
  })

  it('sets confirmation state', () => {
    const conf = { confirmId: 'c1', question: 'ok?', options: ['yes', 'no'] }
    useSessionStore.getState().setConfirmation(conf)
    expect(useSessionStore.getState().confirmation).toEqual(conf)
  })

  it('clears confirmation', () => {
    useSessionStore.getState().setConfirmation({ confirmId: 'c1', question: 'ok?', options: ['yes'] })
    useSessionStore.getState().setConfirmation(null)
    expect(useSessionStore.getState().confirmation).toBeNull()
  })

  it('does not add duplicate message ids', () => {
    useSessionStore.getState().addMessage({ id: '1', sender: 'user', text: 'a', isMarkdown: false, timestamp: 1 })
    useSessionStore.getState().addMessage({ id: '1', sender: 'user', text: 'b', isMarkdown: false, timestamp: 2 })
    expect(useSessionStore.getState().messages).toHaveLength(1)
  })

  it('sets messages in bulk (for session restore)', () => {
    const msgs = [
      { id: '1', sender: 'user' as const, text: 'a', isMarkdown: false, timestamp: 1 },
      { id: '2', sender: 'assistant' as const, text: 'b', isMarkdown: true, timestamp: 2 },
    ]
    useSessionStore.getState().setMessages(msgs)
    expect(useSessionStore.getState().messages).toHaveLength(2)
  })

  it('reset clears all state', () => {
    useSessionStore.getState().addMessage({ id: '1', sender: 'user', text: 'a', isMarkdown: false, timestamp: 1 })
    useSessionStore.getState().setStatus('connected')
    useSessionStore.getState().reset()
    expect(useSessionStore.getState().messages).toEqual([])
    expect(useSessionStore.getState().status).toBe('disconnected')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd web-portal && npx vitest run src/stores/session-store.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement session store**

Create `web-portal/src/stores/session-store.ts`:

```typescript
import { create } from 'zustand'
import type { ChatMessage, ConnectionStatus, ConfirmationState } from '../types/messages'

// Re-export for convenience
export type { ChatMessage, ConnectionStatus, ConfirmationState }

interface SessionState {
  messages: ChatMessage[]
  status: ConnectionStatus
  isTyping: boolean
  sessionId: string | null
  profileId: string | null
  confirmation: ConfirmationState | null

  addMessage: (msg: ChatMessage) => void
  setMessages: (msgs: ChatMessage[]) => void
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void
  removeMessage: (id: string) => void
  setStatus: (status: ConnectionStatus) => void
  setSession: (session: { sessionId?: string | null; profileId?: string | null }) => void
  setTyping: (typing: boolean) => void
  setConfirmation: (conf: ConfirmationState | null) => void
  reset: () => void
}

const initialState = {
  messages: [] as ChatMessage[],
  status: 'disconnected' as ConnectionStatus,
  isTyping: false,
  sessionId: null as string | null,
  profileId: null as string | null,
  confirmation: null as ConfirmationState | null,
}

export const useSessionStore = create<SessionState>()((set) => ({
  ...initialState,

  addMessage: (msg) =>
    set((state) => {
      if (state.messages.some((m) => m.id === msg.id)) return state
      return { messages: [...state.messages, msg] }
    }),

  setMessages: (messages) => set({ messages }),

  updateMessage: (id, updates) =>
    set((state) => ({
      messages: state.messages.map((m) => (m.id === id ? { ...m, ...updates } : m)),
    })),

  removeMessage: (id) =>
    set((state) => ({
      messages: state.messages.filter((m) => m.id !== id),
    })),

  setStatus: (status) => set({ status }),

  setSession: (session) =>
    set((state) => ({
      sessionId: session.sessionId !== undefined ? session.sessionId : state.sessionId,
      profileId: session.profileId !== undefined ? session.profileId : state.profileId,
    })),

  setTyping: (isTyping) => set({ isTyping }),
  setConfirmation: (confirmation) => set({ confirmation }),
  reset: () => set(initialState),
}))
```

- [ ] **Step 5: Run session store tests**

```bash
cd web-portal && npx vitest run src/stores/session-store.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Write sidebar store tests**

Create `web-portal/src/stores/sidebar-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSidebarStore } from './sidebar-store'

describe('useSidebarStore', () => {
  beforeEach(() => {
    localStorage.clear()
    useSidebarStore.setState({ collapsed: false })
  })

  it('starts expanded by default', () => {
    expect(useSidebarStore.getState().collapsed).toBe(false)
  })

  it('toggles collapsed state', () => {
    useSidebarStore.getState().toggle()
    expect(useSidebarStore.getState().collapsed).toBe(true)
    useSidebarStore.getState().toggle()
    expect(useSidebarStore.getState().collapsed).toBe(false)
  })

  it('persists collapsed state to localStorage', () => {
    useSidebarStore.getState().toggle()
    expect(localStorage.getItem('strada-sidebar-collapsed')).toBe('1')
    useSidebarStore.getState().toggle()
    expect(localStorage.getItem('strada-sidebar-collapsed')).toBe('0')
  })

  it('initializes from localStorage', () => {
    localStorage.setItem('strada-sidebar-collapsed', '1')
    // Re-create store state from storage
    useSidebarStore.setState({
      collapsed: localStorage.getItem('strada-sidebar-collapsed') === '1',
    })
    expect(useSidebarStore.getState().collapsed).toBe(true)
  })
})
```

- [ ] **Step 7: Implement sidebar store**

Create `web-portal/src/stores/sidebar-store.ts`:

```typescript
import { create } from 'zustand'

const STORAGE_KEY = 'strada-sidebar-collapsed'

interface SidebarState {
  collapsed: boolean
  toggle: () => void
}

export const useSidebarStore = create<SidebarState>()((set) => ({
  collapsed: localStorage.getItem(STORAGE_KEY) === '1',

  toggle: () =>
    set((state) => {
      const next = !state.collapsed
      localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
      return { collapsed: next }
    }),
}))
```

- [ ] **Step 8: Run all store tests**

```bash
cd web-portal && npx vitest run src/stores/
```

Expected: all tests PASS.

- [ ] **Step 9: Wire useSessionStore into useWebSocket.ts**

Modify `web-portal/src/hooks/useWebSocket.ts`:
- Import `useSessionStore` at the top
- Replace internal `messages` useState with store calls:
  - `setMessages(prev => [...prev, msg])` → `useSessionStore.getState().addMessage(msg)`
  - `setMessages(prev => prev.map(...))` → `useSessionStore.getState().updateMessage(id, updates)`
  - `setMessages(prev => prev.filter(...))` → `useSessionStore.getState().removeMessage(id)`
- Replace `status` useState with `useSessionStore.getState().setStatus()`
- Replace `isTyping` useState with `useSessionStore.getState().setTyping()`
- Replace `confirmation` useState with `useSessionStore.getState().setConfirmation()`
- The hook's return values now read from the store:
  ```typescript
  const messages = useSessionStore((s) => s.messages)
  const status = useSessionStore((s) => s.status)
  const isTyping = useSessionStore((s) => s.isTyping)
  const confirmation = useSessionStore((s) => s.confirmation)
  ```

- [ ] **Step 10: Simplify WebSocketContext.tsx**

The context now only exposes action methods (sendMessage, sendConfirmation, switchProvider, toggleAutonomous) — read state comes from useSessionStore directly. Components that only read messages/status can use the store directly without the context.

- [ ] **Step 11: Replace useSidebar hook usage**

Modify `web-portal/src/hooks/useSidebar.ts` to re-export from store:

```typescript
export { useSidebarStore as useSidebar } from '../stores/sidebar-store'
```

This keeps existing import paths working. Components using `useSidebar()` now get Zustand store.

- [ ] **Step 12: Run all tests**

```bash
cd web-portal && npm test
```

Expected: all existing + new store tests pass.

- [ ] **Step 13: Commit**

```bash
git add web-portal/
git commit -m "feat(web-portal): add Zustand stores for session and sidebar state"
```

---

## Task 4: Lucide Icons (1c)

**Files:**
- Modify: `web-portal/package.json`
- Modify: `web-portal/src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Install Lucide**

```bash
cd web-portal && npm install lucide-react@^0.500
```

- [ ] **Step 2: Replace emoji icons in Sidebar.tsx**

Modify `web-portal/src/components/layout/Sidebar.tsx`:

Replace the SECTIONS constant — swap emoji `icon` strings with Lucide component references:

```typescript
import {
  MessageSquare, BarChart3, Settings, Wrench, Radio,
  Users, ScrollText, Brain, Theater, Database,
  Sun, Moon, ChevronLeft, ChevronRight
} from 'lucide-react'

const SECTIONS = [
  {
    title: 'MAIN',
    items: [
      { path: '/', icon: MessageSquare, label: 'Chat' },
      { path: '/dashboard', icon: BarChart3, label: 'Dashboard' },
    ],
  },
  {
    title: 'ADMIN',
    items: [
      { path: '/config', icon: Settings, label: 'Config' },
      { path: '/tools', icon: Wrench, label: 'Tools' },
      { path: '/channels', icon: Radio, label: 'Channels' },
      { path: '/sessions', icon: Users, label: 'Sessions' },
      { path: '/logs', icon: ScrollText, label: 'Logs' },
    ],
  },
  {
    title: 'AGENT',
    items: [
      { path: '/identity', icon: Brain, label: 'Identity' },
      { path: '/personality', icon: Theater, label: 'Personality' },
      { path: '/memory', icon: Database, label: 'Memory' },
      { path: '/settings', icon: Settings, label: 'Settings' },
    ],
  },
]
```

In JSX, render `<item.icon size={18} />` instead of `<span className="sidebar-icon">{item.icon}</span>`.

Replace theme toggle emoji (`☀️`/`🌙`) with `<Sun size={16} />` / `<Moon size={16} />`.

Replace collapse arrow (`›`/`‹`) with `<ChevronRight size={14} />` / `<ChevronLeft size={14} />`.

- [ ] **Step 3: Verify build**

```bash
cd web-portal && npm run build
```

Expected: builds with no errors.

- [ ] **Step 4: Commit**

```bash
git add web-portal/
git commit -m "feat(web-portal): replace emoji icons with Lucide React SVG icons"
```

---

## Task 5: Radix UI Primitives (1f)

**Files:**
- Modify: `web-portal/package.json`
- Create: `web-portal/src/components/ui/dialog.tsx`
- Create: `web-portal/src/components/ui/dropdown-menu.tsx`
- Create: `web-portal/src/components/ui/tooltip.tsx`
- Create: `web-portal/src/components/ui/tabs.tsx`
- Create: `web-portal/src/components/ui/button.tsx`
- Modify: `web-portal/src/components/ConfirmDialog.tsx`

- [ ] **Step 1: Install Radix primitives**

```bash
cd web-portal && npm install @radix-ui/react-dialog@^1.1 @radix-ui/react-dropdown-menu@^2.1 @radix-ui/react-tabs@^1.1 @radix-ui/react-tooltip@^1.1
```

- [ ] **Step 2: Create UI primitive wrappers**

Create shadcn-style wrappers. These are thin components that add Tailwind classes to Radix primitives.

Create `web-portal/src/components/ui/button.tsx`:

```typescript
import { forwardRef, type ButtonHTMLAttributes } from 'react'

type Variant = 'default' | 'outline' | 'ghost' | 'destructive'
type Size = 'default' | 'sm' | 'lg' | 'icon'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

const variantClasses: Record<Variant, string> = {
  default: 'bg-accent text-bg hover:bg-accent-hover',
  outline: 'border border-border bg-transparent hover:bg-surface-hover text-text',
  ghost: 'hover:bg-surface-hover text-text',
  destructive: 'bg-error text-white hover:bg-error/80',
}

const sizeClasses: Record<Size, string> = {
  default: 'h-9 px-4 py-2 text-sm',
  sm: 'h-8 px-3 text-xs',
  lg: 'h-11 px-6 text-base',
  icon: 'h-9 w-9',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className = '', variant = 'default', size = 'default', ...props }, ref) => (
    <button
      ref={ref}
      className={`inline-flex items-center justify-center rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50 ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      {...props}
    />
  ),
)
Button.displayName = 'Button'
```

Create `web-portal/src/components/ui/dialog.tsx`:

```typescript
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { forwardRef, type ComponentPropsWithoutRef } from 'react'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close
export const DialogPortal = DialogPrimitive.Portal

export const DialogOverlay = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className = '', ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={`fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 ${className}`}
    {...props}
  />
))
DialogOverlay.displayName = 'DialogOverlay'

export const DialogContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className = '', children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={`fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary p-6 shadow-2xl ${className}`}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-accent">
        <X size={16} />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = 'DialogContent'

export const DialogTitle = forwardRef<
  HTMLHeadingElement,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className = '', ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={`text-lg font-semibold text-text ${className}`}
    {...props}
  />
))
DialogTitle.displayName = 'DialogTitle'

export const DialogDescription = forwardRef<
  HTMLParagraphElement,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className = '', ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={`text-sm text-text-secondary ${className}`}
    {...props}
  />
))
DialogDescription.displayName = 'DialogDescription'
```

Create `web-portal/src/components/ui/dropdown-menu.tsx`, `tooltip.tsx`, `tabs.tsx` following the same pattern — thin Radix wrappers with Tailwind classes. Each exports the Radix compound component parts with styled defaults.

- [ ] **Step 3: Rewrite ConfirmDialog with Radix Dialog**

Modify `web-portal/src/components/ConfirmDialog.tsx`:

Replace the entire component to use the new `Dialog` primitive. Keep the same plan detection logic and modify/approve/reject behavior, but render inside `<Dialog open={!!confirmation} onOpenChange={...}>`.

Key changes:
- Remove manual focus management (Radix handles it)
- Remove ESC key handler (Radix handles it)
- Remove custom backdrop (Radix DialogOverlay)
- Keep plan parsing, recommended option, modify textarea logic

- [ ] **Step 4: Run existing ConfirmDialog-related tests**

```bash
cd web-portal && npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add web-portal/
git commit -m "feat(web-portal): add Radix UI primitives and migrate ConfirmDialog"
```

---

## Task 6: TanStack Query (1e)

**Files:**
- Modify: `web-portal/package.json`
- Create: `web-portal/src/lib/query-client.ts`
- Create: `web-portal/src/hooks/use-api.ts`
- Create: `web-portal/src/hooks/use-api.test.ts`
- Modify: `web-portal/src/main.tsx`
- Modify: `web-portal/src/hooks/useDashboard.ts`
- Modify: all 9 admin pages (ConfigPage, ToolsPage, etc.)

- [ ] **Step 1: Install TanStack Query**

```bash
cd web-portal && npm install @tanstack/react-query@^6.0
```

- [ ] **Step 2: Create query client**

Create `web-portal/src/lib/query-client.ts`:

```typescript
import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchInterval: 5_000,
      retry: 1,
    },
  },
})
```

- [ ] **Step 3: Wrap app with QueryClientProvider**

Modify `web-portal/src/main.tsx`:

```typescript
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './lib/query-client'

// In render:
<StrictMode>
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </QueryClientProvider>
</StrictMode>
```

- [ ] **Step 4: Write use-api hook tests**

Create `web-portal/src/hooks/use-api.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useConfig, useTools, useChannels, useSessions, useLogs, useMetrics, useHealth } from './use-api'

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

describe('use-api hooks', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('useConfig fetches /api/config', async () => {
    const data = { values: { key: 'val' }, catalog: {} }
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    const { result } = renderHook(() => useConfig(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(data)
  })

  it('useHealth fetches /health', async () => {
    const data = { status: 'ok', uptime: 100 }
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    const { result } = renderHook(() => useHealth(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(data)
  })

  it('handles fetch errors gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'))
    const { result } = renderHook(() => useConfig(), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.isError).toBe(true))
  })
})
```

- [ ] **Step 5: Implement use-api hooks**

Create `web-portal/src/hooks/use-api.ts`:

```typescript
import { useQuery } from '@tanstack/react-query'

async function fetchApi<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  if (res.status === 204) return null as T
  return res.json()
}

export const useConfig = () =>
  useQuery({ queryKey: ['config'], queryFn: () => fetchApi('/api/config') })

export const useTools = () =>
  useQuery({ queryKey: ['tools'], queryFn: () => fetchApi('/api/tools') })

export const useChannels = () =>
  useQuery({ queryKey: ['channels'], queryFn: () => fetchApi('/api/channels') })

export const useHealth = () =>
  useQuery({ queryKey: ['health'], queryFn: () => fetchApi('/health') })

export const useSessions = () =>
  useQuery({ queryKey: ['sessions'], queryFn: () => fetchApi('/api/sessions') })

export const useMetrics = () =>
  useQuery({ queryKey: ['metrics'], queryFn: () => fetchApi('/api/metrics') })

export const useLogs = () =>
  useQuery({ queryKey: ['logs'], queryFn: () => fetchApi('/api/logs') })

export const useAgents = () =>
  useQuery({ queryKey: ['agents'], queryFn: () => fetchApi('/api/agents') })

export const useDelegations = () =>
  useQuery({ queryKey: ['delegations'], queryFn: () => fetchApi('/api/delegations') })

export const useConsolidation = () =>
  useQuery({ queryKey: ['consolidation'], queryFn: () => fetchApi('/api/consolidation') })

export const useDeployment = () =>
  useQuery({ queryKey: ['deployment'], queryFn: () => fetchApi('/api/deployment') })

export const useMaintenance = () =>
  useQuery({ queryKey: ['maintenance'], queryFn: () => fetchApi('/api/maintenance') })

export const usePersonality = () =>
  useQuery({ queryKey: ['personality'], queryFn: () => fetchApi('/api/personality') })

export const useMemoryStats = () =>
  useQuery({ queryKey: ['memory'], queryFn: () => fetchApi('/api/memory') })

export const useTriggers = () =>
  useQuery({ queryKey: ['triggers'], queryFn: () => fetchApi('/api/triggers') })

export const useDaemon = () =>
  useQuery({ queryKey: ['daemon'], queryFn: () => fetchApi('/api/daemon') })

export const useProviders = (withModels = false) =>
  useQuery({
    queryKey: ['providers', withModels],
    queryFn: () => fetchApi(`/api/providers/available${withModels ? '?withModels=true' : ''}`),
  })
```

- [ ] **Step 6: Run tests**

```bash
cd web-portal && npx vitest run src/hooks/use-api.test.ts
```

Expected: all tests PASS.

- [ ] **Step 7a: Migrate DashboardView to useQuery**

Replace `useDashboard` aggregation hook with individual `useQuery` hooks from `use-api.ts`:

```typescript
const { data: metrics } = useMetrics()
const { data: health } = useHealth()
const { data: triggers } = useTriggers()
const { data: agents } = useAgents()
// etc.
```

Remove the `useDashboard` import. The component's JSX stays the same, just the data source changes.

- [ ] **Step 7b: Migrate ConfigPage, ToolsPage, ChannelsPage**

For each page, replace `useState + useCallback + useAutoRefresh + fetchJson` with the corresponding `use-api` hook. Pattern:

Before: `const [data, setData] = useState(null); const load = useCallback(...); useAutoRefresh(load, 5000)`
After: `const { data, error, isLoading } = useConfig()`

- [ ] **Step 7c: Migrate SessionsPage, LogsPage, IdentityPage**

Same pattern as Step 7b. These pages also have inline styles — keep those for now (removed in Task 7).

- [ ] **Step 7d: Migrate PersonalityPage, MemoryPage, SettingsPage**

PersonalityPage has POST/DELETE mutations — use `useMutation` from TanStack Query for switch/create/delete operations. MemoryPage and SettingsPage follow the standard `useQuery` pattern.

- [ ] **Step 8: Delete useAutoRefresh.ts**

Delete `web-portal/src/hooks/useAutoRefresh.ts` — no longer needed (TanStack Query `refetchInterval` replaces it).

Update `web-portal/src/hooks/useDashboard.ts` — keep the file but simplify it to compose multiple `useQuery` hooks, or mark as deprecated with a comment pointing to individual hooks.

- [ ] **Step 9: Run all tests**

```bash
cd web-portal && npm test
```

Expected: all tests pass.

- [ ] **Step 10: Commit**

```bash
git add web-portal/
git commit -m "feat(web-portal): migrate to TanStack Query, replace manual fetch + polling"
```

---

## Task 7: CSS Migration — Tailwind Classes (1b)

**Files:**
- Modify: all component and page files (see file structure above)
- Delete: `web-portal/src/styles/index.css`, `admin.css`, `sidebar.css`, `setup.css`

This is the largest task. Migrate each component from CSS class names to Tailwind utility classes. Work through components in dependency order: layout first, then shared components, then pages.

- [ ] **Step 1: Migrate AppLayout.tsx**

Replace `className="app-layout"` with Tailwind flex layout:

```tsx
<div className="flex h-screen bg-bg text-text">
  <Sidebar />
  <main className="flex-1 overflow-auto">
    <Outlet />
  </main>
</div>
```

- [ ] **Step 2: Migrate Sidebar.tsx**

Replace all sidebar CSS classes with Tailwind utilities. Key mappings:
- `.sidebar` → `flex flex-col w-60 bg-bg-secondary border-r border-border transition-all duration-300`
- `.sidebar.collapsed` → `w-14`
- `.sidebar-item` → `flex items-center gap-3 px-3 py-2 rounded-lg text-text-secondary hover:bg-surface-hover hover:text-text transition-colors`
- `.sidebar-item.active` → `bg-surface text-accent`
- `.sidebar-footer` → `mt-auto p-3 border-t border-border`

- [ ] **Step 3: Migrate useTheme.ts**

Update `useTheme.ts` to work with Tailwind's `data-theme` attribute (already sets `data-theme` on `documentElement` — verify it works with the `@variant dark` / `@variant light` defined in `globals.css`). No functional changes needed if the existing hook already uses `data-theme`.

- [ ] **Step 4: Migrate ChatView, ChatMessage, ChatInput, EmptyState, TypingIndicator, VoiceOutput, VoiceRecorder**

Replace chat-related CSS classes. Key mappings:
- `.chat-area` → `flex flex-col h-full`
- `.messages` → `flex-1 overflow-y-auto p-4 space-y-4`
- `.message` → `max-w-3xl rounded-xl px-4 py-3`
- `.message.user` → `bg-user-msg ml-auto`
- `.message.ai` → `bg-ai-msg`
- `.input-area` → `border-t border-border p-4`
- `.input-row` → `flex items-end gap-2`
- `.empty-state` → `flex flex-col items-center justify-center h-full text-text-tertiary`

Include VoiceOutput.tsx and VoiceRecorder.tsx in this step (chat-related components).

- [ ] **Step 4: Migrate DashboardView, MetricCard**

Replace dashboard CSS classes:
- `.dashboard-view` → `p-6 space-y-6`
- `.metric-grid` → `grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4`
- `.metric-card` → `rounded-xl border border-border bg-surface p-4`
- `.metric-value` → `text-2xl font-bold text-text`

- [ ] **Step 5: Migrate ErrorBoundary**

Replace hardcoded colors (`#0a0a0f`, `#f87171`, `#00e5ff`) with Tailwind theme classes (`bg-bg`, `text-error`, `text-accent`).

- [ ] **Step 6: Migrate PrimaryWorkerSelector**

Replace CSS classes + remove inline styles (textAlign, lineHeight, padding, fontSize, opacity) with Tailwind equivalents.

- [ ] **Step 8: Migrate admin pages — ConfigPage, ToolsPage, ChannelsPage**

Replace CSS classes with common admin patterns:
- `.admin-page` → `p-6 space-y-6 animate-in fade-in`
- `.page-loading` → `flex items-center justify-center h-64 text-text-secondary`
- `.page-error` → `text-center text-error p-8`
- `.admin-section` → `space-y-3`
- `.admin-section-title` → `text-lg font-semibold text-text tracking-tight`
- `.admin-table` → `w-full text-sm`
- `.admin-search` → `w-full rounded-lg bg-surface border border-border px-3 py-2 text-text placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-accent`

- [ ] **Step 9: Migrate admin pages — SessionsPage, LogsPage, IdentityPage**

Same admin patterns. Also remove ALL inline styles (display, gap, fontSize, color, etc.) — replace with Tailwind utilities (`flex`, `gap-2`, `text-sm`, `text-text-secondary`, etc.).

- [ ] **Step 10: Migrate admin pages — PersonalityPage, MemoryPage, SettingsPage**

PersonalityPage has the most inline styles (~20 instances). Replace every `style={{...}}` with Tailwind classes. MemoryPage has progress bars — use Tailwind width utilities. SettingsPage model selector uses inline padding/opacity — replace with Tailwind.

- [ ] **Step 11: Migrate SetupWizard + 8 setup/ components**

Replace setup CSS classes in SetupWizard.tsx, WelcomeStep.tsx, ProgressBar.tsx, ChannelRagStep.tsx, ReviewStep.tsx, ProvidersStep.tsx, ProjectPathStep.tsx, DirectoryBrowser.tsx, McpInstallPanel.tsx. Keep keyframe animations (move them to globals.css `@layer utilities` block if needed by the wizard).

- [ ] **Step 12: Migrate ConfirmDialog (already Radix from Task 5)**

Ensure ConfirmDialog uses only Tailwind classes — no leftover CSS class references.

- [ ] **Step 13: Update vite.config.ts manualChunks**

Add new vendor chunks for the added dependencies:

```typescript
'ui-vendor': ['lucide-react', '@radix-ui/react-dialog', '@radix-ui/react-dropdown-menu', '@radix-ui/react-tabs', '@radix-ui/react-tooltip'],
'state-vendor': ['zustand', '@tanstack/react-query'],
```

- [ ] **Step 14: Delete old CSS files + remove imports**

```bash
rm web-portal/src/styles/index.css web-portal/src/styles/admin.css web-portal/src/styles/sidebar.css web-portal/src/styles/setup.css
```

Remove old CSS imports from `main.tsx` (the `index.css` and `admin.css` kept since Task 2) and any `sidebar.css`/`setup.css` imports elsewhere. Only `globals.css` + `highlight.js` CSS remain.

- [ ] **Step 15: Run build + visual check**

```bash
cd web-portal && npm run build && npm run preview
```

Open `http://localhost:4173` — verify all 11 pages render correctly with Tailwind styles. Check dark mode toggle, sidebar collapse, chat, dashboard.

- [ ] **Step 16: Run all tests**

```bash
cd web-portal && npm test
```

Expected: all tests pass. Some existing snapshot tests may need updating if they reference old CSS class names.

- [ ] **Step 17: Commit**

```bash
git add web-portal/
git commit -m "feat(web-portal): migrate all components from plain CSS to Tailwind CSS"
```

---

## Task 8: Issue Fixes (1g)

**Files:**
- Modify: `web-portal/src/App.tsx` (404 page)
- Delete: `web-portal/src/components/placeholder/PlaceholderPage.tsx` (issue #8)
- Modify: various files for remaining issues

- [ ] **Step 1: Add 404 page (issue #1)**

Create a simple NotFound component inline in App.tsx or as a separate file:

```typescript
function NotFoundPage() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
      <h1 className="text-6xl font-bold text-text mb-4">404</h1>
      <p className="text-lg mb-6">Page not found</p>
      <a href="/" className="text-accent hover:text-accent-hover transition-colors">
        Back to Chat
      </a>
    </div>
  )
}
```

In App.tsx routes, change the catch-all `/*` route from ChatView to NotFoundPage.

- [ ] **Step 2: Remove PlaceholderPage dead code (issue #8)**

```bash
rm web-portal/src/components/placeholder/PlaceholderPage.tsx
rmdir web-portal/src/components/placeholder/
```

Remove any imports of PlaceholderPage from App.tsx or other files.

- [ ] **Step 3: Fix remaining issues**

Most issues (#4, #11, #14, #17, #18, #19, #20, #24, #26, #27, #28, #29) are already fixed by the Tailwind migration (Task 7), Radix migration (Task 5), and Lucide migration (Task 4):

- #4 (native confirm) — Fixed by Radix Dialog in Task 5
- #11 (inline styles) — Fixed by Tailwind migration in Task 7
- #14 (HMR reconnect) — Check useWebSocket `connect` stability, wrap in useRef if not already
- #17 (!important) — Fixed by removing old CSS in Task 7
- #18 (ARIA) — Fixed by Radix (accessible by default) in Task 5
- #19 (array index keys) — Audit all `.map()` calls, ensure unique keys (log entry IDs, not array indices)
- #20 (console.warn) — Guard with `import.meta.env.DEV` check
- #24 (sessionStorage) — Change session message storage from sessionStorage to localStorage with explicit "clear session" option
- #26 (emoji icons) — Fixed by Lucide in Task 4
- #27 (theme flash) — Add inline script in `index.html` `<head>` to set `data-theme` before React hydrates:
  ```html
  <script>document.documentElement.setAttribute('data-theme',localStorage.getItem('strada-theme')||'dark')</script>
  ```
- #28 (ErrorBoundary colors) — Fixed by Tailwind theme in Task 7
- #29 (undefined CSS class) — Fixed by Tailwind migration in Task 7

- [ ] **Step 4: Run all tests**

```bash
cd web-portal && npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add web-portal/
git commit -m "fix(web-portal): resolve 14 existing issues — 404 page, dead code, a11y, theme flash"
```

---

## Task 9: Test Coverage Completion

**Goal:** Reach ~150 new tests. Tasks 1-8 provide ~30 tests (stores + API hooks). This task adds the remaining ~120 tests.

**Files:**
- Create: `web-portal/src/components/ui/button.test.tsx`
- Create: `web-portal/src/components/ui/dialog.test.tsx`
- Create: `web-portal/src/components/ConfirmDialog.test.tsx`
- Create: `web-portal/src/components/layout/Sidebar.test.tsx`
- Create: `web-portal/src/pages/ConfigPage.test.tsx` (template for all admin pages)
- Create: `web-portal/src/components/ChatView.test.tsx`
- Create: `web-portal/src/hooks/useTheme.test.ts`

- [ ] **Step 1: Write Radix UI component tests (~20 tests)**

Test Button variants/sizes/disabled, Dialog open/close/escape/overlay-click, DropdownMenu trigger/items/keyboard, Tooltip show/hide on hover. Use `@testing-library/react` render + `userEvent`.

- [ ] **Step 2: Write ConfirmDialog tests (~10 tests)**

Test plan detection, recommended option highlight, modify textarea flow, ESC closes, option click calls callback, accessibility (focus trap handled by Radix).

- [ ] **Step 3: Write Sidebar + layout tests (~15 tests)**

Test Lucide icons render as SVG, nav links navigate, collapsed state hides labels, theme toggle switches, active route highlighted, admin section dropdown.

- [ ] **Step 4: Write admin page tests — template pattern (~30 tests)**

Create a test template for admin pages. Each page needs: renders loading state, renders data, renders error state, search/filter works (where applicable). Write ConfigPage.test.tsx as the full template, then replicate the pattern for ToolsPage, ChannelsPage, LogsPage. Use `vi.spyOn(globalThis, 'fetch')` to mock API responses.

- [ ] **Step 5: Write remaining page tests (~20 tests)**

SessionsPage, IdentityPage, PersonalityPage (profile switch + create), MemoryPage, SettingsPage — same pattern as Step 4. PersonalityPage additionally tests mutation flows (create/delete profile).

- [ ] **Step 6: Write ChatView + ChatInput tests (~15 tests)**

Test message rendering (user vs assistant), markdown rendering, streaming indicator, file upload drag/drop, send button disabled when empty, attachment preview + remove.

- [ ] **Step 7: Write theme + a11y tests (~10 tests)**

Test dark/light toggle, theme persisted to localStorage, no theme flash (inline script in index.html), Radix components have proper ARIA attributes, keyboard navigation works on sidebar.

- [ ] **Step 8: Run all tests and verify count**

```bash
cd web-portal && npx vitest run --reporter=verbose 2>&1 | tail -5
```

Expected: ~150+ new tests pass (stores ~15, sidebar ~5, API hooks ~5, UI components ~20, ConfirmDialog ~10, Sidebar+layout ~15, admin pages ~50, ChatView+Input ~15, theme+a11y ~10, plus existing 11 test files).

- [ ] **Step 9: Commit**

```bash
git add web-portal/
git commit -m "test(web-portal): add comprehensive test coverage for UI foundation (~150 tests)"
```

---

## Task 10: Final Verification

- [ ] **Step 1: Run full build**

```bash
cd web-portal && npm run typecheck && npm run build
```

Expected: zero TypeScript errors, build succeeds.

- [ ] **Step 2: Run all frontend tests**

```bash
cd web-portal && npm test
```

Expected: all tests pass (~11 existing + ~150 new).

- [ ] **Step 3: Run backend tests (regression check)**

```bash
cd /Users/okanunico/Documents/Strada/Strada.Brain && npm test
```

Expected: 3919+ backend tests pass. Frontend changes should not affect backend.

- [ ] **Step 4: Visual smoke test**

```bash
cd web-portal && npm run preview
```

Open `http://localhost:4173` and verify:
- [ ] Dark/light theme toggle works with no flash
- [ ] Sidebar navigation works (all 11 pages)
- [ ] Sidebar collapse/expand works
- [ ] Chat input + messages render correctly
- [ ] Dashboard metrics render
- [ ] Setup wizard renders (append `?setup=1`)
- [ ] 404 page shows for invalid routes
- [ ] Icons are SVG (not emoji)
- [ ] No inline styles visible in DOM inspector
- [ ] Mobile responsive (narrow browser window)

- [ ] **Step 5: Git tag**

```bash
git tag workspace-phase-1-complete
```

- [ ] **Step 6: Commit any remaining fixes**

If visual smoke test reveals issues, fix and commit before tagging.

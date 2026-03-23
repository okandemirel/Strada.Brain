# Web Portal: 21st.dev / Shadcn/UI Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate shadcn/ui as the component foundation, replace existing Radix wrappers, add sonner notifications, and evolve the portal's visual identity with glassmorphism/glow/micro-interactions across all panels.

**Architecture:** Shadcn/ui foundation with `@/` path alias → migrate 5 existing UI wrappers → add sonner toast layer + notification center → visual evolution pass on sidebar, chat, dashboard, admin, monitor, and code panels. Each phase produces a working, testable portal.

**Tech Stack:** React 19, Vite, Tailwind CSS v4, shadcn/ui, sonner, Zustand, React Query, Radix UI, Lucide React

**Spec:** `docs/specs/2026-03-23-web-portal-21st-dev-integration-design.md`

---

## File Structure Overview

### New Files
```
web-portal/components.json                    — shadcn/ui config
web-portal/src/lib/utils.ts                   — cn() helper (clsx + tailwind-merge)
web-portal/src/components/ui/badge.tsx         — Badge component
web-portal/src/components/ui/separator.tsx     — Separator component
web-portal/src/components/ui/sheet.tsx         — Sheet (slide-in panel)
web-portal/src/components/ui/scroll-area.tsx   — Custom scrollbar
web-portal/src/components/ui/skeleton.tsx      — Shimmer loading placeholder
web-portal/src/components/ui/input.tsx         — Styled input
web-portal/src/components/ui/table.tsx         — Data table primitives
web-portal/src/components/layout/AdminNav.tsx  — Collapsible admin sidebar section
web-portal/src/components/layout/AdminNav.test.tsx
web-portal/src/components/layout/NotificationCenter.tsx — Sheet-based notification panel
```

### Modified Files (by phase)
```
Phase 0: tsconfig.app.json, vite.config.ts, package.json, globals.css
Phase 1: ui/button.tsx, ui/dialog.tsx, ui/dropdown-menu.tsx, ui/tooltip.tsx, ui/tabs.tsx
         + all test files for migrated components
Phase 2: ui/Toast.tsx (delete), AppLayout.tsx, Sidebar.tsx, workspace-store.ts
Phase 3: Sidebar.tsx, Sidebar.test.tsx, AdminDropdown.tsx → AdminNav.tsx, AdminDropdown.test.tsx
Phase 4: ChatView.tsx, ChatMessage.tsx, ChatInput.tsx, EmptyState.tsx
Phase 5: DashboardView.tsx, MetricCard.tsx
Phase 6: All 10 admin pages (Config, Tools, Channels, Sessions, Logs, Identity, Personality, Memory, Settings + Dashboard)
Phase 7: MonitorPanel.tsx, DAGView.tsx, dag-nodes.tsx, KanbanBoard.tsx, ActivityFeed.tsx, TaskDetailPanel.tsx
Phase 8: CodePanel.tsx, FileTree.tsx, Terminal.tsx, CodeEditor.tsx
```

---

## Phase 0: Shadcn/UI Foundation

### Task 1: Install new dependencies

**Files:**
- Modify: `web-portal/package.json`

- [ ] **Step 1: Install production dependencies**

```bash
cd web-portal && npm install class-variance-authority clsx tailwind-merge sonner
```

- [ ] **Step 2: Verify install**

```bash
cd web-portal && npx tsc --noEmit && npx vitest run --reporter=dot 2>&1 | tail -5
```
Expected: 0 errors, all tests pass

- [ ] **Step 3: Commit**

```bash
git add web-portal/package.json web-portal/package-lock.json
git commit -m "deps(web-portal): add shadcn/ui foundation (cva, clsx, tailwind-merge, sonner)"
```

---

### Task 2: Add `@/` path alias

**Files:**
- Modify: `web-portal/tsconfig.app.json`
- Modify: `web-portal/vite.config.ts`

- [ ] **Step 1: Add paths to tsconfig.app.json**

Add to `compilerOptions`:
```json
"baseUrl": ".",
"paths": {
  "@/*": ["./src/*"]
}
```

- [ ] **Step 2: Add resolve.alias to vite.config.ts**

```ts
import path from 'path'
// ... existing imports

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  // ... rest of config
})
```

- [ ] **Step 3: Verify**

```bash
cd web-portal && npx tsc --noEmit && npx vitest run --reporter=dot 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add web-portal/tsconfig.app.json web-portal/vite.config.ts
git commit -m "build(web-portal): add @/ path alias for shadcn/ui compatibility"
```

---

### Task 3: Create lib/utils.ts and components.json

**Files:**
- Create: `web-portal/src/lib/utils.ts`
- Create: `web-portal/components.json`

- [ ] **Step 1: Create cn() helper**

```ts
// web-portal/src/lib/utils.ts
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

- [ ] **Step 2: Create components.json**

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "default",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/styles/globals.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "darkMode": { "attribute": "data-theme" }
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "iconLibrary": "lucide"
}
```

**Note:** The `darkMode.attribute` key ensures `npx shadcn add` generates components using `[data-theme="dark"]` selectors instead of the default `.dark` class, matching the project's existing toggle mechanism.

- [ ] **Step 3: Verify import works**

```bash
cd web-portal && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add web-portal/src/lib/utils.ts web-portal/components.json
git commit -m "feat(web-portal): add shadcn/ui foundation (cn helper, components.json)"
```

---

### Task 4: Evolve theme — add shadcn CSS variables + glassmorphism utilities

**Files:**
- Modify: `web-portal/src/styles/globals.css`

- [ ] **Step 1: Add shadcn CSS variable layer to dark theme**

After the existing `@theme { ... }` block (line 33), add a new `@layer base` block that maps shadcn variables to existing ones. Also add glassmorphism utility classes.

Add after the `@variant light` line (line 36):

```css
/* ===== Shadcn/UI CSS Variable Bridge ===== */
@layer base {
  :root,
  :root[data-theme="dark"] {
    --background: var(--color-bg);
    --foreground: var(--color-text);
    --card: rgba(255, 255, 255, 0.03);
    --card-foreground: var(--color-text);
    --popover: var(--color-bg-secondary);
    --popover-foreground: var(--color-text);
    --primary: var(--color-accent);
    --primary-foreground: #000000;
    --secondary: var(--color-bg-tertiary);
    --secondary-foreground: var(--color-text);
    --muted: var(--color-bg-tertiary);
    --muted-foreground: var(--color-text-secondary);
    --accent: var(--color-accent);
    --accent-foreground: #000000;
    --destructive: var(--color-error);
    --destructive-foreground: #ffffff;
    --border: var(--color-border);
    --input: var(--color-border);
    --ring: var(--color-accent);
    --radius: 0.75rem;
  }

  :root[data-theme="light"] {
    --background: var(--color-bg);
    --foreground: var(--color-text);
    --card: #ffffff;
    --card-foreground: var(--color-text);
    --popover: var(--color-bg-secondary);
    --popover-foreground: var(--color-text);
    --primary: var(--color-accent);
    --primary-foreground: #ffffff;
    --secondary: var(--color-bg-tertiary);
    --secondary-foreground: var(--color-text);
    --muted: var(--color-bg-tertiary);
    --muted-foreground: var(--color-text-secondary);
    --accent: var(--color-accent);
    --accent-foreground: #ffffff;
    --destructive: var(--color-error);
    --destructive-foreground: #ffffff;
    --border: var(--color-border);
    --input: var(--color-border);
    --ring: var(--color-accent);
    --radius: 0.75rem;
  }
}
```

- [ ] **Step 2: Add glassmorphism keyframes**

Add after the existing keyframes section:

```css
@keyframes glow-pulse {
  0%, 100% { box-shadow: 0 0 15px rgba(0, 229, 255, 0.1); }
  50% { box-shadow: 0 0 25px rgba(0, 229, 255, 0.25); }
}

@keyframes card-lift {
  from { transform: translateY(0); }
  to { transform: translateY(-2px); }
}

@keyframes count-up {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
```

- [ ] **Step 3: Verify theme compiles**

```bash
cd web-portal && npx vite build 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add web-portal/src/styles/globals.css
git commit -m "feat(web-portal): add shadcn CSS variable bridge and glassmorphism keyframes"
```

---

### Task 5: Add ui-vendor chunk to vite config

**Files:**
- Modify: `web-portal/vite.config.ts`

- [ ] **Step 1: Add ui-vendor chunk for cva/clsx/tailwind-merge**

In the `manualChunks` function, add before the `vendor` fallback:

```ts
if (id.includes('class-variance-authority') || id.includes('clsx') || id.includes('tailwind-merge') || id.includes('sonner')) {
  return 'ui-vendor'
}
```

- [ ] **Step 2: Verify build**

```bash
cd web-portal && npx vite build 2>&1 | grep ui-vendor
```
Expected: `dist/assets/ui-vendor-XXXX.js` chunk appears

- [ ] **Step 3: Commit**

```bash
git add web-portal/vite.config.ts
git commit -m "build(web-portal): add ui-vendor chunk for shadcn runtime deps"
```

---

## Phase 1: Base Component Migration

### Task 6: Migrate Button to shadcn/ui pattern

**Files:**
- Modify: `web-portal/src/components/ui/button.tsx`
- Modify: `web-portal/src/components/ui/button.test.tsx`

- [ ] **Step 1: Rewrite button.tsx with cva**

Replace the entire file. Keep the same variant names + add `glow` variant:

```tsx
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer',
  {
    variants: {
      variant: {
        default: 'bg-accent text-black hover:bg-accent-hover active:scale-[0.97]',
        outline: 'border border-border bg-transparent text-text hover:bg-bg-tertiary hover:border-border-hover',
        ghost: 'bg-transparent text-text-secondary hover:bg-bg-tertiary hover:text-text',
        destructive: 'bg-error text-white hover:bg-error/90 active:scale-[0.97]',
        glow: 'bg-accent text-black hover:bg-accent-hover hover:shadow-[0_0_20px_rgba(0,229,255,0.3)] active:scale-[0.97]',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-11 rounded-lg px-6',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props}
    />
  )
)
Button.displayName = 'Button'

export { Button, buttonVariants }
```

- [ ] **Step 2: Update button.test.tsx**

Update imports to use the new export pattern. The existing tests should pass since we kept variant/size names. Update the class assertions to match new classes.

- [ ] **Step 3: Run tests**

```bash
cd web-portal && npx vitest run src/components/ui/button.test.tsx -v
```

- [ ] **Step 4: Commit**

```bash
git add web-portal/src/components/ui/button.tsx web-portal/src/components/ui/button.test.tsx
git commit -m "refactor(web-portal): migrate Button to shadcn/ui cva pattern"
```

---

### Task 7: Migrate Dialog to shadcn/ui pattern

**Files:**
- Modify: `web-portal/src/components/ui/dialog.tsx`
- Modify: `web-portal/src/components/ui/dialog.test.tsx`

- [ ] **Step 1: Rewrite dialog.tsx with cn() and glassmorphism**

Keep all existing exports. Update styling to use `cn()` and add glassmorphism to overlay/content:

```tsx
import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogClose = DialogPrimitive.Close
const DialogPortal = DialogPrimitive.Portal

const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

interface DialogContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  hideClose?: boolean
}

const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, hideClose, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 bg-bg-secondary/90 backdrop-blur-xl border border-white/10 p-6 shadow-2xl rounded-xl animate-[dialog-in_0.2s_ease]',
        className
      )}
      {...props}
    >
      {children}
      {!hideClose && (
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 cursor-pointer">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold leading-none tracking-tight text-text', className)}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-text-secondary', className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog, DialogPortal, DialogOverlay, DialogClose, DialogTrigger,
  DialogContent, DialogTitle, DialogDescription,
}
```

- [ ] **Step 2: Update tests if needed, verify**

```bash
cd web-portal && npx vitest run src/components/ui/dialog.test.tsx -v
```

- [ ] **Step 3: Commit**

```bash
git add web-portal/src/components/ui/dialog.tsx web-portal/src/components/ui/dialog.test.tsx
git commit -m "refactor(web-portal): migrate Dialog to shadcn/ui pattern with glassmorphism"
```

---

### Task 8: Migrate DropdownMenu, Tooltip, Tabs to cn() pattern

**Files:**
- Modify: `web-portal/src/components/ui/dropdown-menu.tsx`
- Modify: `web-portal/src/components/ui/tooltip.tsx`
- Modify: `web-portal/src/components/ui/tabs.tsx`

- [ ] **Step 1: Rewrite dropdown-menu.tsx with cn()**

Same exports, add `cn()` for className merging, add glassmorphism to content:
- DropdownMenuContent: `bg-bg-secondary/90 backdrop-blur-xl border-white/10`
- DropdownMenuItem: hover glow effect

- [ ] **Step 2: Rewrite tooltip.tsx with cn()**

Same exports, `cn()` for className, glassmorphism content.

- [ ] **Step 3: Rewrite tabs.tsx with cn()**

Same exports, `cn()` for className. Active tab: cyan bottom bar + glow.

- [ ] **Step 4: Run all UI tests**

```bash
cd web-portal && npx vitest run src/components/ui/ -v
```

- [ ] **Step 5: Commit**

```bash
git add web-portal/src/components/ui/dropdown-menu.tsx web-portal/src/components/ui/tooltip.tsx web-portal/src/components/ui/tabs.tsx
git commit -m "refactor(web-portal): migrate DropdownMenu, Tooltip, Tabs to shadcn/ui pattern"
```

---

### Task 9: Add new base components (Badge, Separator, Sheet, ScrollArea, Skeleton, Input, Table)

**Files:**
- Create: `web-portal/src/components/ui/badge.tsx`
- Create: `web-portal/src/components/ui/separator.tsx`
- Create: `web-portal/src/components/ui/sheet.tsx`
- Create: `web-portal/src/components/ui/scroll-area.tsx`
- Create: `web-portal/src/components/ui/skeleton.tsx`
- Create: `web-portal/src/components/ui/input.tsx`
- Create: `web-portal/src/components/ui/table.tsx`

- [ ] **Step 1: Create each component following shadcn/ui standard patterns**

Use `npx shadcn@latest add badge separator sheet scroll-area skeleton input table` if the CLI works with the current config. Otherwise, create manually using shadcn/ui source code adapted to use `@/lib/utils` imports and the project's theme variables.

Each component should:
- Import `cn` from `@/lib/utils`
- Use `cva` for variants where applicable (badge, input)
- Apply glassmorphism to appropriate surfaces (sheet content, scroll-area)
- Use `forwardRef` for all components

- [ ] **Step 2: Add Radix dependencies if needed**

```bash
cd web-portal && npm install @radix-ui/react-scroll-area @radix-ui/react-separator
```

Note: Sheet uses the existing `@radix-ui/react-dialog` package.

- [ ] **Step 3: Verify TypeScript**

```bash
cd web-portal && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add web-portal/src/components/ui/badge.tsx web-portal/src/components/ui/separator.tsx web-portal/src/components/ui/sheet.tsx web-portal/src/components/ui/scroll-area.tsx web-portal/src/components/ui/skeleton.tsx web-portal/src/components/ui/input.tsx web-portal/src/components/ui/table.tsx web-portal/package.json web-portal/package-lock.json
git commit -m "feat(web-portal): add shadcn base components (Badge, Sheet, ScrollArea, Skeleton, Input, Table, Separator)"
```

---

## Phase 2: Notification System (Sonner)

### Task 10: Replace Toast with Sonner

**Files:**
- Modify: `web-portal/src/components/layout/AppLayout.tsx` — replace `ToastContainer` with `<Toaster />`
- Modify: `web-portal/src/hooks/use-dashboard-socket.ts` — fire sonner toasts on WS events
- Modify: `web-portal/src/components/ui/Toast.tsx` — delete or gut
- Modify: `web-portal/src/components/ui/Toast.test.tsx` — rewrite for sonner

- [ ] **Step 1: Update AppLayout to use Sonner Toaster**

In `AppLayout.tsx`, replace:
```tsx
import ToastContainer from '../ui/Toast'
```
with:
```tsx
import { Toaster } from 'sonner'
```

Replace `<ToastContainer />` with:
```tsx
<Toaster
  position="bottom-right"
  toastOptions={{
    style: {
      background: 'var(--color-bg-secondary)',
      border: '1px solid rgba(255,255,255,0.1)',
      color: 'var(--color-text)',
      backdropFilter: 'blur(16px)',
    },
  }}
  visibleToasts={3}
/>
```

- [ ] **Step 2: Update dispatchWorkspaceMessage to fire sonner toasts**

In `use-dashboard-socket.ts`, add import:
```tsx
import { toast } from 'sonner'
```

In `workspace:mode_suggest` case, **replace** the existing `ws.addNotification(...)` block (lines 98–105) with a Sonner toast call. The store's `addNotification` is removed here because Sonner now owns transient display, and the notification will still be recorded in the store via a separate `addNotification` call for persistent history:

```tsx
if (!ws.userOverride && payload.mode !== prevMode) {
  // Persistent history (Notification Center reads from store)
  ws.addNotification({
    kind: 'mode_suggest',
    title: 'Mode switched',
    message: (payload.reason as string) ?? `Switched to ${payload.mode}`,
    severity: 'info',
  })
  // Transient toast (Sonner manages display/dismiss lifecycle)
  toast.info((payload.reason as string) ?? `Switched to ${payload.mode}`, {
    action: {
      label: 'Undo',
      onClick: () => useWorkspaceStore.getState().undoModeSwitch(),
    },
  })
}
```

In `workspace:notification` case, add Sonner toast AFTER the existing `addNotification(...)` call (store keeps the persistent record, Sonner shows the transient toast):

```tsx
const severity = (payload.severity as string) ?? 'info'
const message = (payload.message as string) ?? ''
if (severity === 'error') toast.error(message)
else if (severity === 'warning') toast.warning(message)
else toast.info(message)
```

- [ ] **Step 3: Delete Toast.tsx contents, keep file as re-export stub**

Replace Toast.tsx contents with:
```tsx
// Toasts are now handled by Sonner. See AppLayout.tsx.
// This file is kept for backwards compatibility with tests.
export default function ToastContainer() { return null }
```

- [ ] **Step 4: Update Toast.test.tsx**

Rewrite to test that sonner Toaster renders in AppLayout. Keep minimal — sonner's own tests handle toast behavior.

- [ ] **Step 5: Update AppLayout.test.tsx**

If `AppLayout.test.tsx` references `ToastContainer` in assertions or renders, update to expect `<Toaster />` from sonner (or verify it renders via the `[data-sonner-toaster]` attribute). Check and update any mocks that reference the old Toast import path.

- [ ] **Step 6: Run all tests**

```bash
cd web-portal && npx vitest run -v 2>&1 | tail -10
```

- [ ] **Step 7: Commit**

```bash
git add web-portal/src/components/layout/AppLayout.tsx web-portal/src/components/layout/AppLayout.test.tsx web-portal/src/hooks/use-dashboard-socket.ts web-portal/src/components/ui/Toast.tsx web-portal/src/components/ui/Toast.test.tsx
git commit -m "feat(web-portal): replace custom Toast with Sonner notification system"
```

---

### Task 11: Add Notification Center (Sheet)

**Files:**
- Create: `web-portal/src/components/layout/NotificationCenter.tsx`
- Modify: `web-portal/src/components/layout/Sidebar.tsx` — bell button opens NotificationCenter

- [ ] **Step 1: Create NotificationCenter component**

A Sheet that slides from the right, shows all notifications from workspace-store grouped by today/older, with read/dismiss/clear-all actions.

```tsx
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { ScrollArea } from '../ui/scroll-area'
import { Badge } from '../ui/badge'
import { Separator } from '../ui/separator'

interface NotificationCenterProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function NotificationCenter({ open, onOpenChange }: NotificationCenterProps) {
  const notifications = useWorkspaceStore((s) => s.notifications)
  const dismissNotification = useWorkspaceStore((s) => s.dismissNotification)

  const today = new Date().setHours(0, 0, 0, 0)
  const todayItems = notifications.filter((n) => n.timestamp >= today)
  const olderItems = notifications.filter((n) => n.timestamp < today)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-80 bg-bg-secondary/90 backdrop-blur-xl border-white/10">
        <SheetHeader>
          <SheetTitle className="flex items-center justify-between">
            Notifications
            {notifications.length > 0 && (
              <Badge variant="secondary">{notifications.length}</Badge>
            )}
          </SheetTitle>
        </SheetHeader>
        <ScrollArea className="h-[calc(100vh-6rem)] mt-4">
          {notifications.length === 0 ? (
            <div className="text-center text-sm text-text-tertiary py-12">No notifications</div>
          ) : (
            <>
              {todayItems.length > 0 && (
                <div className="mb-4">
                  <div className="text-xs font-semibold text-text-tertiary uppercase mb-2">Today</div>
                  {todayItems.reverse().map((n) => (
                    <NotificationItem key={n.id} notification={n} onDismiss={dismissNotification} />
                  ))}
                </div>
              )}
              {olderItems.length > 0 && (
                <>
                  <Separator className="my-3" />
                  <div>
                    <div className="text-xs font-semibold text-text-tertiary uppercase mb-2">Earlier</div>
                    {olderItems.reverse().map((n) => (
                      <NotificationItem key={n.id} notification={n} onDismiss={dismissNotification} />
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
```

- [ ] **Step 2: Update Sidebar to use NotificationCenter**

Replace the current inline notification dropdown (added in bug fix) with the Sheet-based NotificationCenter. The bell button toggles `notifOpen` state which controls the Sheet.

- [ ] **Step 3: Run tests**

```bash
cd web-portal && npx vitest run -v 2>&1 | tail -10
```

- [ ] **Step 4: Commit**

```bash
git add web-portal/src/components/layout/NotificationCenter.tsx web-portal/src/components/layout/Sidebar.tsx
git commit -m "feat(web-portal): add Notification Center sheet with grouped history"
```

---

## Phase 3: Sidebar Evolution

### Task 12: Glassmorphism sidebar + micro-interactions

**Files:**
- Modify: `web-portal/src/components/layout/Sidebar.tsx`
- Modify: `web-portal/src/components/layout/Sidebar.test.tsx`

- [ ] **Step 1: Apply glassmorphism to sidebar container**

Update `<aside>` classes:
- Background: `bg-bg-secondary/80 backdrop-blur-xl border-r border-white/5`
- Mode buttons: active state gets `before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:h-5 before:w-0.5 before:bg-accent before:rounded-r` (left cyan bar)
- Hover: `hover:translate-x-0.5 transition-all duration-150`

- [ ] **Step 2: Run tests**

```bash
cd web-portal && npx vitest run src/components/layout/Sidebar.test.tsx -v
```

- [ ] **Step 3: Commit**

```bash
git add web-portal/src/components/layout/Sidebar.tsx web-portal/src/components/layout/Sidebar.test.tsx
git commit -m "feat(web-portal): glassmorphism sidebar with micro-interactions"
```

---

### Task 13: Replace AdminDropdown with collapsible AdminNav

**Files:**
- Create: `web-portal/src/components/layout/AdminNav.tsx`
- Create: `web-portal/src/components/layout/AdminNav.test.tsx`
- Modify: `web-portal/src/components/layout/Sidebar.tsx` — import AdminNav instead of AdminDropdown
- Delete: `web-portal/src/components/layout/AdminDropdown.tsx` (after migration)
- Delete: `web-portal/src/components/layout/AdminDropdown.test.tsx`

- [ ] **Step 1: Create AdminNav collapsible component**

In-sidebar collapsible group with chevron toggle, smooth height animation, NavLink items with cyan active highlight. Must call `setMode('chat')` on link click (preserve bug fix behavior).

- [ ] **Step 2: Create AdminNav.test.tsx**

Test: renders admin links, collapsed/expanded state, active route highlighting, click sets mode to chat.

- [ ] **Step 3: Update Sidebar to use AdminNav**

Replace `<AdminDropdown collapsed={collapsed} />` with `<AdminNav collapsed={collapsed} />`.

- [ ] **Step 4: Update Sidebar.test.tsx mock path**

Change `vi.mock('./AdminDropdown', ...)` to `vi.mock('./AdminNav', ...)` at line 75 of `Sidebar.test.tsx`. Update the mock component name accordingly.

- [ ] **Step 5: Delete old AdminDropdown files**

Remove `AdminDropdown.tsx` and `AdminDropdown.test.tsx`.

- [ ] **Step 6: Run all tests**

```bash
cd web-portal && npx vitest run -v 2>&1 | tail -10
```

- [ ] **Step 7: Commit**

```bash
git add -A web-portal/src/components/layout/
git commit -m "feat(web-portal): replace AdminDropdown with collapsible AdminNav section"
```

---

### Task 13b: MiniChat glassmorphism enhancement

**Files:**
- Modify: `web-portal/src/components/workspace/MiniChat.tsx`
- Modify: `web-portal/src/components/workspace/MiniChat.test.tsx`

- [ ] **Step 1: Apply glassmorphism to MiniChat container**

- Container: `bg-white/3 backdrop-blur border border-white/5 rounded-xl`
- Input area: glassmorphism with focus glow
- Last message preview with truncation
- Click anywhere to switch to Chat mode

- [ ] **Step 2: Run tests**

```bash
cd web-portal && npx vitest run src/components/workspace/MiniChat -v
```

- [ ] **Step 3: Commit**

```bash
git add web-portal/src/components/workspace/MiniChat.tsx web-portal/src/components/workspace/MiniChat.test.tsx
git commit -m "feat(web-portal): glassmorphism MiniChat with message preview"
```

---

## Phase 4: Chat Interface

### Task 14: Glassmorphism chat messages + input

**Files:**
- Modify: `web-portal/src/components/ChatMessage.tsx`
- Modify: `web-portal/src/components/ChatInput.tsx`
- Modify: `web-portal/src/components/ChatView.tsx`
- Modify: `web-portal/src/components/EmptyState.tsx`
- Modify: `web-portal/src/components/TypingIndicator.tsx`

- [ ] **Step 1: Update ChatMessage bubbles**

- User messages: `bg-gradient-to-br from-accent/10 to-accent/5 rounded-2xl`
- AI messages: `bg-white/3 backdrop-blur border border-white/5 rounded-2xl` with avatar
- Hover: reveal timestamp + copy button
- Code blocks: add copy button via custom rehype plugin or wrapper

- [ ] **Step 2: Update ChatInput**

- Glassmorphism container: `backdrop-blur bg-white/5 border border-white/10`
- Focus glow: `focus-within:border-accent focus-within:shadow-[0_0_15px_rgba(0,229,255,0.15)]`
- Send button: `bg-accent hover:scale-105 hover:shadow-[0_0_20px_rgba(0,229,255,0.3)]`
- Auto-resize textarea

- [ ] **Step 3: Update EmptyState**

- Glassmorphism card, subtle glow on logo, improved copy

- [ ] **Step 4: Update TypingIndicator**

- Glassmorphism container for bounce dots

- [ ] **Step 5: Run tests**

```bash
cd web-portal && npx vitest run src/components/Chat -v
```

- [ ] **Step 6: Commit**

```bash
git add web-portal/src/components/ChatMessage.tsx web-portal/src/components/ChatInput.tsx web-portal/src/components/ChatView.tsx web-portal/src/components/EmptyState.tsx web-portal/src/components/TypingIndicator.tsx
git commit -m "feat(web-portal): glassmorphism chat interface with glow effects"
```

---

## Phase 5: Dashboard

### Task 15: Redesign MetricCard + Dashboard layout

**Files:**
- Modify: `web-portal/src/components/MetricCard.tsx`
- Modify: `web-portal/src/components/DashboardView.tsx`

- [ ] **Step 1: Redesign MetricCard**

- Glassmorphism: `bg-white/3 backdrop-blur-xl border border-white/8 rounded-2xl`
- Left accent strip: 3px colored bar based on status prop
- Count-up animation: `animate-[count-up_0.4s_ease]`
- Hover lift: `hover:-translate-y-0.5 hover:shadow-[0_0_20px_rgba(0,229,255,0.15)]`
- Optional sparkline SVG slot

- [ ] **Step 2: Update DashboardView layout**

- Replace loading text with `<Skeleton />` components
- Section headers with subtle gradient underline
- Grid layout: `grid-cols-2 lg:grid-cols-4` for metric cards
- Glassmorphism section containers

- [ ] **Step 3: Add SVG sparkline component**

Inline SVG `<polyline>` rendered from `recentTokenUsage` data. No new dependency.

- [ ] **Step 4: Run tests**

```bash
cd web-portal && npx vitest run src/components/Dashboard -v && npx vitest run src/components/MetricCard -v
```

- [ ] **Step 5: Commit**

```bash
git add web-portal/src/components/MetricCard.tsx web-portal/src/components/DashboardView.tsx
git commit -m "feat(web-portal): glassmorphism dashboard with animated MetricCards and sparklines"
```

---

## Phase 6: Admin Pages Consistency Pass

### Task 16: Common admin patterns + page-by-page updates

**Files:**
- Modify: All 10 admin pages in `web-portal/src/pages/`
- Potentially create: shared `AdminPageHeader` component

- [ ] **Step 1: Create AdminPageHeader pattern**

Reusable header with title + optional description. Apply to all admin pages.

- [ ] **Step 2: Update all admin pages**

For each page (ConfigPage, ToolsPage, ChannelsPage, SessionsPage, LogsPage, IdentityPage, PersonalityPage, MemoryPage, SettingsPage):
- Replace `bg-bg-secondary border-border` cards with glassmorphism
- Replace "Loading..." text with `<Skeleton />` shimmer
- Replace plain tables with shadcn `<Table>` component
- Add `<Badge>` for status indicators
- Add `<Input>` with search icon for filter fields
- Consistent error state: icon + message + retry button

- [ ] **Step 3: Run all admin page tests**

```bash
cd web-portal && npx vitest run src/pages/ -v
```

- [ ] **Step 4: Commit per page or as batch**

```bash
git add web-portal/src/pages/ web-portal/src/components/
git commit -m "feat(web-portal): glassmorphism admin pages with shadcn Table, Badge, Skeleton"
```

---

## Phase 7: Monitor Panel

### Task 17: Glassmorphism monitor components

**Files:**
- Modify: `web-portal/src/components/monitor/dag-nodes.tsx`
- Modify: `web-portal/src/components/monitor/DAGView.tsx`
- Modify: `web-portal/src/components/monitor/KanbanBoard.tsx`
- Modify: `web-portal/src/components/monitor/ActivityFeed.tsx`
- Modify: `web-portal/src/components/monitor/TaskDetailPanel.tsx`
- Modify: `web-portal/src/components/monitor/MonitorPanel.tsx`

- [ ] **Step 1: Update DAG node cards**

- Glassmorphism card + status-based left border
- Executing nodes: cyan pulse animation
- Completed: green border, Failed: red border

- [ ] **Step 2: Update Kanban cards**

- Glassmorphism cards, drag glow + scale
- Column headers with `<Badge>` count

- [ ] **Step 3: Update ActivityFeed**

- Timeline layout: vertical left line + dot indicators
- Slide-in animation for new entries
- Tool names in `<Badge>` components

- [ ] **Step 4: Update empty states**

- Large icon + description for when no tasks are running

- [ ] **Step 5: Run monitor tests**

```bash
cd web-portal && npx vitest run src/components/monitor/ -v
```

- [ ] **Step 6: Commit**

```bash
git add web-portal/src/components/monitor/
git commit -m "feat(web-portal): glassmorphism monitor panel with timeline activity feed"
```

---

## Phase 8: Code Panel

### Task 18: Code panel visual refinements

**Files:**
- Modify: `web-portal/src/components/code/CodePanel.tsx`
- Modify: `web-portal/src/components/code/FileTree.tsx`
- Modify: `web-portal/src/components/code/CodeEditor.tsx`
- Modify: `web-portal/src/components/code/Terminal.tsx`

- [ ] **Step 1: Update FileTree**

- File/folder icons by extension (use lucide: FileCode, FileJson, Settings, etc.)
- Hover: glassmorphism highlight
- Active file: cyan text + left bar indicator
- Smooth expand/collapse animation

- [ ] **Step 2: Update editor tabs**

- Glassmorphism tab bar
- Active tab: bottom cyan bar + glow
- Modified dot indicator, hover-reveal close button

- [ ] **Step 3: Update Terminal container**

- Glassmorphism border
- Subtle empty state

- [ ] **Step 4: Run code panel tests**

```bash
cd web-portal && npx vitest run src/components/code/ -v
```

- [ ] **Step 5: Commit**

```bash
git add web-portal/src/components/code/
git commit -m "feat(web-portal): glassmorphism code panel with file type icons and tab glow"
```

---

## Final Verification

### Task 19: Full test suite + build verification

- [ ] **Step 1: Run complete test suite**

```bash
cd web-portal && npx vitest run -v
```
Expected: All tests pass

- [ ] **Step 2: TypeScript check**

```bash
cd web-portal && npx tsc --noEmit
```
Expected: 0 errors

- [ ] **Step 3: Production build**

```bash
cd web-portal && npx vite build
```
Expected: Successful build with ui-vendor chunk

- [ ] **Step 4: Run full project tests**

```bash
cd /Users/okanunico/Documents/Strada/Strada.Brain && npx vitest run
```
Expected: All 4300+ tests pass

- [ ] **Step 5: Manual visual verification**

Start the portal and verify each panel:
- Chat: glassmorphism messages, input glow, empty state
- Monitor: DAG node styles, activity timeline
- Canvas: unchanged (tldraw)
- Code: file tree icons, tab glow, terminal
- Admin pages: glassmorphism cards, skeleton loading, scrolling works
- Sidebar: glassmorphism, collapsible admin nav, micro-interactions
- Notifications: sonner toasts appear, bell opens Sheet center
- Light mode: all glassmorphism adapts correctly

- [ ] **Step 6: Final commit**

```bash
git add -A && git commit -m "feat(web-portal): complete 21st.dev/shadcn-ui integration with glassmorphism visual evolution"
```

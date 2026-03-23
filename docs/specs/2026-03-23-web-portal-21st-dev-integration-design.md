# Web Portal: 21st.dev / Shadcn/UI Integration Design

**Date:** 2026-03-23
**Status:** Approved
**Scope:** Full shadcn/ui migration + 21st.dev component adoption + visual identity evolution

## Overview

Integrate shadcn/ui as the component foundation for the Strada.Brain web portal, enabling seamless adoption of 21st.dev community components. Evolve the portal's visual identity from flat dark UI to a modern glassmorphism-based design while preserving the core cyan (#00e5ff) brand palette.

## Current State

- **No shadcn/ui**: Radix UI primitives manually wrapped (dialog, dropdown-menu, tooltip)
- **Custom dark theme**: CSS variables in `globals.css` (Tailwind v4)
- **Stack**: React 19, Vite, Zustand, React Query, Lucide icons
- **Existing components**: Monaco Editor, ReactFlow (DAG), tldraw (Canvas), xterm (Terminal)

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Integration approach | Full shadcn/ui migration | Enables `npx shadcn` for future 21st.dev components |
| Visual identity | Evolve (option B) | Keep core palette, add glassmorphism/glow/micro-interactions |
| Scope | All areas | Chat, dashboard, admin, sidebar, notifications, monitor, code |

---

## Phase 0: Shadcn/UI Foundation + Theme Evolution

### Setup
- Create `components.json` (Tailwind v4 config, custom paths — see concrete example below)
- Create `src/lib/utils.ts` with `cn()` helper (clsx + tailwind-merge)
- Add `@/` path alias to `tsconfig.json` (`"paths": { "@/*": ["./src/*"] }`) and `vite.config.ts` (`resolve.alias: { "@": path.resolve(__dirname, "src") }`)
- Map CSS variables to shadcn/ui format
- Reconcile dark mode: project uses `data-theme="dark"` attribute (not `.dark` class). Shadcn components.json must set `darkMode: { attribute: "data-theme" }` so generated components respect the existing toggle.

### components.json (Draft)
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
    "cssVariables": true
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

### CSS Variable Mapping (Dark Mode)

```
shadcn variable     → existing variable
--background        → --color-bg (#0a0a0f)
--foreground        → --color-text (#e8e8ed)
--primary           → --color-accent (#00e5ff)
--primary-foreground → #000000
--muted             → --color-bg-tertiary (#1a1a25)
--muted-foreground  → --color-text-secondary (#a0a0b0)
--border            → --color-border (#2a2a3a)
--card              → glassmorphism variant (rgba(255,255,255,0.03))
--destructive       → --color-error (#f87171)
```

### CSS Variable Mapping (Light Mode)

The project already has a full `[data-theme="light"]` override block in `globals.css` (lines 122–151). Shadcn CSS variables must be emitted under `[data-theme="light"]` (not the default `.dark` class). The `@variant light` directive already handles this: `@variant light (&:where([data-theme="light"], [data-theme="light"] *))`.

**Strategy:** Emit shadcn variables inside both `[data-theme="dark"]` and `[data-theme="light"]` blocks within `globals.css`, mapping to the existing light theme values. No change to the `useTheme` hook or `data-theme` toggle mechanism.

### Theme Evolution — New Visual Properties

| Feature | Implementation |
|---------|---------------|
| Glassmorphism | `backdrop-blur-xl bg-white/5 border-white/10` on cards, panels, sidebar |
| Subtle gradients | `bg-gradient-to-br from-accent/10 to-transparent` on headers, active cards |
| Glow effects | `shadow-[0_0_20px_rgba(0,229,255,0.15)]` on hover/active states |
| Micro-interactions | Button hover scale, card lift, sidebar item slide |
| Depth layers | Surface → elevated → floating elevation system |

### New Dependencies
- `sonner` — toast notifications
- `class-variance-authority` — component variants (shadcn requirement)
- `clsx` + `tailwind-merge` — cn() helper (shadcn requirement)

---

## Phase 1: Base Component Migration

### Existing Wrappers → Shadcn/UI

| Current | After | Changes |
|---------|-------|---------|
| `ui/button.tsx` | shadcn Button | `ghost`, `outline`, `glow` variants + hover scale |
| `ui/dialog.tsx` | shadcn Dialog | Glassmorphism overlay, backdrop-blur |
| `ui/dropdown-menu.tsx` | shadcn DropdownMenu | Smooth animation, item hover glow |
| `ui/tooltip.tsx` | shadcn Tooltip | Subtle border glow |
| `ui/tabs.tsx` | shadcn Tabs | Used in CodePanel, MonitorPanel; glassmorphism active indicator |

### New Base Components
- **Sheet** — Slide-in panel for admin/notifications (mobile: full-screen)
- **Separator** — Section dividers
- **Badge** — Status indicators (connected, error, warning, tier labels)
- **ScrollArea** — Custom scrollbar for admin panels
- **Skeleton** — Shimmer loading states
- **Input** — Styled input with search icon variant
- **Table** — Sortable, hoverable data tables

---

## Phase 2: Notification System (Sonner)

### Toast Notifications (Instant)
- Position: bottom-right, slides in
- Types: success (green), error (red), info (cyan), warning (yellow)
- Action button support (e.g., "Mode switched → Undo")
- Stacking: max 3 simultaneous toasts
- Auto-dismiss with configurable duration

### Notification Center (Persistent)
- Opens as Sheet from sidebar bell button (slides from right)
- Full history with timestamps
- Read/unread state
- "Clear all" button
- Grouping: today / older

### Lifecycle Ownership

Two distinct layers with clear ownership:

| Layer | Owner | Responsibility |
|-------|-------|---------------|
| **Transient toasts** | Sonner | Fire-and-forget display, auto-dismiss timers, stacking. Sonner manages its own lifecycle — no coupling to store. |
| **Persistent history** | `workspace-store.notifications` | All notifications stored with timestamps. `dismissNotification` becomes "mark as read/archive" (not "remove from toast"). Notification Center (Sheet) reads from this store. |

### Migration from existing Toast.tsx

The existing `ToastContainer` in `AppLayout.tsx` and `Toast.tsx` component will be replaced by Sonner's `<Toaster />` component. This is a hard cutover during Phase 2 — both files are updated in the same commit. The `workspace-store` notification actions (`addNotification`, `dismissNotification`) remain unchanged but their semantics shift from "show/hide toast" to "record/archive notification."

### WebSocket Integration
- `workspace:notification` → sonner toast (transient) + notification store (persistent)
- `workspace:mode_suggest` → sonner toast with "Switched to Monitor" + undo action + store entry

---

## Phase 3: Sidebar Evolution

### Visual Upgrades
- Glassmorphism background: `backdrop-blur-xl bg-bg-secondary/80 border-r border-white/5`
- Logo area: subtle gradient divider, brand glow
- Active mode button: 2px cyan left bar + intensified glow background
- Hover: items shift right (`translateX(2px)`) + background fade-in
- Collapse/expand: smooth width animation + icon rotation

### Admin Dropdown → Collapsible Section
- Replace dropdown with in-sidebar collapsible group
- Chevron toggle with smooth height animation
- Admin pages directly visible in sidebar
- Active admin page highlighted in cyan

**Test breakage note:** `AdminDropdown.test.tsx` (4 tests) asserts on DropdownMenu behavior (`role="menuitem"`, open/close). `Sidebar.test.tsx` mocks `AdminDropdown` by path. Both test files must be rewritten when the collapsible section replaces the dropdown. The new component (e.g., `AdminNav.tsx`) needs corresponding tests for collapsible behavior, active route highlighting, and keyboard navigation.

### MiniChat Enhancement
- Glassmorphism container
- Last message preview + "typing..." animation
- Click to switch to Chat mode

---

## Phase 4: Chat Interface

### Message Bubbles
- User: right-aligned, gradient background (`from-accent/10 to-accent/5`), rounded-2xl
- AI: left-aligned, glassmorphism card (`bg-white/3 backdrop-blur`), with avatar
- Entry animation: existing `msg-in` + subtle blur-in
- Hover: timestamp + action buttons (copy, retry) appear

### Chat Input
- Glassmorphism: `backdrop-blur bg-white/5 border-white/10`
- Focus: cyan glow border + subtle ring
- Attach button: file upload + image preview (existing MediaProcessor)
- Send button: filled cyan, hover scale + glow pulse
- Shift+Enter: multiline, auto-resize textarea

### Typing Indicator
- Existing bounce-dot in glassmorphism container
- Shown next to AI avatar

### Streaming & Markdown
- Token-by-token render unchanged
- Code blocks: "copy" button added

---

## Phase 5: Dashboard

### MetricCard Redesign
- Glassmorphism: `bg-white/3 backdrop-blur-xl border border-white/8 rounded-2xl`
- Left accent strip (color by status: cyan/green/yellow/red)
- Large value font + count-up animation
- Subtle sparkline/mini-chart at bottom (trend)
- Hover: card lifts (`translateY(-2px)`) + glow shadow

### Dashboard Layout
- Top band: Uptime, Active Sessions, Total Messages, Token Usage → 4-column grid
- Middle: Provider info, RAG status, Memory stats → info cards
- Bottom: Tool call stats, Security stats → table/bar chart

### Mini Chart Component (SVG-only, no new dependency)
- Sparkline: last 24h token usage trend — inline SVG `<polyline>` rendered from data points
- CSS-only bar chart: tool call distribution — `div` bars with CSS height transitions
- Animated: bars grow upward on page load via CSS `@keyframes`

---

## Phase 6: Admin Pages — Consistency Pass

### Common Patterns (All Admin Pages)
- Page header: title + description + breadcrumb
- Glassmorphism section cards (replacing `bg-bg-secondary border-border`)
- Table redesign: shadcn Table, hover row glow, sticky header
- Loading: skeleton shimmer (replacing "Loading..." text)
- Error: icon + message + retry button
- Empty: illustration/icon + description + CTA button

### Page-Specific Enhancements

| Page | Enhancement |
|------|------------|
| Config | Search icon input, tier badges (core=cyan, advanced=yellow, experimental=purple) |
| Tools | Grid of glassmorphism cards, status badges, mini bar charts for call counts |
| Sessions | Sortable data table, channel icons, duration bars, pagination |
| Logs | Level color coding, auto-scroll + pause/resume, level dropdown filter |
| Personality | Larger profile cards with icons, active glow border, syntax-highlighted SOUL.md |
| Memory | Tier distribution chart (donut/stacked bar), health indicator dots |
| Identity | Current identity card + history timeline |
| Settings | Section cards with toggle switches, recovery surface visualization |

---

## Phase 7: Monitor Panel

### DAG View
- Node cards: glassmorphism + status-based left border color
- Pending: grey, Executing: cyan pulse, Completed: green, Failed: red
- Edges: gradient flow animation (replacing animated dash)
- Zoom controls: glassmorphism container

### Kanban Board
- Column headers: badge with task count
- Task cards: glassmorphism, drag glow + scale(1.02)
- Column separators: subtle gradient

### Activity Feed
- Timeline layout: left border line + dot indicator
- Each entry: timestamp, action icon, detail text
- New entry: slide-in + fade animation
- Tool execution: inline code badge

### Task Detail Panel
- Selected task: expanded glassmorphism card
- Status timeline: pending → executing → review → completed
- Review results: collapsible sections

### Empty State
- Large Activity icon with subtle pulse
- "No active goals" heading + helpful description

---

## Phase 8: Code Panel

### File Tree
- File/folder icons by type (`.cs` → code, `.meta` → settings)
- Hover: glassmorphism highlight
- Active file: cyan text + left bar
- Expand/collapse: smooth height animation

### Editor Tabs
- Glassmorphism tab bar
- Active tab: bottom cyan bar + glow
- Modified indicator: small dot (unsaved changes)
- Close button: visible on hover

### Terminal
- Existing xterm preserved
- Container: glassmorphism border, resize handle
- Subtle empty state for "No terminal output"

---

## Implementation Order & Dependencies

```
Phase 0 (foundation)
  └─→ Phase 1 (base components)
        └─→ Phase 2 (notifications)  ── can run in parallel ──┐
        └─→ Phase 3 (sidebar)        ── can run in parallel ──┤
        └─→ Phase 4 (chat)           ── can run in parallel ──┤
        └─→ Phase 5 (dashboard)      ── can run in parallel ──┤
        └─→ Phase 6 (admin pages)    ── can run in parallel ──┤
        └─→ Phase 7 (monitor)        ── can run in parallel ──┤
        └─→ Phase 8 (code panel)     ── can run in parallel ──┘
```

Phase 0 → 1 are sequential (foundation must exist first).
Phases 2–8 are independent and can be parallelized.

## New Dependencies — Bundle Impact

- `class-variance-authority`, `clsx`, `tailwind-merge` are **production** dependencies (not devDependencies)
- Add to a dedicated `ui-vendor` chunk in `vite.config.ts` `build.rolldownOptions.output` to prevent landing in the main `vendor` catch-all

## Testing Strategy

- All existing web-portal tests must continue passing (currently 447 tests across 58 files)
- New shadcn components: unit tests for custom variants/behaviors
- Phase 3 specifically: rewrite `AdminDropdown.test.tsx` and update `Sidebar.test.tsx` mock
- Phase 2 specifically: update `AppLayout.tsx` import from `Toast` to Sonner `Toaster` in same commit
- Visual regression: manual verification per phase
- Integration: existing workspace-integration tests cover mode switching and WS dispatch

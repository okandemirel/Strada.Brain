# Plan 016: Surface Unity MCP bridge status via GET /api/mcp/status and a portal settings section

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat aea95ad..HEAD -- src/dashboard/server.ts src/dashboard/server-types.ts src/core/tool-registry.ts src/core/strada-mcp-tool-loader.ts web-portal/src/pages/SettingsPage.tsx web-portal/src/i18n/locales`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `aea95ad`, 2026-06-11

## Why this matters

`StradaMcpRuntime` (the Unity editor MCP bridge) tracks rich live state — `bridgeConnected`, `bridgeState` (connected/dormant/...), active editor port/project, available vs unavailable tool counts, last error. Today that state is only rendered once into the boot report (`src/core/boot-report.ts`); no dashboard endpoint or portal surface exposes it afterwards. When the Unity editor bridge degrades mid-session, `unity_*` tools silently become unavailable and the user has no way to see why or to trigger a reconnect. This plan adds a sanitized `GET /api/mcp/status` endpoint, a `POST /api/mcp/reconnect` action (the runtime already has a public on-demand reconnect method), and a portal settings section that displays the bridge state.

## Current state

Relevant files:

- `src/core/strada-mcp-tool-loader.ts` — `StradaMcpRuntime` class (line 360); `getStatus(): StradaMcpRuntimeStatus` at lines 671–698; `StradaMcpRuntimeStatus` interface at lines 204–226; public `async tryLazyReconnect(): Promise<boolean>` at lines 541–563. **Do not modify this file.**
- `src/core/tool-registry.ts` — holds `private stradaMcpRuntime` (line 122, set at line 158); already exposes `getStradaMcpRuntimeStatus()` (lines 362–364). The reconnect delegate will be added next to it.
- `src/dashboard/server-types.ts` — `RouteContext` (route handler context); `toolRegistry?: DashboardToolRegistry` at line 438; the `DashboardToolRegistry` interface at lines 128–143 currently only declares `getAllTools()`.
- `src/dashboard/server.ts` — `buildRouteContext()` at line 483 (passes `toolRegistry` at line 534); the route-dispatch chain at lines ~655–680 where `handleSystemRoutes` / `handleSettingsRoutes` etc. are tried in order; route-handler imports at lines 56–62.
- `src/dashboard/server-settings-routes.ts` — exemplar of the delegated route-handler file pattern: `export function handleXxxRoutes(url, method, req, res, ctx): boolean` using `sendJson` / `sendJsonError` from `./server-types.js`.
- `web-portal/src/pages/SettingsPage.tsx` — sidebar registration: `SIDEBAR_ITEMS` array (lines 21–32), lazy section imports (lines 4–13), `renderSection()` switch (lines 43–57).
- `web-portal/src/pages/settings/RateLimitsSection.tsx` — structural exemplar for a settings section that fetches on mount and POSTs on action (mount-time `fetch('/api/settings/rate-limits')` at lines 52–66, save POST below).
- `web-portal/src/i18n/locales/{en,tr,ja,ko,zh,de,es,fr}/settings.json` — 8 locales. **Important**: these files use FLAT keys with literal dots (e.g. the JSON key is the string `"hub.tabs.voice"`, not nested objects). Sidebar labels are `hub.tabs.*` keys.
- `src/dashboard/canvas-routes.test.ts` — structural exemplar for dashboard route tests (vitest, EventEmitter-based req/res fakes, mocked logger).

The status payload as produced today (`strada-mcp-tool-loader.ts:204-226`) — note `sourcePath` is an **absolute filesystem path** and must NOT be returned by the API:

```ts
export interface StradaMcpRuntimeStatus {
  readonly installed: boolean;
  readonly sourcePath: string | null;        // absolute path — strip before sending
  readonly version: string | null;
  readonly toolCount: number;
  readonly resourceCount: number;
  readonly promptCount: number;
  readonly bridgeConfigured: boolean;
  readonly bridgeConnected: boolean;
  readonly bridgeState: string;
  readonly availableToolCount: number;
  readonly unavailableToolCount: number;
  readonly activeEditorPort?: number | null;
  readonly activeEditorInstanceId?: string | null;
  readonly activeEditorProjectName?: string | null;
  readonly editorSelectionSource?: string | null;
  readonly editorDiscoveryCount?: number;
  readonly bridgeUnavailableReason?: string;
  readonly lastError?: string;
  readonly bridgeProtocolVersion?: string;
  readonly bridgeCapabilityMethodCount?: number;
}
```

The existing registry accessor (`src/core/tool-registry.ts:362-364`):

```ts
getStradaMcpRuntimeStatus(): import("./strada-mcp-tool-loader.js").StradaMcpRuntimeStatus | null {
  return this.stradaMcpRuntime?.getStatus() ?? null;
}
```

The reconnect method that already exists (`strada-mcp-tool-loader.ts:541-544`) — safe to call anytime; it returns the current `bridgeConnected` immediately unless the bridge is dormant:

```ts
async tryLazyReconnect(): Promise<boolean> {
  if (this.bridgeState !== "dormant" || !this.bridgeManager || this.bridgeConnected || this.lazyReconnectInProgress) {
    return this.bridgeConnected;
  }
  ...
```

Verified facts (recon, 2026-06-11):

- `grep -rni "api/mcp" src/dashboard/` → no matches. No MCP route exists.
- The dashboard receives the real `ToolRegistry` instance (it structurally satisfies `DashboardToolRegistry`), so adding optional methods to the interface is safe — the concrete class already has/gets them.
- `RouteContext` route handlers are dispatched behind the dashboard's existing auth/origin handling in `server.ts`; new routes registered in the same chain inherit it.
- Portal settings i18n keys for the en locale live in `web-portal/src/i18n/locales/en/settings.json` as flat dotted strings; `web-portal/src/i18n/index.ts` eagerly imports `settings.json` for all 8 locales.

Conventions: conventional commits; colocated `*.test.ts`; route handler files named `server-<area>-routes.ts`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck (backend) | `npm run typecheck:src` | exit 0 |
| Lint (backend) | `npm run lint:src` | exit 0 |
| Single backend test | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/dashboard/server-mcp-routes.test.ts` | all pass |
| Portal typecheck | `npm --prefix web-portal run typecheck` | exit 0 |
| Portal lint | `npm --prefix web-portal run lint` | exit 0 |
| Portal tests | `npm --prefix web-portal run test` | all pass |
| Portal build | `npm --prefix web-portal run build` | exit 0 |
| i18n key parity | `node -e "const l=['en','tr','ja','ko','zh','de','es','fr'];const k=['hub.tabs.mcp','mcp.title'];for(const x of l){const j=require('./web-portal/src/i18n/locales/'+x+'/settings.json');for(const key of k){if(!(key in j))throw new Error(x+' missing '+key)}};console.log('OK')"` | prints `OK` |

All commands run from `/Users/okanunico/Documents/Strada/Strada.Brain`.

## Scope

**In scope** (the only files you should modify/create):

- `src/core/tool-registry.ts` (modify — add one delegate method)
- `src/dashboard/server-types.ts` (modify — extend `DashboardToolRegistry`)
- `src/dashboard/server-mcp-routes.ts` (create)
- `src/dashboard/server-mcp-routes.test.ts` (create)
- `src/dashboard/server.ts` (modify — import + one dispatch line)
- `web-portal/src/pages/settings/McpSection.tsx` (create)
- `web-portal/src/pages/settings/McpSection.test.tsx` (create)
- `web-portal/src/pages/SettingsPage.tsx` (modify — register section)
- `web-portal/src/i18n/locales/{en,tr,ja,ko,zh,de,es,fr}/settings.json` (modify — add keys)

**Out of scope** (do NOT touch, even though they look related):

- `src/core/strada-mcp-tool-loader.ts` — `getStatus()` and `tryLazyReconnect()` already do everything needed.
- `src/core/boot-report.ts` — boot-time rendering stays as-is.
- WebSocket push of live bridge-state changes (`src/dashboard/websocket-server.ts`) — deferred; this plan is poll/refresh only.
- `src/channels/web/static/` — built portal assets; never edit by hand (the build regenerates them, and this plan does not require committing a rebuilt portal).

## Git workflow

- Branch: `advisor/016-mcp-bridge-status-page`
- Commit per step; conventional commits, e.g. `feat(dashboard): add /api/mcp/status and reconnect endpoints`.
- Do NOT push or open a PR.

## Steps

### Step 1: Investigate and confirm current state

1. `grep -rni "api/mcp" src/dashboard/` → **no output**. If an MCP route already exists, STOP and report.
2. `grep -n "getStradaMcpRuntimeStatus\|tryStradaMcpReconnect" src/core/tool-registry.ts` → exactly one hit, `getStradaMcpRuntimeStatus` around line 362.
3. `grep -n "tryLazyReconnect" src/core/strada-mcp-tool-loader.ts` → a definition around line 541 and one internal call site around line 1023.
4. `grep -n "DashboardToolRegistry" src/dashboard/server-types.ts` → interface around line 128, usage around line 438.
5. `grep -n "hub.tabs.mcp" web-portal/src/i18n/locales/en/settings.json` → no output.
6. Run the drift check from the header.

**Verify**: all of the above match.

### Step 2: Add the reconnect delegate to ToolRegistry and widen DashboardToolRegistry

In `src/core/tool-registry.ts`, directly below `getStradaMcpRuntimeStatus()` (line 364), add:

```ts
/** On-demand Unity bridge reconnect; resolves to the resulting connected state. */
async tryStradaMcpReconnect(): Promise<boolean> {
  return (await this.stradaMcpRuntime?.tryLazyReconnect()) ?? false;
}
```

In `src/dashboard/server-types.ts`, extend the `DashboardToolRegistry` interface (lines 128–143) with two **optional** members (optional, because tests and older callers construct partial stubs):

```ts
getStradaMcpRuntimeStatus?(): import("../core/strada-mcp-tool-loader.js").StradaMcpRuntimeStatus | null;
tryStradaMcpReconnect?(): Promise<boolean>;
```

(Use a type-only import path consistent with how the file imports other types; an inline `import(...)` type as shown is acceptable and avoids new top-of-file imports.)

**Verify**: `npm run typecheck:src` → exit 0.

### Step 3: Create the MCP route handler

Create `src/dashboard/server-mcp-routes.ts`, following the shape of `src/dashboard/server-settings-routes.ts` (header doc comment listing routes, single exported `handleMcpRoutes(url, method, req, res, ctx): boolean`, `sendJson`/`sendJsonError` from `./server-types.js`):

- `GET /api/mcp/status` (also accept `/api/mcp/status?...`):
  - If `!ctx.toolRegistry?.getStradaMcpRuntimeStatus` → `sendJson(res, { installed: false, status: null })`.
  - Else get the status; if `null` → same not-installed payload.
  - Else **sanitize**: destructure `sourcePath` and `activeEditorInstanceId` out, send the rest:
    ```ts
    const { sourcePath: _sourcePath, activeEditorInstanceId: _instanceId, ...safe } = status;
    sendJson(res, { installed: status.installed, status: safe });
    ```
    (`sourcePath` is an absolute path; the instance id is an internal identifier with no UI value. `bridgeUnavailableReason`/`lastError` are short human-readable messages produced by the runtime — pass them through.)
- `POST /api/mcp/reconnect`:
  - If `!ctx.toolRegistry?.tryStradaMcpReconnect` → `sendJsonError(res, 503, "MCP runtime not available")`.
  - Else (async result, synchronous `return true` — same pattern as the POST handlers in `server-settings-routes.ts`):
    ```ts
    void ctx.toolRegistry.tryStradaMcpReconnect().then((connected) => {
      const status = ctx.toolRegistry?.getStradaMcpRuntimeStatus?.() ?? null;
      const { sourcePath: _sp, activeEditorInstanceId: _id, ...safe } = status ?? {};
      sendJson(res, { success: true, bridgeConnected: connected, status: status ? safe : null });
    }).catch((err) => {
      sendJsonError(res, 500, err instanceof Error ? err.message : String(err));
    });
    return true;
    ```
  - `GET`/other methods on `/api/mcp/reconnect` → `sendJsonError(res, 405, "Method not allowed")`.
- Any other `/api/mcp/*` URL → return `false`.

Register it in `src/dashboard/server.ts`: add `import { handleMcpRoutes } from "./server-mcp-routes.js";` next to the other route imports (lines 56–62), and add the dispatch line immediately after the `handleSettingsRoutes` line (~676):

```ts
// MCP bridge routes: mcp/status, mcp/reconnect
if (handleMcpRoutes(url, method, req, res, ctx)) return;
```

**Verify**: `npm run typecheck:src` → exit 0; `npm run lint:src` → exit 0.

### Step 4: Backend route tests

Create `src/dashboard/server-mcp-routes.test.ts` modeled on `src/dashboard/canvas-routes.test.ts` (fake req/res capturing `writeHead`/`end`, `as unknown as RouteContext` stubs). Cases listed in the Test plan.

**Verify**: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/dashboard/server-mcp-routes.test.ts` → all pass.

### Step 5: Portal section component

Create `web-portal/src/pages/settings/McpSection.tsx` modeled on `web-portal/src/pages/settings/RateLimitsSection.tsx` (same `useTranslation('settings')`, mount-time fetch with `.finally(() => setLoaded(true))`, glassmorphism row classes copied from `VoiceSection.tsx`/`RateLimitsSection.tsx`). Behavior:

- On mount: GET `/api/mcp/status`; store `{ installed, status }`.
- Render:
  - Not installed → a single informational row (`t('mcp.notInstalled')`).
  - Installed → rows for: bridge state badge (`status.bridgeState`, green when `bridgeConnected`, red otherwise — copy the badge classes from `VoiceSection.tsx:110-118`), version, tools available (`availableToolCount`/`toolCount`), active editor (`activeEditorProjectName` + `activeEditorPort`, or `t('mcp.noEditor')`), and — only when present — `bridgeUnavailableReason` / `lastError` as a secondary text row.
- Actions: a Refresh button (re-runs the GET) and a Reconnect button that POSTs `/api/mcp/reconnect`, then replaces local state from the returned `status` and toasts `t('mcp.toastReconnected')` when `bridgeConnected` is true, `t('mcp.toastStillDisconnected')` otherwise; toast `t('mcp.toastFailed')` on network/HTTP error (use `toast` from `sonner` like the other sections). Disable both buttons while a request is in flight.

Register it in `web-portal/src/pages/SettingsPage.tsx`:

- `const McpSection = lazy(() => import('./settings/McpSection'))` with the other lazy imports.
- Add `{ id: 'mcp', labelKey: 'hub.tabs.mcp', icon: '🔌' }` to `SIDEBAR_ITEMS` after the `daemon` entry.
- Add `case 'mcp': return <McpSection />` to `renderSection()`.

**Verify**: `npm --prefix web-portal run typecheck` → exit 0; `npm --prefix web-portal run lint` → exit 0.

### Step 6: i18n keys for all 8 locales

Add these FLAT keys (literal dotted key strings, matching the existing style — do NOT create nested objects) to `web-portal/src/i18n/locales/<locale>/settings.json` for every locale `en, tr, ja, ko, zh, de, es, fr`. English values; translate the values for the other locales (keep terms like "MCP", "Unity" untranslated):

```json
"hub.tabs.mcp": "Unity MCP",
"mcp.title": "Unity MCP Bridge",
"mcp.description": "Status of the Strada MCP runtime and Unity editor bridge",
"mcp.notInstalled": "Strada MCP is not installed for this project.",
"mcp.bridgeState": "Bridge state",
"mcp.version": "MCP version",
"mcp.tools": "Unity tools",
"mcp.toolsAvailable": "{{available}} of {{total}} available",
"mcp.activeEditor": "Active editor",
"mcp.noEditor": "No Unity editor connected",
"mcp.lastError": "Last error",
"mcp.refresh": "Refresh",
"mcp.reconnect": "Reconnect",
"mcp.reconnecting": "Reconnecting…",
"mcp.toastReconnected": "Unity bridge reconnected",
"mcp.toastStillDisconnected": "Unity editor is not reachable yet",
"mcp.toastFailed": "Bridge status request failed"
```

Place them adjacent to the existing `voice.*` block in each file, and add `"hub.tabs.mcp"` next to the other `hub.tabs.*` entries. (`mcp.toolsAvailable` uses i18next interpolation — call it as `t('mcp.toolsAvailable', { available, total })`.)

**Verify**: the i18n key-parity command from the command table prints `OK`, and `npm --prefix web-portal run build` exits 0 (build fails on malformed JSON).

### Step 7: Portal component test + full sweep

Create `web-portal/src/pages/settings/McpSection.test.tsx` modeled on `web-portal/src/pages/settings/BudgetSection.test.tsx`, stubbing `fetch` via `vi.stubGlobal`. Cases in the Test plan. Then run the full command table.

**Verify**: `npm --prefix web-portal run test` → all pass; every command in "Commands you will need" succeeds; `git status` shows only in-scope files.

## Test plan

Backend — `src/dashboard/server-mcp-routes.test.ts` (pattern: `src/dashboard/canvas-routes.test.ts`):

1. GET `/api/mcp/status` with no `toolRegistry` in ctx → `{ installed: false, status: null }`.
2. GET with a stub registry returning a full `StradaMcpRuntimeStatus` (include `sourcePath: "/Users/secret/path"`, `activeEditorInstanceId: "abc"`) → response `status` contains `bridgeState`, `bridgeConnected`, `toolCount`, etc. but `JSON.stringify(body)` contains **neither** `sourcePath` nor `activeEditorInstanceId` nor the string `/Users/`.
3. GET with registry whose `getStradaMcpRuntimeStatus()` returns `null` → `{ installed: false, status: null }`.
4. POST `/api/mcp/reconnect` with stub `tryStradaMcpReconnect` resolving `true` → `{ success: true, bridgeConnected: true, status: {...} }` and the stub was called once.
5. POST `/api/mcp/reconnect` with no reconnect-capable registry → 503.
6. GET `/api/mcp/reconnect` → 405.
7. Unknown `/api/mcp/foo` → handler returns `false` (route not handled).

Portal — `web-portal/src/pages/settings/McpSection.test.tsx` (pattern: `BudgetSection.test.tsx`):

1. Renders connected state: stub GET returning `bridgeConnected: true, bridgeState: "connected", availableToolCount: 12, toolCount: 12, activeEditorProjectName: "MyGame"` → "connected" badge text and project name visible.
2. Renders not-installed state: stub GET returning `{ installed: false, status: null }` → `mcp.notInstalled` text visible, no Reconnect button (or disabled — assert per your implementation choice, then keep it).
3. Reconnect click POSTs `/api/mcp/reconnect` and updates the badge from the returned status.

Verification: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/dashboard/server-mcp-routes.test.ts` and `npm --prefix web-portal run test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck:src` and `npm run lint:src` exit 0
- [ ] `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/dashboard/server-mcp-routes.test.ts` → all pass (≥ 7 tests)
- [ ] `npm --prefix web-portal run typecheck`, `lint`, `test`, `build` all exit 0
- [ ] `grep -n "handleMcpRoutes" src/dashboard/server.ts` → 2 matches (import + dispatch)
- [ ] `grep -c "sourcePath" src/dashboard/server-mcp-routes.ts` ≥ 1 AND test 2 above proves it is stripped from responses
- [ ] i18n key-parity command prints `OK` (all 8 locales have `hub.tabs.mcp` and `mcp.title`)
- [ ] `grep -n "case 'mcp'" web-portal/src/pages/SettingsPage.tsx` → 1 match
- [ ] `git status` shows changes only in the in-scope file list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1 finds an existing `/api/mcp` route or an existing `tryStradaMcpReconnect` — the feature has been started elsewhere.
- `ToolRegistry` no longer holds `stradaMcpRuntime` / `getStradaMcpRuntimeStatus` as excerpted (lines 122/362) — the runtime wiring has been refactored.
- Making `DashboardToolRegistry` members optional still breaks `npm run typecheck:src` in files outside the in-scope list — the interface is consumed somewhere recon didn't anticipate; report rather than chase edits across the codebase.
- The settings.json files turn out to be nested objects rather than flat dotted keys in any locale (format drift).
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **Deferred (recorded, not in scope)**: pushing live bridge-state transitions over the dashboard WebSocket so the portal badge updates without manual Refresh; and surfacing the same status in the chat channel when a `unity_*` tool call fails because the bridge is down.
- `tryLazyReconnect()` is intentionally a no-op (returns current state) unless the bridge is dormant — the Reconnect button therefore cannot break an established connection; reviewers should confirm the UI copy doesn't promise more than that.
- Reviewer should scrutinize: the sanitization destructure in BOTH the status and reconnect handlers (it's easy to strip `sourcePath` in one and leak it in the other), and that the new dispatch line sits before the 404 fallthrough in `server.ts`.
- If `StradaMcpRuntimeStatus` gains new fields later, they flow to the API automatically — any new path-like field must be added to the destructure-strip list in `server-mcp-routes.ts`.

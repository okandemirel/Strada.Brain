# Plan 007: Add route-level tests for the untested dashboard route modules (vault, provider, settings)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat aea95ad..HEAD -- src/dashboard/server-vault-routes.ts src/dashboard/server-provider-routes.ts src/dashboard/server-settings-routes.ts src/dashboard/server-types.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (plan 008 extends the vault-routes test file created here; execute 007 before 008 when possible)
- **Category**: tests
- **Planned at**: commit `aea95ad`, 2026-06-11

## Why this matters

`src/dashboard/` has route/bridge modules with zero tests (verified by listing): `server-vault-routes.ts`, `server-provider-routes.ts`, `server-settings-routes.ts`, `server-system-routes.ts`, `server-daemon-routes.ts`, `server-personality-routes.ts`, `server-skills-routes.ts`, `monitor-routes.ts`, `workspace-routes.ts`, plus the bridges (`monitor-bridge.ts`, `learning-workspace-bridge.ts`, `task-workspace-bridge.ts`, `workspace-runtime-bridge.ts`) and `workspace-bus.ts`/`workspace-events.ts`. Tested files: `canvas-routes`, `canvas-storage`, `metrics`, `monitor-lifecycle`, `prometheus`, `websocket-server` (x2), `server`. These routes are the HTTP surface of the web portal; the vault routes in particular enforce path-safety (`isUnsafePath`) and information-leak prevention (`sanitizeSyncResponse`, rootPath omission) that currently have no regression net. This plan covers the 3 highest-value files: vault + provider + settings routes.

## Current state

All paths under `/Users/okanunico/Documents/Strada/Strada.Brain`.

### Route architecture (verified)

Dashboard routes are plain functions, no framework. Two patterns exist in `src/dashboard/server-vault-routes.ts`:

1. **Production path** — `handleVaultRoutes(url, method, req, res, ctx)` (line 310): raw Node `IncomingMessage`/`ServerResponse` + `RouteContext`, returns `true` when the route matched, writes JSON via `sendJson`/`sendJsonError` from `src/dashboard/server-types.ts:482-492`. `handleProviderRoutes` (`server-provider-routes.ts:34`) and `handleSettingsRoutes` (`server-settings-routes.ts:21`) follow the same shape.
2. **Express-like adapter** — `registerVaultRoutes(app: RouteApp, registry, factory?, llmProvider?)` (line 175), where `RouteApp` (lines 80–83) is just `{ get(path, handler); post(path, handler) }` and handlers RETURN their response payload as a plain object. **Verified: `registerVaultRoutes` has no production callers anywhere in `src/` or `web-portal/src/`** — its doc comment (lines 68–74) calls it a "dev-server/test adapter". It is therefore directly unit-testable with a fake app object that records handlers, but tests against it alone would NOT cover production. This plan tests BOTH: `handleVaultRoutes` for the production contract, `registerVaultRoutes` where its logic differs (it shares the same helpers).

### Test pattern to copy

`src/dashboard/canvas-routes.test.ts` lines 20–61 define the exact mock helpers to reuse (copy them into each new test file):
- `createMockRes()` — object with `statusCode`, `headers`, `body`, `writeHead: vi.fn(...)`, `end: vi.fn(...)`, cast `as unknown as MockRes & ServerResponse`.
- `createMockReq(body?)` — `EventEmitter` cast to `IncomingMessage`; emits `data`+`end` on `process.nextTick` when a body is given.
- `responseJson()` helper parsing `res.body`.
- It also `vi.mock`s `../utils/logger.js`. Note: vault routes import `getLoggerSafe` (not `getLogger`) — mock the module with BOTH exports: `{ getLogger: () => stub, getLoggerSafe: () => stub }`, or skip the mock entirely if `getLoggerSafe` already no-ops without a configured logger (check `src/utils/logger.ts`; prefer mocking for silence).

Because the raw handlers respond asynchronously via `void promise.then(...)`, after calling a handler that does async work, await settlement before asserting: `await vi.waitFor(() => expect(res.end).toHaveBeenCalled())`.

### RouteContext

`RouteContext` (`src/dashboard/server-types.ts:389-479`) has many optional fields but these REQUIRED ones: `metrics`, `getMemoryStats`, `historyDepth`, `triggerFireRetentionDays`, `startupNotices`, `monitorActivityLog`, `lastModelRefreshMs`, `setLastModelRefreshMs`, `lastUpdateCheckMs`, `setLastUpdateCheckMs`, `readJsonBody`, `getAutonomousDefaults`. Check `src/dashboard/server.test.ts` first for an existing ctx-builder helper to copy; if none fits, build a `makeCtx(overrides)` helper returning a partial cast `as unknown as RouteContext` with at minimum:

```ts
function makeCtx(overrides: Partial<RouteContext> = {}): RouteContext {
  return {
    lastModelRefreshMs: 0,
    setLastModelRefreshMs: vi.fn(),
    readJsonBody: vi.fn(async <T>(_req: unknown, _res: unknown) => null as T | null),
    ...overrides,
  } as unknown as RouteContext;
}
```

For POST routes, set `readJsonBody` to `vi.fn(async () => parsedBodyObject)` per test (the routes treat `null` as "error already sent" and return without responding — that is itself a testable behavior). The vault module has its OWN internal `readJsonBody` reading from the req stream (`server-vault-routes.ts:559-583`, 4096-byte cap) — for vault POSTs pass a real body through `createMockReq(JSON.stringify(...))`.

### Key behaviors to pin (verified excerpts)

- `isUnsafePath` (`server-vault-routes.ts:91-100`): rejects non-string/empty, length > 1024, leading `/` or `\`, any `..`, NUL, and URL-encoded `%2e%2e` / `%2f` / `%5c`.
- `GET /api/vaults` (lines 328–337): returns `{ items: [{ id, kind }] }` — comment: "Intentionally do NOT expose v.rootPath".
- `POST /api/vaults` (lines 342–395): 503 without `ctx.vaultFactory`; 400 on `validateVaultRegisterBody` failure (name regex `/^[A-Za-z0-9 _\-.]{1,64}$/`, rootPath must be absolute, ≤1024 chars, no NUL; kind `unity|generic`); 400 when dir doesn't exist; 409 when `registry.get(id)` already exists; 201 with `{ id, name, kind, status: 'indexing', symbolCount: 0 }` on success; init is fire-and-forget (plan 008 fixes the failure surfacing — do not address it here).
- `sanitizeSyncResponse` (lines 602–616, not exported): POST sync responses contain at most `{ changed, durationMs, canvas: { ok } | { ok: false, error: 'canvas regeneration failed' } }` — the raw canvas error string never leaks.
- `buildVaultRetrievalStatsSnapshot` (exported, lines 157–173): pure function, injectable stats + clock.
- `wireVaultUpdatesToWs` (exported, lines 620–643): attaches `onUpdate` listeners, broadcasts `{ type: 'vault:update', payload }`, swallows broadcast throw, attaches to later-registered vaults via `registry.onRegister`.
- `handleProviderRoutes` (`server-provider-routes.ts`): 501 without `ctx.providerManager` (lines 43–45); `GET /api/providers/active` 400 without `chatId` (109–111) and 400 on identity > 128 chars (113–120); `POST /api/providers/switch` 400 on missing fields (163–166), invalid model regex `MODEL_NAME_RE` (176–179), unknown provider (181–185); `POST /api/models/refresh` 429 + `Retry-After` within 60 s (294–300); `POST /api/routing/preset` 400 for non-`budget|balanced|performance` (361–365).
- `handleSettingsRoutes` (`src/dashboard/server-settings-routes.ts`): 503 without `ctx.unifiedBudgetManager` for `/api/budget*` (30–33); `GET /api/budget` merges `{ ...snapshot, config }` (35–37); `GET /api/budget/history?days=N` clamps days to 1..30 (51); rate-limits GET returns numbers from `daemonStorage.getSettingsOverride` defaults "0" (81–84); voice GET/POST scoped by `chatId` query param defaulting `"global"` (122); 405 on e.g. DELETE to `/api/settings/voice` (160).
- A real `VaultRegistry` (`src/vault/vault-registry.ts`) is cheap to construct (`new VaultRegistry()`) — use it with fake `IVault` objects rather than mocking the registry.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck:src` | exit 0 |
| Lint | `npm run lint:src` | exit 0 |
| One test file | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/dashboard/server-vault-routes.test.ts` | all pass |
| Full suite | `node scripts/run-vitest-batches.mjs` | all pass |

## Scope

**In scope** (create only these):
- `src/dashboard/server-vault-routes.test.ts` (create)
- `src/dashboard/server-provider-routes.test.ts` (create)
- `src/dashboard/server-settings-routes.test.ts` (create)

**Out of scope** (explicitly deferred to a future plan — do NOT touch):
- `server-system-routes.ts`, `server-daemon-routes.ts`, `server-personality-routes.ts`, `server-skills-routes.ts`, `monitor-routes.ts`, `workspace-routes.ts`, and all `*-bridge.ts` / `workspace-bus.ts` / `workspace-events.ts` files.
- Any SOURCE file modification. Tests only. (Plan 008 modifies `server-vault-routes.ts`; not this plan.)
- Spinning up a real HTTP server — handlers are called directly with mocks.

## Git workflow

- Branch: `advisor/007-dashboard-route-tests`
- Conventional commits, e.g. `test(dashboard): add vault route handler tests`.
- Do NOT push or open a PR.

## Steps

### Step 1: `src/dashboard/server-vault-routes.test.ts`

Copy the mock req/res helpers from `canvas-routes.test.ts`. Define a fake vault:

```ts
function fakeVault(overrides: Partial<IVault> = {}): IVault {
  return {
    id: 'unity:abc12345', kind: 'unity-project', rootPath: '/tmp/fake-root',
    init: vi.fn(async () => {}), sync: vi.fn(async () => ({ changed: 0, durationMs: 1 })),
    rebuild: vi.fn(async () => {}), query: vi.fn(async () => ({ hits: [], budgetUsed: 0, truncated: false })),
    stats: vi.fn(async () => ({ fileCount: 1, chunkCount: 2, lastIndexedAt: 123, dbBytes: 10 })),
    dispose: vi.fn(async () => {}), listFiles: vi.fn(() => []),
    readFile: vi.fn(async () => 'body'), onUpdate: vi.fn(() => () => {}),
    ...overrides,
  } as unknown as IVault;
}
```

Test groups (target `handleVaultRoutes` unless noted):

1. **Fall-through & guards**: returns `false` for `/api/metrics`; 503 `'vault subsystem not enabled'` when `ctx.vaultRegistry` is undefined.
2. **GET /api/vaults — no path leak**: register a fake vault with `rootPath: '/Users/secret/project'`; response is `{ items: [{ id, kind }] }` and `res.body` does NOT contain `'/Users/secret'`.
3. **POST /api/vaults validation** (use `createMockReq(JSON.stringify(body))` since the module reads the stream itself): 503 without `ctx.vaultFactory`; 400 for bad name (`'a/b'`, empty, 65 chars), relative rootPath, rootPath with `\x00`, kind `'weird'`; 400 for a nonexistent absolute dir (use `join(tmpdir(), 'does-not-exist-xyz')`); 201 happy path with a real `mkdtempSync` dir and a factory `{ create: vi.fn(async ({ id, rootPath, kind }) => fakeVault({ id })) }` — assert `status === 'indexing'`, vault registered in registry; 409 on second identical registration.
4. **DELETE /api/vaults/:id**: 404 unknown id; success returns `{ ok: true, id }`, vault removed from registry, `dispose` called.
5. **GET /api/vaults/:id/file**: each `isUnsafePath` rejection class → 400 `'invalid path'`: `path=../x`, `path=/abs`, `path=a%2e%2e` (pass the RAW url string `/api/vaults/<id>/file?path=..%2Fx` etc. — note the handler reads `u.searchParams.get('path')`, which DECODES, so test both a decoded `..` and an encoded `%2e%2e` form), missing param, > 1024 chars. `readFile` rejecting → 400. Happy path → `{ body: 'body' }`.
6. **POST /api/vaults/:id/search**: non-string `text` → 400 `'invalid text'`; vault `query` throwing `new VaultQueryError('Vault query is empty after sanitization', 'empty_query')` (import from `../vault/obsidian-vault.js`) → 400 with that message; happy path returns the query result.
7. **POST /api/vaults/:id/sync — sanitization**: vault `sync` resolving `{ changed: 1, durationMs: 5, canvas: { ok: false, error: '/Users/secret/project failed' } }` → response canvas error is EXACTLY `'canvas regeneration failed'` and body does not contain `'/Users/secret'`; `{ canvas: { ok: true } }` passes through as `{ ok: true }`; extra unknown top-level fields on the sync result are dropped.
8. **GET /api/vaults/stats**: direct unit tests for exported `buildVaultRetrievalStatsSnapshot`: zero denominator → `hitRatePct === 0`; `{hits:3, misses:1}` → 75; rounding to 2 decimals; injected `now` reflected in `timestamp`.
9. **wireVaultUpdatesToWs**: fake broadcaster recording messages; triggering a registered vault's `onUpdate` listener broadcasts `{"type":"vault:update",...}`; a throwing broadcaster does not propagate; vaults registered AFTER wiring also get attached; the returned cleanup detaches.
10. **registerVaultRoutes (fake-app adapter)**: build `const routes = new Map<string, Handler>()` app whose `get/post` record handlers; call `registerVaultRoutes(app, registry, factory)`; assert GET `/api/vaults` handler returns `{ items: [...] }` without rootPath, and POST `/api/vaults` handler returns `{ error: ... }` objects for the same validation failures as group 3 (these handlers RETURN payloads instead of writing to res).

**Verify**: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/dashboard/server-vault-routes.test.ts` → all pass.

### Step 2: `src/dashboard/server-provider-routes.test.ts`

Fake `providerManager` implementing `listAvailable` (return `[{ name: 'openai', configured: true }]`), `getActiveInfo`, `setPreference: vi.fn(async () => {})`. For POST routes set `ctx.readJsonBody = vi.fn(async () => body)`.

1. Fall-through: returns `false` for unmatched URL.
2. `GET /api/providers/available`: 501 without manager; happy path `{ providers: [...] }`.
3. `GET /api/providers/active`: 400 missing `chatId`; 400 when `chatId` is 129 chars; happy path returns `{ active, executionPool }`.
4. `POST /api/providers/switch`: 400 missing `chatId`/`provider`; 400 invalid model (`'bad model!'` fails `MODEL_NAME_RE`); 400 unknown provider (`'nope'`); success → `{ success: true, provider, model, selectionMode }` and `setPreference` called with resolved identity key; `hardPin: true` → `selectionMode === 'strada-hard-pin'`; `readJsonBody` resolving `null` → no response written (`res.end` not called).
5. `POST /api/models/refresh`: with `ctx.lastModelRefreshMs = Date.now()` → 429 and `Retry-After` header set; with `lastModelRefreshMs: 0` and no `refreshCatalog` on the manager → 501.
6. `POST /api/routing/preset`: 501 without `ctx.providerRouter`; 400 for `'turbo'`; success for `'budget'` calls `setPreset('budget')`.

Skip `/api/providers/intelligence` and `/api/providers/capabilities` (they dynamically import `provider-knowledge.js` — heavier; defer).

**Verify**: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/dashboard/server-provider-routes.test.ts` → all pass.

### Step 3: `src/dashboard/server-settings-routes.test.ts`

Fake `unifiedBudgetManager` (`getSnapshot`, `getConfig`, `getDailyHistory: vi.fn((d) => [])`, `updateConfig`) and fake `daemonStorage` (`getSettingsOverride: vi.fn()`, `setSettingsOverride: vi.fn()`).

1. Fall-through `false` for unmatched URL.
2. `GET /api/budget`: 503 without manager; happy path body is `{ ...snapshot, config }`; manager `getSnapshot` throwing → 500.
3. `GET /api/budget/history`: `?days=99` → `getDailyHistory(30)`; `?days=0` → `getDailyHistory(1)`; no param → 7.
4. `POST /api/budget/config`: `updateConfig` throwing → 400; success → `{ success: true, config }`.
5. `GET /api/settings/rate-limits`: 503 without storage; defaults → `{ messagesPerMinute: 0, messagesPerHour: 0, tokensPerDay: 0 }` (numbers, not strings).
6. `POST /api/settings/rate-limits`: body `{ messagesPerMinute: 5 }` → `setSettingsOverride('rate_limit_messages_per_minute', '5')` and only that key.
7. `GET/POST /api/settings/voice`: GET with no overrides → all-null fields + `chatId: 'global'`; `?chatId=abc` scopes calls with `'abc'`; POST `{ enabled: true, speed: 1.5 }` → `setSettingsOverride('voice_enabled', 'true', 'global')` and `('voice_speed', '1.5', 'global')`; method `DELETE` → 405.

**Verify**: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/dashboard/server-settings-routes.test.ts` → all pass.

### Step 4: Full gate

**Verify**: `npm run typecheck:src` → exit 0; `npm run lint:src` → exit 0; `node scripts/run-vitest-batches.mjs` → all pass.

## Test plan

Covered in steps 1–3. Structural pattern: `src/dashboard/canvas-routes.test.ts` (mock req/res + handler-returns-true routing). Check `src/dashboard/server.test.ts` before writing for a reusable RouteContext builder. Roughly 45–60 new test cases total across 3 files.

## Done criteria

- [ ] `npm run typecheck:src` exits 0
- [ ] `npm run lint:src` exits 0
- [ ] 3 new test files exist; `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/dashboard/` passes all (old + new)
- [ ] The vault test asserts at least one explicit "response body does not contain rootPath" case
- [ ] `node scripts/run-vitest-batches.mjs` exits 0
- [ ] `git status` shows ONLY the 3 new test files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- "Current state" excerpts don't match the live code (drift). In particular, if plan 008 has already landed, `server-vault-routes.ts` and `vault-registry.ts` will have init-state code and `server-vault-routes.test.ts` may already exist — in that case EXTEND the existing file instead of creating it, and skip any duplicate cases.
- A test reveals a route leaking an absolute path or accepting an `isUnsafePath` input — security bug; report, do not "fix" the route in this plan.
- Mock `RouteContext` casting triggers typecheck errors you cannot resolve with `as unknown as RouteContext`.
- A handler never calls `res.end` within `vi.waitFor`'s default timeout for a case the code clearly should answer.

## Maintenance notes

- `registerVaultRoutes` is currently caller-less in production (dev/test adapter). If it is ever deleted, drop the group-10 tests with it.
- Plan 008 will modify `POST /api/vaults` + `GET /api/vaults/:id/stats` to surface init failure; the tests written here should keep passing (008's changes are additive). Reviewer should re-run this file after 008 lands.
- Deferred follow-up plan: system/daemon/personality/skills/monitor/workspace routes and the four bridge modules.

# Plan 008: Surface async vault init failures through the stats endpoint instead of polling-forever "indexing"

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat aea95ad..HEAD -- src/dashboard/server-vault-routes.ts src/vault/vault-registry.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (can land independently of 007; see Test plan for how the two interact)
- **Category**: bug
- **Planned at**: commit `aea95ad`, 2026-06-11

## Why this matters

`POST /api/vaults` registers a vault, returns `{ status: 'indexing' }`, and kicks off `vault.init()` fire-and-forget. If init fails (embedding provider down, fs/db error), the only trace is a `warn` log; the registered vault stays in the registry, `GET /api/vaults/:id/stats` keeps returning plain counts with no status, and the web-portal client polls forever believing indexing is in progress. The fix records init state per vault and surfaces `{ status: 'error', error: <redacted message> }` through the stats endpoint, while keeping registration non-blocking.

## Current state

All paths under `/Users/okanunico/Documents/Strada/Strada.Brain`.

- `src/dashboard/server-vault-routes.ts` — two parallel implementations:
  - `registerVaultRoutes(app, registry, factory?, llmProvider?)` (line 175) — express-like adapter (no production callers; kept in sync). Its `POST /api/vaults` handler at lines 181–201 ends with:

```ts
// src/dashboard/server-vault-routes.ts:194-201
    const vault = await factory.create({ id, rootPath: dirCheck.realPath, kind: parsed.kind });
    registry.register(vault);
    void vault.init().catch((err) => getLoggerSafe().warn('[vault] async init failed', { err }));
    return {
      id: vault.id, name: parsed.name,
      kind: vault.kind, status: 'indexing', symbolCount: 0,
    };
```

  - Its stats handler at lines 206–209:

```ts
// src/dashboard/server-vault-routes.ts:206-209
  app.get('/api/vaults/:id/stats', async (req) => {
    const v = registry.get(req.params.id);
    return v ? await v.stats() : { error: 'not found' };
  });
```

  - `handleVaultRoutes(...)` (line 310) — the PRODUCTION raw-http path. Its `POST /api/vaults` fire-and-forget block is lines 376–388 (init + best-effort `startWatch`, catch → `getLoggerSafe().warn(\`[vault] async init failed for ${id}\`, { err })` at line 386). Its stats handler is lines 510–513:

```ts
// src/dashboard/server-vault-routes.ts:510-513
  if (op === 'stats' && method === 'GET') {
    void vault.stats().then((s) => sendJson(res, s)).catch(() => sendJsonError(res, 500, 'stats failed'));
    return true;
  }
```

- `src/vault/vault.interface.ts:44-49` — `VaultStats { fileCount; chunkCount; lastIndexedAt; dbBytes }`. `stats()` implementations (`obsidian-vault.ts:335-344`, `unity-project-vault.ts:167-176`) just read SQLite counts — they work even when `init()` failed (the store is created in the constructor), so a failed-init vault reports `fileCount: 0` forever: indistinguishable from "still indexing".
- `src/vault/vault-registry.ts` (129 lines) — `VaultRegistry` with `vaults: Map`, `register` (line 34), `unregister` (line 65), `disposeAll` (line 123). No init-state tracking today. This is the natural shared owner of init state because BOTH route paths already hold the registry.
- `redactPathsInMessage(msg, rootPath, realpathRoot?)` is exported from `src/vault/obsidian-vault.ts:146` and already imported-adjacent in `server-vault-routes.ts` (which imports `VaultQueryError` from the same module, line 12). Use it to scrub the error message before storing.
- Response-shape constraint: the stats endpoints currently return raw `VaultStats`. Adding optional `status`/`error` fields is additive; the web-portal client treats unknown fields as extra JSON. Never include `rootPath`, db paths, or homedir in `error`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck:src` | exit 0 |
| Lint | `npm run lint:src` | exit 0 |
| Vault-route tests | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/dashboard/server-vault-routes.test.ts` | all pass |
| Registry tests | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/vault/vault-registry.test.ts` | all pass (file may not exist yet — see Test plan) |
| Full suite | `node scripts/run-vitest-batches.mjs` | all pass |

## Scope

**In scope** (the only files you may modify/create):
- `src/vault/vault-registry.ts` — add init-state map + accessors
- `src/dashboard/server-vault-routes.ts` — record state in both POST paths; merge state into both stats paths
- `src/dashboard/server-vault-routes.test.ts` — create OR extend (see Test plan)

**Out of scope** (do NOT touch):
- `src/vault/vault.interface.ts` — do NOT change `VaultStats` or `IVault`; the status merge happens at the route layer.
- `src/vault/obsidian-vault.ts`, `src/vault/unity-project-vault.ts`, `src/vault/self-vault.ts` — vault implementations unchanged.
- The web-portal client (`web-portal/`) — displaying the error state is a follow-up; the API contract change here is additive.
- Making registration block on init — the async-init design stays.

## Git workflow

- Branch: `advisor/008-surface-vault-init-failures`
- Conventional commits, e.g. `fix(dashboard): surface vault init failures via stats endpoint`.
- Do NOT push or open a PR.

## Steps

### Step 1: Add init-state tracking to `VaultRegistry`

In `src/vault/vault-registry.ts`, add near the top of the file:

```ts
/** Lifecycle state of a vault's async init(), tracked by the registry. */
export interface VaultInitState {
  status: 'indexing' | 'ready' | 'error';
  /** Present only for status 'error'. Pre-redacted, safe for HTTP responses. */
  error?: string;
}
```

Inside the `VaultRegistry` class add a private map and accessors:

```ts
  private initStates = new Map<VaultId, VaultInitState>();

  setInitState(id: VaultId, state: VaultInitState): void {
    this.initStates.set(id, state);
  }
  getInitState(id: VaultId): VaultInitState | undefined {
    return this.initStates.get(id);
  }
```

Clear the entry in `unregister(id)` (add `this.initStates.delete(id);`) and in `disposeAll()` (add `this.initStates.clear();`).

**Verify**: `npm run typecheck:src` → exit 0.

### Step 2: Record init state in both POST /api/vaults paths

In `src/dashboard/server-vault-routes.ts`:

2a. Import `redactPathsInMessage` alongside the existing `VaultQueryError` import (line 12):
`import { VaultQueryError, redactPathsInMessage } from '../vault/obsidian-vault.js';`

2b. Add a module-level helper (near `makeVaultId`):

```ts
const MAX_INIT_ERROR_CHARS = 200;

/** Track a fire-and-forget vault init on the registry so stats can report it. */
function trackVaultInit(registry: VaultRegistry, vault: IVault, init: Promise<unknown>): void {
  registry.setInitState(vault.id, { status: 'indexing' });
  init.then(
    () => registry.setInitState(vault.id, { status: 'ready' }),
    (err: unknown) => {
      const raw = err instanceof Error ? err.message : String(err);
      const safe = redactPathsInMessage(raw, vault.rootPath).slice(0, MAX_INIT_ERROR_CHARS);
      registry.setInitState(vault.id, { status: 'error', error: safe });
    },
  );
}
```

2c. In `registerVaultRoutes` POST handler, replace line 196:

```ts
    void vault.init().catch((err) => getLoggerSafe().warn('[vault] async init failed', { err }));
```

with:

```ts
    const initPromise = vault.init();
    trackVaultInit(registry, vault, initPromise);
    void initPromise.catch((err) => getLoggerSafe().warn('[vault] async init failed', { err }));
```

2d. In `handleVaultRoutes` POST block (lines 376–388), restructure the fire-and-forget IIFE so init success is recorded BEFORE the best-effort `startWatch` (a watcher failure must not mark the vault as error — indexing succeeded):

```ts
        const initPromise = vault.init();
        trackVaultInit(registry, vault, initPromise);
        void (async () => {
          try {
            await initPromise;
            const maybeWatcher = (vault as unknown as { startWatch?: (ms: number) => Promise<void> });
            if (typeof maybeWatcher.startWatch === 'function') {
              await maybeWatcher.startWatch(factory.watchDebounceMs ?? 800);
            }
          } catch (err) {
            getLoggerSafe().warn(`[vault] async init failed for ${id}`, { err });
          }
        })();
```

(Keep the surrounding `registry.register(vault); sendJson(res, {...status:'indexing'...}, 201);` lines as they are. Note `trackVaultInit` attaches its own rejection handler, so `initPromise` cannot become an unhandled rejection even though the IIFE also awaits it.)

**Verify**: `npm run typecheck:src` → exit 0; `npm run lint:src` → exit 0.

### Step 3: Merge init state into both stats handlers

3a. Add a small helper next to `trackVaultInit`:

```ts
function mergeInitState(
  registry: VaultRegistry,
  id: string,
  stats: import('../vault/vault.interface.js').VaultStats,
): Record<string, unknown> {
  const init = registry.getInitState(id);
  if (!init) return stats as unknown as Record<string, unknown>;
  return {
    ...stats,
    status: init.status,
    ...(init.status === 'error' && init.error ? { error: init.error } : {}),
  };
}
```

3b. `registerVaultRoutes` stats handler (lines 206–209) becomes:

```ts
  app.get('/api/vaults/:id/stats', async (req) => {
    const v = registry.get(req.params.id);
    return v ? mergeInitState(registry, v.id, await v.stats()) : { error: 'not found' };
  });
```

3c. `handleVaultRoutes` stats branch (lines 510–513) becomes:

```ts
  if (op === 'stats' && method === 'GET') {
    void vault.stats()
      .then((s) => sendJson(res, mergeInitState(registry, vault.id, s)))
      .catch(() => sendJsonError(res, 500, 'stats failed'));
    return true;
  }
```

Back-compat note: vaults registered at bootstrap (not via POST) have no recorded state → stats responses are byte-identical to today (no `status` field). Only POST-registered vaults gain the field.

**Verify**: `npm run typecheck:src` → exit 0.

### Step 4: Tests

See Test plan below for the two cases (file exists vs not). Write the tests, then:

**Verify**: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/dashboard/server-vault-routes.test.ts` → all pass.

### Step 5: Full gate

**Verify**: `npm run lint:src` → exit 0; `node scripts/run-vitest-batches.mjs` → all pass.

## Test plan

**Where**: `src/dashboard/server-vault-routes.test.ts`.
- If plan 007 already landed, this file EXISTS — extend it with a new `describe('vault init failure surfacing')` block, reusing its `createMockRes`/`createMockReq`/`fakeVault`/`makeCtx` helpers.
- If 007 has not landed, CREATE the file with just this describe block, copying the mock req/res helpers from `src/dashboard/canvas-routes.test.ts:20-61` and a minimal fake vault (id, kind, rootPath, `init`, `stats`, `dispose`, `onUpdate`, `listFiles`, `readFile`, `sync`, `query`, `rebuild` as `vi.fn`s). Mock `../utils/logger.js` exporting both `getLogger` and `getLoggerSafe`.

Cases (drive `handleVaultRoutes` end-to-end with a real `new VaultRegistry()`, a `mkdtempSync` temp dir as rootPath, and a factory returning a fake vault whose `init` you control with a deferred promise):

1. **indexing**: POST registers the vault (201, `status: 'indexing'`); while `init` is unresolved, GET `/api/vaults/<id>/stats` → body includes `status: 'indexing'` plus the numeric stats fields.
2. **error + redaction**: reject `init` with `new Error(\`embedding provider down at ${rootPath}/db\`)`; `await vi.waitFor(...)` then GET stats → `status: 'error'`, `error` is a string that does NOT contain the temp rootPath (it was redacted to `<vault>`), length ≤ 200.
3. **ready**: resolve `init`; GET stats → `status: 'ready'`, no `error` field.
4. **back-compat**: a vault registered directly via `registry.register(fakeVault())` (no POST) → GET stats body has NO `status` key.
5. **unregister clears state**: after case 2, DELETE `/api/vaults/<id>`, re-register a vault with the same id directly → GET stats has no stale `error`.
6. **registerVaultRoutes parity**: with the fake-app adapter (record handlers from `registerVaultRoutes`), POST then invoke the stats handler → same indexing/error/ready progression.

Verification: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/dashboard/server-vault-routes.test.ts` → all pass, including ≥ 6 new tests.

## Done criteria

- [ ] `npm run typecheck:src` exits 0
- [ ] `npm run lint:src` exits 0
- [ ] `grep -n "status: 'indexing'" src/dashboard/server-vault-routes.ts` still matches (registration response unchanged)
- [ ] `grep -n "getInitState\|setInitState" src/vault/vault-registry.ts src/dashboard/server-vault-routes.ts` shows the registry accessors and both route paths using them
- [ ] New tests pass; `node scripts/run-vitest-batches.mjs` exits 0
- [ ] `git status` shows changes ONLY in the 3 in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" don't match the live code (lines 194–201, 206–209, 376–388, 510–513 of `server-vault-routes.ts` or `vault-registry.ts` structure).
- The web-portal turns out to hard-validate the stats response shape and a `status` field breaks it (search `web-portal/src` for `'/stats'` usage if portal tests fail — if so, report; do not modify the portal).
- You find an existing init-state mechanism already added elsewhere (someone fixed this since `aea95ad`) — extend, don't duplicate; if the approaches conflict, stop.
- Fixing the test failures appears to require changing `vault.interface.ts` or any vault implementation.

## Maintenance notes

- Future work: the web-portal vault panel should stop polling and render the error when `status === 'error'`; a "Retry" button could call POST `/api/vaults/:id/sync` or re-register.
- If a `rebuild()` route is ever added, it must reset the init state to `'indexing'` via `registry.setInitState`.
- Reviewer scrutiny points: (1) the error string stored in the registry must already be redacted (defense in depth — anything reading the state later is safe); (2) `startWatch` failure must NOT flip a ready vault to error; (3) no unhandled-rejection warnings in test output (the dual-consumer promise in Step 2d).
- Relationship to plan 007: independent landing order; whichever lands second extends the existing `server-vault-routes.test.ts` rather than recreating it.

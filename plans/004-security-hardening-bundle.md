# Plan 004: Dashboard defense-in-depth bundle (log buffer sanitization, vault search rate limit, no-token warning, %00 path check)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat aea95ad..HEAD -- src/utils/logger.ts src/security/secret-sanitizer.ts src/dashboard/server-vault-routes.ts src/dashboard/server.ts src/utils/logger.test.ts src/dashboard/server.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `aea95ad`, 2026-06-11

## Why this matters

Four small, independently-verified defense-in-depth gaps. None is a live
exploit today — the point is belt-and-suspenders on a daemon that executes
shell commands and holds provider API keys:

- **(a)** Log entries are stored in the in-memory ring buffer UNsanitized.
  The `/api/logs` endpoint sanitizes at read time, but two other consumers
  (`orchestrator-clarification.ts:95` and
  `orchestrator-intervention-pipeline.ts:1280`) feed raw ring-buffer entries
  into LLM prompt context — a secret logged by any subsystem can leak into a
  provider request. Sanitizing at write time closes every consumer at once.
- **(b)** `POST /api/vaults/:id/search` runs embedding-backed queries with no
  rate limit. Auth gates DO exist at the server layer (bearer when a
  dashboard token is set; same-origin checks on mutating APIs otherwise), so
  this is throttling a semi-trusted caller, not an open endpoint — but a
  runaway client or CSRF-driven flood can saturate the embedding provider.
- **(c)** When no dashboard token is configured, mutable dashboard APIs rely
  solely on same-origin checks. That is a deliberate design, but it is
  silent — operators get no signal that they are running in the weaker mode.
- **(d)** `isUnsafePath` blocks raw `\x00`, `..`, and encoded
  `%2e%2e`/`%2f`/`%5c`, but not encoded `%00`. **This is NOT currently
  exploitable** — the vault layer (`src/vault/path-policy.ts`,
  `resolveSafeVaultReadPath`, ~line 214) has layered realpath/symlink
  defense, and Node `fs` rejects NUL bytes in paths. Adding `%00` to the
  encoded-pattern check just makes the HTTP-layer filter internally
  consistent. Nobody should panic over this one.

## Current state

- `src/utils/logger.ts:27-53` — `RingBufferTransport.log()` pushes
  `{ timestamp, level, message, meta }` into `LOG_RING_BUFFER` (max 500
  entries, message capped at 4096 chars, meta at 2048 serialized bytes) with
  **no sanitization**:

  ```ts
  LOG_RING_BUFFER.push({
    timestamp: String(timestamp ?? new Date().toISOString()),
    level,
    message: String(message).slice(0, MAX_MESSAGE_LENGTH),
    meta: truncatedMeta,
  });
  ```

  The transport is registered in `createLogger` at `logger.ts:101`
  (`new RingBufferTransport(),`).
- Ring buffer consumers (verified):
  - `src/dashboard/server-system-routes.ts:332-344` — `GET /api/logs`
    **already** maps entries through `sanitizeSecrets` at read time. State
    this honestly: (a) adds storage-time sanitization, the read-time layer
    stays as the outer belt.
  - `src/agents/orchestrator-clarification.ts:95` and
    `src/agents/orchestrator-intervention-pipeline.ts:1280` — consume raw
    entries (these are why write-time sanitization matters).
- The repo's canonical sanitizer: `src/security/secret-sanitizer.ts` —
  `export function sanitizeSecrets(content: string, options?: SanitizeOptions): string`
  (line 300). **Critical constraint**: `secret-sanitizer.ts:9` is
  `import { getLogger } from "../utils/logger.js";` — so `logger.ts` must
  NOT import from `secret-sanitizer.ts` (would create a circular dependency;
  the repo enforces zero circular deps). Use the injection pattern below.
- `src/dashboard/server-vault-routes.ts`:
  - Lines 91-100 — `isUnsafePath`, verbatim:

    ```ts
    function isUnsafePath(p: unknown): boolean {
      if (typeof p !== 'string' || p.length === 0) return true;
      if (p.length > 1024) return true;
      // Block absolute, parent refs, null bytes, backslashes, URL-encoded dots.
      if (p.startsWith('/') || p.startsWith('\\')) return true;
      if (p.includes('..')) return true;
      if (p.includes('\x00')) return true;
      if (/%2e%2e/i.test(p) || /%2f/i.test(p) || /%5c/i.test(p)) return true;   // line 98
      return false;
    }
    ```

  - Line 175 — `registerVaultRoutes(app, ...)`: express-shaped adapter used
    by dev-server/tests only (the file's own comment at lines 69-73 says so).
    Its search handler is at lines 229-243.
  - Line 310 — `handleVaultRoutes(url, method, req, res, ctx)`: the
    **production** raw-Node-http path, called from
    `src/dashboard/server.ts:669`. Its search dispatch (lines 503-545):

    ```ts
    const m = pathOnly.match(/^\/api\/vaults\/([^/]+)\/(stats|tree|file|search|sync)$/);
    ...
    if (op === 'search' && method === 'POST') {
      void readJsonBody(req).then(async (body) => { ... });
      return true;
    }
    ```

  - Helpers `sendJson`/`sendJsonError` come from
    `src/dashboard/server-types.ts:482-488`:
    `sendJsonError(res: ServerResponse, statusCode: number, error: string)`.
- The repo's existing rate-limiter pattern to reuse:
  `src/daemon/triggers/webhook-trigger.ts:184` —
  `export class WebhookRateLimiter` with
  `constructor(maxRequests: number, windowMs: number)` and
  `isAllowed(now: number, source: string = "global"): boolean` (per-source
  sliding window). Already re-exported by `src/dashboard/server-types.ts:55`.
  (Do NOT use `src/security/rate-limiter.ts` — that one is the per-user
  message/budget limiter, wrong shape for this.)
- `src/dashboard/server.ts`:
  - Line 128: `private dashboardToken?: string;` — populated from
    `ctx.dashboardToken` (line 343-344), which bootstrap fills from
    `config.websocketDashboard.authToken`
    (`src/core/bootstrap.ts:1249`, `1454`), which comes from env var
    **`WEBSOCKET_DASHBOARD_AUTH_TOKEN`** (`src/config/config.ts:3054`).
  - Lines 597-614 — the auth gates, verbatim:

    ```ts
    const isDashboardApi = url.startsWith("/api/");
    const isMutableDashboardApi = isDashboardApi && method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && !url.startsWith("/api/webhook");
    // Token-enabled dashboard APIs always require bearer auth.
    if (isDashboardApi && this.dashboardToken) {
      if (!this.requireDashboardAuth(req, res)) return;
    }
    // Without a dashboard token, mutating dashboard APIs still require a trusted
    // same-origin browser request so local CSRF cannot drive daemon actions.
    if (isMutableDashboardApi && !this.dashboardToken) {
      if (!this.requireTrustedDashboardMutation(req, res)) return;
    }
    ```

  - Lines 710-717 — the listen callback in `start()`:

    ```ts
    this.server!.listen(this.port, "127.0.0.1", () => {
      this.server!.removeListener("error", reject);
      logger.info(`Dashboard running at http://localhost:${this.port}`);
      resolve();
    });
    ```

- Tests:
  - `src/utils/logger.test.ts` exists — uses `vi.resetModules` + dynamic
    `await import(...)` per test (see its first 50 lines for the pattern).
  - `src/dashboard/server.test.ts` exists — mocks `../utils/logger.js` at
    lines 10-17 (`getLogger`/`getLoggerSafe` returning stub objects).
  - There is NO `src/dashboard/server-vault-routes.test.ts` — step 2/4 create it.
  - Sanitizer redaction examples for assertions:
    `src/security/secret-sanitizer.test.ts:105` shows
    `"Authorization: Bearer abc..."` → `"Authorization: Bearer [REDACTED]"`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `npm run typecheck:src` | exit 0 |
| Lint | `npm run lint:src` | exit 0 |
| Logger tests | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/utils/logger.test.ts` | all pass |
| Server tests | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/dashboard/server.test.ts` | all pass |
| Vault-route tests | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/dashboard/server-vault-routes.test.ts` | all pass |
| Sanitizer tests (regression) | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/security/secret-sanitizer.test.ts` | all pass |

## Scope

**In scope** (the only files you should modify/create):
- `src/utils/logger.ts`
- `src/core/bootstrap.ts` (one registration call + comment — see Step 1 rev.2)
- `src/dashboard/server-vault-routes.ts`
- `src/dashboard/server.ts`
- `src/utils/logger.test.ts`
- `src/dashboard/server.test.ts`
- `src/dashboard/server-vault-routes.test.ts` (create)
- Up to 5 existing `*.test.ts` files ONLY to add a missing
  `setLogRingBufferSanitizer: vi.fn()` line to a `vi.mock("../utils/logger.js")`
  factory, if the empirical check in Step 1.4 reveals any (rev.2 expects zero).

**Out of scope** (do NOT touch, even though they look related):
- `src/dashboard/server-system-routes.ts` — its read-time sanitization of
  `/api/logs` stays exactly as-is (outer belt).
- `src/vault/path-policy.ts` — the vault-layer defense is already correct.
- `src/security/rate-limiter.ts` — wrong limiter for this job.
- `requireDashboardAuth` / `requireTrustedDashboardMutation` logic — the auth
  model itself is not being changed, only a warning added.
- The express-like `registerVaultRoutes` search handler (line 229) — dev/test
  adapter, not production; rate-limiting it adds test friction for no
  production gain. Note this in your commit message.

## Git workflow

- Branch: `advisor/004-security-hardening-bundle`
- One commit per step, conventional style, e.g.:
  - `fix(security): sanitize secrets before storing log ring-buffer entries`
  - `feat(dashboard): rate-limit vault search endpoint per source IP`
  - `feat(dashboard): warn at startup when running without a dashboard token`
  - `fix(security): block encoded %00 in vault path check`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Sanitize ring-buffer entries at write time (a)

Because `secret-sanitizer.ts` imports `logger.ts`, the dependency must point
sanitizer → logger only. Use injection:

1. In `src/utils/logger.ts`, above `RingBufferTransport` (~line 26), add:

   ```ts
   type RingBufferSanitizer = (text: string) => string;
   let ringBufferSanitizer: RingBufferSanitizer = (text) => text;

   /**
    * Inject the secret sanitizer applied to ring-buffer entries at write time.
    * Injected (rather than imported) because security/secret-sanitizer.ts
    * imports this module — a direct import would be a circular dependency.
    */
   export function setLogRingBufferSanitizer(fn: RingBufferSanitizer): void {
     ringBufferSanitizer = fn;
   }
   ```

2. In `RingBufferTransport.log` (lines 28-52), apply it AFTER truncation
   (keeps the regex cost bounded by the 4096/2048 caps):
   - message: `message: ringBufferSanitizer(String(message).slice(0, MAX_MESSAGE_LENGTH)),`
   - meta: after computing `truncatedMeta`, replace it with the sanitized
     round-trip when defined:

     ```ts
     if (truncatedMeta !== undefined) {
       try {
         truncatedMeta = JSON.parse(ringBufferSanitizer(JSON.stringify(truncatedMeta))) as Record<string, unknown>;
       } catch {
         truncatedMeta = { _sanitizeFailed: true };
       }
     }
     ```

3. **(rev.2 — replaces the original module-scope registration, which a first
   execution attempt proved breaks 24 test files that mock `../utils/logger.js`
   with plain object-literal factories; `secret-sanitizer.ts` sits in almost
   every module graph via `config.ts`, so a side effect there detonates the
   missing-export check in every one of those mocks.)**

   Register from `src/core/bootstrap.ts` instead — the earliest common boot
   chokepoint — and use a NAMESPACE import with an optional call so that test
   files mocking `logger.js` without the new export can never fail at load:

   ```ts
   import * as loggerModule from "../utils/logger.js";
   import { sanitizeSecrets } from "../security/secret-sanitizer.js";
   ```

   Then, at the top of the main bootstrap function (before subsystems start
   emitting meaningful logs — put it next to the earliest logger/config setup
   you find there):

   ```ts
   // Write-time defense-in-depth: sanitize ring-buffer log entries the moment
   // they are stored, not only when /api/logs serves them. Namespace access +
   // optional call so logger.js test mocks without this export never break.
   loggerModule.setLogRingBufferSanitizer?.(sanitizeSecrets);
   ```

   Check first whether bootstrap.ts already imports from `../utils/logger.js`
   and/or `../security/secret-sanitizer.js` — if it imports logger via named
   bindings, ADD a separate namespace import for this call only (do not
   rewrite existing imports), and reuse any existing sanitizeSecrets import.

4. **Empirical mock check** (this is the rev.2 acceptance gate): run the 24
   test files that failed in the first execution attempt:

   ```
   NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/integration.test.ts src/agents/orchestrator-integration.test.ts src/agents/orchestrator.test.ts src/core/response-provider-preflight.test.ts src/dashboard/server.test.ts src/memory/file-memory-manager.test.ts src/tasks/background-executor.test.ts src/agents/providers/deepseek.test.ts src/agents/providers/fireworks.test.ts src/agents/providers/gemini.test.ts src/agents/providers/groq.test.ts src/agents/providers/kimi.test.ts src/agents/providers/minimax.test.ts src/agents/providers/mistral.test.ts src/agents/providers/openai.test.ts src/agents/providers/opencode.test.ts src/agents/providers/provider-registry.test.ts src/agents/providers/qwen.test.ts src/agents/providers/together.test.ts src/agents/providers/fallback-chain.test.ts src/memory/unified/auto-tiering.test.ts src/learning/chains/chain-manager.test.ts src/learning/chains/chain-synthesizer.test.ts src/metrics/metrics-cli.test.ts
   ```

   Expected: ALL pass (the namespace+optional-call pattern adds no new named
   binding to any mocked module). If ≤5 fail with the missing-export error,
   add `setLogRingBufferSanitizer: vi.fn()` to those mock factories (in-scope
   allowance). If >5 fail, STOP and report the list.

**Verify**: `npm run typecheck:src` → exit 0; `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/utils/logger.test.ts src/security/secret-sanitizer.test.ts` → all pass (new test added in Test plan item 1); the Step 1.4 batch above → all pass.

### Step 2: Rate-limit `POST /api/vaults/:id/search` (b)

In `src/dashboard/server-vault-routes.ts`:

1. Import the limiter:
   `import { WebhookRateLimiter } from '../daemon/triggers/webhook-trigger.js';`
2. Near the existing constants (lines 85-87, `MAX_QUERY_TEXT_CHARS` etc.) add:

   ```ts
   /** Vault search is embedding-backed and comparatively expensive; cap bursts per source IP. */
   const VAULT_SEARCH_RATE_LIMIT_MAX = 30;
   const VAULT_SEARCH_RATE_LIMIT_WINDOW_MS = 10_000;
   let vaultSearchRateLimiter = new WebhookRateLimiter(VAULT_SEARCH_RATE_LIMIT_MAX, VAULT_SEARCH_RATE_LIMIT_WINDOW_MS);

   /** @internal test hook — restores a fresh limiter (optionally smaller for tests). */
   export function resetVaultSearchRateLimiterForTests(maxRequests = VAULT_SEARCH_RATE_LIMIT_MAX, windowMs = VAULT_SEARCH_RATE_LIMIT_WINDOW_MS): void {
     vaultSearchRateLimiter = new WebhookRateLimiter(maxRequests, windowMs);
   }
   ```

3. In `handleVaultRoutes`, in the `if (op === 'search' && method === 'POST')`
   branch (~line 525), check the limit BEFORE `readJsonBody` (cheapest
   possible rejection — no body parsing for throttled callers):

   ```ts
   if (op === 'search' && method === 'POST') {
     const sourceIp = req.socket?.remoteAddress ?? 'unknown';
     if (!vaultSearchRateLimiter.isAllowed(Date.now(), sourceIp)) {
       sendJsonError(res, 429, 'rate limit exceeded');
       return true;
     }
     void readJsonBody(req).then(async (body) => { ...unchanged... });
     return true;
   }
   ```

Honest note carried into the code comment: the dashboard binds to 127.0.0.1
(`server.ts:711`), so per-IP keying mostly yields one loopback key — this
limiter is effectively a global throttle for local deployments, which is the
intended protection (runaway client / CSRF flood), not multi-tenant fairness.

**Verify**: `npm run typecheck:src` → exit 0; new vault-route test passes (Test plan item 2).

### Step 3: One-time startup warning when no dashboard token is set (c)

In `src/dashboard/server.ts`, inside the `listen` callback (lines 710-716),
immediately after the `Dashboard running at ...` info line, add:

```ts
if (!this.dashboardToken) {
  logger.warn(
    "Dashboard started WITHOUT an auth token: mutable /api/* routes are protected only by same-origin checks. " +
    "Set WEBSOCKET_DASHBOARD_AUTH_TOKEN to require bearer authentication.",
  );
}
```

This fires once per `start()`. Do not gate any request handling on it; it is
purely an operator signal.

**Verify**: `npm run typecheck:src` → exit 0; `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/dashboard/server.test.ts` → all pass (new test, Test plan item 3).

### Step 4: Add `%00` to the encoded-pattern check (d)

In `src/dashboard/server-vault-routes.ts:98`, change:

```ts
if (/%2e%2e/i.test(p) || /%2f/i.test(p) || /%5c/i.test(p)) return true;
```

to:

```ts
if (/%2e%2e/i.test(p) || /%2f/i.test(p) || /%5c/i.test(p) || /%00/i.test(p)) return true;
```

Also update the comment on line 94 to mention null bytes in encoded form.
Reminder from "Why this matters": this is consistency hardening, not a fix
for a live hole — `path-policy.ts` and Node `fs` already stop NUL paths.

**Verify**: vault-route test for `%00` passes (Test plan item 4); `npm run lint:src` → exit 0.

## Test plan

1. **`src/utils/logger.test.ts`** — new test modeled on the existing
   dynamic-import tests (see `"createLogger returns a logger"`,
   logger.test.ts:15): after `vi.resetModules()`, import logger module AND
   `await import("../security/secret-sanitizer.js")` (this performs the
   registration), call `createLogger(...)` with a temp log file path
   (match how existing tests pass `logFile`), log
   `logger.info("auth header was Authorization: Bearer abc123def456")`, then
   assert `getLogRingBuffer()` last entry's `message` contains `[REDACTED]`
   and not `abc123def456`. Add a second assertion for meta:
   `logger.info("x", { header: "Authorization: Bearer abc123def456" })` →
   entry meta serialization contains `[REDACTED]`.
2. **`src/dashboard/server-vault-routes.test.ts`** (create) — unit-test
   `handleVaultRoutes` directly. Build a stub vault
   (`{ query: async () => ({ results: [] }), ... }`) inside a stub registry
   (`{ get: () => stubVault }`) on a minimal `ctx`
   (`{ vaultRegistry: stubRegistry }` cast as needed). Build `req` from
   `Readable.from([JSON.stringify({ text: "hi" })])` with
   `Object.assign(stream, { socket: { remoteAddress: "127.0.0.1" }, headers: {} })`;
   `res` as `{ writeHead: vi.fn(), end: vi.fn() }`. Cases:
   - call `resetVaultSearchRateLimiterForTests(2, 10_000)`; issue 2 search
     requests (expect non-429 handling — `writeHead` called with 200), then a
     3rd → `writeHead` called with 429 and `end` body containing
     `rate limit exceeded`. Await async settles via
     `await new Promise(setImmediate)` after each call.
   - different `remoteAddress` on the 3rd request → allowed (per-source isolation).
3. **`src/dashboard/server.test.ts`** — new test: find how the existing suite
   constructs and starts `DashboardServer` (grep `start(` in that file); start
   without `dashboardToken` and assert the mocked logger's `warn` (extend the
   mock at lines 10-17 to capture calls with `vi.fn()`) received a message
   matching `/WITHOUT an auth token/`. Add the inverse: with
   `dashboardToken: "test-token"`, `warn` NOT called with that message.
   If the existing suite never starts a real listener and constructing one
   requires heavy context, this is a STOP condition (see below).
4. **`src/dashboard/server-vault-routes.test.ts`** — `%00` case via the file
   route: `handleVaultRoutes('/api/vaults/x/file?path=%2500evil.md', 'GET', ...)`
   (note `%2500` so `searchParams.get` yields a literal `%00` in the value) →
   `writeHead` called with 400. Also one regression case: a normal relative
   path like `notes/readme.md` is NOT rejected by `isUnsafePath` (reaches the
   vault stub).

Verification: the four vitest commands in "Commands you will need" → all
pass, including ≥ 5 new tests across the three test files.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck:src` exits 0 and `npm run lint:src` exits 0
- [ ] `grep -n "setLogRingBufferSanitizer" src/core/bootstrap.ts` → 1 match (the optional registration call); `grep -n "setLogRingBufferSanitizer" src/security/secret-sanitizer.ts` → 0 matches
- [ ] `grep -n "429" src/dashboard/server-vault-routes.ts` → ≥ 1 match in the search branch
- [ ] `grep -n "WEBSOCKET_DASHBOARD_AUTH_TOKEN" src/dashboard/server.ts` → 1 match (the warning text)
- [ ] `grep -n "%00" src/dashboard/server-vault-routes.ts` → match on the isUnsafePath line
- [ ] All four vitest runs from "Commands you will need" pass, with new tests present
- [ ] No files outside the in-scope list are modified (`git status --porcelain`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The Step 1.4 empirical batch fails in MORE than 5 files with the
  missing-export mock error after the rev.2 namespace+optional-call pattern is
  applied — stop and report the failing list (rev.1 stopped here with 24
  failures under the old module-scope approach; rev.2 is designed to produce
  zero).
- `src/core/bootstrap.ts` has no clear early initialization point before
  subsystem startup (its structure drifted) — report, don't guess.
- `src/dashboard/server.test.ts` offers no viable way to invoke `start()`
  (heavy ctx construction) — report; do not refactor `server.ts` to make it
  testable, that's a bigger change than this plan authorizes.
- The search branch in `handleVaultRoutes` no longer matches the excerpt
  (drift), or `req.socket` is unavailable in the production call path.

## Maintenance notes

- (a) Write-time sanitization means `/api/logs` now double-sanitizes
  (harmless — `sanitizeSecrets` is idempotent on already-redacted text). A
  follow-up could simplify `server-system-routes.ts:332-344`, deliberately
  NOT done here to keep the outer belt while this change soaks.
- (b) The 30-req/10s constants are deliberate named constants, not config —
  if operators ever need tuning, promote them to `config.ts` (follow the
  `RATE_LIMIT_*` naming family) in a follow-up.
- (c) If the dashboard ever binds to non-loopback interfaces, the warning in
  step 3 should escalate to a hard error — note for whoever changes the bind
  address (`server.ts:711`).
- Reviewer should scrutinize: the logger-mock fallout from step 1 (vitest
  module mocks replace the whole module), and that the 429 path never reads
  the request body.

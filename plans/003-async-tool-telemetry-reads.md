# Plan 003: Remove synchronous disk reads from tool-result workspace telemetry

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat aea95ad..HEAD -- src/agents/orchestrator.ts src/agents/orchestrator.test.ts src/dashboard/workspace-bus.ts src/dashboard/monitor-bridge.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `aea95ad`, 2026-06-11

## Why this matters

Every `file_read`, `file_write`, and `file_edit` tool result triggers
`Orchestrator.emitToolResult`, which performs `readFileSync` on the event
loop purely to feed the web monitor (workspace bus → WebSocket broadcast).
For large files (content is sliced to 500 KB *after* the full read) this
blocks the daemon's event loop — stalling WebSocket traffic, channel I/O, and
the heartbeat — on every file operation in an agent run. The telemetry is
best-effort display data; it should never block the loop. The fix: prefer
content already in hand, and where a disk read is unavoidable, do it with
`fs/promises` on a serialized emit queue that preserves event ordering.

## Current state

- `src/agents/orchestrator.ts` (~6,960 lines) — the orchestrator.
  - Line 13: `import { readFileSync } from "node:fs";`
  - Line 51: `import { getLogger, getLogRingBuffer } from "../utils/logger.js";`
  - Line 700: `private workspaceBus: WorkspaceBus | null = null;`
  - Line 1940: `setWorkspaceBus(bus: WorkspaceBus): void {`
  - Lines 6786–6927: `private emitToolResult(chatId, tc, tr): void` — emits
    `tool:result` on the learning event bus, then (if `this.workspaceBus` is
    set) emits monitor/canvas/code events. `readFileSync` appears at exactly
    two places, lines 6871 and 6896.
- The sync-read section, verbatim as of `aea95ad`
  (`src/agents/orchestrator.ts:6853-6925`, abbreviated):

  ```ts
  // Code event emission for file and shell tools
  const toolInput = tc.input as Record<string, unknown>;
  const filePath = typeof toolInput.path === "string" ? toolInput.path : "";
  const absoluteFilePath = filePath
    ? (isAbsolute(filePath) ? filePath : join(this.projectPath, filePath))
    : "";
  const emitCodeFileOpen = (
    openPath: string,
    options?: { content?: string; touchedStatus?: "modified" | "new" | "deleted"; },
  ) => {
    const language = detectLanguage(openPath);
    let content = options?.content;
    if (content === undefined && absoluteFilePath) {
      try {
        content = readFileSync(absoluteFilePath, "utf-8");   // line 6871 — BLOCKS
      } catch {
        content = undefined;
      }
    }
    workspaceBus.emit("code:file_open", {
      path: openPath,
      content: (content ?? output).slice(0, 500_000),
      language,
      ...(options?.touchedStatus ? { touchedStatus: options.touchedStatus } : {}),
    });
  };

  if (tc.name === "file_read") {
    if (filePath && !tr.isError) {
      emitCodeFileOpen(filePath);
    }
  } else if (tc.name === "file_write" || tc.name === "file_edit") {
    if (filePath && !tr.isError) {
      const language = detectLanguage(filePath);
      if (tc.name === "file_edit" && typeof toolInput.old_string === "string" && typeof toolInput.new_string === "string") {
        try {
          const modified = readFileSync(absoluteFilePath, "utf-8");   // line 6896 — BLOCKS
          // Prefer pre-edit content from tool metadata (reliable) over reverse-engineering
          const original = typeof tr.metadata?.originalContent === "string"
            ? (tr.metadata.originalContent as string)
            : modified.replace(toolInput.new_string as string, () => toolInput.old_string as string);
          workspaceBus.emit("code:file_update", { path: filePath, diff: ..., original: ..., modified: ..., language });
        } catch {
          const content = typeof toolInput.new_string === "string" ? toolInput.new_string : output.slice(0, 10_000);
          emitCodeFileOpen(filePath, { content, touchedStatus: "modified" });
        }
      } else {
        // file_write → emit code:file_open (new/overwritten file)
        const content = typeof toolInput.content === "string" ? toolInput.content
          : typeof toolInput.new_string === "string" ? toolInput.new_string
          : output.slice(0, 10_000);
        emitCodeFileOpen(filePath, { content, touchedStatus: "new" });
      }
      workspaceBus.emit("workspace:mode_suggest", { mode: "code", reason: "File operation detected" });
    }
  } else if (tc.name === "shell_exec" || tc.name === "dotnet_build" || tc.name === "dotnet_test") {
    const command = typeof toolInput.command === "string" ? toolInput.command : undefined;
    workspaceBus.emit("code:terminal_output", { content: output.slice(0, 10_000), command });
    workspaceBus.emit("workspace:mode_suggest", { mode: "code", reason: "Shell execution detected" });
  }
  ```

  (`output` is `const output = tr.content;`, declared earlier in the same
  workspaceBus block, ~line 6805. `workspaceBus` is a local
  `const workspaceBus = this.workspaceBus;` alias.)

- Consumers of these events (verified):
  - `src/dashboard/monitor-bridge.ts:33-34` — `code:file_open` and
    `code:file_update` are in `FORWARDED_EVENTS`; each is independently
    JSON-serialized and broadcast over WebSocket. The bridge keeps no
    cross-event state, but the web portal renders events in arrival order, so
    **relative ordering of events should be preserved**.
- `src/dashboard/workspace-bus.ts` — `WorkspaceBus` is
  `TypedEventBus<WorkspaceEventMap>` (from `src/core/event-bus.ts`), a typed
  wrapper over Node `EventEmitter` with `emit`/`on`. `createWorkspaceBus()`
  factory exported from the same file.
- `src/agents/orchestrator.test.ts` (~8,550 lines) — no existing test covers
  the workspaceBus code events. The structural model to copy is
  `describe("Event Emission", ...)` at line 5863, specifically
  `"should emit tool:result event for each tool call result"` (~line 5887):
  it builds an Orchestrator with mock provider/channel, drives
  `handleMessage` with a `toolCalls` response, uses
  `await vi.advanceTimersByTimeAsync(100); await promise;` and asserts on
  captured events. Tests in this file use fake timers.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `npm run typecheck:src` | exit 0 |
| Lint | `npm run lint:src` | exit 0 |
| Orchestrator tests | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/agents/orchestrator.test.ts` | all pass |
| Sync-read gone | `grep -n "readFileSync" src/agents/orchestrator.ts` | no matches |

## Scope

**In scope** (the only files you should modify):
- `src/agents/orchestrator.ts` (the `emitToolResult` method, its imports, and
  one new private field + optional drain helper)
- `src/agents/orchestrator.test.ts` (new tests)

**Out of scope** (do NOT touch, even though they look related):
- `src/dashboard/monitor-bridge.ts`, `src/dashboard/workspace-bus.ts`,
  `src/dashboard/workspace-events.ts` — consumers/types are fine as-is.
- The `tool:result` learning-bus emission at the top of `emitToolResult`
  (lines 6790–6800) — it does no I/O; leave it synchronous.
- The canvas/diagram detection block (lines ~6805–6851) — no I/O; leave it.
- The `shell_exec`/`dotnet_*` branch — no I/O; leave it synchronous.
- web-portal code.

## Git workflow

- Branch: `advisor/003-async-tool-telemetry-reads`
- Conventional commits, e.g.:
  `perf(orchestrator): make workspace code-event file reads non-blocking`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the async import and the emit queue field

In `src/agents/orchestrator.ts`:

1. Next to line 13 (`import { readFileSync } from "node:fs";`) add:
   `import { readFile } from "node:fs/promises";`
   (Check first whether an `fs/promises` import already exists; if so, extend it.)
2. Near line 700 (`private workspaceBus: WorkspaceBus | null = null;`) add:

   ```ts
   /**
    * Serializes async workspace code-event emission so events reach the
    * monitor in the same order the tool results were processed, while
    * keeping file reads off the event loop.
    */
   private workspaceCodeEventQueue: Promise<void> = Promise.resolve();
   ```

3. Add a small drain helper next to `setWorkspaceBus` (line 1940) so tests
   (and future shutdown logic) can await pending emissions:

   ```ts
   /** Await any queued workspace code-event emissions (test/shutdown hook). */
   async drainWorkspaceCodeEvents(): Promise<void> {
     await this.workspaceCodeEventQueue;
   }
   ```

**Verify**: `npm run typecheck:src` → exit 0 (field/import/helper compile; nothing uses them yet).

### Step 2: Convert the file-event branches to queued async emission

Restructure ONLY the `file_read` / `file_write` / `file_edit` handling inside
`emitToolResult` (currently lines ~6859–6920). Target shape:

```ts
const enqueueCodeEvent = (work: () => Promise<void>): void => {
  this.workspaceCodeEventQueue = this.workspaceCodeEventQueue
    .then(work)
    .catch(() => { /* telemetry is best-effort; never propagate */ });
};

const emitCodeFileOpen = async (
  openPath: string,
  options?: { content?: string; touchedStatus?: "modified" | "new" | "deleted" },
): Promise<void> => {
  const language = detectLanguage(openPath);
  let content = options?.content;
  if (content === undefined && absoluteFilePath) {
    try {
      content = await readFile(absoluteFilePath, "utf-8");
    } catch {
      content = undefined;
    }
  }
  workspaceBus.emit("code:file_open", {
    path: openPath,
    content: (content ?? output).slice(0, 500_000),
    language,
    ...(options?.touchedStatus ? { touchedStatus: options.touchedStatus } : {}),
  });
};

if (tc.name === "file_read") {
  if (filePath && !tr.isError) {
    enqueueCodeEvent(() => emitCodeFileOpen(filePath));
  }
} else if (tc.name === "file_write" || tc.name === "file_edit") {
  if (filePath && !tr.isError) {
    const language = detectLanguage(filePath);
    enqueueCodeEvent(async () => {
      if (tc.name === "file_edit" && typeof toolInput.old_string === "string" && typeof toolInput.new_string === "string") {
        try {
          const modified = await readFile(absoluteFilePath, "utf-8");
          const original = typeof tr.metadata?.originalContent === "string"
            ? (tr.metadata.originalContent as string)
            : modified.replace(toolInput.new_string as string, () => toolInput.old_string as string);
          workspaceBus.emit("code:file_update", { /* identical payload to today */ });
        } catch {
          const content = typeof toolInput.new_string === "string" ? toolInput.new_string : output.slice(0, 10_000);
          await emitCodeFileOpen(filePath, { content, touchedStatus: "modified" });
        }
      } else {
        const content = typeof toolInput.content === "string" ? toolInput.content
          : typeof toolInput.new_string === "string" ? toolInput.new_string
          : output.slice(0, 10_000);
        await emitCodeFileOpen(filePath, { content, touchedStatus: "new" });
      }
      // Emitted inside the same queued task so it still arrives AFTER the file event.
      workspaceBus.emit("workspace:mode_suggest", { mode: "code", reason: "File operation detected" });
    });
  }
}
```

Hard requirements:
- Event payloads stay byte-identical to today (same fields, same slice
  limits: 500_000 for content/original/modified, 250 for the diff strings,
  10_000 for output fallbacks).
- `workspace:mode_suggest` for file ops moves INSIDE the queued task (it
  currently fires synchronously after `emitCodeFileOpen`; keeping it after
  the file event matters more than keeping it synchronous).
- The `shell_exec`/`dotnet_*` branch stays exactly as-is (synchronous).
- `workspaceBus` is already captured as a local const in the enclosing block
  — the queued closures can use it safely even if `this.workspaceBus` is
  later cleared.
- Note for the executor: `file_write` and `file_edit`-fallback paths get
  content from `toolInput` and never touch the disk — they stay on the queue
  only to preserve ordering; that is intentional, not waste.

**Verify**: `npm run typecheck:src` → exit 0; `grep -cn "readFileSync" src/agents/orchestrator.ts` → `0` usages remain (then remove the now-unused line-13 import and re-run typecheck → exit 0).

### Step 3: Run the existing orchestrator suite

```bash
NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/agents/orchestrator.test.ts
```

**Verify**: all existing tests pass. If any test fails on event ordering or
unawaited promises, fix YOUR change, not the test — existing behavior is the
contract.

### Step 4: Add workspace code-event tests

In `src/agents/orchestrator.test.ts`, add a new
`describe("Workspace code events", ...)` immediately after the
`describe("Event Emission", ...)` block (line 5863), modeled on
`"should emit tool:result event for each tool call result"` (~line 5887).
Import `createWorkspaceBus` from `"../dashboard/workspace-bus.js"` at the top
of the file.

Test skeleton (adapt construction boilerplate from the modeled test):

```ts
const bus = createWorkspaceBus();
const fileOpens: unknown[] = [];
const modeSuggests: unknown[] = [];
bus.on("code:file_open", (p) => fileOpens.push(p));
bus.on("workspace:mode_suggest", (p) => modeSuggests.push(p));
orch.setWorkspaceBus(bus);
// ...drive handleMessage with a file_write toolCall:
//   { id: "tc1", name: "file_write", input: { path: "test.cs", content: "hello" } }
await vi.advanceTimersByTimeAsync(100);
await promise;
await orch.drainWorkspaceCodeEvents();
```

Cases to cover (see Test plan). Because the suite uses fake timers and the
queue is promise-based (no timers), `await orch.drainWorkspaceCodeEvents()`
after `await promise` is the synchronization point — do not sleep.

**Verify**: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/agents/orchestrator.test.ts` → all pass including the new tests.

## Test plan

New tests in `src/agents/orchestrator.test.ts`, `describe("Workspace code events")`:

1. **file_write emits code:file_open without disk access** — drive a
   `file_write` toolCall with `input: { path: "test.cs", content: "hello" }`;
   after drain, assert one `code:file_open` with
   `{ path: "test.cs", content: "hello", touchedStatus: "new" }` and one
   `workspace:mode_suggest` with `mode: "code"`, and that the file_open
   handler fired before the mode_suggest handler (push both into one shared
   ordered array to assert sequence).
2. **file_read falls back to tool output when the file is unreadable** —
   drive a `file_read` toolCall with `input: { path: "missing.cs" }` against
   the mock read tool (project path `/tmp/test-project` doesn't contain it,
   so the queued `readFile` rejects); assert `code:file_open` fired with
   `content` equal to the tool result text (the `content ?? output`
   fallback), proving the async read failure is swallowed.
3. **emission does not reject the message flow** — assert `handleMessage`'s
   returned promise resolves normally in both tests (implicit via `await promise`).

Model after: `src/agents/orchestrator.test.ts:5887`
("should emit tool:result event for each tool call result") for orchestrator
construction, mock provider `toolCalls` choreography, and the
fake-timer/await pattern.

Verification: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/agents/orchestrator.test.ts` → all pass, including ≥ 2 new tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "readFileSync" src/agents/orchestrator.ts` → no matches
- [ ] `npm run typecheck:src` exits 0
- [ ] `npm run lint:src` exits 0
- [ ] `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/agents/orchestrator.test.ts` → all pass; new `Workspace code events` tests exist and pass
- [ ] Event payload shapes unchanged (reviewer-checkable: diff shows no field added/removed/renamed in any `workspaceBus.emit` call)
- [ ] No files outside the in-scope list are modified (`git status --porcelain`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `src/agents/orchestrator.ts:6853-6925` doesn't match the
  excerpt above (file has drifted — line numbers shifting slightly is fine,
  the *shape* not matching is not).
- Existing orchestrator tests fail in a way that requires changing test
  expectations about event ordering (means a consumer DOES depend on
  synchronous emission — report which test).
- You find additional `readFileSync`/`statSync` calls inside `emitToolResult`
  beyond lines 6871/6896 (scope was scoped to exactly these two).
- The fake-timer harness deadlocks on the promise queue even with
  `drainWorkspaceCodeEvents` (report; do not switch the whole suite to real
  timers).

## Maintenance notes

- If orchestrator shutdown ever needs to guarantee delivery of in-flight
  monitor events, call `drainWorkspaceCodeEvents()` from the shutdown path —
  it was added with that in mind but wiring it is out of scope here.
- If a future change adds more file-derived telemetry, it must go through
  `enqueueCodeEvent` — never `readFileSync` — to keep ordering and
  non-blocking guarantees.
- Reviewer should scrutinize: (1) `workspace:mode_suggest` still fires after
  the file event, (2) the `.catch(() => {})` on the queue can never swallow
  a learning-bus (`tool:result`) failure because that emission stays outside
  the queue, (3) orchestrator.ts is ~6,960 lines and slated for a Round 4
  decomposition — keep this change minimal so it doesn't conflict.

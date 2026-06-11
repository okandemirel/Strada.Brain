# Plan 009: Eliminate the CompactableMessage double-cast by moving compaction summaries out of session.messages

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat aea95ad..HEAD -- src/agents/session-compaction.ts src/agents/session-compaction.test.ts src/agents/orchestrator.ts src/agents/orchestrator-session-manager.ts src/agents/orchestrator-session-manager.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `aea95ad`, 2026-06-11

## Why this matters

`src/agents/orchestrator.ts:5177` does `session.messages as unknown as CompactableMessage[]` because the `ConversationMessage` union (`UserMessage | AssistantMessage`, no `"system"` role) cannot express the system-role summary messages that the compaction pipeline injects back into `session.messages`. This is not just a type smell — the system-role messages it papers over are **already broken at runtime**: `ClaudeProvider.buildMessages` (src/agents/providers/claude.ts:161-232) only handles `"user"` and `"assistant"` roles and silently drops anything else, and `SessionManager.deserializeSession` (src/agents/orchestrator-session-manager.ts:144-153) filters out non-user/assistant messages on session restore, so compaction summaries vanish on restart. Moving the summary into dedicated session state fixes the type hole AND makes the summary actually reach the provider reliably.

## Decision: Option B (store summary separately) — Option A rejected

Two options were evaluated:

- **Option A (rejected)**: widen `ConversationMessage` with a `SystemMessage` variant. Verified blast radius: every provider's message-mapping code (12+ providers under `src/agents/providers/` — claude.ts, openai.ts, gemini.ts, kimi.ts, deepseek.ts, ollama.ts, minimax.ts, ...) would need explicit system-role handling (Anthropic's API does not even accept `system` in the messages array — it is a top-level parameter), plus the `isUserMessage`/`isAssistantMessage` guards (provider-core.interface.ts:204-210), the deserialize validator, and every exhaustive role switch. All of that to support a message kind that semantically belongs in the system prompt.
- **Option B (chosen)**: the ONLY producer of system-role messages into `session.messages` is the compaction summary itself — verified: `grep -rn 'role: "system"' src/agents/*.ts` matches only `src/agents/session-compaction.ts:219`. So store the summary in a new `Session.compactionSummary` field and append it to the system prompt at the provider call sites. The union stays narrow, providers are untouched, and the summary survives via explicit serialization.

## Current state

- `src/agents/session-compaction.ts` — 4-stage compaction pipeline. Lines 9-14 document the type mismatch. Lines 43-47 define the broad type:

```ts
// session-compaction.ts:43-47
export interface CompactableMessage {
  readonly role: "user" | "assistant" | "system";
  readonly content: string | readonly ContentBlock[];
  readonly [key: string]: unknown;
}
```

  Line 219 creates the summary: `const summaryMsg: CompactableMessage = { role: "system", content: summary };` (inside `stage2Summarization`). Stages 2/3/4 all hoist system-role messages to the FRONT of the array (`groups.filter((g) => g.kind === "system")` at lines 184, 239, 252), so system messages are always front-positioned — separating them loses no ordering information.

- `src/agents/orchestrator.ts:5166-5194` — `maybeCompactSession`, the only caller of `compactSession`:

```ts
// orchestrator.ts:5175-5186
    // Cast: session.messages may contain system-role messages at runtime;
    // CompactableMessage is a superset of ConversationMessage that includes "system".
    const msgs = session.messages as unknown as CompactableMessage[];
    const tokenEstimate = estimateTokens(msgs, systemPrompt?.length ?? 0);
    if (tokenEstimate <= ctxWindow * COMPACTION_TRIGGER_RATIO) return;
    const result = compactSession(msgs, { ... });
    if (result.compacted) {
      session.messages = result.messages as unknown as ConversationMessage[];
```

- `maybeCompactSession` is called at `orchestrator.ts:3047` and `orchestrator.ts:4316`, both immediately before a provider call that uses the same `activePrompt` + `session.messages`.
- Provider call sites in orchestrator.ts that send `session.messages` with a system prompt (verified by grep `chatStream(\|\.chat(`):
  - `orchestrator.ts:5230` — `chatStream(systemPrompt, session.messages, ...)` inside `silentStream`
  - `orchestrator.ts:5258` — `provider.chat(systemPrompt, session.messages, ...)` — silentStream's non-streaming fallback
  - `orchestrator.ts:5355` — `chatStream(...)` inside the visible `streamResponse` path (verify it passes `session.messages`)
  - `orchestrator.ts:3066` and `orchestrator.ts:4350` — non-streaming `resilientProvider.chat(...)` branches paired with the silentStream calls at 3065/4342
  Other `.chat(` sites (1103, 1605, 1747, 5864, 5961, 6031, 6121, intervention-pipeline) build ad-hoc message arrays, NOT `session.messages` — leave them alone.
- `src/agents/orchestrator-session-manager.ts:47-64` — `Session` interface (`messages: ConversationMessage[]`, plus optional fields like `reflectionOverrideCount?: number` which is the pattern to copy for backward-compatible optional fields). `serializeSession` (lines 123-133) and `deserializeSession` (lines 135+; role filter at 144-153).
- `src/agents/providers/provider-core.interface.ts:31-50` — `ConversationMessage = UserMessage | AssistantMessage`. Do NOT modify this file.
- `src/agents/session-compaction.test.ts` — currently only 3 tests, all for `estimateTokens`. `compactSession` itself has no direct tests yet.
- Imports of compaction symbols in orchestrator.ts at lines 81-87 (`compactSession`, `estimateTokens`, `type CompactableMessage`, from `./session-compaction.js`).

## Commands you will need

| Purpose | Command | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `npm run typecheck:src` | exit 0, no errors |
| Single test | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/agents/session-compaction.test.ts` | all pass |
| Session mgr test | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/agents/orchestrator-session-manager.test.ts` | all pass |
| Lint | `npm run lint:src` | exit 0 |
| Cast gone | `grep -rn "as unknown as CompactableMessage" src/` | no output, exit 1 |

## Scope

**In scope** (the only files you should modify):
- `src/agents/session-compaction.ts`
- `src/agents/session-compaction.test.ts`
- `src/agents/orchestrator.ts` (only `maybeCompactSession`, `silentStream`, `streamResponse`, the two non-streaming `.chat(` branches at ~3066/~4350, and one new private helper)
- `src/agents/orchestrator-session-manager.ts` (Session interface + serialize/deserialize)
- `src/agents/orchestrator-session-manager.test.ts` (add serialization round-trip test)

**Out of scope** (do NOT touch, even though they look related):
- `src/agents/providers/provider-core.interface.ts` — the union stays as-is by design (that is the point of Option B).
- Any file under `src/agents/providers/` — no provider message-mapping changes.
- `src/agents/orchestrator-loop-shared.ts`, `orchestrator-end-turn-handler.ts`, `orchestrator-reflection-handler.ts` — their `session.messages.push` sites only push user/assistant messages; nothing to change.
- The compaction algorithm itself (stages 1-4 internals) — only its public boundary changes.

## Git workflow

- Branch: `advisor/009-fix-compactable-message-type`
- Conventional commits, e.g. `refactor(agents): store compaction summary in session state instead of system-role messages`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Rework the public boundary of session-compaction.ts

In `src/agents/session-compaction.ts`:

1. Import the real message type: `import type { ConversationMessage } from "./providers/provider-core.interface.js";`
2. Replace the `CompactableMessage` interface (lines 43-47) with:

```ts
/** Internal summary message used by the compaction pipeline. */
export interface SystemSummaryMessage {
  readonly role: "system";
  readonly content: string;
}

/** Union the pipeline operates on internally. ConversationMessage[] is directly assignable. */
export type CompactableMessage = ConversationMessage | SystemSummaryMessage;
```

   The index signature is removed. Internal helpers (`messageChars`, `hasToolUse`, `isToolResultMessage`, `extractText`, `compactToolGroup`) already cast `msg.content as readonly ContentBlock[]` where needed; fix any new type errors with local casts at the same altitude as the existing ones (e.g. `msg.content as string | readonly ContentBlock[]`), NOT with `as unknown as`. Note: `AssistantMessage.content` is `string` and `UserMessage.content` is `string | MessageContent[]`; the runtime arrays carry tool_use/tool_result blocks, which is why the existing helpers cast.
3. Extend `CompactionOptions` with `readonly previousSummary?: string;` (doc comment: "Summary produced by a previous compaction; counted and merged into the new summary").
4. Change `CompactionResult` to:

```ts
export interface CompactionResult {
  readonly messages: ConversationMessage[];   // system-free
  readonly summary?: string;                  // merged summary text, if any system/summary content was produced
  readonly compacted: boolean;
  readonly stageApplied: string | null;
  readonly originalTokens: number;
  readonly finalTokens: number;
}
```

5. In `compactSession`:
   - Accept `messages: readonly ConversationMessage[]`.
   - At the start, build the internal working array: `const working: CompactableMessage[] = options.previousSummary ? [{ role: "system", content: options.previousSummary }, ...messages] : [...messages];` and run the existing pipeline on `working` (the early-return non-compacted path must still return the ORIGINAL `messages` and `summary: options.previousSummary` unchanged — but note the early return compares `originalTokens` computed from `working`, which correctly includes the previous summary's weight).
   - After the pipeline (every return path, including the early non-compacted return and stage-4), partition the resulting flat array: system-role entries vs the rest. Return the rest as `messages` (`as ConversationMessage[]` is acceptable here ONLY via a type predicate filter, e.g. `flat.filter((m): m is ConversationMessage => m.role !== "system")` — no `as unknown as`), and join the system entries' `content` strings with `"\n\n"` as `summary` (or `undefined` if none).
6. `estimateTokens` keeps its signature but typed against the new `CompactableMessage` union — `readonly ConversationMessage[]` arguments must be assignable with no cast.

**Verify**: `npm run typecheck:src` → exit 0 (orchestrator.ts will now error on the old casts — that is expected; proceed to Step 2 before judging typecheck, or run `npx tsc --noEmit 2>&1 | grep -v orchestrator` to confirm session-compaction.ts itself is clean).

### Step 2: Add Session.compactionSummary with serialization

In `src/agents/orchestrator-session-manager.ts`:

1. Add to the `Session` interface (model the doc comment on `reflectionOverrideCount`, lines 56-63):

```ts
  /**
   * Rolling summary produced by session compaction (see session-compaction.ts).
   * Appended to the system prompt at provider call time instead of being stored
   * as a system-role message in `messages` (ConversationMessage has no system role).
   * Optional for backward compatibility with legacy session files.
   */
  compactionSummary?: string;
```

2. `serializeSession` (line 123): add `compactionSummary: session.compactionSummary,` to the JSON object.
3. `deserializeSession`: restore it with validation, following the `reflectionOverrideCount` migration pattern at lines 154+: accept only `typeof raw === "string" && raw.length > 0 && raw.length <= 50_000`, else `undefined`.

**Verify**: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/agents/orchestrator-session-manager.test.ts` → all existing tests pass.

### Step 3: Rewrite maybeCompactSession and inject the summary at provider call sites

In `src/agents/orchestrator.ts`:

1. `maybeCompactSession` (lines 5166-5194) becomes cast-free:

```ts
    const tokenEstimate = estimateTokens(session.messages,
      (systemPrompt?.length ?? 0) + (session.compactionSummary?.length ?? 0));
    if (tokenEstimate <= ctxWindow * COMPACTION_TRIGGER_RATIO) return;
    const result = compactSession(session.messages, {
      maxTokens: Math.floor(ctxWindow * COMPACTION_TARGET_RATIO),
      preserveRecent: 4,
      maxGroups: 20,
      previousSummary: session.compactionSummary,
    });
    if (result.compacted) {
      session.messages = result.messages;
      if (result.summary) session.compactionSummary = result.summary;
      getLogger().info("Session compacted", { ... keep existing fields ... });
    }
```

   Remove the now-unused `type CompactableMessage` import if nothing else uses it.
2. Add a small private helper near `maybeCompactSession`:

```ts
  /** System prompt with the rolling compaction summary appended (if any). */
  private withCompactionSummary(systemPrompt: string, session: Session): string {
    return session.compactionSummary
      ? `${systemPrompt}\n\n## Prior conversation summary (compacted)\n${session.compactionSummary}`
      : systemPrompt;
  }
```

3. Apply it at every provider call that sends `session.messages` together with a system prompt. Known sites (verify each actually passes `session.messages` before editing; skip any that do not):
   - `silentStream`: compute `const effectivePrompt = this.withCompactionSummary(systemPrompt, session);` once at the top and use it at line ~5230 (`chatStream`) and line ~5258 (fallback `provider.chat`).
   - `streamResponse` (line ~5355 region): same pattern if it passes `session.messages`.
   - The non-streaming branches at line ~3066 and line ~4350 (`resilientProvider.chat(...)`): wrap the prompt argument (`activePrompt` or equivalent) with `this.withCompactionSummary(..., session)`.

**Verify**: `npm run typecheck:src` → exit 0. `grep -rn "as unknown as CompactableMessage" src/` → no matches. `grep -n "as unknown as ConversationMessage" src/agents/orchestrator.ts` → the line-5186 occurrence is gone (the unrelated cast at line ~5275 `} as ConversationMessage` may remain — it is a single cast, not in this plan's scope).

### Step 4: Tests

See "Test plan". Write them, then run the full targeted suite.

**Verify**:
`NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/agents/session-compaction.test.ts src/agents/orchestrator-session-manager.test.ts` → all pass, including the new tests.

### Step 5: Lint + full gate

**Verify**: `npm run lint:src` → exit 0. `npm run typecheck:src` → exit 0.

## Test plan

In `src/agents/session-compaction.test.ts` (extend the existing file; model structure on its existing `describe`/`it` style):

- `compactSession` returns `compacted: false` and untouched messages when under budget.
- `compactSession` with an over-budget conversation returns `messages` containing NO `role: "system"` entries (assert `result.messages.every(m => m.role !== "system")`) and a non-empty `summary` when stage 2 ran.
- `previousSummary` is merged: pass `previousSummary: "old summary"`, assert the returned `summary` includes content derived from it (it was prepended as a system entry and re-extracted).
- `previousSummary` round-trips unchanged when no compaction occurs (early return) — `summary === previousSummary`, `compacted === false`.
- Stage-4 hard truncation path still returns a system-free `messages` array.
- Type-level: the test file calls `compactSession` / `estimateTokens` with a plain `ConversationMessage[]` (no casts) — compilation is the assertion.

In `src/agents/orchestrator-session-manager.test.ts`:

- serialize→deserialize round-trip preserves `compactionSummary`.
- deserialize tolerates legacy JSON without the field (`compactionSummary === undefined`).
- deserialize rejects a non-string `compactionSummary` (e.g. number → `undefined`).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck:src` exits 0
- [ ] `grep -rn "as unknown as CompactableMessage" src/` returns nothing
- [ ] The `as unknown as ConversationMessage[]` cast formerly at orchestrator.ts:5186 is gone
- [ ] `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run src/agents/session-compaction.test.ts src/agents/orchestrator-session-manager.test.ts` exits 0 with new tests included
- [ ] `npm run lint:src` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `grep -rn 'role: "system"' src/agents/*.ts` (excluding tests) matches anything OTHER than session-compaction.ts — the "compaction is the only system-message producer" assumption is false.
- `maybeCompactSession` in the live code no longer matches the excerpt (orchestrator.ts has drifted; it is at ~6,960 lines and under active decomposition).
- Fixing type errors in session-compaction.ts internals seems to require `as unknown as` or modifying `provider-core.interface.ts`.
- `streamResponse` or the `.chat(` branches at ~3066/~4350 do not pass `session.messages` (call-shape drift) — report instead of guessing the injection point.
- Existing session-manager tests fail for reasons unrelated to `compactionSummary`.

## Maintenance notes

- The summary now travels via system prompt; if a future "context budget" feature counts system prompt tokens separately, include `session.compactionSummary.length` there too (as `maybeCompactSession` now does).
- Reviewer should scrutinize: (1) the early-return path of `compactSession` preserving `previousSummary`; (2) that no provider call site sending `session.messages` was missed (`grep -n "session.messages" src/agents/orchestrator.ts` and eyeball `.chat(`/`chatStream(` lines).
- Deferred: orchestrator Round-4 decomposition may move `maybeCompactSession`/`silentStream` into a module — keep `withCompactionSummary` adjacent to them.
- Deferred: summary text growth is bounded only by `SUMMARY_MAX_CHARS` per compaction plus merge; if sessions compact many times, consider re-summarizing the merged summary (not in this plan).

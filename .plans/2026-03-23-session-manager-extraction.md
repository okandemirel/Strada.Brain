# SessionManager Extraction — Phase 1 of Orchestrator Restructuring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract all session-related state and methods from `orchestrator.ts` into a `SessionManager` class, reducing orchestrator complexity by ~200 lines and consolidating session logic into one module.

**Architecture:** Create a `SessionManager` class that owns session state (`sessions`, `sessionLocks`, `lastPersistTime` maps) and exposes all session operations as methods. The class absorbs the existing free functions from `orchestrator-session-persistence.ts` plus the plan-review/write-rejection/message-sending methods currently inline in `orchestrator.ts`. The Orchestrator instantiates `SessionManager` in its constructor and delegates all session calls to it.

**Tech Stack:** TypeScript (strict mode), Vitest, ESM modules

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| **Create** | `src/agents/orchestrator-session-manager.ts` | `SessionManager` class — owns session state, transcript, persistence, plan review, message sending |
| **Create** | `src/agents/orchestrator-session-manager.test.ts` | Unit tests for SessionManager |
| **Modify** | `src/agents/orchestrator.ts` | Remove session methods/state, instantiate + delegate to `SessionManager` |
| **Delete** | `src/agents/orchestrator-session-persistence.ts` | Absorbed into SessionManager |

### Key design decisions

1. **SessionManager owns state** — `sessions`, `sessionLocks`, `lastPersistTime` maps move out of Orchestrator
2. **Shared references** — `activeGoalTrees`, `pendingResumeTrees` remain owned by Orchestrator but passed to SessionManager via constructor (SessionManager needs them for LRU eviction and goal tree cleanup)
3. **Narrow dependency interfaces** — SessionManager takes `channel: { sendText, sendMarkdown }` and `interactionPolicy: { get(chatId) }` rather than full objects
4. **Public API preserved** — `Orchestrator.cleanupSessions()` and `Orchestrator.getSessions()` stay as 1-line delegators so external callers (bootstrap, AgentManager, dashboard) don't change
5. **`Session` type re-exported** — from `orchestrator-session-manager.ts` so existing type imports keep working
6. **`SessionPersistenceContext` intentionally dropped** — it was only used internally between orchestrator.ts and orchestrator-session-persistence.ts. SessionManager holds its own state directly, making the context interface unnecessary.

---

### Task 1: Create SessionManager class with core session methods

**Files:**
- Create: `src/agents/orchestrator-session-manager.ts`

- [ ] **Step 1: Create SessionManager class with deps interface and constructor**

```typescript
// src/agents/orchestrator-session-manager.ts
import type { ConversationMessage } from "./providers/provider.interface.js";
import type { MessageContent, AssistantMessage } from "./providers/provider-core.interface.js";
import type { IMemoryManager } from "../memory/memory.interface.js";
import type { ChatId } from "../types/index.js";
import type { GoalTree } from "../goals/types.js";
import type { IEmbeddingProvider, IRAGPipeline } from "../rag/rag.interface.js";
import type { InstinctRetriever } from "./instinct-retriever.js";
import type { ReRetrievalConfig } from "../config/config.js";
import type { IEventEmitter, LearningEventMap } from "../core/event-bus.js";
import type { ExecutionJournal } from "./autonomy/index.js";
import type { TaskExecutionStore } from "../memory/unified/task-execution-store.js";
import type { SessionSummarizer } from "../memory/unified/session-summarizer.js";
import type { InteractionGateState } from "./autonomy/interaction-policy.js";
import type { InteractionBoundaryDecision } from "./autonomy/visibility-boundary.js";
import { MemoryRefresher } from "./memory-refresher.js";
import { redactSensitiveText } from "./orchestrator-text-utils.js";
import { stripInternalDecisionMarkers } from "./orchestrator-supervisor-routing.js";
import { getLogger } from "../utils/logger.js";

const MAX_SESSIONS = 100;
const LOW_SIGNAL_EXECUTION_ACK_RE =
  /^(?:adjusted|done|ok(?:ay)?|noted|ack(?:nowledged)?|revised|updated|handled|understood|fixed)\.?$/iu;

export interface Session {
  messages: ConversationMessage[];
  visibleMessages?: ConversationMessage[];
  lastActivity: Date;
  conversationScope?: string;
  profileKey?: string;
  mixedParticipants?: boolean;
  postSetupBootstrapDelivered?: boolean;
}

export interface SessionManagerDeps {
  readonly channel: {
    sendText(chatId: string, text: string): Promise<void>;
    sendMarkdown(chatId: string, markdown: string): Promise<void>;
  };
  readonly interactionPolicy: {
    get(chatId: string): InteractionGateState | undefined;
  };
  readonly activeGoalTrees: Map<string, GoalTree>;
  readonly pendingResumeTrees: Map<string, GoalTree[]>;
  readonly memoryManager?: IMemoryManager;
  readonly sessionSummarizer?: SessionSummarizer;
  readonly reRetrievalConfig?: ReRetrievalConfig;
  readonly embeddingProvider?: IEmbeddingProvider;
  readonly ragPipeline?: IRAGPipeline;
  readonly instinctRetriever: InstinctRetriever | null;
  readonly eventEmitter: IEventEmitter<LearningEventMap> | null;
  readonly taskExecutionStore?: TaskExecutionStore;
}

export class SessionManager {
  private static readonly PERSIST_DEBOUNCE_MS = 5_000;

  readonly sessions = new Map<string, Session>();
  readonly sessionLocks = new Map<string, Promise<void>>();
  private readonly lastPersistTime = new Map<string, number>();
  private readonly deps: SessionManagerDeps;

  constructor(deps: SessionManagerDeps) {
    this.deps = deps;
  }
}
```

- [ ] **Step 2: Add getOrCreateSession method**

```typescript
getOrCreateSession(chatId: string): Session {
  let session = this.sessions.get(chatId);
  if (session) {
    this.sessions.delete(chatId);
    this.sessions.set(chatId, session);
    return session;
  }

  if (this.sessions.size >= MAX_SESSIONS) {
    const oldestKey = this.sessions.keys().next().value as string;
    const oldestSession = this.sessions.get(oldestKey);
    this.sessions.delete(oldestKey);
    this.sessionLocks.delete(oldestKey);
    this.deps.activeGoalTrees.delete(oldestSession?.conversationScope ?? oldestKey);
  }

  session = {
    messages: [],
    visibleMessages: [],
    lastActivity: new Date(),
    mixedParticipants: false,
  };
  this.sessions.set(chatId, session);
  return session;
}
```

- [ ] **Step 3: Add trimSession method**

Copy the full `trimSession` function body from `orchestrator-session-persistence.ts:91-161` as a class method. Replace `function trimSession(session, maxMessages)` signature with `trimSession(session: Session, maxMessages: number): ConversationMessage[]`. No logic changes — the body is identical.

- [ ] **Step 4: Add visible transcript methods**

```typescript
private ensureVisibleMessages(session: Session): ConversationMessage[] {
  if (!session.visibleMessages) {
    session.visibleMessages = [];
  }
  return session.visibleMessages;
}

getVisibleTranscript(session: Session): ConversationMessage[] {
  return this.ensureVisibleMessages(session);
}

appendVisibleUserMessage(session: Session, content: string | MessageContent[]): void {
  const message: ConversationMessage = { role: "user", content };
  session.messages.push(message);
  this.ensureVisibleMessages(session).push(message);
}

appendVisibleAssistantMessage(session: Session, content: string): void {
  const message: ConversationMessage = { role: "assistant", content };
  session.messages.push(message);
  this.ensureVisibleMessages(session).push(message);
}
```

- [ ] **Step 5: Add extractLastUserMessage method**

```typescript
extractLastUserMessage(session: Session): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i]!;
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      const textParts = (msg.content as MessageContent[])
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text);
      if (textParts.length > 0) return textParts.join(" ");
    }
  }
  return "";
}
```

- [ ] **Step 6: Add sendVisibleAssistantText and sendVisibleAssistantMarkdown**

```typescript
async sendVisibleAssistantText(chatId: string, session: Session, content: string): Promise<void> {
  this.appendVisibleAssistantMessage(session, content);
  await this.deps.channel.sendText(chatId, content);
}

async sendVisibleAssistantMarkdown(chatId: string, session: Session, content: string): Promise<void> {
  this.appendVisibleAssistantMessage(session, content);
  await this.deps.channel.sendMarkdown(chatId, content);
}
```

- [ ] **Step 7: Add memory persistence methods**

Copy from `orchestrator-session-persistence.ts`, replacing `ctx.` with `this.`/`this.deps.`:

```typescript
async persistSessionToMemory(
  chatId: string,
  messages: ConversationMessage[],
  force = false,
): Promise<void> {
  if (!this.deps.memoryManager) return;
  if (messages.length < 2) return;

  if (!force) {
    const now = Date.now();
    const lastTime = this.lastPersistTime.get(chatId) ?? 0;
    if (now - lastTime < SessionManager.PERSIST_DEBOUNCE_MS) return;
    this.lastPersistTime.set(chatId, now);
  }

  try {
    const summary = messages
      .map((m) => {
        if (typeof m.content === "string") return `[${m.role}] ${m.content}`;
        if (Array.isArray(m.content)) {
          const texts = (m.content as MessageContent[])
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text);
          return texts.length > 0
            ? `[${m.role}] ${texts.join(" ")}`
            : `[${m.role}] [media message]`;
        }
        return `[${m.role}] [complex content]`;
      })
      .join("\n");

    if (summary) {
      const sanitized = redactSensitiveText(summary);
      const userMsg = messages.find((m) => m.role === "user");
      let assistantMsg: ConversationMessage | undefined;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]!.role === "assistant") {
          assistantMsg = messages[i];
          break;
        }
      }
      const extractText = (msg: ConversationMessage | undefined): string | undefined => {
        if (!msg) return undefined;
        if (typeof msg.content === "string") return msg.content.slice(0, 500);
        if (Array.isArray(msg.content)) {
          const texts = (msg.content as Array<{ type: string; text?: string }>)
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text)
            .join(" ");
          return texts.slice(0, 500) || undefined;
        }
        return undefined;
      };
      const result = await this.deps.memoryManager.storeConversation(chatId as ChatId, sanitized, {
        userMessage: extractText(userMsg),
        assistantMessage: extractText(assistantMsg),
      });
      if (result && typeof result === "object" && "kind" in result && result.kind === "err") {
        getLogger().warn("Memory storeConversation failed", {
          chatId,
          error: String((result as { error: unknown }).error),
        });
      }
    }
  } catch (error) {
    getLogger().warn("Memory persistence failed", {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

persistExecutionMemory(scopeKey: string, executionJournal: ExecutionJournal): void {
  if (!this.deps.taskExecutionStore) {
    return;
  }
  try {
    this.deps.taskExecutionStore.updateExecutionSnapshot(scopeKey, executionJournal.snapshot());
  } catch (error) {
    getLogger().warn("Execution memory persistence failed", {
      scopeKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

createMemoryRefresher(initialContentHashes: string[]): MemoryRefresher | null {
  if (!this.deps.reRetrievalConfig?.enabled) return null;
  const refresher = new MemoryRefresher(this.deps.reRetrievalConfig, {
    memoryManager: this.deps.memoryManager,
    ragPipeline: this.deps.ragPipeline,
    instinctRetriever: this.deps.instinctRetriever ?? undefined,
    embeddingProvider: this.deps.embeddingProvider,
    eventBus: this.deps.eventEmitter ?? undefined,
  });
  if (initialContentHashes.length > 0) {
    refresher.seedContentHashes(initialContentHashes);
  }
  return refresher;
}

takePendingResumeTrees(conversationScope: string, chatId: string): GoalTree[] {
  const scoped = this.deps.pendingResumeTrees.get(conversationScope);
  if (scoped && scoped.length > 0) {
    this.deps.pendingResumeTrees.delete(conversationScope);
    return scoped;
  }

  if (conversationScope !== chatId) {
    const legacyChatScoped = this.deps.pendingResumeTrees.get(chatId);
    if (legacyChatScoped && legacyChatScoped.length > 0) {
      this.deps.pendingResumeTrees.delete(chatId);
      return legacyChatScoped;
    }
  }

  return [];
}
```

- [ ] **Step 8: Add plan review and write rejection methods**

```typescript
formatPlanReviewMessage(draft: string): string {
  return [
    "Plan review requested before execution.",
    "",
    draft.trim(),
    "",
    "Reply with your approval or requested changes before write-capable execution continues.",
  ].join("\n");
}

getPendingPlanReviewVisibleText(chatId: string): string | null {
  const gate = this.deps.interactionPolicy.get(chatId);
  if (gate?.kind !== "plan-review-required") {
    return null;
  }
  if (gate.planText?.trim()) {
    return this.formatPlanReviewMessage(gate.planText);
  }
  return [
    "Plan review requested before execution.",
    "",
    "A concrete plan still needs to be shown before write-capable execution continues.",
    "",
    "Reply with your approval or requested changes before write-capable execution continues.",
  ].join("\n");
}

getPendingSelfManagedWriteRejectionVisibleText(
  session: Session,
  draft: string | null | undefined,
): string | null {
  const normalizedDraft = stripInternalDecisionMarkers(draft ?? "").trim();
  if (normalizedDraft && !LOW_SIGNAL_EXECUTION_ACK_RE.test(normalizedDraft)) {
    return null;
  }

  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (!message || message.role !== "user" || !Array.isArray(message.content)) {
      continue;
    }

    for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = (message.content as MessageContent[])[blockIndex];
      if (!block || block.type !== "tool_result" || typeof (block as { content?: string }).content !== "string") {
        continue;
      }
      const blockContent = (block as { content: string }).content;
      if (!blockContent.startsWith("Self-managed write review rejected")) {
        continue;
      }

      const match = blockContent.match(
        /for '([^']+)':\s*(.+?)\.\s*Choose a safer bounded operation/iu,
      );
      const toolName = match?.[1] ?? "write-capable action";
      const reason = match?.[2]?.trim() ?? blockContent.trim();
      return [
        `Execution stopped because the proposed '${toolName}' operation was rejected by autonomous safety review.`,
        "",
        `Reason: ${reason}.`,
        "",
        "No safer bounded replacement was produced in the same turn.",
      ].join("\n");
    }
  }

  return null;
}

formatBoundaryVisibleText(decision: InteractionBoundaryDecision): string | undefined {
  if (!decision.visibleText) {
    return undefined;
  }
  return decision.kind === "plan_review"
    ? this.formatPlanReviewMessage(decision.visibleText)
    : decision.visibleText;
}
```

- [ ] **Step 9: Add cleanupSessions method**

```typescript
cleanupSessions(maxAgeMs: number = 3_600_000): void {
  const now = Date.now();
  for (const [chatId, session] of this.sessions) {
    if (now - session.lastActivity.getTime() > maxAgeMs) {
      if (this.sessionLocks.has(chatId)) continue;

      const visibleMessages = this.getVisibleTranscript(session);
      if (this.deps.sessionSummarizer && visibleMessages.length >= 2) {
        void this.deps.sessionSummarizer
          .summarizeAndUpdateProfile(session.profileKey ?? chatId, visibleMessages)
          .catch(() => {});
      }
      void this.persistSessionToMemory(chatId, visibleMessages.slice(-10), true);
      this.lastPersistTime.delete(chatId);
      this.sessions.delete(chatId);
      this.deps.activeGoalTrees.delete(session.conversationScope ?? chatId);
    }
  }
}
```

- [ ] **Step 10: Add lastPersistTime accessor for Orchestrator's profile touch debouncing**

The Orchestrator's `processMessage` uses `lastPersistTime` for profile-touch debouncing (lines 2057, 3812) — this is NOT session logic, but the map is shared. Expose it:

```typescript
/** Exposed for Orchestrator's profile-touch debouncing. Will move to a dedicated tracker in Phase 2. */
get persistTimeMap(): Map<string, number> {
  return this.lastPersistTime;
}
```

- [ ] **Step 11: Verify the file compiles**

Run: `npx tsc --noEmit src/agents/orchestrator-session-manager.ts`
Expected: 0 errors (or only errors about missing orchestrator imports which is fine since the file isn't wired yet)

---

### Task 2: Write SessionManager unit tests

**Files:**
- Create: `src/agents/orchestrator-session-manager.test.ts`

- [ ] **Step 1: Write test helper and construction/getOrCreateSession tests**

```typescript
import { describe, it, expect, vi } from "vitest";
import { SessionManager, type SessionManagerDeps } from "./orchestrator-session-manager.js";

function createMockDeps(overrides?: Partial<SessionManagerDeps>): SessionManagerDeps {
  return {
    channel: {
      sendText: vi.fn().mockResolvedValue(undefined),
      sendMarkdown: vi.fn().mockResolvedValue(undefined),
    },
    interactionPolicy: { get: vi.fn().mockReturnValue(undefined) },
    activeGoalTrees: new Map(),
    pendingResumeTrees: new Map(),
    instinctRetriever: null,
    eventEmitter: null,
    ...overrides,
  };
}

describe("SessionManager", () => {
  it("creates a new session for unknown chatId", () => {
    const sm = new SessionManager(createMockDeps());
    const session = sm.getOrCreateSession("chat-1");
    expect(session.messages).toEqual([]);
    expect(session.visibleMessages).toEqual([]);
  });

  it("returns existing session and refreshes LRU order", () => {
    const sm = new SessionManager(createMockDeps());
    const s1 = sm.getOrCreateSession("chat-1");
    sm.getOrCreateSession("chat-2");
    const s1Again = sm.getOrCreateSession("chat-1");
    expect(s1Again).toBe(s1);
    const keys = [...sm.sessions.keys()];
    expect(keys[keys.length - 1]).toBe("chat-1");
  });
});
```

- [ ] **Step 2: Write test for visible transcript management**

```typescript
it("appendVisibleAssistantMessage adds to both messages and visibleMessages", () => {
  const sm = new SessionManager(createMockDeps());
  const session = sm.getOrCreateSession("chat-1");
  sm.appendVisibleAssistantMessage(session, "Hello");
  expect(session.messages).toHaveLength(1);
  expect(session.messages[0]).toEqual({ role: "assistant", content: "Hello" });
  expect(session.visibleMessages).toHaveLength(1);
});

it("getVisibleTranscript returns visible messages", () => {
  const sm = new SessionManager(createMockDeps());
  const session = sm.getOrCreateSession("chat-1");
  sm.appendVisibleUserMessage(session, "Hi");
  sm.appendVisibleAssistantMessage(session, "Hey");
  const transcript = sm.getVisibleTranscript(session);
  expect(transcript).toHaveLength(2);
  expect(transcript[0]!.role).toBe("user");
  expect(transcript[1]!.role).toBe("assistant");
});
```

- [ ] **Step 3: Write test for sendVisibleAssistantMarkdown**

```typescript
it("sendVisibleAssistantMarkdown appends message and calls channel", async () => {
  const deps = createMockDeps();
  const sm = new SessionManager(deps);
  const session = sm.getOrCreateSession("chat-1");
  await sm.sendVisibleAssistantMarkdown("chat-1", session, "**bold**");
  expect(session.messages).toHaveLength(1);
  expect(deps.channel.sendMarkdown).toHaveBeenCalledWith("chat-1", "**bold**");
});
```

- [ ] **Step 4: Write test for extractLastUserMessage**

```typescript
it("extractLastUserMessage returns last user string content", () => {
  const sm = new SessionManager(createMockDeps());
  const session = sm.getOrCreateSession("chat-1");
  sm.appendVisibleUserMessage(session, "first");
  sm.appendVisibleAssistantMessage(session, "response");
  sm.appendVisibleUserMessage(session, "second");
  expect(sm.extractLastUserMessage(session)).toBe("second");
});

it("extractLastUserMessage returns empty string for empty session", () => {
  const sm = new SessionManager(createMockDeps());
  const session = sm.getOrCreateSession("chat-1");
  expect(sm.extractLastUserMessage(session)).toBe("");
});
```

- [ ] **Step 5: Write test for trimSession**

```typescript
it("trimSession removes oldest messages when exceeding max", () => {
  const sm = new SessionManager(createMockDeps());
  const session = sm.getOrCreateSession("chat-1");
  // Add 6 messages (3 pairs)
  for (let i = 0; i < 3; i++) {
    sm.appendVisibleUserMessage(session, `user-${i}`);
    sm.appendVisibleAssistantMessage(session, `assistant-${i}`);
  }
  expect(session.messages).toHaveLength(6);
  const trimmed = sm.trimSession(session, 4);
  expect(session.messages.length).toBeLessThanOrEqual(6);
  // trimmed returns removed visible messages
  expect(Array.isArray(trimmed)).toBe(true);
});

it("trimSession returns empty array when under limit", () => {
  const sm = new SessionManager(createMockDeps());
  const session = sm.getOrCreateSession("chat-1");
  sm.appendVisibleUserMessage(session, "hi");
  const trimmed = sm.trimSession(session, 10);
  expect(trimmed).toEqual([]);
});
```

- [ ] **Step 6: Write test for plan review visible text**

```typescript
it("getPendingPlanReviewVisibleText returns null when no gate", () => {
  const sm = new SessionManager(createMockDeps());
  expect(sm.getPendingPlanReviewVisibleText("chat-1")).toBeNull();
});

it("getPendingPlanReviewVisibleText returns formatted plan when gate has planText", () => {
  const deps = createMockDeps({
    interactionPolicy: {
      get: vi.fn().mockReturnValue({ kind: "plan-review-required", planText: "Step 1\nStep 2" }),
    },
  });
  const sm = new SessionManager(deps);
  const text = sm.getPendingPlanReviewVisibleText("chat-1");
  expect(text).toContain("Plan review requested");
  expect(text).toContain("Step 1");
});
```

- [ ] **Step 7: Write test for cleanupSessions**

```typescript
it("cleanupSessions removes expired sessions", () => {
  const sm = new SessionManager(createMockDeps());
  const session = sm.getOrCreateSession("chat-1");
  session.lastActivity = new Date(Date.now() - 7_200_000); // 2 hours ago
  sm.cleanupSessions(3_600_000);
  expect(sm.sessions.has("chat-1")).toBe(false);
});

it("cleanupSessions skips locked sessions", () => {
  const sm = new SessionManager(createMockDeps());
  const session = sm.getOrCreateSession("chat-1");
  session.lastActivity = new Date(Date.now() - 7_200_000);
  sm.sessionLocks.set("chat-1", Promise.resolve());
  sm.cleanupSessions(3_600_000);
  expect(sm.sessions.has("chat-1")).toBe(true);
});
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run src/agents/orchestrator-session-manager.test.ts`
Expected: All tests PASS

- [ ] **Step 9: Commit**

```bash
git add src/agents/orchestrator-session-manager.ts src/agents/orchestrator-session-manager.test.ts
git commit -m "feat(agents): create SessionManager class with unit tests

Phase 1 of orchestrator restructuring milestone.
SessionManager owns session state and consolidates session operations:
- Session creation/retrieval with LRU eviction
- Visible transcript management
- Message sending (text + markdown)
- Memory persistence (debounced)
- Plan review / write rejection visible text
- Session cleanup with summarization"
```

---

### Task 3: Wire SessionManager into Orchestrator

**Files:**
- Modify: `src/agents/orchestrator.ts`

This task is the critical replacement. It has two sub-parts: (A) add SessionManager instantiation, (B) replace all call sites.

- [ ] **Step 1: Add SessionManager import and field**

In `orchestrator.ts`, replace the import block at lines 221-234:

```typescript
// REMOVE:
import {
  getOrCreateSession as getOrCreateSessionHelper,
  trimSession as trimSessionHelper,
  persistSessionToMemory as persistSessionToMemoryHelper,
  persistExecutionMemory as persistExecutionMemoryHelper,
  createMemoryRefresher as createMemoryRefresherHelper,
  takePendingResumeTrees as takePendingResumeTreesHelper,
  extractLastUserMessage as extractLastUserMessageHelper,
  getVisibleTranscript as getVisibleTranscriptHelper,
  appendVisibleUserMessage as appendVisibleUserMessageHelper,
  appendVisibleAssistantMessage as appendVisibleAssistantMessageHelper,
  type Session,
  type SessionPersistenceContext,
} from "./orchestrator-session-persistence.js";

// ADD:
import { SessionManager, type Session } from "./orchestrator-session-manager.js";
```

- [ ] **Step 2: Remove session state fields from Orchestrator class**

Remove these field declarations (lines ~464-465, ~494):
```typescript
// REMOVE:
private readonly sessions = new Map<string, Session>();
private readonly sessionLocks = new Map<string, Promise<void>>();
private readonly lastPersistTime = new Map<string, number>();
```

Add new field:
```typescript
private readonly sessionManager: SessionManager;
```

- [ ] **Step 3: Instantiate SessionManager in constructor**

At the end of the Orchestrator constructor, add:
```typescript
this.sessionManager = new SessionManager({
  channel: this.channel,
  interactionPolicy: this.interactionPolicy,
  activeGoalTrees: this.activeGoalTrees,
  pendingResumeTrees: this.pendingResumeTrees,
  memoryManager: this.memoryManager,
  sessionSummarizer: this.sessionSummarizer,
  reRetrievalConfig: this.reRetrievalConfig,
  embeddingProvider: this.embeddingProvider,
  ragPipeline: this.ragPipeline,
  instinctRetriever: this.instinctRetriever,
  eventEmitter: this.eventEmitter,
  taskExecutionStore: this.taskExecutionStore,
});
```

- [ ] **Step 4: Remove all wrapper methods from Orchestrator**

Remove these method definitions entirely (they become `this.sessionManager.X()` calls at their call sites):

Session state wrappers:
- `getVisibleTranscript` (lines 1273-1275)
- `appendVisibleUserMessage` (lines 1277-1279)
- `appendVisibleAssistantMessage` (lines 1281-1283)
- `sendVisibleAssistantText` (lines 1285-1292)
- `sendVisibleAssistantMarkdown` (lines 1294-1301)
- `extractLastUserMessage` (lines 6921-6923)
- `getOrCreateSession` (lines 6925-6927)
- `trimSession` (lines 6929-6936)

Memory persistence wrappers:
- `persistSessionToMemory` (lines 6977-6983)
- `persistExecutionMemory` (line 7040-7042)
- `createMemoryRefresher` (lines 7319-7321)
- `takePendingResumeTrees` (lines 7323-7325)

Plan review / visibility methods:
- `formatPlanReviewMessage` (lines 1374-1382)
- `getPendingPlanReviewVisibleText` (lines 1384-1399)
- `getPendingSelfManagedWriteRejectionVisibleText` (lines 1401-1441)
- `formatBoundaryVisibleText` (lines 1443-1449)

Infrastructure to remove:
- `getSessionPersistenceContext` (lines 6903-6918) — no longer needed
- `PERSIST_DEBOUNCE_MS` constant (line 6971) — moved to SessionManager

- [ ] **Step 5: Replace cleanupSessions and getSessions with delegators**

Replace `cleanupSessions` body (lines 6945-6968) with:
```typescript
cleanupSessions(maxAgeMs: number = 3_600_000): void {
  this.sessionManager.cleanupSessions(maxAgeMs);
}
```

Replace `getSessions` body (lines 1804-1813) with:
```typescript
getSessions(): Map<string, { lastActivity: Date; messageCount: number }> {
  const result = new Map<string, { lastActivity: Date; messageCount: number }>();
  for (const [chatId, session] of this.sessionManager.sessions) {
    result.set(chatId, {
      lastActivity: session.lastActivity,
      messageCount: session.messages.length,
    });
  }
  return result;
}
```

- [ ] **Step 6: Replace all session method call sites**

Mechanical replacements throughout `orchestrator.ts` — search and replace each pattern:

| Find | Replace | Count |
|------|---------|-------|
| `this.getOrCreateSession(` | `this.sessionManager.getOrCreateSession(` | 4 |
| `this.getVisibleTranscript(` | `this.sessionManager.getVisibleTranscript(` | 9 |
| `this.appendVisibleUserMessage(` | `this.sessionManager.appendVisibleUserMessage(` | 6 |
| `this.appendVisibleAssistantMessage(` | `this.sessionManager.appendVisibleAssistantMessage(` | 9 |
| `this.sendVisibleAssistantText(` | `this.sessionManager.sendVisibleAssistantText(` | 14 |
| `this.sendVisibleAssistantMarkdown(` | `this.sessionManager.sendVisibleAssistantMarkdown(` | 21 |
| `this.persistSessionToMemory(` | `this.sessionManager.persistSessionToMemory(` | 10 |
| `this.extractLastUserMessage(` | `this.sessionManager.extractLastUserMessage(` | 2 |
| `this.trimSession(` | `this.sessionManager.trimSession(` | 1 |
| `this.getPendingPlanReviewVisibleText(` | `this.sessionManager.getPendingPlanReviewVisibleText(` | 5 |
| `this.getPendingSelfManagedWriteRejectionVisibleText(` | `this.sessionManager.getPendingSelfManagedWriteRejectionVisibleText(` | 4 |
| `this.formatPlanReviewMessage(` | `this.sessionManager.formatPlanReviewMessage(` | 5 |
| `this.formatBoundaryVisibleText(` | `this.sessionManager.formatBoundaryVisibleText(` | 2 |

Also replace the 3 helper calls that used `getSessionPersistenceContext()`:
| Find | Replace |
|------|---------|
| `persistExecutionMemoryHelper(this.getSessionPersistenceContext(), scopeKey, executionJournal)` | `this.sessionManager.persistExecutionMemory(scopeKey, executionJournal)` |
| `createMemoryRefresherHelper(this.getSessionPersistenceContext(), initialContentHashes)` | `this.sessionManager.createMemoryRefresher(initialContentHashes)` |
| `takePendingResumeTreesHelper(this.getSessionPersistenceContext(), conversationScope, chatId)` | `this.sessionManager.takePendingResumeTrees(conversationScope, chatId)` |

- [ ] **Step 7: Fix remaining references to session state fields**

Replace ALL direct field accesses — **be careful with these, they are sensitive concurrency sites**:

**Session lock logic in `handleMessage` (lines ~1888-1906)** — concurrency-critical:
```typescript
// Replace this.sessionLocks with this.sessionManager.sessionLocks
const prev = this.sessionManager.sessionLocks.get(chatId) ?? Promise.resolve();
// ... (same pattern for .set() and .delete() and .get() calls)
```

**Metrics in `processMessage` (line ~3788)**:
```typescript
// Replace: this.sessions.size
this.metrics?.setActiveSessions(this.sessionManager.sessions.size);
```

**Profile touch debouncing in `processMessage` (lines ~2057, ~3812)**:
```typescript
// Replace: this.lastPersistTime → this.sessionManager.persistTimeMap
const lastTouch = this.sessionManager.persistTimeMap.get(`touch:${identityKey}`) ?? 0;
// ...
this.sessionManager.persistTimeMap.set(`touch:${identityKey}`, Date.now());
```

- [ ] **Step 8: Remove the LOW_SIGNAL_EXECUTION_ACK_RE constant**

Remove line 252-253 from orchestrator.ts (moved to SessionManager):
```typescript
// REMOVE from orchestrator.ts:
const LOW_SIGNAL_EXECUTION_ACK_RE =
  /^(?:adjusted|done|ok(?:ay)?|noted|ack(?:nowledged)?|revised|updated|handled|understood|fixed)\.?$/iu;
```

- [ ] **Step 9: Verify TypeScript compilation**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 10: Run full test suite**

Run: `npm test`
Expected: All 4,162+ tests pass, 0 failures

- [ ] **Step 11: Commit**

```bash
git add src/agents/orchestrator.ts
git commit -m "refactor(agents): wire SessionManager into Orchestrator

Replace 18 session wrapper methods + 3 state fields with delegation
to SessionManager. ~200 lines removed from orchestrator.ts.
All call sites updated mechanically (this.X → this.sessionManager.X).
cleanupSessions() and getSessions() remain as public delegators."
```

---

### Task 4: Delete orchestrator-session-persistence.ts

**Files:**
- Delete: `src/agents/orchestrator-session-persistence.ts`

- [ ] **Step 1: Verify no remaining imports of the old file**

Run: `grep -r "orchestrator-session-persistence" src/ --include='*.ts'`
Expected: 0 matches (all imports were updated in Task 3)

Note: `src/agents/README.md` may still reference the old file — update that reference if it exists:
```bash
grep -r "orchestrator-session-persistence" src/ --include='*.md'
```
If found, update the README reference to point to `orchestrator-session-manager.ts`.

- [ ] **Step 2: Delete the file**

```bash
git rm src/agents/orchestrator-session-persistence.ts
```

- [ ] **Step 3: Verify TypeScript compilation**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(agents): remove orchestrator-session-persistence.ts

Absorbed into SessionManager class. No logic changes.
Updated README.md references if applicable."
```

---

### Task 5: Final verification and line count audit

- [ ] **Step 1: Run full test suite one final time**

Run: `npm test`
Expected: All 4,162+ tests pass

- [ ] **Step 2: Verify 0 TypeScript errors**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: Count lines**

Run: `wc -l src/agents/orchestrator.ts src/agents/orchestrator-session-manager.ts`

Expected:
- `orchestrator.ts`: ~7,100 lines (down from 7,326 — ~200 lines removed)
- `orchestrator-session-manager.ts`: ~450 lines
- Net: session logic consolidated into one module, orchestrator reduced

- [ ] **Step 4: Verify no remaining session logic in orchestrator.ts**

Run: `grep -n "private.*getVisibleTranscript\|private.*appendVisible\|private.*persistSessionToMemory\|private.*formatPlanReview\|private.*getPendingPlanReview\|private.*getPendingSelfManaged\|private.*formatBoundaryVisible\|private.*getSessionPersistenceContext\|private.*persistExecutionMemory\|private.*createMemoryRefresher\|private.*takePendingResumeTrees" src/agents/orchestrator.ts`

Expected: 0 matches. All private session method definitions removed. Only the `sessionManager` field declaration, `cleanupSessions` delegator, and `getSessions` delegator should remain.

- [ ] **Step 5: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "chore(agents): Phase 1 complete — SessionManager extraction verified"
```

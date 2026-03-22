import type { ConversationMessage } from "./providers/provider.interface.js";
import type { MessageContent, AssistantMessage } from "./providers/provider-core.interface.js";
import type { IMemoryManager } from "../memory/memory.interface.js";
import type { ChatId } from "../types/index.js";
import type { GoalTree } from "../goals/types.js";
import type { IEmbeddingProvider } from "../rag/rag.interface.js";
import type { IRAGPipeline } from "../rag/rag.interface.js";
import type { InstinctRetriever } from "./instinct-retriever.js";
import type { ReRetrievalConfig } from "../config/config.js";
import type { IEventEmitter, LearningEventMap } from "../core/event-bus.js";
import type { ExecutionJournal } from "./autonomy/index.js";
import type { TaskExecutionStore } from "../memory/unified/task-execution-store.js";
import { MemoryRefresher } from "./memory-refresher.js";
import { redactSensitiveText } from "./orchestrator-text-utils.js";
import { getLogger } from "../utils/logger.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_SESSIONS = 100;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Session {
  messages: ConversationMessage[];
  visibleMessages?: ConversationMessage[];
  lastActivity: Date;
  conversationScope?: string;
  profileKey?: string;
  mixedParticipants?: boolean;
  postSetupBootstrapDelivered?: boolean;
}

/**
 * Readonly context interface carrying the Orchestrator fields
 * needed by session-persistence standalone functions.
 */
export interface SessionPersistenceContext {
  readonly sessions: Map<string, Session>;
  readonly sessionLocks: Map<string, Promise<void>>;
  readonly activeGoalTrees: Map<string, GoalTree>;
  readonly pendingResumeTrees: Map<string, GoalTree[]>;
  readonly memoryManager?: IMemoryManager;
  readonly reRetrievalConfig?: ReRetrievalConfig;
  readonly embeddingProvider?: IEmbeddingProvider;
  readonly ragPipeline?: IRAGPipeline;
  readonly instinctRetriever: InstinctRetriever | null;
  readonly eventEmitter: IEventEmitter<LearningEventMap> | null;
  readonly taskExecutionStore?: TaskExecutionStore;
  readonly lastPersistTime: Map<string, number>;
  readonly persistDebounceMs: number;
}

// ─── Functions ────────────────────────────────────────────────────────────────

export function getOrCreateSession(
  ctx: SessionPersistenceContext,
  chatId: string,
): Session {
  let session = ctx.sessions.get(chatId);
  if (session) {
    // Move to end for LRU ordering (Map preserves insertion order)
    ctx.sessions.delete(chatId);
    ctx.sessions.set(chatId, session);
    return session;
  }

  // Evict oldest session if at capacity
  if (ctx.sessions.size >= MAX_SESSIONS) {
    const oldestKey = ctx.sessions.keys().next().value as string;
    const oldestSession = ctx.sessions.get(oldestKey);
    ctx.sessions.delete(oldestKey);
    ctx.sessionLocks.delete(oldestKey);
    ctx.activeGoalTrees.delete(oldestSession?.conversationScope ?? oldestKey);
  }

  session = {
    messages: [],
    visibleMessages: [],
    lastActivity: new Date(),
    mixedParticipants: false,
  };
  ctx.sessions.set(chatId, session);
  return session;
}

/**
 * Trim session history to keep context manageable.
 * Trims at safe boundaries to avoid orphaning tool_use/tool_result pairs.
 * Returns the trimmed (removed) messages for persistence.
 */
export function trimSession(session: Session, maxMessages: number): ConversationMessage[] {
  if (session.messages.length <= maxMessages) return [];

  const overflow = session.messages.length - maxMessages;
  const trimMessages = (count: number): ConversationMessage[] => {
    const removed = session.messages.splice(0, count);
    if (removed.length === 0) {
      return removed;
    }
    if (!session.visibleMessages?.length) {
      return [];
    }
    const removedSet = new Set(removed);
    const removedVisible = session.visibleMessages.filter((message) => removedSet.has(message));
    session.visibleMessages = session.visibleMessages.filter(
      (message) => !removedSet.has(message),
    );
    return removedVisible;
  };

  // Find a safe trim boundary that does NOT orphan tool_call/tool_result pairs.
  // A safe boundary is a user message with plain string content (not a tool_result array)
  // that is NOT immediately preceded by an assistant message with tool_calls.
  let trimTo = 0;
  for (let i = overflow; i < session.messages.length; i++) {
    const msg = session.messages[i]!;

    // Must be a plain user message (string content, not tool_result array)
    if (msg.role !== "user") continue;
    if (typeof msg.content !== "string") continue;

    // Check the previous message — if it's an assistant with tool_calls,
    // this user message might be a tool_result response (content mismatch
    // but we need to be safe). Only trim if the previous is NOT a tool_call.
    if (i > 0) {
      const prev = session.messages[i - 1]!;
      if (prev.role === "assistant" && (prev as AssistantMessage).tool_calls?.length) {
        continue; // Skip — trimming here would orphan the tool_calls
      }
    }

    trimTo = i;
    break;
  }

  if (trimTo > 0) {
    return trimMessages(trimTo);
  }

  // Fallback: if no safe boundary found and session exceeds hard cap (2x max),
  // force trim at the oldest complete tool pair boundary to prevent unbounded growth
  const hardCap = maxMessages * 2;
  if (session.messages.length > hardCap) {
    getLogger().warn("Session exceeds hard cap, force-trimming", {
      size: session.messages.length,
      hardCap,
    });
    // Find the first complete pair boundary (user message after a tool_result)
    for (let i = 1; i < overflow; i++) {
      const msg = session.messages[i]!;
      const prev = session.messages[i - 1]!;
      if (msg.role === "user" && prev.role === "user") {
        return trimMessages(i);
      }
    }
    // Last resort: trim at overflow, accepting potential orphaning
    return trimMessages(overflow);
  }

  return [];
}

/**
 * Persist conversation messages to memory so the agent remembers them next session.
 * Debounced by default — pass `force: true` for trim evictions and session cleanup.
 */
export async function persistSessionToMemory(
  ctx: SessionPersistenceContext,
  chatId: string,
  messages: ConversationMessage[],
  force = false,
): Promise<void> {
  if (!ctx.memoryManager) return;
  if (messages.length < 2) return;

  if (!force) {
    const now = Date.now();
    const lastTime = ctx.lastPersistTime.get(chatId) ?? 0;
    if (now - lastTime < ctx.persistDebounceMs) return;
    ctx.lastPersistTime.set(chatId, now);
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
      // Sanitize before persisting — strip any leaked API keys/secrets
      const sanitized = redactSensitiveText(summary);
      // Extract first user message and last assistant message for structured storage
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
      const result = await ctx.memoryManager.storeConversation(chatId as ChatId, sanitized, {
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

export function persistExecutionMemory(
  ctx: SessionPersistenceContext,
  scopeKey: string,
  executionJournal: ExecutionJournal,
): void {
  if (!ctx.taskExecutionStore) {
    return;
  }
  try {
    ctx.taskExecutionStore.updateExecutionSnapshot(scopeKey, executionJournal.snapshot());
  } catch (error) {
    getLogger().warn("Execution memory persistence failed", {
      scopeKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Create a MemoryRefresher if re-retrieval is enabled, seeded with initial content hashes.
 * Returns null when re-retrieval is disabled.
 */
export function createMemoryRefresher(
  ctx: SessionPersistenceContext,
  initialContentHashes: string[],
): MemoryRefresher | null {
  if (!ctx.reRetrievalConfig?.enabled) return null;
  const refresher = new MemoryRefresher(ctx.reRetrievalConfig, {
    memoryManager: ctx.memoryManager,
    ragPipeline: ctx.ragPipeline,
    instinctRetriever: ctx.instinctRetriever ?? undefined,
    embeddingProvider: ctx.embeddingProvider,
    eventBus: ctx.eventEmitter ?? undefined,
  });
  if (initialContentHashes.length > 0) {
    refresher.seedContentHashes(initialContentHashes);
  }
  return refresher;
}

export function takePendingResumeTrees(
  ctx: SessionPersistenceContext,
  conversationScope: string,
  chatId: string,
): GoalTree[] {
  const scoped = ctx.pendingResumeTrees.get(conversationScope);
  if (scoped && scoped.length > 0) {
    ctx.pendingResumeTrees.delete(conversationScope);
    return scoped;
  }

  if (conversationScope !== chatId) {
    const legacyChatScoped = ctx.pendingResumeTrees.get(chatId);
    if (legacyChatScoped && legacyChatScoped.length > 0) {
      ctx.pendingResumeTrees.delete(chatId);
      return legacyChatScoped;
    }
  }

  return [];
}

export function extractLastUserMessage(session: Session): string {
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

export function ensureVisibleMessages(session: Session): ConversationMessage[] {
  if (!session.visibleMessages) {
    session.visibleMessages = [];
  }
  return session.visibleMessages;
}

export function getVisibleTranscript(session: Session): ConversationMessage[] {
  return ensureVisibleMessages(session);
}

export function appendVisibleUserMessage(
  session: Session,
  content: string | MessageContent[],
): void {
  const message: ConversationMessage = { role: "user", content };
  session.messages.push(message);
  ensureVisibleMessages(session).push(message);
}

export function appendVisibleAssistantMessage(session: Session, content: string): void {
  const message: ConversationMessage = { role: "assistant", content };
  session.messages.push(message);
  ensureVisibleMessages(session).push(message);
}

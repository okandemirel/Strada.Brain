/**
 * SessionManager — encapsulates all session lifecycle, visible-transcript,
 * and persistence logic previously spread across orchestrator.ts and
 * orchestrator-session-persistence.ts.
 *
 * Pure refactor: every method is copied verbatim from its source, with only
 * `ctx.X` → `this.X` / `this.deps.X` adaptations.
 */

import type { ConversationMessage } from "./providers/provider.interface.js";
import type {
  MessageContent,
  AssistantMessage,
} from "./providers/provider-core.interface.js";
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
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MemoryRefresher } from "./memory-refresher.js";
import { redactSensitiveText } from "./orchestrator-text-utils.js";
import { stripInternalDecisionMarkers } from "./orchestrator-supervisor-routing.js";
import { getLogger } from "../utils/logger.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_SESSIONS = 100;

const LOW_SIGNAL_EXECUTION_ACK_RE =
  /^(?:adjusted|done|ok(?:ay)?|noted|ack(?:nowledged)?|revised|updated|handled|understood|fixed)\.?$/iu;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Session {
  messages: ConversationMessage[];
  visibleMessages?: ConversationMessage[];
  lastActivity: Date;
  conversationScope?: string;
  profileKey?: string;
  mixedParticipants?: boolean;
  postSetupBootstrapDelivered?: boolean;
  lastJournalSnapshot?: import("./autonomy/execution-journal.js").ExecutionJournalSnapshot;
}

/**
 * Narrow dependency interface for SessionManager — carries only the external
 * collaborators it actually needs.
 */
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
  readonly sessionsDir?: string;
}

// ─── SessionManager ──────────────────────────────────────────────────────────

export class SessionManager {
  /** Minimum interval between debounced memory persists per chat (5s). */
  private static readonly PERSIST_DEBOUNCE_MS = 5_000;
  private static readonly MAX_PERSISTED_MESSAGES = 50;
  private static readonly SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

  readonly sessions = new Map<string, Session>();
  readonly sessionLocks = new Map<string, Promise<void>>();
  private readonly lastPersistTime = new Map<string, number>();
  private readonly deps: SessionManagerDeps;

  constructor(deps: SessionManagerDeps) {
    this.deps = deps;
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  static serializeSession(session: Session): string {
    const messages = session.messages.slice(-SessionManager.MAX_PERSISTED_MESSAGES);
    return JSON.stringify({
      messages,
      lastActivity: session.lastActivity.toISOString(),
      conversationScope: session.conversationScope,
      profileKey: session.profileKey,
      lastJournalSnapshot: session.lastJournalSnapshot,
    });
  }

  static deserializeSession(json: string): Session | null {
    try {
      const data = JSON.parse(json);
      const lastActivity = new Date(data.lastActivity);
      if (Date.now() - lastActivity.getTime() > SessionManager.SESSION_EXPIRY_MS) {
        return null; // expired
      }
      // Validate message structure to prevent injection via tampered session files
      const rawMessages = Array.isArray(data.messages) ? data.messages : [];
      const messages = rawMessages.filter(
        (m: unknown): m is ConversationMessage =>
          typeof m === "object" && m !== null &&
          "role" in m &&
          ((m as Record<string, unknown>).role === "user" || (m as Record<string, unknown>).role === "assistant") &&
          "content" in m &&
          (typeof (m as Record<string, unknown>).content === "string" ||
           (m as Record<string, unknown>).content === null ||
           Array.isArray((m as Record<string, unknown>).content)),
      );
      return {
        messages,
        visibleMessages: [],
        lastActivity,
        conversationScope: data.conversationScope,
        profileKey: data.profileKey,
        lastJournalSnapshot: data.lastJournalSnapshot,
      };
    } catch {
      return null;
    }
  }

  // ── Disk persistence ──────────────────────────────────────────────────────

  private sessionFilePath(chatId: string): string {
    const safeName = chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.deps.sessionsDir!, `${safeName}.json`);
  }

  private async persistSessionToDisk(chatId: string, session: Session): Promise<void> {
    const dir = this.deps.sessionsDir;
    if (!dir) return;
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }
    await writeFile(this.sessionFilePath(chatId), SessionManager.serializeSession(session), { encoding: "utf-8", mode: 0o600 });
  }

  private static readonly MAX_SESSION_FILE_BYTES = 512 * 1024; // 512KB safety cap

  private restoreSessionFromDisk(chatId: string): Session | null {
    if (!this.deps.sessionsDir) return null;
    try {
      const filePath = this.sessionFilePath(chatId);
      if (!existsSync(filePath)) return null;
      const stat = statSync(filePath);
      if (stat.size > SessionManager.MAX_SESSION_FILE_BYTES) {
        getLogger().warn("Session file too large, skipping restore", { chatId, size: stat.size });
        return null;
      }
      const json = readFileSync(filePath, "utf-8");
      return SessionManager.deserializeSession(json);
    } catch {
      return null;
    }
  }

  /**
   * Delete session files older than SESSION_EXPIRY_MS.
   * Call periodically (e.g., on startup) to prevent disk accumulation.
   */
  cleanupStaleSessions(): void {
    const dir = this.deps.sessionsDir;
    if (!dir || !existsSync(dir)) return;
    try {
      const { readdirSync, unlinkSync } = require("node:fs") as typeof import("node:fs");
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".json")) continue;
        try {
          const filePath = join(dir, file);
          const stat = statSync(filePath);
          if (Date.now() - stat.mtimeMs > SessionManager.SESSION_EXPIRY_MS) {
            unlinkSync(filePath);
          }
        } catch { /* skip individual file errors */ }
      }
    } catch {
      getLogger().debug("Session cleanup failed", { dir });
    }
  }

  // ── Accessor ─────────────────────────────────────────────────────────────

  /**
   * Expose lastPersistTime for the orchestrator's profile-touch debouncing.
   */
  get persistTimeMap(): Map<string, number> {
    return this.lastPersistTime;
  }

  // ── Session lifecycle ────────────────────────────────────────────────────

  getOrCreateSession(chatId: string): Session {
    let session = this.sessions.get(chatId);
    if (session) {
      // Move to end for LRU ordering (Map preserves insertion order)
      this.sessions.delete(chatId);
      this.sessions.set(chatId, session);
      return session;
    }

    // Try disk restore before creating fresh session
    if (this.deps.sessionsDir) {
      const restored = this.restoreSessionFromDisk(chatId);
      if (restored) {
        this.sessions.set(chatId, restored);
        return restored;
      }
    }

    // Evict oldest session if at capacity
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

  /**
   * Trim session history to keep context manageable.
   * Trims at safe boundaries to avoid orphaning tool_use/tool_result pairs.
   * Returns the trimmed (removed) messages for persistence.
   */
  trimSession(session: Session, maxMessages: number): ConversationMessage[] {
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

  // ── Visible transcript helpers ───────────────────────────────────────────

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

  // ── Send + record helpers ───────────────────────────────────────────────

  async sendVisibleAssistantText(
    chatId: string,
    session: Session,
    content: string,
  ): Promise<void> {
    this.appendVisibleAssistantMessage(session, content);
    await this.deps.channel.sendText(chatId, content);
  }

  async sendVisibleAssistantMarkdown(
    chatId: string,
    session: Session,
    content: string,
  ): Promise<void> {
    this.appendVisibleAssistantMessage(session, content);
    await this.deps.channel.sendMarkdown(chatId, content);
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  /**
   * Persist conversation messages to memory so the agent remembers them next session.
   * Debounced by default — pass `force: true` for trim evictions and session cleanup.
   */
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
        const result = await this.deps.memoryManager.storeConversation(
          chatId as ChatId,
          sanitized,
          {
            userMessage: extractText(userMsg),
            assistantMessage: extractText(assistantMsg),
          },
        );
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

    // Fire-and-forget disk persistence
    if (this.deps.sessionsDir) {
      const sessionForDisk = this.sessions.get(chatId);
      if (sessionForDisk) {
        this.persistSessionToDisk(chatId, sessionForDisk).catch((err) => {
          getLogger().debug("Session disk persist failed", {
            chatId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
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

  /**
   * Create a MemoryRefresher if re-retrieval is enabled, seeded with initial content hashes.
   * Returns null when re-retrieval is disabled.
   */
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

  // ── Plan review / write-rejection visible text ──────────────────────────

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
        const block = message.content[blockIndex];
        if (!block || block.type !== "tool_result" || typeof block.content !== "string") {
          continue;
        }
        if (!block.content.startsWith("Self-managed write review rejected")) {
          continue;
        }

        const match = block.content.match(
          /for '([^']+)':\s*(.+?)\.\s*Choose a safer bounded operation/iu,
        );
        const toolName = match?.[1] ?? "write-capable action";
        const reason = match?.[2]?.trim() ?? block.content.trim();
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

  // ── Cleanup ──────────────────────────────────────────────────────────────

  /**
   * Clean up expired sessions (call periodically).
   */
  cleanupSessions(maxAgeMs: number = 3600_000): void {
    const now = Date.now();
    for (const [chatId, session] of this.sessions) {
      if (now - session.lastActivity.getTime() > maxAgeMs) {
        // Skip sessions with active locks — they are currently being processed
        if (this.sessionLocks.has(chatId)) continue;

        // Session-end summarization (fire-and-forget)
        const visibleMessages = this.getVisibleTranscript(session);
        if (this.deps.sessionSummarizer && visibleMessages.length >= 2) {
          void this.deps.sessionSummarizer
            .summarizeAndUpdateProfile(session.profileKey ?? chatId, visibleMessages)
            .catch(() => {
              // Session summarization failure is non-fatal
            });
        }
        // Persist before cleanup (forced — session is being evicted)
        void this.persistSessionToMemory(chatId, visibleMessages.slice(-10), /* force */ true);
        this.lastPersistTime.delete(chatId);
        this.sessions.delete(chatId);
        this.deps.activeGoalTrees.delete(session.conversationScope ?? chatId);
      }
    }
  }
}

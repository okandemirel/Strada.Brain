import type { IAIProvider, ConversationMessage, ToolCall, ToolResult } from "./providers/provider.interface.js";
import type { ITool, ToolContext } from "./tools/tool.interface.js";
import type { IChannelAdapter, IncomingMessage } from "../channels/channel.interface.js";
import type { IMemoryManager } from "../memory/memory.interface.js";
import type { MetricsCollector } from "../dashboard/metrics.js";
import { STRATA_SYSTEM_PROMPT, buildProjectContext, buildAnalysisSummary } from "./context/strata-knowledge.js";
import { getLogger } from "../utils/logger.js";

const MAX_TOOL_ITERATIONS = 15;
const TYPING_INTERVAL_MS = 4000;
const MAX_SESSIONS = 100;
const MAX_TOOL_RESULT_LENGTH = 8192;
const API_KEY_PATTERN = /(?:sk-|key-|token-|api[_-]?key[=: ]+)[a-zA-Z0-9_-]{10,}/gi;

interface Session {
  messages: ConversationMessage[];
  lastActivity: Date;
}

/**
 * The AI Agent Orchestrator - the "brain" of Strata Brain.
 *
 * Implements the core agent loop:
 *   User message → LLM → Tool calls → LLM → ... → Final response
 *
 * Manages conversation sessions per chat and routes tool calls.
 */
export class Orchestrator {
  private readonly provider: IAIProvider;
  private readonly tools: Map<string, ITool>;
  private readonly toolDefinitions: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }>;
  private readonly channel: IChannelAdapter;
  private readonly projectPath: string;
  private readonly readOnly: boolean;
  private readonly requireConfirmation: boolean;
  private readonly memoryManager?: IMemoryManager;
  private readonly metrics?: MetricsCollector;
  private readonly sessions = new Map<string, Session>();
  private readonly sessionLocks = new Map<string, Promise<void>>();
  private readonly systemPrompt: string;

  constructor(opts: {
    provider: IAIProvider;
    tools: ITool[];
    channel: IChannelAdapter;
    projectPath: string;
    readOnly: boolean;
    requireConfirmation: boolean;
    memoryManager?: IMemoryManager;
    metrics?: MetricsCollector;
  }) {
    this.provider = opts.provider;
    this.channel = opts.channel;
    this.projectPath = opts.projectPath;
    this.readOnly = opts.readOnly;
    this.requireConfirmation = opts.requireConfirmation;
    this.memoryManager = opts.memoryManager;
    this.metrics = opts.metrics;

    // Build tool registry
    this.tools = new Map();
    this.toolDefinitions = [];
    for (const tool of opts.tools) {
      this.tools.set(tool.name, tool);
      this.toolDefinitions.push({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      });
    }

    this.systemPrompt =
      STRATA_SYSTEM_PROMPT + buildProjectContext(this.projectPath);
  }

  /**
   * Handle an incoming message from any channel.
   * Uses a per-session lock to prevent concurrent processing.
   */
  async handleMessage(msg: IncomingMessage): Promise<void> {
    const { chatId } = msg;

    // Per-session concurrency lock: queue messages for the same chat
    const prev = this.sessionLocks.get(chatId) ?? Promise.resolve();
    const current = prev.then(() => this.processMessage(msg));
    this.sessionLocks.set(chatId, current.catch(() => {}));
    await current;
  }

  private async processMessage(msg: IncomingMessage): Promise<void> {
    const logger = getLogger();
    const { chatId, text, userId } = msg;

    logger.info("Processing message", {
      chatId,
      userId,
      textLength: text.length,
      channel: msg.channelType,
    });
    this.metrics?.recordMessage();
    this.metrics?.setActiveSessions(this.sessions.size);

    // Get or create session
    const session = this.getOrCreateSession(chatId);
    session.lastActivity = new Date();

    // Add user message
    session.messages.push({ role: "user", content: text });

    // Trim old messages to manage context window
    // Persist trimmed messages to memory before discarding
    const trimmed = this.trimSession(session, 40);
    if (trimmed.length > 0 && this.memoryManager) {
      const summary = trimmed
        .filter((m) => m.content && !m.toolResults?.length)
        .map((m) => `[${m.role}] ${m.content}`)
        .join("\n");
      if (summary) {
        await this.memoryManager.storeConversation(chatId, summary);
      }
    }

    // Start typing indicator loop
    const typingInterval = setInterval(() => {
      this.channel.sendTypingIndicator(chatId).catch(() => {});
    }, TYPING_INTERVAL_MS);

    try {
      await this.runAgentLoop(chatId, session);
    } catch (error) {
      const errMsg =
        error instanceof Error ? error.message : "Unknown error";
      logger.error("Agent loop error", { chatId, error: errMsg });
      // M2: Don't leak internal details to users
      await this.channel.sendText(
        chatId,
        "An error occurred while processing your request. Please try again."
      );
    } finally {
      clearInterval(typingInterval);
    }
  }

  /**
   * The core agent loop: LLM → Tool calls → LLM → ... → Response
   */
  private async runAgentLoop(
    chatId: string,
    session: Session
  ): Promise<void> {
    const logger = getLogger();

    // Retrieve relevant memory context for the first iteration
    let systemPrompt = this.systemPrompt;
    if (this.memoryManager && session.messages.length > 0) {
      const lastUserMsg = [...session.messages]
        .reverse()
        .find((m) => m.role === "user" && m.content);
      if (lastUserMsg) {
        try {
          const memories = await this.memoryManager.retrieve(lastUserMsg.content, {
            limit: 3,
            minScore: 0.15,
          });
          if (memories.length > 0) {
            const memoryContext = memories
              .map((m) => m.entry.content)
              .join("\n---\n");
            systemPrompt += `\n\n## Relevant Memory\n${memoryContext}\n`;
            logger.debug("Injected memory context", {
              chatId,
              memoryCount: memories.length,
              topScore: memories[0]!.score.toFixed(3),
            });
          }
        } catch {
          // Memory retrieval failure is non-fatal
        }
      }

      // Inject cached analysis summary into system prompt
      try {
        const analysis = await this.memoryManager.getCachedAnalysis(this.projectPath);
        if (analysis) {
          systemPrompt += buildAnalysisSummary(analysis);
        }
      } catch {
        // Analysis cache failure is non-fatal
      }
    }

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const response = await this.provider.chat(
        systemPrompt,
        session.messages,
        this.toolDefinitions
      );

      logger.debug("LLM response", {
        chatId,
        iteration,
        stopReason: response.stopReason,
        toolCallCount: response.toolCalls.length,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      });
      this.metrics?.recordTokenUsage(
        response.usage.inputTokens,
        response.usage.outputTokens,
        this.provider.name
      );

      // If no tool calls, send the final text response
      if (
        response.stopReason === "end_turn" ||
        response.toolCalls.length === 0
      ) {
        if (response.text) {
          session.messages.push({
            role: "assistant",
            content: response.text,
          });
          await this.channel.sendMarkdown(chatId, response.text);
        }
        return;
      }

      // Handle tool calls
      // First, add the assistant message with tool calls
      session.messages.push({
        role: "assistant",
        content: response.text,
        toolCalls: response.toolCalls,
      });

      // If there's intermediate text, send it
      if (response.text) {
        await this.channel.sendMarkdown(chatId, response.text);
      }

      // Execute all tool calls
      const toolResults = await this.executeToolCalls(
        chatId,
        response.toolCalls
      );

      // Add tool results as a user message
      session.messages.push({
        role: "user",
        content: "",
        toolResults,
      });
    }

    // Hit max iterations
    await this.channel.sendText(
      chatId,
      "I've reached the maximum number of steps for this request. " +
        "Please send a follow-up message to continue."
    );
  }

  /**
   * Execute tool calls, handling confirmations for write operations.
   */
  private async executeToolCalls(
    chatId: string,
    toolCalls: ToolCall[]
  ): Promise<ToolResult[]> {
    const logger = getLogger();
    const results: ToolResult[] = [];

    const toolContext: ToolContext = {
      projectPath: this.projectPath,
      workingDirectory: this.projectPath,
      readOnly: this.readOnly,
    };

    for (const tc of toolCalls) {
      const tool = this.tools.get(tc.name);
      if (!tool) {
        results.push({
          toolCallId: tc.id,
          content: `Error: unknown tool '${tc.name}'`,
          isError: true,
        });
        continue;
      }

      logger.debug("Executing tool", {
        chatId,
        tool: tc.name,
        input: tc.input,
      });

      // Confirmation flow for write operations
      if (this.requireConfirmation && this.isWriteOperation(tc.name)) {
        const confirmed = await this.requestWriteConfirmation(
          chatId,
          tc.name,
          tc.input
        );
        if (!confirmed) {
          results.push({
            toolCallId: tc.id,
            content: "Operation cancelled by user.",
            isError: false,
          });
          continue;
        }
      }

      const toolStart = Date.now();
      try {
        const result = await tool.execute(tc.input, toolContext);
        this.metrics?.recordToolCall(tc.name, Date.now() - toolStart, !result.isError);
        results.push({
          toolCallId: tc.id,
          content: sanitizeToolResult(result.content),
          isError: result.isError,
        });
      } catch (error) {
        this.metrics?.recordToolCall(tc.name, Date.now() - toolStart, false);
        const errMsg =
          error instanceof Error ? error.message : "Unknown error";
        logger.error("Tool execution error", {
          tool: tc.name,
          error: errMsg,
        });
        results.push({
          toolCallId: tc.id,
          content: "Tool execution failed",
          isError: true,
        });
      }
    }

    return results;
  }

  private isWriteOperation(toolName: string): boolean {
    return (
      toolName === "file_write" ||
      toolName === "file_edit" ||
      toolName === "strata_create_module" ||
      toolName === "strata_create_component" ||
      toolName === "strata_create_mediator" ||
      toolName === "strata_create_system"
    );
  }

  private async requestWriteConfirmation(
    chatId: string,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<boolean> {
    const path = String(input["path"] ?? "unknown");
    const action =
      toolName === "file_write" ? "create/overwrite" : "edit";

    const response = await this.channel.requestConfirmation({
      chatId,
      question: `Confirm file ${action}: \`${path}\`?`,
      options: ["Yes", "No"],
      details:
        toolName === "file_edit"
          ? `Replacing text in ${path}`
          : `Writing to ${path}`,
    });

    return response === "Yes";
  }

  private getOrCreateSession(chatId: string): Session {
    let session = this.sessions.get(chatId);
    if (session) {
      // Move to end for LRU ordering (Map preserves insertion order)
      this.sessions.delete(chatId);
      this.sessions.set(chatId, session);
      return session;
    }

    // Evict oldest session if at capacity
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldestKey = this.sessions.keys().next().value as string;
      this.sessions.delete(oldestKey);
      this.sessionLocks.delete(oldestKey);
    }

    session = { messages: [], lastActivity: new Date() };
    this.sessions.set(chatId, session);
    return session;
  }

  /**
   * Trim session history to keep context manageable.
   * Trims at safe boundaries to avoid orphaning tool_use/tool_result pairs.
   * Returns the trimmed (removed) messages for persistence.
   */
  private trimSession(session: Session, maxMessages: number): ConversationMessage[] {
    if (session.messages.length <= maxMessages) return [];

    const overflow = session.messages.length - maxMessages;

    // Find the first safe trim boundary: a user message that has no toolResults
    // (i.e., a plain text message, not a tool_result response).
    let trimTo = overflow;
    for (let i = overflow; i < session.messages.length; i++) {
      const msg = session.messages[i]!;
      if (msg.role === "user" && !msg.toolResults?.length) {
        trimTo = i;
        break;
      }
    }

    if (trimTo > 0) {
      return session.messages.splice(0, trimTo);
    }
    return [];
  }

  /**
   * Clean up expired sessions (call periodically).
   */
  cleanupSessions(maxAgeMs: number = 3600_000): void {
    const now = Date.now();
    for (const [chatId, session] of this.sessions) {
      if (now - session.lastActivity.getTime() > maxAgeMs) {
        this.sessions.delete(chatId);
        this.sessionLocks.delete(chatId);
      }
    }
  }
}

/**
 * Sanitize tool results before feeding back to LLM.
 * Caps length and strips potential API key patterns.
 */
function sanitizeToolResult(content: string): string {
  let result = content;

  // Strip API key patterns
  result = result.replace(API_KEY_PATTERN, "[REDACTED]");

  // Cap length
  if (result.length > MAX_TOOL_RESULT_LENGTH) {
    result = result.substring(0, MAX_TOOL_RESULT_LENGTH) + "\n... (truncated)";
  }

  return result;
}

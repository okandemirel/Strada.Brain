import type {
  IAIProvider,
  ConversationMessage,
  ToolCall,
  ToolResult,
  ProviderResponse,
  IStreamingProvider,
} from "./providers/provider.interface.js";
import type { ProviderManager } from "./providers/provider-manager.js";
import type { ITool, ToolContext } from "./tools/tool.interface.js";
import type { IChannelAdapter, IncomingMessage } from "../channels/channel.interface.js";
import { supportsRichMessaging } from "../channels/channel.interface.js";
import type { IMemoryManager } from "../memory/memory.interface.js";
import { isOk, isSome } from "../types/index.js";
import type { ChatId } from "../types/index.js";
import type { MetricsCollector } from "../dashboard/metrics.js";
import {
  STRATA_SYSTEM_PROMPT,
  buildProjectContext,
  buildAnalysisSummary,
  buildDepsContext,
} from "./context/strata-knowledge.js";
import type { StradaDepsStatus } from "../config/strada-deps.js";
import { checkStradaDeps, installStradaDep } from "../config/strada-deps.js";
import type { IRAGPipeline } from "../rag/rag.interface.js";
import type { RateLimiter } from "../security/rate-limiter.js";
import { getLogger } from "../utils/logger.js";
import { AgentPhase, createInitialState, transitionPhase, type AgentState, type StepResult } from "./agent-state.js";
import { buildPlanningPrompt, buildReflectionPrompt, buildReplanningPrompt, buildExecutionContext } from "./paor-prompts.js";
import type { InstinctRetriever } from "./instinct-retriever.js";
import { shouldForceReplan } from "./failure-classifier.js";
import { ErrorRecoveryEngine, TaskPlanner, SelfVerification } from "./autonomy/index.js";
import { WRITE_OPERATIONS } from "./autonomy/constants.js";
import type { BackgroundTaskOptions } from "../tasks/types.js";
import type { IEventEmitter, LearningEventMap } from "../core/event-bus.js";
import type { MetricsRecorder } from "../metrics/metrics-recorder.js";

const MAX_TOOL_ITERATIONS = 50;
const TYPING_INTERVAL_MS = 4000;
const MAX_SESSIONS = 100;
const MAX_TOOL_RESULT_LENGTH = 8192;
const STREAM_THROTTLE_MS = 500; // Throttle streaming updates to channels
const API_KEY_PATTERN =
  /(?:sk-|key-|token-|api[_-]?key[=: ]+|ghp_|gho_|ghu_|ghs_|ghr_|xox[bpas]-|Bearer\s+)[a-zA-Z0-9_\-.]{10,}/gi;

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
  private readonly providerManager: ProviderManager;
  private readonly tools: Map<string, ITool>;
  private readonly toolDefinitions: Array<{
    name: string;
    description: string;
    input_schema: import("../types/index.js").JsonObject;
  }>;
  private readonly channel: IChannelAdapter;
  private readonly projectPath: string;
  private readonly readOnly: boolean;
  private readonly requireConfirmation: boolean;
  private readonly memoryManager?: IMemoryManager;
  private readonly metrics?: MetricsCollector;
  private readonly ragPipeline?: IRAGPipeline;
  private readonly rateLimiter?: RateLimiter;
  private readonly streamingEnabled: boolean;
  private readonly sessions = new Map<string, Session>();
  private readonly sessionLocks = new Map<string, Promise<void>>();
  private systemPrompt: string;
  private stradaDeps: StradaDepsStatus | undefined;
  private depsSetupComplete: boolean = false;
  private pendingDepsPrompt: boolean = false;
  private pendingModulesPrompt: boolean = false;
  private readonly instinctRetriever: InstinctRetriever | null;
  private readonly eventEmitter: IEventEmitter<LearningEventMap> | null;
  private readonly metricsRecorder: MetricsRecorder | null;

  constructor(opts: {
    providerManager: ProviderManager;
    tools: ITool[];
    channel: IChannelAdapter;
    projectPath: string;
    readOnly: boolean;
    requireConfirmation: boolean;
    memoryManager?: IMemoryManager;
    metrics?: MetricsCollector;
    ragPipeline?: IRAGPipeline;
    rateLimiter?: RateLimiter;
    streamingEnabled?: boolean;
    stradaDeps?: StradaDepsStatus;
    instinctRetriever?: InstinctRetriever;
    eventEmitter?: IEventEmitter<LearningEventMap>;
    metricsRecorder?: MetricsRecorder;
  }) {
    this.providerManager = opts.providerManager;
    this.channel = opts.channel;
    this.projectPath = opts.projectPath;
    this.readOnly = opts.readOnly;
    this.requireConfirmation = opts.requireConfirmation;
    this.memoryManager = opts.memoryManager;
    this.metrics = opts.metrics;
    this.ragPipeline = opts.ragPipeline;
    this.rateLimiter = opts.rateLimiter;
    this.streamingEnabled = opts.streamingEnabled ?? false;
    this.instinctRetriever = opts.instinctRetriever ?? null;
    this.eventEmitter = opts.eventEmitter ?? null;
    this.metricsRecorder = opts.metricsRecorder ?? null;

    // Build tool registry
    this.tools = new Map();
    this.toolDefinitions = [];
    for (const tool of opts.tools) {
      this.tools.set(tool.name, tool);
      this.toolDefinitions.push({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as import("../types/index.js").JsonObject,
      });
    }

    this.stradaDeps = opts.stradaDeps;
    this.depsSetupComplete = !opts.stradaDeps || opts.stradaDeps.coreInstalled;
    this.systemPrompt =
      STRATA_SYSTEM_PROMPT +
      buildProjectContext(this.projectPath) +
      buildDepsContext(opts.stradaDeps);
  }

  /**
   * Handle an incoming message from any channel.
   * Uses a per-session lock to prevent concurrent processing.
   */
  async handleMessage(msg: IncomingMessage): Promise<void> {
    const { chatId } = msg;

    // Intercept messages if Strada.Core is missing and setup not complete
    if (!this.depsSetupComplete && this.stradaDeps && !this.stradaDeps.coreInstalled) {
      await this.handleDepsSetup(msg);
      return;
    }

    // Handle pending modules prompt after core installation
    if (this.pendingModulesPrompt) {
      await this.handleModulesPrompt(msg);
      return;
    }

    // Per-session concurrency lock: queue messages for the same chat
    const prev = this.sessionLocks.get(chatId) ?? Promise.resolve();
    const current = prev.then(() => this.processMessage(msg));
    this.sessionLocks.set(
      chatId,
      current.catch((err) => {
        getLogger().error("Session lock error", {
          chatId,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    );
    await current;
  }

  /**
   * Run a task in the background with abort support and progress reporting.
   * Used by the task system for async execution.
   */
  async runBackgroundTask(prompt: string, options: BackgroundTaskOptions): Promise<string> {
    const logger = getLogger();
    const { signal, onProgress, chatId } = options;
    const provider = this.providerManager.getProvider(chatId);

    // ─── Metrics: start recording ────────────────────────────────────
    const taskType = options.parentMetricId ? "subtask" as const : "background" as const;
    const metricId = this.metricsRecorder?.startTask({
      sessionId: chatId,
      taskDescription: prompt.slice(0, 200),
      taskType,
      parentTaskId: options.parentMetricId,
    });
    // ────────────────────────────────────────────────────────────────

    // Isolated session for this task
    const session: Session = {
      messages: [{ role: "user", content: prompt }],
      lastActivity: new Date(),
    };

    // Build system prompt with memory/RAG context
    let systemPrompt = this.systemPrompt;
    if (this.memoryManager) {
      try {
        const memoriesResult = await this.memoryManager.retrieve({
          mode: "text",
          query: prompt,
          limit: 3,
          minScore: 0.15,
        });
        if (isOk(memoriesResult)) {
          const memories = memoriesResult.value;
          if (memories.length > 0) {
            const memoryContext = memories.map((m) => m.entry.content).join("\n---\n");
            systemPrompt += `\n\n## Relevant Memory\n${memoryContext}\n`;
          }
        }
      } catch {
        // Memory retrieval failure is non-fatal
      }

      if (this.ragPipeline) {
        try {
          const ragResults = await this.ragPipeline.search(prompt, { topK: 6, minScore: 0.2 });
          if (ragResults.length > 0) {
            systemPrompt += this.ragPipeline.formatContext(ragResults);
          }
        } catch {
          // RAG failure is non-fatal
        }
      }

      try {
        const analysisResult = await this.memoryManager.getCachedAnalysis(this.projectPath);
        if (isOk(analysisResult)) {
          const analysisOpt = analysisResult.value;
          if (isSome(analysisOpt)) {
            systemPrompt += buildAnalysisSummary(analysisOpt.value);
          }
        }
      } catch {
        // Non-fatal
      }
    }

    // Autonomy layer
    const errorRecovery = new ErrorRecoveryEngine();
    const taskPlanner = new TaskPlanner();
    const selfVerification = new SelfVerification();
    systemPrompt += taskPlanner.getPlanningPrompt();
    let verificationRequested = false;

    let bgIteration = 0;
    let bgToolCallCount = 0;

    try {
      for (bgIteration = 0; bgIteration < MAX_TOOL_ITERATIONS; bgIteration++) {
        // Check cancellation
        if (signal.aborted) {
          throw new Error("Task cancelled");
        }

        const response = await provider.chat(
          systemPrompt,
          session.messages,
          this.toolDefinitions,
        );

        logger.debug("Background task LLM response", {
          chatId,
          iteration: bgIteration,
          stopReason: response.stopReason,
          toolCallCount: response.toolCalls.length,
        });
        this.metrics?.recordTokenUsage(
          response.usage.inputTokens,
          response.usage.outputTokens,
          provider.name,
        );
        this.rateLimiter?.recordTokenUsage(
          response.usage.inputTokens,
          response.usage.outputTokens,
          provider.name,
        );

        // Final response — return text
        if (response.stopReason === "end_turn" || response.toolCalls.length === 0) {
          if (!verificationRequested && selfVerification.needsVerification()) {
            verificationRequested = true;
            if (response.text) {
              session.messages.push({ role: "assistant", content: response.text });
            }
            session.messages.push({ role: "user", content: selfVerification.getPrompt() });
            continue;
          }

          if (response.text) {
            session.messages.push({ role: "assistant", content: response.text });
          }

          // ─── Metrics: record success ────────────────────────────────
          if (metricId) {
            this.metricsRecorder?.endTask(metricId, {
              agentPhase: AgentPhase.COMPLETE,
              iterations: bgIteration + 1,
              toolCallCount: bgToolCallCount,
              hitMaxIterations: false,
            });
          }
          // ────────────────────────────────────────────────────────────

          return response.text || "Task completed without output.";
        }

        // Handle tool calls
        session.messages.push({
          role: "assistant",
          content: response.text,
          tool_calls: response.toolCalls,
        });

        const toolResults = await this.executeToolCalls(chatId, response.toolCalls);
        bgToolCallCount += response.toolCalls.length;

        // Autonomy tracking
        for (let i = 0; i < response.toolCalls.length; i++) {
          const tc = response.toolCalls[i]!;
          const tr = toolResults[i]!;
          taskPlanner.trackToolCall(tc.name, tr.isError ?? false);
          selfVerification.track(tc.name, tc.input, tr);
          if (tc.name === "dotnet_build") verificationRequested = false;

          const analysis = errorRecovery.analyze(tc.name, tr);
          if (analysis) {
            taskPlanner.recordError(analysis.summary);
            toolResults[i] = {
              toolCallId: tr.toolCallId,
              content: sanitizeToolResult(tr.content + analysis.recoveryInjection),
              isError: tr.isError,
            };
          }

          this.emitToolResult(chatId, tc, toolResults[i]!);
        }

        // Progress report: summarize tool calls
        const toolNames = response.toolCalls.map((tc) => tc.name).join(", ");
        onProgress(`Running tools: ${toolNames}`);

        // Add tool results
        const stateCtx = taskPlanner.getStateInjection();
        const contentBlocks: Array<
          | { type: "text"; text: string }
          | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
        > = [];
        if (stateCtx) {
          contentBlocks.push({ type: "text" as const, text: stateCtx });
        }
        for (const tr of toolResults) {
          contentBlocks.push({
            type: "tool_result" as const,
            tool_use_id: tr.toolCallId,
            content: tr.content,
            is_error: tr.isError,
          });
        }
        session.messages.push({
          role: "user",
          content: contentBlocks.length === 1 && stateCtx ? stateCtx : contentBlocks,
        });
      }

      // ─── Metrics: record max iterations ──────────────────────────────
      if (metricId) {
        this.metricsRecorder?.endTask(metricId, {
          agentPhase: AgentPhase.EXECUTING,
          iterations: bgIteration,
          toolCallCount: bgToolCallCount,
          hitMaxIterations: true,
        });
      }
      // ────────────────────────────────────────────────────────────────

      return "Task reached maximum iterations. The work done so far has been saved.";
    } finally {
      // ─── Metrics: safety net for unexpected exits ────────────────────
      if (metricId && !this.metricsRecorder?.isRecorded(metricId)) {
        this.metricsRecorder?.endTask(metricId, {
          agentPhase: AgentPhase.FAILED,
          iterations: bgIteration,
          toolCallCount: bgToolCallCount,
          hitMaxIterations: false,
        });
      }
      // ────────────────────────────────────────────────────────────────
    }
  }

  /**
   * Handle the dependency setup flow when Strada.Core is missing.
   * Prompts the user on first message, processes their response on subsequent messages.
   */
  private async handleDepsSetup(msg: IncomingMessage): Promise<void> {
    const { chatId } = msg;
    const text = msg.text?.toLowerCase() ?? "";

    if (this.pendingDepsPrompt) {
      // User is responding to our install prompt
      if (text.includes("evet") || text.includes("yes") || text.includes("kur")) {
        await this.channel.sendText(chatId, "Strada.Core kuruluyor...");
        const result = await installStradaDep(this.projectPath, "core");
        if (result.kind === "ok") {
          this.stradaDeps = checkStradaDeps(this.projectPath);
          this.systemPrompt =
            STRATA_SYSTEM_PROMPT +
            buildProjectContext(this.projectPath) +
            buildDepsContext(this.stradaDeps);
          this.depsSetupComplete = true;
          await this.channel.sendText(chatId, "Strada.Core kuruldu! Artık kullanabilirsiniz.");

          if (!this.stradaDeps.modulesInstalled) {
            this.pendingModulesPrompt = true;
            await this.channel.sendText(
              chatId,
              "Strada.Modules da kurulu değil. Kurmamı ister misiniz? (evet/hayır)",
            );
            return;
          }
        } else {
          await this.channel.sendText(chatId, `Kurulum başarısız: ${result.error}`);
          this.depsSetupComplete = true;
        }
      } else {
        this.depsSetupComplete = true;
        await this.channel.sendText(
          chatId,
          "Anlaşıldı. Strada.Core olmadan sınırlı destek sunabilirim.",
        );
      }
      return;
    }

    // First message — send the install prompt
    this.pendingDepsPrompt = true;
    await this.channel.sendText(
      chatId,
      "⚠️ Strada.Core projenizde bulunamadı.\n\n" +
        `Proje: ${this.projectPath}\n` +
        "Arama yapılan konumlar: Packages/strada.core, Packages/com.strada.core, Packages/Strada.Core\n\n" +
        "Git submodule olarak kurmamı ister misiniz? (evet/hayır)",
    );
  }

  /**
   * Handle the optional Strada.Modules installation prompt.
   */
  private async handleModulesPrompt(msg: IncomingMessage): Promise<void> {
    const { chatId } = msg;
    const text = msg.text?.toLowerCase() ?? "";
    this.pendingModulesPrompt = false;

    if (text.includes("evet") || text.includes("yes") || text.includes("kur")) {
      await this.channel.sendText(chatId, "Strada.Modules kuruluyor...");
      const result = await installStradaDep(this.projectPath, "modules");
      if (result.kind === "ok") {
        this.stradaDeps = checkStradaDeps(this.projectPath);
        this.systemPrompt =
          STRATA_SYSTEM_PROMPT +
          buildProjectContext(this.projectPath) +
          buildDepsContext(this.stradaDeps);
        await this.channel.sendText(chatId, "Strada.Modules kuruldu!");
      } else {
        await this.channel.sendText(chatId, `Modules kurulumu başarısız: ${result.error}`);
      }
    } else {
      await this.channel.sendText(chatId, "Anlaşıldı. Strada.Modules olmadan devam ediyoruz.");
    }
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

    // Check rate limits before processing
    if (this.rateLimiter) {
      const rateCheck = this.rateLimiter.checkMessageRate(userId);
      if (!rateCheck.allowed) {
        logger.warn("Rate limited", { userId, reason: rateCheck.reason });
        const retryMsg = rateCheck.retryAfterMs
          ? ` Please try again in ${Math.ceil(rateCheck.retryAfterMs / 1000)} seconds.`
          : "";
        await this.channel.sendText(chatId, `${rateCheck.reason}${retryMsg}`);
        return;
      }
    }

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
        .filter((m) => {
          if (!m.content) return false;
          if (m.role === "assistant") return true;
          // For user messages, check if it's a tool result message (has MessageContent array)
          if (typeof m.content !== "string") return false;
          return true;
        })
        .map(
          (m) => `[${m.role}] ${typeof m.content === "string" ? m.content : "[complex content]"}`,
        )
        .join("\n");
      if (summary) {
        await this.memoryManager.storeConversation(chatId as ChatId, summary);
      }
    }

    // Start typing indicator loop
    const typingInterval = setInterval(() => {
      if (supportsRichMessaging(this.channel)) {
        this.channel.sendTypingIndicator(chatId as string).catch((err) =>
          getLogger().error("Failed to send typing indicator", {
            chatId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }, TYPING_INTERVAL_MS);

    try {
      await this.runAgentLoop(chatId, session);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Unknown error";
      logger.error("Agent loop error", { chatId, error: errMsg });
      // M2: Don't leak internal details to users
      await this.channel.sendText(
        chatId,
        "An error occurred while processing your request. Please try again.",
      );
    } finally {
      clearInterval(typingInterval);
    }
  }

  /**
   * The core agent loop: LLM → Tool calls → LLM → ... → Response
   */
  private async runAgentLoop(chatId: string, session: Session): Promise<void> {
    const logger = getLogger();
    const provider = this.providerManager.getProvider(chatId);

    // Retrieve relevant memory context for the first iteration
    let systemPrompt = this.systemPrompt;
    if (this.memoryManager && session.messages.length > 0) {
      const lastUserMsg = [...session.messages]
        .reverse()
        .find((m) => m.role === "user" && m.content);
      if (lastUserMsg && typeof lastUserMsg.content === "string") {
        try {
          const memoriesResult = await this.memoryManager.retrieve({
            mode: "text",
            query: lastUserMsg.content,
            limit: 3,
            minScore: 0.15,
          });
          if (isOk(memoriesResult)) {
            const memories = memoriesResult.value;
            if (memories.length > 0) {
              const memoryContext = memories.map((m) => m.entry.content).join("\n---\n");
              systemPrompt += `\n\n## Relevant Memory\n${memoryContext}\n`;
              logger.debug("Injected memory context", {
                chatId,
                memoryCount: memories.length,
                topScore: memories[0]!.score.toFixed(3),
              });
            }
          }
        } catch {
          // Memory retrieval failure is non-fatal
        }

        // Inject RAG code context
        if (this.ragPipeline && typeof lastUserMsg.content === "string") {
          try {
            const ragResults = await this.ragPipeline.search(lastUserMsg.content, {
              topK: 6,
              minScore: 0.2,
            });
            if (ragResults.length > 0) {
              systemPrompt += this.ragPipeline.formatContext(ragResults);
              logger.debug("Injected RAG context", {
                chatId,
                resultCount: ragResults.length,
                topScore: ragResults[0]!.finalScore.toFixed(3),
              });
            }
          } catch {
            // RAG failure is non-fatal
          }
        }
      }

      // Inject cached analysis summary into system prompt
      try {
        const analysisResult = await this.memoryManager.getCachedAnalysis(this.projectPath);
        if (isOk(analysisResult)) {
          const analysisOpt = analysisResult.value;
          if (isSome(analysisOpt)) {
            systemPrompt += buildAnalysisSummary(analysisOpt.value);
          }
        }
      } catch {
        // Analysis cache failure is non-fatal
      }
    }

    // ─── Autonomy layer ──────────────────────────────────────────────────
    const errorRecovery = new ErrorRecoveryEngine();
    const taskPlanner = new TaskPlanner();
    const selfVerification = new SelfVerification();
    systemPrompt += taskPlanner.getPlanningPrompt();
    let verificationRequested = false;
    // ────────────────────────────────────────────────────────────────────

    // ─── PAOR State Machine ──────────────────────────────────────────────
    const lastUserMessage = this.extractLastUserMessage(session);
    let agentState = createInitialState(lastUserMessage);

    let matchedInstinctIds: string[] = [];
    if (this.instinctRetriever) {
      try {
        const insightResult = await this.instinctRetriever.getInsightsForTask(lastUserMessage);
        agentState = { ...agentState, learnedInsights: insightResult.insights };
        matchedInstinctIds = insightResult.matchedInstinctIds;
      } catch {
        // Non-fatal
      }
    }

    // ─── Metrics: start recording ────────────────────────────────────
    const metricId = this.metricsRecorder?.startTask({
      sessionId: chatId,
      taskDescription: lastUserMessage.slice(0, 200),
      taskType: "interactive",
      instinctIds: matchedInstinctIds,
    });
    // ────────────────────────────────────────────────────────────────

    const REFLECT_INTERVAL = 3;
    // ────────────────────────────────────────────────────────────────────

    const canStream =
      this.streamingEnabled &&
      "chatStream" in provider &&
      typeof provider.chatStream === "function" &&
      "startStreamingMessage" in this.channel &&
      typeof this.channel.startStreamingMessage === "function";

    try {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      // ─── PAOR: Build phase-aware system prompt ──────────────────────
      let activePrompt = systemPrompt;
      switch (agentState.phase) {
        case AgentPhase.PLANNING:
          activePrompt += "\n\n" + buildPlanningPrompt(agentState.taskDescription, agentState.learnedInsights);
          break;
        case AgentPhase.EXECUTING:
          activePrompt += buildExecutionContext(agentState);
          break;
        case AgentPhase.REPLANNING:
          activePrompt += "\n\n" + buildReplanningPrompt(agentState);
          break;
      }
      // ────────────────────────────────────────────────────────────────

      let response;
      if (canStream) {
        response = await this.streamResponse(chatId, activePrompt, session, provider);
      } else {
        response = await provider.chat(activePrompt, session.messages, this.toolDefinitions);
      }

      logger.debug("LLM response", {
        chatId,
        iteration,
        stopReason: response.stopReason,
        toolCallCount: response.toolCalls.length,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        streamed: canStream,
      });
      this.metrics?.recordTokenUsage(
        response.usage.inputTokens,
        response.usage.outputTokens,
        provider.name,
      );
      this.rateLimiter?.recordTokenUsage(
        response.usage.inputTokens,
        response.usage.outputTokens,
        provider.name,
      );

      // ─── PAOR: Handle REFLECTING phase response ─────────────────────
      if (agentState.phase === AgentPhase.REFLECTING) {
        const decision = parseReflectionDecision(response.text);

        if (decision === "DONE") {
          if (response.text) {
            session.messages.push({ role: "assistant", content: response.text });
            if (!canStream) await this.channel.sendMarkdown(chatId, response.text);
          }
          // ─── Metrics: record DONE ───────────────────────────────────
          if (metricId) {
            this.metricsRecorder?.endTask(metricId, {
              agentPhase: AgentPhase.COMPLETE,
              iterations: agentState.iteration,
              toolCallCount: agentState.stepResults.length,
              hitMaxIterations: false,
            });
          }
          // ──────────────────────────────────────────────────────────
          return;
        }

        if (decision === "REPLAN") {
          agentState = {
            ...agentState,
            failedApproaches: [...agentState.failedApproaches, extractApproachSummary(agentState)],
            lastReflection: response.text ?? null,
            reflectionCount: agentState.reflectionCount + 1,
          };
          agentState = transitionPhase(agentState, AgentPhase.REPLANNING);
          if (response.text) {
            session.messages.push({ role: "assistant", content: response.text });
          }
          session.messages.push({ role: "user", content: "Please create a new plan." });
          continue;
        }

        // CONTINUE
        agentState = {
          ...agentState,
          reflectionCount: agentState.reflectionCount + 1,
          consecutiveErrors: 0,
        };
        agentState = transitionPhase(agentState, AgentPhase.EXECUTING);

        if (response.toolCalls.length === 0) {
          if (response.text) {
            session.messages.push({ role: "assistant", content: response.text });
          }
          session.messages.push({ role: "user", content: "Please continue." });
          continue;
        }
      }
      // ────────────────────────────────────────────────────────────────

      // If no tool calls, send the final text response
      // (streaming already sent it, so skip for streamed end_turn)
      if (response.stopReason === "end_turn" || response.toolCalls.length === 0) {
        // ─── Verification gate: catch unverified exits ──────────────────
        if (!verificationRequested && selfVerification.needsVerification()) {
          verificationRequested = true;
          if (response.text) {
            session.messages.push({ role: "assistant", content: response.text });
          }
          session.messages.push({
            role: "user",
            content: selfVerification.getPrompt(),
          });
          logger.debug("Verification gate triggered", { chatId, iteration });
          continue; // send back to LLM with verification reminder
        }
        // ────────────────────────────────────────────────────────────────

        if (response.text) {
          session.messages.push({
            role: "assistant",
            content: response.text,
          });
          // Only send via sendMarkdown if we didn't stream
          if (!canStream || response.toolCalls.length > 0) {
            await this.channel.sendMarkdown(chatId, response.text);
          }
        }
        // ─── Metrics: record end_turn ───────────────────────────────
        if (metricId) {
          this.metricsRecorder?.endTask(metricId, {
            agentPhase: agentState.phase,
            iterations: agentState.iteration,
            toolCallCount: agentState.stepResults.length,
            hitMaxIterations: false,
          });
        }
        // ──────────────────────────────────────────────────────────
        return;
      }

      // ─── PAOR: Phase transitions ────────────────────────────────────
      if (agentState.phase === AgentPhase.PLANNING) {
        agentState = { ...agentState, plan: response.text ?? null };
        agentState = transitionPhase(agentState, AgentPhase.EXECUTING);
      }
      if (agentState.phase === AgentPhase.REPLANNING) {
        agentState = { ...agentState, plan: response.text ?? null };
        agentState = transitionPhase(agentState, AgentPhase.EXECUTING);
      }
      // ────────────────────────────────────────────────────────────────

      // Handle tool calls
      // First, add the assistant message with tool calls
      session.messages.push({
        role: "assistant",
        content: response.text,
        tool_calls: response.toolCalls,
      });

      // If there's intermediate text and we didn't stream, send it
      if (response.text && !canStream) {
        await this.channel.sendMarkdown(chatId, response.text);
      }

      // Execute all tool calls
      const toolResults = await this.executeToolCalls(chatId, response.toolCalls);

      // ─── Autonomy: track + analyze results ─────────────────────────────
      for (let i = 0; i < response.toolCalls.length; i++) {
        const tc = response.toolCalls[i]!;
        const tr = toolResults[i]!;

        // O(1) tracking in planner & verifier
        taskPlanner.trackToolCall(tc.name, tr.isError ?? false);
        selfVerification.track(tc.name, tc.input, tr);

        // Reset verification gate after build attempt so it can re-fire on failure
        if (tc.name === "dotnet_build") {
          verificationRequested = false;
        }

        // Error recovery: analyze and enrich the tool result
        const analysis = errorRecovery.analyze(tc.name, tr);
        if (analysis) {
          taskPlanner.recordError(analysis.summary);
          // Re-sanitize after appending (prevents API key leakage + enforces length cap)
          // Create new result with sanitized content (ToolResult is immutable)
          toolResults[i] = {
            toolCallId: tr.toolCallId,
            content: sanitizeToolResult(tr.content + analysis.recoveryInjection),
            isError: tr.isError,
          };
        }

        this.emitToolResult(chatId, tc, toolResults[i]!);
      }

      // Inject state-aware context (stall detection, budget warnings)
      const stateCtx = taskPlanner.getStateInjection();
      // ────────────────────────────────────────────────────────────────────

      // ─── PAOR: Record step results ──────────────────────────────────
      for (let i = 0; i < response.toolCalls.length; i++) {
        const tc = response.toolCalls[i]!;
        const tr = toolResults[i]!;
        const stepResult: StepResult = {
          toolName: tc.name,
          success: !(tr.isError ?? false),
          summary: tr.content.slice(0, 200),
          timestamp: Date.now(),
        };
        agentState = {
          ...agentState,
          stepResults: [...agentState.stepResults, stepResult],
          iteration: agentState.iteration + 1,
          consecutiveErrors: tr.isError ? agentState.consecutiveErrors + 1 : 0,
        };
      }

      const hasErrors = toolResults.some(tr => tr.isError);
      const failedSteps = agentState.stepResults.filter(s => !s.success);
      const shouldReflect =
        hasErrors ||
        (agentState.stepResults.length > 0 && agentState.stepResults.length % REFLECT_INTERVAL === 0) ||
        shouldForceReplan(failedSteps);

      if (shouldReflect && agentState.phase === AgentPhase.EXECUTING) {
        agentState = transitionPhase(agentState, AgentPhase.REFLECTING);
      }
      // ────────────────────────────────────────────────────────────────

      // Add tool results as a user message
      // Build content blocks for tool results
      const contentBlocks: Array<
        | { type: "text"; text: string }
        | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
      > = [];
      if (stateCtx) {
        contentBlocks.push({ type: "text" as const, text: stateCtx });
      }
      if (agentState.phase === AgentPhase.REFLECTING) {
        contentBlocks.push({ type: "text" as const, text: buildReflectionPrompt(agentState) });
      }
      for (const tr of toolResults) {
        contentBlocks.push({
          type: "tool_result" as const,
          tool_use_id: tr.toolCallId,
          content: tr.content,
          is_error: tr.isError,
        });
      }
      session.messages.push({
        role: "user",
        content: contentBlocks.length === 1 && stateCtx ? stateCtx : contentBlocks,
      });
    }

    // Hit max iterations
    // ─── Metrics: record max iterations ──────────────────────────────
    if (metricId) {
      this.metricsRecorder?.endTask(metricId, {
        agentPhase: agentState.phase,
        iterations: agentState.iteration,
        toolCallCount: agentState.stepResults.length,
        hitMaxIterations: true,
      });
    }
    // ────────────────────────────────────────────────────────────────

    await this.channel.sendText(
      chatId,
      "I've reached the maximum number of steps for this request. " +
        "Please send a follow-up message to continue.",
    );
    } finally {
      // ─── Metrics: safety net for unexpected exits ────────────────────
      if (metricId && !this.metricsRecorder?.isRecorded(metricId)) {
        this.metricsRecorder?.endTask(metricId, {
          agentPhase: agentState.phase,
          iterations: agentState.iteration,
          toolCallCount: agentState.stepResults.length,
          hitMaxIterations: false,
        });
      }
      // ────────────────────────────────────────────────────────────────
    }
  }

  /**
   * Stream a response from the LLM to the channel in real-time.
   * Sends text chunks as they arrive, then returns the final ProviderResponse.
   */
  private async streamResponse(
    chatId: string,
    systemPrompt: string,
    session: Session,
    provider: IAIProvider,
  ): Promise<ProviderResponse> {
    const channel = this.channel;
    let streamId: string | undefined;
    let accumulated = "";
    let lastUpdate = 0;

    const onChunk = (chunk: string) => {
      accumulated += chunk;

      // Throttle updates to avoid flooding the channel
      const now = Date.now();
      if (now - lastUpdate >= STREAM_THROTTLE_MS && streamId) {
        lastUpdate = now;
        (
          channel as {
            updateStreamingMessage?: (
              chatId: string,
              streamId: string,
              text: string,
            ) => Promise<void>;
          }
        )
          .updateStreamingMessage?.(chatId, streamId, accumulated)
          ?.catch((err) =>
            getLogger().error("Failed to update streaming message", {
              chatId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
      }
    };

    // Start the streaming message placeholder
    streamId =
      (await (
        channel as { startStreamingMessage?: (chatId: string) => Promise<string | undefined> }
      ).startStreamingMessage?.(chatId)) ?? undefined;

    const response = await (provider as IStreamingProvider).chatStream(
      systemPrompt,
      session.messages,
      this.toolDefinitions,
      onChunk,
    );

    // Finalize the streamed message
    if (streamId && accumulated) {
      await (
        channel as {
          finalizeStreamingMessage?: (
            chatId: string,
            streamId: string,
            text: string,
          ) => Promise<void>;
        }
      ).finalizeStreamingMessage?.(chatId, streamId, accumulated);
    }

    return response;
  }

  /**
   * Execute tool calls, handling confirmations for write operations.
   */
  private async executeToolCalls(chatId: string, toolCalls: ToolCall[]): Promise<ToolResult[]> {
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
        const confirmed = await this.requestWriteConfirmation(chatId, tc.name, tc.input);
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
        const errMsg = error instanceof Error ? error.message : "Unknown error";
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
    return WRITE_OPERATIONS.has(toolName);
  }

  private async requestWriteConfirmation(
    chatId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<boolean> {
    let question: string;
    let details: string;

    switch (toolName) {
      case "file_delete":
        question = `Confirm delete: \`${input["path"]}\`?`;
        details = `Permanently deleting ${input["path"]}`;
        break;
      case "file_rename":
        question = `Confirm rename: \`${input["old_path"]}\` → \`${input["new_path"]}\`?`;
        details = `Moving ${input["old_path"]} to ${input["new_path"]}`;
        break;
      case "file_delete_directory":
        question = `Confirm DELETE directory: \`${input["path"]}\`?`;
        details = `Recursively deleting ${input["path"]} and ALL contents`;
        break;
      case "shell_exec":
        question = `Confirm shell command: \`${String(input["command"]).slice(0, 100)}\`?`;
        details = `Running: ${input["command"]}`;
        break;
      case "git_commit":
        question = `Confirm git commit: "${String(input["message"]).slice(0, 80)}"?`;
        details = `Creating git commit`;
        break;
      case "git_push":
        question = "Confirm git push to remote?";
        details = `Pushing to ${input["remote"] ?? "origin"}`;
        break;
      default: {
        const path = String(input["path"] ?? "unknown");
        question = `Confirm file ${toolName === "file_write" ? "create/overwrite" : "edit"}: \`${path}\`?`;
        details = toolName === "file_edit" ? `Replacing text in ${path}` : `Writing to ${path}`;
      }
    }

    const response = await (
      this.channel as unknown as {
        requestConfirmation: (req: {
          chatId: string;
          question: string;
          options: string[];
          details?: string;
        }) => Promise<string>;
      }
    ).requestConfirmation({
      chatId,
      question,
      options: ["Yes", "No"],
      details,
    });

    return response === "Yes";
  }

  private extractLastUserMessage(session: Session): string {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i]!;
      if (msg.role === "user" && typeof msg.content === "string") {
        return msg.content;
      }
    }
    return "";
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
      if (msg.role === "user" && !("toolResults" in msg)) {
        trimTo = i;
        break;
      }
    }

    if (trimTo > 0) {
      return session.messages.splice(0, trimTo);
    }
    return [];
  }

  getProviderManager(): ProviderManager {
    return this.providerManager;
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

  private emitToolResult(chatId: string, tc: { name: string; input: unknown }, tr: { content: string; isError?: boolean }): void {
    if (!this.eventEmitter) return;
    this.eventEmitter.emit("tool:result", {
      sessionId: chatId,
      toolName: tc.name,
      input: sanitizeEventInput(tc.input as Record<string, unknown>),
      output: tr.content.slice(0, 500),
      success: !(tr.isError ?? false),
      retryCount: 0,
      timestamp: Date.now(),
    });
  }
}

const REFLECTION_DECISION_RE = /\*\*\s*(DONE|REPLAN|CONTINUE)\s*\*\*/;

function parseReflectionDecision(text: string | null | undefined): "CONTINUE" | "REPLAN" | "DONE" {
  if (!text) return "CONTINUE";
  const match = text.match(REFLECTION_DECISION_RE);
  if (match) return match[1] as "DONE" | "REPLAN" | "CONTINUE";
  // Fallback: check last line for bare keyword
  const lastLine = text.trim().split("\n").pop()?.toUpperCase() ?? "";
  if (lastLine === "DONE") return "DONE";
  if (lastLine === "REPLAN") return "REPLAN";
  return "CONTINUE";
}

function extractApproachSummary(state: AgentState): string {
  const recentSteps = state.stepResults.slice(-5);
  const tools = recentSteps.map(s => s.toolName + "(" + (s.success ? "OK" : "FAIL") + ")").join(" → ");
  return (state.plan?.slice(0, 100) ?? "Unknown plan") + ": " + tools;
}

/** Sanitize tool input for learning events: cap size, strip API keys */
function sanitizeEventInput(input: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(input);
  if (serialized.length > 2048) {
    return { _truncated: true, _keys: Object.keys(input) };
  }
  const scrubbed = serialized.replace(API_KEY_PATTERN, "[REDACTED]");
  return JSON.parse(scrubbed) as Record<string, unknown>;
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

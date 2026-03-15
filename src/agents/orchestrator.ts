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
import type { IChannelAdapter, IncomingMessage, Attachment } from "../channels/channel.interface.js";
import { supportsRichMessaging } from "../channels/channel.interface.js";
import { isVisionCompatible, toBase64ImageSource } from "../utils/media-processor.js";
import type { MessageContent, AssistantMessage } from "./providers/provider-core.interface.js";
import type { IMemoryManager } from "../memory/memory.interface.js";
import { isOk, isSome } from "../types/index.js";
import type { ChatId } from "../types/index.js";
import type { MetricsCollector } from "../dashboard/metrics.js";
import {
  STRADA_SYSTEM_PROMPT,
  buildProjectContext,
  buildAnalysisSummary,
  buildDepsContext,
  buildCapabilityManifest,
  buildIdentitySection,
  buildCrashNotificationSection,
} from "./context/strada-knowledge.js";
import type { IdentityState } from "../identity/identity-state.js";
import type { CrashRecoveryContext } from "../identity/crash-recovery.js";
import type { StradaDepsStatus } from "../config/strada-deps.js";
import { checkStradaDeps, installStradaDep } from "../config/strada-deps.js";
import type { IRAGPipeline } from "../rag/rag.interface.js";
import type { RateLimiter } from "../security/rate-limiter.js";
import { getLogger } from "../utils/logger.js";
import { AgentPhase, createInitialState, transitionPhase, type AgentState, type StepResult } from "./agent-state.js";
import { buildPlanningPrompt, buildReflectionPrompt, buildReplanningPrompt, buildExecutionContext } from "./paor-prompts.js";
import type { InstinctRetriever } from "./instinct-retriever.js";
import { MemoryRefresher } from "./memory-refresher.js";
import type { ReRetrievalConfig } from "../config/config.js";
import type { IEmbeddingProvider } from "../rag/rag.interface.js";
import { shouldForceReplan } from "./failure-classifier.js";
import { ErrorRecoveryEngine, TaskPlanner, SelfVerification } from "./autonomy/index.js";
import { WRITE_OPERATIONS } from "./autonomy/constants.js";
import { DMPolicy, isDestructiveOperation, type DMPolicyConfig } from "../security/dm-policy.js";
import type { BackgroundTaskOptions } from "../tasks/types.js";
import type { IEventEmitter, LearningEventMap } from "../core/event-bus.js";
import type { MetricsRecorder } from "../metrics/metrics-recorder.js";
import type { GoalDecomposer } from "../goals/goal-decomposer.js";
import { renderGoalTree, summarizeTree } from "../goals/goal-renderer.js";
import { formatResumePrompt, prepareTreeForResume } from "../goals/goal-resume.js";
import type { GoalTree, GoalNodeId, GoalStatus } from "../goals/types.js";
import { parseGoalBlock, buildGoalTreeFromBlock } from "../goals/types.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { SoulLoader } from "./soul/index.js";
import type { SessionSummarizer } from "../memory/unified/session-summarizer.js";
import type { UserProfileStore } from "../memory/unified/user-profile-store.js";

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

/** Default prompt when user sends an image with no text. */
const DEFAULT_IMAGE_PROMPT = "What is in this image?";

/**
 * Build user message content, converting image attachments to vision blocks
 * when the provider supports it.
 */
export function buildUserContent(
  text: string,
  attachments: Attachment[] | undefined,
  supportsVision: boolean,
): string | MessageContent[] {
  if (!attachments || attachments.length === 0) {
    return text;
  }

  const imageAttachments: Attachment[] = [];
  const nonImageAttachments: Attachment[] = [];
  for (const a of attachments) {
    if (a.mimeType && isVisionCompatible(a.mimeType) && (a.data || a.url)) {
      imageAttachments.push(a);
    } else {
      nonImageAttachments.push(a);
    }
  }

  // If no vision support or no image attachments, append text notes
  if (!supportsVision || imageAttachments.length === 0) {
    const notes = attachments
      .map((a) => `[Attached: ${a.name} (${a.mimeType ?? "unknown"})]`)
      .join("\n");
    return text ? `${text}\n\n${notes}` : notes;
  }

  // Build MessageContent[] with image blocks
  const content: MessageContent[] = [];

  // Text block (with non-image notes appended)
  let textPart = text;
  if (nonImageAttachments.length > 0) {
    const notes = nonImageAttachments
      .map((a) => `[Attached: ${a.name} (${a.mimeType ?? "unknown"})]`)
      .join("\n");
    textPart = textPart ? `${textPart}\n\n${notes}` : notes;
  }
  content.push({ type: "text", text: textPart || DEFAULT_IMAGE_PROMPT });

  // Image blocks
  for (const att of imageAttachments) {
    if (att.data) {
      content.push({
        type: "image",
        source: toBase64ImageSource(att.data, att.mimeType!),
      });
    } else if (att.url) {
      content.push({
        type: "image",
        source: { type: "url", url: att.url },
      });
    }
  }

  return content;
}

/**
 * The AI Agent Orchestrator - the "brain" of Strada Brain.
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
  /** Per-session matched instinct IDs for appliedInstinctIds attribution in tool:result events */
  private readonly currentSessionInstinctIds = new Map<string, string[]>();
  private readonly goalDecomposer: GoalDecomposer | null;
  private readonly reRetrievalConfig?: ReRetrievalConfig;
  private readonly embeddingProvider?: IEmbeddingProvider;
  /** Active goal trees per session for proactive/reactive decomposition */
  private readonly activeGoalTrees = new Map<string, GoalTree>();
  /** Interrupted goal trees detected on startup, pending user resume/discard decision */
  private pendingResumeTrees: GoalTree[];
  /** TaskManager reference for inline goal detection submission (lazy setter) */
  private taskManager: TaskManager | null = null;
  private readonly soulLoader: SoulLoader | null;
  private readonly dmPolicy: DMPolicy;
  private readonly lastPersistTime = new Map<string, number>();
  private readonly sessionSummarizer?: SessionSummarizer;
  private readonly userProfileStore?: UserProfileStore;

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
    goalDecomposer?: GoalDecomposer;
    interruptedGoalTrees?: GoalTree[];
    getIdentityState?: () => IdentityState;
    crashRecoveryContext?: CrashRecoveryContext;
    reRetrievalConfig?: ReRetrievalConfig;
    embeddingProvider?: IEmbeddingProvider;
    soulLoader?: SoulLoader;
    dmPolicyConfig?: Partial<DMPolicyConfig>;
    sessionSummarizer?: SessionSummarizer;
    userProfileStore?: UserProfileStore;
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
    this.goalDecomposer = opts.goalDecomposer ?? null;
    this.pendingResumeTrees = opts.interruptedGoalTrees ?? [];
    this.reRetrievalConfig = opts.reRetrievalConfig;
    this.embeddingProvider = opts.embeddingProvider;
    this.soulLoader = opts.soulLoader ?? null;
    this.dmPolicy = new DMPolicy(opts.channel, opts.dmPolicyConfig);
    this.sessionSummarizer = opts.sessionSummarizer;
    this.userProfileStore = opts.userProfileStore;

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
      STRADA_SYSTEM_PROMPT +
      buildProjectContext(this.projectPath) +
      buildDepsContext(opts.stradaDeps) +
      buildCapabilityManifest() +
      (opts.getIdentityState ? buildIdentitySection(opts.getIdentityState()) : "") +
      (opts.crashRecoveryContext ? buildCrashNotificationSection(opts.crashRecoveryContext) : "");
  }

  /**
   * Dynamically add a tool to the orchestrator's available tools.
   * Used by chain synthesis to make composite tools available to the LLM.
   */
  addTool(tool: ITool): void {
    this.tools.set(tool.name, tool);
    // Update or append toolDefinitions
    const existingIdx = this.toolDefinitions.findIndex(td => td.name === tool.name);
    const def = {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as import("../types/index.js").JsonObject,
    };
    if (existingIdx >= 0) {
      this.toolDefinitions[existingIdx] = def;
    } else {
      this.toolDefinitions.push(def);
    }
  }

  /**
   * Dynamically remove a tool from the orchestrator's available tools.
   * Used by chain synthesis to remove invalidated composite tools.
   */
  removeTool(name: string): void {
    this.tools.delete(name);
    const idx = this.toolDefinitions.findIndex(td => td.name === name);
    if (idx >= 0) {
      this.toolDefinitions.splice(idx, 1);
    }
  }

  /**
   * Set the task manager reference for inline goal detection submission.
   * Uses lazy setter pattern to avoid circular dependency (same as BackgroundExecutor).
   */
  setTaskManager(tm: TaskManager): void {
    this.taskManager = tm;
  }

  /** Append soul personality section to a system prompt if available. */
  private injectSoulPersonality(systemPrompt: string, channelType?: string): string {
    if (!this.soulLoader) return systemPrompt;
    const soulContent = this.soulLoader.getContent(channelType);
    if (!soulContent) return systemPrompt;
    return systemPrompt + `\n\n## Agent Personality\n\n${soulContent}\n`;
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
    let systemPrompt = this.injectSoulPersonality(this.systemPrompt, options.channelType);

    const bgInitialContentHashes: string[] = [];
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
            systemPrompt += `\n\n<!-- re-retrieval:memory:start -->\n## Relevant Memory\n${memoryContext}\n<!-- re-retrieval:memory:end -->\n`;
            for (const m of memories) bgInitialContentHashes.push(m.entry.content);
          }
        }
      } catch {
        // Memory retrieval failure is non-fatal
      }

      if (this.ragPipeline) {
        try {
          const ragResults = await this.ragPipeline.search(prompt, { topK: 6, minScore: 0.2 });
          if (ragResults.length > 0) {
            const ragFormatted = this.ragPipeline.formatContext(ragResults);
            systemPrompt += `\n\n<!-- re-retrieval:rag:start -->\n${ragFormatted}\n<!-- re-retrieval:rag:end -->\n`;
            for (const r of ragResults) bgInitialContentHashes.push(r.chunk.content);
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

    // ─── Background task instinct retrieval ────────────────────────────
    if (this.instinctRetriever) {
      try {
        const insightResult = await this.instinctRetriever.getInsightsForTask(prompt);
        if (insightResult.insights.length > 0) {
          const insightsText = insightResult.insights.join("\n");
          systemPrompt += `\n\n## Learned Insights\n${insightsText}\n`;
        }
      } catch {
        // Non-fatal
      }
    }
    // ────────────────────────────────────────────────────────────────

    // ─── Memory Re-retrieval: create refresher for background path ───
    const bgMemoryRefresher = this.createMemoryRefresher(bgInitialContentHashes);
    // ────────────────────────────────────────────────────────────────

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
        const bgInputTokens = response.usage?.inputTokens ?? 0;
        const bgOutputTokens = response.usage?.outputTokens ?? 0;
        this.metrics?.recordTokenUsage(bgInputTokens, bgOutputTokens, provider.name);
        this.rateLimiter?.recordTokenUsage(bgInputTokens, bgOutputTokens, provider.name);

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
          this.recordMetricEnd(metricId, {
            agentPhase: AgentPhase.COMPLETE,
            iterations: bgIteration + 1,
            toolCallCount: bgToolCallCount,
            hitMaxIterations: false,
          });
          // ────────────────────────────────────────────────────────────

          // Persist background task conversation to memory
          await this.persistSessionToMemory(chatId, session.messages, /* force */ true);
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

        // ─── Memory Re-retrieval (background path) ───────────────────────
        if (bgMemoryRefresher) {
          try {
            const check = await bgMemoryRefresher.shouldRefresh(bgIteration, prompt, chatId);
            if (check.should) {
              const refreshed = await bgMemoryRefresher.refresh(prompt, chatId, check.reason, bgIteration, check.cosineDistance);
              if (refreshed.triggered) {
                if (refreshed.newMemoryContext) {
                  systemPrompt = replaceSection(systemPrompt, "re-retrieval:memory", `## Relevant Memory\n${refreshed.newMemoryContext}`);
                }
                if (refreshed.newRagContext) {
                  systemPrompt = replaceSection(systemPrompt, "re-retrieval:rag", refreshed.newRagContext);
                }
              }
            }
          } catch {
            // Re-retrieval failure is non-fatal
          }
        }
        // ─────────────────────────────────────────────────────────────────
      }

      // ─── Metrics: record max iterations ──────────────────────────────
      this.recordMetricEnd(metricId, {
        agentPhase: AgentPhase.EXECUTING,
        iterations: bgIteration,
        toolCallCount: bgToolCallCount,
        hitMaxIterations: true,
      });
      // ────────────────────────────────────────────────────────────────

      return "Task reached maximum iterations. The work done so far has been saved.";
    } finally {
      // ─── Metrics: safety net for unexpected exits (endTask is idempotent) ─
      this.recordMetricEnd(metricId, {
        agentPhase: AgentPhase.FAILED,
        iterations: bgIteration,
        toolCallCount: bgToolCallCount,
        hitMaxIterations: false,
      });
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
            STRADA_SYSTEM_PROMPT +
            buildCapabilityManifest() +
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
          STRADA_SYSTEM_PROMPT +
          buildCapabilityManifest() +
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

    // Goal tree resume detection (trigger on first message when interrupted trees exist)
    if (this.pendingResumeTrees.length > 0) {
      const resumePrompt = formatResumePrompt(this.pendingResumeTrees);
      await this.channel.sendMarkdown(chatId, resumePrompt);

      const normalized = text.toLowerCase().trim();
      if (normalized === "resume" || normalized === "resume all") {
        for (const tree of this.pendingResumeTrees) {
          const prepared = prepareTreeForResume(tree);
          this.activeGoalTrees.set(tree.sessionId, prepared);
        }
        this.pendingResumeTrees = [];
        await this.channel.sendMarkdown(chatId, "Resuming interrupted goal trees...");
        return;
      } else if (normalized === "discard" || normalized === "discard all") {
        this.pendingResumeTrees = [];
        await this.channel.sendMarkdown(chatId, "Interrupted goal trees discarded.");
        return;
      }
      // User chose to ignore the prompt — clear pending and continue with normal flow
      this.pendingResumeTrees = [];
    }

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

    // Add user message (with vision blocks if applicable)
    const provider = this.providerManager.getProvider(chatId);
    const supportsVision = provider.capabilities.vision;
    const userContent = buildUserContent(text, msg.attachments, supportsVision);
    session.messages.push({ role: "user", content: userContent });

    // Trim old messages to manage context window
    // Persist trimmed messages to memory before discarding
    const trimmed = this.trimSession(session, 40);
    if (trimmed.length > 0) {
      await this.persistSessionToMemory(chatId, trimmed, /* force */ true);
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

    // First-run onboarding check (creates minimal profile if needed)
    this.runOnboarding(chatId);

    try {
      await this.runAgentLoop(chatId, session, msg.channelType);
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
      // Persist conversation summary (debounced to avoid excessive writes)
      await this.persistSessionToMemory(chatId, session.messages.slice(-10));
    }
  }

  /**
   * First-run onboarding: creates a minimal profile so subsequent messages don't re-trigger.
   * The actual onboarding questions are driven by the LLM via system prompt directive.
   */
  private runOnboarding(chatId: string): void {
    if (!this.userProfileStore) return;
    const existing = this.userProfileStore.getProfile(chatId);
    if (existing) return; // Returning user — skip
    // Create minimal profile immediately (prevents re-trigger on next message)
    this.userProfileStore.upsertProfile(chatId, {});
  }

  /**
   * The core agent loop: LLM → Tool calls → LLM → ... → Response
   */
  private async runAgentLoop(chatId: string, session: Session, channelType?: string): Promise<void> {
    const logger = getLogger();
    const provider = this.providerManager.getProvider(chatId);

    // Retrieve relevant memory context for the first iteration
    let systemPrompt = this.injectSoulPersonality(this.systemPrompt, channelType);

    const initialContentHashes: string[] = [];
    if (this.memoryManager && session.messages.length > 0) {
      const lastUserMsg = [...session.messages]
        .reverse()
        .find((m) => m.role === "user" && m.content);
      // Extract text from both string and MessageContent[] (vision) messages
      const queryText = lastUserMsg
        ? typeof lastUserMsg.content === "string"
          ? lastUserMsg.content
          : Array.isArray(lastUserMsg.content)
            ? (lastUserMsg.content as MessageContent[])
                .filter((b): b is { type: "text"; text: string } => b.type === "text")
                .map((b) => b.text)
                .join(" ")
            : ""
        : "";
      if (lastUserMsg && queryText) {
        try {
          const memoriesResult = await this.memoryManager.retrieve({
            mode: "text",
            query: queryText,
            limit: 3,
            minScore: 0.15,
          });
          if (isOk(memoriesResult)) {
            const memories = memoriesResult.value;
            if (memories.length > 0) {
              const memoryContext = memories.map((m) => m.entry.content).join("\n---\n");
              systemPrompt += `\n\n<!-- re-retrieval:memory:start -->\n## Relevant Memory\n${memoryContext}\n<!-- re-retrieval:memory:end -->\n`;
              for (const m of memories) initialContentHashes.push(m.entry.content);
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
        if (this.ragPipeline && queryText) {
          try {
            const ragResults = await this.ragPipeline.search(queryText, {
              topK: 6,
              minScore: 0.2,
            });
            if (ragResults.length > 0) {
              const ragFormatted = this.ragPipeline.formatContext(ragResults);
              systemPrompt += `\n\n<!-- re-retrieval:rag:start -->\n${ragFormatted}\n<!-- re-retrieval:rag:end -->\n`;
              for (const r of ragResults) initialContentHashes.push(r.chunk.content);
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

    // First-time user onboarding directive
    if (this.userProfileStore) {
      const profile = this.userProfileStore.getProfile(chatId);
      if (profile && !profile.displayName) {
        systemPrompt += `\n\n## First-Time User Onboarding
This is a new user who hasn't been onboarded yet. Before answering their question, warmly introduce yourself and use the ask_user tool to learn about them:
1. Ask their name (how to address them)
2. Ask their preferred communication style (casual/formal/minimal - suggest casual as default)
3. Ask how detailed they want explanations (brief/moderate/detailed)
After receiving answers, acknowledge them warmly and proceed to answer their original question.
Be natural and conversational — this should feel like meeting a new colleague, not filling out a form.\n`;
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
    // Store per-session instinct IDs for appliedInstinctIds attribution
    this.currentSessionInstinctIds.set(chatId, matchedInstinctIds);

    // ─── Memory Re-retrieval: create refresher ───────────────────────
    const memoryRefresher = this.createMemoryRefresher(initialContentHashes);
    // ────────────────────────────────────────────────────────────────

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
          activePrompt += "\n\n" + buildPlanningPrompt(
            agentState.taskDescription,
            agentState.learnedInsights,
            { enableGoalDetection: !!this.taskManager },
          );
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

      const inputTokens = response.usage?.inputTokens ?? 0;
      const outputTokens = response.usage?.outputTokens ?? 0;
      logger.debug("LLM response", {
        chatId,
        iteration,
        stopReason: response.stopReason,
        toolCallCount: response.toolCalls.length,
        inputTokens,
        outputTokens,
        streamed: canStream,
      });
      this.metrics?.recordTokenUsage(inputTokens, outputTokens, provider.name);
      this.rateLimiter?.recordTokenUsage(inputTokens, outputTokens, provider.name);

      // ─── PAOR: Handle REFLECTING phase response ─────────────────────
      if (agentState.phase === AgentPhase.REFLECTING) {
        const decision = parseReflectionDecision(response.text);

        if (decision === "DONE") {
          if (response.text) {
            session.messages.push({ role: "assistant", content: response.text });
            if (!canStream) await this.channel.sendMarkdown(chatId, response.text);
          }
          // ─── Metrics: record DONE ───────────────────────────────────
          this.recordMetricEnd(metricId, {
            agentPhase: AgentPhase.COMPLETE,
            iterations: agentState.iteration,
            toolCallCount: agentState.stepResults.length,
            hitMaxIterations: false,
          });
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

          // ─── Goal Decomposition: reactive decomposition when stuck ──────
          if (this.goalDecomposer && this.activeGoalTrees.has(chatId)) {
            try {
              const goalTree = this.activeGoalTrees.get(chatId)!;
              // Find the currently-executing node
              let executingNodeId: GoalNodeId | null = null;
              for (const [, node] of goalTree.nodes) {
                if (node.status === "executing") {
                  executingNodeId = node.id;
                  break;
                }
              }
              if (executingNodeId) {
                const executingNode = goalTree.nodes.get(executingNodeId)!;
                this.emitGoalEvent(goalTree.rootId, executingNodeId, "failed", executingNode.depth);
                const updatedTree = await this.goalDecomposer.decomposeReactive(
                  goalTree,
                  executingNodeId,
                  response.text ?? "",
                );
                if (updatedTree) {
                  this.activeGoalTrees.set(chatId, updatedTree);
                  const treeViz = renderGoalTree(updatedTree);
                  await this.channel.sendMarkdown(chatId, "Goal tree updated (reactive decomposition):\n```\n" + treeViz + "\n```");
                } else {
                  getLogger().info("Reactive decomposition skipped (depth limit reached)", { chatId, nodeId: executingNodeId });
                }
              }
            } catch (reactiveError) {
              // Reactive decomposition failure is non-fatal
              getLogger().warn("Reactive goal decomposition failed", {
                chatId,
                error: reactiveError instanceof Error ? reactiveError.message : String(reactiveError),
              });
            }
          }
          // ────────────────────────────────────────────────────────────────

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

      // ─── Goal Detection: check for goal block in Plan phase response ───
      // Must run BEFORE end_turn early return since goal detection responses
      // may have no tool calls but should short-circuit to background execution.
      if (agentState.phase === AgentPhase.PLANNING && this.taskManager) {
        const goalBlock = parseGoalBlock(response.text ?? "");
        if (goalBlock && goalBlock.isGoal) {
          // Build GoalTree from LLM output using shared factory
          const goalTree = buildGoalTreeFromBlock(
            goalBlock, chatId, lastUserMessage, response.text ?? undefined,
          );

          // Send acknowledgment
          const nodeCount = goalTree.nodes.size - 1;
          const ackMsg = `Working on: ${lastUserMessage.slice(0, 80)}` +
            ` (${nodeCount} step${nodeCount !== 1 ? "s" : ""}, ~${goalBlock.estimatedMinutes} min). I'll update you as I go.`;
          await this.channel.sendText(chatId, ackMsg);

          // Submit as background task with pre-decomposed tree
          this.taskManager.submit(chatId, channelType ?? "cli", lastUserMessage, { goalTree });

          // Record metric end for the interactive session (goal runs separately)
          this.recordMetricEnd(metricId, {
            agentPhase: AgentPhase.COMPLETE,
            iterations: agentState.iteration,
            toolCallCount: 0,
            hitMaxIterations: false,
          });

          // Short-circuit: return immediately, session lock releases
          return;
        }
      }
      // ────────────────────────────────────────────────────────────────────

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
        this.recordMetricEnd(metricId, {
          agentPhase: agentState.phase,
          iterations: agentState.iteration,
          toolCallCount: agentState.stepResults.length,
          hitMaxIterations: false,
        });
        // ──────────────────────────────────────────────────────────
        return;
      }

      // ─── PAOR: Phase transitions ────────────────────────────────────
      if (agentState.phase === AgentPhase.PLANNING) {
        agentState = { ...agentState, plan: response.text ?? null };

        // ─── Goal Decomposition: proactive decomposition for complex tasks ───
        if (this.goalDecomposer && this.goalDecomposer.shouldDecompose(lastUserMessage)) {
          try {
            const goalTree = await this.goalDecomposer.decomposeProactive(chatId, lastUserMessage);
            this.activeGoalTrees.set(chatId, goalTree);
            this.emitGoalEvent(goalTree.rootId, goalTree.rootId, "pending", 0);
            const treeViz = renderGoalTree(goalTree);
            await this.channel.sendMarkdown(chatId, "Goal decomposition:\n```\n" + treeViz + "\n```");
            // Augment plan with decomposition summary
            const treeSummary = summarizeTree(goalTree);
            agentState = { ...agentState, plan: (agentState.plan ?? "") + "\n\n[Goal Tree: " + treeSummary + "]" };
          } catch (decompError) {
            // Decomposition failure is non-fatal -- continue without decomposition
            getLogger().warn("Proactive goal decomposition failed", {
              chatId,
              error: decompError instanceof Error ? decompError.message : String(decompError),
            });
          }
        }
        // ────────────────────────────────────────────────────────────────────

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

      // ─── Memory Re-retrieval ─────────────────────────────────────────
      if (memoryRefresher) {
        try {
          const recentContext = this.extractLastUserMessage(session);
          const check = await memoryRefresher.shouldRefresh(iteration, recentContext, chatId);
          if (check.should) {
            const refreshed = await memoryRefresher.refresh(recentContext, chatId, check.reason, iteration, check.cosineDistance);
            if (refreshed.triggered) {
              if (refreshed.newMemoryContext) {
                systemPrompt = replaceSection(systemPrompt, "re-retrieval:memory", `## Relevant Memory\n${refreshed.newMemoryContext}`);
              }
              if (refreshed.newRagContext) {
                systemPrompt = replaceSection(systemPrompt, "re-retrieval:rag", refreshed.newRagContext);
              }
              if (refreshed.newInsights?.length) {
                agentState = { ...agentState, learnedInsights: refreshed.newInsights };
              }
              if (refreshed.newInstinctIds?.length) {
                // Deduplicate and cap instinct IDs to prevent unbounded growth
                const idSet = new Set(matchedInstinctIds);
                for (const id of refreshed.newInstinctIds) idSet.add(id);
                matchedInstinctIds = [...idSet].slice(0, 200);
                this.currentSessionInstinctIds.set(chatId, matchedInstinctIds);
              }
            }
          }
        } catch {
          // Re-retrieval failure is non-fatal
        }
      }
      // ─────────────────────────────────────────────────────────────────
    }

    // Hit max iterations
    // ─── Metrics: record max iterations ──────────────────────────────
    this.recordMetricEnd(metricId, {
      agentPhase: agentState.phase,
      iterations: agentState.iteration,
      toolCallCount: agentState.stepResults.length,
      hitMaxIterations: true,
    });
    // ────────────────────────────────────────────────────────────────

    await this.channel.sendText(
      chatId,
      "I've reached the maximum number of steps for this request. " +
        "Please send a follow-up message to continue.",
    );
    } finally {
      // ─── Metrics: safety net for unexpected exits (endTask is idempotent) ─
      this.recordMetricEnd(metricId, {
        agentPhase: agentState.phase,
        iterations: agentState.iteration,
        toolCallCount: agentState.stepResults.length,
        hitMaxIterations: false,
      });
      // ────────────────────────────────────────────────────────────────
      // Clean up per-session instinct IDs and goal trees to prevent memory leak
      this.currentSessionInstinctIds.delete(chatId);
      // Note: activeGoalTrees intentionally NOT cleaned up here -- trees persist across messages
      // in a session for reactive decomposition. Cleaned up in cleanupSessions and eviction.
    }
  }

  /** Record a metric end event (idempotent — endTask is a no-op for already-completed or unknown IDs) */
  private recordMetricEnd(
    metricId: string | undefined,
    result: { agentPhase: AgentPhase; iterations: number; toolCallCount: number; hitMaxIterations: boolean },
  ): void {
    if (metricId) {
      this.metricsRecorder?.endTask(metricId, result);
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

    let response: ProviderResponse;
    const streamTimeout = 120_000; // 120s timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), streamTimeout);
    try {

      const streamPromise = (provider as IStreamingProvider).chatStream(
        systemPrompt,
        session.messages,
        this.toolDefinitions,
        onChunk,
      );

      // Race against abort signal
      response = await Promise.race([
        streamPromise,
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () =>
            reject(new Error("Streaming response timed out")),
          { once: true });
        }),
      ]);

      clearTimeout(timer);
    } catch (streamError) {
      clearTimeout(timer);
      const errMsg = streamError instanceof Error ? streamError.message : "Unknown streaming error";
      getLogger().error("Streaming error", { chatId, error: errMsg });
      accumulated = `[Streaming error: ${errMsg}]`;

      // Finalize with error message and return a synthetic response
      if (streamId) {
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

      return {
        text: accumulated,
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    }

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

    const toolContext: ToolContext & { soulLoader?: SoulLoader | null } = {
      projectPath: this.projectPath,
      workingDirectory: this.projectPath,
      readOnly: this.readOnly,
      chatId,
      channel: this.channel,
      soulLoader: this.soulLoader,
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

      // Confirmation flow via DMPolicy for write operations
      if (this.requireConfirmation && this.isWriteOperation(tc.name)) {
        const destructive = isDestructiveOperation(tc.name, tc.input);
        // Note: userId not available in executeToolCalls context; chatId used as userId fallback
        const prefs = this.dmPolicy.getSessionPrefs(chatId, chatId);
        const stubDiff = {
          path: String(tc.input["path"] ?? ""),
          content: "",
          stats: { additions: 0, deletions: 0, modifications: 0, totalChanges: 1, hunks: 1 },
          oldPath: "",
          newPath: String(tc.input["path"] ?? ""),
          diff: "",
          isNew: false,
          isDeleted: false,
          isRename: false,
        };
        if (this.dmPolicy.isApprovalRequired(prefs, stubDiff, destructive)) {
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
      this.activeGoalTrees.delete(oldestKey);
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
      return session.messages.splice(0, trimTo);
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
          return session.messages.splice(0, i);
        }
      }
      // Last resort: trim at overflow, accepting potential orphaning
      return session.messages.splice(0, overflow);
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
        // Session-end summarization (fire-and-forget)
        if (this.sessionSummarizer && session.messages.length >= 2) {
          void this.sessionSummarizer.summarizeAndUpdateProfile(chatId, session.messages)
            .catch(() => {
              // Session summarization failure is non-fatal
            });
        }
        // Persist before cleanup (forced — session is being evicted)
        void this.persistSessionToMemory(chatId, session.messages.slice(-10), /* force */ true);
        this.lastPersistTime.delete(chatId);
        this.sessions.delete(chatId);
        this.sessionLocks.delete(chatId);
        this.activeGoalTrees.delete(chatId);
      }
    }
  }

  /** Minimum interval between debounced memory persists per chat (30s). */
  private static readonly PERSIST_DEBOUNCE_MS = 30_000;

  /**
   * Persist conversation messages to memory so the agent remembers them next session.
   * Debounced by default — pass `force: true` for trim evictions and session cleanup.
   */
  private async persistSessionToMemory(
    chatId: string,
    messages: ConversationMessage[],
    force = false,
  ): Promise<void> {
    if (!this.memoryManager) return;
    if (messages.length < 2) return;

    if (!force) {
      const now = Date.now();
      const lastTime = this.lastPersistTime.get(chatId) ?? 0;
      if (now - lastTime < Orchestrator.PERSIST_DEBOUNCE_MS) return;
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
        const sanitized = summary.replace(API_KEY_PATTERN, "[REDACTED]");
        // Extract first user message and last assistant message for structured storage
        const userMsg = messages.find((m) => m.role === "user");
        const assistantMsg = [...messages].reverse().find((m) => m.role === "assistant");
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
        await this.memoryManager.storeConversation(chatId as ChatId, sanitized, {
          userMessage: extractText(userMsg),
          assistantMessage: extractText(assistantMsg),
        });
      }
    } catch {
      // Memory persistence failure is non-fatal
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
      appliedInstinctIds: this.currentSessionInstinctIds.get(chatId) ?? [],
      timestamp: Date.now(),
    });
  }

  /** Emit a goal lifecycle event on the event bus */
  private emitGoalEvent(rootId: GoalNodeId | string, nodeId: GoalNodeId | string, status: GoalStatus, depth: number): void {
    if (!this.eventEmitter) return;
    this.eventEmitter.emit("goal:status-changed", {
      rootId: rootId as GoalNodeId,
      nodeId: nodeId as GoalNodeId,
      status,
      depth,
      timestamp: Date.now(),
    });
  }

  /**
   * Create a MemoryRefresher if re-retrieval is enabled, seeded with initial content hashes.
   * Returns null when re-retrieval is disabled.
   */
  private createMemoryRefresher(initialContentHashes: string[]): MemoryRefresher | null {
    if (!this.reRetrievalConfig?.enabled) return null;
    const refresher = new MemoryRefresher(this.reRetrievalConfig, {
      memoryManager: this.memoryManager,
      ragPipeline: this.ragPipeline,
      instinctRetriever: this.instinctRetriever ?? undefined,
      embeddingProvider: this.embeddingProvider,
      eventBus: this.eventEmitter ?? undefined,
    });
    if (initialContentHashes.length > 0) {
      refresher.seedContentHashes(initialContentHashes);
    }
    return refresher;
  }
}

/**
 * Replace a section delimited by XML markers in a prompt string.
 * Markers: `<!-- {tag}:start -->` and `<!-- {tag}:end -->`.
 * If markers are not found, appends the section.
 */
function replaceSection(prompt: string, tag: string, newContent: string): string {
  const startMarker = `<!-- ${tag}:start -->`;
  const endMarker = `<!-- ${tag}:end -->`;
  // Sanitize newContent: strip any embedded markers to prevent injection
  // of fake section boundaries from adversarial memory/RAG content.
  const sanitized = newContent
    .replace(/<!--\s*[\w:-]+:start\s*-->/g, "")
    .replace(/<!--\s*[\w:-]+:end\s*-->/g, "");
  const startIdx = prompt.indexOf(startMarker);
  const endIdx = prompt.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) {
    return prompt + `\n\n${startMarker}\n${sanitized}\n${endMarker}\n`;
  }
  return prompt.substring(0, startIdx) + startMarker + "\n" + sanitized + "\n" + endMarker + prompt.substring(endIdx + endMarker.length);
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

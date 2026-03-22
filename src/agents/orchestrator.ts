import type {
  IAIProvider,
  ConversationMessage,
  ToolCall,
  ToolResult,
  ProviderResponse,
  IStreamingProvider,
} from "./providers/provider.interface.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { ProviderManager } from "./providers/provider-manager.js";
import { getToolMetadata, type ITool, type ToolContext } from "./tools/tool.interface.js";
import type {
  IChannelAdapter,
  IncomingMessage,
  Attachment,
} from "../channels/channel.interface.js";
import { supportsInteractivity, supportsRichMessaging } from "../channels/channel.interface.js";
import { isVisionCompatible, toBase64ImageSource } from "../utils/media-processor.js";
import type { MessageContent } from "./providers/provider-core.interface.js";
import type { IMemoryManager } from "../memory/memory.interface.js";
import { isOk, isSome } from "../types/index.js";
import type { MetricsCollector } from "../dashboard/metrics.js";
import {
  STRADA_SYSTEM_PROMPT,
  buildProjectContext,
  buildDepsContext,
  buildCapabilityManifest,
  buildIdentitySection,
  buildCrashNotificationSection,
  buildProjectWorldMemorySection,
} from "./context/strada-knowledge.js";
import type { IdentityState } from "../identity/identity-state.js";
import type { CrashRecoveryContext } from "../identity/crash-recovery.js";
import type { StradaDepsStatus } from "../config/strada-deps.js";
import { checkStradaDeps, installStradaDep } from "../config/strada-deps.js";
import type { IRAGPipeline } from "../rag/rag.interface.js";
import type { RateLimiter } from "../security/rate-limiter.js";
import { getLogger, getLogRingBuffer } from "../utils/logger.js";
import { buildPostSetupWelcomeMessage } from "../common/setup-state.js";
import type { PostSetupBootstrap, PostSetupBootstrapContext } from "../common/setup-contract.js";
import {
  AgentPhase,
  createInitialState,
  transitionPhase,
  type AgentState,
  type StepResult,
} from "./agent-state.js";
import {
  buildPlanningPrompt,
  buildReflectionPrompt,
  buildReplanningPrompt,
  buildExecutionContext,
} from "./paor-prompts.js";
import type { InstinctRetriever } from "./instinct-retriever.js";
import type { TrajectoryReplayRetriever } from "./trajectory-replay-retriever.js";
import { TeachingParser } from "../learning/feedback/teaching-parser.js";
import type { LearningPipeline } from "../learning/pipeline/learning-pipeline.js";
import type { InterventionEngine } from "../learning/intervention/intervention-engine.js";
import { MemoryRefresher } from "./memory-refresher.js";
import {
  DEFAULT_INTERACTION_CONFIG,
  DEFAULT_LLM_STREAM_INITIAL_TIMEOUT_MS,
  DEFAULT_LLM_STREAM_STALL_TIMEOUT_MS,
  DEFAULT_TASK_CONFIG,
  type InteractionConfig,
  type ReRetrievalConfig,
  type StradaDependencyConfig,
  type TaskConfig,
} from "../config/config.js";
import type { IEmbeddingProvider } from "../rag/rag.interface.js";
import { shouldForceReplan } from "./failure-classifier.js";
import {
  getRecommendedMaxMessages,
  type ModelIntelligenceLookup,
} from "./providers/provider-knowledge.js";
import {
  buildClarificationReviewRequest,
  CLARIFICATION_REVIEW_SYSTEM_PROMPT,
  COMPLETION_REVIEW_SYNTHESIS_SYSTEM_PROMPT,
  ControlLoopTracker,
  decideInteractionBoundary,
  draftLooksLikeInternalPlanArtifact,
  ErrorRecoveryEngine,
  ExecutionJournal,
  LOOP_RECOVERY_REVIEW_SYSTEM_PROMPT,
  TaskPlanner,
  SelfVerification,
  buildLoopRecoveryReviewRequest,
  collectClarificationReviewEvidence,
  buildCompletionReviewStageRequest,
  buildCompletionReviewStageSystemPrompt,
  buildCompletionReviewSynthesisRequest,
  finalizeVerifierPipelineReview,
  isTerminalFailureReport,
  parseCompletionReviewDecision,
  parseCompletionReviewStageResult,
  parseClarificationReviewDecision,
  parseLoopRecoveryReviewDecision,
  planVerifierPipeline,
  sanitizeClarificationReviewDecision,
  sanitizeLoopRecoveryReviewDecision,
  shouldRunClarificationReview,
  InteractionPolicyStateMachine,
  userExplicitlyAskedForPlan,
  type CompletionReviewStageName,
  type CompletionReviewStageResult,
  type ControlLoopGateKind,
  type InteractionBoundaryDecision,
  type LoopRecoveryBrief,
  type LoopRecoveryReviewDecision,
  type VerifierPipelineResult,
} from "./autonomy/index.js";
import { StradaConformanceGuard } from "./autonomy/strada-conformance.js";
import { MUTATION_TOOLS, WRITE_OPERATIONS, extractFilePath, isVerificationToolName } from "./autonomy/constants.js";
import { DMPolicy, isDestructiveOperation, type DMPolicyConfig } from "../security/dm-policy.js";
import {
  checkReadOnlyBlock,
  createReadOnlyToolStub,
  getReadOnlySystemPrompt,
} from "../security/read-only-guard.js";
import type { BackgroundTaskOptions, TaskProgressSignal, TaskProgressUpdate, TaskUsageEvent } from "../tasks/types.js";
import { buildTaskProgressSummary, type ProgressLanguage } from "../tasks/progress-signals.js";
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
import {
  resolveAutonomousModeWithDefault,
  type UserProfileStore,
} from "../memory/unified/user-profile-store.js";
import type {
  TaskExecutionStore,
} from "../memory/unified/task-execution-store.js";
import type {
  RuntimeArtifactManager,
  TrajectoryPhaseReplay,
  TrajectoryReplayContext,
} from "../learning/index.js";
import { classifyErrorMessage } from "../utils/error-messages.js";
import { TaskClassifier } from "../agent-core/routing/task-classifier.js";
import type {
  TaskClassification,
  ExecutionTrace,
  ExecutionPhase,
  ExecutionTraceSource,
  PhaseOutcome,
  PhaseOutcomeStatus,
  PhaseOutcomeTelemetry,
  VerifierDecision,
} from "../agent-core/routing/routing-types.js";
import {
  SHELL_REVIEW_SYSTEM_PROMPT,
  formatRequestedPlan,
  isSafeShellFallback,
  normalizeInteractiveText as normalizePolicyText,
  parseShellReviewDecision,
  resolveExecutionPolicy,
  reviewAutonomousPlan,
  reviewAutonomousQuestion,
} from "./orchestrator-interaction-policy.js";
import {
  applyVisibleResponseContract,
  extractExactResponseLiteral,
  extractNaturalLanguageDirectiveUpdates,
  resolveConversationScope,
  resolveIdentityKey,
} from "./orchestrator-text-utils.js";
import {
  mergeLearnedInsights,
  normalizeFailureFingerprint,
  replaceSection,
  sanitizeEventInput,
  sanitizeToolResult,
  shouldSurfaceTerminalFailureFromReflection,
} from "./orchestrator-runtime-utils.js";
import {
  handlePlanPhaseTransition,
  processReflectionPreamble,
  applyReflectionContinuation,
  handleReplanDecision,
  handleVerifierReplan,
} from "./orchestrator-loop-utils.js";
import {
  buildExecutionTraceRecord,
  buildPhaseOutcomeRecord,
  buildPhaseOutcomeTelemetry as buildPhaseOutcomeTelemetryModel,
  resolveExecutionTraceSource as resolveExecutionTraceSourceModel,
  toExecutionPhase as toExecutionPhaseModel,
  toPhaseOutcomeStatus as toPhaseOutcomeStatusModel,
  transitionToVerifierReplan as transitionToVerifierReplanModel,
} from "./orchestrator-phase-telemetry.js";
import {
  createCatalogVersion,
  type WorkerArtifactMetadata,
  type WorkerReviewFinding,
  type WorkerRunRequest,
  type WorkerRunResult,
  type WorkerToolTrace,
  type WorkerVerificationResult,
  type WorkspaceLease,
} from "./supervisor/supervisor-types.js";
import {
  buildStaticSupervisorAssignment as buildStaticSupervisorAssignmentHelper,
  buildCatalogAssignmentMetadata as buildCatalogAssignmentMetadataHelper,
  resolveProviderModelId as resolveProviderModelIdHelper,
  resolveSupervisorAssignment as resolveSupervisorAssignmentHelper,
  buildSupervisorExecutionStrategy as buildSupervisorExecutionStrategyHelper,
  getPinnedToolTurnAssignment as getPinnedToolTurnAssignmentHelper,
  buildSupervisorRolePrompt as buildSupervisorRolePromptHelper,
  resolveConsensusReviewAssignment as resolveConsensusReviewAssignmentHelper,
  recordProviderUsage as recordProviderUsageHelper,
  stripInternalDecisionMarkers as stripInternalDecisionMarkersHelper,
  type SupervisorRoutingContext,
  type SupervisorAssignment,
  type SupervisorExecutionStrategy,
  type SupervisorRole,
} from "./orchestrator-supervisor-routing.js";
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
import {
  canInspectLocally as canInspectLocallyHelper,
  decideUserVisibleBoundary as decideUserVisibleBoundaryHelper,
  buildSafeVisibleFallbackFromDraft as buildSafeVisibleFallbackFromDraftHelper,
  resolveDraftClarificationIntervention as resolveDraftClarificationInterventionHelper,
  resolveAskUserClarificationIntervention as resolveAskUserClarificationInterventionHelper,
  type ClarificationIntervention,
  type ClarificationContext,
} from "./orchestrator-clarification.js";
import {
  buildSystemPromptWithContext as buildSystemPromptWithContextHelper,
  type ContextBuilderDeps,
} from "./orchestrator-context-builder.js";

const TYPING_INTERVAL_MS = 4000;
const STREAM_THROTTLE_MS = 500; // Throttle streaming updates to channels
const NATURAL_LANGUAGE_BUILTIN_PERSONAS = ["default", "formal", "casual", "minimal"] as const;
const LOW_SIGNAL_EXECUTION_ACK_RE =
  /^(?:adjusted|done|ok(?:ay)?|noted|ack(?:nowledged)?|revised|updated|handled|understood|fixed)\.?$/iu;
const SUPERVISOR_SYNTHESIS_SYSTEM_PROMPT = `You are a synthesis worker inside Strada Brain's orchestrator.
The orchestrator remains the primary intelligence and the user-facing agent.
You are not the overall assistant for the session.

Your job:
- Convert verified execution artifacts into the final user-facing response.
- Preserve completed work, blockers, verification status, and next steps.
- Remove internal control markers such as DONE, CONTINUE, or REPLAN.
- Do not invent tool results, code changes, or success claims.
- If the task is incomplete or blocked, say that clearly.
- Do not ask for permission unless the evidence truly shows missing user intent.`;

interface WorkerToolMetadata {
  readonly readOnly?: boolean;
  readonly controlPlaneOnly?: boolean;
  readonly requiresBridge?: boolean;
  readonly available?: boolean;
  readonly availabilityReason?: string;
}

interface TaskExecutionContext {
  readonly chatId: string;
  readonly conversationId?: string;
  readonly userId?: string;
  readonly identityKey?: string;
  readonly taskRunId?: string;
}

type ToolExecutionMode = "interactive" | "background" | "delegated";

interface ToolExecutionOptions {
  mode?: ToolExecutionMode;
  userId?: string;
  taskPrompt?: string;
  sessionMessages?: ConversationMessage[];
  onUsage?: (usage: TaskUsageEvent) => void;
  identityKey?: string;
  strategy?: SupervisorExecutionStrategy;
  agentState?: AgentState;
  touchedFiles?: readonly string[];
  projectPathOverride?: string;
  workingDirectoryOverride?: string;
  workspaceLease?: WorkspaceLease;
}

interface SelfManagedWriteReview {
  approved: boolean;
  reason?: string;
}

interface VerifierIntervention {
  kind: "approve" | "continue" | "replan";
  gate?: string;
  result: VerifierPipelineResult;
}

interface LoopRecoveryIntervention {
  action: "none" | "continue" | "replan" | "blocked";
  gate?: string;
  message?: string;
  summary?: string;
}

interface WorkerRunCollector {
  toolTrace: WorkerToolTrace[];
  childWorkerResults: WorkerRunResult[];
  verifierResult?: VerifierPipelineResult;
  touchedFiles?: readonly string[];
  finalVisibleResponse?: string;
  finalSummary?: string;
  lastAssignment?: SupervisorAssignment;
  status?: WorkerRunResult["status"];
  reason?: string;
}

function createStreamingProgressTimeout(
  initialTimeoutMs: number,
  stallTimeoutMs: number,
): {
  markProgress: () => void;
  timeoutPromise: Promise<never>;
  clear: () => void;
} {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let sawProgress = false;
  let rejectTimeout: ((error: Error) => void) | undefined;

  const armTimeout = () => {
    if (timeoutId) clearTimeout(timeoutId);
    const timeoutMs = sawProgress ? stallTimeoutMs : initialTimeoutMs;
    timeoutId = setTimeout(() => {
      const message = sawProgress
        ? `Streaming stalled after ${stallTimeoutMs}ms without progress`
        : `Streaming did not start within ${initialTimeoutMs}ms`;
      rejectTimeout?.(new Error(message));
    }, timeoutMs);
  };

  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });

  armTimeout();

  return {
    markProgress: () => {
      sawProgress = true;
      armTimeout();
    },
    timeoutPromise,
    clear: () => {
      if (timeoutId) clearTimeout(timeoutId);
    },
  };
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
  private readonly toolMetadataByName = new Map<string, WorkerToolMetadata>();
  private readonly channel: IChannelAdapter;
  private readonly projectPath: string;
  private readonly readOnly: boolean;
  private readonly requireConfirmation: boolean;
  private readonly memoryManager?: IMemoryManager;
  private readonly metrics?: MetricsCollector;
  private readonly ragPipeline?: IRAGPipeline;
  private readonly rateLimiter?: RateLimiter;
  private readonly streamingEnabled: boolean;
  private readonly defaultLanguage: "en" | "tr" | "ja" | "ko" | "zh" | "de" | "es" | "fr";
  private readonly streamInitialTimeoutMs: number;
  private readonly streamStallTimeoutMs: number;
  private readonly sessions = new Map<string, Session>();
  private readonly sessionLocks = new Map<string, Promise<void>>();
  private systemPrompt: string;
  private readonly getIdentityState?: () => IdentityState;
  private readonly crashRecoveryContext?: CrashRecoveryContext;
  private stradaDeps: StradaDepsStatus | undefined;
  private readonly stradaConfig?: Partial<StradaDependencyConfig>;
  private depsSetupComplete: boolean = false;
  private readonly pendingDepsPrompt = new Map<string, boolean>();
  private readonly pendingModulesPrompt = new Map<string, boolean>();
  private readonly interactionPolicy = new InteractionPolicyStateMachine();
  private readonly instinctRetriever: InstinctRetriever | null;
  private readonly trajectoryReplayRetriever: TrajectoryReplayRetriever | null;
  private readonly eventEmitter: IEventEmitter<LearningEventMap> | null;
  private readonly metricsRecorder: MetricsRecorder | null;
  private readonly learningPipeline: LearningPipeline | null;
  private readonly interventionEngine: InterventionEngine | null;
  /** Per-session matched instinct IDs for appliedInstinctIds attribution in tool:result events */
  private readonly currentSessionInstinctIds = new Map<string, string[]>();
  private readonly goalDecomposer: GoalDecomposer | null;
  private readonly reRetrievalConfig?: ReRetrievalConfig;
  private readonly embeddingProvider?: IEmbeddingProvider;
  /** Active goal trees per session for proactive/reactive decomposition */
  private readonly activeGoalTrees = new Map<string, GoalTree>();
  /** Interrupted goal trees detected on startup, pending user resume/discard decision */
  private readonly pendingResumeTrees = new Map<string, GoalTree[]>();
  /** TaskManager reference for inline goal detection submission (lazy setter) */
  private taskManager: TaskManager | null = null;
  private readonly soulLoader: SoulLoader | null;
  private readonly dmPolicy: DMPolicy;
  private readonly lastPersistTime = new Map<string, number>();
  private readonly sessionSummarizer?: SessionSummarizer;
  private readonly userProfileStore?: UserProfileStore;
  private readonly autonomousDefaultEnabled: boolean;
  private readonly autonomousDefaultHours: number;
  private readonly interactionConfig: InteractionConfig;
  private readonly taskConfig: TaskConfig;
  private readonly taskExecutionStore?: TaskExecutionStore;
  private readonly runtimeArtifactManager?: RuntimeArtifactManager;
  /** Multi-provider routing: selects best provider per task/phase. */
  private readonly providerRouter?: import("../agent-core/routing/provider-router.js").ProviderRouter;
  /** Live model intelligence for provider-aware prompting and trimming. */
  private readonly modelIntelligence?: ModelIntelligenceLookup;
  /** Consensus verification: cross-provider output validation on low confidence. */
  private readonly consensusManager?: import("../agent-core/routing/consensus-manager.js").ConsensusManager;
  /** Confidence estimation for consensus gating. */
  private readonly confidenceEstimator?: import("../agent-core/routing/confidence-estimator.js").ConfidenceEstimator;
  private readonly taskClassifier = new TaskClassifier();
  private readonly onUsage?: (usage: TaskUsageEvent) => void;
  private readonly taskContext = new AsyncLocalStorage<TaskExecutionContext>();
  private readonly runtimeArtifactMatches = new Map<
    string,
    {
      activeGuidanceIds: string[];
      shadowIds: string[];
    }
  >();

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
    defaultLanguage?: "en" | "tr" | "ja" | "ko" | "zh" | "de" | "es" | "fr";
    streamInitialTimeoutMs?: number;
    streamStallTimeoutMs?: number;
    stradaDeps?: StradaDepsStatus;
    stradaConfig?: Partial<StradaDependencyConfig>;
    instinctRetriever?: InstinctRetriever;
    trajectoryReplayRetriever?: TrajectoryReplayRetriever;
    eventEmitter?: IEventEmitter<LearningEventMap>;
    metricsRecorder?: MetricsRecorder;
    learningPipeline?: LearningPipeline;
    interventionEngine?: InterventionEngine;
    goalDecomposer?: GoalDecomposer;
    interruptedGoalTrees?: GoalTree[];
    getIdentityState?: () => IdentityState;
    crashRecoveryContext?: CrashRecoveryContext;
    reRetrievalConfig?: ReRetrievalConfig;
    embeddingProvider?: IEmbeddingProvider;
    soulLoader?: SoulLoader;
    dmPolicyConfig?: Partial<DMPolicyConfig>;
    dmPolicy?: DMPolicy;
    sessionSummarizer?: SessionSummarizer;
    userProfileStore?: UserProfileStore;
    autonomousDefaultEnabled?: boolean;
    autonomousDefaultHours?: number;
    interactionConfig?: InteractionConfig;
    taskConfig?: TaskConfig;
    taskExecutionStore?: TaskExecutionStore;
    runtimeArtifactManager?: RuntimeArtifactManager;
    toolMetadataByName?:
      | ReadonlyMap<string, WorkerToolMetadata>
      | Record<string, WorkerToolMetadata>;
    providerRouter?: import("../agent-core/routing/provider-router.js").ProviderRouter;
    modelIntelligence?: ModelIntelligenceLookup;
    consensusManager?: import("../agent-core/routing/consensus-manager.js").ConsensusManager;
    confidenceEstimator?: import("../agent-core/routing/confidence-estimator.js").ConfidenceEstimator;
    onUsage?: (usage: TaskUsageEvent) => void;
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
    this.defaultLanguage = opts.defaultLanguage ?? "en";
    this.streamInitialTimeoutMs =
      opts.streamInitialTimeoutMs ?? DEFAULT_LLM_STREAM_INITIAL_TIMEOUT_MS;
    this.streamStallTimeoutMs = opts.streamStallTimeoutMs ?? DEFAULT_LLM_STREAM_STALL_TIMEOUT_MS;
    this.stradaConfig = opts.stradaConfig;
    this.instinctRetriever = opts.instinctRetriever ?? null;
    this.trajectoryReplayRetriever = opts.trajectoryReplayRetriever ?? null;
    this.eventEmitter = opts.eventEmitter ?? null;
    this.metricsRecorder = opts.metricsRecorder ?? null;
    this.learningPipeline = opts.learningPipeline ?? null;
    this.interventionEngine = opts.interventionEngine ?? null;
    this.goalDecomposer = opts.goalDecomposer ?? null;
    for (const tree of opts.interruptedGoalTrees ?? []) {
      const existing = this.pendingResumeTrees.get(tree.sessionId) ?? [];
      existing.push(tree);
      this.pendingResumeTrees.set(tree.sessionId, existing);
    }
    this.reRetrievalConfig = opts.reRetrievalConfig;
    this.embeddingProvider = opts.embeddingProvider;
    this.soulLoader = opts.soulLoader ?? null;
    this.dmPolicy = opts.dmPolicy ?? new DMPolicy(opts.channel, opts.dmPolicyConfig);
    this.sessionSummarizer = opts.sessionSummarizer;
    this.userProfileStore = opts.userProfileStore;
    this.autonomousDefaultEnabled = opts.autonomousDefaultEnabled ?? false;
    this.autonomousDefaultHours = opts.autonomousDefaultHours ?? 24;
    this.interactionConfig = opts.interactionConfig ?? DEFAULT_INTERACTION_CONFIG;
    this.taskConfig = opts.taskConfig ?? DEFAULT_TASK_CONFIG;
    this.taskExecutionStore = opts.taskExecutionStore;
    this.runtimeArtifactManager = opts.runtimeArtifactManager;
    if (opts.toolMetadataByName) {
      if (opts.toolMetadataByName instanceof Map) {
        for (const [name, metadata] of opts.toolMetadataByName.entries()) {
          this.toolMetadataByName.set(name, metadata);
        }
      } else {
        for (const [name, metadata] of Object.entries(opts.toolMetadataByName)) {
          this.toolMetadataByName.set(name, metadata);
        }
      }
    }
    this.providerRouter = opts.providerRouter;
    this.modelIntelligence = opts.modelIntelligence;
    this.consensusManager = opts.consensusManager;
    this.confidenceEstimator = opts.confidenceEstimator;
    this.onUsage = opts.onUsage;
    this.getIdentityState = opts.getIdentityState;
    this.crashRecoveryContext = opts.crashRecoveryContext;

    // Build tool registry
    this.tools = new Map();
    this.toolDefinitions = [];
    for (const tool of opts.tools) {
      this.registerTool(tool);
    }

    this.stradaDeps = opts.stradaDeps;
    this.depsSetupComplete = !opts.stradaDeps || opts.stradaDeps.coreInstalled;
    this.systemPrompt = "";
    this.rebuildBaseSystemPrompt();
  }

  async withTaskExecutionContext<T>(
    context: TaskExecutionContext,
    run: () => Promise<T>,
  ): Promise<T> {
    return await this.taskContext.run(context, run);
  }

  private getTaskExecutionContext(): TaskExecutionContext | undefined {
    return this.taskContext.getStore();
  }

  private resolveTaskRunId(chatId?: string, explicitTaskRunId?: string): string | undefined {
    if (explicitTaskRunId) {
      return explicitTaskRunId;
    }
    const scoped = this.getTaskExecutionContext();
    if (!scoped?.taskRunId) {
      return undefined;
    }
    if (!chatId || scoped.chatId === chatId) {
      return scoped.taskRunId;
    }
    return undefined;
  }

  private getInteractiveIterationLimit(): number {
    return Math.max(1, this.taskConfig.interactiveMaxIterations);
  }

  private getBackgroundEpochIterationLimit(): number {
    return Math.max(1, this.taskConfig.backgroundEpochMaxIterations);
  }

  private canAutoContinueBackgroundEpoch(completedEpochCount: number): boolean {
    if (!this.taskConfig.backgroundAutoContinue) {
      return false;
    }

    const maxEpochs = this.taskConfig.backgroundMaxEpochs;
    return maxEpochs === 0 || completedEpochCount < maxEpochs;
  }

  private buildBackgroundIterationBudgetStopMessage(epochCount: number): string {
    const epochLabel = epochCount === 1 ? "epoch" : "epochs";
    return (
      `Background task reached the configured iteration budget after ${epochCount} ${epochLabel}. ` +
      "A checkpoint summary was persisted, but full resume is not yet supported."
    );
  }

  private rebuildBaseSystemPrompt(): void {
    this.systemPrompt =
      STRADA_SYSTEM_PROMPT +
      buildProjectContext(this.projectPath) +
      buildDepsContext(this.stradaDeps) +
      buildCapabilityManifest() +
      (this.readOnly ? getReadOnlySystemPrompt() : "") +
      (this.getIdentityState ? buildIdentitySection(this.getIdentityState()) : "") +
      (this.crashRecoveryContext ? buildCrashNotificationSection(this.crashRecoveryContext) : "");
  }

  private getSupervisorRoutingContext(): SupervisorRoutingContext {
    return {
      providerManager: this.providerManager,
      providerRouter: this.providerRouter as SupervisorRoutingContext["providerRouter"],
      modelIntelligence: this.modelIntelligence,
      metrics: this.metrics,
      rateLimiter: this.rateLimiter,
      taskClassifier: this.taskClassifier,
    };
  }

  private buildStaticSupervisorAssignment(
    role: SupervisorRole,
    providerName: string,
    modelId: string | undefined,
    provider: IAIProvider,
    reason: string,
    traceSource?: ExecutionTraceSource,
    metadata?: {
      assignmentVersion?: number;
      catalogVersion?: string;
    },
  ): SupervisorAssignment {
    return buildStaticSupervisorAssignmentHelper(role, providerName, modelId, provider, reason, traceSource, metadata);
  }

  private buildCatalogAssignmentMetadata(
    providerName: string,
    modelId: string | undefined,
    identityKey: string,
    assignmentVersion?: number,
  ): {
    assignmentVersion?: number;
    catalogVersion?: string;
  } {
    return buildCatalogAssignmentMetadataHelper(this.getSupervisorRoutingContext(), providerName, modelId, identityKey, assignmentVersion);
  }

  private resolveProviderModelId(providerName: string, identityKey: string): string | undefined {
    return resolveProviderModelIdHelper(this.getSupervisorRoutingContext(), providerName, identityKey);
  }

  private resolveSupervisorAssignment(
    role: SupervisorRole,
    task: TaskClassification,
    phase: string | undefined,
    identityKey: string,
    fallbackName: string,
    fallbackProvider: IAIProvider,
    taskDescription?: string,
    projectWorldFingerprint?: string,
  ): SupervisorAssignment {
    return resolveSupervisorAssignmentHelper(this.getSupervisorRoutingContext(), role, task, phase, identityKey, fallbackName, fallbackProvider, taskDescription, projectWorldFingerprint);
  }

  private buildSupervisorExecutionStrategy(
    prompt: string,
    identityKey: string,
    fallbackProvider: IAIProvider,
    projectWorldFingerprint?: string,
  ): SupervisorExecutionStrategy {
    return buildSupervisorExecutionStrategyHelper(this.getSupervisorRoutingContext(), prompt, identityKey, fallbackProvider, projectWorldFingerprint);
  }

  private getPinnedToolTurnAssignment(
    strategy: SupervisorExecutionStrategy,
    phase: AgentPhase,
    pinnedProvider: SupervisorAssignment | null,
  ): SupervisorAssignment {
    return getPinnedToolTurnAssignmentHelper(strategy, phase, pinnedProvider);
  }

  private buildSupervisorRolePrompt(
    strategy: SupervisorExecutionStrategy,
    assignment: SupervisorAssignment,
  ): string {
    return buildSupervisorRolePromptHelper(this.getSupervisorRoutingContext(), strategy, assignment);
  }

  private stripInternalDecisionMarkers(text: string | null | undefined): string {
    return stripInternalDecisionMarkersHelper(text);
  }

  private recordProviderUsage(
    providerName: string,
    usage: ProviderResponse["usage"] | undefined,
    onUsage?: (usage: TaskUsageEvent) => void,
  ): void {
    recordProviderUsageHelper(this.getSupervisorRoutingContext(), providerName, usage, onUsage);
  }

  private toExecutionPhase(phase: AgentPhase): ExecutionPhase {
    return toExecutionPhaseModel(phase);
  }

  private toPhaseOutcomeStatus(decision: "approve" | "continue" | "replan"): PhaseOutcomeStatus {
    return toPhaseOutcomeStatusModel(decision);
  }

  private transitionToVerifierReplan(
    state: AgentState,
    reflectionText?: string | null,
  ): AgentState {
    return transitionToVerifierReplanModel(state, reflectionText);
  }

  private resolveExecutionTraceSource(
    assignment: SupervisorAssignment,
    fallback: ExecutionTraceSource = "supervisor-strategy",
  ): ExecutionTraceSource {
    return resolveExecutionTraceSourceModel(assignment, fallback);
  }

  private recordExecutionTrace(params: {
    chatId?: string;
    identityKey: string;
    assignment: SupervisorAssignment;
    phase: ExecutionPhase;
    source?: ExecutionTraceSource;
    task: TaskClassification;
    reason?: string;
    taskRunId?: string;
  }): void {
    this.providerRouter?.recordExecutionTrace?.(
      buildExecutionTraceRecord({
        identityKey: params.identityKey,
        assignment: params.assignment,
        phase: params.phase,
        source: params.source,
        task: params.task,
        reason: params.reason,
        timestampMs: Date.now(),
        chatId: params.chatId,
        taskRunId: this.resolveTaskRunId(params.chatId, params.taskRunId),
      }),
    );
  }

  private recordPhaseOutcome(params: {
    chatId?: string;
    identityKey: string;
    assignment: SupervisorAssignment;
    phase: ExecutionPhase;
    status: PhaseOutcomeStatus;
    task: TaskClassification;
    source?: ExecutionTraceSource;
    reason?: string;
    telemetry?: PhaseOutcomeTelemetry;
    taskRunId?: string;
  }): void {
    this.providerRouter?.recordPhaseOutcome?.(
      buildPhaseOutcomeRecord({
        identityKey: params.identityKey,
        assignment: params.assignment,
        phase: params.phase,
        status: params.status,
        task: params.task,
        timestampMs: Date.now(),
        source: params.source,
        reason: params.reason,
        telemetry: params.telemetry,
        chatId: params.chatId,
        taskRunId: this.resolveTaskRunId(params.chatId, params.taskRunId),
      }),
    );
  }

  private buildPhaseOutcomeTelemetry(params: {
    state?: AgentState;
    usage?: ProviderResponse["usage"];
    verifierDecision?: VerifierDecision;
    failureReason?: string | null;
    projectWorldFingerprint?: string;
  }): PhaseOutcomeTelemetry | undefined {
    return buildPhaseOutcomeTelemetryModel(params);
  }

  private resolveConsensusReviewAssignment(
    preferredReviewer: SupervisorAssignment,
    currentAssignment: SupervisorAssignment,
    identityKey: string,
  ): SupervisorAssignment | null {
    return resolveConsensusReviewAssignmentHelper(this.getSupervisorRoutingContext(), preferredReviewer, currentAssignment, identityKey);
  }

  private shouldUseSupervisorSynthesis(strategy: SupervisorExecutionStrategy): boolean {
    return Boolean(this.providerRouter) && strategy.usesMultipleProviders;
  }

  private async synthesizeUserFacingResponse(params: {
    chatId: string;
    identityKey: string;
    prompt: string;
    draft: string;
    agentState: AgentState;
    strategy: SupervisorExecutionStrategy;
    systemPrompt: string;
    usageHandler?: (usage: TaskUsageEvent) => void;
  }): Promise<string> {
    const cleanedDraft = this.stripInternalDecisionMarkers(params.draft);
    const exactLiteral = extractExactResponseLiteral(params.prompt);
    if (!cleanedDraft) {
      return "";
    }

    if (!this.shouldUseSupervisorSynthesis(params.strategy)) {
      return applyVisibleResponseContract(params.prompt, cleanedDraft);
    }

    const synthesisProvider = params.strategy.synthesizer.provider;
    const recentSteps = params.agentState.stepResults
      .slice(-8)
      .map((step) => `- [${step.success ? "OK" : "FAIL"}] ${step.toolName}: ${step.summary}`)
      .join("\n");
    const synthesisRequest = [
      "Create the final user-facing response for this completed orchestrated task.",
      "",
      `Original user request:\n${params.prompt}`,
      "",
      params.agentState.plan
        ? `Current plan:\n${params.agentState.plan}\n`
        : "Current plan:\n(none)\n",
      recentSteps
        ? `Verified execution evidence:\n${recentSteps}\n`
        : "Verified execution evidence:\n(no tool evidence)\n",
      `Worker draft:\n${cleanedDraft}`,
      "",
      "Requirements:",
      "- Preserve only verified facts.",
      "- Mention blockers if any remain.",
      "- Remove internal workflow markers.",
      "- Do not expose internal tool names, tool-run checklists, or orchestration instructions unless the user explicitly asked for a plan or audit trail.",
      "- Keep the answer directly usable for the user.",
      ...(exactLiteral
        ? [
            `- The user requested this exact visible output literal: "${exactLiteral}".`,
            "- Return exactly that literal if it is consistent with the verified execution evidence.",
          ]
        : []),
    ].join("\n");

    try {
      const synthesisResponse = await synthesisProvider.chat(
        `${params.systemPrompt}\n\n${SUPERVISOR_SYNTHESIS_SYSTEM_PROMPT}${this.buildSupervisorRolePrompt(params.strategy, params.strategy.synthesizer)}`,
        [{ role: "user", content: synthesisRequest }],
        [],
      );
      this.recordExecutionTrace({
        chatId: params.chatId,
        identityKey: params.identityKey,
        assignment: params.strategy.synthesizer,
        phase: "synthesis",
        source: "synthesis",
        task: params.strategy.task,
      });
      this.recordProviderUsage(
        params.strategy.synthesizer.providerName,
        synthesisResponse.usage,
        params.usageHandler,
      );
      const synthesizedText = this.stripInternalDecisionMarkers(synthesisResponse.text).trim();
      const visibleText = synthesizedText
        ? applyVisibleResponseContract(params.prompt, synthesizedText)
        : this.buildSafeVisibleFallbackFromDraft(
            params.prompt,
            cleanedDraft,
            params.strategy.task,
            false,
          );
      this.recordPhaseOutcome({
        chatId: params.chatId,
        identityKey: params.identityKey,
        assignment: params.strategy.synthesizer,
        phase: "synthesis",
        source: "synthesis",
        status: synthesizedText ? "approved" : "failed",
        task: params.strategy.task,
        reason: synthesizedText
          ? "Synthesis produced the final user-facing response."
          : "Synthesis returned no safe visible text; falling back to the boundary-safe summary.",
        telemetry: this.buildPhaseOutcomeTelemetry({
          usage: synthesisResponse.usage,
          failureReason: synthesizedText ? undefined : cleanedDraft,
        }),
      });
      return visibleText;
    } catch {
      this.recordPhaseOutcome({
        chatId: params.chatId,
        identityKey: params.identityKey,
        assignment: params.strategy.synthesizer,
        phase: "synthesis",
        source: "synthesis",
        status: "failed",
        task: params.strategy.task,
        reason: "Synthesis failed; falling back to the boundary-safe summary.",
        telemetry: this.buildPhaseOutcomeTelemetry({
          failureReason: cleanedDraft,
        }),
      });
      return this.buildSafeVisibleFallbackFromDraft(
        params.prompt,
        cleanedDraft,
        params.strategy.task,
        false,
      );
    }
  }

  async synthesizeGoalExecutionResult(params: {
    prompt: string;
    goalTree: GoalTree;
    executionResult: import("../goals/goal-executor.js").ExecutionResult;
    chatId: string;
    conversationId?: string;
    userId?: string;
    channelType?: string;
    onUsage?: (usage: TaskUsageEvent) => void;
    childWorkerResults?: readonly WorkerRunResult[];
  }): Promise<string> {
    const identityKey = resolveIdentityKey(params.chatId, params.userId, params.conversationId, this.userProfileStore, params.channelType);
    const fallbackProvider = this.providerManager.getProvider(identityKey);
    const strategy = this.buildSupervisorExecutionStrategy(
      params.prompt,
      identityKey,
      fallbackProvider,
    );
    const synthesisProvider = strategy.synthesizer.provider;
    const rawDraft = params.executionResult.results
      .filter((result) => result.result)
      .map((result) => `## Sub-goal: ${result.task}\n\n${result.result}`)
      .join("\n\n---\n\n");

    if (!rawDraft.trim()) {
      return "";
    }

    const verifiedSteps = params.executionResult.results
      .map((result) => {
        if (result.result) {
          return `- [OK] ${result.task}: ${result.result}`;
        }
        return `- [FAIL] ${result.task}: ${result.error ?? "Unknown failure"}`;
      })
      .join("\n");
    const childEvidence = params.childWorkerResults?.length
      ? params.childWorkerResults
        .map((result) => {
          const touchedSummary = result.touchedFiles.length > 0
            ? ` touched=${result.touchedFiles.join(", ")}`
            : "";
          const findingSummary = result.reviewFindings.length > 0
            ? ` findings=${result.reviewFindings.map((finding) => finding.message).join(" | ")}`
            : "";
          return `- [${result.status.toUpperCase()}] ${result.provider}${touchedSummary}${findingSummary}`;
        })
        .join("\n")
      : "(none)";

    const synthesisRequest = [
      "Create the final user-facing response for this completed decomposed task.",
      "",
      `Original user request:\n${params.prompt}`,
      "",
      `Goal summary:\n${summarizeTree(params.goalTree)}`,
      "",
      verifiedSteps
        ? `Verified sub-goal outcomes:\n${verifiedSteps}`
        : "Verified sub-goal outcomes:\n(none)",
      "",
      `Child worker evidence:\n${childEvidence}`,
      "",
      `Raw sub-goal draft:\n${rawDraft}`,
      "",
      "Requirements:",
      "- Respond as Strada's final user-facing answer, not as an internal sub-goal worker.",
      "- Do not expose internal sub-goal headers, plan scaffolding, or decomposition notes.",
      "- Preserve only verified facts from the provided execution evidence.",
      "- If the original request asks for an exact visible output literal, obey it.",
    ].join("\n");

    try {
      const synthesisResponse = await synthesisProvider.chat(
        `${this.systemPrompt}\n\n${SUPERVISOR_SYNTHESIS_SYSTEM_PROMPT}${this.buildSupervisorRolePrompt(strategy, strategy.synthesizer)}`,
        [{ role: "user", content: synthesisRequest }],
        [],
      );
      this.recordExecutionTrace({
        chatId: params.chatId,
        identityKey,
        assignment: strategy.synthesizer,
        phase: "synthesis",
        source: "synthesis",
        task: strategy.task,
      });
      this.recordProviderUsage(
        strategy.synthesizer.providerName,
        synthesisResponse.usage,
        params.onUsage,
      );
      this.recordPhaseOutcome({
        chatId: params.chatId,
        identityKey,
        assignment: strategy.synthesizer,
        phase: "synthesis",
        source: "synthesis",
        status: "approved",
        task: strategy.task,
        reason: "Goal synthesis produced the final user-facing response.",
        telemetry: this.buildPhaseOutcomeTelemetry({
          usage: synthesisResponse.usage,
        }),
      });
      return this.buildSafeVisibleFallbackFromDraft(
        params.prompt,
        this.stripInternalDecisionMarkers(synthesisResponse.text) || rawDraft,
        strategy.task,
      );
    } catch {
      this.recordPhaseOutcome({
        chatId: params.chatId,
        identityKey,
        assignment: strategy.synthesizer,
        phase: "synthesis",
        source: "synthesis",
        status: "failed",
        task: strategy.task,
        reason: "Goal synthesis failed; falling back to the raw execution draft.",
        telemetry: this.buildPhaseOutcomeTelemetry({
          failureReason: rawDraft,
        }),
      });
      return this.buildSafeVisibleFallbackFromDraft(params.prompt, rawDraft, strategy.task);
    }
  }

  private toWorkerVerificationResults(
    result: VerifierPipelineResult | null | undefined,
  ): WorkerVerificationResult[] {
    if (!result) {
      return [];
    }

    return result.checks.map((check) => ({
      name: check.name,
      status: check.status,
      summary: check.summary,
    }));
  }

  private toWorkerReviewFindings(
    result: VerifierPipelineResult | null | undefined,
  ): WorkerReviewFinding[] {
    if (!result) {
      return [];
    }

    const findings: WorkerReviewFinding[] = [];
    for (const check of result.checks) {
      if (check.status === "issues") {
        findings.push({
          source: check.name === "completion-review" ? "completion-review" : "integration",
          severity: check.gate ? "error" : "warning",
          message: check.summary,
        });
      }
    }

    const reviewDecision = result.reviewDecision;
    if (reviewDecision?.reviews) {
      const reviewSources: Array<{
        key: keyof NonNullable<typeof reviewDecision.reviews>;
        source: WorkerReviewFinding["source"];
      }> = [
        { key: "code", source: "code-review" },
        { key: "simplify", source: "simplify" },
        { key: "security", source: "security-review" },
      ];
      for (const reviewSource of reviewSources) {
        if (reviewDecision.reviews[reviewSource.key] === "issues") {
          findings.push({
            source: reviewSource.source,
            severity: "error",
            message: `${reviewSource.source} found issues during completion review.`,
          });
        }
      }
    }

    for (const finding of reviewDecision?.findings ?? []) {
      findings.push({
        source: "completion-review",
        severity: result.decision === "approve" ? "info" : "warning",
        message: finding,
      });
    }

    for (const stageResult of result.stageResults ?? []) {
      const source = stageResult.stage === "code"
        ? "code-review"
        : stageResult.stage === "simplify"
          ? "simplify"
          : "security-review";
      for (const finding of stageResult.findings ?? []) {
        findings.push({
          source,
          severity: stageResult.status === "issues" ? "warning" : "info",
          message: finding,
        });
      }
    }

    return findings;
  }

  private buildWorkerArtifacts(params: {
    workspaceLease?: WorkspaceLease;
    touchedFiles: readonly string[];
    finalSummary: string;
  }): WorkerArtifactMetadata[] {
    const artifacts: WorkerArtifactMetadata[] = [];
    if (params.workspaceLease) {
      artifacts.push({
        kind: "workspace",
        summary: `Worker executed in isolated workspace ${params.workspaceLease.id}.`,
        path: params.workspaceLease.path,
      });
    }
    if (params.touchedFiles.length > 0) {
      artifacts.push({
        kind: "patch",
        summary: `Touched ${params.touchedFiles.length} file(s).`,
      });
    }
    artifacts.push({
      kind: "result",
      summary: params.finalSummary,
    });
    return artifacts;
  }

  /**
   * Dynamically add a tool to the orchestrator's available tools.
   * Used by chain synthesis to make composite tools available to the LLM.
   */
  addTool(tool: ITool, metadata?: WorkerToolMetadata): void {
    this.registerTool(tool, metadata);
  }

  /**
   * Dynamically remove a tool from the orchestrator's available tools.
   * Used by chain synthesis to remove invalidated composite tools.
   */
  removeTool(name: string): void {
    this.tools.delete(name);
    this.toolMetadataByName.delete(name);
    const idx = this.toolDefinitions.findIndex((td) => td.name === name);
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

  private getVisibleTranscript(session: Session): ConversationMessage[] {
    return getVisibleTranscriptHelper(session);
  }

  private appendVisibleUserMessage(session: Session, content: string | MessageContent[]): void {
    appendVisibleUserMessageHelper(session, content);
  }

  private appendVisibleAssistantMessage(session: Session, content: string): void {
    appendVisibleAssistantMessageHelper(session, content);
  }

  private async sendVisibleAssistantText(
    chatId: string,
    session: Session,
    content: string,
  ): Promise<void> {
    this.appendVisibleAssistantMessage(session, content);
    await this.channel.sendText(chatId, content);
  }

  private async sendVisibleAssistantMarkdown(
    chatId: string,
    session: Session,
    content: string,
  ): Promise<void> {
    this.appendVisibleAssistantMessage(session, content);
    await this.channel.sendMarkdown(chatId, content);
  }

  private buildWorkerToolDefinitions(
    task: TaskClassification,
    phase: AgentPhase,
    role: SupervisorAssignment["role"],
  ): Array<{
    name: string;
    description: string;
    input_schema: import("../types/index.js").JsonObject;
  }> {
    const allowWriteTools =
      role === "executor" &&
      task.type !== "analysis" &&
      task.type !== "simple-question" &&
      phase !== AgentPhase.PLANNING &&
      phase !== AgentPhase.REPLANNING &&
      phase !== AgentPhase.REFLECTING;

    return this.toolDefinitions.filter((definition) => {
      const metadata = this.toolMetadataByName.get(definition.name);
      if (metadata?.controlPlaneOnly) {
        return false;
      }
      if (metadata?.requiresBridge && metadata.available === false) {
        return false;
      }
      if (!allowWriteTools && metadata?.readOnly === false) {
        return false;
      }
      return true;
    });
  }

  private getClarificationContext(): ClarificationContext {
    return {
      interactionConfig: this.interactionConfig,
      toolMetadataByName: this.toolMetadataByName,
    };
  }

  private canInspectLocally(
    prompt: string,
    task: TaskClassification,
    availableToolNames: readonly string[],
  ): boolean {
    return canInspectLocallyHelper(this.getClarificationContext(), prompt, task, availableToolNames);
  }

  private decideUserVisibleBoundary(params: {
    chatId: string;
    prompt: string;
    workerDraft: string;
    visibleDraft?: string;
    task: TaskClassification;
    state: AgentState;
    selfVerification: SelfVerification;
    taskStartedAtMs: number;
    availableToolNames: readonly string[];
    terminalFailureReported?: boolean;
  }): InteractionBoundaryDecision {
    return decideUserVisibleBoundaryHelper(this.getClarificationContext(), params);
  }

  private buildSafeVisibleFallbackFromDraft(
    prompt: string,
    draft: string,
    task: TaskClassification,
    allowDirectFinalAnswer = true,
  ): string {
    return buildSafeVisibleFallbackFromDraftHelper(prompt, draft, task, allowDirectFinalAnswer);
  }

  private formatPlanReviewMessage(draft: string): string {
    return [
      "Plan review requested before execution.",
      "",
      draft.trim(),
      "",
      "Reply with your approval or requested changes before write-capable execution continues.",
    ].join("\n");
  }

  private getPendingPlanReviewVisibleText(chatId: string): string | null {
    const gate = this.interactionPolicy.get(chatId);
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

  private getPendingSelfManagedWriteRejectionVisibleText(
    session: Session,
    draft: string | null | undefined,
  ): string | null {
    const normalizedDraft = this.stripInternalDecisionMarkers(draft ?? "").trim();
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

  private formatBoundaryVisibleText(decision: InteractionBoundaryDecision): string | undefined {
    if (!decision.visibleText) {
      return undefined;
    }
    return decision.kind === "plan_review"
      ? this.formatPlanReviewMessage(decision.visibleText)
      : decision.visibleText;
  }

  private async resolveVisibleDraftDecision(params: {
    chatId: string;
    identityKey: string;
    prompt: string;
    draft: string;
    agentState: AgentState;
    strategy: SupervisorExecutionStrategy;
    systemPrompt: string;
    selfVerification: SelfVerification;
    taskStartedAtMs: number;
    availableToolNames: readonly string[];
    terminalFailureReported?: boolean;
    usageHandler?: (usage: TaskUsageEvent) => void;
  }): Promise<InteractionBoundaryDecision> {
    const cleanedDraft = this.stripInternalDecisionMarkers(params.draft).trim();
    const explicitPlanReview = userExplicitlyAskedForPlan(params.prompt);

    if (
      explicitPlanReview &&
      draftLooksLikeInternalPlanArtifact(cleanedDraft, {
        toolNames: params.availableToolNames,
      })
    ) {
      this.interactionPolicy.requirePlanReview(
        params.chatId,
        "user explicitly asked to review a plan first",
        cleanedDraft,
      );
      return {
        kind: "plan_review",
        reason: "The user explicitly asked to review the plan before execution.",
        visibleText: this.formatPlanReviewMessage(cleanedDraft),
      };
    }

    const rawBoundary = this.decideUserVisibleBoundary({
      chatId: params.chatId,
      prompt: params.prompt,
      workerDraft: cleanedDraft,
      task: params.strategy.task,
      state: params.agentState,
      selfVerification: params.selfVerification,
      taskStartedAtMs: params.taskStartedAtMs,
      availableToolNames: params.availableToolNames,
      terminalFailureReported: params.terminalFailureReported,
    });
    if (rawBoundary.kind !== "final_answer") {
      return rawBoundary;
    }

    const visibleDraft = cleanedDraft
      ? await this.synthesizeUserFacingResponse({
          chatId: params.chatId,
          identityKey: params.identityKey,
          prompt: params.prompt,
          draft: cleanedDraft,
          agentState: params.agentState,
          strategy: params.strategy,
          systemPrompt: params.systemPrompt,
          usageHandler: params.usageHandler,
        })
      : "";
    return this.decideUserVisibleBoundary({
      chatId: params.chatId,
      prompt: params.prompt,
      workerDraft: cleanedDraft,
      visibleDraft,
      task: params.strategy.task,
      state: params.agentState,
      selfVerification: params.selfVerification,
      taskStartedAtMs: params.taskStartedAtMs,
      availableToolNames: params.availableToolNames,
      terminalFailureReported: params.terminalFailureReported,
    });
  }

  private getClarificationReviewAssignment(
    identityKey: string,
    strategy?: SupervisorExecutionStrategy,
  ): SupervisorAssignment {
    if (strategy) {
      return this.buildStaticSupervisorAssignment(
        "reviewer",
        strategy.reviewer.providerName,
        strategy.reviewer.modelId,
        strategy.reviewer.provider,
        "reviewed whether clarification should stay internal or be surfaced to the user",
        "clarification-review",
        {
          assignmentVersion: strategy.reviewer.assignmentVersion,
          catalogVersion: strategy.reviewer.catalogVersion,
        },
      );
    }

    const fallbackProvider = this.providerManager.getProvider(identityKey);
    return this.buildStaticSupervisorAssignment(
      "reviewer",
      fallbackProvider.name,
      this.resolveProviderModelId(fallbackProvider.name, identityKey),
      fallbackProvider,
      "reviewed whether clarification should stay internal or be surfaced to the user",
      "clarification-review",
      this.buildCatalogAssignmentMetadata(
        fallbackProvider.name,
        this.resolveProviderModelId(fallbackProvider.name, identityKey),
        identityKey,
      ),
    );
  }

  private async reviewClarification(params: {
    chatId: string;
    identityKey: string;
    prompt: string;
    draft: string;
    state: AgentState;
    touchedFiles?: readonly string[];
    strategy?: SupervisorExecutionStrategy;
    usageHandler?: (usage: TaskUsageEvent) => void;
  }): Promise<{
    decision: ReturnType<typeof sanitizeClarificationReviewDecision>;
    evidence: ReturnType<typeof collectClarificationReviewEvidence>;
  }> {
    const evidence = collectClarificationReviewEvidence({
      prompt: params.prompt,
      draft: params.draft,
      state: params.state,
      projectPath: this.projectPath,
      touchedFiles: params.touchedFiles,
    });
    const reviewer = this.getClarificationReviewAssignment(params.identityKey, params.strategy);
    const reviewTask = params.strategy?.task ?? this.taskClassifier.classify(params.prompt);
    const reviewStrategy = params.strategy ?? {
      task: reviewTask,
      planner: reviewer,
      executor: reviewer,
      reviewer,
      synthesizer: reviewer,
      usesMultipleProviders: false,
    };

    try {
      const reviewResponse = await reviewer.provider.chat(
        `${this.systemPrompt}\n\n${CLARIFICATION_REVIEW_SYSTEM_PROMPT}${this.buildSupervisorRolePrompt(reviewStrategy, reviewer)}`,
        [
          {
            role: "user",
            content: buildClarificationReviewRequest(evidence),
          },
        ],
        [],
      );
      this.recordExecutionTrace({
        chatId: params.chatId,
        identityKey: params.identityKey,
        assignment: reviewer,
        phase: "clarification-review",
        source: "clarification-review",
        task: reviewTask,
      });
      this.recordAuxiliaryUsage(reviewer.providerName, reviewResponse.usage, params.usageHandler);
      const decision = sanitizeClarificationReviewDecision(
        parseClarificationReviewDecision(reviewResponse.text),
      );
      this.recordPhaseOutcome({
        chatId: params.chatId,
        identityKey: params.identityKey,
        assignment: reviewer,
        phase: "clarification-review",
        source: "clarification-review",
        status:
          decision?.decision === "ask_user"
            ? "blocked"
            : decision?.decision === "blocked"
              ? "blocked"
              : decision?.decision === "internal_continue"
                ? "continued"
                : "approved",
        task: reviewTask,
        reason: decision?.reason ?? "Clarification review completed.",
        telemetry: this.buildPhaseOutcomeTelemetry({
          usage: reviewResponse.usage,
        }),
      });
      return { decision, evidence };
    } catch (error) {
      getLogger().warn("Clarification review provider failed", {
        chatId: params.chatId,
        provider: reviewer.providerName,
        error: error instanceof Error ? error.message : String(error),
      });
      this.recordPhaseOutcome({
        chatId: params.chatId,
        identityKey: params.identityKey,
        assignment: reviewer,
        phase: "clarification-review",
        source: "clarification-review",
        status: "failed",
        task: reviewTask,
        reason: "Clarification review provider failed; falling back to Strada-side decision.",
        telemetry: this.buildPhaseOutcomeTelemetry({
          failureReason: params.draft,
        }),
      });
    }

    return {
      decision: evidence.canInspectLocally
        ? {
            decision: "internal_continue",
            reason: "Strada still has a local inspection path and should continue internally.",
            recommendedNextAction:
              "Inspect local files, logs, tests, or runtime state before asking the user anything else.",
          }
        : {
            decision: "blocked",
            reason:
              "External clarification is still required because no local inspection path remains.",
            blockingType: "missing_external_info",
            question: "Please share the missing external detail needed to continue.",
          },
      evidence,
    };
  }

  private async resolveDraftClarificationIntervention(params: {
    chatId: string;
    identityKey: string;
    prompt: string;
    draft: string;
    state: AgentState;
    strategy?: SupervisorExecutionStrategy;
    touchedFiles?: readonly string[];
    usageHandler?: (usage: TaskUsageEvent) => void;
  }): Promise<ClarificationIntervention> {
    const cleanedDraft = this.stripInternalDecisionMarkers(params.draft);
    if (!cleanedDraft) {
      return { kind: "none" };
    }
    if (!shouldRunClarificationReview(cleanedDraft)) {
      return { kind: "none" };
    }

    const reviewResult = await this.reviewClarification({
      ...params,
      draft: cleanedDraft,
    });

    return resolveDraftClarificationInterventionHelper(
      this.getClarificationContext(),
      params.draft,
      reviewResult,
    );
  }

  private async resolveAskUserClarificationIntervention(params: {
    chatId: string;
    identityKey: string;
    toolCall: ToolCall;
    prompt: string;
    state: AgentState;
    strategy?: SupervisorExecutionStrategy;
    touchedFiles?: readonly string[];
    usageHandler?: (usage: TaskUsageEvent) => void;
  }): Promise<ClarificationIntervention> {
    const question = this.normalizeInteractiveText(params.toolCall.input["question"]);
    const context = this.normalizeInteractiveText(params.toolCall.input["context"]);
    const options = Array.isArray(params.toolCall.input["options"])
      ? params.toolCall.input["options"]
          .map((option) => this.normalizeInteractiveText(option))
          .filter(Boolean)
      : [];
    const recommended = this.normalizeInteractiveText(params.toolCall.input["recommended"]);
    const draft = [
      context ? `Context: ${context}` : "",
      question ? `Question: ${question}` : "",
      options.length > 0 ? `Options: ${options.join(" | ")}` : "",
      recommended ? `Recommended: ${recommended}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const reviewResult = await this.reviewClarification({
      ...params,
      draft,
    });

    return resolveAskUserClarificationInterventionHelper(
      this.getClarificationContext(),
      params.toolCall.input,
      reviewResult,
      (value) => this.normalizeInteractiveText(value),
    );
  }

  private getContextBuilderDeps(): ContextBuilderDeps {
    return {
      memoryManager: this.memoryManager,
      ragPipeline: this.ragPipeline,
      embeddingProvider: this.embeddingProvider,
      taskExecutionStore: this.taskExecutionStore,
      soulLoader: this.soulLoader,
      dmPolicy: this.dmPolicy,
      activeGoalTrees: this.activeGoalTrees,
      projectPath: this.projectPath,
      defaultLanguage: this.defaultLanguage,
      systemPrompt: this.systemPrompt,
      taskClassifier: this.taskClassifier,
      toolMetadataByName: this.toolMetadataByName,
      toolDefinitions: this.toolDefinitions,
      runtimeArtifactManager: this.runtimeArtifactManager as ContextBuilderDeps["runtimeArtifactManager"],
      trajectoryReplayRetriever: this.trajectoryReplayRetriever as ContextBuilderDeps["trajectoryReplayRetriever"],
      getTaskExecutionContext: () => this.getTaskExecutionContext(),
      runtimeArtifactMatches: this.runtimeArtifactMatches,
      buildWorkerToolDefinitions: (task, phase, role) =>
        this.buildWorkerToolDefinitions(task, phase, role as SupervisorAssignment["role"]),
    };
  }

  /**
   * Build a complete system prompt with all context layers.
   * Shared by both runAgentLoop (interactive) and runBackgroundTask (background).
   */
  private async buildSystemPromptWithContext(params: {
    chatId: string;
    conversationScope: string;
    identityKey: string;
    userId?: string;
    channelType?: string;
    prompt: string;
    personaContent?: string;
    profile: {
      displayName?: string;
      language: string;
      activePersona: string;
      preferences: unknown;
      contextSummary?: string;
    } | null;
    preComputedEmbedding?: number[];
  }): Promise<{
    systemPrompt: string;
    initialContentHashes: string[];
    projectWorldSummary?: string;
    projectWorldFingerprint?: string;
  }> {
    return buildSystemPromptWithContextHelper(this.getContextBuilderDeps(), params);
  }

  /**
   * Public accessor for active sessions (used by dashboard /api/sessions).
   */
  getSessions(): Map<string, { lastActivity: Date; messageCount: number }> {
    const result = new Map<string, { lastActivity: Date; messageCount: number }>();
    for (const [chatId, session] of this.sessions) {
      result.set(chatId, {
        lastActivity: session.lastActivity,
        messageCount: session.messages.length,
      });
    }
    return result;
  }

  async deliverPostSetupBootstrap(
    context: PostSetupBootstrapContext,
    bootstrap: PostSetupBootstrap,
  ): Promise<void> {
    const session = this.getOrCreateSession(context.chatId);
    if (session.postSetupBootstrapDelivered) {
      return;
    }

    session.postSetupBootstrapDelivered = true;
    session.lastActivity = new Date();
    session.profileKey ??= context.profileId;
    session.conversationScope ??= context.profileId;
    session.mixedParticipants = false;

    await this.sendVisibleAssistantMarkdown(
      context.chatId,
      session,
      buildPostSetupWelcomeMessage(bootstrap.language),
    );

    if (bootstrap.autonomy?.enabled) {
      const expiresAt =
        typeof bootstrap.autonomy.hours === "number"
          ? Date.now() + bootstrap.autonomy.hours * 3600_000
          : undefined;

      await this.userProfileStore?.setAutonomousMode(context.profileId, true, expiresAt);
      this.dmPolicy?.initFromProfile(
        context.chatId,
        {
          autonomousMode: true,
          ...(expiresAt ? { autonomousExpiresAt: expiresAt } : {}),
        },
        context.profileId,
      );
    }
  }

  /**
   * Handle an incoming message from any channel.
   * Uses a per-session lock to prevent concurrent processing.
   */
  async handleMessage(msg: IncomingMessage): Promise<void> {
    const { chatId } = msg;
    const identityKey = resolveIdentityKey(chatId, msg.userId, msg.conversationId, this.userProfileStore, msg.channelType);
    const existingTaskContext = this.getTaskExecutionContext();
    const taskRunId = existingTaskContext?.taskRunId ?? `taskrun_${randomUUID()}`;
    const taskContext: TaskExecutionContext = {
      chatId,
      conversationId: msg.conversationId,
      userId: msg.userId,
      identityKey,
      taskRunId,
    };

    // Intercept messages if Strada.Core is missing and setup not complete
    if (!this.depsSetupComplete && this.stradaDeps && !this.stradaDeps.coreInstalled) {
      await this.withTaskExecutionContext(taskContext, async () => {
        await this.handleDepsSetup(msg);
      });
      return;
    }

    // Handle pending modules prompt after core installation
    if (this.pendingModulesPrompt.get(chatId)) {
      await this.withTaskExecutionContext(taskContext, async () => {
        await this.handleModulesPrompt(msg);
      });
      return;
    }

    // Per-session concurrency lock: queue messages for the same chat
    const prev = this.sessionLocks.get(chatId) ?? Promise.resolve();
    const current = prev.then(() =>
      this.withTaskExecutionContext(taskContext, async () => this.processMessage(msg)),
    );
    const tracked = current.catch((err) => {
      getLogger().error("Session lock error", {
        chatId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    this.sessionLocks.set(chatId, tracked);
    try {
      await current;
    } finally {
      // Clean up resolved lock to prevent unbounded map growth
      if (this.sessionLocks.get(chatId) === tracked) {
        this.sessionLocks.delete(chatId);
      }
    }
  }

  /**
   * Run a task in the background with abort support and progress reporting.
   * Used by the task system for async execution.
   */
  async runWorkerTask(request: WorkerRunRequest & {
    signal: AbortSignal;
    onProgress: (message: TaskProgressUpdate) => void;
    attachments?: Attachment[];
    onUsage?: (usage: TaskUsageEvent) => void;
    parentMetricId?: string;
  }): Promise<WorkerRunResult> {
    const collector: WorkerRunCollector = {
      toolTrace: [],
      childWorkerResults: [],
    };
    let visibleResponse = "";
    let thrownReason: string | undefined;
    try {
      visibleResponse = await this.runBackgroundTask(
        request.prompt,
        {
          signal: request.signal,
          onProgress: request.onProgress,
          chatId: request.chatId,
          channelType: request.channelType ?? "cli",
          taskRunId: request.taskRunId,
          conversationId: request.conversationId,
          userId: request.userId,
          attachments: request.attachments,
          onUsage: request.onUsage,
          parentMetricId: request.parentMetricId,
          workspaceLease: request.workspaceLease,
          __workerCollector: collector,
          __workerMode: request.mode,
        } as BackgroundTaskOptions & {
          __workerCollector: WorkerRunCollector;
          __workerMode?: ToolExecutionMode;
        },
      );
    } catch (error) {
      thrownReason = error instanceof Error ? error.message : String(error);
      visibleResponse = collector.finalVisibleResponse ?? "";
    }

    const finalAssignment = collector.lastAssignment;
    const providerName = finalAssignment?.providerName ?? "unknown";
    const modelId = finalAssignment?.modelId;
    const catalogVersion =
      finalAssignment?.catalogVersion ??
      createCatalogVersion({
        provider: providerName,
        model: modelId,
        updatedAt: undefined,
        stale: false,
        degraded: false,
      });
    const verificationResults = this.toWorkerVerificationResults(collector.verifierResult);
    const reviewFindings = this.toWorkerReviewFindings(collector.verifierResult);
    const touchedFiles = [
      ...new Set([
        ...(collector.touchedFiles ?? []),
        ...collector.childWorkerResults.flatMap((result) => [...result.touchedFiles]),
      ]),
    ];
    const finalSummary = collector.finalSummary ?? (visibleResponse || thrownReason || "");

    return {
      status: collector.status ?? (thrownReason ? "failed" : "completed"),
      finalSummary,
      visibleResponse,
      provider: providerName,
      model: modelId,
      catalogVersion,
      assignmentVersion: finalAssignment?.assignmentVersion ?? 0,
      workspaceId: request.workspaceLease?.id,
      touchedFiles,
      toolTrace: collector.toolTrace,
      verificationResults,
      reviewFindings,
      artifacts: this.buildWorkerArtifacts({
        workspaceLease: request.workspaceLease,
        touchedFiles,
        finalSummary,
      }),
      reason: collector.reason ?? thrownReason,
    };
  }

  async runBackgroundTask(prompt: string, options: BackgroundTaskOptions): Promise<string> {
    const { signal, onProgress, chatId } = options;
    const workerCollector = (
      options as BackgroundTaskOptions & { __workerCollector?: WorkerRunCollector }
    ).__workerCollector;
    const workerMode = (
      options as BackgroundTaskOptions & { __workerMode?: ToolExecutionMode }
    ).__workerMode ?? "background";
    const conversationScope = resolveConversationScope(chatId, options.conversationId);
    const identityKey = resolveIdentityKey(chatId, options.userId, options.conversationId, this.userProfileStore, options.channelType);
    const taskRunId =
      options.taskRunId?.trim() ||
      this.getTaskExecutionContext()?.taskRunId ||
      `taskrun_${randomUUID()}`;

    return await this.withTaskExecutionContext(
      {
        chatId,
        conversationId: options.conversationId,
        userId: options.userId,
        identityKey,
        taskRunId,
      },
      async () => {
        const logger = getLogger();
        const fallbackProvider = this.providerManager.getProvider(identityKey);
        let executionStrategy = this.buildSupervisorExecutionStrategy(
          prompt,
          identityKey,
          fallbackProvider,
        );

        // ─── Metrics: start recording ────────────────────────────────────
        const taskType = options.parentMetricId ? ("subtask" as const) : ("background" as const);
        const metricId = this.metricsRecorder?.startTask({
          sessionId: chatId,
          taskDescription: prompt.slice(0, 200),
          taskType,
          parentTaskId: options.parentMetricId,
        });
        // ────────────────────────────────────────────────────────────────

        // Build user content with vision support if attachments present
        const supportsVision = fallbackProvider.capabilities.vision;
        const userContent = buildUserContent(
          prompt || DEFAULT_IMAGE_PROMPT,
          options.attachments,
          supportsVision,
        );
        const initialUserMessage: ConversationMessage = { role: "user", content: userContent };
        const session: Session = {
          messages: [initialUserMessage],
          visibleMessages: [initialUserMessage],
          lastActivity: new Date(),
        };

        let profile = this.userProfileStore?.getProfile(identityKey) ?? null;

        // Touch user profile (debounced)
        if (this.userProfileStore && profile) {
          const lastTouch = this.lastPersistTime.get(`touch:${identityKey}`) ?? 0;
          if (Date.now() - lastTouch > 60_000) {
            this.userProfileStore.touchLastSeen(identityKey);
            this.lastPersistTime.set(`touch:${identityKey}`, Date.now());
          }
        }

        await this.maybeUpdateUserProfileFromPrompt(chatId, identityKey, prompt, options.userId);
        profile = this.userProfileStore?.getProfile(identityKey) ?? profile;

        // Load autonomous mode from profile at session start
        if (this.dmPolicy && this.userProfileStore) {
          try {
            const autonomousState = await resolveAutonomousModeWithDefault(
              this.userProfileStore,
              identityKey,
              {
                enabled: this.autonomousDefaultEnabled,
                hours: this.autonomousDefaultHours,
              },
            );
            if (autonomousState.enabled) {
              this.dmPolicy.initFromProfile(
                chatId,
                {
                  autonomousMode: true,
                  autonomousExpiresAt: autonomousState.expiresAt,
                },
                options.userId,
              );
            } else {
              this.dmPolicy.initFromProfile(chatId, { autonomousMode: false }, options.userId);
            }
          } catch {
            // Autonomous mode restoration failure is non-fatal
          }
        }
        // ────────────────────────────────────────────────────────────────────

        // Pre-compute embedding once for memory + RAG search (avoids redundant calls)
        let bgEmbedding: number[] | undefined;
        if (this.embeddingProvider && prompt) {
          try {
            const batch = await this.embeddingProvider.embed([prompt]);
            bgEmbedding = batch.embeddings[0];
          } catch {
            // Embedding failure is non-fatal; downstream calls will embed on demand
          }
        }

        // Build system prompt with all context layers (DRY: shared with runAgentLoop)
        const {
          systemPrompt: builtPrompt,
          initialContentHashes: bgInitialContentHashes,
          projectWorldSummary: bgProjectWorldSummary,
          projectWorldFingerprint: bgProjectWorldFingerprint,
        } = await this.buildSystemPromptWithContext({
          chatId,
          conversationScope,
          identityKey,
          channelType: options.channelType,
          prompt,
          profile,
          preComputedEmbedding: bgEmbedding,
        });
        let systemPrompt = builtPrompt;
        executionStrategy = this.buildSupervisorExecutionStrategy(
          prompt,
          identityKey,
          fallbackProvider,
          bgProjectWorldFingerprint,
        );

        // ─── PAOR State Machine ──────────────────────────────────────────────
        let bgAgentState = createInitialState(prompt);

        if (this.instinctRetriever) {
          try {
            const insightResult = await this.instinctRetriever.getInsightsForTask(prompt);
            if (insightResult.insights.length > 0) {
              bgAgentState = { ...bgAgentState, learnedInsights: insightResult.insights };
              const insightsText = insightResult.insights.join("\n");
              systemPrompt += `\n\n## Learned Insights\n${insightsText}\n`;
            }
          } catch {
            // Non-fatal
          }
        }

        const BG_REFLECT_INTERVAL = 3;
        // ────────────────────────────────────────────────────────────────────

        // ─── Memory Re-retrieval: create refresher for background path ───
        const bgMemoryRefresher = this.createMemoryRefresher(bgInitialContentHashes);
        // ────────────────────────────────────────────────────────────────

        // Autonomy layer
        const errorRecovery = new ErrorRecoveryEngine();
        const taskPlanner = new TaskPlanner({
          iterationBudget: this.getBackgroundEpochIterationLimit(),
        });
        const selfVerification = new SelfVerification();
        const executionJournal = new ExecutionJournal(prompt);
        const controlLoopTracker = new ControlLoopTracker();
        const progressTitle = prompt.replace(/\s+/g, " ").trim().slice(0, 80) || "Task";
        const progressLanguage = (profile?.language ?? this.defaultLanguage) as ProgressLanguage;
        if (bgProjectWorldSummary && bgProjectWorldFingerprint) {
          executionJournal.attachProjectWorldContext({
            summary: bgProjectWorldSummary,
            fingerprint: bgProjectWorldFingerprint,
          });
        }
        const stradaConformance = new StradaConformanceGuard(this.stradaDeps);
        const taskStartedAtMs = Date.now();
        const buildBgPhaseOutcomeTelemetry = (params: {
          state?: AgentState;
          usage?: ProviderResponse["usage"];
          verifierDecision?: VerifierDecision;
          failureReason?: string | null;
        }) =>
          this.buildPhaseOutcomeTelemetry({
            ...params,
            projectWorldFingerprint: bgProjectWorldFingerprint,
          });
        stradaConformance.trackPrompt(prompt);
        let toolTurnAffinity: SupervisorAssignment | null = null;

        const bgEpochIterationLimit = this.getBackgroundEpochIterationLimit();
        let bgIteration = 0;
        let bgEpochIteration = 0;
        let bgEpochCount = 1;
        let bgToolCallCount = 0;
        let finalVisibleResponse = "";
        let finalStatus: WorkerRunResult["status"] | undefined;
        let finalReason: string | undefined;
        const emitProgress = (update: TaskProgressUpdate): void => {
          if (typeof update !== "string" && update.userSummary) {
            executionJournal.recordUserFacingProgress(update.userSummary);
          }
          onProgress(update);
        };
        const finish = (
          response: string,
          status: WorkerRunResult["status"] = "completed",
          reason?: string,
        ): string => {
          finalVisibleResponse = response;
          finalStatus = status;
          finalReason = reason;
          return response;
        };

        try {
          while (true) {
            for (
              bgEpochIteration = 0;
              bgEpochIteration < bgEpochIterationLimit;
              bgEpochIteration++, bgIteration++
            ) {
              executionStrategy = this.buildSupervisorExecutionStrategy(
                prompt,
                identityKey,
                fallbackProvider,
                bgProjectWorldFingerprint,
              );

              // Check cancellation
              if (signal.aborted) {
                throw new Error("Task cancelled");
              }

              // ─── PAOR: Build phase-aware system prompt ──────────────────────
              let activePrompt = systemPrompt;
              switch (bgAgentState.phase) {
                case AgentPhase.PLANNING:
                  activePrompt +=
                    "\n\n" +
                    buildPlanningPrompt(
                      bgAgentState.taskDescription,
                      mergeLearnedInsights(
                        bgAgentState.learnedInsights,
                        executionJournal.getLearnedInsights(),
                      ),
                      { enableGoalDetection: false }, // Background tasks don't spawn sub-goals
                    );
                  break;
                case AgentPhase.EXECUTING:
                  activePrompt += buildExecutionContext(bgAgentState);
                  break;
                case AgentPhase.REPLANNING:
                  activePrompt += "\n\n" + buildReplanningPrompt(bgAgentState);
                  break;
              }
              activePrompt += executionJournal.buildPromptSection(bgAgentState.phase);
              // ────────────────────────────────────────────────────────────────

              const currentAssignment = this.getPinnedToolTurnAssignment(
                executionStrategy,
                bgAgentState.phase,
                toolTurnAffinity,
              );
              if (workerCollector) {
                workerCollector.lastAssignment = currentAssignment;
              }
              const currentProvider = currentAssignment.provider;
              const currentToolDefinitions = this.buildWorkerToolDefinitions(
                executionStrategy.task,
                bgAgentState.phase,
                currentAssignment.role,
              );
              activePrompt += this.buildSupervisorRolePrompt(executionStrategy, currentAssignment);

              const response = await currentProvider.chat(
                activePrompt,
                session.messages,
                currentToolDefinitions,
              );
              this.recordExecutionTrace({
                chatId,
                identityKey,
                assignment: currentAssignment,
                phase: this.toExecutionPhase(bgAgentState.phase),
                source: this.resolveExecutionTraceSource(currentAssignment),
                task: executionStrategy.task,
              });

              logger.debug("Background task LLM response", {
                chatId,
                epoch: bgEpochCount,
                epochIteration: bgEpochIteration,
                iteration: bgIteration,
                phase: bgAgentState.phase,
                stopReason: response.stopReason,
                toolCallCount: response.toolCalls.length,
              });
              if (
                response.toolCalls.length > 0 &&
                !toolTurnAffinity &&
                bgAgentState.phase !== AgentPhase.PLANNING &&
                bgAgentState.phase !== AgentPhase.REPLANNING
              ) {
                toolTurnAffinity = currentAssignment;
              }
              this.recordProviderUsage(
                currentAssignment.providerName,
                response.usage,
                options.onUsage ?? this.onUsage,
              );

              // ─── PAOR: Handle REFLECTING phase response ─────────────────────
              if (bgAgentState.phase === AgentPhase.REFLECTING) {
                const { decision } = await processReflectionPreamble({
                  agentState: bgAgentState,
                  executionJournal,
                  responseText: response.text,
                  providerName: currentAssignment.providerName,
                  modelId: currentAssignment.modelId,
                  logLabel: "bg",
                });

                if (response.toolCalls.length === 0) {
                  const pendingPlanReviewText = this.getPendingPlanReviewVisibleText(chatId);
                  if (pendingPlanReviewText) {
                    this.appendVisibleAssistantMessage(session, pendingPlanReviewText);
                    this.recordMetricEnd(metricId, {
                      agentPhase: AgentPhase.COMPLETE,
                      iterations: bgAgentState.iteration,
                      toolCallCount: bgToolCallCount,
                      hitMaxIterations: false,
                    });
                    await this.persistSessionToMemory(
                      chatId,
                      this.getVisibleTranscript(session),
                      /* force */ true,
                    );
                    return finish(pendingPlanReviewText, "blocked", pendingPlanReviewText);
                  }

                  const pendingWriteRejectionText =
                    this.getPendingSelfManagedWriteRejectionVisibleText(session, response.text);
                  if (pendingWriteRejectionText) {
                    this.appendVisibleAssistantMessage(session, pendingWriteRejectionText);
                    this.recordMetricEnd(metricId, {
                      agentPhase: AgentPhase.COMPLETE,
                      iterations: bgAgentState.iteration,
                      toolCallCount: bgToolCallCount,
                      hitMaxIterations: false,
                    });
                    await this.persistSessionToMemory(
                      chatId,
                      this.getVisibleTranscript(session),
                      /* force */ true,
                    );
                    return finish(pendingWriteRejectionText, "blocked", pendingWriteRejectionText);
                  }
                }

                if (decision === "DONE" || decision === "DONE_WITH_SUGGESTIONS") {
                  const clarificationIntervention =
                    await this.resolveDraftClarificationIntervention({
                      chatId,
                      identityKey,
                      prompt,
                      draft: response.text ?? "",
                      state: bgAgentState,
                      strategy: executionStrategy,
                      touchedFiles: [...selfVerification.getState().touchedFiles],
                      usageHandler: options.onUsage ?? this.onUsage,
                    });
                  if (
                    clarificationIntervention.kind === "continue" &&
                    clarificationIntervention.gate
                  ) {
                    const loopRecovery = await this.handleBackgroundLoopRecovery({
                      chatId,
                      identityKey,
                      prompt,
                      title: progressTitle,
                      language: progressLanguage,
                      state: bgAgentState,
                      strategy: executionStrategy,
                      tracker: controlLoopTracker,
                      executionJournal,
                      kind: "clarification_internal_continue",
                      reason: "Clarification review kept the task internal.",
                      gate: clarificationIntervention.gate,
                      iteration: bgIteration,
                      availableToolNames: currentToolDefinitions.map((definition) => definition.name),
                      selfVerification,
                      usageHandler: options.onUsage ?? this.onUsage,
                      onProgress: emitProgress,
                      session,
                      workerCollector,
                      workspaceLease: options.workspaceLease,
                    });
                    if (loopRecovery.action === "blocked" && loopRecovery.message) {
                      this.appendVisibleAssistantMessage(session, loopRecovery.message);
                      this.recordMetricEnd(metricId, {
                        agentPhase: AgentPhase.COMPLETE,
                        iterations: bgAgentState.iteration,
                        toolCallCount: bgToolCallCount,
                        hitMaxIterations: false,
                      });
                      await this.persistSessionToMemory(
                        chatId,
                        this.getVisibleTranscript(session),
                        /* force */ true,
                      );
                      return finish(loopRecovery.message, "blocked", loopRecovery.message);
                    }
                    if (loopRecovery.action === "replan" && loopRecovery.gate) {
                      bgAgentState = handleVerifierReplan({
                        agentState: bgAgentState,
                        executionJournal,
                        responseText: response.text,
                        reason: loopRecovery.summary ?? "Loop recovery requested a different approach.",
                        providerName: executionStrategy.reviewer.providerName,
                        modelId: executionStrategy.reviewer.modelId,
                      });
                      if (response.text) {
                        session.messages.push({ role: "assistant", content: response.text });
                      }
                      session.messages.push({ role: "user", content: loopRecovery.gate });
                      emitProgress(this.buildStructuredProgressSignal(
                        prompt,
                        progressTitle,
                        {
                          kind: "loop_recovery",
                          message: "Loop recovery requested a replan after clarification review.",
                        },
                        progressLanguage,
                      ));
                      continue;
                    }
                    bgAgentState = applyReflectionContinuation(bgAgentState, response.text);
                    if (response.text) {
                      session.messages.push({ role: "assistant", content: response.text });
                    }
                    session.messages.push({
                      role: "user",
                      content: loopRecovery.gate ?? clarificationIntervention.gate,
                    });
                    emitProgress(this.buildStructuredProgressSignal(
                      prompt,
                      progressTitle,
                      {
                        kind: "clarification",
                        message: "Clarification review kept the task internal",
                      },
                      progressLanguage,
                    ));
                    continue;
                  }
                  if (
                    (clarificationIntervention.kind === "ask_user" ||
                      clarificationIntervention.kind === "blocked") &&
                    clarificationIntervention.message
                  ) {
                    this.appendVisibleAssistantMessage(session, clarificationIntervention.message);
                    this.recordMetricEnd(metricId, {
                      agentPhase: AgentPhase.COMPLETE,
                      iterations: bgAgentState.iteration,
                      toolCallCount: bgToolCallCount,
                      hitMaxIterations: false,
                    });
                    await this.persistSessionToMemory(
                      chatId,
                      this.getVisibleTranscript(session),
                      /* force */ true,
                    );
                    return finish(
                      clarificationIntervention.message,
                      "blocked",
                      clarificationIntervention.message,
                    );
                  }

                  const rawBoundary = this.decideUserVisibleBoundary({
                    chatId,
                    prompt,
                    workerDraft: response.text ?? "",
                    task: executionStrategy.task,
                    state: bgAgentState,
                    selfVerification,
                    taskStartedAtMs,
                    availableToolNames: currentToolDefinitions.map((definition) => definition.name),
                    terminalFailureReported: isTerminalFailureReport(response.text),
                  });
                  if (rawBoundary.kind === "internal_continue" && rawBoundary.gate) {
                    const loopRecovery = await this.handleBackgroundLoopRecovery({
                      chatId,
                      identityKey,
                      prompt,
                      title: progressTitle,
                      language: progressLanguage,
                      state: bgAgentState,
                      strategy: executionStrategy,
                      tracker: controlLoopTracker,
                      executionJournal,
                      kind: "visibility_internal_continue",
                      reason: "Visibility boundary kept the task internal.",
                      gate: rawBoundary.gate,
                      iteration: bgIteration,
                      availableToolNames: currentToolDefinitions.map((definition) => definition.name),
                      selfVerification,
                      usageHandler: options.onUsage ?? this.onUsage,
                      onProgress: emitProgress,
                      session,
                      workerCollector,
                      workspaceLease: options.workspaceLease,
                    });
                    if (loopRecovery.action === "blocked" && loopRecovery.message) {
                      this.appendVisibleAssistantMessage(session, loopRecovery.message);
                      this.recordMetricEnd(metricId, {
                        agentPhase: AgentPhase.COMPLETE,
                        iterations: bgAgentState.iteration,
                        toolCallCount: bgToolCallCount,
                        hitMaxIterations: false,
                      });
                      await this.persistSessionToMemory(
                        chatId,
                        this.getVisibleTranscript(session),
                        /* force */ true,
                      );
                      return finish(loopRecovery.message, "blocked", loopRecovery.message);
                    }
                    if (loopRecovery.action === "replan" && loopRecovery.gate) {
                      bgAgentState = handleVerifierReplan({
                        agentState: bgAgentState,
                        executionJournal,
                        responseText: response.text,
                        reason: loopRecovery.summary ?? "Loop recovery requested a different plan.",
                        providerName: executionStrategy.reviewer.providerName,
                        modelId: executionStrategy.reviewer.modelId,
                      });
                      if (response.text) {
                        session.messages.push({ role: "assistant", content: response.text });
                      }
                      session.messages.push({ role: "user", content: loopRecovery.gate });
                      emitProgress(this.buildStructuredProgressSignal(
                        prompt,
                        progressTitle,
                        {
                          kind: "loop_recovery",
                          message: "Loop recovery requested a replan after visibility review.",
                        },
                        progressLanguage,
                      ));
                      continue;
                    }
                    bgAgentState = applyReflectionContinuation(bgAgentState, response.text);
                    if (response.text) {
                      session.messages.push({ role: "assistant", content: response.text });
                    }
                    session.messages.push({ role: "user", content: loopRecovery.gate ?? rawBoundary.gate });
                    emitProgress(this.buildStructuredProgressSignal(
                      prompt,
                      progressTitle,
                      {
                        kind: "visibility",
                        message: "Visibility boundary kept the task internal",
                      },
                      progressLanguage,
                    ));
                    continue;
                  }
                  if (
                    (rawBoundary.kind === "plan_review" ||
                      rawBoundary.kind === "terminal_failure") &&
                    rawBoundary.visibleText
                  ) {
                    const surfacedText = this.formatBoundaryVisibleText(rawBoundary)!;
                    this.appendVisibleAssistantMessage(session, surfacedText);
                    this.recordMetricEnd(metricId, {
                      agentPhase: AgentPhase.COMPLETE,
                      iterations: bgAgentState.iteration,
                      toolCallCount: bgToolCallCount,
                      hitMaxIterations: false,
                    });
                    await this.persistSessionToMemory(
                      chatId,
                      this.getVisibleTranscript(session),
                      /* force */ true,
                    );
                    return finish(
                      surfacedText,
                      rawBoundary.kind === "plan_review" ? "blocked" : "completed",
                      surfacedText,
                    );
                  }

                  const verifierIntervention = await this.resolveVerifierIntervention({
                    chatId,
                    identityKey,
                    prompt,
                    state: bgAgentState,
                    draft: response.text,
                    selfVerification,
                    stradaConformance,
                    strategy: executionStrategy,
                    taskStartedAtMs,
                    availableToolNames: currentToolDefinitions.map((definition) => definition.name),
                    usageHandler: options.onUsage ?? this.onUsage,
                  });
                  if (workerCollector) {
                    workerCollector.verifierResult = verifierIntervention.result;
                  }
                  executionJournal.recordVerifierResult(
                    verifierIntervention.result,
                    executionStrategy.reviewer.providerName,
                    executionStrategy.reviewer.modelId,
                  );
                  if (verifierIntervention.kind === "continue" && verifierIntervention.gate) {
                    this.recordPhaseOutcome({
                      chatId,
                      identityKey,
                      assignment: currentAssignment,
                      phase: "reflecting",
                      status: "continued",
                      task: executionStrategy.task,
                      reason: verifierIntervention.result.summary,
                      telemetry: buildBgPhaseOutcomeTelemetry({
                        state: bgAgentState,
                        usage: response.usage,
                        verifierDecision: "continue",
                        failureReason: verifierIntervention.result.summary,
                      }),
                    });
                    const loopRecovery = await this.handleBackgroundLoopRecovery({
                      chatId,
                      identityKey,
                      prompt,
                      title: progressTitle,
                      language: progressLanguage,
                      state: bgAgentState,
                      strategy: executionStrategy,
                      tracker: controlLoopTracker,
                      executionJournal,
                      kind: "verifier_continue",
                      reason: verifierIntervention.result.summary,
                      gate: verifierIntervention.gate,
                      iteration: bgIteration,
                      availableToolNames: currentToolDefinitions.map((definition) => definition.name),
                      selfVerification,
                      usageHandler: options.onUsage ?? this.onUsage,
                      onProgress: emitProgress,
                      session,
                      workerCollector,
                      workspaceLease: options.workspaceLease,
                    });
                    if (loopRecovery.action === "blocked" && loopRecovery.message) {
                      this.appendVisibleAssistantMessage(session, loopRecovery.message);
                      this.recordMetricEnd(metricId, {
                        agentPhase: AgentPhase.COMPLETE,
                        iterations: bgAgentState.iteration,
                        toolCallCount: bgToolCallCount,
                        hitMaxIterations: false,
                      });
                      await this.persistSessionToMemory(
                        chatId,
                        this.getVisibleTranscript(session),
                        /* force */ true,
                      );
                      return finish(loopRecovery.message, "blocked", loopRecovery.message);
                    }
                    if (loopRecovery.action === "replan" && loopRecovery.gate) {
                      bgAgentState = handleVerifierReplan({
                        agentState: bgAgentState,
                        executionJournal,
                        responseText: response.text,
                        reason: loopRecovery.summary ?? verifierIntervention.result.summary,
                        providerName: executionStrategy.reviewer.providerName,
                        modelId: executionStrategy.reviewer.modelId,
                      });
                      if (response.text) {
                        session.messages.push({ role: "assistant", content: response.text });
                      }
                      session.messages.push({ role: "user", content: loopRecovery.gate });
                      emitProgress(this.buildStructuredProgressSignal(
                        prompt,
                        progressTitle,
                        {
                          kind: "loop_recovery",
                          message: "Loop recovery requested a replan after repeated verifier feedback.",
                        },
                        progressLanguage,
                      ));
                      continue;
                    }
                    bgAgentState = applyReflectionContinuation(bgAgentState, response.text);
                    if (response.text) {
                      session.messages.push({ role: "assistant", content: response.text });
                    }
                    session.messages.push({
                      role: "user",
                      content: loopRecovery.gate ?? verifierIntervention.gate,
                    });
                    emitProgress(this.buildStructuredProgressSignal(
                      prompt,
                      progressTitle,
                      {
                        kind: "verification",
                        message: "Verification required before completion",
                      },
                      progressLanguage,
                    ));
                    continue;
                  }
                  if (verifierIntervention.kind === "replan" && verifierIntervention.gate) {
                    const loopRecovery = await this.handleBackgroundLoopRecovery({
                      chatId,
                      identityKey,
                      prompt,
                      title: progressTitle,
                      language: progressLanguage,
                      state: bgAgentState,
                      strategy: executionStrategy,
                      tracker: controlLoopTracker,
                      executionJournal,
                      kind: "verifier_replan",
                      reason: verifierIntervention.result.summary,
                      gate: verifierIntervention.gate,
                      iteration: bgIteration,
                      availableToolNames: currentToolDefinitions.map((definition) => definition.name),
                      selfVerification,
                      usageHandler: options.onUsage ?? this.onUsage,
                      onProgress: emitProgress,
                      session,
                      workerCollector,
                      workspaceLease: options.workspaceLease,
                    });
                    if (loopRecovery.action === "blocked" && loopRecovery.message) {
                      this.appendVisibleAssistantMessage(session, loopRecovery.message);
                      this.recordMetricEnd(metricId, {
                        agentPhase: AgentPhase.COMPLETE,
                        iterations: bgAgentState.iteration,
                        toolCallCount: bgToolCallCount,
                        hitMaxIterations: false,
                      });
                      await this.persistSessionToMemory(
                        chatId,
                        this.getVisibleTranscript(session),
                        /* force */ true,
                      );
                      return finish(loopRecovery.message, "blocked", loopRecovery.message);
                    }
                    executionJournal.beginReplan({
                      state: bgAgentState,
                      reason: loopRecovery.summary ?? verifierIntervention.result.summary,
                      providerName: executionStrategy.reviewer.providerName,
                      modelId: executionStrategy.reviewer.modelId,
                    });
                    this.recordPhaseOutcome({
                      chatId,
                      identityKey,
                      assignment: currentAssignment,
                      phase: "reflecting",
                      status: "replanned",
                      task: executionStrategy.task,
                      reason: verifierIntervention.result.summary,
                      telemetry: buildBgPhaseOutcomeTelemetry({
                        state: bgAgentState,
                        usage: response.usage,
                        verifierDecision: "replan",
                        failureReason: verifierIntervention.result.summary,
                      }),
                    });
                    bgAgentState = this.transitionToVerifierReplan(bgAgentState, response.text);
                    if (response.text) {
                      session.messages.push({ role: "assistant", content: response.text });
                    }
                    session.messages.push({
                      role: "user",
                      content: loopRecovery.gate ?? verifierIntervention.gate,
                    });
                    emitProgress(this.buildStructuredProgressSignal(
                      prompt,
                      progressTitle,
                      {
                        kind: loopRecovery.action === "replan" ? "loop_recovery" : "replanning",
                        message:
                          loopRecovery.action === "replan"
                            ? "Loop recovery requested a replan after repeated verifier feedback."
                            : "Verifier pipeline requested a replan",
                      },
                      progressLanguage,
                    ));
                    continue;
                  }

                  const finalText = await this.synthesizeUserFacingResponse({
                    chatId,
                    identityKey,
                    prompt,
                    draft: response.text ?? "",
                    agentState: bgAgentState,
                    strategy: executionStrategy,
                    systemPrompt,
                    usageHandler: options.onUsage ?? this.onUsage,
                  });
                  if (workerCollector) {
                    workerCollector.lastAssignment = executionStrategy.synthesizer;
                  }
                  const finalBoundary = this.decideUserVisibleBoundary({
                    chatId,
                    prompt,
                    workerDraft: response.text ?? "",
                    visibleDraft: finalText,
                    task: executionStrategy.task,
                    state: bgAgentState,
                    selfVerification,
                    taskStartedAtMs,
                    availableToolNames: currentToolDefinitions.map((definition) => definition.name),
                    terminalFailureReported: isTerminalFailureReport(response.text),
                  });
                  if (finalBoundary.kind === "internal_continue" && finalBoundary.gate) {
                    const loopRecovery = await this.handleBackgroundLoopRecovery({
                      chatId,
                      identityKey,
                      prompt,
                      title: progressTitle,
                      language: progressLanguage,
                      state: bgAgentState,
                      strategy: executionStrategy,
                      tracker: controlLoopTracker,
                      executionJournal,
                      kind: "visibility_internal_continue",
                      reason: "Visibility boundary rejected the draft.",
                      gate: finalBoundary.gate,
                      iteration: bgIteration,
                      availableToolNames: currentToolDefinitions.map((definition) => definition.name),
                      selfVerification,
                      usageHandler: options.onUsage ?? this.onUsage,
                      onProgress: emitProgress,
                      session,
                      workerCollector,
                      workspaceLease: options.workspaceLease,
                    });
                    if (loopRecovery.action === "blocked" && loopRecovery.message) {
                      this.appendVisibleAssistantMessage(session, loopRecovery.message);
                      this.recordMetricEnd(metricId, {
                        agentPhase: AgentPhase.COMPLETE,
                        iterations: bgAgentState.iteration,
                        toolCallCount: bgToolCallCount,
                        hitMaxIterations: false,
                      });
                      await this.persistSessionToMemory(
                        chatId,
                        this.getVisibleTranscript(session),
                        /* force */ true,
                      );
                      return finish(loopRecovery.message, "blocked", loopRecovery.message);
                    }
                    if (loopRecovery.action === "replan" && loopRecovery.gate) {
                      bgAgentState = handleVerifierReplan({
                        agentState: bgAgentState,
                        executionJournal,
                        responseText: response.text,
                        reason: loopRecovery.summary ?? "Loop recovery requested a different plan.",
                        providerName: executionStrategy.reviewer.providerName,
                        modelId: executionStrategy.reviewer.modelId,
                      });
                      if (response.text) {
                        session.messages.push({ role: "assistant", content: response.text });
                      }
                      session.messages.push({ role: "user", content: loopRecovery.gate });
                      emitProgress(this.buildStructuredProgressSignal(
                        prompt,
                        progressTitle,
                        {
                          kind: "loop_recovery",
                          message: "Loop recovery requested a replan after the draft was rejected.",
                        },
                        progressLanguage,
                      ));
                      continue;
                    }
                    bgAgentState = applyReflectionContinuation(bgAgentState, response.text);
                    if (response.text) {
                      session.messages.push({ role: "assistant", content: response.text });
                    }
                    session.messages.push({
                      role: "user",
                      content: loopRecovery.gate ?? finalBoundary.gate,
                    });
                    emitProgress(this.buildStructuredProgressSignal(
                      prompt,
                      progressTitle,
                      {
                        kind: "visibility",
                        message: "Visibility boundary rejected the draft",
                      },
                      progressLanguage,
                    ));
                    continue;
                  }
                  const surfacedFinalText = finalBoundary.visibleText ?? finalText;
                  if (surfacedFinalText) {
                    this.appendVisibleAssistantMessage(session, surfacedFinalText);
                  }
                  this.recordPhaseOutcome({
                    chatId,
                    identityKey,
                    assignment: currentAssignment,
                    phase: "reflecting",
                    status: "approved",
                    task: executionStrategy.task,
                    reason:
                      "Reflection accepted completion after the verifier pipeline cleared the task.",
                    telemetry: buildBgPhaseOutcomeTelemetry({
                      state: bgAgentState,
                      usage: response.usage,
                      verifierDecision: "approve",
                    }),
                  });
                  this.recordMetricEnd(metricId, {
                    agentPhase: AgentPhase.COMPLETE,
                    iterations: bgAgentState.iteration,
                    toolCallCount: bgToolCallCount,
                    hitMaxIterations: false,
                  });
                  await this.persistSessionToMemory(
                    chatId,
                    this.getVisibleTranscript(session),
                    /* force */ true,
                  );
                  return finish(surfacedFinalText || "Task completed without output.");
                }

                if (decision === "REPLAN") {
                  bgAgentState = handleReplanDecision({
                    agentState: bgAgentState,
                    executionJournal,
                    responseText: response.text,
                    providerName: currentAssignment.providerName,
                    modelId: currentAssignment.modelId,
                  });
                  if (response.text) {
                    session.messages.push({ role: "assistant", content: response.text });
                  }
                  this.recordPhaseOutcome({
                    chatId,
                    identityKey,
                    assignment: currentAssignment,
                    phase: "reflecting",
                    status: "replanned",
                    task: executionStrategy.task,
                    reason: response.text ?? "reflection requested a new plan",
                    telemetry: buildBgPhaseOutcomeTelemetry({
                      state: bgAgentState,
                      usage: response.usage,
                      failureReason: response.text,
                    }),
                  });
                  session.messages.push({ role: "user", content: "Please create a new plan." });
                  emitProgress(this.buildStructuredProgressSignal(
                    prompt,
                    progressTitle,
                    {
                      kind: "replanning",
                      message: "Replanning: current approach needs adjustment",
                    },
                    progressLanguage,
                  ));
                  continue;
                }

                // CONTINUE — plain continuation, reflection text not persisted
                bgAgentState = applyReflectionContinuation(bgAgentState, response.text, { skipLastReflection: true });

                if (response.toolCalls.length === 0) {
                  if (response.text) {
                    session.messages.push({ role: "assistant", content: response.text });
                  }
                  session.messages.push({ role: "user", content: "Please continue." });
                  continue;
                }
              }
              // ────────────────────────────────────────────────────────────────

              if (
                (bgAgentState.phase === AgentPhase.PLANNING ||
                  bgAgentState.phase === AgentPhase.REPLANNING) &&
                response.toolCalls.length === 0 &&
                userExplicitlyAskedForPlan(prompt) &&
                draftLooksLikeInternalPlanArtifact(response.text ?? "", {
                  toolNames: currentToolDefinitions.map((definition) => definition.name),
                })
              ) {
                bgAgentState = handlePlanPhaseTransition({
                  agentState: bgAgentState,
                  executionJournal,
                  responseText: response.text,
                  providerName: currentAssignment.providerName,
                  modelId: currentAssignment.modelId,
                  autoTransition: false,
                });
                const planText = applyVisibleResponseContract(
                  prompt,
                  this.stripInternalDecisionMarkers(response.text) || response.text || "",
                );
                if (planText) {
                  this.interactionPolicy.requirePlanReview(
                    chatId,
                    "user explicitly asked to review a plan first",
                    planText,
                  );
                  this.appendVisibleAssistantMessage(
                    session,
                    this.formatPlanReviewMessage(planText),
                  );
                }
                this.recordMetricEnd(metricId, {
                  agentPhase: AgentPhase.COMPLETE,
                  iterations: bgAgentState.iteration,
                  toolCallCount: bgToolCallCount,
                  hitMaxIterations: false,
                });
                await this.persistSessionToMemory(
                  chatId,
                  this.getVisibleTranscript(session),
                  /* force */ true,
                );
                return finish(
                  planText
                    ? this.formatPlanReviewMessage(planText)
                    : "Plan prepared for review.",
                  "blocked",
                  planText ?? "Plan prepared for review.",
                );
              }

              // Final response — return text
              if (response.stopReason === "end_turn" || response.toolCalls.length === 0) {
                const pendingPlanReviewText = this.getPendingPlanReviewVisibleText(chatId);
                if (pendingPlanReviewText) {
                  this.appendVisibleAssistantMessage(session, pendingPlanReviewText);
                  this.recordMetricEnd(metricId, {
                    agentPhase: AgentPhase.COMPLETE,
                    iterations: bgAgentState.iteration,
                    toolCallCount: bgToolCallCount,
                    hitMaxIterations: false,
                  });
                  await this.persistSessionToMemory(
                    chatId,
                    this.getVisibleTranscript(session),
                    /* force */ true,
                  );
                  return finish(pendingPlanReviewText, "blocked", pendingPlanReviewText);
                }

                const pendingWriteRejectionText = this.getPendingSelfManagedWriteRejectionVisibleText(
                  session,
                  response.text,
                );
                if (pendingWriteRejectionText) {
                  this.appendVisibleAssistantMessage(session, pendingWriteRejectionText);
                  this.recordMetricEnd(metricId, {
                    agentPhase: AgentPhase.COMPLETE,
                    iterations: bgAgentState.iteration,
                    toolCallCount: bgToolCallCount,
                    hitMaxIterations: false,
                  });
                  await this.persistSessionToMemory(
                    chatId,
                    this.getVisibleTranscript(session),
                    /* force */ true,
                  );
                  return finish(pendingWriteRejectionText, "blocked", pendingWriteRejectionText);
                }

                const clarificationIntervention = await this.resolveDraftClarificationIntervention({
                  chatId,
                  identityKey,
                  prompt,
                  draft: response.text ?? "",
                  state: bgAgentState,
                  strategy: executionStrategy,
                  touchedFiles: [...selfVerification.getState().touchedFiles],
                  usageHandler: options.onUsage ?? this.onUsage,
                });
                if (
                  clarificationIntervention.kind === "continue" &&
                  clarificationIntervention.gate
                ) {
                  const loopRecovery = await this.handleBackgroundLoopRecovery({
                    chatId,
                    identityKey,
                    prompt,
                    title: progressTitle,
                    language: progressLanguage,
                    state: bgAgentState,
                    strategy: executionStrategy,
                    tracker: controlLoopTracker,
                    executionJournal,
                    kind: "clarification_internal_continue",
                    reason: "Clarification review kept the task internal.",
                    gate: clarificationIntervention.gate,
                    iteration: bgIteration,
                    availableToolNames: currentToolDefinitions.map((definition) => definition.name),
                    selfVerification,
                    usageHandler: options.onUsage ?? this.onUsage,
                    onProgress: emitProgress,
                    session,
                    workerCollector,
                    workspaceLease: options.workspaceLease,
                  });
                  if (loopRecovery.action === "blocked" && loopRecovery.message) {
                    this.appendVisibleAssistantMessage(session, loopRecovery.message);
                    this.recordMetricEnd(metricId, {
                      agentPhase: AgentPhase.COMPLETE,
                      iterations: bgAgentState.iteration,
                      toolCallCount: bgToolCallCount,
                      hitMaxIterations: false,
                    });
                    await this.persistSessionToMemory(
                      chatId,
                      this.getVisibleTranscript(session),
                      /* force */ true,
                    );
                    return finish(loopRecovery.message, "blocked", loopRecovery.message);
                  }
                  if (loopRecovery.action === "replan" && loopRecovery.gate) {
                    bgAgentState = handleVerifierReplan({
                      agentState: bgAgentState,
                      executionJournal,
                      responseText: response.text,
                      reason: loopRecovery.summary ?? "Loop recovery requested a different approach.",
                      providerName: executionStrategy.reviewer.providerName,
                      modelId: executionStrategy.reviewer.modelId,
                    });
                    if (response.text) {
                      session.messages.push({ role: "assistant", content: response.text });
                    }
                    session.messages.push({ role: "user", content: loopRecovery.gate });
                    emitProgress(this.buildStructuredProgressSignal(
                      prompt,
                      progressTitle,
                      {
                        kind: "loop_recovery",
                        message: "Loop recovery requested a replan after clarification review.",
                      },
                      progressLanguage,
                    ));
                    continue;
                  }
                  if (response.text) {
                    session.messages.push({ role: "assistant", content: response.text });
                  }
                  session.messages.push({
                    role: "user",
                    content: loopRecovery.gate ?? clarificationIntervention.gate,
                  });
                  emitProgress(this.buildStructuredProgressSignal(
                    prompt,
                    progressTitle,
                    {
                      kind: "clarification",
                      message: "Clarification review kept the task internal",
                    },
                    progressLanguage,
                  ));
                  continue;
                }
                if (
                  (clarificationIntervention.kind === "ask_user" ||
                    clarificationIntervention.kind === "blocked") &&
                  clarificationIntervention.message
                ) {
                  this.appendVisibleAssistantMessage(session, clarificationIntervention.message);
                  this.recordMetricEnd(metricId, {
                    agentPhase: AgentPhase.COMPLETE,
                    iterations: bgAgentState.iteration,
                    toolCallCount: bgToolCallCount,
                    hitMaxIterations: false,
                  });
                  await this.persistSessionToMemory(
                    chatId,
                    this.getVisibleTranscript(session),
                    /* force */ true,
                  );
                  return finish(
                    clarificationIntervention.message,
                    "blocked",
                    clarificationIntervention.message,
                  );
                }

                const rawBoundary = this.decideUserVisibleBoundary({
                  chatId,
                  prompt,
                  workerDraft: response.text ?? "",
                  task: executionStrategy.task,
                  state: bgAgentState,
                  selfVerification,
                  taskStartedAtMs,
                  availableToolNames: currentToolDefinitions.map((definition) => definition.name),
                  terminalFailureReported: isTerminalFailureReport(response.text),
                });
                if (rawBoundary.kind === "internal_continue" && rawBoundary.gate) {
                  const loopRecovery = await this.handleBackgroundLoopRecovery({
                    chatId,
                    identityKey,
                    prompt,
                    title: progressTitle,
                    language: progressLanguage,
                    state: bgAgentState,
                    strategy: executionStrategy,
                    tracker: controlLoopTracker,
                    executionJournal,
                    kind: "visibility_internal_continue",
                    reason: "Visibility boundary kept the task internal.",
                    gate: rawBoundary.gate,
                    iteration: bgIteration,
                    availableToolNames: currentToolDefinitions.map((definition) => definition.name),
                    selfVerification,
                    usageHandler: options.onUsage ?? this.onUsage,
                    onProgress: emitProgress,
                    session,
                    workerCollector,
                    workspaceLease: options.workspaceLease,
                  });
                  if (loopRecovery.action === "blocked" && loopRecovery.message) {
                    this.appendVisibleAssistantMessage(session, loopRecovery.message);
                    this.recordMetricEnd(metricId, {
                      agentPhase: AgentPhase.COMPLETE,
                      iterations: bgAgentState.iteration,
                      toolCallCount: bgToolCallCount,
                      hitMaxIterations: false,
                    });
                    await this.persistSessionToMemory(
                      chatId,
                      this.getVisibleTranscript(session),
                      /* force */ true,
                    );
                    return finish(loopRecovery.message, "blocked", loopRecovery.message);
                  }
                  if (loopRecovery.action === "replan" && loopRecovery.gate) {
                    bgAgentState = handleVerifierReplan({
                      agentState: bgAgentState,
                      executionJournal,
                      responseText: response.text,
                      reason: loopRecovery.summary ?? "Loop recovery requested a different plan.",
                      providerName: executionStrategy.reviewer.providerName,
                      modelId: executionStrategy.reviewer.modelId,
                    });
                    if (response.text) {
                      session.messages.push({ role: "assistant", content: response.text });
                    }
                    session.messages.push({ role: "user", content: loopRecovery.gate });
                    emitProgress(this.buildStructuredProgressSignal(
                      prompt,
                      progressTitle,
                      {
                        kind: "loop_recovery",
                        message: "Loop recovery requested a replan after visibility review.",
                      },
                      progressLanguage,
                    ));
                    continue;
                  }
                  if (response.text) {
                    session.messages.push({ role: "assistant", content: response.text });
                  }
                  session.messages.push({
                    role: "user",
                    content: loopRecovery.gate ?? rawBoundary.gate,
                  });
                  emitProgress(this.buildStructuredProgressSignal(
                    prompt,
                    progressTitle,
                    {
                      kind: "visibility",
                      message: "Visibility boundary kept the task internal",
                    },
                    progressLanguage,
                  ));
                  continue;
                }
                if (
                  (rawBoundary.kind === "plan_review" || rawBoundary.kind === "terminal_failure") &&
                  rawBoundary.visibleText
                ) {
                  const surfacedText = this.formatBoundaryVisibleText(rawBoundary)!;
                  this.appendVisibleAssistantMessage(session, surfacedText);
                  this.recordMetricEnd(metricId, {
                    agentPhase: AgentPhase.COMPLETE,
                    iterations: bgAgentState.iteration,
                    toolCallCount: bgToolCallCount,
                    hitMaxIterations: false,
                  });
                  await this.persistSessionToMemory(
                    chatId,
                    this.getVisibleTranscript(session),
                    /* force */ true,
                  );
                  return finish(
                    surfacedText,
                    rawBoundary.kind === "plan_review" ? "blocked" : "completed",
                    surfacedText,
                  );
                }

                const verifierIntervention = await this.resolveVerifierIntervention({
                  chatId,
                  identityKey,
                  prompt,
                  state: bgAgentState,
                  draft: response.text,
                  selfVerification,
                  stradaConformance,
                  strategy: executionStrategy,
                  taskStartedAtMs,
                  availableToolNames: currentToolDefinitions.map((definition) => definition.name),
                  usageHandler: options.onUsage ?? this.onUsage,
                });
                if (workerCollector) {
                  workerCollector.verifierResult = verifierIntervention.result;
                }
                executionJournal.recordVerifierResult(
                  verifierIntervention.result,
                  executionStrategy.reviewer.providerName,
                  executionStrategy.reviewer.modelId,
                );
                if (verifierIntervention.kind === "continue" && verifierIntervention.gate) {
                  this.recordPhaseOutcome({
                    chatId,
                    identityKey,
                    assignment: currentAssignment,
                    phase: this.toExecutionPhase(bgAgentState.phase),
                    status: "continued",
                    task: executionStrategy.task,
                    reason: verifierIntervention.result.summary,
                    telemetry: buildBgPhaseOutcomeTelemetry({
                      state: bgAgentState,
                      usage: response.usage,
                      verifierDecision: "continue",
                      failureReason: verifierIntervention.result.summary,
                    }),
                  });
                  const loopRecovery = await this.handleBackgroundLoopRecovery({
                    chatId,
                    identityKey,
                    prompt,
                    title: progressTitle,
                    language: progressLanguage,
                    state: bgAgentState,
                    strategy: executionStrategy,
                    tracker: controlLoopTracker,
                    executionJournal,
                    kind: "verifier_continue",
                    reason: verifierIntervention.result.summary,
                    gate: verifierIntervention.gate,
                    iteration: bgIteration,
                    availableToolNames: currentToolDefinitions.map((definition) => definition.name),
                    selfVerification,
                    usageHandler: options.onUsage ?? this.onUsage,
                    onProgress: emitProgress,
                    session,
                    workerCollector,
                    workspaceLease: options.workspaceLease,
                  });
                  if (loopRecovery.action === "blocked" && loopRecovery.message) {
                    this.appendVisibleAssistantMessage(session, loopRecovery.message);
                    this.recordMetricEnd(metricId, {
                      agentPhase: AgentPhase.COMPLETE,
                      iterations: bgAgentState.iteration,
                      toolCallCount: bgToolCallCount,
                      hitMaxIterations: false,
                    });
                    await this.persistSessionToMemory(
                      chatId,
                      this.getVisibleTranscript(session),
                      /* force */ true,
                    );
                    return finish(loopRecovery.message, "blocked", loopRecovery.message);
                  }
                  if (loopRecovery.action === "replan" && loopRecovery.gate) {
                    bgAgentState = handleVerifierReplan({
                      agentState: bgAgentState,
                      executionJournal,
                      responseText: response.text,
                      reason: loopRecovery.summary ?? verifierIntervention.result.summary,
                      providerName: executionStrategy.reviewer.providerName,
                      modelId: executionStrategy.reviewer.modelId,
                    });
                    if (response.text) {
                      session.messages.push({ role: "assistant", content: response.text });
                    }
                    session.messages.push({ role: "user", content: loopRecovery.gate });
                    emitProgress(this.buildStructuredProgressSignal(
                      prompt,
                      progressTitle,
                      {
                        kind: "loop_recovery",
                        message: "Loop recovery requested a replan after repeated verifier feedback.",
                      },
                      progressLanguage,
                    ));
                    continue;
                  }
                  if (response.text) {
                    session.messages.push({ role: "assistant", content: response.text });
                  }
                  session.messages.push({
                    role: "user",
                    content: loopRecovery.gate ?? verifierIntervention.gate,
                  });
                  emitProgress(this.buildStructuredProgressSignal(
                    prompt,
                    progressTitle,
                    {
                      kind: "verification",
                      message: "Verification required before completion",
                    },
                    progressLanguage,
                  ));
                  continue;
                }
                if (verifierIntervention.kind === "replan" && verifierIntervention.gate) {
                  const loopRecovery = await this.handleBackgroundLoopRecovery({
                    chatId,
                    identityKey,
                    prompt,
                    title: progressTitle,
                    language: progressLanguage,
                    state: bgAgentState,
                    strategy: executionStrategy,
                    tracker: controlLoopTracker,
                    executionJournal,
                    kind: "verifier_replan",
                    reason: verifierIntervention.result.summary,
                    gate: verifierIntervention.gate,
                    iteration: bgIteration,
                    availableToolNames: currentToolDefinitions.map((definition) => definition.name),
                    selfVerification,
                    usageHandler: options.onUsage ?? this.onUsage,
                    onProgress: emitProgress,
                    session,
                    workerCollector,
                    workspaceLease: options.workspaceLease,
                  });
                  if (loopRecovery.action === "blocked" && loopRecovery.message) {
                    this.appendVisibleAssistantMessage(session, loopRecovery.message);
                    this.recordMetricEnd(metricId, {
                      agentPhase: AgentPhase.COMPLETE,
                      iterations: bgAgentState.iteration,
                      toolCallCount: bgToolCallCount,
                      hitMaxIterations: false,
                    });
                    await this.persistSessionToMemory(
                      chatId,
                      this.getVisibleTranscript(session),
                      /* force */ true,
                    );
                    return finish(loopRecovery.message, "blocked", loopRecovery.message);
                  }
                  this.recordPhaseOutcome({
                    chatId,
                    identityKey,
                    assignment: currentAssignment,
                    phase: this.toExecutionPhase(bgAgentState.phase),
                    status: "replanned",
                    task: executionStrategy.task,
                    reason: verifierIntervention.result.summary,
                    telemetry: buildBgPhaseOutcomeTelemetry({
                      state: bgAgentState,
                      usage: response.usage,
                      verifierDecision: "replan",
                      failureReason: verifierIntervention.result.summary,
                    }),
                  });
                  bgAgentState = this.transitionToVerifierReplan(bgAgentState, response.text);
                  if (response.text) {
                    session.messages.push({ role: "assistant", content: response.text });
                  }
                  session.messages.push({
                    role: "user",
                    content: loopRecovery.gate ?? verifierIntervention.gate,
                  });
                  emitProgress(this.buildStructuredProgressSignal(
                    prompt,
                    progressTitle,
                    {
                      kind: loopRecovery.action === "replan" ? "loop_recovery" : "replanning",
                      message:
                        loopRecovery.action === "replan"
                          ? "Loop recovery requested a replan after repeated verifier feedback."
                          : "Verifier pipeline requested a replan",
                    },
                    progressLanguage,
                  ));
                  continue;
                }

                const finalText = await this.synthesizeUserFacingResponse({
                  chatId,
                  identityKey,
                  prompt,
                  draft: response.text ?? "",
                  agentState: bgAgentState,
                  strategy: executionStrategy,
                  systemPrompt,
                  usageHandler: options.onUsage ?? this.onUsage,
                });
                if (workerCollector) {
                  workerCollector.lastAssignment = executionStrategy.synthesizer;
                }
                const finalBoundary = this.decideUserVisibleBoundary({
                  chatId,
                  prompt,
                  workerDraft: response.text ?? "",
                  visibleDraft: finalText,
                  task: executionStrategy.task,
                  state: bgAgentState,
                  selfVerification,
                  taskStartedAtMs,
                  availableToolNames: currentToolDefinitions.map((definition) => definition.name),
                  terminalFailureReported: isTerminalFailureReport(response.text),
                });
                if (finalBoundary.kind === "internal_continue" && finalBoundary.gate) {
                  if (response.text) {
                    session.messages.push({ role: "assistant", content: response.text });
                  }
                  session.messages.push({ role: "user", content: finalBoundary.gate });
                  continue;
                }
                const surfacedFinalText = finalBoundary.visibleText ?? finalText;
                if (surfacedFinalText) {
                  this.appendVisibleAssistantMessage(session, surfacedFinalText);
                }
                this.recordPhaseOutcome({
                  chatId,
                  identityKey,
                  assignment: currentAssignment,
                  phase: this.toExecutionPhase(bgAgentState.phase),
                  status: "approved",
                  task: executionStrategy.task,
                  reason:
                    "Execution produced a final response after the verifier pipeline cleared the task.",
                  telemetry: buildBgPhaseOutcomeTelemetry({
                    state: bgAgentState,
                    usage: response.usage,
                    verifierDecision: "approve",
                  }),
                });

                // ─── Metrics: record success ────────────────────────────────
                this.recordMetricEnd(metricId, {
                  agentPhase: AgentPhase.COMPLETE,
                  iterations: bgAgentState.iteration,
                  toolCallCount: bgToolCallCount,
                  hitMaxIterations: false,
                });
                // ────────────────────────────────────────────────────────────

                // Persist background task conversation to memory
                await this.persistSessionToMemory(
                  chatId,
                  this.getVisibleTranscript(session),
                  /* force */ true,
                );

                return finish(surfacedFinalText || "Task completed without output.");
              }

              // ─── PAOR: Phase transitions ────────────────────────────────────
              if (bgAgentState.phase === AgentPhase.PLANNING || bgAgentState.phase === AgentPhase.REPLANNING) {
                bgAgentState = handlePlanPhaseTransition({
                  agentState: bgAgentState,
                  executionJournal,
                  responseText: response.text,
                  providerName: currentAssignment.providerName,
                  modelId: currentAssignment.modelId,
                });
              }
              // ────────────────────────────────────────────────────────────────

              // Handle tool calls
              session.messages.push({
                role: "assistant",
                content: response.text,
                tool_calls: response.toolCalls,
              });

              const toolResults = await this.executeToolCalls(chatId, response.toolCalls, {
                mode: workerMode,
                taskPrompt: prompt,
                sessionMessages: session.messages,
                onUsage: options.onUsage ?? this.onUsage,
                identityKey,
                strategy: executionStrategy,
                agentState: bgAgentState,
                touchedFiles: [...selfVerification.getState().touchedFiles],
                workspaceLease: options.workspaceLease,
              });
              bgToolCallCount += response.toolCalls.length;
              const verificationStateBefore = selfVerification.getState();
              const touchedFilesBefore = new Set(verificationStateBefore.touchedFiles);

              // Autonomy tracking
              for (let i = 0; i < response.toolCalls.length; i++) {
                const tc = response.toolCalls[i]!;
                const tr = toolResults[i]!;
                const delegatedWorkerResult = tr.metadata?.["workerResult"] as WorkerRunResult | undefined;
                taskPlanner.trackToolCall(tc.name, tr.isError ?? false);
                selfVerification.track(tc.name, tc.input, tr);
                if (delegatedWorkerResult) {
                  selfVerification.ingestWorkerResult(delegatedWorkerResult);
                  workerCollector?.childWorkerResults.push(delegatedWorkerResult);
                }
                stradaConformance.trackToolCall(tc.name, tc.input, tr.isError ?? false, tr.content);
                workerCollector?.toolTrace.push({
                  toolName: tc.name,
                  success: !(tr.isError ?? false),
                  summary: tr.content.slice(0, 200),
                  timestamp: Date.now(),
                  workspaceId: options.workspaceLease?.id,
                });

                const analysis = errorRecovery.analyze(tc.name, tr);
                if (analysis) {
                  taskPlanner.recordError(analysis.summary);
                  toolResults[i] = {
                    toolCallId: tr.toolCallId,
                    content: sanitizeToolResult(tr.content + analysis.recoveryInjection),
                    isError: tr.isError,
                    metadata: tr.metadata,
                  };
                }

                this.emitToolResult(chatId, tc, toolResults[i]!);
              }
              executionJournal.recordToolBatch({
                phase: bgAgentState.phase,
                toolCalls: response.toolCalls,
                toolResults,
                providerName: currentAssignment.providerName,
                modelId: currentAssignment.modelId,
              });
              const verificationStateAfter = selfVerification.getState();
              const newTouchedFiles = [...verificationStateAfter.touchedFiles]
                .filter((file) => !touchedFilesBefore.has(file));
              if (
                verificationStateAfter.lastBuildOk === true &&
                verificationStateAfter.lastVerificationAt !== verificationStateBefore.lastVerificationAt
              ) {
                controlLoopTracker.markVerificationClean(bgIteration);
              }
              if (newTouchedFiles.length > 0) {
                controlLoopTracker.markMeaningfulFileEvidence(newTouchedFiles, bgIteration);
              }

              // Progress report: summarize tool calls
              emitProgress(this.buildToolBatchProgressSignal({
                prompt,
                title: progressTitle,
                toolCalls: response.toolCalls,
                language: progressLanguage,
              }));

              // ─── Consensus: verify output with second provider if confidence is low ───
              if (this.consensusManager && this.confidenceEstimator && this.providerRouter) {
                try {
                  const bgTaskClass = this.taskClassifier.classify(prompt);
                  const bgConfidence = this.confidenceEstimator.estimate({
                    task: bgTaskClass,
                    providerName: currentAssignment.providerName,
                    providerCapabilities: currentProvider.capabilities,
                    agentState: bgAgentState,
                    responseLength: (response.text ?? "").length,
                  });

                  const bgAvailableCount = this.providerManager.listAvailable().length;
                  const bgStrategy = this.consensusManager.shouldConsult(
                    bgConfidence,
                    bgTaskClass,
                    bgAvailableCount,
                  );

                  if (bgStrategy !== "skip" && bgAvailableCount >= 2) {
                    const bgReviewAssignment = this.resolveConsensusReviewAssignment(
                      executionStrategy.reviewer,
                      currentAssignment,
                      identityKey,
                    );
                    if (bgReviewAssignment) {
                      if (bgReviewAssignment.provider) {
                        const bgConsensusResult = await this.consensusManager.verify({
                          originalOutput: {
                            text: response.text ?? undefined,
                            toolCalls: response.toolCalls.map((tc: ToolCall) => ({
                              name: tc.name,
                              input: tc.input,
                            })),
                          },
                          originalProvider: currentAssignment.providerName,
                          task: bgTaskClass,
                          confidence: bgConfidence,
                          reviewProvider: bgReviewAssignment.provider,
                          prompt,
                        });
                        this.recordExecutionTrace({
                          chatId,
                          identityKey,
                          assignment: bgReviewAssignment,
                          phase: "consensus-review",
                          source: "consensus-review",
                          task: bgTaskClass,
                          reason: bgReviewAssignment.reason,
                        });
                        this.recordPhaseOutcome({
                          chatId,
                          identityKey,
                          assignment: bgReviewAssignment,
                          phase: "consensus-review",
                          source: "consensus-review",
                          status: bgConsensusResult.agreed ? "approved" : "continued",
                          task: bgTaskClass,
                          reason:
                            bgConsensusResult.reasoning?.trim() ||
                            (bgConsensusResult.agreed
                              ? "Consensus review agreed with the current path."
                              : "Consensus review found a disagreement and kept execution open."),
                        });

                        if (!bgConsensusResult.agreed) {
                          logger.warn("Consensus disagreement (background)", {
                            chatId,
                            strategy: bgConsensusResult.strategy,
                            reasoning: bgConsensusResult.reasoning?.slice(0, 200),
                          });
                        }
                      }
                    }
                  }
                } catch {
                  // Consensus failure is non-fatal
                }
              }
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
                bgAgentState = {
                  ...bgAgentState,
                  stepResults: [...bgAgentState.stepResults, stepResult],
                  iteration: bgAgentState.iteration + 1,
                  consecutiveErrors: tr.isError ? bgAgentState.consecutiveErrors + 1 : 0,
                };
              }

              const hasErrors = toolResults.some((tr) => tr.isError);
              const failedSteps = bgAgentState.stepResults.filter((s) => !s.success);
              const shouldReflect =
                hasErrors ||
                (bgAgentState.stepResults.length > 0 &&
                  bgAgentState.stepResults.length % BG_REFLECT_INTERVAL === 0) ||
                shouldForceReplan(failedSteps);

              if (shouldReflect && bgAgentState.phase === AgentPhase.EXECUTING) {
                bgAgentState = transitionPhase(bgAgentState, AgentPhase.REFLECTING);
                emitProgress(this.buildStructuredProgressSignal(
                  prompt,
                  progressTitle,
                  {
                    kind: "analysis",
                    message: "Reflecting on progress...",
                  },
                  progressLanguage,
                ));
              }
              // ────────────────────────────────────────────────────────────────

              // Add tool results
              const stateCtx = taskPlanner.getStateInjection();
              const contentBlocks: Array<
                | { type: "text"; text: string }
                | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
              > = [];
              if (stateCtx) {
                contentBlocks.push({ type: "text" as const, text: stateCtx });
              }
              if (bgAgentState.phase === AgentPhase.REFLECTING) {
                contentBlocks.push({
                  type: "text" as const,
                  text: buildReflectionPrompt(bgAgentState),
                });
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
                    const refreshed = await bgMemoryRefresher.refresh(
                      prompt,
                      chatId,
                      check.reason,
                      bgIteration,
                      check.cosineDistance,
                    );
                    if (refreshed.triggered) {
                      if (refreshed.newMemoryContext) {
                        systemPrompt = replaceSection(
                          systemPrompt,
                          "re-retrieval:memory",
                          `## Relevant Memory\n${refreshed.newMemoryContext}`,
                        );
                      }
                      if (refreshed.newRagContext) {
                        systemPrompt = replaceSection(
                          systemPrompt,
                          "re-retrieval:rag",
                          refreshed.newRagContext,
                        );
                      }
                      if (refreshed.newInsights?.length) {
                        bgAgentState = { ...bgAgentState, learnedInsights: refreshed.newInsights };
                      }
                    }
                  }
                } catch {
                  // Re-retrieval failure is non-fatal
                }
              }
              // ─────────────────────────────────────────────────────────────────
            }
            const completedEpochCount = bgEpochCount;
            const continuedAfterBudget = this.canAutoContinueBackgroundEpoch(completedEpochCount);

            this.recordPhaseOutcome({
              chatId,
              identityKey,
              assignment: executionStrategy.executor,
              phase: this.toExecutionPhase(bgAgentState.phase),
              status: continuedAfterBudget ? "continued" : "blocked",
              task: executionStrategy.task,
              reason: continuedAfterBudget
                ? "Background execution window reached its iteration budget and rolled into a new autonomous epoch."
                : "Background execution stopped after reaching the configured iteration budget.",
              telemetry: buildBgPhaseOutcomeTelemetry({
                state: bgAgentState,
              }),
            });
            this.persistExecutionMemory(identityKey, executionJournal);

            if (continuedAfterBudget) {
              taskPlanner.resetBudgetWindow();
              bgEpochCount++;
              continue;
            }

            this.recordMetricEnd(metricId, {
              agentPhase: bgAgentState.phase,
              iterations: bgAgentState.iteration,
              toolCallCount: bgToolCallCount,
              iterationBudgetReached: true,
              continuedAfterBudget: false,
              epochCount: completedEpochCount,
              terminatedByIterationBudget: true,
            });

            return finish(
              this.buildBackgroundIterationBudgetStopMessage(completedEpochCount),
              "blocked",
              "Background execution reached its configured iteration budget.",
            );
          }
        } catch (error) {
          bgAgentState = transitionPhase(bgAgentState, AgentPhase.FAILED);
          finalStatus = "failed";
          finalReason = error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          this.persistExecutionMemory(identityKey, executionJournal);
          // ─── Metrics: safety net for unexpected exits (endTask is idempotent) ─
          this.recordMetricEnd(metricId, {
            agentPhase: bgAgentState.phase,
            iterations: bgAgentState.iteration,
            toolCallCount: bgToolCallCount,
            hitMaxIterations: false,
          });
          // ────────────────────────────────────────────────────────────────
          if (workerCollector) {
            workerCollector.touchedFiles = [...selfVerification.getState().touchedFiles];
            workerCollector.finalVisibleResponse = finalVisibleResponse;
            workerCollector.finalSummary = finalVisibleResponse || finalReason || "";
            workerCollector.status = finalStatus;
            workerCollector.reason = finalReason;
          }
        }
      },
    );
  }

  /**
   * Handle the dependency setup flow when Strada.Core is missing.
   * Prompts the user on first message, processes their response on subsequent messages.
   */
  private async handleDepsSetup(msg: IncomingMessage): Promise<void> {
    const { chatId } = msg;
    const text = msg.text?.toLowerCase() ?? "";
    const session = this.getOrCreateSession(chatId);
    this.appendVisibleUserMessage(session, msg.text ?? "");

    if (this.pendingDepsPrompt.get(chatId)) {
      // User is responding to our install prompt
      if (text.includes("evet") || text.includes("yes") || text.includes("kur")) {
        await this.sendVisibleAssistantText(chatId, session, "Strada.Core kuruluyor...");
        const result = await installStradaDep(this.projectPath, "core", this.stradaConfig);
        if (result.kind === "ok") {
          this.stradaDeps = checkStradaDeps(this.projectPath, this.stradaConfig);
          this.rebuildBaseSystemPrompt();
          this.depsSetupComplete = true;
          await this.sendVisibleAssistantText(
            chatId,
            session,
            "Strada.Core kuruldu! Artık kullanabilirsiniz.",
          );

          if (!this.stradaDeps.modulesInstalled) {
            this.pendingModulesPrompt.set(chatId, true);
            await this.sendVisibleAssistantText(
              chatId,
              session,
              "Strada.Modules da kurulu değil. Kurmamı ister misiniz? (evet/hayır)",
            );
            return;
          }
        } else {
          await this.sendVisibleAssistantText(
            chatId,
            session,
            `Kurulum başarısız: ${result.error}`,
          );
          this.depsSetupComplete = true;
        }
      } else {
        this.depsSetupComplete = true;
        await this.sendVisibleAssistantText(
          chatId,
          session,
          "Anlaşıldı. Strada.Core olmadan sınırlı destek sunabilirim.",
        );
      }
      return;
    }

    // First message — send the install prompt
    this.pendingDepsPrompt.set(chatId, true);
    await this.sendVisibleAssistantText(
      chatId,
      session,
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
    const session = this.getOrCreateSession(chatId);
    this.appendVisibleUserMessage(session, msg.text ?? "");
    this.pendingModulesPrompt.delete(chatId);

    if (text.includes("evet") || text.includes("yes") || text.includes("kur")) {
      await this.sendVisibleAssistantText(chatId, session, "Strada.Modules kuruluyor...");
      const result = await installStradaDep(this.projectPath, "modules", this.stradaConfig);
      if (result.kind === "ok") {
        this.stradaDeps = checkStradaDeps(this.projectPath, this.stradaConfig);
        this.rebuildBaseSystemPrompt();
        await this.sendVisibleAssistantText(chatId, session, "Strada.Modules kuruldu!");
      } else {
        await this.sendVisibleAssistantText(
          chatId,
          session,
          `Modules kurulumu başarısız: ${result.error}`,
        );
      }
    } else {
      await this.sendVisibleAssistantText(
        chatId,
        session,
        "Anlaşıldı. Strada.Modules olmadan devam ediyoruz.",
      );
    }
  }

  private async processMessage(msg: IncomingMessage): Promise<void> {
    const logger = getLogger();
    const { chatId, text, userId: msgUserId, conversationId } = msg;
    const userId = msgUserId;
    const conversationScope = resolveConversationScope(chatId, conversationId);

    logger.info("Processing message", {
      chatId,
      userId,
      textLength: text.length,
      channel: msg.channelType,
    });

    const session = this.getOrCreateSession(chatId);

    // Goal tree resume detection (trigger on first message when interrupted trees exist)
    const pendingResumeTrees = this.takePendingResumeTrees(conversationScope, chatId);
    if (pendingResumeTrees.length > 0) {
      const resumePrompt = formatResumePrompt(pendingResumeTrees);
      const normalized = text.toLowerCase().trim();
      if (normalized === "resume" || normalized === "resume all") {
        this.appendVisibleUserMessage(session, text);
        await this.sendVisibleAssistantMarkdown(chatId, session, resumePrompt);
        for (const tree of pendingResumeTrees) {
          const prepared = prepareTreeForResume(tree);
          this.activeGoalTrees.set(tree.sessionId, prepared);
        }
        await this.sendVisibleAssistantMarkdown(
          chatId,
          session,
          "Resuming interrupted goal trees...",
        );
        return;
      } else if (normalized === "discard" || normalized === "discard all") {
        this.appendVisibleUserMessage(session, text);
        await this.sendVisibleAssistantMarkdown(chatId, session, resumePrompt);
        await this.sendVisibleAssistantMarkdown(
          chatId,
          session,
          "Interrupted goal trees discarded.",
        );
        return;
      }
    }

    // Check rate limits before processing
    if (this.rateLimiter) {
      const rateCheck = this.rateLimiter.checkMessageRate(userId);
      if (!rateCheck.allowed) {
        logger.warn("Rate limited", { userId, reason: rateCheck.reason });
        const retryMsg = rateCheck.retryAfterMs
          ? ` Please try again in ${Math.ceil(rateCheck.retryAfterMs / 1000)} seconds.`
          : "";
        this.appendVisibleUserMessage(session, text);
        await this.sendVisibleAssistantText(chatId, session, `${rateCheck.reason}${retryMsg}`);
        return;
      }
    }

    this.metrics?.recordMessage();
    this.metrics?.setActiveSessions(this.sessions.size);
    const identityKey = resolveIdentityKey(chatId, userId, conversationId, this.userProfileStore, msg.channelType);
    const clearedPlanReview = this.interactionPolicy.noteUserMessage(chatId, text);
    if (clearedPlanReview) {
      logger.info("Cleared pending plan review after explicit user approval", {
        chatId,
        userId,
        reason: clearedPlanReview.reason,
      });
    }

    session.lastActivity = new Date();
    session.conversationScope = conversationScope;
    if (!session.mixedParticipants) {
      if (!session.profileKey) {
        session.profileKey = identityKey;
      } else if (session.profileKey !== identityKey) {
        session.profileKey = undefined;
        session.mixedParticipants = true;
      }
    }

    // Touch user profile (lastSeenAt) — debounced to avoid per-message SQLite writes
    if (this.userProfileStore) {
      const lastTouch = this.lastPersistTime.get(`touch:${identityKey}`) ?? 0;
      if (Date.now() - lastTouch > 60_000) {
        this.userProfileStore.touchLastSeen(identityKey);
        this.lastPersistTime.set(`touch:${identityKey}`, Date.now());
      }
    }

    // Load autonomous mode from profile at session start
    if (this.dmPolicy && this.userProfileStore) {
      try {
        const autonomousState = await resolveAutonomousModeWithDefault(
          this.userProfileStore,
          identityKey,
          {
            enabled: this.autonomousDefaultEnabled,
            hours: this.autonomousDefaultHours,
          },
        );
        if (autonomousState.enabled) {
          this.dmPolicy.initFromProfile(
            chatId,
            {
              autonomousMode: true,
              autonomousExpiresAt: autonomousState.expiresAt,
            },
            userId,
          );
        } else {
          this.dmPolicy.initFromProfile(chatId, { autonomousMode: false }, userId);
        }
      } catch {
        // Autonomous mode restoration failure is non-fatal
      }
    }

    await this.maybeUpdateUserProfileFromPrompt(chatId, identityKey, text, userId);

    // Teaching intent detection: explicit teaching from user (Learning Pipeline v2)
    if (this.learningPipeline && TeachingParser.isTeachingIntent(text)) {
      try {
        const parsed = TeachingParser.parse(text);
        const scope = parsed.scope ?? "user";
        await this.learningPipeline.teachExplicit(parsed.content, scope, userId);
        logger.debug("Teaching intent processed", { userId, scope, contentLength: parsed.content.length });
      } catch (err) {
        logger.warn("Teaching intent processing failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Add user message (with vision blocks if applicable)
    const provider = this.providerManager.getProvider(identityKey);
    const supportsVision = provider.capabilities.vision;
    const userContent = buildUserContent(text, msg.attachments, supportsVision);
    this.appendVisibleUserMessage(session, userContent);

    // Trim old messages to manage context window (provider-aware threshold)
    // Persist trimmed messages to memory before discarding
    const providerInfo = this.providerManager.getActiveInfo?.(identityKey);
    const trimmed = this.trimSession(
      session,
      getRecommendedMaxMessages(
        providerInfo?.providerName ?? provider.name,
        providerInfo?.model,
        this.modelIntelligence,
        this.providerManager.getProviderCapabilities?.(
          providerInfo?.providerName ?? provider.name,
          providerInfo?.model,
        ),
        providerInfo?.providerName ?? provider.name,
      ),
    );
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

    try {
      await this.runAgentLoop(chatId, session, msg.channelType, userId, conversationId);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Unknown error";
      logger.error("Agent loop error", { chatId, error: errMsg });
      await this.sendVisibleAssistantText(chatId, session, classifyErrorMessage(error));
    } finally {
      clearInterval(typingInterval);
      // Persist conversation summary (forced to ensure no messages are lost)
      const visibleMessages = this.getVisibleTranscript(session);
      await this.persistSessionToMemory(chatId, visibleMessages.slice(-10), /* force */ true);
      // Periodic summarization: every 10 messages, generate an LLM summary
      if (
        this.sessionSummarizer &&
        visibleMessages.length > 0 &&
        visibleMessages.length % 10 === 0
      ) {
        void this.sessionSummarizer
          .summarizeAndUpdateProfile(session.profileKey ?? chatId, visibleMessages)
          .catch(() => {
            /* periodic summarization failure is non-fatal */
          });
      }
    }
  }

  /**
   * The core agent loop: LLM → Tool calls → LLM → ... → Response
   */
  private async runAgentLoop(
    chatId: string,
    session: Session,
    channelType?: string,
    userId?: string,
    conversationId?: string,
  ): Promise<void> {
    const logger = getLogger();
    const conversationScope = resolveConversationScope(chatId, conversationId);
    const identityKey = resolveIdentityKey(chatId, userId, conversationId, this.userProfileStore, channelType);
    const fallbackProvider = this.providerManager.getProvider(identityKey);

    // Load user profile once for the entire agent loop
    const profile = this.userProfileStore?.getProfile(identityKey) ?? null;

    // Per-user persona override (from profile, not global SoulLoader mutation)
    let personaContent: string | undefined;
    if (profile?.activePersona && profile.activePersona !== "default" && this.soulLoader) {
      personaContent =
        (await this.soulLoader.getProfileContent(profile.activePersona)) ?? undefined;
    }

    // Extract query text from last user message for embedding + context
    const lastUserMsg = [...session.messages].reverse().find((m) => m.role === "user" && m.content);
    const queryText = lastUserMsg
      ? typeof lastUserMsg.content === "string"
        ? lastUserMsg.content
        : Array.isArray(lastUserMsg.content)
          ? (lastUserMsg.content as Array<{ type: string; text?: string }>)
              .filter((b) => b.type === "text" && b.text)
              .map((b) => b.text)
              .join(" ")
          : ""
      : "";

    // Pre-compute embedding once for memory search + RAG search (avoids 2 redundant calls)
    let preComputedEmbedding: number[] | undefined;
    if (queryText && this.embeddingProvider) {
      try {
        const batch = await this.embeddingProvider.embed([queryText]);
        preComputedEmbedding = batch.embeddings[0];
      } catch {
        // Embedding failure is non-fatal; downstream calls will embed on demand
      }
    }

    // Build system prompt with all context layers (DRY: shared with runBackgroundTask)
    logger.debug("Building system prompt", { chatId });
    const {
      systemPrompt: builtSystemPrompt,
      initialContentHashes,
      projectWorldSummary,
      projectWorldFingerprint,
    } = await this.buildSystemPromptWithContext({
      chatId,
      conversationScope,
      identityKey,
      userId,
      channelType,
      prompt: queryText,
      personaContent,
      profile,
      preComputedEmbedding,
    });
    let systemPrompt = builtSystemPrompt;

    // ─── Autonomy layer ──────────────────────────────────────────────────
    const lastUserMessage = this.extractLastUserMessage(session);
    const errorRecovery = new ErrorRecoveryEngine();
    const taskPlanner = new TaskPlanner({
      iterationBudget: this.getInteractiveIterationLimit(),
    });
    const selfVerification = new SelfVerification();
    const executionJournal = new ExecutionJournal(lastUserMessage);
    if (projectWorldSummary && projectWorldFingerprint) {
      executionJournal.attachProjectWorldContext({
        summary: projectWorldSummary,
        fingerprint: projectWorldFingerprint,
      });
    }
    const stradaConformance = new StradaConformanceGuard(this.stradaDeps);
    const taskStartedAtMs = Date.now();
    const buildInteractivePhaseOutcomeTelemetry = (params: {
      state?: AgentState;
      usage?: ProviderResponse["usage"];
      verifierDecision?: VerifierDecision;
      failureReason?: string | null;
    }) =>
      this.buildPhaseOutcomeTelemetry({
        ...params,
        projectWorldFingerprint,
      });
    // ────────────────────────────────────────────────────────────────────

    // ─── PAOR State Machine ──────────────────────────────────────────────
    stradaConformance.trackPrompt(lastUserMessage);
    let agentState = createInitialState(lastUserMessage);
    let executionStrategy = this.buildSupervisorExecutionStrategy(
      lastUserMessage,
      identityKey,
      fallbackProvider,
      projectWorldFingerprint,
    );
    let toolTurnAffinity: SupervisorAssignment | null = null;

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

    logger.debug("System prompt built", { chatId, promptLength: systemPrompt.length });
    const interactiveIterationLimit = this.getInteractiveIterationLimit();

    try {
      for (let iteration = 0; iteration < interactiveIterationLimit; iteration++) {
        executionStrategy = this.buildSupervisorExecutionStrategy(
          lastUserMessage,
          identityKey,
          fallbackProvider,
          projectWorldFingerprint,
        );

        // ─── PAOR: Build phase-aware system prompt ──────────────────────
        let activePrompt = systemPrompt;
        switch (agentState.phase) {
          case AgentPhase.PLANNING:
            activePrompt +=
              "\n\n" +
              buildPlanningPrompt(
                agentState.taskDescription,
                mergeLearnedInsights(
                  agentState.learnedInsights,
                  executionJournal.getLearnedInsights(),
                ),
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
        activePrompt += executionJournal.buildPromptSection(agentState.phase);
        // ────────────────────────────────────────────────────────────────

        const currentAssignment = this.getPinnedToolTurnAssignment(
          executionStrategy,
          agentState.phase,
          toolTurnAffinity,
        );
        const currentProvider = currentAssignment.provider;
        activePrompt += this.buildSupervisorRolePrompt(executionStrategy, currentAssignment);
        const canStream =
          this.streamingEnabled &&
          "chatStream" in currentProvider &&
          typeof currentProvider.chatStream === "function" &&
          "startStreamingMessage" in this.channel &&
          typeof this.channel.startStreamingMessage === "function";

        logger.debug("Calling LLM", {
          chatId,
          canStream,
          provider: currentAssignment.providerName,
          iteration,
        });
        const currentToolDefinitions = this.buildWorkerToolDefinitions(
          executionStrategy.task,
          agentState.phase,
          currentAssignment.role,
        );
        let response;
        if (canStream) {
          // Silent streaming: use streaming internally (SSE parsing, timeout, reasoning_content)
          // but don't create visible messages. User sees only the final response via sendMarkdown.
          response = await this.silentStream(
            chatId,
            activePrompt,
            session,
            currentProvider,
            currentToolDefinitions,
          );
        } else {
          response = await currentProvider.chat(
            activePrompt,
            session.messages,
            currentToolDefinitions,
          );
        }
        this.recordExecutionTrace({
          chatId,
          identityKey,
          assignment: currentAssignment,
          phase: this.toExecutionPhase(agentState.phase),
          source: this.resolveExecutionTraceSource(currentAssignment),
          task: executionStrategy.task,
        });
        logger.debug("LLM responded", {
          chatId,
          hasText: !!response.text,
          textLen: response.text?.length ?? 0,
          toolCalls: response.toolCalls.length,
        });

        logger.debug("LLM response", {
          chatId,
          iteration,
          stopReason: response.stopReason,
          toolCallCount: response.toolCalls.length,
          inputTokens: response.usage?.inputTokens ?? 0,
          outputTokens: response.usage?.outputTokens ?? 0,
          streamed: canStream,
        });
        if (
          response.toolCalls.length > 0 &&
          !toolTurnAffinity &&
          agentState.phase !== AgentPhase.PLANNING &&
          agentState.phase !== AgentPhase.REPLANNING
        ) {
          toolTurnAffinity = currentAssignment;
        }
        this.recordProviderUsage(currentAssignment.providerName, response.usage, this.onUsage);

        // ─── PAOR: Handle REFLECTING phase response ─────────────────────
        if (agentState.phase === AgentPhase.REFLECTING) {
          const { decision } = await processReflectionPreamble({
            agentState,
            executionJournal,
            responseText: response.text,
            providerName: currentAssignment.providerName,
            modelId: currentAssignment.modelId,
          });

          if (response.toolCalls.length === 0) {
            const pendingPlanReviewText = this.getPendingPlanReviewVisibleText(chatId);
            if (pendingPlanReviewText) {
              await this.sendVisibleAssistantMarkdown(chatId, session, pendingPlanReviewText);
              this.recordMetricEnd(metricId, {
                agentPhase: AgentPhase.COMPLETE,
                iterations: agentState.iteration,
                toolCallCount: agentState.stepResults.length,
                hitMaxIterations: false,
              });
              return;
            }

            const pendingWriteRejectionText = this.getPendingSelfManagedWriteRejectionVisibleText(
              session,
              response.text,
            );
            if (pendingWriteRejectionText) {
              await this.sendVisibleAssistantMarkdown(
                chatId,
                session,
                pendingWriteRejectionText,
              );
              this.recordMetricEnd(metricId, {
                agentPhase: AgentPhase.COMPLETE,
                iterations: agentState.iteration,
                toolCallCount: agentState.stepResults.length,
                hitMaxIterations: false,
              });
              return;
            }
          }

          if (decision === "DONE" || decision === "DONE_WITH_SUGGESTIONS") {
            const clarificationIntervention = await this.resolveDraftClarificationIntervention({
              chatId,
              identityKey,
              prompt: lastUserMessage,
              draft: response.text ?? "",
              state: agentState,
              strategy: executionStrategy,
              touchedFiles: [...selfVerification.getState().touchedFiles],
              usageHandler: this.onUsage,
            });
            if (clarificationIntervention.kind === "continue" && clarificationIntervention.gate) {
              agentState = applyReflectionContinuation(agentState, response.text);
              if (response.text) {
                session.messages.push({ role: "assistant", content: response.text });
              }
              session.messages.push({ role: "user", content: clarificationIntervention.gate });
              continue;
            }
            if (
              (clarificationIntervention.kind === "ask_user" ||
                clarificationIntervention.kind === "blocked") &&
              clarificationIntervention.message
            ) {
              await this.sendVisibleAssistantMarkdown(
                chatId,
                session,
                clarificationIntervention.message,
              );
              this.recordMetricEnd(metricId, {
                agentPhase: AgentPhase.COMPLETE,
                iterations: agentState.iteration,
                toolCallCount: agentState.stepResults.length,
                hitMaxIterations: false,
              });
              return;
            }

            const verifierIntervention = await this.resolveVerifierIntervention({
              chatId,
              identityKey,
              prompt: lastUserMessage,
              state: agentState,
              draft: response.text,
              selfVerification,
              stradaConformance,
              strategy: executionStrategy,
              taskStartedAtMs,
              availableToolNames: currentToolDefinitions.map((definition) => definition.name),
              usageHandler: this.onUsage,
            });
            executionJournal.recordVerifierResult(
              verifierIntervention.result,
              executionStrategy.reviewer.providerName,
              executionStrategy.reviewer.modelId,
            );
            if (verifierIntervention.kind === "continue" && verifierIntervention.gate) {
              this.recordPhaseOutcome({
                chatId,
                identityKey,
                assignment: currentAssignment,
                phase: "reflecting",
                status: "continued",
                task: executionStrategy.task,
                reason: verifierIntervention.result.summary,
                telemetry: buildInteractivePhaseOutcomeTelemetry({
                  state: agentState,
                  usage: response.usage,
                  verifierDecision: "continue",
                  failureReason: verifierIntervention.result.summary,
                }),
              });
              agentState = applyReflectionContinuation(agentState, response.text);
              if (response.text) {
                session.messages.push({ role: "assistant", content: response.text });
              }
              session.messages.push({ role: "user", content: verifierIntervention.gate });
              continue;
            }
            if (verifierIntervention.kind === "replan" && verifierIntervention.gate) {
              executionJournal.beginReplan({
                state: agentState,
                reason: verifierIntervention.result.summary,
                providerName: executionStrategy.reviewer.providerName,
                modelId: executionStrategy.reviewer.modelId,
              });
              this.recordPhaseOutcome({
                chatId,
                identityKey,
                assignment: currentAssignment,
                phase: "reflecting",
                status: "replanned",
                task: executionStrategy.task,
                reason: verifierIntervention.result.summary,
                telemetry: buildInteractivePhaseOutcomeTelemetry({
                  state: agentState,
                  usage: response.usage,
                  verifierDecision: "replan",
                  failureReason: verifierIntervention.result.summary,
                }),
              });
              agentState = this.transitionToVerifierReplan(agentState, response.text);
              if (response.text) {
                session.messages.push({ role: "assistant", content: response.text });
              }
              session.messages.push({ role: "user", content: verifierIntervention.gate });
              continue;
            }

            const visibilityDecision = await this.resolveVisibleDraftDecision({
              chatId,
              identityKey,
              prompt: lastUserMessage,
              draft: response.text ?? "",
              agentState,
              strategy: executionStrategy,
              systemPrompt,
              selfVerification,
              taskStartedAtMs,
              availableToolNames: currentToolDefinitions.map((definition) => definition.name),
              usageHandler: this.onUsage,
            });
            if (visibilityDecision.kind === "internal_continue" && visibilityDecision.gate) {
              if (response.text) {
                session.messages.push({ role: "assistant", content: response.text });
              }
              session.messages.push({ role: "user", content: visibilityDecision.gate });
              agentState = applyReflectionContinuation(agentState, response.text);
              continue;
            }
            if (
              (visibilityDecision.kind === "plan_review" ||
                visibilityDecision.kind === "blocked" ||
                visibilityDecision.kind === "ask_user") &&
              visibilityDecision.visibleText
            ) {
              await this.sendVisibleAssistantMarkdown(
                chatId,
                session,
                visibilityDecision.visibleText,
              );
              this.recordPhaseOutcome({
                chatId,
                identityKey,
                assignment: currentAssignment,
                phase: "reflecting",
                status: "blocked",
                task: executionStrategy.task,
                reason: visibilityDecision.reason,
                telemetry: buildInteractivePhaseOutcomeTelemetry({
                  state: agentState,
                  usage: response.usage,
                  verifierDecision: "approve",
                }),
              });
              this.recordMetricEnd(metricId, {
                agentPhase: AgentPhase.COMPLETE,
                iterations: agentState.iteration,
                toolCallCount: agentState.stepResults.length,
                hitMaxIterations: false,
              });
              return;
            }
            const finalText = visibilityDecision.visibleText?.trim() ?? "";
            if (finalText) {
              await this.sendVisibleAssistantMarkdown(chatId, session, finalText);
            }
            this.recordPhaseOutcome({
              chatId,
              identityKey,
              assignment: currentAssignment,
              phase: "reflecting",
              status: "approved",
              task: executionStrategy.task,
              reason: visibilityDecision.reason,
              telemetry: buildInteractivePhaseOutcomeTelemetry({
                state: agentState,
                usage: response.usage,
                verifierDecision: "approve",
              }),
            });
            this.recordMetricEnd(metricId, {
              agentPhase: AgentPhase.COMPLETE,
              iterations: agentState.iteration,
              toolCallCount: agentState.stepResults.length,
              hitMaxIterations: false,
            });
            return;
          }

          if (decision === "REPLAN") {
            agentState = handleReplanDecision({
              agentState,
              executionJournal,
              responseText: response.text,
              providerName: currentAssignment.providerName,
              modelId: currentAssignment.modelId,
              autoTransition: false, // Goal decomposition may happen before transition
            });

            // ─── Goal Decomposition: reactive decomposition when stuck ──────
            if (this.goalDecomposer && this.activeGoalTrees.has(conversationScope)) {
              try {
                const goalTree = this.activeGoalTrees.get(conversationScope)!;
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
                  this.emitGoalEvent(
                    goalTree.rootId,
                    executingNodeId,
                    "failed",
                    executingNode.depth,
                  );
                  const updatedTree = await this.goalDecomposer.decomposeReactive(
                    goalTree,
                    executingNodeId,
                    response.text ?? "",
                  );
                  if (updatedTree) {
                    this.activeGoalTrees.set(conversationScope, updatedTree);
                    const treeViz = renderGoalTree(updatedTree);
                    await this.sendVisibleAssistantMarkdown(
                      chatId,
                      session,
                      "Goal tree updated (reactive decomposition):\n```\n" + treeViz + "\n```",
                    );
                  } else {
                    getLogger().info("Reactive decomposition skipped (depth limit reached)", {
                      chatId,
                      nodeId: executingNodeId,
                    });
                  }
                }
              } catch (reactiveError) {
                // Reactive decomposition failure is non-fatal
                getLogger().warn("Reactive goal decomposition failed", {
                  chatId,
                  error:
                    reactiveError instanceof Error ? reactiveError.message : String(reactiveError),
                });
              }
            }
            // ────────────────────────────────────────────────────────────────

            agentState = transitionPhase(agentState, AgentPhase.REPLANNING);
            if (response.text) {
              session.messages.push({ role: "assistant", content: response.text });
            }
            this.recordPhaseOutcome({
              chatId,
              identityKey,
              assignment: currentAssignment,
              phase: "reflecting",
              status: "replanned",
              task: executionStrategy.task,
              reason: response.text ?? "reflection requested a new plan",
              telemetry: buildInteractivePhaseOutcomeTelemetry({
                state: agentState,
                usage: response.usage,
                failureReason: response.text,
              }),
            });
            session.messages.push({ role: "user", content: "Please create a new plan." });
            continue;
          }

          // CONTINUE — plain continuation, reflection text not persisted
          agentState = applyReflectionContinuation(agentState, response.text, { skipLastReflection: true });

          if (response.toolCalls.length === 0) {
            if (shouldSurfaceTerminalFailureFromReflection(response)) {
              const visibilityDecision = await this.resolveVisibleDraftDecision({
                chatId,
                identityKey,
                prompt: lastUserMessage,
                draft: response.text ?? "",
                agentState,
                strategy: executionStrategy,
                systemPrompt,
                selfVerification,
                taskStartedAtMs,
                availableToolNames: currentToolDefinitions.map((definition) => definition.name),
                terminalFailureReported: true,
                usageHandler: this.onUsage,
              });
              if (visibilityDecision.kind === "internal_continue" && visibilityDecision.gate) {
                if (response.text) {
                  session.messages.push({ role: "assistant", content: response.text });
                }
                session.messages.push({ role: "user", content: visibilityDecision.gate });
                continue;
              }
              if (visibilityDecision.visibleText) {
                await this.sendVisibleAssistantMarkdown(
                  chatId,
                  session,
                  visibilityDecision.visibleText,
                );
              }
              this.recordMetricEnd(metricId, {
                agentPhase: AgentPhase.COMPLETE,
                iterations: agentState.iteration,
                toolCallCount: agentState.stepResults.length,
                hitMaxIterations: false,
              });
              return;
            }

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
              goalBlock,
              conversationScope,
              lastUserMessage,
              response.text ?? undefined,
            );

            // Send acknowledgment
            const nodeCount = goalTree.nodes.size - 1;
            const ackMsg =
              `Working on: ${lastUserMessage.slice(0, 80)}` +
              ` (${nodeCount} step${nodeCount !== 1 ? "s" : ""}, ~${goalBlock.estimatedMinutes} min). I'll update you as I go.`;
            await this.sendVisibleAssistantText(chatId, session, ackMsg);

            // Submit as background task with pre-decomposed tree
            this.taskManager.submit(chatId, channelType ?? "cli", lastUserMessage, {
              goalTree,
              conversationId: conversationScope,
              userId: identityKey,
            });

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

        if (
          (agentState.phase === AgentPhase.PLANNING ||
            agentState.phase === AgentPhase.REPLANNING) &&
          response.toolCalls.length === 0 &&
          userExplicitlyAskedForPlan(lastUserMessage) &&
          draftLooksLikeInternalPlanArtifact(response.text ?? "", {
            toolNames: currentToolDefinitions.map((definition) => definition.name),
          })
        ) {
          agentState = handlePlanPhaseTransition({
            agentState,
            executionJournal,
            responseText: response.text,
            providerName: currentAssignment.providerName,
            modelId: currentAssignment.modelId,
            autoTransition: false,
          });

          if (
            agentState.phase === AgentPhase.PLANNING &&
            this.goalDecomposer &&
            this.goalDecomposer.shouldDecompose(lastUserMessage)
          ) {
            try {
              const goalTree = await this.goalDecomposer.decomposeProactive(
                conversationScope,
                lastUserMessage,
              );
              this.activeGoalTrees.set(conversationScope, goalTree);
              this.emitGoalEvent(goalTree.rootId, goalTree.rootId, "pending", 0);
              const treeViz = renderGoalTree(goalTree);
              await this.sendVisibleAssistantMarkdown(
                chatId,
                session,
                "Goal decomposition:\n```\n" + treeViz + "\n```",
              );
              const treeSummary = summarizeTree(goalTree);
              agentState = {
                ...agentState,
                plan: (agentState.plan ?? "") + "\n\n[Goal Tree: " + treeSummary + "]",
              };
            } catch (decompError) {
              getLogger().warn("Proactive goal decomposition failed", {
                chatId,
                error: decompError instanceof Error ? decompError.message : String(decompError),
              });
            }
          }

          this.interactionPolicy.requirePlanReview(
            chatId,
            "user explicitly asked to review a plan first",
            applyVisibleResponseContract(
              lastUserMessage,
              this.stripInternalDecisionMarkers(response.text) || response.text || "",
            ),
          );
          const planText = this.getPendingPlanReviewVisibleText(chatId)!;
          await this.sendVisibleAssistantMarkdown(chatId, session, planText);
          this.recordMetricEnd(metricId, {
            agentPhase: AgentPhase.COMPLETE,
            iterations: agentState.iteration,
            toolCallCount: agentState.stepResults.length,
            hitMaxIterations: false,
          });
          return;
        }

        // If no tool calls, send the final text response
        // (streaming already sent it, so skip for streamed end_turn)
        if (response.stopReason === "end_turn" || response.toolCalls.length === 0) {
          const pendingPlanReviewText = this.getPendingPlanReviewVisibleText(chatId);
          if (pendingPlanReviewText) {
            await this.sendVisibleAssistantMarkdown(chatId, session, pendingPlanReviewText);
            this.recordMetricEnd(metricId, {
              agentPhase: AgentPhase.COMPLETE,
              iterations: agentState.iteration,
              toolCallCount: agentState.stepResults.length,
              hitMaxIterations: false,
            });
            return;
          }

          const pendingWriteRejectionText = this.getPendingSelfManagedWriteRejectionVisibleText(
            session,
            response.text,
          );
          if (pendingWriteRejectionText) {
            await this.sendVisibleAssistantMarkdown(chatId, session, pendingWriteRejectionText);
            this.recordMetricEnd(metricId, {
              agentPhase: AgentPhase.COMPLETE,
              iterations: agentState.iteration,
              toolCallCount: agentState.stepResults.length,
              hitMaxIterations: false,
            });
            return;
          }

          const clarificationIntervention = await this.resolveDraftClarificationIntervention({
            chatId,
            identityKey,
            prompt: lastUserMessage,
            draft: response.text ?? "",
            state: agentState,
            strategy: executionStrategy,
            touchedFiles: [...selfVerification.getState().touchedFiles],
            usageHandler: this.onUsage,
          });
          if (clarificationIntervention.kind === "continue" && clarificationIntervention.gate) {
            if (response.text) {
              session.messages.push({ role: "assistant", content: response.text });
            }
            session.messages.push({
              role: "user",
              content: clarificationIntervention.gate,
            });
            continue;
          }
          if (
            (clarificationIntervention.kind === "ask_user" ||
              clarificationIntervention.kind === "blocked") &&
            clarificationIntervention.message
          ) {
            await this.sendVisibleAssistantMarkdown(
              chatId,
              session,
              clarificationIntervention.message,
            );
            this.recordMetricEnd(metricId, {
              agentPhase: AgentPhase.COMPLETE,
              iterations: agentState.iteration,
              toolCallCount: agentState.stepResults.length,
              hitMaxIterations: false,
            });
            return;
          }

          // ─── Verification gate: catch unverified exits ──────────────────
          const verifierIntervention = await this.resolveVerifierIntervention({
            chatId,
            identityKey,
            prompt: lastUserMessage,
            state: agentState,
            draft: response.text,
            selfVerification,
            stradaConformance,
            strategy: executionStrategy,
            taskStartedAtMs,
            availableToolNames: currentToolDefinitions.map((definition) => definition.name),
            usageHandler: this.onUsage,
          });
          if (verifierIntervention.kind === "continue" && verifierIntervention.gate) {
            this.recordPhaseOutcome({
              chatId,
              identityKey,
              assignment: currentAssignment,
              phase: this.toExecutionPhase(agentState.phase),
              status: "continued",
              task: executionStrategy.task,
              reason: verifierIntervention.result.summary,
              telemetry: buildInteractivePhaseOutcomeTelemetry({
                state: agentState,
                usage: response.usage,
                verifierDecision: "continue",
                failureReason: verifierIntervention.result.summary,
              }),
            });
            if (response.text) {
              session.messages.push({ role: "assistant", content: response.text });
            }
            session.messages.push({
              role: "user",
              content: verifierIntervention.gate,
            });
            logger.debug("Verification gate triggered", { chatId, iteration });
            continue; // send back to LLM with verification reminder
          }
          if (verifierIntervention.kind === "replan" && verifierIntervention.gate) {
            this.recordPhaseOutcome({
              chatId,
              identityKey,
              assignment: currentAssignment,
              phase: this.toExecutionPhase(agentState.phase),
              status: "replanned",
              task: executionStrategy.task,
              reason: verifierIntervention.result.summary,
              telemetry: buildInteractivePhaseOutcomeTelemetry({
                state: agentState,
                usage: response.usage,
                verifierDecision: "replan",
                failureReason: verifierIntervention.result.summary,
              }),
            });
            agentState = this.transitionToVerifierReplan(agentState, response.text);
            if (response.text) {
              session.messages.push({ role: "assistant", content: response.text });
            }
            session.messages.push({
              role: "user",
              content: verifierIntervention.gate,
            });
            logger.debug("Verifier pipeline triggered replan", { chatId, iteration });
            continue;
          }
          // ────────────────────────────────────────────────────────────────

          // ─── Consensus for text-only responses on critical tasks ──────
          if (this.consensusManager && this.confidenceEstimator && response.text) {
            try {
              const textTaskClass = this.taskClassifier.classify(lastUserMessage);
              if (textTaskClass.criticality === "critical") {
                const textConfidence = this.confidenceEstimator.estimate({
                  task: textTaskClass,
                  providerName: currentAssignment.providerName,
                  providerCapabilities: currentProvider.capabilities,
                  agentState,
                  responseLength: response.text.length,
                });
                const textAvailableCount = this.providerManager.listAvailable().length;
                const textStrategy = this.consensusManager.shouldConsult(
                  textConfidence,
                  textTaskClass,
                  textAvailableCount,
                );
                if (textStrategy !== "skip" && textAvailableCount >= 2) {
                  const textReviewAssignment = this.resolveConsensusReviewAssignment(
                    executionStrategy.reviewer,
                    currentAssignment,
                    identityKey,
                  );
                  if (textReviewAssignment) {
                    if (textReviewAssignment.provider) {
                      const textConsensus = await this.consensusManager.verify({
                        originalOutput: { text: response.text },
                        originalProvider: currentAssignment.providerName,
                        task: textTaskClass,
                        confidence: textConfidence,
                        reviewProvider: textReviewAssignment.provider,
                        prompt: lastUserMessage,
                      });
                      this.recordExecutionTrace({
                        chatId,
                        identityKey,
                        assignment: textReviewAssignment,
                        phase: "consensus-review",
                        source: "consensus-review",
                        task: textTaskClass,
                        reason: textReviewAssignment.reason,
                      });
                      this.recordPhaseOutcome({
                        chatId,
                        identityKey,
                        assignment: textReviewAssignment,
                        phase: "consensus-review",
                        source: "consensus-review",
                        status: textConsensus.agreed ? "approved" : "continued",
                        task: textTaskClass,
                        reason:
                          textConsensus.reasoning?.trim() ||
                          (textConsensus.agreed
                            ? "Consensus review agreed with the current path."
                            : "Consensus review found a disagreement and kept execution open."),
                      });
                      if (!textConsensus.agreed) {
                        logger.warn("Consensus disagreement (text-only, critical)", {
                          chatId,
                          strategy: textConsensus.strategy,
                          reasoning: textConsensus.reasoning?.slice(0, 200),
                        });
                      }
                    }
                  }
                }
              }
            } catch {
              // Consensus failure is non-fatal
            }
          }
          // ────────────────────────────────────────────────────────────────

          if (response.text) {
            const visibilityDecision = await this.resolveVisibleDraftDecision({
              chatId,
              identityKey,
              prompt: lastUserMessage,
              draft: response.text,
              agentState,
              strategy: executionStrategy,
              systemPrompt,
              selfVerification,
              taskStartedAtMs,
              availableToolNames: currentToolDefinitions.map((definition) => definition.name),
              usageHandler: this.onUsage,
            });
            if (visibilityDecision.kind === "internal_continue" && visibilityDecision.gate) {
              session.messages.push({ role: "assistant", content: response.text });
              session.messages.push({ role: "user", content: visibilityDecision.gate });
              continue;
            }
            if (
              (visibilityDecision.kind === "plan_review" ||
                visibilityDecision.kind === "blocked" ||
                visibilityDecision.kind === "ask_user") &&
              visibilityDecision.visibleText
            ) {
              await this.sendVisibleAssistantMarkdown(
                chatId,
                session,
                visibilityDecision.visibleText,
              );
              this.recordPhaseOutcome({
                chatId,
                identityKey,
                assignment: currentAssignment,
                phase: this.toExecutionPhase(agentState.phase),
                status: "blocked",
                task: executionStrategy.task,
                reason: visibilityDecision.reason,
                telemetry: buildInteractivePhaseOutcomeTelemetry({
                  state: agentState,
                  usage: response.usage,
                  verifierDecision: "approve",
                }),
              });
              this.recordMetricEnd(metricId, {
                agentPhase: AgentPhase.COMPLETE,
                iterations: agentState.iteration,
                toolCallCount: agentState.stepResults.length,
                hitMaxIterations: false,
              });
              return;
            }
            const finalText = visibilityDecision.visibleText?.trim() ?? "";
            if (finalText) {
              await this.sendVisibleAssistantMarkdown(chatId, session, finalText);
            }
            this.recordPhaseOutcome({
              chatId,
              identityKey,
              assignment: currentAssignment,
              phase: this.toExecutionPhase(agentState.phase),
              status: "approved",
              task: executionStrategy.task,
              reason: visibilityDecision.reason,
              telemetry: buildInteractivePhaseOutcomeTelemetry({
                state: agentState,
                usage: response.usage,
                verifierDecision: "approve",
              }),
            });
          } else {
            // LLM returned empty response — send fallback to user
            const lang = profile?.language ?? this.defaultLanguage;
            const fallback =
              lang === "tr"
                ? "Bir yanıt oluşturamadım. Sorunuzu yeniden ifade edebilir misiniz?"
                : lang === "ja"
                  ? "応答を生成できませんでした。質問を言い換えていただけますか？"
                  : lang === "ko"
                    ? "응답을 생성할 수 없었습니다. 질문을 다시 표현해 주시겠어요?"
                    : lang === "zh"
                      ? "我无法生成回复。您能重新表述您的问题吗？"
                      : lang === "de"
                        ? "Ich konnte keine Antwort generieren. Könnten Sie Ihre Frage umformulieren?"
                        : lang === "es"
                          ? "No pude generar una respuesta. ¿Podría reformular su pregunta?"
                          : lang === "fr"
                            ? "Je n'ai pas pu générer de réponse. Pourriez-vous reformuler votre question ?"
                            : "I wasn't able to generate a response. Could you rephrase your question?";
            logger.warn("LLM returned empty response", {
              chatId,
              canStream,
              provider: currentAssignment.providerName,
            });
            await this.sendVisibleAssistantMarkdown(chatId, session, fallback);
          }
          // ─── Metrics: record end_turn ───────────────────────────────
          this.recordMetricEnd(metricId, {
            agentPhase: AgentPhase.COMPLETE,
            iterations: agentState.iteration,
            toolCallCount: agentState.stepResults.length,
            hitMaxIterations: false,
          });
          // ──────────────────────────────────────────────────────────
          return;
        }

        // ─── PAOR: Phase transitions ────────────────────────────────────
        if (agentState.phase === AgentPhase.PLANNING) {
          agentState = handlePlanPhaseTransition({
            agentState,
            executionJournal,
            responseText: response.text,
            providerName: currentAssignment.providerName,
            modelId: currentAssignment.modelId,
            autoTransition: false, // Goal decomposition may happen before transition
          });

          // ─── Goal Decomposition: proactive decomposition for complex tasks ───
          if (this.goalDecomposer && this.goalDecomposer.shouldDecompose(lastUserMessage)) {
            try {
              const goalTree = await this.goalDecomposer.decomposeProactive(
                conversationScope,
                lastUserMessage,
              );
              this.activeGoalTrees.set(conversationScope, goalTree);
              this.emitGoalEvent(goalTree.rootId, goalTree.rootId, "pending", 0);
              const treeViz = renderGoalTree(goalTree);
              await this.sendVisibleAssistantMarkdown(
                chatId,
                session,
                "Goal decomposition:\n```\n" + treeViz + "\n```",
              );
              // Augment plan with decomposition summary
              const treeSummary = summarizeTree(goalTree);
              agentState = {
                ...agentState,
                plan: (agentState.plan ?? "") + "\n\n[Goal Tree: " + treeSummary + "]",
              };
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
          agentState = handlePlanPhaseTransition({
            agentState,
            executionJournal,
            responseText: response.text,
            providerName: currentAssignment.providerName,
            modelId: currentAssignment.modelId,
          });
        }
        // ────────────────────────────────────────────────────────────────

        // Handle tool calls
        // First, add the assistant message with tool calls
        session.messages.push({
          role: "assistant",
          content: response.text,
          tool_calls: response.toolCalls,
        });

        // Intermediate text is stored in session for LLM context but NOT sent to user.
        // User only sees the final response (end_turn without tool calls).

        // Execute all tool calls
        const toolResults = await this.executeToolCalls(chatId, response.toolCalls, {
          mode: "interactive",
          userId,
          taskPrompt: lastUserMessage,
          sessionMessages: session.messages,
          onUsage: this.onUsage,
          identityKey,
          strategy: executionStrategy,
          agentState,
          touchedFiles: [...selfVerification.getState().touchedFiles],
        });

        // ─── Autonomy: track + analyze results ─────────────────────────────
        for (let i = 0; i < response.toolCalls.length; i++) {
          const tc = response.toolCalls[i]!;
          const tr = toolResults[i]!;
          const delegatedWorkerResult = tr.metadata?.["workerResult"] as WorkerRunResult | undefined;

          // O(1) tracking in planner & verifier
          taskPlanner.trackToolCall(tc.name, tr.isError ?? false);
          selfVerification.track(tc.name, tc.input, tr);
          if (delegatedWorkerResult) {
            selfVerification.ingestWorkerResult(delegatedWorkerResult);
          }
          stradaConformance.trackToolCall(tc.name, tc.input, tr.isError ?? false, tr.content);

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
              metadata: tr.metadata,
            };
          }

          this.emitToolResult(chatId, tc, toolResults[i]!);
        }
        executionJournal.recordToolBatch({
          phase: agentState.phase,
          toolCalls: response.toolCalls,
          toolResults,
          providerName: currentAssignment.providerName,
          modelId: currentAssignment.modelId,
        });

        // Inject state-aware context (stall detection, budget warnings)
        const stateCtx = taskPlanner.getStateInjection();
        // ────────────────────────────────────────────────────────────────────

        // ─── Consensus: verify output with second provider if confidence is low ───
        if (this.consensusManager && this.confidenceEstimator && this.providerRouter) {
          try {
            const taskClass = this.taskClassifier.classify(lastUserMessage);
            const confidence = this.confidenceEstimator.estimate({
              task: taskClass,
              providerName: currentAssignment.providerName,
              providerCapabilities: currentProvider.capabilities,
              agentState,
              responseLength: (response.text ?? "").length,
            });

            const availableCount = this.providerManager.listAvailable().length;
            const strategy = this.consensusManager.shouldConsult(
              confidence,
              taskClass,
              availableCount,
            );

            if (strategy !== "skip" && availableCount >= 2) {
              const reviewAssignment = this.resolveConsensusReviewAssignment(
                executionStrategy.reviewer,
                currentAssignment,
                identityKey,
              );
              if (reviewAssignment) {
                if (reviewAssignment.provider) {
                  const consensusResult = await this.consensusManager.verify({
                    originalOutput: {
                      text: response.text ?? undefined,
                      toolCalls: response.toolCalls.map((tc: ToolCall) => ({
                        name: tc.name,
                        input: tc.input,
                      })),
                    },
                    originalProvider: currentAssignment.providerName,
                    task: taskClass,
                    confidence,
                    reviewProvider: reviewAssignment.provider,
                    prompt: lastUserMessage,
                  });
                  this.recordExecutionTrace({
                    chatId,
                    identityKey,
                    assignment: reviewAssignment,
                    phase: "consensus-review",
                    source: "consensus-review",
                    task: taskClass,
                    reason: reviewAssignment.reason,
                  });
                  this.recordPhaseOutcome({
                    chatId,
                    identityKey,
                    assignment: reviewAssignment,
                    phase: "consensus-review",
                    source: "consensus-review",
                    status: consensusResult.agreed ? "approved" : "continued",
                    task: taskClass,
                    reason:
                      consensusResult.reasoning?.trim() ||
                      (consensusResult.agreed
                        ? "Consensus review agreed with the current path."
                        : "Consensus review found a disagreement and kept execution open."),
                  });

                  if (!consensusResult.agreed) {
                    logger.warn("Consensus disagreement", {
                      chatId,
                      strategy: consensusResult.strategy,
                      reasoning: consensusResult.reasoning?.slice(0, 200),
                    });
                  }
                }
              }
            }
          } catch {
            // Consensus failure is non-fatal
          }
        }
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

        const hasErrors = toolResults.some((tr) => tr.isError);
        const failedSteps = agentState.stepResults.filter((s) => !s.success);
        const shouldReflect =
          hasErrors ||
          (agentState.stepResults.length > 0 &&
            agentState.stepResults.length % REFLECT_INTERVAL === 0) ||
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
              const refreshed = await memoryRefresher.refresh(
                recentContext,
                chatId,
                check.reason,
                iteration,
                check.cosineDistance,
              );
              if (refreshed.triggered) {
                if (refreshed.newMemoryContext) {
                  systemPrompt = replaceSection(
                    systemPrompt,
                    "re-retrieval:memory",
                    `## Relevant Memory\n${refreshed.newMemoryContext}`,
                  );
                }
                if (refreshed.newRagContext) {
                  systemPrompt = replaceSection(
                    systemPrompt,
                    "re-retrieval:rag",
                    refreshed.newRagContext,
                  );
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
        iterationBudgetReached: true,
        continuedAfterBudget: false,
        epochCount: 1,
        terminatedByIterationBudget: true,
      });
      // ────────────────────────────────────────────────────────────────

      await this.sendVisibleAssistantText(
        chatId,
        session,
        "I've reached the maximum number of steps for this request. " +
          "Please send a follow-up message to continue.",
      );
    } catch (error) {
      agentState = transitionPhase(agentState, AgentPhase.FAILED);
      throw error;
    } finally {
      this.persistExecutionMemory(identityKey, executionJournal);
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
    result: {
      agentPhase: AgentPhase;
      iterations: number;
      toolCallCount: number;
      hitMaxIterations?: boolean;
      iterationBudgetReached?: boolean;
      continuedAfterBudget?: boolean;
      epochCount?: number;
      terminatedByIterationBudget?: boolean;
    },
  ): void {
    if (metricId) {
      this.metricsRecorder?.endTask(metricId, result);
    }
  }

  /**
   * Silent streaming: uses the provider's streaming API internally (SSE parsing,
   * timeout, reasoning_content) but does NOT create visible messages for the user.
   * Returns the full ProviderResponse. Used by runAgentLoop to avoid showing
   * intermediate iterations while keeping streaming reliability.
   */
  private readonly silentStream = async (
    chatId: string,
    systemPrompt: string,
    session: Session,
    provider: IAIProvider,
    toolDefinitions: Array<{
      name: string;
      description: string;
      input_schema: import("../types/index.js").JsonObject;
    }>,
  ): Promise<ProviderResponse> => {
    const timeoutGuard = createStreamingProgressTimeout(
      this.streamInitialTimeoutMs,
      this.streamStallTimeoutMs,
    );
    try {
      const streamPromise = (provider as IStreamingProvider).chatStream(
        systemPrompt,
        session.messages,
        toolDefinitions,
        () => {
          timeoutGuard.markProgress();
        },
      );
      const response = await Promise.race([streamPromise, timeoutGuard.timeoutPromise]);
      timeoutGuard.clear();
      return response;
    } catch (err) {
      timeoutGuard.clear();
      const errMsg = err instanceof Error ? err.message : "Unknown streaming error";
      getLogger().error("Silent stream error", { chatId, error: errMsg });
      try {
        return await provider.chat(systemPrompt, session.messages, toolDefinitions);
      } catch (fallbackErr) {
        getLogger().error("Silent stream fallback chat failed", {
          chatId,
          error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        });
      }
      return {
        text: "",
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    }
  };

  /**
   * Stream a response from the LLM to the channel in real-time.
   * Sends text chunks as they arrive, then returns the final ProviderResponse.
   * Reserved for runBackgroundTask visible streaming.
   */
  // @ts-expect-error Reserved for background task streaming
  private async streamResponse(
    chatId: string,
    systemPrompt: string,
    session: Session,
    provider: IAIProvider,
    toolDefinitions: Array<{
      name: string;
      description: string;
      input_schema: import("../types/index.js").JsonObject;
    }>,
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
    const timeoutGuard = createStreamingProgressTimeout(
      this.streamInitialTimeoutMs,
      this.streamStallTimeoutMs,
    );
    try {
      const streamPromise = (provider as IStreamingProvider).chatStream(
        systemPrompt,
        session.messages,
        toolDefinitions,
        (chunk) => {
          timeoutGuard.markProgress();
          onChunk(chunk);
        },
      );

      // Race against abort signal
      response = await Promise.race([streamPromise, timeoutGuard.timeoutPromise]);

      timeoutGuard.clear();
    } catch (streamError) {
      timeoutGuard.clear();
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

    return response;
  }

  /**
   * Execute tool calls, handling confirmations for write operations.
   */
  private isSelfManagedInteractiveMode(
    chatId: string,
    mode: ToolExecutionMode,
    userId?: string,
  ): boolean {
    return mode !== "interactive" || this.dmPolicy.isAutonomousActive(chatId, userId);
  }

  private resolveToolExecutionPolicy(
    chatId: string,
    toolName: string,
    mode: ToolExecutionMode,
    userId?: string,
  ) {
    return resolveExecutionPolicy({
      executionMode: mode,
      autonomousActive: this.dmPolicy.isAutonomousActive(chatId, userId),
      isWriteOperation: this.isWriteOperation(toolName),
      requireConfirmation: this.requireConfirmation,
      readOnly: this.readOnly,
      hasPlanReviewGate: this.interactionPolicy.getWriteBlock(chatId, toolName) !== null,
    });
  }

  private normalizeInteractiveText(value: unknown): string {
    return normalizePolicyText(value);
  }

  private async resolveInteractiveToolCall(
    chatId: string,
    toolCall: ToolCall,
    mode: ToolExecutionMode,
    taskPrompt: string | undefined,
    userId?: string,
  ): Promise<ToolResult | null> {
    const interactionMode = mode === "delegated" ? "background" : mode;
    if (toolCall.name === "show_plan") {
        const explicitPlanReview = taskPrompt && userExplicitlyAskedForPlan(taskPrompt);
        if (explicitPlanReview) {
          const planText = formatRequestedPlan(toolCall.input);
          if (!planText) {
            this.interactionPolicy.requirePlanReview(
              chatId,
              "user explicitly asked to review a plan first",
          );
          return {
            toolCallId: toolCall.id,
            content:
              "Plan request could not be satisfied because the proposed plan is incomplete. " +
              "Provide a concrete summary and actionable steps before asking the user to review it. " +
              "Do not execute write-capable actions until the plan is reviewed.",
            isError: true,
          };
        }

        this.interactionPolicy.requirePlanReview(
          chatId,
          "user explicitly asked to review a plan first",
          planText,
        );

        if (mode === "interactive" && this.channel && supportsInteractivity(this.channel)) {
          const response = await this.channel.requestConfirmation({
            chatId,
            userId,
            question: planText,
            options: ["Approve", "Modify", "Reject"],
            details: "User explicitly asked to review the plan before execution.",
          });

          if (response === "timeout") {
            return {
              toolCallId: toolCall.id,
              content:
                "User did not respond to the requested plan review. Wait for their decision before proceeding with write-capable actions.",
              isError: true,
            };
          }

          if (response === "Approve") {
            this.interactionPolicy.clear(chatId);
            return {
              toolCallId: toolCall.id,
              content: "Plan approved by user. Proceed with execution.",
            };
          }

          return {
            toolCallId: toolCall.id,
            content:
              response === "Reject"
                ? "Plan rejected by user. Revise the approach or ask one focused follow-up question only if a real decision blocker remains. Do not execute write-capable actions until the revised plan is approved."
                : `User requested plan changes: "${response}". Revise the plan accordingly and show it again before proceeding. Do not execute write-capable actions until the revised plan is approved.`,
            isError: response === "Reject",
          };
        }

        return {
          toolCallId: toolCall.id,
          content:
            "User explicitly asked to review the plan before execution. Present the plan in your next user-facing response and wait for approval or revision before any write-capable actions.",
          isError: true,
        };
      }

      const review = reviewAutonomousPlan(toolCall.input, interactionMode);
      return { toolCallId: toolCall.id, content: review.content, isError: review.isError };
    }

    if (!this.isSelfManagedInteractiveMode(chatId, mode, userId)) {
      return null;
    }

    if (toolCall.name === "ask_user") {
      const review = reviewAutonomousQuestion(toolCall.input, interactionMode);
      return { toolCallId: toolCall.id, content: review.content, isError: review.isError };
    }

    return null;
  }

  private reviewSelfManagedWriteOperation(
    chatId: string,
    toolName: string,
    input: Record<string, unknown>,
    mode: ToolExecutionMode,
    options: ToolExecutionOptions,
  ): Promise<SelfManagedWriteReview> | SelfManagedWriteReview {
    switch (toolName) {
      case "shell_exec": {
        const command = this.normalizeInteractiveText(input["command"]);
        if (!command) {
          return { approved: false, reason: "shell command is missing" };
        }
        if (isDestructiveOperation(toolName, input)) {
          return { approved: false, reason: "shell command looks destructive" };
        }
        return this.reviewShellCommandWithProvider(chatId, command, mode, options, input);
      }
      case "file_rename": {
        const oldPath = this.normalizeInteractiveText(input["old_path"]);
        const newPath = this.normalizeInteractiveText(input["new_path"]);
        if (!oldPath || !newPath) {
          return {
            approved: false,
            reason: "rename operation is missing a source or destination path",
          };
        }
        return { approved: true };
      }
      case "git_commit": {
        const message = this.normalizeInteractiveText(input["message"]);
        if (message.length < 3) {
          return { approved: false, reason: "git commit message is too short" };
        }
        return { approved: true };
      }
      case "file_write":
      case "file_create":
      case "file_edit":
      case "file_delete":
      case "file_delete_directory": {
        const path = this.normalizeInteractiveText(input["path"]);
        if (!path) {
          return { approved: false, reason: "target path is missing" };
        }
        return { approved: true };
      }
      default:
        return { approved: true };
    }
  }

  private extractConversationText(content: string | MessageContent[]): string {
    if (typeof content === "string") {
      return content;
    }

    return content
      .map((block) => {
        switch (block.type) {
          case "text":
            return block.text;
          case "tool_result":
            return block.content;
          case "tool_use":
            return `${block.name}(${JSON.stringify(block.input)})`;
          default:
            return "";
        }
      })
      .filter((part) => part.length > 0)
      .join(" ");
  }

  private summarizeMessagesForShellReview(messages?: ConversationMessage[]): string {
    if (!messages || messages.length === 0) {
      return "";
    }

    return messages
      .slice(-4)
      .map((message) => {
        const text = this.extractConversationText(message.content).replace(/\s+/g, " ").trim();
        if (!text) {
          return "";
        }
        return `${message.role}: ${text.slice(0, 220)}`;
      })
      .filter((line) => line.length > 0)
      .join("\n");
  }

  private recordAuxiliaryUsage(
    provider: string,
    usage: ProviderResponse["usage"] | undefined,
    sink?: (usage: TaskUsageEvent) => void,
  ): void {
    if (!usage) {
      return;
    }

    this.metrics?.recordTokenUsage(usage.inputTokens, usage.outputTokens, provider);
    this.rateLimiter?.recordTokenUsage(usage.inputTokens, usage.outputTokens, provider);
    sink?.({
      provider,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
  }

  private async resolveVerifierIntervention(params: {
    chatId: string;
    identityKey: string;
    prompt: string;
    state: AgentState;
    draft: string | null | undefined;
    selfVerification: SelfVerification;
    stradaConformance: StradaConformanceGuard;
    strategy: SupervisorExecutionStrategy;
    taskStartedAtMs: number;
    availableToolNames?: readonly string[];
    usageHandler?: (usage: TaskUsageEvent) => void;
  }): Promise<VerifierIntervention> {
    const verificationState = params.selfVerification.getState();
    const logEntries = typeof getLogRingBuffer === "function" ? getLogRingBuffer() : [];
    const buildVerificationGate = params.selfVerification.needsVerification()
      ? params.selfVerification.getPrompt()
      : null;
    const conformanceGate = params.stradaConformance.getPrompt();
    const plan = planVerifierPipeline({
      prompt: params.prompt,
      draft: params.draft ?? "",
      state: params.state,
      task: params.strategy.task,
      verificationState,
      buildVerificationGate,
      conformanceGate,
      logEntries,
      chatId: params.chatId,
      taskStartedAtMs: params.taskStartedAtMs,
    });
    const boundaryDecision = decideInteractionBoundary({
      prompt: params.prompt,
      workerDraft: params.draft ?? "",
      visibleDraft: "",
      task: params.strategy.task,
      evidence: plan.evidence,
      canInspectLocally: this.canInspectLocally(
        params.prompt,
        params.strategy.task,
        params.availableToolNames ?? [],
      ),
      terminalFailureReported: isTerminalFailureReport(params.draft ?? ""),
      availableToolNames: params.availableToolNames,
    });
    if (boundaryDecision.kind === "internal_continue" && boundaryDecision.gate) {
      this.recordRuntimeArtifactEvaluation({
        chatId: params.chatId,
        taskRunId: this.getTaskExecutionContext()?.taskRunId,
        decision: "continue",
        summary: "The current draft still deflects execution back to the user.",
        failureReason: params.draft,
      });
      return {
        kind: "continue",
        gate: boundaryDecision.gate,
        result: {
          decision: "continue",
          gate: boundaryDecision.gate,
          summary: "The current draft still deflects execution back to the user.",
          checks: plan.checks,
          evidence: plan.evidence,
        },
      };
    }

    if (!plan.reviewRequired) {
      this.recordRuntimeArtifactEvaluation({
        chatId: params.chatId,
        taskRunId: this.getTaskExecutionContext()?.taskRunId,
        decision: plan.initialDecision,
        summary: plan.summary,
        failureReason: params.draft,
      });
      return {
        kind:
          plan.initialDecision === "replan"
            ? "replan"
            : plan.initialDecision === "continue"
              ? "continue"
              : "approve",
        gate: plan.gate,
        result: {
          decision: plan.initialDecision,
          gate: plan.gate,
          summary: plan.summary,
          checks: plan.checks,
          evidence: plan.evidence,
        },
      };
    }

    try {
      const stagedReview = await this.runCompletionReviewStages({
        chatId: params.chatId,
        identityKey: params.identityKey,
        prompt: params.prompt,
        state: params.state,
        draft: params.draft ?? "",
        plan,
        strategy: params.strategy,
        usageHandler: params.usageHandler,
      });
      const result = finalizeVerifierPipelineReview(
        plan,
        stagedReview.decision,
        params.draft,
        stagedReview.stageResults,
      );
      this.recordPhaseOutcome({
        chatId: params.chatId,
        identityKey: params.identityKey,
        assignment: params.strategy.reviewer,
        phase: "completion-review",
        source: "completion-review",
        status: this.toPhaseOutcomeStatus(result.decision),
        task: params.strategy.task,
        reason: result.summary,
        telemetry: this.buildPhaseOutcomeTelemetry({
          usage: stagedReview.usage,
          verifierDecision: result.decision,
          state: params.state,
          failureReason: params.draft,
        }),
      });
      this.recordRuntimeArtifactEvaluation({
        chatId: params.chatId,
        taskRunId: this.getTaskExecutionContext()?.taskRunId,
        decision: result.decision,
        summary: result.summary,
        failureReason: params.draft,
      });
      return {
        kind:
          result.decision === "replan"
            ? "replan"
            : result.decision === "continue"
              ? "continue"
              : "approve",
        gate: result.gate,
        result,
      };
    } catch (error) {
      getLogger().warn("Completion review provider failed", {
        chatId: params.chatId,
        provider: params.strategy.reviewer.providerName,
        error: error instanceof Error ? error.message : String(error),
      });
      this.recordPhaseOutcome({
        chatId: params.chatId,
        identityKey: params.identityKey,
        assignment: params.strategy.reviewer,
        phase: "completion-review",
        source: "completion-review",
        status: "failed",
        task: params.strategy.task,
        reason: "Completion review provider failed; falling back to conservative verifier gate.",
        telemetry: this.buildPhaseOutcomeTelemetry({
          state: params.state,
          failureReason: params.draft,
        }),
      });
    }

    const fallbackResult = finalizeVerifierPipelineReview(plan, null, params.draft);
    this.recordRuntimeArtifactEvaluation({
      chatId: params.chatId,
      taskRunId: this.getTaskExecutionContext()?.taskRunId,
      decision: fallbackResult.decision,
      summary: fallbackResult.summary,
      failureReason: params.draft,
    });
    return {
      kind:
        fallbackResult.decision === "replan"
          ? "replan"
          : fallbackResult.decision === "continue"
            ? "continue"
            : "approve",
      gate: fallbackResult.gate,
      result: fallbackResult,
    };
  }

  private buildStructuredProgressSignal(
    prompt: string,
    title: string,
    signal: Omit<TaskProgressSignal, "userSummary"> & { userSummary?: string },
    language?: ProgressLanguage,
  ): TaskProgressSignal {
    const withSummary: TaskProgressSignal = {
      ...signal,
      userSummary:
        signal.userSummary ??
        buildTaskProgressSummary(
          { title, prompt },
          signal,
          language ?? this.defaultLanguage,
        ),
    };
    return withSummary;
  }

  private buildToolBatchProgressSignal(params: {
    prompt: string;
    title: string;
    toolCalls: readonly ToolCall[];
    language?: ProgressLanguage;
  }): TaskProgressSignal {
    const toolNames = params.toolCalls.map((toolCall) => toolCall.name);
    const files = [...new Set(
      params.toolCalls
        .map((toolCall) => extractFilePath(toolCall.input as Record<string, unknown>))
        .filter((file) => file.trim().length > 0),
    )];
    const delegationType = toolNames.find((name) => name.startsWith("delegate_"));
    const hasVerification = params.toolCalls.some((toolCall) => this.isVerificationProgressTool(toolCall));
    const hasMutation = params.toolCalls.some((toolCall) => MUTATION_TOOLS.has(toolCall.name));
    const hasInspection = params.toolCalls.some((toolCall) =>
      toolCall.name === "file_read"
      || toolCall.name === "list_directory"
      || toolCall.name.includes("search")
      || toolCall.name.includes("analyze"),
    );

    const kind = delegationType
      ? "delegation"
      : hasVerification
        ? "verification"
        : hasMutation
          ? "editing"
          : hasInspection
            ? "inspection"
            : "analysis";

    return this.buildStructuredProgressSignal(
      params.prompt,
      params.title,
      {
        kind,
        message: `Running tools: ${toolNames.join(", ")}`,
        toolNames,
        files,
        delegationType: delegationType?.replace(/^delegate_/, ""),
      },
      params.language,
    );
  }

  private isVerificationProgressTool(toolCall: ToolCall): boolean {
    if (isVerificationToolName(toolCall.name)) {
      return true;
    }
    if (toolCall.name !== "shell_exec") {
      return false;
    }
    const command =
      typeof toolCall.input["command"] === "string" ? toolCall.input["command"].trim() : "";
    return /\b(?:test|build|check|lint|typecheck|verify|compile|playmode|editmode|smoke)\b/iu.test(command);
  }

  private selectLoopRecoveryDelegationTool(
    availableToolNames: readonly string[] | undefined,
    touchedFiles: readonly string[],
  ): "delegate_analysis" | "delegate_code_review" | null {
    if (!availableToolNames || availableToolNames.length === 0) {
      return null;
    }
    if (touchedFiles.length > 0 && availableToolNames.includes("delegate_code_review")) {
      return "delegate_code_review";
    }
    if (availableToolNames.includes("delegate_analysis")) {
      return "delegate_analysis";
    }
    if (availableToolNames.includes("delegate_code_review")) {
      return "delegate_code_review";
    }
    return null;
  }

  private async resolveLoopRecoveryReview(params: {
    chatId: string;
    identityKey: string;
    brief: LoopRecoveryBrief;
    strategy: SupervisorExecutionStrategy;
    usageHandler?: (usage: TaskUsageEvent) => void;
  }): Promise<LoopRecoveryReviewDecision> {
    const reviewer = params.strategy.reviewer;
    try {
      const response = await reviewer.provider.chat(
        LOOP_RECOVERY_REVIEW_SYSTEM_PROMPT,
        [
          {
            role: "user",
            content: buildLoopRecoveryReviewRequest(params.brief),
          },
        ],
        [],
      );
      this.recordAuxiliaryUsage(reviewer.providerName, response.usage, params.usageHandler);
      return sanitizeLoopRecoveryReviewDecision(
        parseLoopRecoveryReviewDecision(response.text),
      ) ?? { decision: "replan_local", reason: "Loop recovery review returned no usable decision." };
    } catch (error) {
      getLogger().warn("Loop recovery review provider failed", {
        chatId: params.chatId,
        provider: reviewer.providerName,
        error: error instanceof Error ? error.message : String(error),
      });
      return { decision: "replan_local", reason: "Loop recovery review failed; falling back to local replanning." };
    }
  }

  private isNovelLoopRecoveryAction(
    decision: LoopRecoveryReviewDecision,
    brief: LoopRecoveryBrief,
  ): boolean {
    const action = decision.recommendedNextAction?.trim().toLowerCase();
    if (!action) {
      return false;
    }
    if (brief.requiredActions.some((item) => item.toLowerCase() === action)) {
      return false;
    }
    if (brief.recentToolSummaries.some((item) => item.toLowerCase().includes(action))) {
      return false;
    }
    return true;
  }

  private buildLoopRecoveryGate(params: {
    brief: LoopRecoveryBrief;
    decision: LoopRecoveryReviewDecision;
    delegatedSummary?: string;
  }): string {
    const lines = [
      "[LOOP RECOVERY REQUIRED]",
      "",
      `Loop fingerprint: ${params.brief.fingerprint}`,
      `Reason: ${params.decision.reason ?? params.brief.latestReason ?? "Repeated internal review loop detected."}`,
    ];
    if (params.delegatedSummary) {
      lines.push(`Delegated diagnosis: ${params.delegatedSummary}`);
    }
    if (params.brief.requiredActions.length > 0) {
      lines.push("Required verifier actions:");
      for (const action of params.brief.requiredActions.slice(0, 4)) {
        lines.push(`- ${action}`);
      }
    }
    if (params.decision.recommendedNextAction) {
      lines.push(`Next action: ${params.decision.recommendedNextAction}`);
    }
    lines.push("Do not repeat the same fingerprint without materially new evidence.");
    return lines.join("\n");
  }

  private buildLoopRecoveryCheckpointMessage(params: {
    prompt: string;
    brief: LoopRecoveryBrief;
    decision: LoopRecoveryReviewDecision;
    touchedFiles: readonly string[];
  }): string {
    const title = params.prompt.replace(/\s+/g, " ").trim().slice(0, 80) || "Task checkpoint";
    const touched = params.touchedFiles.slice(0, 5).map((file) => `- ${file}`);
    const progress = params.brief.recentUserFacingProgress.slice(-3).map((line) => `- ${line}`);
    return [
      `Blocked checkpoint: ${title}`,
      "",
      `Reason: ${params.decision.reason ?? params.brief.latestReason ?? "Repeated internal review loop detected."}`,
      params.brief.verifierSummary ? `Verifier: ${params.brief.verifierSummary}` : "",
      progress.length > 0 ? `Recent progress:\n${progress.join("\n")}` : "",
      touched.length > 0 ? `Touched files:\n${touched.join("\n")}` : "",
      "Stopped here to avoid growing the same control loop again.",
    ].filter(Boolean).join("\n\n");
  }

  private async handleBackgroundLoopRecovery(params: {
    chatId: string;
    identityKey: string;
    prompt: string;
    title: string;
    language?: ProgressLanguage;
    state: AgentState;
    strategy: SupervisorExecutionStrategy;
    tracker: ControlLoopTracker;
    executionJournal: ExecutionJournal;
    kind: ControlLoopGateKind;
    reason?: string;
    gate?: string;
    iteration: number;
    availableToolNames?: readonly string[];
    selfVerification: SelfVerification;
    usageHandler?: (usage: TaskUsageEvent) => void;
    onProgress: (message: TaskProgressUpdate) => void;
    session: Session;
    workerCollector?: WorkerRunCollector;
    workspaceLease?: WorkspaceLease;
  }): Promise<LoopRecoveryIntervention> {
    const touchedFiles = [...params.selfVerification.getState().touchedFiles];
    const trigger = params.tracker.recordGate({
      kind: params.kind,
      reason: params.reason,
      gate: params.gate,
      iteration: params.iteration,
    });
    if (!trigger) {
      return { action: "none" };
    }

    const delegationTool = this.selectLoopRecoveryDelegationTool(
      params.availableToolNames,
      touchedFiles,
    );
    const brief = params.executionJournal.buildRecoveryBrief({
      fingerprint: trigger.fingerprint,
      latestReason: trigger.latestReason,
      touchedFiles,
      recoveryEpisode: trigger.recoveryEpisode + 1,
      availableDelegations: delegationTool ? [delegationTool] : [],
    });
    const reviewDecision = await this.resolveLoopRecoveryReview({
      chatId: params.chatId,
      identityKey: params.identityKey,
      brief,
      strategy: params.strategy,
      usageHandler: params.usageHandler,
    });
    const recoveryAttempt = params.tracker.markRecoveryAttempt(trigger.fingerprint);

    let finalDecision = reviewDecision;
    if (recoveryAttempt >= 2) {
      finalDecision = {
        decision: "blocked",
        reason: reviewDecision.reason ?? "Repeated control-loop recovery attempts did not produce a clean path.",
        summary: reviewDecision.summary,
      };
    } else if (recoveryAttempt >= 1 && delegationTool) {
      finalDecision = {
        ...reviewDecision,
        decision:
          delegationTool === "delegate_code_review"
            ? "delegate_code_review"
            : "delegate_analysis",
      };
    } else if (reviewDecision.decision === "continue_local" && !this.isNovelLoopRecoveryAction(reviewDecision, brief)) {
      finalDecision = {
        ...reviewDecision,
        decision: "replan_local",
        reason: reviewDecision.reason ?? "Suggested next action was not materially different from the repeated loop.",
      };
    }

    if (finalDecision.decision === "delegate_analysis" || finalDecision.decision === "delegate_code_review") {
      const toolName = finalDecision.decision === "delegate_code_review"
        ? "delegate_code_review"
        : "delegate_analysis";
      if (params.availableToolNames?.includes(toolName)) {
        params.onProgress(
          this.buildStructuredProgressSignal(
            params.prompt,
            params.title,
            {
              kind: "delegation",
              message: `Loop recovery delegation: ${toolName}`,
              delegationType: toolName.replace(/^delegate_/, ""),
              files: touchedFiles,
            },
            params.language,
          ),
        );
        const delegatedTask =
          finalDecision.delegationTask
          ?? (
            toolName === "delegate_code_review"
              ? `Review the touched files and identify why the current verification loop is not closing cleanly.\nTouched files:\n${touchedFiles.join("\n") || "(none)"}`
              : `Analyze the repeated control loop and identify the missing evidence or verification path.\nFingerprint: ${brief.fingerprint}\nVerifier memory: ${brief.verifierSummary ?? "(none)"}`
          );
        const toolCall: ToolCall = {
          id: `loop-recovery-${randomUUID()}`,
          name: toolName,
          input: {
            task: delegatedTask,
            context: buildLoopRecoveryReviewRequest(brief),
            mode: "sync",
          },
        };
        const toolResults = await this.executeToolCalls(params.chatId, [toolCall], {
          mode: "background",
          taskPrompt: params.prompt,
          sessionMessages: params.session.messages,
          onUsage: params.usageHandler,
          identityKey: params.identityKey,
          strategy: params.strategy,
          agentState: params.state,
          touchedFiles,
          workspaceLease: params.workspaceLease,
        });
        const toolResult = toolResults[0];
        const delegatedWorkerResult = toolResult?.metadata?.["workerResult"] as WorkerRunResult | undefined;
        if (toolResult) {
          params.workerCollector?.toolTrace.push({
            toolName: toolCall.name,
            success: !(toolResult.isError ?? false),
            summary: toolResult.content.slice(0, 200),
            timestamp: Date.now(),
            workspaceId: params.workspaceLease?.id,
          });
        }
        if (delegatedWorkerResult) {
          params.selfVerification.ingestWorkerResult(delegatedWorkerResult);
          params.workerCollector?.childWorkerResults.push(delegatedWorkerResult);
        }
        params.executionJournal.recordDelegatedDiagnosis(
          toolName.replace(/^delegate_/, ""),
          toolResult?.content ?? delegatedWorkerResult?.finalSummary ?? "",
        );
        params.executionJournal.recordLoopRecoveryEpisode({
          fingerprint: brief.fingerprint,
          decision: finalDecision.decision,
          summary: finalDecision.reason ?? "Delegated diagnosis requested.",
        });
        return {
          action: "replan",
          gate: this.buildLoopRecoveryGate({
            brief,
            decision: finalDecision,
            delegatedSummary:
              delegatedWorkerResult?.finalSummary
              ?? toolResult?.content
              ?? finalDecision.summary,
          }),
          summary: delegatedWorkerResult?.finalSummary ?? toolResult?.content ?? finalDecision.summary,
        };
      }
      finalDecision = {
        ...finalDecision,
        decision: "replan_local",
        reason: finalDecision.reason ?? "Delegation was requested but not available; falling back to local replanning.",
      };
    }

    params.executionJournal.recordLoopRecoveryEpisode({
      fingerprint: brief.fingerprint,
      decision: finalDecision.decision ?? "replan_local",
      summary: finalDecision.reason ?? "Loop recovery requested a different path.",
    });

    if (finalDecision.decision === "blocked") {
      return {
        action: "blocked",
        message: this.buildLoopRecoveryCheckpointMessage({
          prompt: params.prompt,
          brief,
          decision: finalDecision,
          touchedFiles,
        }),
      };
    }

    if (finalDecision.decision === "continue_local") {
      return {
        action: "continue",
        gate: this.buildLoopRecoveryGate({
          brief,
          decision: finalDecision,
        }),
      };
    }

    return {
      action: "replan",
      gate: this.buildLoopRecoveryGate({
        brief,
        decision: finalDecision,
      }),
    };
  }

  private resolveCompletionReviewStageAssignment(
    stage: CompletionReviewStageName,
    params: {
      prompt: string;
      identityKey: string;
      strategy: SupervisorExecutionStrategy;
    },
  ): SupervisorAssignment {
    const task =
      stage === "code"
        ? { ...params.strategy.task, type: "code-review" as const }
        : stage === "simplify"
          ? { ...params.strategy.task, type: "refactoring" as const }
          : {
            ...params.strategy.task,
            type: "analysis" as const,
            criticality: params.strategy.task.criticality === "low" ? "medium" : params.strategy.task.criticality,
          };

    return this.resolveSupervisorAssignment(
      "reviewer",
      task,
      "completion-review",
      params.identityKey,
      params.strategy.reviewer.providerName,
      params.strategy.reviewer.provider,
      `${params.prompt}\n\nCompletion review stage: ${stage}.`,
    );
  }

  private buildCompletionReviewStageFallback(
    stage: CompletionReviewStageName,
    summary: string,
    requiredAction: string,
  ): CompletionReviewStageResult {
    return {
      stage,
      status: "issues",
      summary,
      findings: [summary],
      requiredActions: [requiredAction],
    };
  }

  private deriveStageResultsFromLegacyReviewDecision(
    decision: ReturnType<typeof parseCompletionReviewDecision>,
  ): CompletionReviewStageResult[] {
    if (!decision?.reviews) {
      return [];
    }

    return [
      {
        stage: "code",
        status: decision.reviews.code === "issues" || decision.reviews.code === "not_applicable"
          ? decision.reviews.code
          : "clean",
        summary: decision.summary,
      },
      {
        stage: "simplify",
        status: decision.reviews.simplify === "issues" || decision.reviews.simplify === "not_applicable"
          ? decision.reviews.simplify
          : "clean",
        summary: decision.summary,
      },
      {
        stage: "security",
        status: decision.reviews.security === "issues" || decision.reviews.security === "not_applicable"
          ? decision.reviews.security
          : "clean",
        summary: decision.summary,
      },
    ];
  }

  private async runCompletionReviewStages(params: {
    chatId: string;
    identityKey: string;
    prompt: string;
    state: AgentState;
    draft: string;
    plan: ReturnType<typeof planVerifierPipeline>;
    strategy: SupervisorExecutionStrategy;
    usageHandler?: (usage: TaskUsageEvent) => void;
  }): Promise<{
    decision: ReturnType<typeof parseCompletionReviewDecision>;
    stageResults: CompletionReviewStageResult[];
    usage?: ProviderResponse["usage"];
  }> {
    const verifierChecks = params.plan.checks.map(
      (check) => `- ${check.name}: ${check.status} — ${check.summary}`,
    );
    const stageResults: CompletionReviewStageResult[] = [];
    const stages: CompletionReviewStageName[] = ["code", "simplify", "security"];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    const recordUsage = (usage: ProviderResponse["usage"] | undefined) => {
      if (!usage) {
        return;
      }
      totalInputTokens += usage.inputTokens ?? 0;
      totalOutputTokens += usage.outputTokens ?? 0;
    };

    for (const stage of stages) {
      const assignment = this.resolveCompletionReviewStageAssignment(stage, params);
      try {
        const reviewResponse = await assignment.provider.chat(
          `${this.systemPrompt}\n\n${buildCompletionReviewStageSystemPrompt(stage)}${this.buildSupervisorRolePrompt(params.strategy, assignment)}`,
          [
            {
              role: "user",
              content: buildCompletionReviewStageRequest({
                stage,
                prompt: params.prompt,
                draft: params.draft,
                state: params.state,
                evidence: params.plan.evidence,
                verifierChecks,
              }),
            },
          ],
          [],
        );
        this.recordExecutionTrace({
          chatId: params.chatId,
          identityKey: params.identityKey,
          assignment,
          phase: "completion-review",
          source: "completion-review",
          task: params.strategy.task,
          reason: `${stage} stage review`,
        });
        this.recordAuxiliaryUsage(assignment.providerName, reviewResponse.usage, params.usageHandler);
        recordUsage(reviewResponse.usage);
        const legacyDecision = parseCompletionReviewDecision(reviewResponse.text);
        const looksLikeLegacyCompletionDecision = Boolean(
          legacyDecision?.decision
          || legacyDecision?.closureStatus
          || legacyDecision?.logStatus
          || legacyDecision?.reviews,
        );
        if (looksLikeLegacyCompletionDecision && stageResults.length === 0) {
          return {
            decision: legacyDecision,
            stageResults: this.deriveStageResultsFromLegacyReviewDecision(legacyDecision),
            usage: {
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              totalTokens: totalInputTokens + totalOutputTokens,
            },
          };
        }
        stageResults.push(
          parseCompletionReviewStageResult(reviewResponse.text, stage)
          ?? this.buildCompletionReviewStageFallback(
            stage,
            `${stage} review returned an invalid response.`,
            `Rerun the ${stage} review and continue conservatively until it is clean.`,
          ),
        );
      } catch (error) {
        getLogger().warn("Completion review stage failed", {
          chatId: params.chatId,
          stage,
          provider: assignment.providerName,
          error: error instanceof Error ? error.message : String(error),
        });
        stageResults.push(
          this.buildCompletionReviewStageFallback(
            stage,
            `${stage} review failed before Strada could validate completion.`,
            `Investigate the ${stage} review failure, rerun that review, and continue conservatively.`,
          ),
        );
      }
    }

    const reviewer = this.resolveSupervisorAssignment(
      "reviewer",
      { ...params.strategy.task, type: "code-review" },
      "completion-review",
      params.identityKey,
      params.strategy.reviewer.providerName,
      params.strategy.reviewer.provider,
      `${params.prompt}\n\nCompletion review synthesis.`,
    );
    const synthesisRequest = buildCompletionReviewSynthesisRequest({
      prompt: params.prompt,
      draft: params.draft,
      state: params.state,
      evidence: params.plan.evidence,
      verifierChecks,
      stageResults,
    });

    const reviewResponse = await reviewer.provider.chat(
      `${this.systemPrompt}\n\n${COMPLETION_REVIEW_SYNTHESIS_SYSTEM_PROMPT}${this.buildSupervisorRolePrompt(params.strategy, reviewer)}`,
      [
        {
          role: "user",
          content: synthesisRequest,
        },
      ],
      [],
    ).catch((error) => {
      getLogger().warn("Completion review synthesis failed", {
        chatId: params.chatId,
        provider: reviewer.providerName,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    if (!reviewResponse) {
      return {
        decision: null,
        stageResults,
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          totalTokens: totalInputTokens + totalOutputTokens,
        },
      };
    }
    this.recordExecutionTrace({
      chatId: params.chatId,
      identityKey: params.identityKey,
      assignment: reviewer,
      phase: "completion-review",
      source: "completion-review",
      task: params.strategy.task,
      reason: "aggregated staged completion review",
    });
    this.recordAuxiliaryUsage(reviewer.providerName, reviewResponse.usage, params.usageHandler);
    recordUsage(reviewResponse.usage);
    return {
      decision: parseCompletionReviewDecision(reviewResponse.text),
      stageResults,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
      },
    };
  }

  private async reviewShellCommandWithProvider(
    chatId: string,
    command: string,
    mode: ToolExecutionMode,
    options: ToolExecutionOptions,
    input: Record<string, unknown>,
  ): Promise<SelfManagedWriteReview> {
    const identityKey = resolveIdentityKey(chatId, options.userId, undefined, this.userProfileStore);
    const provider = this.providerManager.getProvider(identityKey);
    const taskPrompt = this.normalizeInteractiveText(options.taskPrompt);
    const recentContext = this.summarizeMessagesForShellReview(options.sessionMessages);
    const workingDirectory = this.normalizeInteractiveText(input["working_directory"]) || ".";
    const timeoutMs = Number(input["timeout_ms"] ?? 30000);
    const reviewAssignment = this.buildStaticSupervisorAssignment(
      "reviewer",
      provider.name,
      this.resolveProviderModelId(provider.name, identityKey),
      provider,
      "reviewed whether a write-capable shell command should run autonomously",
    );
    const reviewTask = this.taskClassifier.classify(taskPrompt || command);

    try {
      const response = await provider.chat(
        SHELL_REVIEW_SYSTEM_PROMPT,
        [
          {
            role: "user",
            content:
              `Mode: ${mode}\n` +
              `Task: ${taskPrompt || "(not provided)"}\n` +
              `Working directory: ${workingDirectory}\n` +
              `Timeout ms: ${Number.isFinite(timeoutMs) ? timeoutMs : 30000}\n` +
              `Recent context:\n${recentContext || "(none)"}\n\n` +
              `Command:\n${command}`,
          },
        ],
        [],
      );
      this.recordExecutionTrace({
        chatId,
        identityKey,
        assignment: reviewAssignment,
        phase: "shell-review",
        source: "shell-review",
        task: reviewTask,
      });

      this.recordAuxiliaryUsage(provider.name, response.usage, options.onUsage ?? this.onUsage);
      const decision = parseShellReviewDecision(response.text);

      if (
        decision?.decision === "approve" &&
        decision.taskAligned !== false &&
        decision.bounded !== false
      ) {
        this.recordPhaseOutcome({
          chatId,
          identityKey,
          assignment: reviewAssignment,
          phase: "shell-review",
          source: "shell-review",
          status: "approved",
          task: reviewTask,
          reason: decision.reason || "Shell review approved the autonomous command.",
          telemetry: this.buildPhaseOutcomeTelemetry({
            usage: response.usage,
          }),
        });
        return { approved: true, reason: decision.reason };
      }

      if (
        decision?.decision === "reject" ||
        decision?.taskAligned === false ||
        decision?.bounded === false
      ) {
        this.recordPhaseOutcome({
          chatId,
          identityKey,
          assignment: reviewAssignment,
          phase: "shell-review",
          source: "shell-review",
          status: "blocked",
          task: reviewTask,
          reason: decision.reason || "Shell review rejected the autonomous command.",
          telemetry: this.buildPhaseOutcomeTelemetry({
            usage: response.usage,
            failureReason: command,
          }),
        });
        return { approved: false, reason: decision.reason || "shell review rejected the command" };
      }
    } catch {
      this.recordPhaseOutcome({
        chatId,
        identityKey,
        assignment: reviewAssignment,
        phase: "shell-review",
        source: "shell-review",
        status: "failed",
        task: reviewTask,
        reason: "Shell review provider failed; falling back to bounded local heuristics.",
        telemetry: this.buildPhaseOutcomeTelemetry({
          failureReason: command,
        }),
      });
      // Fall back to local bounded-command heuristics below.
    }

    if (isSafeShellFallback(command)) {
      return {
        approved: true,
        reason: "shell review fallback approved a bounded development command",
      };
    }

    return { approved: false, reason: "shell review was inconclusive for this command" };
  }

  private buildSelfManagedWriteRejection(
    toolCallId: string,
    toolName: string,
    mode: ToolExecutionMode,
    reason: string,
  ): ToolResult {
    return {
      toolCallId,
      content:
        `Self-managed write review rejected (${mode} mode) for '${toolName}': ${reason}. ` +
        "Choose a safer bounded operation and continue without waiting for user approval.",
      isError: true,
    };
  }

  private async executeToolCalls(
    chatId: string,
    toolCalls: ToolCall[],
    options: ToolExecutionOptions = {},
  ): Promise<ToolResult[]> {
    const logger = getLogger();
    const results: ToolResult[] = [];
    const mode = options.mode ?? "interactive";
    const workspacePath = options.workspaceLease?.path;
    const projectPath = options.projectPathOverride ?? workspacePath ?? this.projectPath;
    const workingDirectory =
      options.workingDirectoryOverride ?? workspacePath ?? this.projectPath;

    const toolContext: ToolContext & { soulLoader?: SoulLoader | null } = {
      projectPath,
      workingDirectory,
      readOnly: this.readOnly,
      userId: options.userId,
      chatId,
      channel: this.channel,
      soulLoader: this.soulLoader,
    };

    for (const tc of toolCalls) {
      let activeToolCall = tc;
      const interactiveResolution = await this.resolveInteractiveToolCall(
        chatId,
        activeToolCall,
        mode,
        options.taskPrompt,
        options.userId,
      );
      if (interactiveResolution) {
        results.push(interactiveResolution);
        continue;
      }

      if (
        mode === "interactive" &&
        activeToolCall.name === "ask_user" &&
        options.taskPrompt &&
        options.identityKey &&
        options.agentState
      ) {
        const clarificationIntervention = await this.resolveAskUserClarificationIntervention({
          chatId,
          identityKey: options.identityKey,
          toolCall: activeToolCall,
          prompt: options.taskPrompt,
          state: options.agentState,
          strategy: options.strategy,
          touchedFiles: options.touchedFiles,
          usageHandler: options.onUsage,
        });
        if (clarificationIntervention.kind === "continue") {
          results.push({
            toolCallId: activeToolCall.id,
            content:
              clarificationIntervention.gate ?? "Continue internally without asking the user yet.",
            isError: false,
          });
          continue;
        }
        if (clarificationIntervention.input) {
          activeToolCall = {
            ...activeToolCall,
            input:
              clarificationIntervention.input as unknown as import("../types/index.js").JsonObject,
          };
        }
      }

      const readOnlyCheck = checkReadOnlyBlock(activeToolCall.name, this.readOnly);
      if (!readOnlyCheck.allowed) {
        results.push(createReadOnlyToolStub(activeToolCall.name, activeToolCall.id));
        continue;
      }

      const tool = this.tools.get(activeToolCall.name);
      if (!tool) {
        results.push({
          toolCallId: activeToolCall.id,
          content: `Error: unknown tool '${activeToolCall.name}'`,
          isError: true,
        });
        continue;
      }

      const executionPolicy = this.resolveToolExecutionPolicy(
        chatId,
        activeToolCall.name,
        mode,
        options.userId,
      );
      logger.debug("Resolved tool execution policy", {
        chatId,
        tool: activeToolCall.name,
        mode: executionPolicy.mode,
        reason: executionPolicy.reason,
        hardBlockers: [...executionPolicy.hardBlockers],
      });
      if (executionPolicy.mode === "blocked") {
        if (executionPolicy.hardBlockers.includes("read_only_mode")) {
          results.push(createReadOnlyToolStub(activeToolCall.name, activeToolCall.id));
          continue;
        }

        const pendingWriteBlock = this.interactionPolicy.getWriteBlock(chatId, activeToolCall.name);
        if (pendingWriteBlock) {
          results.push({
            toolCallId: activeToolCall.id,
            content:
              `Plan approval is still required before '${activeToolCall.name}' can run. ` +
              `Reason: ${pendingWriteBlock.reason}. Revise or reshow the plan, or wait for the user to approve it first.`,
            isError: true,
          });
          continue;
        }

        results.push({
          toolCallId: activeToolCall.id,
          content: executionPolicy.reason,
          isError: true,
        });
        continue;
      }

      // Intervention Engine: evaluate instincts before tool execution (Learning Pipeline v2)
      if (this.interventionEngine && this.instinctRetriever) {
        try {
          const relevantInstincts = await this.instinctRetriever.getMatchedInstincts(
            activeToolCall.name,
          );
          if (relevantInstincts.length > 0) {
            const intervention = this.interventionEngine.evaluate(
              activeToolCall.name,
              activeToolCall.input as Record<string, unknown>,
              relevantInstincts,
            );

            if (intervention.action === 'warn') {
              logger.debug("Intervention engine: warn for tool", {
                tool: activeToolCall.name,
                matches: intervention.matches.length,
              });
            }

            if (intervention.action === 'auto_apply') {
              for (const match of intervention.matches.filter((i: { tier: string }) => i.tier === 'auto')) {
                await this.interventionEngine.logIntervention(
                  match.instinctId, activeToolCall.name, 'auto', 'applied',
                );
              }
            }
          }
        } catch (err) {
          logger.debug("Intervention evaluation skipped", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      logger.debug("Executing tool", {
        chatId,
        tool: activeToolCall.name,
        input: activeToolCall.input,
      });

      if (this.isWriteOperation(activeToolCall.name)) {
        if (executionPolicy.mode === "self_managed") {
          const review = await this.reviewSelfManagedWriteOperation(
            chatId,
            activeToolCall.name,
            activeToolCall.input,
            mode,
            options,
          );
          if (!review.approved) {
            results.push(
              this.buildSelfManagedWriteRejection(
                activeToolCall.id,
                activeToolCall.name,
                mode,
                review.reason ?? "operation did not pass local safety review",
              ),
            );
            continue;
          }
        } else if (executionPolicy.mode === "user_confirm") {
          const destructive = isDestructiveOperation(activeToolCall.name, activeToolCall.input);
          const sessionUserId = options.userId ?? chatId;
          const prefs = this.dmPolicy.getSessionPrefs(sessionUserId, chatId);
          const stubDiff = {
            path: String(activeToolCall.input["path"] ?? ""),
            content: "",
            stats: { additions: 0, deletions: 0, modifications: 0, totalChanges: 1, hunks: 1 },
            oldPath: "",
            newPath: String(activeToolCall.input["path"] ?? ""),
            diff: "",
            isNew: false,
            isDeleted: false,
            isRename: false,
          };
          if (this.dmPolicy.isApprovalRequired(prefs, stubDiff, destructive)) {
            const confirmed = await this.requestWriteConfirmation(
              chatId,
              options.userId,
              activeToolCall.name,
              activeToolCall.input,
            );
            if (!confirmed) {
              results.push({
                toolCallId: activeToolCall.id,
                content: "Operation cancelled by user.",
                isError: false,
              });
              continue;
            }
          }
        }
      }

      const toolStart = Date.now();
      try {
        const result = await tool.execute(activeToolCall.input, toolContext);
        this.metrics?.recordToolCall(activeToolCall.name, Date.now() - toolStart, !result.isError);
        results.push({
          toolCallId: activeToolCall.id,
          content: sanitizeToolResult(result.content),
          isError: result.isError,
          metadata: result.metadata,
        });
      } catch (error) {
        this.metrics?.recordToolCall(activeToolCall.name, Date.now() - toolStart, false);
        const errMsg = error instanceof Error ? error.message : "Unknown error";
        logger.error("Tool execution error", {
          chatId,
          tool: activeToolCall.name,
          error: errMsg,
        });
        results.push({
          toolCallId: activeToolCall.id,
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

  private registerTool(tool: ITool, metadata?: WorkerToolMetadata): void {
    const readOnlyCheck = checkReadOnlyBlock(tool.name, this.readOnly);
    if (!readOnlyCheck.allowed) {
      return;
    }

    this.tools.set(tool.name, tool);
    const intrinsicMetadata = getToolMetadata(tool);
    const existingMetadata = this.toolMetadataByName.get(tool.name);
    const intrinsicRequiresBridge =
      intrinsicMetadata && "requiresBridge" in intrinsicMetadata
        ? Boolean((intrinsicMetadata as Record<string, unknown>).requiresBridge)
        : false;
    const defaultControlPlaneOnly = tool.name === "ask_user" || tool.name === "show_plan";
    this.toolMetadataByName.set(tool.name, {
      readOnly:
        metadata?.readOnly ??
        existingMetadata?.readOnly ??
        intrinsicMetadata?.isReadOnly ??
        !WRITE_OPERATIONS.has(tool.name),
      controlPlaneOnly: Boolean(
        metadata?.controlPlaneOnly ?? existingMetadata?.controlPlaneOnly ?? defaultControlPlaneOnly,
      ),
      requiresBridge: Boolean(
        metadata?.requiresBridge ?? existingMetadata?.requiresBridge ?? intrinsicRequiresBridge,
      ),
      available: metadata?.available ?? existingMetadata?.available ?? true,
      availabilityReason: metadata?.availabilityReason ?? existingMetadata?.availabilityReason,
    });
    const def = {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as import("../types/index.js").JsonObject,
    };
    const existingIdx = this.toolDefinitions.findIndex((td) => td.name === tool.name);
    if (existingIdx >= 0) {
      this.toolDefinitions[existingIdx] = def;
    } else {
      this.toolDefinitions.push(def);
    }
  }

  private async requestWriteConfirmation(
    chatId: string,
    userId: string | undefined,
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
          userId?: string;
          question: string;
          options: string[];
          details?: string;
        }) => Promise<string>;
      }
    ).requestConfirmation({
      chatId,
      userId,
      question,
      options: ["Yes", "No"],
      details,
    });

    return response === "Yes";
  }

  private getSessionPersistenceContext(): SessionPersistenceContext {
    return {
      sessions: this.sessions,
      sessionLocks: this.sessionLocks,
      activeGoalTrees: this.activeGoalTrees,
      pendingResumeTrees: this.pendingResumeTrees,
      memoryManager: this.memoryManager,
      reRetrievalConfig: this.reRetrievalConfig,
      embeddingProvider: this.embeddingProvider,
      ragPipeline: this.ragPipeline,
      instinctRetriever: this.instinctRetriever,
      eventEmitter: this.eventEmitter,
      taskExecutionStore: this.taskExecutionStore,
      lastPersistTime: this.lastPersistTime,
      persistDebounceMs: Orchestrator.PERSIST_DEBOUNCE_MS,
    };
  }

  private extractLastUserMessage(session: Session): string {
    return extractLastUserMessageHelper(session);
  }

  private getOrCreateSession(chatId: string): Session {
    return getOrCreateSessionHelper(this.getSessionPersistenceContext(), chatId);
  }

  /**
   * Trim session history to keep context manageable.
   * Trims at safe boundaries to avoid orphaning tool_use/tool_result pairs.
   * Returns the trimmed (removed) messages for persistence.
   */
  private trimSession(session: Session, maxMessages: number): ConversationMessage[] {
    return trimSessionHelper(session, maxMessages);
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
        // Skip sessions with active locks — they are currently being processed
        if (this.sessionLocks.has(chatId)) continue;

        // Session-end summarization (fire-and-forget)
        const visibleMessages = this.getVisibleTranscript(session);
        if (this.sessionSummarizer && visibleMessages.length >= 2) {
          void this.sessionSummarizer
            .summarizeAndUpdateProfile(session.profileKey ?? chatId, visibleMessages)
            .catch(() => {
              // Session summarization failure is non-fatal
            });
        }
        // Persist before cleanup (forced — session is being evicted)
        void this.persistSessionToMemory(chatId, visibleMessages.slice(-10), /* force */ true);
        this.lastPersistTime.delete(chatId);
        this.sessions.delete(chatId);
        this.activeGoalTrees.delete(session.conversationScope ?? chatId);
      }
    }
  }

  /** Minimum interval between debounced memory persists per chat (5s). */
  private static readonly PERSIST_DEBOUNCE_MS = 5_000;

  /**
   * Persist conversation messages to memory so the agent remembers them next session.
   * Debounced by default — pass `force: true` for trim evictions and session cleanup.
   */
  private async persistSessionToMemory(
    chatId: string,
    messages: ConversationMessage[],
    force = false,
  ): Promise<void> {
    return persistSessionToMemoryHelper(this.getSessionPersistenceContext(), chatId, messages, force);
  }

  private async maybeUpdateUserProfileFromPrompt(
    chatId: string,
    profileKey: string,
    prompt: string,
    userId?: string,
  ): Promise<void> {
    if (!this.userProfileStore || !prompt.trim()) {
      return;
    }

    const latestProfile = this.userProfileStore.getProfile(profileKey);
    const updates = extractNaturalLanguageDirectiveUpdates({
      latestProfile,
      prompt,
      availablePersonas: [
        ...NATURAL_LANGUAGE_BUILTIN_PERSONAS,
        ...(this.soulLoader?.getProfiles() ?? []),
      ],
    });
    const profileUpdates: Record<string, unknown> = {};

    if (updates.language) {
      profileUpdates["language"] = updates.language;
    }
    if (updates.displayName) {
      profileUpdates["displayName"] = updates.displayName;
    }
    if (updates.activePersona) {
      profileUpdates["activePersona"] = updates.activePersona;
    }
    if (updates.preferences) {
      profileUpdates["preferences"] = updates.preferences;
    }

    if (Object.keys(profileUpdates).length > 0) {
      this.userProfileStore.upsertProfile(profileKey, profileUpdates);
    }

    if (updates.autonomousMode) {
      await this.userProfileStore.setAutonomousMode(
        profileKey,
        updates.autonomousMode.enabled,
        updates.autonomousMode.expiresAt,
      );
      this.dmPolicy?.initFromProfile(
        chatId,
        {
          autonomousMode: updates.autonomousMode.enabled,
          autonomousExpiresAt: updates.autonomousMode.expiresAt,
        },
        userId,
      );
    }
  }

  private persistExecutionMemory(scopeKey: string, executionJournal: ExecutionJournal): void {
    persistExecutionMemoryHelper(this.getSessionPersistenceContext(), scopeKey, executionJournal);
  }

  private getRuntimeArtifactMatchKey(taskRunId?: string, chatId?: string): string | null {
    const resolvedTaskRunId = taskRunId?.trim();
    if (resolvedTaskRunId) {
      return resolvedTaskRunId;
    }
    const resolvedChatId = chatId?.trim();
    return resolvedChatId && resolvedChatId.length > 0 ? `chat:${resolvedChatId}` : null;
  }

  private recordRuntimeArtifactEvaluation(params: {
    chatId?: string;
    taskRunId?: string;
    decision: VerifierDecision;
    summary: string;
    failureReason?: string | null;
  }): void {
    if (!this.runtimeArtifactManager) {
      return;
    }

    const key = this.getRuntimeArtifactMatchKey(params.taskRunId, params.chatId);
    if (!key) {
      return;
    }

    const matched = this.runtimeArtifactMatches.get(key);
    if (!matched) {
      return;
    }

    const artifactIds = [...new Set([...matched.activeGuidanceIds, ...matched.shadowIds])];
    if (artifactIds.length === 0) {
      return;
    }

    const fingerprint =
      params.decision === "approve"
        ? ""
        : normalizeFailureFingerprint(params.failureReason ?? params.summary);
    this.runtimeArtifactManager.recordEvaluation({
      artifactIds,
      identityKey: this.getTaskExecutionContext()?.identityKey,
      verdict:
        params.decision === "approve"
          ? "clean"
          : params.decision === "continue"
            ? "retry"
            : "failure",
      blocker: params.decision === "replan",
      reason: params.summary,
      failureFingerprint: fingerprint || undefined,
    });

    if (params.decision === "approve") {
      this.runtimeArtifactMatches.delete(key);
    }
  }

  private async buildProjectWorldMemoryLayer(): Promise<{
    content: string;
    contentHashes: string[];
    summary: string;
    fingerprint: string;
  } | null> {
    if (!this.memoryManager) {
      return buildProjectWorldMemorySection({
        projectPath: this.projectPath,
        analysis: null,
      });
    }

    try {
      const analysisResult = await this.memoryManager.getCachedAnalysis(this.projectPath);
      const analysis =
        isOk(analysisResult) && isSome(analysisResult.value) ? analysisResult.value.value : null;
      return buildProjectWorldMemorySection({
        projectPath: this.projectPath,
        analysis,
      });
    } catch {
      return buildProjectWorldMemorySection({
        projectPath: this.projectPath,
        analysis: null,
      });
    }
  }

  private buildTrajectoryPhaseReplayTelemetry(
    chatId: string,
    identityKey: string,
    sinceTimestamp?: number,
    taskRunId?: string,
  ): TrajectoryPhaseReplay[] {
    if (!this.providerRouter) {
      return [];
    }

    const correlatedTaskRunId = this.resolveTaskRunId(chatId, taskRunId);
    const traces = (this.providerRouter.getRecentExecutionTraces?.(100, identityKey) ?? [])
      .filter((trace) => trace.chatId === chatId)
      .filter((trace) => (correlatedTaskRunId ? trace.taskRunId === correlatedTaskRunId : true))
      .filter(
        (trace) =>
          correlatedTaskRunId || sinceTimestamp === undefined || trace.timestamp >= sinceTimestamp,
      );
    const outcomes = (this.providerRouter.getRecentPhaseOutcomes?.(100, identityKey) ?? [])
      .filter((outcome) => outcome.chatId === chatId)
      .filter((outcome) => (correlatedTaskRunId ? outcome.taskRunId === correlatedTaskRunId : true))
      .filter(
        (outcome) =>
          correlatedTaskRunId ||
          sinceTimestamp === undefined ||
          outcome.timestamp >= sinceTimestamp,
      );
    if (traces.length === 0 && outcomes.length === 0) {
      return [];
    }

    const keyed = new Map<string, TrajectoryPhaseReplay>();
    const makeKey = (event: ExecutionTrace | PhaseOutcome) =>
      [event.phase, event.role, event.provider, event.model ?? "", event.source].join(":");

    for (const trace of traces) {
      const key = makeKey(trace);
      const existing = keyed.get(key);
      if (existing && existing.timestamp > trace.timestamp) {
        continue;
      }
      keyed.set(key, this.toTrajectoryPhaseReplay(trace));
    }

    for (const outcome of outcomes) {
      const key = makeKey(outcome);
      const existing = keyed.get(key);
      if (!existing || outcome.timestamp >= existing.timestamp) {
        keyed.set(key, this.toTrajectoryPhaseReplay(outcome));
        continue;
      }
      keyed.set(key, this.mergeReplayOutcome(existing, outcome));
    }

    return [...keyed.values()].sort((left, right) => left.timestamp - right.timestamp).slice(-12);
  }

  private toTrajectoryPhaseReplay(event: ExecutionTrace | PhaseOutcome): TrajectoryPhaseReplay {
    return {
      phase: event.phase,
      role: event.role,
      provider: event.provider,
      model: event.model,
      source: event.source,
      status: "status" in event ? event.status : undefined,
      verifierDecision: "telemetry" in event ? event.telemetry?.verifierDecision : undefined,
      phaseVerdict: "telemetry" in event ? event.telemetry?.phaseVerdict : undefined,
      phaseVerdictScore: "telemetry" in event ? event.telemetry?.phaseVerdictScore : undefined,
      retryCount: "telemetry" in event ? event.telemetry?.retryCount : undefined,
      rollbackDepth: "telemetry" in event ? event.telemetry?.rollbackDepth : undefined,
      timestamp: event.timestamp,
    };
  }

  private mergeReplayOutcome(
    existing: TrajectoryPhaseReplay,
    outcome: PhaseOutcome,
  ): TrajectoryPhaseReplay {
    return {
      ...existing,
      status: outcome.status,
      verifierDecision: outcome.telemetry?.verifierDecision,
      phaseVerdict: outcome.telemetry?.phaseVerdict,
      phaseVerdictScore: outcome.telemetry?.phaseVerdictScore,
      retryCount: outcome.telemetry?.retryCount,
      rollbackDepth: outcome.telemetry?.rollbackDepth,
    };
  }

  private emitToolResult(
    chatId: string,
    tc: { name: string; input: unknown },
    tr: { content: string; isError?: boolean },
  ): void {
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

  async buildTrajectoryReplayContext(params: {
    chatId: string;
    userId?: string;
    conversationId?: string;
    channelType?: string;
    sinceTimestamp?: number;
    taskRunId?: string;
  }): Promise<TrajectoryReplayContext | null> {
    const identityKey = resolveIdentityKey(params.chatId, params.userId, params.conversationId, this.userProfileStore, params.channelType);
    const taskExecutionMemory = this.taskExecutionStore?.getMemory(identityKey) ?? null;
    const exactReplayMatch = params.taskRunId
      ? (this.trajectoryReplayRetriever?.getReplayContextForTaskRun({
          taskRunId: params.taskRunId,
          chatId: params.chatId,
        }) ?? null)
      : null;
    const exactReplayContext = exactReplayMatch?.replayContext ?? null;
    const hasExactReplayMatch = exactReplayMatch?.found ?? false;
    const projectWorldLayer = await this.buildProjectWorldMemoryLayer();
    const phaseTelemetry = this.buildTrajectoryPhaseReplayTelemetry(
      params.chatId,
      identityKey,
      params.sinceTimestamp,
      params.taskRunId,
    );

    const learnedInsightsSource = hasExactReplayMatch
      ? (exactReplayContext?.learnedInsights ?? [])
      : (exactReplayContext?.learnedInsights ?? taskExecutionMemory?.learnedInsights ?? []);
    const learnedInsights = learnedInsightsSource.slice(0, 4);
    const branchSummary = hasExactReplayMatch
      ? exactReplayContext?.branchSummary
      : (exactReplayContext?.branchSummary ?? taskExecutionMemory?.branchSummary);
    const verifierSummary = hasExactReplayMatch
      ? exactReplayContext?.verifierSummary
      : (exactReplayContext?.verifierSummary ?? taskExecutionMemory?.verifierSummary);
    if (
      !projectWorldLayer &&
      !exactReplayContext?.projectWorldFingerprint &&
      !branchSummary &&
      !verifierSummary &&
      learnedInsights.length === 0 &&
      phaseTelemetry.length === 0 &&
      !exactReplayContext?.phaseTelemetry?.length
    ) {
      return null;
    }

    return {
      projectWorldFingerprint:
        exactReplayContext?.projectWorldFingerprint ?? projectWorldLayer?.fingerprint,
      projectWorldSummary: exactReplayContext?.projectWorldSummary ?? projectWorldLayer?.summary,
      branchSummary,
      verifierSummary,
      learnedInsights,
      phaseTelemetry:
        phaseTelemetry.length > 0 ? phaseTelemetry : (exactReplayContext?.phaseTelemetry ?? []),
    };
  }

  /** Emit a goal lifecycle event on the event bus */
  private emitGoalEvent(
    rootId: GoalNodeId | string,
    nodeId: GoalNodeId | string,
    status: GoalStatus,
    depth: number,
  ): void {
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
    return createMemoryRefresherHelper(this.getSessionPersistenceContext(), initialContentHashes);
  }

  private takePendingResumeTrees(conversationScope: string, chatId: string): GoalTree[] {
    return takePendingResumeTreesHelper(this.getSessionPersistenceContext(), conversationScope, chatId);
  }
}

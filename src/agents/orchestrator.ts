import type {
  IAIProvider,
  ConversationMessage,
  ToolCall,
  ToolResult,
  ProviderResponse,
  IStreamingProvider,
} from "./providers/provider.interface.js";
import { ProviderHealthRegistry } from "./providers/provider-health.js";
import { DynamicToolFactory } from "./tools/dynamic/dynamic-tool-factory.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative as pathRelative } from "node:path";
import { detectLanguage } from "../dashboard/workspace-routes.js";
import type { ProviderManager } from "./providers/provider-manager.js";
import { canonicalizeProviderName } from "./providers/provider-identity.js";
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
// isOk, isSome moved to orchestrator-trajectory-replay.ts
import type { MetricsCollector } from "../dashboard/metrics.js";
import {
  STRADA_SYSTEM_PROMPT,
  STRADA_AGENT_PREAMBLE,
  buildProjectContext,
  buildVaultProjectContext,
  buildDepsContext,
  buildCapabilityManifest,
  buildToolUsageHints,
  buildIdentitySection,
  buildCrashNotificationSection,
} from "./context/strada-knowledge.js";
import { validatePath } from "../security/path-guard.js";
import { vaultFileRead } from "./tools/file-read.js";
import { FILE_LIMITS } from "../common/constants.js";
import type { FrameworkPromptGenerator } from "../intelligence/framework/framework-prompt-generator.js";
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
} from "./agent-state.js";
import type { InstinctRetriever } from "./instinct-retriever.js";
import type { TrajectoryReplayRetriever } from "./trajectory-replay-retriever.js";
import { TeachingParser } from "../learning/feedback/teaching-parser.js";
import type { LearningPipeline } from "../learning/pipeline/learning-pipeline.js";
import type { InterventionEngine } from "../learning/intervention/intervention-engine.js";
import {
  DEFAULT_INTERACTION_CONFIG,
  DEFAULT_LLM_PROVIDER_FIRST_RESPONSE_TIMEOUT_MS,
  DEFAULT_LLM_STREAM_INITIAL_TIMEOUT_MS,
  DEFAULT_LLM_STREAM_STALL_TIMEOUT_MS,
  DEFAULT_TASK_CONFIG,
  type InteractionConfig,
  type ReRetrievalConfig,
  type StradaDependencyConfig,
  type TaskConfig,
} from "../config/config.js";
import type { IEmbeddingProvider } from "../rag/rag.interface.js";
import {
  getRecommendedMaxMessages,
  type ModelIntelligenceLookup,
} from "./providers/provider-knowledge.js";
import {
  compactSession,
  estimateTokens,
  COMPACTION_TRIGGER_RATIO,
  COMPACTION_TARGET_RATIO,
  DEFAULT_CONTEXT_WINDOW,
} from "./session-compaction.js";
import {
  COMPLETION_REVIEW_SYNTHESIS_SYSTEM_PROMPT,
  buildCompletionReviewStageRequest,
  buildCompletionReviewStageSystemPrompt,
  buildCompletionReviewSynthesisRequest,
  buildVisibilityReviewRequest,
  draftLooksLikeInternalPlanArtifact,
  parseCompletionReviewDecision,
  parseCompletionReviewStageResult,
  parseVisibilityReviewDecision,
  planVerifierPipeline,
  sanitizeVisibilityReviewDecision,
  VISIBILITY_REVIEW_SYSTEM_PROMPT,
  InteractionPolicyStateMachine,
  userExplicitlyAskedForPlan,
  type CompletionReviewStageName,
  type CompletionReviewStageResult,
  type VerifierPipelineResult,
} from "./autonomy/index.js";
import { MUTATION_TOOLS, WRITE_OPERATIONS, extractFilePath, isVerificationToolName } from "./autonomy/constants.js";
import { DMPolicy, isDestructiveOperation, type DMPolicyConfig } from "../security/dm-policy.js";
import {
  checkReadOnlyBlock,
  createReadOnlyToolStub,
  getReadOnlySystemPrompt,
} from "../security/read-only-guard.js";
import type { BackgroundTaskOptions, TaskProgressSignal, TaskProgressUpdate, TaskUsageEvent } from "../tasks/types.js";
import type { UnifiedBudgetManager } from "../budget/unified-budget-manager.js";
import type { TaskCheckpointStore, PendingTaskCheckpoint } from "../tasks/task-checkpoint-store.js";
import { buildTaskProgressSummary, type ProgressLanguage } from "../tasks/progress-signals.js";
import type { IEventEmitter, LearningEventMap } from "../core/event-bus.js";
import type { MetricsRecorder } from "../metrics/metrics-recorder.js";
import type { GoalDecomposer } from "../goals/goal-decomposer.js";
import { summarizeTree } from "../goals/goal-renderer.js";
// formatGoalPlanMarkdown moved to orchestrator-goal-decomposition.ts
import { formatResumePrompt, prepareTreeForResume } from "../goals/goal-resume.js";
import type { GoalTree } from "../goals/types.js";
import type { SkillEntry } from "../skills/types.js";
import type { GoalStorage } from "../goals/goal-storage.js";
import type { WorkspaceBus } from "../dashboard/workspace-bus.js";
// goalTreeToDagPayload moved to orchestrator-goal-decomposition.ts
import type { MonitorLifecycle } from '../dashboard/monitor-lifecycle.js';
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
  TrajectoryReplayContext,
} from "../learning/index.js";
import { classifyErrorMessage } from "../utils/error-messages.js";
import { TaskClassifier } from "../agent-core/routing/task-classifier.js";
import type {
  TaskClassification,
  ExecutionPhase,
  ExecutionTraceSource,
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
  sanitizePromptInjection,
} from "./orchestrator-text-utils.js";
import {
  normalizeFailureFingerprint,
  sanitizeEventInput,
  sanitizeToolResult,
  checkProviderFailureCircuitBreaker,
  isEmptyProviderResponse,
  isSingleProviderChain,
  recordProviderHealthFailure,
  evaluateProviderFailure,
} from "./orchestrator-runtime-utils.js";
import { IterationHealthTracker } from "./iteration-health-tracker.js";
import {
  createFailureLedger,
  IterationHealthCoreAdapter,
  mapVerdictToLoopAction,
  openRunClock,
  resolveRunBudgetPolicy,
  SystemClock,
  type CallScope,
  type CancelReason,
  type Clock,
  type FailureLedger,
  type LoopAction,
  type PolicySeed,
  type RunClock,
  type VerdictInput,
} from "../agent-core/control/index.js";
import type { FlagSet } from "../agent-core/runner/index.js";
import { getResilienceMessage } from "./resilience-messages.js";
import {
  buildPhasePromptSection,
  recordStepResultsAndCheckReflection,
  buildToolResultContentBlocks,
  handlePlanPhaseTransition,
  processReflectionPreamble,
} from "./orchestrator-loop-utils.js";
import { runConsensusVerification } from "./orchestrator-consensus.js";
import {
  executeAndTrackTools,
  refreshMemoryIfNeeded,
  runConsensusIfAvailable,
  checkPendingBlocks,
  pushContinuationMessages,
  MAX_TOKENS_CONTINUATION_GATE,
} from "./orchestrator-loop-shared.js";
import { createAutonomyBundle } from "./orchestrator-autonomy-tracker.js";
import {
  buildExecutionTraceRecord,
  buildPhaseOutcomeRecord,
  buildPhaseOutcomeTelemetry as buildPhaseOutcomeTelemetryModel,
  resolveExecutionTraceSource as resolveExecutionTraceSourceModel,
  toExecutionPhase as toExecutionPhaseModel,
} from "./orchestrator-phase-telemetry.js";
import {
  createCatalogVersion,
  type WorkerArtifactMetadata,
  type WorkerReviewFinding,
  type WorkerRunRequest,
  type WorkerRunResult,
  type WorkerVerificationResult,
  type WorkspaceLease,
} from "./supervisor/supervisor-types.js";
import type { SupervisorResult } from "../supervisor/supervisor-types.js";
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
  buildSupervisorActivationNarrative,
  normalizeSupervisorProgressMarkdown,
} from "../supervisor/supervisor-feedback.js";
import { SessionManager, type Session } from "./orchestrator-session-manager.js";
import {
  buildSafeVisibleFallbackFromDraft as buildSafeVisibleFallbackFromDraftHelper,
  resolveAskUserClarificationIntervention as resolveAskUserClarificationInterventionHelper,
  type ClarificationIntervention,
  type ClarificationContext,
} from "./orchestrator-clarification.js";
import {
  reviewClarification as reviewClarificationPipeline,
  type InterventionDeps,
  type WorkerRunCollector,
} from "./orchestrator-intervention-pipeline.js";
import {
  buildSystemPromptWithContext as buildSystemPromptWithContextHelper,
  injectSoulPersonality,
  type ContextBuilderDeps,
} from "./orchestrator-context-builder.js";
import {
  handleBgReflectionDone,
  handleBgReflectionReplan,
  handleBgReflectionContinue,
  handleInteractiveReflectionDone,
  handleInteractiveReflectionReplan,
  handleInteractiveReflectionContinue,
  type BgReflectionContext,
  type InteractiveReflectionContext,
  type ReflectionLoopAction,
} from "./orchestrator-reflection-handler.js";
import {
  handleBgEndTurn,
  handleInteractiveEndTurn,
  type BgEndTurnContext,
  type InteractiveEndTurnContext,
  type EndTurnLoopAction,
} from "./orchestrator-end-turn-handler.js";
import type { SupervisorBrain } from "../supervisor/supervisor-brain.js";
import { requestWriteConfirmation as requestWriteConfirmationHelper } from "./orchestrator-write-gate.js";
import {
  buildTrajectoryReplayContext as buildTrajectoryReplayContextHelper,
  type TrajectoryReplayDeps,
} from "./orchestrator-trajectory-replay.js";
import {
  runProactiveGoalDecomposition as runProactiveGoalDecompositionHelper,
  runReactiveGoalDecomposition as runReactiveGoalDecompositionHelper,
  type GoalDecompositionDeps,
} from "./orchestrator-goal-decomposition.js";

const DIAGNOSTIC_BLOCKED_RE = /^Blocked checkpoint:/i;
/** Self-improvement tools bypass phase-based write filtering — they have their own guards. */
const SELF_IMPROVEMENT_TOOLS: ReadonlySet<string> = new Set([
  "create_tool", "create_skill", "remove_dynamic_tool",
]);
const TYPING_INTERVAL_MS = 4000;
const MAX_CONSECUTIVE_PROVIDER_FAILURES = 5;
/** 1b seed default for the task-scope silence ceiling. Mirrors background-executor.ts's
 *  DEFAULT_TASK_INACTIVITY_TIMEOUT_MS (600_000) — re-declared locally to avoid importing the
 *  bg-executor into the interactive path. Kept in step via the policy clamp (ratio×stall). */
const PHASE1B_TASK_INACTIVITY_MS = 10 * 60 * 1000;
const PHASE1B_MIN_INACTIVITY_OVER_STREAM_RATIO = 2;
const NATURAL_LANGUAGE_BUILTIN_PERSONAS = ["default", "formal", "casual", "minimal"] as const;
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

export type SupervisorAdmissionPath = "supervisor" | "direct_worker";

export type SupervisorAdmissionReason =
  | "eligible"
  | "multimodal_passthrough"
  | "busy"
  | "low_complexity"
  | "not_decomposable"
  | "unavailable"
  | "supervisor_error";

export interface SupervisorAdmissionRequest {
  readonly prompt: string;
  readonly chatId: string;
  readonly channelType?: string;
  readonly userId?: string;
  readonly conversationId?: string;
  readonly signal?: AbortSignal;
  readonly goalTree?: GoalTree;
  // forceEligibility removed — supervisor complexity gate always applies
  readonly userContent?: string | MessageContent[] | null;
  readonly attachments?: Attachment[];
  readonly taskRunId?: string;
  readonly onUsage?: (usage: TaskUsageEvent) => void;
  readonly workspaceLease?: WorkspaceLease;
  readonly onActivated?: (
    activation: ReturnType<typeof buildSupervisorActivationNarrative>,
  ) => Promise<void> | void;
  readonly reportUpdate?: (markdown: string) => Promise<void> | void;
  readonly onGoalDecomposed?: (goalTree: GoalTree) => void;
}

export type SupervisorAdmissionDecision =
  | {
      readonly path: "supervisor";
      readonly reason: "eligible";
      readonly result: SupervisorResult;
    }
  | {
      readonly path: Exclude<SupervisorAdmissionPath, "supervisor">;
      readonly reason: Exclude<SupervisorAdmissionReason, "eligible">;
    };

function extractSupervisorPromptText(
  content?: string | MessageContent[] | null,
): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((block) => {
      switch (block.type) {
        case "text":
          return [block.text.trim()];
        case "tool_result":
          return [block.content.trim()];
        case "tool_use":
          return [`${block.name}(${JSON.stringify(block.input)})`];
        case "image":
          return [];
      }
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

function describeSupervisorAttachment(attachment: Attachment): string {
  const labelByType: Record<Attachment["type"], string> = {
    image: "Image attachment",
    audio: "Audio attachment",
    video: "Video attachment",
    document: "Document attachment",
    file: "File attachment",
  };
  const label = labelByType[attachment.type] ?? "Attachment";
  const name = attachment.name?.trim() || "unnamed";
  const mime = attachment.mimeType?.trim() || "unknown";
  return `${label}: ${name} (${mime})`;
}

function getSupervisorAttachmentNotes(
  params: Pick<SupervisorAdmissionRequest, "userContent" | "attachments">,
): string[] {
  const attachmentNotes = (params.attachments ?? []).map(describeSupervisorAttachment);
  if (attachmentNotes.length > 0) {
    return attachmentNotes;
  }

  if (Array.isArray(params.userContent)) {
    const imageBlockCount = params.userContent.filter((block) => block.type === "image").length;
    if (imageBlockCount > 0) {
      return [
        `Image attachment${imageBlockCount === 1 ? "" : "s"} available for analysis (${imageBlockCount})`,
      ];
    }
  }

  return [];
}

function buildSupervisorPlanningPrompt(
  params: Pick<SupervisorAdmissionRequest, "prompt" | "userContent" | "attachments">,
): string {
  const basePrompt = params.prompt.trim() || extractSupervisorPromptText(params.userContent) || DEFAULT_IMAGE_PROMPT;
  const sections: string[] = [basePrompt];
  const attachmentNotes = getSupervisorAttachmentNotes(params);

  if (attachmentNotes.length > 0) {
    sections.push(`Available inputs:\n${attachmentNotes.map((note) => `- ${note}`).join("\n")}`);
  }

  return sections.join("\n\n");
}

function appendAttachmentNotesToGroundingContent(
  content: MessageContent[],
  attachments?: Attachment[],
): MessageContent[] {
  const nonImageAttachmentNotes = (attachments ?? [])
    .filter((attachment) => !attachment.mimeType || !isVisionCompatible(attachment.mimeType) || (!attachment.data && !attachment.url))
    .map(describeSupervisorAttachment);
  if (nonImageAttachmentNotes.length === 0) {
    return content;
  }

  const supplementalText = `Additional attachments:\n${nonImageAttachmentNotes.map((note) => `- ${note}`).join("\n")}`;
  const textIndex = content.findIndex((block) => block.type === "text");
  if (textIndex === -1) {
    return [{ type: "text", text: supplementalText }, ...content];
  }

  const textBlocks = content.filter((block): block is Extract<MessageContent, { type: "text" }> => block.type === "text");
  if (nonImageAttachmentNotes.every((note) => textBlocks.some((block) => block.text.includes(note)))) {
    return content;
  }

  const updated = [...content];
  const current = updated[textIndex];
  if (current?.type === "text") {
    updated[textIndex] = {
      ...current,
      text: current.text.trim() ? `${current.text}\n\n${supplementalText}` : supplementalText,
    };
  }
  return updated;
}

function buildSupervisorGroundingContent(
  params: Pick<SupervisorAdmissionRequest, "prompt" | "userContent" | "attachments">,
): MessageContent[] | null {
  if (Array.isArray(params.userContent) && params.userContent.some((block) => block.type === "image")) {
    return appendAttachmentNotesToGroundingContent(params.userContent, params.attachments);
  }

  const imageAttachments = (params.attachments ?? []).filter(
    (attachment) => attachment.mimeType && isVisionCompatible(attachment.mimeType) && (attachment.data || attachment.url),
  );
  if (imageAttachments.length === 0) {
    return null;
  }

  const content = buildUserContent(
    params.prompt.trim() || extractSupervisorPromptText(params.userContent) || DEFAULT_IMAGE_PROMPT,
    params.attachments,
    true,
  );
  return Array.isArray(content) ? content : null;
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
  /** Goal tree context for substep emission to workspace bus. */
  goalContext?: import("../tasks/types.js").GoalContext;
}

interface SelfManagedWriteReview {
  approved: boolean;
  reason?: string;
}

/**
 * Maximum number of silent (pre-first-token) thinking windows a stream may re-arm via
 * markAlive() before the watchdog fires regardless. markAlive() keeps re-arming the
 * generous thinking window on every keepalive / reasoning-summary delta so a genuinely
 * thinking model is never cut off mid-reason — but WITHOUT a hard ceiling an endpoint
 * that emits endless heartbeats with no visible content (a stuck reasoning model or a
 * chatty proxy) would re-arm forever and the call would hang until the outer task
 * timeout (minutes-to-hours). This bounds total silent time at N × the window.
 *
 * Kept in step with MIN_INACTIVITY_OVER_STREAM_RATIO (background-executor.ts): with the
 * default window the silent cap lands right at the outer task-inactivity floor, so this
 * watchdog fires at-or-before the task timer. Tune the two together.
 */
const MAX_SILENT_THINKING_WINDOWS = 2;

export function createStreamingProgressTimeout(
  initialTimeoutMs: number,
  stallTimeoutMs: number,
  /** Extended stall timeout for reasoning models during silent thinking phases. */
  thinkingStallTimeoutMs?: number,
): {
  markProgress: () => void;
  markAlive: () => void;
  timeoutPromise: Promise<never>;
  signal: AbortSignal;
  clear: () => void;
} {
  const abortController = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let sawProgress = false;
  let rejectTimeout: ((error: Error) => void) | undefined;
  // When the silent (pre-first-token) phase began — used to bound total silent time so
  // markAlive() re-arms cannot extend it forever (see MAX_SILENT_THINKING_WINDOWS).
  const silentPhaseStartedAt = Date.now();

  const armTimeout = () => {
    if (timeoutId) clearTimeout(timeoutId);
    // Pre-first-token: use extended thinking timeout (silent reasoning phase).
    // Post-first-token: always use normal stall timeout — if tokens were flowing
    // and stopped, the connection is likely dead, not thinking.
    const windowMs = sawProgress
      ? stallTimeoutMs
      : (thinkingStallTimeoutMs ?? initialTimeoutMs);
    // Absolute ceiling on the silent phase: keepalives re-arm `windowMs`, but never past
    // N windows of total silent time — otherwise an endless heartbeat stream hangs forever.
    let timeoutMs = windowMs;
    let cappedBySilenceCeiling = false;
    if (!sawProgress) {
      const remaining = windowMs * MAX_SILENT_THINKING_WINDOWS - (Date.now() - silentPhaseStartedAt);
      if (remaining < timeoutMs) {
        timeoutMs = Math.max(0, remaining);
        cappedBySilenceCeiling = true;
      }
    }
    timeoutId = setTimeout(() => {
      const thinkingHint = !sawProgress && thinkingStallTimeoutMs ? " (thinking model)" : "";
      const error = new Error(sawProgress
        ? `Streaming stalled after ${stallTimeoutMs}ms without progress`
        : cappedBySilenceCeiling
          ? `Streaming produced no visible content within ${windowMs * MAX_SILENT_THINKING_WINDOWS}ms${thinkingHint}`
          : `Streaming did not start within ${windowMs}ms${thinkingHint}`);
      abortController.abort(error);
      rejectTimeout?.(error);
    }, timeoutMs);
  };

  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });

  armTimeout();

  return {
    // Real visible content arrived. Flip to the (shorter) post-first-token stall
    // window — once tokens are flowing, a long gap means a dead connection.
    markProgress: () => {
      sawProgress = true;
      armTimeout();
    },
    // The stream is alive but produced no visible content (e.g. a `keepalive`
    // heartbeat or reasoning-summary delta during a silent thinking phase).
    // Re-arm WITHOUT setting sawProgress so the generous pre-first-token thinking
    // window is preserved — a keepalive must NOT downgrade the watchdog to the
    // short stall window mid-reasoning.
    markAlive: () => {
      armTimeout();
    },
    timeoutPromise,
    signal: abortController.signal,
    clear: () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (!abortController.signal.aborted) abortController.abort();
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
  private readonly vaultRegistry?: import("../vault/vault-registry.js").VaultRegistry;
  private readonly vaultWriteHookBudgetMs: number = 200;
  private vaultWriteHook: import("../vault/write-hook.js").InstalledWriteHook | null = null;
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
  /**
   * Agent Core v2 resolved flag set (Phase 1a). When `failureLedger === true`, the four
   * provider-failure decision sites consult the {@link FailureLedger} instead of v1's
   * inline `consecutiveProviderFailures`/`iterationHealth` logic. Undefined or `false`
   * keeps the byte-identical v1 path. Threaded whole (not the bare boolean) so 1b–1d wire
   * up with zero re-plumbing.
   */
  private readonly agentCoreFlagSet?: FlagSet;
  /** Agent Core v2 — Phase 1b. Injectable time source for RunClock; SystemClock in prod,
   *  FakeClock in tests. Only consulted when `agentCoreFlagSet.runClock === true`. */
  private readonly agentCoreClock: Clock;
  private readonly sessionManager: SessionManager;
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
  /** Goal storage for persisting goal trees (enables DAG/Kanban UI updates) */
  private goalStorage: GoalStorage | null = null;
  /** Active goal trees per session for proactive/reactive decomposition */
  private readonly activeGoalTrees = new Map<string, GoalTree>();
  /** Interrupted goal trees detected on startup, pending user resume/discard decision */
  private readonly pendingResumeTrees = new Map<string, GoalTree[]>();
  /** TaskManager reference for inline goal detection submission (lazy setter) */
  private taskManager: TaskManager | null = null;
  /** Workspace bus for monitor UI events (lazy setter — bus created after orchestrator) */
  private workspaceBus: WorkspaceBus | null = null;
  /**
   * Serializes async workspace code-event emission so events reach the
   * monitor in the same order the tool results were processed, while
   * keeping file reads off the event loop.
   */
  private workspaceCodeEventQueue: Promise<void> = Promise.resolve();
  private monitorLifecycle: MonitorLifecycle | null = null;
  /** Tracks consecutive ask_user blocks per conversation to break clarification loops. */
  private readonly askUserBlockCounts = new Map<string, number>();
  /** Tracks consecutive errors per tool per chat to auto-disable repeatedly failing tools. */
  private readonly toolConsecutiveErrors = new Map<string, Map<string, number>>();
  private static readonly MAX_CONSECUTIVE_TOOL_ERRORS = 3;
  private readonly soulLoader: SoulLoader | null;
  private readonly dmPolicy: DMPolicy;
  private readonly sessionSummarizer?: SessionSummarizer;
  private readonly userProfileStore?: UserProfileStore;
  private readonly autonomousDefaultEnabled: boolean;
  private readonly autonomousDefaultHours: number;
  private readonly interactionConfig: InteractionConfig;
  private readonly taskConfig: TaskConfig;
  /**
   * Optional live budget source. When wired (post-bootstrap), overrides
   * the static {@link taskConfig}.interactiveTokenBudget via
   * {@link getLiveInteractiveTokenBudget} so portal edits take effect
   * without a process restart.
   */
  private unifiedBudgetManager?: UnifiedBudgetManager;
  /** Unsubscribe handle for the active budget-config listener (prevents leaks on re-wire). */
  private budgetConfigUnsubscribe?: () => void;
  /** Optional checkpoint persistence for budget/provider aborts. */
  private checkpointStore?: TaskCheckpointStore;
  /**
   * Last seen channelType/userId per chat. Populated on every handleMessage
   * entry so that {@link continueFromCheckpoint} can synthesize an
   * {@link IncomingMessage} with the correct routing metadata without
   * forcing the caller (CommandHandler) to plumb it through.
   * Bounded at MAX_LAST_ROUTING_ENTRIES to avoid unbounded growth.
   */
  private readonly lastRoutingByChat = new Map<
    string,
    { channelType: IncomingMessage["channelType"]; userId: string; conversationId?: string }
  >();
  private static readonly MAX_LAST_ROUTING_ENTRIES = 1000;
  /**
   * In-flight resume set. Gates {@link continueFromCheckpoint} so the same
   * chat cannot trigger two concurrent checkpoint replays (e.g. /retry spam
   * or two implicit recovery intents landing in parallel). Keyed by chatId
   * because the first successful call clears the checkpoint — the second
   * caller should see a not_found instead of racing the first. (CWE-362)
   */
  private readonly resumeInFlight = new Set<string>();
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
  private readonly supervisorBrain?: SupervisorBrain;
  private readonly activeSupervisorScopes = new Set<string>();
  private readonly supervisorComplexityThreshold: "moderate" | "complex";
  private readonly conformanceEnabled?: boolean;
  private readonly conformanceFrameworkPathsOnly?: boolean;
  private readonly loopFingerprintThreshold?: number;
  private readonly loopFingerprintWindow?: number;
  private readonly loopDensityThreshold?: number;
  private readonly loopDensityWindow?: number;
  private readonly loopMaxRecoveryEpisodes?: number;
  private readonly loopStaleAnalysisThreshold?: number;
  private readonly loopHardCapReplan?: number;
  private readonly loopHardCapBlock?: number;
  private readonly progressAssessmentEnabled: boolean;
  /** Hard cap on iterations for delegated sub-agents (overrides config if lower). */
  private readonly maxIterations?: number;
  private readonly runtimeArtifactMatches = new Map<
    string,
    {
      activeGuidanceIds: string[];
      shadowIds: string[];
    }
  >();
  /** Framework Knowledge Layer prompt generator (injected by bootstrap when available) */
  private frameworkPromptGenerator: FrameworkPromptGenerator | null = null;
  /** Callback to hot-reload a newly created skill */
  private onSkillCreated?: (skillPath: string) => Promise<void>;
  private getSkillEntries?: () => readonly SkillEntry[];
  /** Per-orchestrator DynamicToolFactory (avoids module-level singleton leaks in multi-agent setups) */
  private readonly dynamicToolFactory = new DynamicToolFactory();

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
    memoryDbPath?: string;
    supervisorBrain?: SupervisorBrain;
    supervisorComplexityThreshold?: "moderate" | "complex";
    conformanceEnabled?: boolean;
    conformanceFrameworkPathsOnly?: boolean;
    loopFingerprintThreshold?: number;
    loopFingerprintWindow?: number;
    loopDensityThreshold?: number;
    loopDensityWindow?: number;
    loopMaxRecoveryEpisodes?: number;
    loopStaleAnalysisThreshold?: number;
    loopHardCapReplan?: number;
    loopHardCapBlock?: number;
    progressAssessmentEnabled?: boolean;
    onSkillCreated?: (skillPath: string) => Promise<void>;
    getSkillEntries?: () => readonly SkillEntry[];
    /** Hard cap on iterations for delegated sub-agents (overrides config if lower). */
    maxIterations?: number;
    /** Vault registry — when present, file-write tools trigger a budget-aware reindex of the touched file. */
    vaultRegistry?: import("../vault/vault-registry.js").VaultRegistry;
    /** Vault write-hook budget in ms (Phase 1 default 200). */
    vaultWriteHookBudgetMs?: number;
    /**
     * Agent Core v2 resolved flag set (Phase 1a). Defaults to undefined (= v1 everywhere).
     * Only `failureLedger` is consulted in 1a; the rest are threaded for 1b–1d.
     */
    agentCoreFlagSet?: FlagSet;
    /** Agent Core v2 — Phase 1b injectable Clock (defaults to SystemClock). */
    agentCoreClock?: Clock;
  }) {
    this.providerManager = opts.providerManager;
    // Vault write-hook lazy-binds when the first Edit/Write tool runs.
    this.vaultRegistry = opts.vaultRegistry;
    this.vaultWriteHookBudgetMs = opts.vaultWriteHookBudgetMs ?? 200;
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
    this.supervisorBrain = opts.supervisorBrain;
    this.supervisorComplexityThreshold = opts.supervisorComplexityThreshold ?? "complex";
    this.conformanceEnabled = opts.conformanceEnabled;
    this.conformanceFrameworkPathsOnly = opts.conformanceFrameworkPathsOnly;
    this.loopFingerprintThreshold = opts.loopFingerprintThreshold;
    this.loopFingerprintWindow = opts.loopFingerprintWindow;
    this.loopDensityThreshold = opts.loopDensityThreshold;
    this.loopDensityWindow = opts.loopDensityWindow;
    this.loopMaxRecoveryEpisodes = opts.loopMaxRecoveryEpisodes;
    this.loopStaleAnalysisThreshold = opts.loopStaleAnalysisThreshold;
    this.loopHardCapReplan = opts.loopHardCapReplan;
    this.loopHardCapBlock = opts.loopHardCapBlock;
    this.progressAssessmentEnabled = opts.progressAssessmentEnabled ?? true;
    this.maxIterations = opts.maxIterations;
    this.getIdentityState = opts.getIdentityState;
    this.crashRecoveryContext = opts.crashRecoveryContext;
    this.onSkillCreated = opts.onSkillCreated;
    this.getSkillEntries = opts.getSkillEntries;
    this.agentCoreFlagSet = opts.agentCoreFlagSet;
    this.agentCoreClock = opts.agentCoreClock ?? new SystemClock();

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
      sessionsDir: join(opts.memoryDbPath ?? join(this.projectPath ?? ".", ".strada-memory"), "sessions"),
    });
  }

  async withTaskExecutionContext<T>(
    context: TaskExecutionContext,
    run: () => Promise<T>,
  ): Promise<T> {
    return await this.taskContext.run(context, run);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Agent Core v2 — Phase 1a: FailureLedger consultation (flag-gated).
  //
  // These helpers are reached ONLY when `agentCoreFlagSet.failureLedger === true`.
  // The flag-OFF path is v1's unchanged inline logic. All DECISION logic lives in
  // agent-core (`mapVerdictToLoopAction`); these methods only ASSEMBLE the inert
  // 1a VerdictInput and EXECUTE v1's existing side-effect statements for the chosen
  // action. No v1 behavior is rewritten — the notices/finish/guidance below are the
  // same resilience messages and message pushes the OFF arms emit.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Phase 1a {@link VerdictInput}. failureLedger ships in ISOLATION (runClock /
   * silenceAccumulator / typedCancelReason still OFF), so every field those concerns own is
   * inert here:
   *   - taskCancelReason: null      (typed cancel = 1d; v1 cancel still flows via
   *                                  `signal.aborted` re-throw, handled OUTSIDE this helper).
   *   - hardTimeoutBlown: false     (runClock = 1b).
   *   - hardTimeoutScope: "task"    (inert; never read because hardTimeoutBlown=false).
   *   - resourceExhausted: false    (token-budget abort stays v1's own check ABOVE the site).
   *   - taskInactivityExceeded: false (silenceAccumulator = 1c).
   *   - callStalled: false          (a typed provider-stall is a runClock signal, 1b).
   *   - modelProposedDone/reflectionWantsExtend/loopDetectionBlocked: false at failure sites.
   * With these inert, verdict() precedence collapses to rule 5 (shouldAbort) → rule 7
   * (shouldAskUser) → rule 9 (consecutive>0 retry) → default continue — EXACTLY the
   * THROW+EMPTY decision surface 1a replaces. Rules 1–4, 6, 8, 10 are provably dead here.
   */
  private buildPhase1aVerdictInput(): VerdictInput {
    return {
      taskCancelReason: null,
      hardTimeoutBlown: false,
      hardTimeoutScope: "task",
      resourceExhausted: false,
      taskInactivityExceeded: false,
      callStalled: false,
      modelProposedDone: false,
      reflectionWantsExtend: false,
      loopDetectionBlocked: false,
    };
  }

  /**
   * Phase 1a: the shared 3-step ledger interaction at each of the 4 failure sites — tag the
   * provider, record the (non-benign) failure, and read the verdict under the inert 1a inputs.
   * One definition so 1b–1d can add sites without re-stamping the call sequence.
   */
  private recordPhase1aFailureAndVerdict(
    ledger: FailureLedger,
    adapter: IterationHealthCoreAdapter,
    provider: string,
  ): ReturnType<FailureLedger["verdict"]> {
    adapter.setProvider(provider);
    ledger.recordFailure(provider, false);
    return ledger.verdict(this.buildPhase1aVerdictInput());
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Agent Core v2 — Phase 1b: RunClock construction + the live-signal VerdictInput.
  //
  // Reached ONLY when `agentCoreFlagSet.runClock === true`. The RunClock owns every
  // per-call deadline (CallScope token) + the task-scope silence accumulator; its typed
  // provider-stall / hard-timeout / silence signals feed the SAME FailureLedger the 1a
  // helper feeds (rules 2/4/6 become reachable). The flag-OFF path is byte-identical v1.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Phase 1b. Build the PolicySeed from live v1 config/state for a run.
   * `-1` (interactiveTokenBudget "unbounded" sentinel) maps to +Infinity because Budget has
   * no sentinel; costCap is Infinity (v1 has no cost gate). Reads the LIVE token budget so a
   * mid-task portal raise is reflected if `reArmOnConfigChange` is later called (deferred).
   */
  private buildPolicySeed(): PolicySeed {
    const liveTokenBudget = this.getLiveInteractiveTokenBudget();
    return {
      streamInitialTimeoutMs: this.streamInitialTimeoutMs,
      streamStallTimeoutMs: this.streamStallTimeoutMs,
      providerFirstResponseMs: DEFAULT_LLM_PROVIDER_FIRST_RESPONSE_TIMEOUT_MS,
      taskInactivityMs: PHASE1B_TASK_INACTIVITY_MS,
      minInactivityOverStreamRatio: PHASE1B_MIN_INACTIVITY_OVER_STREAM_RATIO,
      outputTokenCap: liveTokenBudget === -1 ? Number.POSITIVE_INFINITY : liveTokenBudget,
      costCapUsd: Number.POSITIVE_INFINITY,
      // taskHardMs omitted → resolver uses Infinity (v1 has no wall-clock task ceiling). The
      // 3h27m-runaway bound stays the iteration limit + loopDetectionBlocked guard in 1b.
    };
  }

  /**
   * Phase 1b: VerdictInput with real RunClock signals. Called at the failure sites ONLY when
   * `agentCoreFlagSet.runClock === true`. `callStalled` is true when the just-failed call's
   * token aborted with a typed provider-stall / hard-timeout; `hardTimeoutBlown` from the task
   * token; `taskInactivityExceeded` from the silence accumulator BUT gated on the
   * `silenceAccumulator` flag (1c) — see the field comment. taskCancelReason stays null
   * here (typed cancel = 1d; v1 cancel still flows via `signal.aborted` re-throw outside this
   * site). `failedCallReason` is the just-failed call scope's `token.reason` when locally
   * readable (non-streaming sibling sites), else null (streaming sites rely on the task-scope
   * silence accumulator + hard-timeout — see P-1b-4).
   */
  private buildPhase1bVerdictInput(
    runClock: RunClock,
    failedCallReason: CancelReason | null,
  ): VerdictInput {
    const taskReason = runClock.taskToken.reason;
    const hardTask = taskReason?.kind === "hard-timeout" && taskReason.scope === "task";
    return {
      taskCancelReason: null, // 1d
      hardTimeoutBlown: runClock.hardTaskExpired() || hardTask,
      hardTimeoutScope: "task",
      resourceExhausted: false, // token-budget abort stays v1's own check above the site
      // The task-scope silence accumulator drives the task-inactivity verdict only from Phase 1c
      // (silenceAccumulator flag). RunClock already accumulates silent ms in 1b, but CONSUMING it
      // here would prematurely leak 1c's livelock-stop into 1b (where the flag is off) and make the
      // silenceAccumulator flag a no-op. Behavior-preserving: v1 never bounded the accumulator
      // livelock either — that is precisely what 1c adds. Per-call stalls ARE bounded in 1b via
      // `callStalled` below; only the cross-call accumulator verdict waits for 1c.
      taskInactivityExceeded:
        this.agentCoreFlagSet?.silenceAccumulator === true && runClock.silenceCeilingExceeded(),
      callStalled:
        failedCallReason?.kind === "provider-stall" ||
        failedCallReason?.kind === "hard-timeout",
      modelProposedDone: false,
      reflectionWantsExtend: false,
      loopDetectionBlocked: false,
    };
  }

  /**
   * Phase 1b sibling of {@link recordPhase1aFailureAndVerdict}: tag the provider, record the
   * (non-benign) failure, and read the verdict under the LIVE RunClock signals.
   */
  private recordPhase1bFailureAndVerdict(
    ledger: FailureLedger,
    adapter: IterationHealthCoreAdapter,
    provider: string,
    runClock: RunClock,
    failedCallReason: CancelReason | null,
  ): ReturnType<FailureLedger["verdict"]> {
    adapter.setProvider(provider);
    ledger.recordFailure(provider, false);
    return ledger.verdict(this.buildPhase1bVerdictInput(runClock, failedCallReason));
  }

  /**
   * Synthesize the v1 {@link FailureAction} the legacy health-context message expects, from
   * the ledger's loop action + served backoff. Lets the ledger path reuse v1's exact
   * `buildSessionHealthContext` text without duplicating it.
   */
  private synthFailureAction(
    action: LoopAction,
    iterationHealth: IterationHealthTracker,
  ): import("./iteration-health-tracker.js").FailureAction {
    if (action.notice === "abort") {
      // Reproduce v1's tracker abort-reason format VERBATIM (iteration-health-tracker.ts) so the
      // ledger path's buildSessionHealthContext message carries the same specific rate + count
      // the agent saw under v1 — not a generic string.
      return {
        kind: "abort",
        reason: `Failure rate ${(iterationHealth.getFailureRate() * 100).toFixed(0)}% with ${iterationHealth.getConsecutiveFailures()} consecutive failures`,
      };
    }
    if (action.notice === "ask_user") {
      return { kind: "ask_user", backoffMs: action.backoffMs };
    }
    return { kind: "retry", backoffMs: action.backoffMs };
  }

  /**
   * Execute the BACKGROUND-loop side effects for a ledger verdict, returning how the loop
   * should proceed. Mirrors v1's bg health-context push + progressive-disclosure emits +
   * backoff + abort `finish(...)`. `terminalAbort` is "return" (bg EMPTY) — but bg THROW
   * supplies "break" so the existing `providerAbort`/`break` post-loop handling runs.
   */
  private async applyBackgroundVerdict(
    verdict: ReturnType<FailureLedger["verdict"]>,
    bag: {
      ledger: FailureLedger;
      iterationHealth: IterationHealthTracker;
      session: Session;
      providerName: string;
      prompt: string;
      progressTitle: string;
      progressLanguage: ProgressLanguage;
      emitProgress: (update: TaskProgressUpdate) => void;
      finish: (text: string, status?: WorkerRunResult["status"], reason?: string) => string;
      abortControl: "break" | "return";
      onAbort: (reason: string) => void;
    },
  ): Promise<{ control: "continue" } | { control: "break" } | { control: "return"; finish: string }> {
    const action = mapVerdictToLoopAction(verdict, bag.abortControl);
    const statusLevel = bag.iterationHealth.getStatusLevel();
    const failureAction = this.synthFailureAction(action, bag.iterationHealth);

    // Inject rich health context so the agent can reason about it when provider recovers.
    bag.session.messages.push({
      role: "user",
      content: bag.iterationHealth.buildSessionHealthContext(bag.providerName, failureAction),
    } as ConversationMessage);

    // Progressive disclosure — notify by severity (identical to v1 EMPTY path).
    if (statusLevel === "degraded") {
      bag.emitProgress(this.buildStructuredProgressSignal(
        bag.prompt, bag.progressTitle,
        { kind: "status", message: getResilienceMessage("provider_slow", bag.progressLanguage ?? "en") },
        bag.progressLanguage,
      ));
    } else if (statusLevel === "critical") {
      bag.emitProgress(this.buildStructuredProgressSignal(
        bag.prompt, bag.progressTitle,
        { kind: "status", message: getResilienceMessage("provider_failing", bag.progressLanguage ?? "en", {
          seconds: Math.round(action.backoffMs / 1000),
          attempt: bag.iterationHealth.getConsecutiveFailures(),
          max: 5,
        }) },
        bag.progressLanguage,
      ));
    }

    if (action.notice === "ask_user") {
      bag.emitProgress(this.buildStructuredProgressSignal(
        bag.prompt, bag.progressTitle,
        { kind: "status", message: getResilienceMessage("provider_ask_user", bag.progressLanguage ?? "en") },
        bag.progressLanguage,
      ));
    }

    if (action.control !== "continue") {
      // Terminal: a verdict-stop / health abort.
      const reason = `Provider failure rate critical (${(bag.ledger.health.failureRate * 100).toFixed(0)}% with ${bag.ledger.health.consecutive} consecutive failures).`;
      if (action.control === "return") {
        return {
          control: "return",
          finish: bag.finish(
            getResilienceMessage("provider_abort", bag.progressLanguage ?? "en"),
            "completed",
            reason,
          ),
        };
      }
      bag.onAbort(reason);
      return { control: "break" };
    }

    // Retry / informational ask_user → optional backoff then continue.
    if (action.backoffMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, action.backoffMs));
    }
    return { control: "continue" };
  }

  /**
   * Execute the INTERACTIVE-loop side effects for a ledger verdict. Differs from the bg
   * helper only in I/O surface (sync user-visible `sendVisibleAssistantMarkdown`) and in
   * mapping a terminal stop to `break` (interactive never `finish(...)`-returns mid-loop).
   */
  private async applyInteractiveVerdict(
    verdict: ReturnType<FailureLedger["verdict"]>,
    bag: {
      iterationHealth: IterationHealthTracker;
      chatId: string;
      session: Session;
      providerName: string;
      language: string;
    },
  ): Promise<{ control: "continue" | "break" }> {
    const action = mapVerdictToLoopAction(verdict, "break");
    const statusLevel = bag.iterationHealth.getStatusLevel();
    const failureAction = this.synthFailureAction(action, bag.iterationHealth);

    bag.session.messages.push({
      role: "user",
      content: bag.iterationHealth.buildSessionHealthContext(bag.providerName, failureAction),
    } as ConversationMessage);

    if (statusLevel === "degraded") {
      await this.sessionManager.sendVisibleAssistantMarkdown(
        bag.chatId, bag.session,
        getResilienceMessage("provider_slow", bag.language),
      );
    } else if (statusLevel === "critical") {
      await this.sessionManager.sendVisibleAssistantMarkdown(
        bag.chatId, bag.session,
        getResilienceMessage("provider_failing", bag.language, {
          seconds: Math.round(action.backoffMs / 1000),
          attempt: bag.iterationHealth.getConsecutiveFailures(),
          max: 5,
        }),
      );
    }

    if (action.notice === "ask_user") {
      await this.sessionManager.sendVisibleAssistantMarkdown(
        bag.chatId, bag.session,
        getResilienceMessage("provider_ask_user", bag.language),
      );
    }

    if (action.control === "break") {
      await this.sessionManager.sendVisibleAssistantMarkdown(
        bag.chatId, bag.session,
        getResilienceMessage("provider_abort", bag.language),
      );
      return { control: "break" };
    }

    if (action.backoffMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, action.backoffMs));
    }
    return { control: "continue" };
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

  /** Update consecutive error counter for a tool in a given chat. Resets on success. */
  private trackToolError(chatId: string, toolName: string, isError: boolean): void {
    if (isError) {
      if (!this.toolConsecutiveErrors.has(chatId)) this.toolConsecutiveErrors.set(chatId, new Map());
      const errs = this.toolConsecutiveErrors.get(chatId)!;
      errs.set(toolName, (errs.get(toolName) ?? 0) + 1);
    } else {
      this.toolConsecutiveErrors.get(chatId)?.delete(toolName);
    }
  }

  private getInteractiveIterationLimit(): number {
    const configLimit = Math.max(1, this.taskConfig.interactiveMaxIterations);
    return this.maxIterations ? Math.min(this.maxIterations, configLimit) : configLimit;
  }

  private getBackgroundEpochIterationLimit(): number {
    const configLimit = Math.max(1, this.taskConfig.backgroundEpochMaxIterations);
    return this.maxIterations ? Math.min(this.maxIterations, configLimit) : configLimit;
  }

  private canAutoContinueBackgroundEpoch(completedEpochCount: number): boolean {
    if (!this.taskConfig.backgroundAutoContinue) {
      return false;
    }

    const maxEpochs = this.taskConfig.backgroundMaxEpochs;
    return maxEpochs === 0 || completedEpochCount < maxEpochs;
  }

  private shouldActivateSupervisor(classification: TaskClassification): boolean {
    // Conversational messages never need supervisor decomposition
    if (classification.type === "conversational") return false;
    const threshold = this.supervisorComplexityThreshold;
    if (threshold === "moderate") {
      return classification.complexity === "moderate" || classification.complexity === "complex";
    }
    return classification.complexity === "complex";
  }

  private hasRichSupervisorInput(params: {
    userContent?: string | MessageContent[] | null;
    attachments?: Attachment[];
  }): boolean {
    if (Array.isArray(params.userContent) && params.userContent.some((block) => block.type !== "text")) {
      return true;
    }
    return (params.attachments?.length ?? 0) > 0;
  }

  private resolveSupervisorFallbackPath(
    _params: Pick<SupervisorAdmissionRequest, "goalTree" | "userContent" | "attachments">,
  ): Exclude<SupervisorAdmissionPath, "supervisor"> {
    return "direct_worker";
  }

  private resolveSupervisorScope(chatId: string, channelType?: string, conversationId?: string): string {
    return JSON.stringify([channelType?.trim() || "", resolveConversationScope(chatId, conversationId)]);
  }

  private selectSupervisorPlanningProvider(identityKey: string): IAIProvider | null {
    const providerManager = this.providerManager as ProviderManager & {
      getPrimaryProviderByName?: (name: string, model?: string) => IAIProvider | null;
    };
    const activeInfo = this.providerManager.getActiveInfo(identityKey);
    const activeProviderName = canonicalizeProviderName(activeInfo.providerName) ?? activeInfo.providerName;
    const preferredProvider =
      providerManager.getPrimaryProviderByName?.(activeProviderName, activeInfo.model)
      ?? this.providerManager.getProvider(identityKey);
    if (preferredProvider.capabilities.vision) {
      return preferredProvider;
    }

    for (const candidate of this.providerManager.listExecutionCandidates(identityKey)) {
      const capabilities = this.providerManager.getProviderCapabilities(candidate.name, candidate.defaultModel);
      if (!capabilities?.vision) {
        continue;
      }
      const provider =
        providerManager.getPrimaryProviderByName?.(candidate.name, candidate.defaultModel)
        ?? this.providerManager.getProviderByName(candidate.name, candidate.defaultModel);
      if (provider?.capabilities.vision) {
        return provider;
      }
    }

    return null;
  }

  private async resolveGroundedSupervisorPlanningPrompt(
    params: SupervisorAdmissionRequest,
    coarsePlanningPrompt: string,
  ): Promise<string | null> {
    const groundingContent = buildSupervisorGroundingContent(params);
    if (!groundingContent) {
      return null;
    }

    const identityKey = resolveIdentityKey(
      params.chatId,
      params.userId,
      params.conversationId,
      this.userProfileStore,
      params.channelType,
    );
    const planningProvider = this.selectSupervisorPlanningProvider(identityKey);
    if (!planningProvider?.capabilities.vision) {
      return null;
    }

    try {
      const response = await planningProvider.chat(
        [
          "You are preparing internal planning context for a task orchestrator.",
          "Summarize only grounded facts from the user's multimodal input.",
          "Include visible UI states, errors, labels, filenames, and constraints that matter for task decomposition.",
          "Do not solve the task, ask follow-up questions, or invent unseen details.",
          "Respond in at most 6 short bullet points.",
        ].join(" "),
        [{ role: "user", content: groundingContent }],
        [],
      );
      this.recordProviderUsage(planningProvider.name, response.usage, params.onUsage);
      const groundedContext = this.stripInternalDecisionMarkers(response.text ?? "").trim();
      if (!groundedContext) {
        return null;
      }
      return `${coarsePlanningPrompt}\n\nGrounded multimodal context:\n${groundedContext}`;
    } catch (error) {
      getLogger().warn("Failed to ground supervisor multimodal planning context", {
        chatId: params.chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private getSupervisorWorkerStatus(result: SupervisorResult): WorkerRunResult["status"] {
    if (result.success) {
      return "completed";
    }
    return result.partial ? "blocked" : "failed";
  }

  async evaluateSupervisorAdmission(
    params: SupervisorAdmissionRequest,
  ): Promise<SupervisorAdmissionDecision> {
    const fallbackPath = this.resolveSupervisorFallbackPath(params);
    const coarsePlanningPrompt = buildSupervisorPlanningPrompt(params);
    const shouldRegroundRichInput = this.hasRichSupervisorInput(params);
    const supervisorGoalTree = shouldRegroundRichInput ? undefined : params.goalTree;
    if (!this.supervisorBrain) {
      return {
        path: fallbackPath,
        reason: "unavailable",
      };
    }

    const classification = this.taskClassifier?.classify(coarsePlanningPrompt);
    const shouldForceSupervisor = Boolean(params.goalTree);
    const isDecomposable = this.goalDecomposer?.shouldDecompose(coarsePlanningPrompt) ?? false;
    if (!shouldForceSupervisor && !isDecomposable && (!classification || !this.shouldActivateSupervisor(classification))) {
      return {
        path: fallbackPath,
        reason: "low_complexity",
      };
    }

    let supervisorPlanningPrompt = coarsePlanningPrompt;
    if (shouldRegroundRichInput) {
      const groundedPlanningPrompt = await this.resolveGroundedSupervisorPlanningPrompt(params, coarsePlanningPrompt);
      if (!groundedPlanningPrompt) {
        return {
          path: fallbackPath,
          reason: "multimodal_passthrough",
        };
      }
      supervisorPlanningPrompt = groundedPlanningPrompt;
    }

    if (!this.supervisorBrain.shouldExecute(supervisorPlanningPrompt, supervisorGoalTree)) {
      return {
        path: fallbackPath,
        reason: "not_decomposable",
      };
    }

    const supervisorScope = this.resolveSupervisorScope(
      params.chatId,
      params.channelType,
      params.conversationId,
    );
    if (this.activeSupervisorScopes.has(supervisorScope)) {
      return {
        path: fallbackPath,
        reason: "busy",
      };
    }

    this.activeSupervisorScopes.add(supervisorScope);
    try {
      const activation = buildSupervisorActivationNarrative(params.prompt);
      try {
        await params.onActivated?.(activation);
      } catch {
        // Activation feedback is best-effort only.
      }
      const result = await this.supervisorBrain.execute(params.prompt, {
        chatId: params.chatId,
        channelType: params.channelType,
        userId: params.userId,
        conversationId: params.conversationId,
        taskRunId: params.taskRunId,
        attachments: params.attachments,
        onUsage: params.onUsage,
        workspaceLease: params.workspaceLease,
        userContent: params.userContent,
        planningPrompt: supervisorPlanningPrompt,
        ...(params.signal ? { signal: params.signal } : {}),
        ...(supervisorGoalTree ? { goalTree: supervisorGoalTree } : {}),
        ...(params.onGoalDecomposed ? { onGoalDecomposed: params.onGoalDecomposed } : {}),
        ...(params.reportUpdate ? { reportUpdate: params.reportUpdate } : {}),
      });
      if (!result) {
        return {
          path: fallbackPath,
          reason: "not_decomposable",
        };
      }
      return {
        path: "supervisor",
        reason: "eligible",
        result,
      };
    } catch (err) {
      getLogger().warn("Supervisor brain failed, falling through to PAOR", { error: String(err) });
      return {
        path: fallbackPath,
        reason: "supervisor_error",
      };
    } finally {
      this.activeSupervisorScopes.delete(supervisorScope);
    }
  }

  async tryRouteThroughSupervisor(params: SupervisorAdmissionRequest): Promise<SupervisorResult | null> {
    const decision = await this.evaluateSupervisorAdmission(params);
    return decision.path === "supervisor" ? decision.result : null;
  }

  private buildBackgroundIterationBudgetStopMessage(epochCount: number): string {
    const epochLabel = epochCount === 1 ? "epoch" : "epochs";
    return (
      `Background task reached the configured iteration budget after ${epochCount} ${epochLabel}. ` +
      "A checkpoint summary was persisted, but full resume is not yet supported."
    );
  }

  setFrameworkPromptGenerator(generator: FrameworkPromptGenerator): void {
    this.frameworkPromptGenerator = generator;
    this.rebuildBaseSystemPrompt();
  }

  private rebuildBaseSystemPrompt(): void {
    const frameworkSection = this.frameworkPromptGenerator?.buildFrameworkKnowledgeSection();
    const knowledgeBase = frameworkSection
      ? STRADA_AGENT_PREAMBLE + frameworkSection
      : STRADA_SYSTEM_PROMPT; // fallback to static knowledge

    // Note: vault context is intentionally NOT folded in here. It is
    // request-specific (depends on the current user message) and is injected
    // per-request via buildSystemPromptWithContext({ vaultContext }) so that
    // concurrent chats / background tasks do not race on a shared field.
    this.systemPrompt =
      knowledgeBase +
      buildProjectContext(this.projectPath) +
      buildDepsContext(this.stradaDeps) +
      buildCapabilityManifest() +
      buildToolUsageHints(!!this.vaultRegistry) +
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

  private buildFixedSupervisorExecutionStrategy(
    prompt: string,
    identityKey: string,
    providerName: string,
    modelId: string | undefined,
    provider: IAIProvider,
  ): SupervisorExecutionStrategy {
    const task = this.taskClassifier.classify(prompt);
    const metadata = this.buildCatalogAssignmentMetadata(providerName, modelId, identityKey);
    const buildAssignment = (role: SupervisorRole): SupervisorAssignment =>
      this.buildStaticSupervisorAssignment(
        role,
        providerName,
        modelId,
        provider,
        "Supervisor delegated child-worker assignment",
        undefined,
        metadata,
      );

    return {
      task,
      planner: buildAssignment("planner"),
      executor: buildAssignment("executor"),
      reviewer: buildAssignment("reviewer"),
      synthesizer: buildAssignment("synthesizer"),
      usesMultipleProviders: false,
    };
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

  /**
   * Shared per-iteration boilerplate for both `runBackgroundTask` and `runAgentLoop`.
   *
   * Rebuilds the execution strategy, constructs the phase-aware active prompt,
   * resolves the current provider assignment, builds tool definitions, and
   * appends the supervisor role prompt.  The LLM call itself stays inline in
   * each loop because the two paths diverge (direct `.chat()` vs streaming).
   */
  private prepareIteration(params: {
    prompt: string;
    identityKey: string;
    agentState: AgentState;
    executionJournal: import("./autonomy/execution-journal.js").ExecutionJournal;
    systemPrompt: string;
    fallbackProvider: IAIProvider;
    toolTurnAffinity: SupervisorAssignment | null;
    projectWorldFingerprint?: string;
    enableGoalDetection: boolean;
    fixedExecutionStrategy?: SupervisorExecutionStrategy;
    /** Optional: pass IterationHealthTracker to inject health awareness into the prompt when failures have occurred. */
    iterationHealth?: IterationHealthTracker;
  }): {
    executionStrategy: SupervisorExecutionStrategy;
    activePrompt: string;
    currentAssignment: SupervisorAssignment;
    currentProvider: IAIProvider;
    currentToolDefinitions: Array<{
      name: string;
      description: string;
      input_schema: import("../types/index.js").JsonObject;
    }>;
    currentToolNames: string[];
  } {
    const executionStrategy = params.fixedExecutionStrategy ?? this.buildSupervisorExecutionStrategy(
      params.prompt,
      params.identityKey,
      params.fallbackProvider,
      params.projectWorldFingerprint,
    );

    let activePrompt = params.systemPrompt + buildPhasePromptSection(
      params.agentState,
      params.executionJournal,
      { enableGoalDetection: params.enableGoalDetection },
    );

    const currentAssignment = this.getPinnedToolTurnAssignment(
      executionStrategy,
      params.agentState.phase,
      params.toolTurnAffinity,
    );
    const currentProvider = currentAssignment.provider;
    const currentToolDefinitions = this.buildWorkerToolDefinitions(
      executionStrategy.task,
      params.agentState.phase,
      currentAssignment.role,
    );
    const currentToolNames = currentToolDefinitions.map((d) => d.name);
    activePrompt += this.buildSupervisorRolePrompt(executionStrategy, currentAssignment);

    // Append provider health awareness when failures have occurred during this task
    if (params.iterationHealth && params.iterationHealth.getTotalFailures() > 0) {
      activePrompt += `\n\n## Provider Health Awareness\nThe AI provider has experienced ${params.iterationHealth.getTotalFailures()} failure(s) during this task (current failure rate: ${(params.iterationHealth.getFailureRate() * 100).toFixed(0)}%). If you notice [Provider Health Report] messages in the conversation, this means the provider was temporarily unavailable. Adapt your approach: use fewer tool calls per step, simplify complex operations, and consider providing partial results if the provider remains unstable. Your goal is to deliver the best possible result despite infrastructure challenges.`;
    }

    return {
      executionStrategy,
      activePrompt,
      currentAssignment,
      currentProvider,
      currentToolDefinitions,
      currentToolNames,
    };
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
        : buildSafeVisibleFallbackFromDraftHelper(
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
      return buildSafeVisibleFallbackFromDraftHelper(
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
      // Use the full prompt with personality (soul) instead of the base systemPrompt
      const soulEnrichedPrompt = injectSoulPersonality(this.getContextBuilderDeps(), this.systemPrompt, params.channelType);
      const synthesisResponse = await synthesisProvider.chat(
        `${soulEnrichedPrompt}\n\n${SUPERVISOR_SYNTHESIS_SYSTEM_PROMPT}${this.buildSupervisorRolePrompt(strategy, strategy.synthesizer)}`,
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
      return buildSafeVisibleFallbackFromDraftHelper(
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
      return buildSafeVisibleFallbackFromDraftHelper(params.prompt, rawDraft, strategy.task);
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
    workspaceLeaseRetained?: boolean;
    touchedFiles: readonly string[];
    finalSummary: string;
  }): WorkerArtifactMetadata[] {
    const artifacts: WorkerArtifactMetadata[] = [];
    if (params.workspaceLease) {
      artifacts.push({
        kind: "workspace",
        summary: `Worker executed in isolated workspace ${params.workspaceLease.id}.`,
        ...(params.workspaceLeaseRetained !== false ? { path: params.workspaceLease.path } : {}),
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

  /**
   * Set the workspace bus for emitting monitor events to the dashboard UI.
   * Uses lazy setter because the workspace bus is created after the orchestrator.
   */
  setWorkspaceBus(bus: WorkspaceBus): void {
    this.workspaceBus = bus;
  }

  /** Await any queued workspace code-event emissions (test/shutdown hook). */
  async drainWorkspaceCodeEvents(): Promise<void> {
    await this.workspaceCodeEventQueue;
  }

  setMonitorLifecycle(lifecycle: MonitorLifecycle): void {
    this.monitorLifecycle = lifecycle;
  }

  setGoalStorage(storage: GoalStorage): void {
    this.goalStorage = storage;
  }

  /**
   * Wire a live budget manager so the orchestrator reads the freshest
   * `interactiveTokenBudget` from the unified config store (e.g. after a
   * POST /api/budget/config update) instead of the static TaskConfig value
   * captured at construction time.
   */
  setUnifiedBudgetManager(manager: UnifiedBudgetManager): void {
    // Detach any previous listener before re-wiring to avoid accumulating
    // duplicate callbacks across repeated setUnifiedBudgetManager calls
    // (tests, hot-reload, multi-manager scenarios).
    this.budgetConfigUnsubscribe?.();
    this.budgetConfigUnsubscribe = undefined;
    this.unifiedBudgetManager = manager;
    // No local cache — getLiveInteractiveTokenBudget() reads through on every
    // tick. Logging here only aids observability.
    this.budgetConfigUnsubscribe = manager.onConfigUpdated?.((config) => {
      getLogger().info("Budget config updated — orchestrator will read fresh interactive token budget", {
        interactiveTokenBudget: config.interactiveTokenBudget ?? null,
      });
    });
  }

  /**
   * Wire a persistent checkpoint store so budget/provider aborts can be
   * replayed later. Optional — when unset, save calls are silent no-ops.
   */
  setTaskCheckpointStore(store: TaskCheckpointStore): void {
    this.checkpointStore = store;
  }

  /**
   * Record the most recent routing metadata (channelType, userId, conversationId)
   * for a chat. Used by {@link continueFromCheckpoint} to synthesize an
   * {@link IncomingMessage} on a checkpoint-driven resume.
   */
  private rememberRouting(chatId: string, msg: IncomingMessage): void {
    this.lastRoutingByChat.set(chatId, {
      channelType: msg.channelType,
      userId: msg.userId,
      conversationId: msg.conversationId,
    });
    // Trim the oldest entries when we exceed the bound. Map preserves insertion
    // order, so we can drop the first key cheaply.
    if (this.lastRoutingByChat.size > Orchestrator.MAX_LAST_ROUTING_ENTRIES) {
      const firstKey = this.lastRoutingByChat.keys().next().value;
      if (typeof firstKey === "string") {
        this.lastRoutingByChat.delete(firstKey);
      }
    }
  }

  /**
   * Rehydrate a pending task from its checkpoint and re-enter the interactive
   * PAOR loop using the current (possibly updated) budget. Safe to call even
   * if no checkpoint exists — returns a not-found hint in that case.
   *
   * Checkpoint lifecycle invariant:
   *   - On synchronous setup failure (missing store, concurrent resume,
   *     unknown chat, chat/user mismatch, empty user message) the
   *     checkpoint is preserved — it is cleared only just before async
   *     dispatch via `checkpointStore.clear(cp.taskId)`.
   *   - On async `handleMessage` failure the checkpoint is best-effort
   *     re-persisted via {@link persistCheckpoint} with a bumped
   *     `timestamp` so it beats any older BG/FG failure row in
   *     `loadLatest` (timestamp DESC). If that save itself fails (rare),
   *     the resume context is lost and the user must re-issue the
   *     original request.
   *
   * `options.userId` (optional) enables per-user ownership enforcement in
   * multi-user channels — if supplied AND the checkpoint was written with a
   * userId, the two must match or the call returns `user_mismatch`. Legacy
   * checkpoints (no userId) remain resumable for back-compat.
   */
  async continueFromCheckpoint(
    chatId: string,
    options?: { taskId?: string; userId?: string },
  ): Promise<{
    status: "resumed" | "not_found" | "error";
    reason?: string;
    checkpoint?: PendingTaskCheckpoint;
  }> {
    if (!this.checkpointStore) {
      return { status: "error", reason: "no_store" };
    }

    // Concurrent-resume guard. Prevents /retry + implicit recovery (or two
    // /retry in rapid succession) from racing on the same checkpoint. The
    // checkpoint clear happens async below, so without this guard both
    // callers could enter handleMessage with stale state. (CWE-362)
    if (this.resumeInFlight.has(chatId)) {
      return { status: "error", reason: "resume_in_flight" };
    }
    this.resumeInFlight.add(chatId);

    let cp: PendingTaskCheckpoint | null = null;
    try {
      cp = options?.taskId
        ? await this.checkpointStore.loadByTaskId(options.taskId)
        : await this.checkpointStore.loadLatest(chatId);
    } catch (e) {
      this.resumeInFlight.delete(chatId);
      return { status: "error", reason: e instanceof Error ? e.message : String(e) };
    }

    if (!cp) {
      this.resumeInFlight.delete(chatId);
      return { status: "not_found" };
    }

    // Safety: the checkpoint must belong to this chat. loadByTaskId can
    // otherwise cross-resume foreign sessions if the caller passes a stale
    // taskId — the UI uses chatId as the primary isolation key, so honour it.
    // (CWE-639 Authorization Bypass via User-Controlled Key)
    if (cp.chatId !== chatId) {
      this.resumeInFlight.delete(chatId);
      return { status: "error", reason: "chat_mismatch" };
    }

    // Per-user ownership guard. When the caller supplies a userId AND the
    // checkpoint was written with one, they must match. Legacy checkpoints
    // (cp.userId undefined/empty) stay resumable for back-compat so older
    // rows written before the multi-user isolation migration are not
    // stranded. When the caller does not supply a userId (legacy entry
    // point) we fall back to the prior chatId-only behaviour. This keeps
    // `/retry` in private/single-user chats working while preventing a
    // user B in a shared channel from resuming user A's pending task
    // (CWE-639 Authorization Bypass via User-Controlled Key).
    if (
      options?.userId &&
      typeof cp.userId === "string" &&
      cp.userId.length > 0 &&
      cp.userId !== options.userId
    ) {
      this.resumeInFlight.delete(chatId);
      return { status: "error", reason: "user_mismatch" };
    }

    const text = (cp.lastUserMessage ?? "").trim();
    if (!text) {
      this.resumeInFlight.delete(chatId);
      return { status: "error", reason: "empty_last_user_message" };
    }

    try {
      const session = this.sessionManager.getOrCreateSession(chatId);
      const liveBudget = this.getLiveInteractiveTokenBudget();
      const budgetK = Math.round(liveBudget / 1000);
      getLogger().debug("continueFromCheckpoint: resuming with live token budget", {
        chatId, liveBudget, unlimited: liveBudget === -1,
        unifiedBudgetManagerSet: !!this.unifiedBudgetManager,
      });
      const abbrev = text.length > 80 ? `${text.slice(0, 80)}...` : text;
      const confirmation = [
        `▶️ **Resuming previous task from**: _${abbrev}_`,
        `▶️ **Önceki görevden devam**: _${abbrev}_`,
        "",
        `New budget: **${budgetK}K** tokens / Yeni bütçe: **${budgetK}K** token.`,
      ].join("\n");
      await this.sessionManager.sendVisibleAssistantMarkdown(chatId, session, confirmation);

      // Resolve routing metadata. Prefer the last recorded entry so we stay on
      // the user's active channel; fall back to "web" (the default per the
      // project configuration) when nothing is known.
      const routing = this.lastRoutingByChat.get(chatId);
      const synthesized: IncomingMessage = {
        channelType: routing?.channelType ?? "web",
        chatId,
        conversationId: routing?.conversationId,
        userId: routing?.userId ?? chatId,
        text,
        timestamp: new Date(),
      };

      // Clear the checkpoint BEFORE re-dispatching so a crash/duplicate does
      // not leave us in an infinite resume loop. The user's session state
      // preserves enough context to recover if handleMessage throws.
      try {
        await this.checkpointStore.clear(cp.taskId);
      } catch (clearErr) {
        getLogger().warn("Failed to clear checkpoint after resume trigger", {
          taskId: cp.taskId,
          error: clearErr instanceof Error ? clearErr.message : String(clearErr),
        });
      }

      // Fire-and-forget through the normal interactive entry point. We do not
      // await so the command handler's acknowledgement can stream first; the
      // agent loop will surface its own visible output via the session. The
      // in-flight flag is cleared when the dispatched handleMessage settles so
      // a second /retry while the first resume is still running is rejected
      // with `resume_in_flight` (CWE-362 concurrency guard).
      const restoredCheckpoint = cp;
      void this.handleMessage(synthesized)
        .catch(async (err) => {
          getLogger().error("continueFromCheckpoint: handleMessage failed", {
            chatId,
            taskId: restoredCheckpoint.taskId,
            error: err instanceof Error ? err.message : String(err),
          });
          // Restore the checkpoint so the user can /retry again. The JSDoc
          // invariant "on exception the checkpoint is preserved" must hold
          // even for the async-dispatched path — otherwise a transient
          // provider failure permanently loses the resume context.
          //
          // Timestamp BUMP: `checkpointStore.loadLatest` orders by
          // `timestamp DESC`. If a concurrent BG/FG failure writes a fresh
          // checkpoint while this async handler is settling, reviving with
          // the original `cp.timestamp` would silently be shadowed by that
          // newer row. Bump to `Date.now()` so the restored checkpoint is
          // always the winner for the *next* `/retry`.
          await this.persistCheckpoint({ ...restoredCheckpoint, timestamp: Date.now() }).catch((saveErr) => {
            getLogger().warn(
              "continueFromCheckpoint: failed to restore checkpoint after handleMessage error",
              {
                taskId: restoredCheckpoint.taskId,
                error: saveErr instanceof Error ? saveErr.message : String(saveErr),
              },
            );
          });
        })
        .finally(() => {
          this.resumeInFlight.delete(chatId);
        });

      return { status: "resumed", checkpoint: cp };
    } catch (e) {
      this.resumeInFlight.delete(chatId);
      return {
        status: "error",
        reason: e instanceof Error ? e.message : String(e),
        checkpoint: cp,
      };
    }
  }

  /**
   * Resolve the live input-token budget per interactive/background loop.
   * Prefers the UnifiedBudgetManager override when set (≥ -1); falls back to
   * the static TaskConfig value otherwise. -1 means unlimited.
   */
  private getLiveInteractiveTokenBudget(): number {
    const live = this.unifiedBudgetManager?.getConfig()?.interactiveTokenBudget;
    if (typeof live === "number" && live >= -1) return live;
    if (live !== undefined && live !== null) {
      getLogger().warn("getLiveInteractiveTokenBudget: live value out of range", {
        unifiedBudgetManagerSet: !!this.unifiedBudgetManager,
        rawConfigValue: live,
        fallbackUsed: this.taskConfig.interactiveTokenBudget,
      });
    }
    return this.taskConfig.interactiveTokenBudget;
  }

  /**
   * Best-effort checkpoint save. Never throws — failures are logged and swallowed
   * so the main abort path is not impacted.
   */
  private async persistCheckpoint(cp: PendingTaskCheckpoint): Promise<void> {
    const store = this.checkpointStore;
    if (!store) return;
    try {
      await store.save(cp);
    } catch (err) {
      getLogger().warn("Task checkpoint save failed", { error: String(err), taskId: cp.taskId });
    }
  }

  /**
   * Persist a "budget_exceeded" checkpoint with the current iteration's
   * usage/limit. Shared by both the background and foreground token-budget
   * branches so the payload shape stays consistent.
   */
  private async saveBudgetExceededCheckpoint(params: {
    taskId: string;
    chatId: string;
    lastUserMessage: string;
    used: number;
    budget: number;
  }): Promise<void> {
    await this.persistCheckpoint({
      taskId: params.taskId,
      chatId: params.chatId,
      timestamp: Date.now(),
      stage: "budget_exceeded",
      lastUserMessage: params.lastUserMessage,
      touchedFiles: [],
      budgetState: { used: params.used, budget: params.budget },
    });
  }

  private buildWorkerToolDefinitions(
    _task: TaskClassification,
    phase: AgentPhase,
    role: SupervisorAssignment["role"],
  ): Array<{
    name: string;
    description: string;
    input_schema: import("../types/index.js").JsonObject;
  }> {
    const allowWriteTools =
      role === "executor" &&
      phase !== AgentPhase.PLANNING &&
      phase !== AgentPhase.REPLANNING &&
      phase !== AgentPhase.REFLECTING;

    return this.toolDefinitions.filter((definition) => {
      const metadata = this.toolMetadataByName.get(definition.name);
      if (metadata?.controlPlaneOnly) {
        return false;
      }
      if (metadata?.available === false) {
        return false;
      }
      if (!allowWriteTools && metadata?.readOnly === false) {
        // Allow self-improvement tools in all phases
        if (SELF_IMPROVEMENT_TOOLS.has(definition.name)) {
          return true;
        }
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

  /**
   * Build the dependency bundle consumed by the intervention/clarification/review
   * pipeline. The clarification and review stages prepend the system prompt, so
   * they must see the LIVE per-request prompt (which the PAOR loops mutate via
   * memory re-retrieval) rather than the static base `this.systemPrompt`. Callers
   * inside a loop pass a `getSystemPrompt` thunk closing over their local
   * `systemPrompt` variable so updates are reflected without rebuilding deps.
   */
  private buildInterventionDeps(getSystemPrompt?: () => string): InterventionDeps {
    // Fallback to the static base prompt when no live thunk is supplied.
    const resolveSystemPrompt = getSystemPrompt ?? (() => this.systemPrompt);
    return {
      getReviewerAssignment: (id, s) => this.getClarificationReviewAssignment(id, s),
      classifyTask: (p) => this.taskClassifier.classify(p),
      buildSupervisorRolePrompt: (s, a) => this.buildSupervisorRolePrompt(s, a),
      get systemPrompt(): string {
        return resolveSystemPrompt();
      },
      projectPath: this.projectPath,
      clarificationContext: this.getClarificationContext(),
      stripInternalDecisionMarkers: (t) => stripInternalDecisionMarkersHelper(t),
      interactionPolicy: this.interactionPolicy,
      formatPlanReviewMessage: (d) => this.sessionManager.formatPlanReviewMessage(d),
      recordExecutionTrace: (p) => this.recordExecutionTrace(p as Parameters<typeof this.recordExecutionTrace>[0]),
      recordAuxiliaryUsage: (n, u, h) => this.recordAuxiliaryUsage(n, u, h),
      recordPhaseOutcome: (p) => this.recordPhaseOutcome(p as Parameters<typeof this.recordPhaseOutcome>[0]),
      buildPhaseOutcomeTelemetry: (p) => this.buildPhaseOutcomeTelemetry(p),
      recordRuntimeArtifactEvaluation: (p) => this.recordRuntimeArtifactEvaluation(p as Parameters<typeof this.recordRuntimeArtifactEvaluation>[0]),
      getTaskRunId: () => this.getTaskExecutionContext()?.taskRunId,
      synthesizeUserFacingResponse: (p) => this.synthesizeUserFacingResponse(p),
      runCompletionReviewStages: (p) => this.runCompletionReviewStages(p),
      runVisibilityReview: (p) => this.runVisibilityReview(p),
      executeToolCalls: (chatId, toolCalls, opts) => this.executeToolCalls(chatId, toolCalls, opts),
      getLogRingBuffer: () => typeof getLogRingBuffer === "function" ? getLogRingBuffer() : [],
      buildStructuredProgressSignal: (prompt, title, signal, lang) => this.buildStructuredProgressSignal(prompt, title, signal, lang),
      isAutonomousActive: (chatId, userId) => this.dmPolicy?.isAutonomousActive(chatId, userId) ?? false,
    };
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

    const reviewResult = await reviewClarificationPipeline({
      ...params,
      draft,
    }, this.buildInterventionDeps());

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
      skillEntries: this.getSkillEntries?.(),
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
    vaultContext?: string;
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
   * Compute request-scoped vault context enrichment for a user message.
   * Returns "" when no vault registry is configured or on failure, so the
   * value can be passed directly into buildSystemPromptWithContext.
   */
  private async computeVaultContext(userMessage: string): Promise<string> {
    if (!this.vaultRegistry) return "";
    try {
      return await buildVaultProjectContext({
        vaultRegistry: this.vaultRegistry,
        userMessage,
        contextBudget: 4000,
      });
    } catch (err) {
      getLogger().warn("Vault context enrichment failed", { err });
      return "";
    }
  }

  /**
   * Public accessor for active sessions (used by dashboard /api/sessions).
   */
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

  async deliverPostSetupBootstrap(
    context: PostSetupBootstrapContext,
    bootstrap: PostSetupBootstrap,
  ): Promise<void> {
    const session = this.sessionManager.getOrCreateSession(context.chatId);
    if (session.postSetupBootstrapDelivered) {
      return;
    }

    session.postSetupBootstrapDelivered = true;
    session.lastActivity = new Date();
    session.profileKey ??= context.profileId;
    session.conversationScope ??= context.profileId;
    session.mixedParticipants = false;

    await this.sessionManager.sendVisibleAssistantMarkdown(
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
    // Remember the most recent routing metadata so that checkpoint-driven
    // resumes (continueFromCheckpoint) can reissue a message via the same
    // channel/user without the caller plumbing it through.
    this.rememberRouting(chatId, msg);
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
    const prev = this.sessionManager.sessionLocks.get(chatId) ?? Promise.resolve();
    const current = prev.then(() =>
      this.withTaskExecutionContext(taskContext, async () => this.processMessage(msg)),
    );
    const tracked = current.catch((err) => {
      getLogger().error("Session lock error", {
        chatId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    this.sessionManager.sessionLocks.set(chatId, tracked);
    try {
      await current;
    } finally {
      // Clean up resolved lock to prevent unbounded map growth
      if (this.sessionManager.sessionLocks.get(chatId) === tracked) {
        this.sessionManager.sessionLocks.delete(chatId);
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
    workspaceLeaseRetained?: boolean;
    supervisorMode?: BackgroundTaskOptions["supervisorMode"];
    goalContext?: import("../tasks/types.js").GoalContext;
  }): Promise<WorkerRunResult> {
    const collector: WorkerRunCollector = {
      toolTrace: [],
      childWorkerResults: [],
    };
    let visibleResponse = "";
    let thrownReason: string | undefined;
    try {
      const supervisorMode = request.supervisorMode ?? (request.mode === "background" ? "auto" : "off");
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
          assignedProvider: request.assignedProvider,
          assignedModel: request.assignedModel,
          attachments: request.attachments,
          userContent: request.userContent,
          onUsage: request.onUsage,
          parentMetricId: request.parentMetricId,
          workspaceLease: request.workspaceLease,
          supervisorMode,
          goalContext: request.goalContext,
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
        workspaceLeaseRetained: request.workspaceLeaseRetained,
        touchedFiles,
        finalSummary,
      }),
      reason: collector.reason ?? thrownReason,
    };
  }

  async runBackgroundTask(prompt: string, options: BackgroundTaskOptions): Promise<string> {
    const { signal, onProgress, chatId } = options;
    const supervisorMode = options.supervisorMode ?? "auto";
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

    return await this.withTaskExecutionContext<string>(
      {
        chatId,
        conversationId: options.conversationId,
        userId: options.userId,
        identityKey,
        taskRunId,
      },
      async (): Promise<string> => {
        const logger = getLogger();
        const fixedProviderName =
          canonicalizeProviderName(options.assignedProvider)
          ?? options.assignedProvider?.trim().toLowerCase();
        const fixedModelId = options.assignedModel?.trim() || undefined;
        const fixedProvider = fixedProviderName
          ? this.providerManager.getProviderByName(fixedProviderName, fixedModelId)
          : null;
        if (options.assignedProvider && fixedProviderName && !fixedProvider) {
          logger.warn("Delegated worker provider pin could not be materialized; using fallback provider", {
            assignedProvider: options.assignedProvider,
            canonicalProvider: fixedProviderName,
            assignedModel: fixedModelId,
            chatId,
            taskRunId,
          });
        }
        const fallbackProvider = fixedProvider ?? this.providerManager.getProvider(identityKey);
        const buildExecutionStrategy = (projectWorldFingerprint?: string): SupervisorExecutionStrategy => {
          if (fixedProviderName && fixedProvider) {
            return this.buildFixedSupervisorExecutionStrategy(
              prompt,
              identityKey,
              fixedProviderName,
              fixedModelId,
              fixedProvider,
            );
          }
          return this.buildSupervisorExecutionStrategy(
            prompt,
            identityKey,
            fallbackProvider,
            projectWorldFingerprint,
          );
        };
        let executionStrategy = buildExecutionStrategy();

        // ─── Metrics: start recording ────────────────────────────────────
        const taskType = options.parentMetricId ? ("subtask" as const) : ("background" as const);
        const metricId = this.metricsRecorder?.startTask({
          sessionId: chatId,
          taskDescription: prompt.slice(0, 200),
          taskType,
          parentTaskId: options.parentMetricId,
        });
        this.metrics?.recordMessage();
        // ────────────────────────────────────────────────────────────────

        // Build user content with vision support if attachments present
        const supportsVision = fallbackProvider.capabilities.vision;
        const userContent = options.userContent ?? buildUserContent(
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
          const lastTouch = this.sessionManager.persistTimeMap.get(`touch:${identityKey}`) ?? 0;
          if (Date.now() - lastTouch > 60_000) {
            this.userProfileStore.touchLastSeen(identityKey);
            this.sessionManager.persistTimeMap.set(`touch:${identityKey}`, Date.now());
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

        // Per-user persona override (from profile, not global SoulLoader mutation)
        let bgPersonaContent: string | undefined;
        if (profile?.activePersona && profile.activePersona !== "default" && this.soulLoader) {
          bgPersonaContent =
            (await this.soulLoader.getProfileContent(profile.activePersona)) ?? undefined;
        }

        // Build system prompt with all context layers (DRY: shared with runAgentLoop)
        // Per-request vault context enrichment (request-scoped, not a shared field).
        const bgVaultContext = await this.computeVaultContext(prompt);
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
          personaContent: bgPersonaContent,
          vaultContext: bgVaultContext,
          profile,
          preComputedEmbedding: bgEmbedding,
        });
        let systemPrompt = builtPrompt;
        executionStrategy = buildExecutionStrategy(bgProjectWorldFingerprint);

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
        const bgMemoryRefresher = this.sessionManager.createMemoryRefresher(bgInitialContentHashes);
        // ────────────────────────────────────────────────────────────────

        // Autonomy layer
        const {
          errorRecovery,
          taskPlanner,
          selfVerification,
          executionJournal,
          controlLoopTracker: controlLoopTrackerOrNull,
          stradaConformance,
        } = createAutonomyBundle({
          prompt,
          iterationBudget: this.getBackgroundEpochIterationLimit(),
          stradaDeps: this.stradaDeps,
          projectWorldSummary: bgProjectWorldSummary,
          projectWorldFingerprint: bgProjectWorldFingerprint,
          includeControlLoopTracker: true,
          previousJournalSnapshot: session.lastJournalSnapshot,
          conformanceEnabled: this.conformanceEnabled,
          conformanceFrameworkPathsOnly: this.conformanceFrameworkPathsOnly,
          loopFingerprintThreshold: this.loopFingerprintThreshold,
          loopFingerprintWindow: this.loopFingerprintWindow,
          loopDensityThreshold: this.loopDensityThreshold,
          loopDensityWindow: this.loopDensityWindow,
          loopMaxRecoveryEpisodes: this.loopMaxRecoveryEpisodes,
          loopStaleAnalysisThreshold: this.loopStaleAnalysisThreshold,
          loopHardCapReplan: this.loopHardCapReplan,
          loopHardCapBlock: this.loopHardCapBlock,
          progressAssessmentEnabled: this.progressAssessmentEnabled,
        });
        const controlLoopTracker = controlLoopTrackerOrNull!;
        // Pass a live thunk so clarification/review stages see the per-request
        // prompt (updated by memory re-retrieval), not the static base prompt.
        const interventionDeps = this.buildInterventionDeps(() => systemPrompt);
        const progressTitle = prompt.replace(/\s+/g, " ").trim().slice(0, 80) || "Task";
        const progressLanguage = (profile?.language ?? this.defaultLanguage) as ProgressLanguage;
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
        /** Terminal exit helper — always used with `return` to exit the loop. */
        const bgFinishBlocked = async (text: string): Promise<string> => {
          // Log the internal diagnostic, show user-friendly message with context
          const isDiagnostic = DIAGNOSTIC_BLOCKED_RE.test(text);
          let userText: string;
          if (isDiagnostic) {
            logger.warn("Loop detection blocked task", { chatId, diagnostic: text.slice(0, 500) });
            bgAgentState = { ...bgAgentState, loopDetectionBlocked: true };
            const stuckMsg = getResilienceMessage("task_stuck", progressLanguage ?? "en");
            // Extract the suggested action from the diagnostic to give the user actionable context
            const actionMatch = /Suggested action:\s*(.+?)(?:\nFiles t|$)/is.exec(text);
            userText = actionMatch?.[1]?.trim()
              ? `${stuckMsg}\n\n**${actionMatch[1].trim()}**`
              : stuckMsg;
          } else {
            userText = text;
          }
          this.sessionManager.appendVisibleAssistantMessage(session, userText);
          this.recordMetricEnd(metricId, {
            agentPhase: AgentPhase.COMPLETE,
            iterations: bgAgentState.iteration,
            toolCallCount: bgToolCallCount,
            hitMaxIterations: false,
          });
          await this.sessionManager.persistSessionToMemory(chatId, this.sessionManager.getVisibleTranscript(session), true);
          return finish(userText, "blocked", userText);
        };

        // Phase 1b: declared OUTSIDE the try so the outer finally can dispose it. Assigned
        // (flag-ON only) once the ledger is built; undefined keeps the byte-identical v1 path.
        let bgRunClock: RunClock | undefined;
        try {
          if (supervisorMode !== "off") {
            let lastSupervisorSummary: string | null = null;
            const emitSupervisorProgress = (summary: string, message: string): void => {
              const normalized = summary.trim();
              if (!normalized || normalized === lastSupervisorSummary) {
                return;
              }
              lastSupervisorSummary = normalized;
              emitProgress({
                kind: "goal",
                message,
                userSummary: normalized,
              });
            };
            const supervisorDecision = await this.evaluateSupervisorAdmission({
              prompt,
              chatId,
              channelType: options.channelType,
              userId: options.userId,
              conversationId: options.conversationId,
              signal,
              userContent,
              attachments: options.attachments,
              taskRunId,
              onUsage: options.onUsage ?? this.onUsage,
              workspaceLease: options.workspaceLease,
              onActivated: (activation) => {
                emitSupervisorProgress(
                  normalizeSupervisorProgressMarkdown(activation.markdown),
                  "Supervisor activation",
                );
              },
              reportUpdate: (markdown) => {
                emitSupervisorProgress(
                  normalizeSupervisorProgressMarkdown(markdown),
                  "Supervisor update",
                );
              },
            });
            if (supervisorDecision.path === "supervisor") {
              const supervisorResult = supervisorDecision.result;
              return finish(
                supervisorResult.output,
                this.getSupervisorWorkerStatus(supervisorResult),
                supervisorResult.output,
              );
            }
          }

          let consecutiveMaxTokens = 0;
          let consecutiveProviderFailures = 0;
          const iterationHealth = new IterationHealthTracker();
          // Agent Core v2 — Phase 1a (flag-gated). The ledger wraps the SAME iterationHealth
          // tracker, so the OFF path's downstream reads (health-awareness prompt, tool-result
          // health context) keep working unchanged. pauseRetryBudget:0 is correct for 1a:
          // callStalled is never set (run-clock OFF) → rule 6 dead → budget never consulted.
          // Phase 1b: when run-clock is ON, open ONE RunClock per bg run and lift the pause→retry
          // budget from the resolved policy so rule 6 (call-stall → pause→retry→stop) is live.
          let bgPauseRetryBudget = 0;
          if (this.agentCoreFlagSet?.runClock === true) {
            const { policy, warnings } = resolveRunBudgetPolicy("background", this.buildPolicySeed());
            for (const w of warnings) logger.warn(`[RunBudgetPolicy:background] ${w}`);
            bgRunClock = openRunClock(this.agentCoreClock, policy);
            bgPauseRetryBudget = policy.pauseRetryBudget;
          }
          const bgFailureLedgerAdapter =
            this.agentCoreFlagSet?.failureLedger === true
              ? new IterationHealthCoreAdapter(iterationHealth, "")
              : undefined;
          const bgFailureLedger = bgFailureLedgerAdapter
            ? createFailureLedger(bgFailureLedgerAdapter, { pauseRetryBudget: bgPauseRetryBudget })
            : undefined;
          let maxTokensAbort = false;
          let providerAbort = false;
          let providerAbortReason: string | undefined;
          let bgCumulativeInputTokens = 0; // observability only
          let bgCumulativeOutputTokens = 0; // the budget-gating metric (audit #3)
          while (true) {
            // Re-read every epoch so a mid-task budget raise (via /token
            // or the portal budget editor) actually takes effect without
            // requiring the user to hit the checkpoint limit and /retry.
            const bgTokenBudget = this.getLiveInteractiveTokenBudget();
            for (
              bgEpochIteration = 0;
              bgEpochIteration < bgEpochIterationLimit;
              bgEpochIteration++, bgIteration++
            ) {
              // Check cancellation
              if (signal.aborted) {
                throw new Error("Task cancelled");
              }
              const bgIterationStartMs = Date.now();

              const {
                executionStrategy: iterStrategy,
                activePrompt,
                currentAssignment,
                currentProvider,
                currentToolDefinitions,
                currentToolNames,
              } = this.prepareIteration({
                prompt,
                identityKey,
                agentState: bgAgentState,
                executionJournal,
                systemPrompt,
                fallbackProvider,
                toolTurnAffinity,
                projectWorldFingerprint: bgProjectWorldFingerprint,
                enableGoalDetection: false,
                fixedExecutionStrategy: fixedProviderName && fixedProvider ? executionStrategy : undefined,
                iterationHealth,
              });
              executionStrategy = iterStrategy;
              if (workerCollector) {
                workerCollector.lastAssignment = currentAssignment;
              }

              // Trim session to stay within provider context window limits
              const maxMessages = getRecommendedMaxMessages(
                currentAssignment.providerName,
                currentAssignment.modelId,
                this.modelIntelligence,
                this.providerManager.getProviderCapabilities?.(
                  currentAssignment.providerName,
                  currentAssignment.modelId,
                ),
                currentAssignment.providerName,
              );
              if (session.messages.length > maxMessages) {
                session.messages = session.messages.slice(-maxMessages);
              }

              this.maybeCompactSession(session, currentAssignment.providerName, currentAssignment.modelId, activePrompt);

              // Use silent streaming for background tasks when available.
              // Non-streaming calls to providers like Kimi hit gateway timeouts (~5min)
              // because long-running LLM responses are cut off server-side.
              // Task-aware fallback: use ProviderRouter-ranked order when available
              const resilientProvider = this.buildTaskAwareProvider(
                currentAssignment.providerName,
                executionStrategy.task,
                bgAgentState.phase,
                {
                  modelId: currentAssignment.modelId,
                  identityKey,
                  usesMultipleProviders: executionStrategy.usesMultipleProviders,
                },
              ) ?? currentProvider;
              const canBgStream =
                this.streamingEnabled &&
                "chatStream" in resilientProvider &&
                typeof resilientProvider.chatStream === "function";
              let response;
              // Phase 1b: capture the non-streaming sibling's CallScope so the catch can read
              // its typed token.reason (provider-stall / hard-timeout) for the verdict's
              // `callStalled`. Declared outside the try; undefined on the streaming path and on
              // flag-OFF (streaming sites rely on the silence accumulator instead — P-1b-4).
              let bgChatScope: CallScope | undefined;
              try {
                response = canBgStream
                  ? await this.silentStream(
                      chatId, activePrompt, session, resilientProvider, currentToolDefinitions, signal,
                      // Re-arm the per-task inactivity watchdog from intra-call
                      // keepalive/reasoning liveness (audit #8). Non-user-facing.
                      () => emitProgress({ kind: "heartbeat", message: "" }),
                      bgRunClock, // Phase 1b
                    )
                  : bgRunClock
                  ? await (async () => {
                      // Phase 1b ON: per-call deadline is the CallScope token, carved under
                      // task-remaining; externalSignal stays the task `signal` ALONE (audit #6/#7).
                      bgChatScope = bgRunClock.enterCall({
                        firstResponseMs: this.streamInitialTimeoutMs,
                        stallMs: this.streamInitialTimeoutMs,
                        hardMs: this.streamInitialTimeoutMs,
                      });
                      try {
                        return await resilientProvider.chat(
                          this.withCompactionSummary(activePrompt, session),
                          session.messages,
                          currentToolDefinitions,
                          {
                            signal: AbortSignal.any([signal, bgChatScope.token.signal]),
                            externalSignal: signal,
                          },
                        );
                      } finally {
                        bgChatScope.leave();
                      }
                    })()
                  : await resilientProvider.chat(
                      this.withCompactionSummary(activePrompt, session),
                      session.messages,
                      currentToolDefinitions,
                      // Non-streaming sibling of the silentStream path. Bound it with a
                      // per-call deadline: the streaming path has its progress watchdog and
                      // the interactive non-streaming path has the same AbortSignal.timeout,
                      // but this background path had NONE — so a stalled provider hung the
                      // task until the task-level abort (observed: ~70min silent stall).
                      // Compose the deadline with the task signal; externalSignal stays the
                      // task signal ALONE so a benign cancel / inactivity abort isn't mistaken
                      // for a provider stall (no health poison / no false fall-over), while a
                      // genuine timeout IS treated as a provider failure (audit #6 / #7).
                      {
                        signal: AbortSignal.any([signal, AbortSignal.timeout(this.streamInitialTimeoutMs)]),
                        externalSignal: signal,
                      },
                    );
              } catch (providerError) {
                const errMsg = providerError instanceof Error ? providerError.message : String(providerError);
                const isTimeoutOrAbort = /aborted|timeout|ETIMEDOUT|stall/i.test(errMsg);
                // Don't swallow cancellation — let the outer catch handle it
                if (signal.aborted) throw providerError;

                if (bgFailureLedger && bgFailureLedgerAdapter) {
                  // ── Agent Core v2 — Phase 1a/1b LEDGER PATH (bg THROW). 1a: a throw is a
                  //    generic health failure (rules 5/7/9). 1b: when run-clock is ON, the
                  //    non-streaming sibling's typed token.reason also feeds rule 6 (call-stall)
                  //    / rule 2 (hard-timeout) via buildPhase1bVerdictInput. ──
                  const verdict = bgRunClock
                    ? this.recordPhase1bFailureAndVerdict(
                        bgFailureLedger,
                        bgFailureLedgerAdapter,
                        currentAssignment.providerName,
                        bgRunClock,
                        bgChatScope?.token.reason ?? null,
                      )
                    : this.recordPhase1aFailureAndVerdict(
                    bgFailureLedger,
                    bgFailureLedgerAdapter,
                    currentAssignment.providerName,
                  );
                  logger.warn("Provider call failed in background loop (ledger)", {
                    chatId,
                    epoch: bgEpochCount,
                    iteration: bgIteration,
                    provider: currentAssignment.providerName,
                    error: errMsg,
                    consecutive: bgFailureLedger.health.consecutive,
                    isTimeoutOrAbort,
                    verdict: verdict.decision,
                  });
                  const handled = await this.applyBackgroundVerdict(verdict, {
                    ledger: bgFailureLedger,
                    iterationHealth,
                    session,
                    providerName: currentAssignment.providerName,
                    prompt,
                    progressTitle,
                    progressLanguage,
                    emitProgress,
                    finish,
                    abortControl: "break",
                    onAbort: (reason) => { providerAbort = true; providerAbortReason = reason; },
                  });
                  if (handled.control === "return") return handled.finish;
                  if (handled.control === "break") break;
                  if (isTimeoutOrAbort) {
                    // Give back the iteration — timeouts produce no progress (UNCHANGED).
                    bgEpochIteration--;
                    bgIteration--;
                  }
                  continue;
                }

                consecutiveProviderFailures++;
                logger.warn("Provider call failed in background loop", {
                  chatId,
                  epoch: bgEpochCount,
                  iteration: bgIteration,
                  provider: currentAssignment.providerName,
                  error: errMsg,
                  consecutiveProviderFailures,
                  isTimeoutOrAbort,
                });

                const bgFailureEval = evaluateProviderFailure(
                  consecutiveProviderFailures, MAX_CONSECUTIVE_PROVIDER_FAILURES,
                  currentAssignment.providerName, errMsg,
                );
                if (bgFailureEval.action === "abort") {
                  logger.error("Background task aborting: too many consecutive provider failures", {
                    consecutiveProviderFailures, chatId, provider: currentAssignment.providerName,
                  });
                  providerAbort = true;
                  providerAbortReason = `Too many consecutive provider failures (${consecutiveProviderFailures}).`;
                  break;
                }

                if (isTimeoutOrAbort) {
                  // Give back the iteration — timeouts produce no progress
                  bgEpochIteration--;
                  bgIteration--;
                }

                if (bgFailureEval.guidanceMessage) {
                  session.messages.push({
                    role: "user",
                    content: bgFailureEval.guidanceMessage,
                  } as ConversationMessage);
                }

                continue;
              }
              // The ledger path defers its success accounting to the EMPTY gate below
              // (a response that arrives but is EMPTY is a failure, so success must NOT be
              // recorded here — only once we know the response is usable). v1's two
              // independent counters reset separately, so the OFF arm keeps its post-catch
              // reset of `consecutiveProviderFailures`.
              if (!bgFailureLedger) {
                consecutiveProviderFailures = 0;
              }
              this.recordExecutionTrace({
                chatId,
                identityKey,
                assignment: currentAssignment,
                phase: toExecutionPhaseModel(bgAgentState.phase),
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

              // Token budget enforcement. Gate on cumulative OUTPUT tokens ("fresh
              // work" the model generated) — NOT cumulative input. Cumulative input
              // re-counts the whole growing context every iteration, so a task with
              // a stable working set was killed for RE-SENDING rather than for doing
              // new work (it hit 500K "input" by ~iteration 13 while the real context
              // was a fraction of that). Output tokens don't re-count re-sent context
              // and remain a real runaway/cost bound (audit #3). Cumulative input is
              // kept for observability only.
              bgCumulativeInputTokens += response.usage?.inputTokens ?? 0;
              bgCumulativeOutputTokens += response.usage?.outputTokens ?? 0;
              if (bgTokenBudget !== -1 && bgCumulativeOutputTokens > bgTokenBudget) {
                logger.warn("Background token budget exceeded", {
                  chatId, bgCumulativeOutputTokens, bgCumulativeInputTokens, bgTokenBudget,
                  iteration: bgIteration, provider: currentAssignment.providerName,
                });
                await this.saveBudgetExceededCheckpoint({
                  taskId: options.taskRunId ?? `${chatId}-bg-${Date.now()}`,
                  chatId,
                  lastUserMessage: typeof prompt === "string" ? prompt : "",
                  used: bgCumulativeOutputTokens,
                  budget: bgTokenBudget,
                });
                return finish(
                  getResilienceMessage("token_budget_exceeded", progressLanguage ?? "en", {
                    used: Math.round(bgCumulativeOutputTokens / 1000),
                    budget: Math.round(bgTokenBudget / 1000),
                  }),
                  "completed",
                  "Background token budget exceeded",
                );
              }

              // Per-iteration observability log
              logger.debug("Iteration complete (bg)", {
                iteration: bgIteration + 1, chatId,
                tokens: response.usage?.totalTokens ?? 0,
                inputTokens: response.usage?.inputTokens ?? 0,
                toolCalls: response.toolCalls?.length ?? 0,
                cumulativeInputTokens: bgCumulativeInputTokens,
                durationMs: Date.now() - bgIterationStartMs,
              });

              // Intelligent provider resilience: detect synthetic empty responses and adapt
              if (bgFailureLedger && bgFailureLedgerAdapter) {
                // ── Agent Core v2 — Phase 1a/1b LEDGER PATH (bg EMPTY). Emptiness is v1's shared
                //    predicate; the ledger owns retry/ask_user/abort + backoff. An EMPTY response
                //    is not a call-stall (the call returned), so 1b passes null failedCallReason;
                //    the task-scope silence/hard signals still flow via buildPhase1bVerdictInput. ──
                if (isEmptyProviderResponse(response)) {
                  const verdict = bgRunClock
                    ? this.recordPhase1bFailureAndVerdict(
                        bgFailureLedger,
                        bgFailureLedgerAdapter,
                        currentAssignment.providerName,
                        bgRunClock,
                        null,
                      )
                    : this.recordPhase1aFailureAndVerdict(
                    bgFailureLedger,
                    bgFailureLedgerAdapter,
                    currentAssignment.providerName,
                  );
                  const handled = await this.applyBackgroundVerdict(verdict, {
                    ledger: bgFailureLedger,
                    iterationHealth,
                    session,
                    providerName: currentAssignment.providerName,
                    prompt,
                    progressTitle,
                    progressLanguage,
                    emitProgress,
                    finish,
                    abortControl: "return",
                    onAbort: (reason) => { providerAbort = true; providerAbortReason = reason; },
                  });
                  if (handled.control === "return") return handled.finish;
                  if (handled.control === "break") break;
                  continue;
                }
                bgFailureLedger.recordSuccess(currentAssignment.providerName, "real");
              } else {
                const cbResult = checkProviderFailureCircuitBreaker(response, iterationHealth.getConsecutiveFailures());
                if (cbResult.action !== "ok") {
                  const failureAction = iterationHealth.recordFailure(currentAssignment.providerName);
                  const statusLevel = iterationHealth.getStatusLevel();

                  // Inject rich health context so the agent can reason about it when provider recovers
                  session.messages.push({
                    role: "user",
                    content: iterationHealth.buildSessionHealthContext(currentAssignment.providerName, failureAction),
                  } as ConversationMessage);

                  // Progressive disclosure — notify user based on severity
                  if (statusLevel === "degraded") {
                    emitProgress(this.buildStructuredProgressSignal(
                      prompt, progressTitle,
                      { kind: "status", message: getResilienceMessage("provider_slow", progressLanguage ?? "en") },
                      progressLanguage,
                    ));
                  } else if (statusLevel === "critical") {
                    emitProgress(this.buildStructuredProgressSignal(
                      prompt, progressTitle,
                      { kind: "status", message: getResilienceMessage("provider_failing", progressLanguage ?? "en", {
                        seconds: Math.round((failureAction.kind !== "abort" ? failureAction.backoffMs : 0) / 1000),
                        attempt: iterationHealth.getConsecutiveFailures(),
                        max: 5,
                      }) },
                      progressLanguage,
                    ));
                  }

                  // Ask user — provider has been unreliable beyond retry threshold
                  if (failureAction.kind === "ask_user") {
                    emitProgress(this.buildStructuredProgressSignal(
                      prompt, progressTitle,
                      { kind: "status", message: getResilienceMessage("provider_ask_user", progressLanguage ?? "en") },
                      progressLanguage,
                    ));
                  }

                  // Abort if failure rate is critical
                  if (failureAction.kind === "abort") {
                    logger.error("Provider failure rate critical — aborting task", {
                      chatId,
                      provider: currentAssignment.providerName,
                      failureRate: iterationHealth.getFailureRate(),
                      consecutiveFailures: iterationHealth.getConsecutiveFailures(),
                      totalFailures: iterationHealth.getTotalFailures(),
                      taskDurationMs: iterationHealth.getTaskDurationMs(),
                    });
                    return finish(
                      getResilienceMessage("provider_abort", progressLanguage ?? "en"),
                      "completed",
                      failureAction.reason,
                    );
                  }

                  // Exponential backoff before retry
                  if (failureAction.backoffMs > 0) {
                    logger.info("Provider failure backoff", {
                      chatId,
                      backoffMs: failureAction.backoffMs,
                      provider: currentAssignment.providerName,
                      consecutiveFailures: iterationHealth.getConsecutiveFailures(),
                    });
                    await new Promise(resolve => setTimeout(resolve, failureAction.backoffMs));
                  }

                  continue;
                } else {
                  iterationHealth.recordSuccess();
                }
              }

              // max_tokens: model output was truncated — push and continue so the model finishes.
              if (response.stopReason === "max_tokens" && response.toolCalls.length === 0) {
                consecutiveMaxTokens++;
                if (consecutiveMaxTokens >= 3) {
                  logger.error("max_tokens on 3 consecutive calls — aborting to prevent runaway accumulation", { chatId });
                  maxTokensAbort = true;
                  break;
                }
                logger.warn("Background LLM response truncated by max_tokens — auto-continuing", {
                  chatId,
                  epoch: bgEpochCount,
                  epochIteration: bgEpochIteration,
                  iteration: bgIteration,
                  textLength: response.text?.length ?? 0,
                });
                pushContinuationMessages(
                  { responseText: response.text, session },
                  MAX_TOKENS_CONTINUATION_GATE,
                );
                continue;
              }
              consecutiveMaxTokens = 0;

              // ─── PAOR: Handle REFLECTING phase response ─────────────────────
              if (bgAgentState.phase === AgentPhase.REFLECTING) {
                const { decision, wasOverride } = await processReflectionPreamble({
                  agentState: bgAgentState,
                  executionJournal,
                  responseText: response.text,
                  providerName: currentAssignment.providerName,
                  modelId: currentAssignment.modelId,
                  logLabel: "bg",
                });
                if (wasOverride) {
                  bgAgentState = { ...bgAgentState, reflectionOverrideCount: bgAgentState.reflectionOverrideCount + 1 };
                }

                // Pending checks (tightly coupled to loop return)
                if (response.toolCalls.length === 0) {
                  const pending = checkPendingBlocks({
                    getPendingPlanReviewVisibleText: (c) => this.sessionManager.getPendingPlanReviewVisibleText(c),
                    getPendingSelfManagedWriteRejectionVisibleText: (s, d) => this.sessionManager.getPendingSelfManagedWriteRejectionVisibleText(s as Session, d),
                    chatId, session, responseText: response.text,
                  });
                  if (pending.blocked) {
                    return bgFinishBlocked(pending.text);
                  }
                }

                const bgReflectionCtx: BgReflectionContext = {
                  chatId,
                  identityKey,
                  prompt,
                  responseText: response.text,
                  responseUsage: response.usage,
                  toolCallCount: response.toolCalls.length,
                  executionStrategy,
                  executionJournal,
                  selfVerification,
                  stradaConformance,
                  taskStartedAtMs,
                  currentToolNames,
                  currentAssignment,
                  interventionDeps,
                  session,
                  usageHandler: options.onUsage ?? this.onUsage,
                  recordPhaseOutcome: (p) => this.recordPhaseOutcome(p),
                  buildPhaseOutcomeTelemetry: buildBgPhaseOutcomeTelemetry,
                  progressAssessmentEnabled: this.progressAssessmentEnabled,
                  controlLoopTracker,
                  workerCollector,
                  progressTitle,
                  progressLanguage,
                  iteration: bgIteration,
                  workspaceLease: options.workspaceLease,
                  systemPrompt,
                  emitProgress,
                  buildStructuredProgressSignal: (p, t, s, l) => this.buildStructuredProgressSignal(p, t, s, l),
                  getClarificationContext: () => this.getClarificationContext(),
                  formatBoundaryVisibleText: (b) => this.sessionManager.formatBoundaryVisibleText(b),
                  appendVisibleAssistantMessage: (s, t) => this.sessionManager.appendVisibleAssistantMessage(s, t),
                  synthesizeUserFacingResponse: (p) => this.synthesizeUserFacingResponse(p),
                  persistSessionToMemory: (c, t, f) => this.sessionManager.persistSessionToMemory(c, t, f),
                  getVisibleTranscript: (s) => this.sessionManager.getVisibleTranscript(s),
                };

                let bgAction: ReflectionLoopAction;
                if (decision === "DONE" || decision === "DONE_WITH_SUGGESTIONS") {
                  bgAction = await handleBgReflectionDone(bgAgentState, bgReflectionCtx);
                } else if (decision === "REPLAN") {
                  bgAction = handleBgReflectionReplan(bgAgentState, bgReflectionCtx);
                } else {
                  bgAction = await handleBgReflectionContinue(bgAgentState, bgReflectionCtx, response.toolCalls.length);
                }

                if (bgAction.flow === "continue") {
                  bgAgentState = bgAction.newState;
                  if (decision !== "DONE" && decision !== "DONE_WITH_SUGGESTIONS" && response.toolCalls.length > 0) {
                    // CONTINUE with tool calls — fall through to tool execution below
                  } else {
                    continue;
                  }
                } else if (bgAction.flow === "done") {
                  this.recordMetricEnd(metricId, {
                    agentPhase: AgentPhase.COMPLETE,
                    iterations: bgAgentState.iteration,
                    toolCallCount: bgToolCallCount,
                    hitMaxIterations: false,
                  });
                  await this.sessionManager.persistSessionToMemory(
                    chatId,
                    this.sessionManager.getVisibleTranscript(session),
                    true,
                  );
                  return finish(
                    bgAction.visibleText || "Task completed without output.",
                    bgAction.status ?? "completed",
                    bgAction.visibleText || "Task completed without output.",
                  );
                } else {
                  // blocked
                  if (bgAction.status === "completed") {
                    return finish(bgAction.visibleText, "completed", bgAction.visibleText);
                  }
                  return bgFinishBlocked(bgAction.visibleText);
                }
              }
              // ────────────────────────────────────────────────────────────────

              if (
                (bgAgentState.phase === AgentPhase.PLANNING ||
                  bgAgentState.phase === AgentPhase.REPLANNING) &&
                response.toolCalls.length === 0 &&
                userExplicitlyAskedForPlan(prompt) &&
                draftLooksLikeInternalPlanArtifact(response.text ?? "", {
                  toolNames: currentToolNames,
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
                  this.sessionManager.appendVisibleAssistantMessage(
                    session,
                    this.sessionManager.formatPlanReviewMessage(planText),
                  );
                }
                this.recordMetricEnd(metricId, {
                  agentPhase: AgentPhase.COMPLETE,
                  iterations: bgAgentState.iteration,
                  toolCallCount: bgToolCallCount,
                  hitMaxIterations: false,
                });
                await this.sessionManager.persistSessionToMemory(
                  chatId,
                  this.sessionManager.getVisibleTranscript(session),
                  /* force */ true,
                );
                return finish(
                  planText
                    ? this.sessionManager.formatPlanReviewMessage(planText)
                    : "Plan prepared for review.",
                  "blocked",
                  planText ?? "Plan prepared for review.",
                );
              }

              // Autonomous mode: text-only responses during PLANNING/REPLANNING are internal
              // plans, not final responses. Record the plan, transition to EXECUTING, and
              // let the PAOR loop continue. The agent should execute — not present plans.
              if (
                (bgAgentState.phase === AgentPhase.PLANNING ||
                  bgAgentState.phase === AgentPhase.REPLANNING) &&
                response.toolCalls.length === 0 &&
                draftLooksLikeInternalPlanArtifact(response.text ?? "", { toolNames: currentToolNames }) &&
                this.dmPolicy?.isAutonomousActive(chatId, options.userId)
              ) {
                bgAgentState = handlePlanPhaseTransition({
                  agentState: bgAgentState,
                  executionJournal,
                  responseText: response.text,
                  providerName: currentAssignment.providerName,
                  modelId: currentAssignment.modelId,
                  autoTransition: true,
                });
                session.messages.push(
                  { role: "assistant", content: response.text },
                  { role: "user", content: "Plan recorded. Now execute it step by step using the available tools. Start with the first actionable step." },
                );
                continue;
              }

              // Final response — return text (extracted to orchestrator-end-turn-handler.ts)
              // If tool calls are present we must execute them even when the
              // provider signals end_turn (some providers emit both).
              if (response.toolCalls.length === 0) {
                const pending = checkPendingBlocks({
                  getPendingPlanReviewVisibleText: (c) => this.sessionManager.getPendingPlanReviewVisibleText(c),
                  getPendingSelfManagedWriteRejectionVisibleText: (s, d) => this.sessionManager.getPendingSelfManagedWriteRejectionVisibleText(s as Session, d),
                  chatId, session, responseText: response.text,
                });
                if (pending.blocked) {
                  return bgFinishBlocked(pending.text);
                }

                const bgEndTurnCtx: BgEndTurnContext = {
                  chatId,
                  identityKey,
                  prompt,
                  taskClassification: this.taskClassifier.classify(prompt),
                  responseText: response.text,
                  responseUsage: response.usage,
                  executionStrategy,
                  executionJournal,
                  selfVerification,
                  stradaConformance,
                  taskStartedAtMs,
                  currentToolNames,
                  currentAssignment,
                  interventionDeps,
                  session,
                  usageHandler: options.onUsage ?? this.onUsage,
                  recordPhaseOutcome: (p) => this.recordPhaseOutcome(p),
                  buildPhaseOutcomeTelemetry: buildBgPhaseOutcomeTelemetry,
                  progressAssessmentEnabled: this.progressAssessmentEnabled,
                  controlLoopTracker,
                  workerCollector,
                  progressTitle,
                  progressLanguage,
                  iteration: bgIteration,
                  workspaceLease: options.workspaceLease,
                  systemPrompt,
                  daemonMode: true,
                  emitProgress,
                  buildStructuredProgressSignal: (p, t, s, l) => this.buildStructuredProgressSignal(p, t, s, l),
                  getClarificationContext: () => this.getClarificationContext(),
                  formatBoundaryVisibleText: (b) => this.sessionManager.formatBoundaryVisibleText(b),
                  appendVisibleAssistantMessage: (s, t) => this.sessionManager.appendVisibleAssistantMessage(s, t),
                  synthesizeUserFacingResponse: (p) => this.synthesizeUserFacingResponse(p),
                  persistSessionToMemory: (c, t, f) => this.sessionManager.persistSessionToMemory(c, t as ConversationMessage[], f),
                  getVisibleTranscript: (s) => this.sessionManager.getVisibleTranscript(s),
                };
                const bgEndAction: EndTurnLoopAction = await handleBgEndTurn(bgAgentState, bgEndTurnCtx);

                if (bgEndAction.flow === "continue") {
                  bgAgentState = bgEndAction.newState;
                  continue;
                } else if (bgEndAction.flow === "done") {
                  this.recordMetricEnd(metricId, {
                    agentPhase: AgentPhase.COMPLETE,
                    iterations: bgAgentState.iteration,
                    toolCallCount: bgToolCallCount,
                    hitMaxIterations: false,
                  });
                  return finish(
                    bgEndAction.visibleText || "Task completed without output.",
                    bgEndAction.status ?? "completed",
                    bgEndAction.visibleText || "Task completed without output.",
                  );
                } else {
                  // blocked
                  if (bgEndAction.status === "completed") {
                    return finish(bgEndAction.visibleText, "completed", bgEndAction.visibleText);
                  }
                  return bgFinishBlocked(bgEndAction.visibleText);
                }
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

              // Handle tool calls + autonomy tracking
              const verificationStateBefore = selfVerification.getState();
              const touchedFilesBefore = new Set(verificationStateBefore.touchedFiles);
              const { toolResults } = await executeAndTrackTools({
                chatId,
                responseText: response.text,
                toolCalls: response.toolCalls,
                session,
                executeToolCalls: (c, tc, opts) => this.executeToolCalls(c, tc, opts),
                executeOptions: {
                  mode: workerMode,
                  taskPrompt: prompt,
                  sessionMessages: session.messages,
                  onUsage: options.onUsage ?? this.onUsage,
                  identityKey,
                  strategy: executionStrategy,
                  agentState: bgAgentState,
                  touchedFiles: [...selfVerification.getState().touchedFiles],
                  workspaceLease: options.workspaceLease,
                  goalContext: options.goalContext,
                },
                trackingParams: {
                  taskPlanner,
                  selfVerification,
                  stradaConformance,
                  errorRecovery,
                  executionJournal,
                  agentPhase: bgAgentState.phase,
                  providerName: currentAssignment.providerName,
                  modelId: currentAssignment.modelId,
                  emitToolResult: (c, tc, tr) => this.emitToolResult(c, tc, tr),
                  workerCollector: workerCollector ?? undefined,
                  workspaceId: options.workspaceLease?.id,
                },
              });
              bgToolCallCount += response.toolCalls.length;
              for (const tc of response.toolCalls) {
                controlLoopTracker.markToolExecution(tc.name);
              }
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
                await runConsensusIfAvailable({
                  consensusManager: this.consensusManager,
                  confidenceEstimator: this.confidenceEstimator,
                  providerManager: this.providerManager,
                  taskClassifier: this.taskClassifier,
                  prompt,
                  responseText: response.text,
                  toolCalls: response.toolCalls,
                  currentAssignment,
                  currentProviderCapabilities: currentProvider.capabilities,
                  agentState: bgAgentState,
                  executionStrategy,
                  identityKey,
                  chatId,
                  logLabel: "background",
                  resolveConsensusReviewAssignment: (r, c, k) => this.resolveConsensusReviewAssignment(r, c, k),
                  recordExecutionTrace: (p) => this.recordExecutionTrace(p),
                  recordPhaseOutcome: (p) => this.recordPhaseOutcome(p),
                });
              }
              // ────────────────────────────────────────────────────────────────────

              // ─── PAOR: Record step results ──────────────────────────────────
              {
                const stepRecord = recordStepResultsAndCheckReflection({
                  agentState: bgAgentState,
                  toolCalls: response.toolCalls,
                  toolResults,
                  reflectInterval: BG_REFLECT_INTERVAL,
                });
                bgAgentState = stepRecord.agentState;
                if (stepRecord.shouldReflect && bgAgentState.phase === AgentPhase.REFLECTING) {
                  emitProgress(this.buildStructuredProgressSignal(
                    prompt,
                    progressTitle,
                    { kind: "analysis", message: "Reflecting on progress..." },
                    progressLanguage,
                  ));
                }
              }
              // ────────────────────────────────────────────────────────────────

              // Add tool results
              {
                const stateCtx = taskPlanner.getStateInjection();
                const providerHealthContext = iterationHealth.getTotalFailures() > 0
                  ? `${iterationHealth.getTotalFailures()} failure(s), ${(iterationHealth.getFailureRate() * 100).toFixed(0)}% failure rate, ${iterationHealth.getConsecutiveFailures()} consecutive`
                  : undefined;
                const contentBlocks = buildToolResultContentBlocks(stateCtx, bgAgentState, toolResults, { providerHealthContext });
                session.messages.push({
                  role: "user",
                  content: contentBlocks.length === 1 && stateCtx ? stateCtx : contentBlocks,
                });
              }

              // ─── Memory Re-retrieval (background path) ───────────────────────
              {
                const memRefresh = await refreshMemoryIfNeeded({
                  memoryRefresher: bgMemoryRefresher,
                  iteration: bgIteration,
                  queryContext: prompt,
                  chatId,
                  systemPrompt,
                  agentState: bgAgentState,
                });
                systemPrompt = memRefresh.systemPrompt;
                bgAgentState = memRefresh.agentState;
              }
              // ─────────────────────────────────────────────────────────────────
            }
            if (providerAbort) {
              return finish(
                getResilienceMessage("provider_abort", progressLanguage ?? "en"),
                "failed",
                providerAbortReason ?? "Too many consecutive provider failures.",
              );
            }
            if (maxTokensAbort) {
              return finish(
                getResilienceMessage("task_stuck", progressLanguage ?? "en"),
                "failed",
                "Background task aborted after repeated max_tokens truncations (runaway output).",
              );
            }
            const completedEpochCount = bgEpochCount;
            const continuedAfterBudget = this.canAutoContinueBackgroundEpoch(completedEpochCount);

            this.recordPhaseOutcome({
              chatId,
              identityKey,
              assignment: executionStrategy.executor,
              phase: toExecutionPhaseModel(bgAgentState.phase),
              status: continuedAfterBudget ? "continued" : "blocked",
              task: executionStrategy.task,
              reason: continuedAfterBudget
                ? "Background execution window reached its iteration budget and rolled into a new autonomous epoch."
                : "Background execution stopped after reaching the configured iteration budget.",
              telemetry: buildBgPhaseOutcomeTelemetry({
                state: bgAgentState,
              }),
            });
            this.sessionManager.persistExecutionMemory(identityKey, executionJournal);

            if (continuedAfterBudget) {
              taskPlanner.resetBudgetWindow();
              consecutiveMaxTokens = 0;
              // Only amnesty loop detection state if the epoch produced mutations.
              // Without mutations, the agent is stalling and the loop detector should
              // carry its accumulated state across the epoch boundary.
              if (controlLoopTracker.hadMutationsSinceLastReset()) {
                controlLoopTracker.markVerificationClean(bgIteration);
              } else {
                logger.warn("Epoch rolled without mutations — preserving loop detection state", {
                  chatId,
                  epoch: bgEpochCount,
                  readOnlyToolCalls: controlLoopTracker.getConsecutiveReadOnlyToolCalls(),
                });
              }
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
          // Phase 1b: clear the RunClock's timers + commit the final silent contribution.
          // Idempotent; cancels taskToken as benign `task-winddown`, never poisons health.
          bgRunClock?.dispose();
          this.sessionManager.persistExecutionMemory(identityKey, executionJournal);
          session.lastJournalSnapshot = executionJournal.snapshot();
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
        return finalVisibleResponse || "Task completed.";
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
    const session = this.sessionManager.getOrCreateSession(chatId);
    this.sessionManager.appendVisibleUserMessage(session, msg.text ?? "");

    if (this.pendingDepsPrompt.get(chatId)) {
      // User is responding to our install prompt
      if (text.includes("evet") || text.includes("yes") || text.includes("kur")) {
        await this.sessionManager.sendVisibleAssistantText(chatId, session, "Strada.Core kuruluyor...");
        const result = await installStradaDep(this.projectPath, "core", this.stradaConfig);
        if (result.kind === "ok") {
          this.stradaDeps = checkStradaDeps(this.projectPath, this.stradaConfig);
          this.rebuildBaseSystemPrompt();
          this.depsSetupComplete = true;
          await this.sessionManager.sendVisibleAssistantText(
            chatId,
            session,
            "Strada.Core kuruldu! Artık kullanabilirsiniz.",
          );

          if (!this.stradaDeps.modulesInstalled) {
            this.pendingModulesPrompt.set(chatId, true);
            await this.sessionManager.sendVisibleAssistantText(
              chatId,
              session,
              "Strada.Modules da kurulu değil. Kurmamı ister misiniz? (evet/hayır)",
            );
            return;
          }
        } else {
          await this.sessionManager.sendVisibleAssistantText(
            chatId,
            session,
            `Kurulum başarısız: ${result.error}`,
          );
          this.depsSetupComplete = true;
        }
      } else {
        this.depsSetupComplete = true;
        await this.sessionManager.sendVisibleAssistantText(
          chatId,
          session,
          "Anlaşıldı. Strada.Core olmadan sınırlı destek sunabilirim.",
        );
      }
      return;
    }

    // First message — send the install prompt
    this.pendingDepsPrompt.set(chatId, true);
    await this.sessionManager.sendVisibleAssistantText(
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
    const session = this.sessionManager.getOrCreateSession(chatId);
    this.sessionManager.appendVisibleUserMessage(session, msg.text ?? "");
    this.pendingModulesPrompt.delete(chatId);

    if (text.includes("evet") || text.includes("yes") || text.includes("kur")) {
      await this.sessionManager.sendVisibleAssistantText(chatId, session, "Strada.Modules kuruluyor...");
      const result = await installStradaDep(this.projectPath, "modules", this.stradaConfig);
      if (result.kind === "ok") {
        this.stradaDeps = checkStradaDeps(this.projectPath, this.stradaConfig);
        this.rebuildBaseSystemPrompt();
        await this.sessionManager.sendVisibleAssistantText(chatId, session, "Strada.Modules kuruldu!");
      } else {
        await this.sessionManager.sendVisibleAssistantText(
          chatId,
          session,
          `Modules kurulumu başarısız: ${result.error}`,
        );
      }
    } else {
      await this.sessionManager.sendVisibleAssistantText(
        chatId,
        session,
        "Anlaşıldı. Strada.Modules olmadan devam ediyoruz.",
      );
    }
  }

  private async processMessage(msg: IncomingMessage): Promise<void> {
    const logger = getLogger();
    const { chatId, text: rawText, userId: msgUserId, conversationId } = msg;
    const text = sanitizePromptInjection(rawText);
    const userId = msgUserId;
    const conversationScope = resolveConversationScope(chatId, conversationId);

    logger.info("Processing message", {
      chatId,
      userId,
      textLength: text.length,
      channel: msg.channelType,
    });

    const session = this.sessionManager.getOrCreateSession(chatId);

    // Goal tree resume detection (trigger on first message when interrupted trees exist)
    const pendingResumeTrees = this.sessionManager.takePendingResumeTrees(conversationScope, chatId);
    if (pendingResumeTrees.length > 0) {
      const resumePrompt = formatResumePrompt(pendingResumeTrees);
      const normalized = text.toLowerCase().trim();
      if (normalized === "resume" || normalized === "resume all") {
        this.sessionManager.appendVisibleUserMessage(session, text);
        await this.sessionManager.sendVisibleAssistantMarkdown(chatId, session, resumePrompt);
        for (const tree of pendingResumeTrees) {
          const prepared = prepareTreeForResume(tree);
          this.activeGoalTrees.set(tree.sessionId, prepared);
        }
        await this.sessionManager.sendVisibleAssistantMarkdown(
          chatId,
          session,
          "Resuming interrupted goal trees...",
        );
        return;
      } else if (normalized === "discard" || normalized === "discard all") {
        this.sessionManager.appendVisibleUserMessage(session, text);
        await this.sessionManager.sendVisibleAssistantMarkdown(chatId, session, resumePrompt);
        await this.sessionManager.sendVisibleAssistantMarkdown(
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
        this.sessionManager.appendVisibleUserMessage(session, text);
        await this.sessionManager.sendVisibleAssistantText(chatId, session, `${rateCheck.reason}${retryMsg}`);
        return;
      }
    }

    this.metrics?.recordMessage();
    this.metrics?.setActiveSessions(this.sessionManager.sessions.size);

    // Vault context enrichment is computed per-request inside runAgentLoop /
    // runBackgroundTask (see computeVaultContext) and injected via
    // buildSystemPromptWithContext, so it stays request-scoped rather than
    // living on a shared instance field that concurrent turns would race on.

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
      const lastTouch = this.sessionManager.persistTimeMap.get(`touch:${identityKey}`) ?? 0;
      if (Date.now() - lastTouch > 60_000) {
        this.userProfileStore.touchLastSeen(identityKey);
        this.sessionManager.persistTimeMap.set(`touch:${identityKey}`, Date.now());
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
    this.sessionManager.appendVisibleUserMessage(session, userContent);

    // Trim old messages to manage context window (provider-aware threshold)
    // Persist trimmed messages to memory before discarding
    const providerInfo = this.providerManager.getActiveInfo?.(identityKey);
    const trimmed = this.sessionManager.trimSession(
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
      await this.sessionManager.persistSessionToMemory(chatId, trimmed, /* force */ true);
    }

    // Monitor lifecycle: emit simple DAG so monitor workspace always shows something
    const conversationScopeForMonitor = resolveConversationScope(chatId, conversationId);
    this.monitorLifecycle?.requestStart(conversationScopeForMonitor, text);

    // Start typing indicator loop (only on channels that support rich messaging;
    // check the capability once here rather than on every interval tick)
    const richChannel = supportsRichMessaging(this.channel) ? this.channel : undefined;
    const typingInterval = richChannel
      ? setInterval(() => {
          richChannel.sendTypingIndicator(chatId as string).catch((err) =>
            getLogger().error("Failed to send typing indicator", {
              chatId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }, TYPING_INTERVAL_MS)
      : undefined;

    try {
      await this.runAgentLoop(chatId, session, msg.channelType, userId, conversationId, msg.attachments);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Unknown error";
      logger.error("Agent loop error", { chatId, error: errMsg });
      await this.sessionManager.sendVisibleAssistantText(chatId, session, classifyErrorMessage(error));
    } finally {
      this.monitorLifecycle?.requestEnd(resolveConversationScope(chatId, conversationId));
      if (typingInterval) {
        clearInterval(typingInterval);
      }
      // Clear typing indicator on completion/error
      if (supportsRichMessaging(this.channel)) {
        this.channel.sendTypingStop?.(chatId);
      }
      // Persist conversation summary (forced to ensure no messages are lost)
      const visibleMessages = this.sessionManager.getVisibleTranscript(session);
      await this.sessionManager.persistSessionToMemory(chatId, visibleMessages.slice(-10), /* force */ true);
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
    attachments?: Attachment[],
  ): Promise<void> {
    const logger = getLogger();
    const conversationScope = resolveConversationScope(chatId, conversationId);
    const lastUserContent = this.sessionManager.extractLastUserContent(session);
    const lastUserHasRichInput =
      (attachments?.length ?? 0) > 0
      || (Array.isArray(lastUserContent) && lastUserContent.some((block) => block.type !== "text"));
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
    // Per-request vault context enrichment (request-scoped, not a shared field).
    const vaultContext = await this.computeVaultContext(queryText);
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
      vaultContext,
      profile,
      preComputedEmbedding,
    });
    let systemPrompt = builtSystemPrompt;

    // ─── Autonomy layer ──────────────────────────────────────────────────
    const lastUserMessage = this.sessionManager.extractLastUserMessage(session);
    const {
      errorRecovery,
      taskPlanner,
      selfVerification,
      executionJournal,
      controlLoopTracker: interactiveControlLoopTracker,
      stradaConformance,
    } = createAutonomyBundle({
      prompt: lastUserMessage,
      iterationBudget: this.getInteractiveIterationLimit(),
      stradaDeps: this.stradaDeps,
      projectWorldSummary,
      projectWorldFingerprint,
      includeControlLoopTracker: true,
      previousJournalSnapshot: session.lastJournalSnapshot,
      conformanceEnabled: this.conformanceEnabled,
      conformanceFrameworkPathsOnly: this.conformanceFrameworkPathsOnly,
      loopFingerprintThreshold: this.loopFingerprintThreshold,
      loopFingerprintWindow: this.loopFingerprintWindow,
      loopDensityThreshold: this.loopDensityThreshold,
      loopDensityWindow: this.loopDensityWindow,
      loopMaxRecoveryEpisodes: this.loopMaxRecoveryEpisodes,
      loopStaleAnalysisThreshold: this.loopStaleAnalysisThreshold,
      loopHardCapReplan: this.loopHardCapReplan,
      loopHardCapBlock: this.loopHardCapBlock,
      progressAssessmentEnabled: this.progressAssessmentEnabled,
    });
    // Pass a live thunk so clarification/review stages see the per-request
    // prompt (updated by memory re-retrieval), not the static base prompt.
    const interventionDeps = this.buildInterventionDeps(() => systemPrompt);
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
    this.propagateInstinctIdsToChannel(chatId, matchedInstinctIds);

    // ─── Memory Re-retrieval: create refresher ───────────────────────
    const memoryRefresher = this.sessionManager.createMemoryRefresher(initialContentHashes);
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

    // Phase 1b: declared OUTSIDE the try so the outer finally can dispose it. Assigned
    // (flag-ON only) once the ledger is built; undefined keeps the byte-identical v1 path.
    let ifRunClock: RunClock | undefined;
    try {
      const supervisorDecision = await this.evaluateSupervisorAdmission({
        prompt: lastUserMessage,
        chatId,
        channelType,
        userId,
        conversationId,
        userContent: lastUserContent,
        attachments,
        taskRunId: this.getTaskExecutionContext()?.taskRunId,
        onUsage: this.onUsage,
        onGoalDecomposed: (goalTree) => {
          this.monitorLifecycle?.goalDecomposed(conversationScope, goalTree);
          try {
            this.goalStorage?.upsertTree(goalTree, "executing");
          } catch {
            // Goal persistence is best-effort; DAG display still works via WS events
          }
        },
        reportUpdate: async (markdown) => {
          await this.sessionManager.sendVisibleAssistantMarkdown(chatId, session, markdown);
        },
      });
      if (supervisorDecision.path === "supervisor") {
        const supervisorResult = supervisorDecision.result;
        await this.sessionManager.sendVisibleAssistantMarkdown(chatId, session, supervisorResult.output);
        this.recordMetricEnd(metricId, {
          agentPhase: AgentPhase.COMPLETE,
          iterations: agentState.iteration,
          toolCallCount: agentState.stepResults.length,
          hitMaxIterations: false,
        });
        return;
      }

      let consecutiveMaxTokens = 0;
      let consecutiveProviderFailures = 0;
      let cumulativeInputTokens = 0; // observability only
      let cumulativeOutputTokens = 0; // the budget-gating metric (audit #3)
      const iterationHealth = new IterationHealthTracker();
      // Agent Core v2 — Phase 1a (flag-gated). Wraps the SAME iterationHealth so OFF-path
      // downstream reads are unaffected; pauseRetryBudget:0 (rule 6 dead without run-clock).
      // Phase 1b: when run-clock is ON, open ONE RunClock per interactive run and lift the
      // pause→retry budget from the resolved policy so rule 6 (call-stall) is live.
      let ifPauseRetryBudget = 0;
      if (this.agentCoreFlagSet?.runClock === true) {
        const { policy, warnings } = resolveRunBudgetPolicy("interactive", this.buildPolicySeed());
        for (const w of warnings) logger.warn(`[RunBudgetPolicy:interactive] ${w}`);
        ifRunClock = openRunClock(this.agentCoreClock, policy);
        ifPauseRetryBudget = policy.pauseRetryBudget;
      }
      const ifFailureLedgerAdapter =
        this.agentCoreFlagSet?.failureLedger === true
          ? new IterationHealthCoreAdapter(iterationHealth, "")
          : undefined;
      const ifFailureLedger = ifFailureLedgerAdapter
        ? createFailureLedger(ifFailureLedgerAdapter, { pauseRetryBudget: ifPauseRetryBudget })
        : undefined;
      for (let iteration = 0; iteration < interactiveIterationLimit; iteration++) {
        // Re-read every iteration so a mid-task budget raise (via /token
        // or the portal budget editor) actually takes effect without
        // requiring the user to hit the checkpoint limit and /retry.
        const tokenBudget = this.getLiveInteractiveTokenBudget();
        const iterationStartMs = Date.now();
        const {
          executionStrategy: iterStrategy,
          activePrompt,
          currentAssignment,
          currentProvider,
          currentToolDefinitions,
          currentToolNames,
        } = this.prepareIteration({
          prompt: lastUserMessage,
          identityKey,
          agentState,
          executionJournal,
          systemPrompt,
          fallbackProvider,
          toolTurnAffinity,
          projectWorldFingerprint,
          enableGoalDetection: !!this.taskManager,
          iterationHealth,
        });
        executionStrategy = iterStrategy;

        this.maybeCompactSession(session, currentAssignment.providerName, currentAssignment.modelId, activePrompt);

        // Task-aware fallback: use ProviderRouter-ranked order when available
        const resilientProvider = this.buildTaskAwareProvider(
          currentAssignment.providerName,
          executionStrategy.task,
          agentState.phase,
          {
            modelId: currentAssignment.modelId,
            identityKey,
            usesMultipleProviders: executionStrategy.usesMultipleProviders,
          },
        ) ?? currentProvider;
        // Gate silent streaming purely on provider capability — it uses
        // chatStream/chat internally and renders the final reply via sendMarkdown,
        // so it does NOT require channel.startStreamingMessage. Requiring it forced
        // channels without that hook (IRC/Matrix/Teams) onto the un-timed
        // non-streaming .chat() path. Mirror the background gate (audit #8).
        const canStream =
          this.streamingEnabled &&
          "chatStream" in resilientProvider &&
          typeof resilientProvider.chatStream === "function";

        logger.debug("Calling LLM", {
          chatId,
          canStream,
          provider: currentAssignment.providerName,
          iteration,
        });
        let response;
        // Phase 1b: capture the non-streaming sibling's CallScope so the catch can read its
        // typed token.reason for the verdict's `callStalled`. Undefined on the streaming path
        // and on flag-OFF (streaming sites rely on the silence accumulator — P-1b-4).
        let ifChatScope: CallScope | undefined;
        try {
          if (canStream) {
            // Silent streaming: use streaming internally (SSE parsing, timeout, reasoning_content)
            // but don't create visible messages. User sees only the final response via sendMarkdown.
            response = await this.silentStream(
              chatId,
              activePrompt,
              session,
              resilientProvider,
              currentToolDefinitions,
              undefined, // externalSignal — runAgentLoop has no user-cancel signal in scope
              undefined, // onLiveness — interactive has no task-inactivity heartbeat
              ifRunClock, // Phase 1b
            );
          } else if (ifRunClock) {
            // Phase 1b ON: scoped per-call deadline, NO externalSignal (a stall here IS a
            // genuine provider failure that must poison health — audit #7 — so the call
            // token's provider-stall is the only signal).
            ifChatScope = ifRunClock.enterCall({
              firstResponseMs: this.streamInitialTimeoutMs,
              stallMs: this.streamInitialTimeoutMs,
              hardMs: this.streamInitialTimeoutMs,
            });
            try {
              response = await resilientProvider.chat(
                this.withCompactionSummary(activePrompt, session),
                session.messages,
                currentToolDefinitions,
                { signal: ifChatScope.token.signal },
              );
            } finally {
              ifChatScope.leave();
            }
          } else {
            // Interactive non-streaming sibling of silentStream: even though the user
            // is actively connected, the underlying fetch needs a deadline or a stalled
            // provider hangs this loop forever. Thread a per-attempt timeout signal so a
            // stall throws → routed through the catch/evaluateProviderFailure/backoff
            // below. (runAgentLoop has no user-cancel signal in scope, unlike the
            // background path; the timeout is the bound that was missing — audit #7.)
            // No externalSignal: here the only signal is the deadline, and a timeout is
            // a genuine provider stall that SHOULD count as a failure / poison health —
            // so it must not be tagged as a benign control-plane cancel (audit #7).
            const interactiveSignal = AbortSignal.timeout(this.streamInitialTimeoutMs);
            response = await resilientProvider.chat(
              this.withCompactionSummary(activePrompt, session),
              session.messages,
              currentToolDefinitions,
              { signal: interactiveSignal },
            );
          }
        } catch (providerError) {
          const errMsg = providerError instanceof Error ? providerError.message : String(providerError);
          if (ifFailureLedger && ifFailureLedgerAdapter) {
            // ── Agent Core v2 — Phase 1a/1b LEDGER PATH (interactive THROW). 1b: when run-clock
            //    is ON, the non-streaming sibling's typed token.reason feeds rule 6/rule 2. ──
            const interactiveLang = (profile?.language ?? this.defaultLanguage) as string;
            const verdict = ifRunClock
              ? this.recordPhase1bFailureAndVerdict(
                  ifFailureLedger,
                  ifFailureLedgerAdapter,
                  currentAssignment.providerName,
                  ifRunClock,
                  ifChatScope?.token.reason ?? null,
                )
              : this.recordPhase1aFailureAndVerdict(
              ifFailureLedger,
              ifFailureLedgerAdapter,
              currentAssignment.providerName,
            );
            logger.warn("Provider call failed in interactive loop (ledger)", {
              chatId, iteration,
              provider: currentAssignment.providerName,
              error: errMsg,
              consecutive: ifFailureLedger.health.consecutive,
              verdict: verdict.decision,
            });
            const handled = await this.applyInteractiveVerdict(verdict, {
              iterationHealth,
              chatId,
              session,
              providerName: currentAssignment.providerName,
              language: interactiveLang,
            });
            if (handled.control === "break") break;
            continue;
          }
          consecutiveProviderFailures++;
          logger.warn("Provider call failed in interactive loop", {
            chatId, iteration,
            provider: currentAssignment.providerName,
            error: errMsg, consecutiveProviderFailures,
          });
          const failureEval = evaluateProviderFailure(
            consecutiveProviderFailures, MAX_CONSECUTIVE_PROVIDER_FAILURES,
            currentAssignment.providerName, errMsg,
          );
          // Always notify the user of provider errors in interactive mode
          const interactiveLang = (profile?.language ?? this.defaultLanguage) as string;
          if (failureEval.action === "abort") {
            logger.error("Interactive loop aborting: too many consecutive provider failures", {
              consecutiveProviderFailures, chatId, provider: currentAssignment.providerName,
            });
            await this.sessionManager.sendVisibleAssistantMarkdown(
              chatId, session,
              getResilienceMessage("provider_abort", interactiveLang),
            );
            break;
          }
          // Send a user-visible retry notice so the user knows something went wrong
          await this.sessionManager.sendVisibleAssistantMarkdown(
            chatId, session,
            getResilienceMessage("provider_slow", interactiveLang),
          );
          if (failureEval.guidanceMessage) {
            session.messages.push({
              role: "user",
              content: failureEval.guidanceMessage,
            } as ConversationMessage);
          }
          continue;
        }
        // Ledger path defers success accounting to the EMPTY gate below (see bg loop).
        if (!ifFailureLedger) {
          consecutiveProviderFailures = 0;
        }
        this.recordExecutionTrace({
          chatId,
          identityKey,
          assignment: currentAssignment,
          phase: toExecutionPhaseModel(agentState.phase),
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

        // Token budget enforcement. Gate on cumulative OUTPUT tokens ("fresh work"),
        // NOT cumulative input — cumulative input re-counts the growing context each
        // iteration and kills a stable-working-set task for re-sending (audit #3).
        // Cumulative input is retained for observability only.
        cumulativeInputTokens += response.usage?.inputTokens ?? 0;
        cumulativeOutputTokens += response.usage?.outputTokens ?? 0;

        // Per-iteration observability log
        logger.debug("Iteration complete (interactive)", {
          iteration: iteration + 1, chatId,
          tokens: response.usage?.totalTokens ?? 0,
          inputTokens: response.usage?.inputTokens ?? 0,
          toolCalls: response.toolCalls?.length ?? 0,
          cumulativeInputTokens,
          cumulativeOutputTokens,
          durationMs: Date.now() - iterationStartMs,
        });
        if (tokenBudget !== -1 && cumulativeOutputTokens > tokenBudget) {
          logger.warn("Interactive token budget exceeded — aborting loop", {
            chatId,
            cumulativeOutputTokens,
            cumulativeInputTokens,
            tokenBudget,
            iteration,
            provider: currentAssignment.providerName,
          });
          await this.saveBudgetExceededCheckpoint({
            taskId: conversationId ?? `${chatId}-fg-${Date.now()}`,
            chatId,
            lastUserMessage,
            used: cumulativeOutputTokens,
            budget: tokenBudget,
          });
          await this.sessionManager.sendVisibleAssistantMarkdown(
            chatId, session,
            getResilienceMessage("token_budget_exceeded", (profile?.language ?? this.defaultLanguage) as string, {
              used: Math.round(cumulativeOutputTokens / 1000),
              budget: Math.round(tokenBudget / 1000),
            }),
          );
          break;
        }

        // Intelligent provider resilience: detect synthetic empty responses and adapt
        const interactiveLang = (profile?.language ?? this.defaultLanguage) as string;
        if (ifFailureLedger && ifFailureLedgerAdapter) {
          // ── Agent Core v2 — Phase 1a/1b LEDGER PATH (interactive EMPTY). 1b: an EMPTY
          //    response is not a call-stall (null failedCallReason); task-scope signals flow. ──
          if (isEmptyProviderResponse(response)) {
            const verdict = ifRunClock
              ? this.recordPhase1bFailureAndVerdict(
                  ifFailureLedger,
                  ifFailureLedgerAdapter,
                  currentAssignment.providerName,
                  ifRunClock,
                  null,
                )
              : this.recordPhase1aFailureAndVerdict(
              ifFailureLedger,
              ifFailureLedgerAdapter,
              currentAssignment.providerName,
            );
            const handled = await this.applyInteractiveVerdict(verdict, {
              iterationHealth,
              chatId,
              session,
              providerName: currentAssignment.providerName,
              language: interactiveLang,
            });
            if (handled.control === "break") break;
            continue;
          }
          ifFailureLedger.recordSuccess(currentAssignment.providerName, "real");
        } else {
          const cbResult = checkProviderFailureCircuitBreaker(response, iterationHealth.getConsecutiveFailures());
          if (cbResult.action !== "ok") {
            const failureAction = iterationHealth.recordFailure(currentAssignment.providerName);
            const statusLevel = iterationHealth.getStatusLevel();

            // Inject rich health context so the agent can reason about it when provider recovers
            session.messages.push({
              role: "user",
              content: iterationHealth.buildSessionHealthContext(currentAssignment.providerName, failureAction),
            } as ConversationMessage);

            // Progressive disclosure — notify user based on severity
            if (statusLevel === "degraded") {
              await this.sessionManager.sendVisibleAssistantMarkdown(
                chatId, session,
                getResilienceMessage("provider_slow", interactiveLang),
              );
            } else if (statusLevel === "critical") {
              await this.sessionManager.sendVisibleAssistantMarkdown(
                chatId, session,
                getResilienceMessage("provider_failing", interactiveLang, {
                  seconds: Math.round((failureAction.kind !== "abort" ? failureAction.backoffMs : 0) / 1000),
                  attempt: iterationHealth.getConsecutiveFailures(),
                  max: 5,
                }),
              );
            }

            // Ask user — provider has been unreliable beyond retry threshold
            if (failureAction.kind === "ask_user") {
              await this.sessionManager.sendVisibleAssistantMarkdown(
                chatId, session,
                getResilienceMessage("provider_ask_user", interactiveLang),
              );
            }

            // Abort if failure rate is critical
            if (failureAction.kind === "abort") {
              logger.error("Provider failure rate critical — aborting interactive loop", {
                chatId,
                provider: currentAssignment.providerName,
                failureRate: iterationHealth.getFailureRate(),
                consecutiveFailures: iterationHealth.getConsecutiveFailures(),
                totalFailures: iterationHealth.getTotalFailures(),
                taskDurationMs: iterationHealth.getTaskDurationMs(),
              });
              await this.sessionManager.sendVisibleAssistantMarkdown(
                chatId, session,
                getResilienceMessage("provider_abort", interactiveLang),
              );
              break;
            }

            // Exponential backoff before retry
            if (failureAction.backoffMs > 0) {
              logger.info("Provider failure backoff", {
                chatId,
                backoffMs: failureAction.backoffMs,
                provider: currentAssignment.providerName,
                consecutiveFailures: iterationHealth.getConsecutiveFailures(),
              });
              await new Promise(resolve => setTimeout(resolve, failureAction.backoffMs));
            }

            continue;
          } else {
            iterationHealth.recordSuccess();
          }
        }

        // max_tokens: model output was truncated — push and continue so the model finishes.
        if (response.stopReason === "max_tokens" && response.toolCalls.length === 0) {
          consecutiveMaxTokens++;
          if (consecutiveMaxTokens >= 3) {
            logger.error("max_tokens on 3 consecutive calls — aborting to prevent runaway accumulation", { chatId });
            break;
          }
          logger.warn("Interactive LLM response truncated by max_tokens — auto-continuing", {
            chatId,
            iteration: agentState.iteration,
            textLength: response.text?.length ?? 0,
          });
          pushContinuationMessages(
            { responseText: response.text, session },
            MAX_TOKENS_CONTINUATION_GATE,
          );
          continue;
        }
        consecutiveMaxTokens = 0;

        // ─── PAOR: Handle REFLECTING phase response ─────────────────────
        if (agentState.phase === AgentPhase.REFLECTING) {
          const { decision, wasOverride } = await processReflectionPreamble({
            agentState,
            executionJournal,
            responseText: response.text,
            providerName: currentAssignment.providerName,
            modelId: currentAssignment.modelId,
          });
          if (wasOverride) {
            agentState = { ...agentState, reflectionOverrideCount: agentState.reflectionOverrideCount + 1 };
          }

          // Pending checks (tightly coupled to loop return)
          if (response.toolCalls.length === 0) {
            const pending = checkPendingBlocks({
              getPendingPlanReviewVisibleText: (c) => this.sessionManager.getPendingPlanReviewVisibleText(c),
              getPendingSelfManagedWriteRejectionVisibleText: (s, d) => this.sessionManager.getPendingSelfManagedWriteRejectionVisibleText(s as Session, d),
              chatId, session, responseText: response.text,
            });
            if (pending.blocked) {
              await this.sessionManager.sendVisibleAssistantMarkdown(chatId, session, pending.text);
              this.recordMetricEnd(metricId, {
                agentPhase: AgentPhase.COMPLETE,
                iterations: agentState.iteration,
                toolCallCount: agentState.stepResults.length,
                hitMaxIterations: false,
              });
              return;
            }
          }

          const interactiveReflectionCtx: InteractiveReflectionContext = {
            chatId,
            identityKey,
            prompt: lastUserMessage,
            responseText: response.text,
            responseUsage: response.usage,
            toolCallCount: response.toolCalls.length,
            executionStrategy,
            executionJournal,
            selfVerification,
            stradaConformance,
            taskStartedAtMs,
            currentToolNames,
            currentAssignment,
            interventionDeps,
            session,
            usageHandler: this.onUsage,
            recordPhaseOutcome: (p) => this.recordPhaseOutcome(p),
            buildPhaseOutcomeTelemetry: buildInteractivePhaseOutcomeTelemetry,
            systemPrompt,
            progressAssessmentEnabled: this.progressAssessmentEnabled,
            controlLoopTracker: interactiveControlLoopTracker ?? undefined,
          };

          let interactiveAction: ReflectionLoopAction;
          if (decision === "DONE" || decision === "DONE_WITH_SUGGESTIONS") {
            interactiveAction = await handleInteractiveReflectionDone(agentState, interactiveReflectionCtx);
          } else if (decision === "REPLAN") {
            interactiveAction = handleInteractiveReflectionReplan(agentState, interactiveReflectionCtx);
            if (interactiveAction.flow === "continue") {
              let replanState = interactiveAction.newState;

              await this.runReactiveGoalDecomposition({
                conversationScope, chatId, session, responseText: response.text ?? "",
              });

              replanState = transitionPhase(replanState, AgentPhase.REPLANNING);
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
                  state: replanState,
                  usage: response.usage,
                  failureReason: response.text,
                }),
              });
              session.messages.push({ role: "user", content: "Please create a new plan." });
              agentState = replanState;
              continue;
            }
          } else {
            interactiveAction = await handleInteractiveReflectionContinue(
              agentState,
              interactiveReflectionCtx,
              response,
            );
          }

          // Handle action results
          if (interactiveAction.flow === "continue") {
            agentState = interactiveAction.newState;
            if (decision !== "DONE" && decision !== "DONE_WITH_SUGGESTIONS" && response.toolCalls.length > 0) {
              // Fall through to tool execution
            } else {
              continue;
            }
          } else if (interactiveAction.flow === "done") {
            if (interactiveAction.visibleText) {
              await this.sessionManager.sendVisibleAssistantMarkdown(chatId, session, interactiveAction.visibleText);
            }
            this.recordMetricEnd(metricId, {
              agentPhase: AgentPhase.COMPLETE,
              iterations: agentState.iteration,
              toolCallCount: agentState.stepResults.length,
              hitMaxIterations: false,
            });
            return;
          } else {
            // blocked — sanitize diagnostic messages before showing to user
            const rawBlocked = interactiveAction.visibleText ?? "";
            const isDiag1 = DIAGNOSTIC_BLOCKED_RE.test(rawBlocked);
            let safeBlocked: string;
            if (isDiag1) {
              logger.warn("Loop detection blocked task", { chatId, diagnostic: rawBlocked.slice(0, 500) });
              agentState = { ...agentState, loopDetectionBlocked: true };
              const stuckMsg1 = getResilienceMessage("task_stuck", this.defaultLanguage);
              const actionMatch1 = /Suggested action:\s*(.+?)(?:\nFiles t|$)/is.exec(rawBlocked);
              safeBlocked = actionMatch1?.[1]?.trim()
                ? `${stuckMsg1}\n\n**${actionMatch1[1].trim()}**`
                : stuckMsg1;
            } else {
              safeBlocked = rawBlocked;
            }
            if (safeBlocked) {
              await this.sessionManager.sendVisibleAssistantMarkdown(chatId, session, safeBlocked);
            }
            this.recordMetricEnd(metricId, {
              agentPhase: AgentPhase.COMPLETE,
              iterations: agentState.iteration,
              toolCallCount: agentState.stepResults.length,
              hitMaxIterations: false,
            });
            return;
          }
        }
        // ────────────────────────────────────────────────────────────────

        // ─── Goal Detection: check for goal block in Plan phase response ───
        // Must run BEFORE end_turn early return since goal detection responses
        // may have no tool calls but should short-circuit to background execution.
        if (agentState.phase === AgentPhase.PLANNING && this.taskManager) {
          const goalBlock = parseGoalBlock(response.text ?? "");
          if (goalBlock && goalBlock.isGoal) {
            const goalTree = lastUserHasRichInput
              ? undefined
              : buildGoalTreeFromBlock(
                goalBlock,
                conversationScope,
                lastUserMessage,
                response.text ?? undefined,
              );

            // Send acknowledgment
            const nodeCount = goalTree ? goalTree.nodes.size - 1 : goalBlock.nodes.length;
            const ackMsg =
              `Working on: ${lastUserMessage.slice(0, 80)}` +
              ` (${nodeCount} step${nodeCount !== 1 ? "s" : ""}, ~${goalBlock.estimatedMinutes} min). I'll update you as I go.`;
            await this.sessionManager.sendVisibleAssistantText(chatId, session, ackMsg);

            // Submit as a background task. The background executor now decides
            // whether the request can execute a trusted goal tree directly or
            // should stay on the shared worker path for rich input.
            this.taskManager.submit(chatId, channelType ?? "cli", lastUserMessage, {
              ...(goalTree ? { goalTree } : {}),
              ...(lastUserHasRichInput ? { forceSharedPlanning: true } : {}),
              ...(lastUserContent ? { userContent: lastUserContent } : {}),
              attachments: attachments?.length ? attachments : undefined,
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
            toolNames: currentToolNames,
          })
        ) {
          // Autonomous mode: auto-execute plans, don't present for review
          if (this.dmPolicy?.isAutonomousActive(chatId, userId)) {
            agentState = handlePlanPhaseTransition({
              agentState,
              executionJournal,
              responseText: response.text,
              providerName: currentAssignment.providerName,
              modelId: currentAssignment.modelId,
              autoTransition: true,
            });
            session.messages.push(
              { role: "assistant", content: response.text },
              { role: "user", content: "Plan recorded. Now execute it step by step using the available tools. Start with the first actionable step." },
            );
            continue;
          }

          agentState = handlePlanPhaseTransition({
            agentState,
            executionJournal,
            responseText: response.text,
            providerName: currentAssignment.providerName,
            modelId: currentAssignment.modelId,
            autoTransition: false,
          });

          if (agentState.phase === AgentPhase.PLANNING) {
            agentState = await this.runProactiveGoalDecomposition({
              conversationScope, userMessage: lastUserMessage, chatId, session, agentState,
            });
          }

          this.interactionPolicy.requirePlanReview(
            chatId,
            "user explicitly asked to review a plan first",
            applyVisibleResponseContract(
              lastUserMessage,
              this.stripInternalDecisionMarkers(response.text) || response.text || "",
            ),
          );
          const planText = this.sessionManager.getPendingPlanReviewVisibleText(chatId)!;
          await this.sessionManager.sendVisibleAssistantMarkdown(chatId, session, planText);
          this.recordMetricEnd(metricId, {
            agentPhase: AgentPhase.COMPLETE,
            iterations: agentState.iteration,
            toolCallCount: agentState.stepResults.length,
            hitMaxIterations: false,
          });
          return;
        }

        // Interactive loop: autonomous mode auto-executes PLANNING text-only responses
        if (
          (agentState.phase === AgentPhase.PLANNING ||
            agentState.phase === AgentPhase.REPLANNING) &&
          response.toolCalls.length === 0 &&
          draftLooksLikeInternalPlanArtifact(response.text ?? "", { toolNames: currentToolNames }) &&
          this.dmPolicy?.isAutonomousActive(chatId, userId)
        ) {
          agentState = handlePlanPhaseTransition({
            agentState,
            executionJournal,
            responseText: response.text,
            providerName: currentAssignment.providerName,
            modelId: currentAssignment.modelId,
            autoTransition: true,
          });
          session.messages.push(
            { role: "assistant", content: response.text },
            { role: "user", content: "Plan recorded. Now execute it step by step using the available tools. Start with the first actionable step." },
          );
          continue;
        }

        // If no tool calls, send the final text response (extracted to orchestrator-end-turn-handler.ts)
        // (streaming already sent it, so skip for streamed end_turn)
        // If tool calls are present we must execute them even when the
        // provider signals end_turn (some providers emit both).
        if (response.toolCalls.length === 0) {
          const pending = checkPendingBlocks({
            getPendingPlanReviewVisibleText: (c) => this.sessionManager.getPendingPlanReviewVisibleText(c),
            getPendingSelfManagedWriteRejectionVisibleText: (s, d) => this.sessionManager.getPendingSelfManagedWriteRejectionVisibleText(s as Session, d),
            chatId, session, responseText: response.text,
          });
          if (pending.blocked) {
            await this.sessionManager.sendVisibleAssistantMarkdown(chatId, session, pending.text);
            this.recordMetricEnd(metricId, {
              agentPhase: AgentPhase.COMPLETE,
              iterations: agentState.iteration,
              toolCallCount: agentState.stepResults.length,
              hitMaxIterations: false,
            });
            return;
          }

          const interactiveEndTurnCtx: InteractiveEndTurnContext = {
            chatId,
            identityKey,
            prompt: lastUserMessage,
            responseText: response.text,
            responseUsage: response.usage,
            executionStrategy,
            executionJournal,
            selfVerification,
            stradaConformance,
            taskStartedAtMs,
            currentToolNames,
            currentAssignment,
            interventionDeps,
            session,
            usageHandler: this.onUsage,
            recordPhaseOutcome: (p) => this.recordPhaseOutcome(p),
            buildPhaseOutcomeTelemetry: buildInteractivePhaseOutcomeTelemetry,
            systemPrompt,
            defaultLanguage: this.defaultLanguage,
            profileLanguage: profile?.language,
            progressAssessmentEnabled: this.progressAssessmentEnabled,
            controlLoopTracker: interactiveControlLoopTracker ?? undefined,
            runTextConsensusIfCritical: async (p) => {
              if (!this.consensusManager || !this.confidenceEstimator) return;
              const textTaskClass = this.taskClassifier.classify(p.prompt);
              if (textTaskClass.criticality !== "critical") return;
              const textConfidence = this.confidenceEstimator.estimate({
                task: textTaskClass,
                providerName: p.providerName,
                providerCapabilities: currentProvider.capabilities,
                agentState: p.agentState,
                responseLength: p.responseText.length,
              });
              await runConsensusVerification({
                consensusManager: this.consensusManager,
                availableProviderCount: this.providerManager.listAvailable().length,
                taskClass: textTaskClass,
                confidence: textConfidence,
                originalOutput: { text: p.responseText },
                originalProviderName: p.providerName,
                prompt: p.prompt,
                reviewAssignment: this.resolveConsensusReviewAssignment(executionStrategy.reviewer, currentAssignment, identityKey),
                chatId,
                identityKey,
                logLabel: "text-only, critical",
                recordExecutionTrace: (rp) => this.recordExecutionTrace(rp as Parameters<typeof this.recordExecutionTrace>[0]),
                recordPhaseOutcome: (rp) => this.recordPhaseOutcome(rp as Parameters<typeof this.recordPhaseOutcome>[0]),
              });
            },
          };
          const interactiveEndAction: EndTurnLoopAction = await handleInteractiveEndTurn(agentState, interactiveEndTurnCtx);

          if (interactiveEndAction.flow === "continue") {
            agentState = interactiveEndAction.newState;
            continue;
          } else if (interactiveEndAction.flow === "done") {
            if (interactiveEndAction.visibleText) {
              await this.sessionManager.sendVisibleAssistantMarkdown(chatId, session, interactiveEndAction.visibleText);
            }
            this.recordMetricEnd(metricId, {
              agentPhase: AgentPhase.COMPLETE,
              iterations: agentState.iteration,
              toolCallCount: agentState.stepResults.length,
              hitMaxIterations: false,
            });
            return;
          } else {
            // blocked — sanitize diagnostic messages before showing to user
            const rawEnd = interactiveEndAction.visibleText ?? "";
            const isDiag2 = DIAGNOSTIC_BLOCKED_RE.test(rawEnd);
            let safeEnd: string;
            if (isDiag2) {
              logger.warn("Loop detection blocked task", { chatId, diagnostic: rawEnd.slice(0, 500) });
              agentState = { ...agentState, loopDetectionBlocked: true };
              const stuckMsg2 = getResilienceMessage("task_stuck", this.defaultLanguage);
              const actionMatch2 = /Suggested action:\s*(.+?)(?:\nFiles t|$)/is.exec(rawEnd);
              safeEnd = actionMatch2?.[1]?.trim()
                ? `${stuckMsg2}\n\n**${actionMatch2[1].trim()}**`
                : stuckMsg2;
            } else {
              safeEnd = rawEnd;
            }
            if (safeEnd) {
              await this.sessionManager.sendVisibleAssistantMarkdown(chatId, session, safeEnd);
            }
            this.recordMetricEnd(metricId, {
              agentPhase: AgentPhase.COMPLETE,
              iterations: agentState.iteration,
              toolCallCount: agentState.stepResults.length,
              hitMaxIterations: false,
            });
            return;
          }
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

          agentState = await this.runProactiveGoalDecomposition({
            conversationScope, userMessage: lastUserMessage, chatId, session, agentState,
          });

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

        // Handle tool calls + autonomy tracking
        // Intermediate text is stored in session for LLM context but NOT sent to user.
        // User only sees the final response (end_turn without tool calls).
        const { toolResults } = await executeAndTrackTools({
          chatId,
          responseText: response.text,
          toolCalls: response.toolCalls,
          session,
          executeToolCalls: (c, tc, opts) => this.executeToolCalls(c, tc, opts),
          executeOptions: {
            mode: "interactive",
            userId,
            taskPrompt: lastUserMessage,
            sessionMessages: session.messages,
            onUsage: this.onUsage,
            identityKey,
            strategy: executionStrategy,
            agentState,
            touchedFiles: [...selfVerification.getState().touchedFiles],
          },
          trackingParams: {
            taskPlanner,
            selfVerification,
            stradaConformance,
            errorRecovery,
            executionJournal,
            agentPhase: agentState.phase,
            providerName: currentAssignment.providerName,
            modelId: currentAssignment.modelId,
            emitToolResult: (c, tc, tr) => this.emitToolResult(c, tc, tr),
          },
        });

        // Track tool execution in the interactive control loop tracker
        if (interactiveControlLoopTracker) {
          for (const tc of response.toolCalls) {
            interactiveControlLoopTracker.markToolExecution(tc.name);
          }
        }

        // Inject state-aware context (stall detection, budget warnings)
        const stateCtx = taskPlanner.getStateInjection();

        // ─── Consensus: verify output with second provider if confidence is low ───
        if (this.consensusManager && this.confidenceEstimator && this.providerRouter) {
          await runConsensusIfAvailable({
            consensusManager: this.consensusManager,
            confidenceEstimator: this.confidenceEstimator,
            providerManager: this.providerManager,
            taskClassifier: this.taskClassifier,
            prompt: lastUserMessage,
            responseText: response.text,
            toolCalls: response.toolCalls,
            currentAssignment,
            currentProviderCapabilities: currentProvider.capabilities,
            agentState,
            executionStrategy,
            identityKey,
            chatId,
            resolveConsensusReviewAssignment: (r, c, k) => this.resolveConsensusReviewAssignment(r, c, k),
            recordExecutionTrace: (p) => this.recordExecutionTrace(p),
            recordPhaseOutcome: (p) => this.recordPhaseOutcome(p),
          });
        }
        // ────────────────────────────────────────────────────────────────────

        // ─── PAOR: Record step results ──────────────────────────────────
        {
          const stepRecord = recordStepResultsAndCheckReflection({
            agentState,
            toolCalls: response.toolCalls,
            toolResults,
            reflectInterval: REFLECT_INTERVAL,
          });
          agentState = stepRecord.agentState;
        }
        // ────────────────────────────────────────────────────────────────

        // Add tool results as a user message
        {
          const providerHealthContext = iterationHealth.getTotalFailures() > 0
            ? `${iterationHealth.getTotalFailures()} failure(s), ${(iterationHealth.getFailureRate() * 100).toFixed(0)}% failure rate, ${iterationHealth.getConsecutiveFailures()} consecutive`
            : undefined;
          const contentBlocks = buildToolResultContentBlocks(stateCtx, agentState, toolResults, { providerHealthContext });
          session.messages.push({
            role: "user",
            content: contentBlocks.length === 1 && stateCtx ? stateCtx : contentBlocks,
          });
        }

        // ─── Memory Re-retrieval ─────────────────────────────────────────
        {
          const recentContext = this.sessionManager.extractLastUserMessage(session);
          const memRefresh = await refreshMemoryIfNeeded({
            memoryRefresher,
            iteration,
            queryContext: recentContext,
            chatId,
            systemPrompt,
            agentState,
            onNewInstinctIds: (ids) => {
              // Deduplicate and cap instinct IDs to prevent unbounded growth
              const idSet = new Set(matchedInstinctIds);
              for (const id of ids) idSet.add(id);
              matchedInstinctIds = [...idSet].slice(0, 200);
              this.currentSessionInstinctIds.set(chatId, matchedInstinctIds);
              this.propagateInstinctIdsToChannel(chatId, matchedInstinctIds);
            },
          });
          systemPrompt = memRefresh.systemPrompt;
          agentState = memRefresh.agentState;
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

      await this.sessionManager.sendVisibleAssistantText(
        chatId,
        session,
        "I've reached the maximum number of steps for this request. " +
          "Please send a follow-up message to continue.",
      );
    } catch (error) {
      agentState = transitionPhase(agentState, AgentPhase.FAILED);
      throw error;
    } finally {
      // Phase 1b: clear the RunClock's timers + commit the final silent contribution.
      // Idempotent; cancels taskToken as benign `task-winddown`, never poisons health.
      ifRunClock?.dispose();
      this.sessionManager.persistExecutionMemory(identityKey, executionJournal);
      session.lastJournalSnapshot = executionJournal.snapshot();
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
      this.propagateInstinctIdsToChannel(chatId, []);
      // Note: activeGoalTrees intentionally NOT cleaned up here -- trees persist across messages
      // in a session for reactive decomposition. Cleaned up in cleanupSessions and eviction.
    }
  }

  /** Propagate instinct IDs to the channel adapter for feedback attribution. */
  private propagateInstinctIdsToChannel(chatId: string, instinctIds: string[]): void {
    const ch = this.channel as unknown as Record<string, unknown>;
    if (typeof ch.setAppliedInstinctIds === "function") {
      (ch.setAppliedInstinctIds as (chatId: string, ids: string[]) => void)(chatId, instinctIds);
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
   * Compact session messages when approaching the provider's context window.
   * Uses a 4-stage pipeline (tool result → summarization → sliding window → truncation).
   */
  private maybeCompactSession(
    session: Session,
    providerName: string,
    modelId?: string,
    systemPrompt?: string,
  ): void {
    const ctxWindow =
      this.providerManager.getProviderCapabilities?.(providerName, modelId)?.contextWindow
      ?? DEFAULT_CONTEXT_WINDOW;
    const tokenEstimate = estimateTokens(
      session.messages,
      (systemPrompt?.length ?? 0) + (session.compactionSummary?.length ?? 0),
    );
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
      getLogger().info("Session compacted", {
        stage: result.stageApplied,
        originalTokens: result.originalTokens,
        finalTokens: result.finalTokens,
        systemPromptEstimate: systemPrompt ? Math.ceil(systemPrompt.length / 4) : 0,
      });
    }
  }

  /** System prompt with the rolling compaction summary appended (if any). */
  private withCompactionSummary(systemPrompt: string, session: Session): string {
    return session.compactionSummary
      ? `${systemPrompt}\n\n## Prior conversation summary (compacted)\n${session.compactionSummary}`
      : systemPrompt;
  }

  /**
   * Classify a {@link silentStream} response into the registry health signal. A 200 with no
   * usable output is what the per-task circuit breaker classifies as a FAILURE; recording it
   * as registry success would diverge the two — the breaker would back off while the registry
   * kept the provider "healthy". Uses the SHARED predicate so they can't drift (audit #9).
   *
   * Pure extraction of the exact sequence the v1 stream-success and fallback-success arms ran
   * inline; both the flag-OFF and flag-ON `silentStream` branches call it identically.
   */
  private classifySilentStreamResponse(response: ProviderResponse, provider: IAIProvider): void {
    if (isEmptyProviderResponse(response)) {
      recordProviderHealthFailure(
        ProviderHealthRegistry.getInstance(),
        provider.name,
        response.meta?.reason ?? "empty response (no text, no tool calls)",
        { isSingleProvider: isSingleProviderChain(provider) },
      );
    } else {
      ProviderHealthRegistry.getInstance().recordSuccess(provider.name);
    }
  }

  /**
   * The non-streaming fallback {@link silentStream} runs after a streaming error. Pure
   * extraction of v1's fallback try/catch (the success path + the synthetic-empty-response
   * catch). Flag-OFF (`runClock` undefined) is byte-identical to v1: the per-call deadline is
   * `AbortSignal.timeout(this.streamInitialTimeoutMs)` composed with the external signal exactly
   * as before. Flag-ON: the deadline is a fresh RunClock CallScope token composed the same way.
   */
  private async silentStreamFallback(
    provider: IAIProvider,
    effectivePrompt: string,
    session: Session,
    toolDefinitions: Array<{
      name: string;
      description: string;
      input_schema: import("../types/index.js").JsonObject;
    }>,
    externalSignal: AbortSignal | undefined,
    chatId: string,
    runClock?: RunClock,
  ): Promise<ProviderResponse> {
    let fbScope: CallScope | undefined;
    // Flag-ON: a fresh fallback CallScope token (composition order [externalSignal, token]
    // mirrors v1's [externalSignal, timeoutSignal]). Flag-OFF: VERBATIM v1 AbortSignal.timeout.
    const fallbackSignal: AbortSignal = runClock
      ? (() => {
          fbScope = runClock.enterCall({
            firstResponseMs: this.streamInitialTimeoutMs,
            stallMs: this.streamInitialTimeoutMs,
            hardMs: this.streamInitialTimeoutMs,
          });
          return externalSignal
            ? AbortSignal.any([externalSignal, fbScope.token.signal])
            : fbScope.token.signal;
        })()
      : (() => {
          const timeoutSignal = AbortSignal.timeout(this.streamInitialTimeoutMs);
          return externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal;
        })();
    try {
      const fallbackResponse = await provider.chat(effectivePrompt, session.messages, toolDefinitions, {
        signal: fallbackSignal,
        externalSignal,
      });
      // The fallback chat can also return an empty 200 — record it as a health FAILURE
      // (same predicate the per-task breaker uses) so the registry and breaker stay in
      // agreement on this path too (audit #9).
      this.classifySilentStreamResponse(fallbackResponse, provider);
      return fallbackResponse;
    } catch (fallbackErr) {
      const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      getLogger().error("Silent stream fallback chat failed", { chatId, error: fallbackMsg });
      recordProviderHealthFailure(ProviderHealthRegistry.getInstance(), provider.name, fallbackMsg, {
        isSingleProvider: isSingleProviderChain(provider),
      });
      // Surface the failure to the agent so it can adapt its approach
      // (e.g. simplify the request, reduce tool usage, skip non-critical work).
      // This mirrors Claude Code's behavior of showing errors to the user.
      session.messages.push({
        role: "user",
        content: `[System: The AI provider (${provider.name}) failed to respond. Error: ${fallbackMsg}. You may need to: simplify your current step, reduce the number of tool calls, or skip non-critical analysis. Adapt your approach and continue.]`,
      } as ConversationMessage);
      // Return a synthetic empty response so the PAOR loop can continue with the
      // agent's awareness of the failure. The explicit `meta.empty` flag is the
      // canonical signal the circuit breaker (runBackgroundTask / runAgentLoop)
      // keys on — more robust than inferring emptiness from the token shape (#18).
      return {
        text: "",
        toolCalls: [],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        meta: { empty: true, reason: "provider_failure" },
      };
    } finally {
      fbScope?.leave();
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
    externalSignal?: AbortSignal,
    onLiveness?: () => void,
    runClock?: RunClock, // Phase 1b — flag-ON only; undefined keeps the verbatim v1 watchdog path.
  ): Promise<ProviderResponse> => {
    // Reasoning models get an extended stall window equal to the initial timeout
    // because they may enter long silent thinking phases with no SSE events.
    const thinkingStall = provider.capabilities.thinkingSupported
      ? this.streamInitialTimeoutMs
      : undefined;
    const effectivePrompt = this.withCompactionSummary(systemPrompt, session);

    // ── Agent Core v2 — Phase 1b: RunClock-governed streaming (flag-ON). ──────────────────
    // The CallScope token replaces the createStreamingProgressTimeout watchdog + Promise.race:
    // the token aborts the live fetch directly via the composed signal (no rejecting race).
    if (runClock) {
      // Reasoning providers keep the generous stall window (== first-response) so a long
      // silent think is not cut short — mirrors v1's `thinkingStall`. firstResponse==hard==
      // streamInitialTimeoutMs reproduces v1's single AbortSignal.timeout bound on the silent
      // phase; the task-scope silence accumulator is the global ceiling (replaces the deleted
      // MAX_SILENT_THINKING_WINDOWS local cap).
      const scope = runClock.enterCall({
        firstResponseMs: this.streamInitialTimeoutMs,
        stallMs: thinkingStall ?? this.streamStallTimeoutMs,
        hardMs: this.streamInitialTimeoutMs,
      });
      // Compose exactly as v1 composed (scope token + external signal); externalSignal stays
      // threaded so the resilient chain can tell a benign cancel from a stall (audit #6).
      const composedSignal = externalSignal
        ? AbortSignal.any([scope.token.signal, externalSignal])
        : scope.token.signal;
      let onLivenessAt = 0;
      try {
        const response = await (provider as IStreamingProvider).chatStream(
          effectivePrompt,
          session.messages,
          toolDefinitions,
          (chunk) => {
            // Visible token → firstTokenSeen (flip first-response → stall) + touch (re-arm).
            // Empty chunk = keepalive/reasoning delta → do NOT touch (preserve the long think
            // window; the call's first-response==hard timer bounds the silent phase, and the
            // task-scope accumulator bounds it globally). Still forward throttled task-liveness.
            if (chunk) {
              scope.firstTokenSeen();
              scope.touch();
            } else if (onLiveness) {
              const now = this.agentCoreClock.now();
              if (now - onLivenessAt >= 20_000) {
                onLivenessAt = now;
                onLiveness();
              }
            }
          },
          { signal: composedSignal, externalSignal },
        );
        this.classifySilentStreamResponse(response, provider);
        return response;
      } catch (err) {
        // Benign control-plane cancel → rethrow for the loop's `signal.aborted` path (audit #6).
        if (externalSignal?.aborted) throw err;
        getLogger().error("Silent stream error", {
          chatId,
          error: err instanceof Error ? err.message : "Unknown streaming error",
        });
        // Non-cancel error → the same non-streaming fallback v1 runs, under a fresh scope.
        return await this.silentStreamFallback(
          provider, effectivePrompt, session, toolDefinitions, externalSignal, chatId, runClock,
        );
      } finally {
        scope.leave();
      }
    }

    // ── Flag-OFF: VERBATIM v1 (createStreamingProgressTimeout + Promise.race). ─────────────
    // Throttle for surfacing intra-call liveness to the task-level inactivity
    // watchdog (which cannot otherwise see keepalive/reasoning heartbeats) — a
    // dense reasoning-summary stream must not flood it (audit #8).
    let lastLivenessAt = 0;
    const timeoutGuard = createStreamingProgressTimeout(
      this.streamInitialTimeoutMs,
      this.streamStallTimeoutMs,
      thinkingStall,
    );
    // Compose external signal (task cancellation) with watchdog signal so
    // both can abort the fetch — prevents stale requests when user cancels.
    const composedSignal = externalSignal
      ? AbortSignal.any([timeoutGuard.signal, externalSignal])
      : timeoutGuard.signal;
    try {
      const streamPromise = (provider as IStreamingProvider).chatStream(
        effectivePrompt,
        session.messages,
        toolDefinitions,
        (chunk) => {
          // Non-empty chunk = real visible content (flip to stall window); empty
          // chunk = liveness heartbeat (keepalive / reasoning summary) that must
          // keep the long thinking window so the model is not cut off mid-reason.
          if (chunk) {
            timeoutGuard.markProgress();
          } else {
            timeoutGuard.markAlive();
            // Forward liveness to the task-level inactivity watchdog (throttled).
            if (onLiveness) {
              const now = Date.now();
              if (now - lastLivenessAt >= 20_000) {
                lastLivenessAt = now;
                onLiveness();
              }
            }
          }
        },
        // Thread the EXTERNAL (un-composed) signal so the resilient chain can tell a
        // benign control-plane cancel from a watchdog stall and not poison health /
        // fall over / emit a false "All providers failed" on cancel (audit #6).
        { signal: composedSignal, externalSignal },
      );
      // Suppress unhandled rejection from abandoned stream when timeout wins the race
      streamPromise.catch((err) => {
        getLogger().debug("Stream abandoned after timeout race", { error: err instanceof Error ? err.message : String(err) });
      });
      const response = await Promise.race([streamPromise, timeoutGuard.timeoutPromise]);
      timeoutGuard.clear();
      // Route empty 200s to the health-failure path (the shared breaker predicate, audit #9).
      this.classifySilentStreamResponse(response, provider);
      return response;
    } catch (err) {
      timeoutGuard.clear();
      // Control-plane cancellation: the external signal aborted this call (user cancel /
      // task wind-down). Benign — NOT a provider failure. Do not log an error, do not
      // attempt the fallback chat (it would re-run the chain on the same aborted signal
      // → a false "All providers failed"), and do not poison provider health. Rethrow so
      // the loop's `if (signal.aborted) throw` cancellation path handles it (audit #6).
      if (externalSignal?.aborted) {
        throw err;
      }
      const errMsg = err instanceof Error ? err.message : "Unknown streaming error";
      getLogger().error("Silent stream error", { chatId, error: errMsg });
      // Fallback to non-streaming under the SAME per-call deadline v1 used (extracted; the
      // OFF call passes no runClock → AbortSignal.timeout, byte-identical to the prior inline).
      return await this.silentStreamFallback(
        provider, effectivePrompt, session, toolDefinitions, externalSignal, chatId,
      );
    }
  };

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

  /**
   * Build a resilient provider with fallback order ranked by task fitness.
   * Uses ProviderRouter scoring when available, falls back to default order.
   */
  private buildTaskAwareProvider(
    primaryName: string,
    task?: import("../agent-core/routing/routing-types.js").TaskClassification,
    phase?: string,
    options?: { modelId?: string; identityKey?: string; usesMultipleProviders?: boolean },
  ): import("./providers/provider.interface.js").IAIProvider | null {
    const modelId = options?.modelId;

    // Honor a single-provider / hard-pinned strategy exactly: materialize the
    // supervisor-selected provider AND model rather than building a multi-provider
    // fallback chain, which would both ignore the pin and silently drop the chosen
    // model (running the provider's static default instead).
    if (!this.providerRouter || !task || options?.usesMultipleProviders === false) {
      return this.providerManager.getProviderByName?.(primaryName, modelId) ?? null;
    }

    try {
      const rankedOrder = this.providerRouter.resolveRanked(
        task,
        phase,
        options?.identityKey ? { identityKey: options.identityKey } : undefined,
      );
      if (rankedOrder.length <= 1) {
        return this.providerManager.getProviderByName?.(primaryName, modelId) ?? null;
      }

      // Ensure primary is first, then fill with router-ranked order
      const order = [primaryName];
      for (const name of rankedOrder) {
        if (!order.includes(name)) {
          order.push(name);
        }
      }

      return this.providerManager.buildResilientProviderWithOrder?.(order, modelId)
        ?? this.providerManager.getProviderByName?.(primaryName, modelId)
        ?? null;
    } catch {
      // Fallback to the selected provider + model on any router error
      return this.providerManager.getProviderByName?.(primaryName, modelId) ?? null;
    }
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

  // @ts-expect-error -- method retained for backward compatibility with legacy review format; will be removed in a future cleanup pass
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

  private async runVisibilityReview(params: {
    chatId: string;
    identityKey: string;
    prompt: string;
    draft: string;
    evidence: ReturnType<typeof planVerifierPipeline>["evidence"];
    task: TaskClassification;
    strategy: SupervisorExecutionStrategy;
    canInspectLocally: boolean;
    usageHandler?: (usage: TaskUsageEvent) => void;
  }): Promise<{
    decision: ReturnType<typeof sanitizeVisibilityReviewDecision>;
    usage?: ProviderResponse["usage"];
  }> {
    const reviewer = this.resolveSupervisorAssignment(
      "reviewer",
      { ...params.strategy.task, type: "analysis" },
      "visibility-review",
      params.identityKey,
      params.strategy.reviewer.providerName,
      params.strategy.reviewer.provider,
      `${params.prompt}\n\nVisibility review.`,
    );

    const response = await reviewer.provider.chat(
      `${this.systemPrompt}\n\n${VISIBILITY_REVIEW_SYSTEM_PROMPT}${this.buildSupervisorRolePrompt(params.strategy, reviewer)}`,
      [
        {
          role: "user",
          content: buildVisibilityReviewRequest({
            prompt: params.prompt,
            draft: params.draft,
            evidence: params.evidence,
            task: params.task,
            canInspectLocally: params.canInspectLocally,
          }),
        },
      ],
      [],
    );
    this.recordExecutionTrace({
      chatId: params.chatId,
      identityKey: params.identityKey,
      assignment: reviewer,
      phase: "visibility-review",
      source: "visibility-review",
      task: params.task,
    });
    this.recordAuxiliaryUsage(reviewer.providerName, response.usage, params.usageHandler);
    const decision = sanitizeVisibilityReviewDecision(
      parseVisibilityReviewDecision(response.text),
    );
    this.recordPhaseOutcome({
      chatId: params.chatId,
      identityKey: params.identityKey,
      assignment: reviewer,
      phase: "visibility-review",
      source: "visibility-review",
      status: decision?.decision === "internal_continue" ? "continued" : "approved",
      task: params.task,
      reason: decision?.reason ?? "Visibility review completed.",
      telemetry: this.buildPhaseOutcomeTelemetry({
        usage: response.usage,
      }),
    });
    return { decision, usage: response.usage };
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

    // Run all review stages in parallel to reduce wall-clock time (3 sequential → 1 parallel batch)
    const stagePromises = stages.map(async (stage) => {
      const assignment = this.resolveCompletionReviewStageAssignment(stage, params);
      const stageRequest = buildCompletionReviewStageRequest({
        stage,
        prompt: params.prompt,
        draft: params.draft,
        state: params.state,
        evidence: params.plan.evidence,
        verifierChecks,
        buildToolsAvailable: params.plan.buildToolsAvailable,
      });
      const stageMessages: ConversationMessage[] = [{ role: "user", content: stageRequest }];

      const parseOrFallback = (text: string): CompletionReviewStageResult =>
        parseCompletionReviewStageResult(text, stage)
        ?? this.buildCompletionReviewStageFallback(
          stage,
          `${stage} review returned an invalid response.`,
          `Rerun the ${stage} review and continue conservatively until it is clean.`,
        );

      try {
        const reviewResponse = await assignment.provider.chat(
          `${this.systemPrompt}\n\n${buildCompletionReviewStageSystemPrompt(stage)}${this.buildSupervisorRolePrompt(params.strategy, assignment)}`,
          stageMessages,
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
        return parseOrFallback(reviewResponse.text);
      } catch (error) {
        getLogger().warn("Completion review stage failed, trying main provider chain", {
          chatId: params.chatId,
          stage,
          provider: assignment.providerName,
          error: error instanceof Error ? error.message : String(error),
        });
        // Retry with the main provider chain (FallbackChainProvider) before giving up
        try {
          const chainProvider = this.providerManager.getProvider(params.identityKey);
          const retryResponse = await chainProvider.chat(
            `${this.systemPrompt}\n\n${buildCompletionReviewStageSystemPrompt(stage)}`,
            stageMessages,
            [],
          );
          this.recordAuxiliaryUsage(chainProvider.name, retryResponse.usage, params.usageHandler);
          recordUsage(retryResponse.usage);
          return parseOrFallback(retryResponse.text);
        } catch (retryError) {
          getLogger().debug("Completion review stage retry also failed", {
            chatId: params.chatId,
            stage,
            error: retryError instanceof Error ? retryError.message : String(retryError),
          });
          return this.buildCompletionReviewStageFallback(
            stage,
            `${stage} review failed before Strada could validate completion.`,
            `Investigate the ${stage} review failure, rerun that review, and continue conservatively.`,
          );
        }
      }
    });
    stageResults.push(...await Promise.all(stagePromises));

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
      buildToolsAvailable: params.plan.buildToolsAvailable,
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
    ).catch(async (error) => {
      getLogger().warn("Completion review synthesis failed, trying main provider chain", {
        chatId: params.chatId,
        provider: reviewer.providerName,
        error: error instanceof Error ? error.message : String(error),
      });
      // Retry with the main provider chain before giving up
      try {
        const chainProvider = this.providerManager.getProvider(params.identityKey);
        const retryResponse = await chainProvider.chat(
          `${this.systemPrompt}\n\n${COMPLETION_REVIEW_SYNTHESIS_SYSTEM_PROMPT}`,
          [{ role: "user", content: synthesisRequest }],
          [],
        );
        this.recordAuxiliaryUsage(chainProvider.name, retryResponse.usage, params.usageHandler);
        recordUsage(retryResponse.usage);
        return retryResponse;
      } catch (retryError) {
        getLogger().debug("Completion review synthesis retry also failed", {
          chatId: params.chatId,
          error: retryError instanceof Error ? retryError.message : String(retryError),
        });
        return null;
      }
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
    const goalCtx = options.goalContext;
    let substepOrder = 0;

    const toolContext: ToolContext & { soulLoader?: SoulLoader | null; userProfileStore?: UserProfileStore } = {
      projectPath,
      workingDirectory,
      readOnly: this.readOnly,
      userId: options.userId,
      chatId,
      channel: this.channel,
      soulLoader: this.soulLoader,
      userProfileStore: this.userProfileStore,
      // Dynamic tool registration callbacks
      registerDynamicTool: (tool) => this.addTool(tool),
      unregisterDynamicTool: (name) => {
        if (this.tools.has(name)) {
          this.removeTool(name);
          return true;
        }
        return false;
      },
      lookupTool: (name) => this.tools.get(name),
      onSkillCreated: this.onSkillCreated,
      dynamicToolFactory: this.dynamicToolFactory,
      vaultRegistry: this.vaultRegistry,
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
        // Break clarification loops: after 2 consecutive blocks, let ask_user through
        const blockCount = this.askUserBlockCounts.get(chatId) ?? 0;
        const MAX_ASK_USER_BLOCKS = 2;

        if (blockCount < MAX_ASK_USER_BLOCKS) {
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
            this.askUserBlockCounts.set(chatId, blockCount + 1);
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
        } else {
          // Loop breaker: reset counter and let ask_user pass through
          logger.info("Clarification loop breaker: letting ask_user through after repeated blocks", {
            chatId, blockCount,
          });
        }
        // Reset counter when ask_user actually goes through
        this.askUserBlockCounts.delete(chatId);
      }

      const readOnlyCheck = checkReadOnlyBlock(activeToolCall.name, this.readOnly);
      if (!readOnlyCheck.allowed) {
        this.metrics?.recordToolBlocked();
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

      // Vault-first interceptor: bypass file_read tool execution when vault has fresh data.
      if (activeToolCall.name === "file_read" && this.vaultRegistry && toolContext.projectPath) {
        const input = activeToolCall.input as Record<string, unknown>;
        const rawPath = input["path"];
        if (typeof rawPath === "string") {
          const pathCheck = await validatePath(toolContext.projectPath, rawPath);
          if (pathCheck.valid) {
            const vault = this.vaultRegistry.resolveVaultForPath(pathCheck.fullPath, toolContext.projectPath);
            if (vault) {
              const vaultRel = pathRelative(vault.rootPath, pathCheck.fullPath).replaceAll("\\", "/");
              const intercepted = await vaultFileRead({
                vault,
                vaultRelPath: vaultRel,
                absPath: pathCheck.fullPath,
                displayPath: rawPath,
                offset: input["offset"] !== undefined ? Math.max(1, Number(input["offset"])) : undefined,
                limit: input["limit"] !== undefined ? Math.min(FILE_LIMITS.MAX_LINES, Math.max(1, Number(input["limit"]))) : undefined,
                symbol: typeof input["symbol"] === "string" && input["symbol"].length > 0 ? input["symbol"] : undefined,
              });
              if (intercepted) {
                results.push({
                  toolCallId: activeToolCall.id,
                  content: intercepted.content,
                  isError: false,
                  metadata: intercepted.metadata,
                });
                continue;
              }
            }
          }
        }
      }

      // Auto-disable tools that have failed repeatedly in this chat
      const chatToolErrors = this.toolConsecutiveErrors.get(chatId);
      const toolErrorCount = chatToolErrors?.get(activeToolCall.name) ?? 0;
      if (toolErrorCount >= Orchestrator.MAX_CONSECUTIVE_TOOL_ERRORS) {
        results.push({
          toolCallId: activeToolCall.id,
          content: `Tool '${activeToolCall.name}' has failed ${toolErrorCount} consecutive times and is temporarily disabled for this conversation. Use a different approach or tool.`,
          isError: true,
        });
        continue;
      }

      const toolMeta = this.toolMetadataByName.get(activeToolCall.name);
      if (toolMeta?.available === false) {
        results.push({
          toolCallId: activeToolCall.id,
          content: toolMeta.availabilityReason || `Tool '${activeToolCall.name}' is currently unavailable.`,
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
      const substepId = `${activeToolCall.name}-${substepOrder}`;
      substepOrder++;

      const emitSubstep = (status: "active" | "done" | "skipped"): void => {
        if (goalCtx && this.workspaceBus) {
          this.workspaceBus.emit("monitor:substep", {
            rootId: goalCtx.rootId,
            nodeId: goalCtx.nodeId,
            substep: { id: substepId, label: activeToolCall.name, status, order: substepOrder },
          });
        }
      };

      emitSubstep("active");

      try {
        const result = await tool.execute(activeToolCall.input, toolContext);
        this.metrics?.recordToolCall(activeToolCall.name, Date.now() - toolStart, !result.isError, result.isError ? String(result.content).slice(0, 200) : undefined);
        // Vault write-hook (Phase 1): on successful Edit/Write tool calls,
        // trigger a budget-aware reindex of the touched file so the next turn's
        // vault-backed context reflects the just-written change.
        if (!result.isError && this.vaultRegistry) {
          await this.maybeFireVaultWriteHook(activeToolCall.name, activeToolCall.input);
        }
        if (!result.isError && activeToolCall.name !== "ask_user") {
          this.askUserBlockCounts.delete(chatId);
        }
        emitSubstep(result.isError ? "skipped" : "done");

        this.trackToolError(chatId, activeToolCall.name, !!result.isError);

        results.push({
          toolCallId: activeToolCall.id,
          content: sanitizeToolResult(result.content),
          isError: result.isError,
          metadata: result.metadata,
        });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : "Unknown error";
        this.metrics?.recordToolCall(activeToolCall.name, Date.now() - toolStart, false, errMsg.slice(0, 200));
        logger.error("Tool execution error", {
          chatId,
          tool: activeToolCall.name,
          error: errMsg,
        });
        emitSubstep("skipped");

        this.trackToolError(chatId, activeToolCall.name, true);

        results.push({
          toolCallId: activeToolCall.id,
          content: `Tool execution failed: ${classifyErrorMessage(error)}`,
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
    return requestWriteConfirmationHelper(this.channel, chatId, userId, toolName, input);
  }

  getProviderManager(): ProviderManager {
    return this.providerManager;
  }

  /**
   * Clean up expired sessions (call periodically).
   */
  cleanupSessions(maxAgeMs: number = 3_600_000): void {
    const expired = this.sessionManager.cleanupSessions(maxAgeMs);
    // Only clear block counts for expired sessions, not all active ones
    for (const chatId of expired) {
      this.askUserBlockCounts.delete(chatId);
      this.toolConsecutiveErrors.delete(chatId);
    }
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

  private emitToolResult(
    chatId: string,
    tc: { name: string; input: unknown },
    tr: { content: string; isError?: boolean; metadata?: Record<string, unknown> },
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

    // Workspace monitor: agent activity event for dashboard UI
    if (this.workspaceBus) {
      const workspaceBus = this.workspaceBus;
      workspaceBus.emit("monitor:agent_activity", {
        taskId: undefined,
        action: "tool_execute",
        tool: tc.name,
        detail: `Executing ${tc.name}`,
        timestamp: Date.now(),
      });

      // Visual output detection: emit canvas events for diagrams and large diffs
      const output = tr.content;
      const shapes: Array<{ type: string; id: string; props: Record<string, unknown> }> = [];

      if (/```(?:mermaid|plantuml)|@startuml/i.test(output)) {
        shapes.push({
          type: "code-block",
          id: `diagram-${Date.now()}`,
          props: {
            w: 420,
            h: 260,
            code: output,
            language: output.includes("mermaid") ? "mermaid" : "plantuml",
            title: "Generated diagram",
          },
        });
      }

      if (/^@@\s+-\d+/m.test(output) && output.split("\n").length > 50) {
        shapes.push({
          type: "diff-block",
          id: `diff-${Date.now()}`,
          props: {
            w: 420,
            h: 260,
            diff: output,
            filePath: "Generated diff",
          },
        });
      }

      if (shapes.length > 0) {
        workspaceBus.emit("canvas:shapes_add", { shapes });
        workspaceBus.emit("workspace:mode_suggest", {
          mode: "canvas",
          reason: `Visual output detected: ${shapes.map((s) => s.type).join(", ")}`,
        });
      }

      // Code event emission for file and shell tools
      const toolInput = tc.input as Record<string, unknown>;
      const filePath = typeof toolInput.path === "string" ? toolInput.path : "";
      const absoluteFilePath = filePath
        ? (isAbsolute(filePath) ? filePath : join(this.projectPath, filePath))
        : "";
      const enqueueCodeEvent = (work: () => Promise<void>): void => {
        this.workspaceCodeEventQueue = this.workspaceCodeEventQueue
          .then(work)
          .catch(() => { /* telemetry is best-effort; never propagate */ });
      };

      const emitCodeFileOpen = async (
        openPath: string,
        options?: {
          content?: string;
          touchedStatus?: "modified" | "new" | "deleted";
        },
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
              // file_edit → emit code:file_update with original + modified for diff view
              try {
                // `modified` is intentionally re-read live from disk; in a turn with
                // multiple edits to the same file it may reflect a later same-file
                // edit, not just this one — accepted as best-effort monitor telemetry.
                const modified = await readFile(absoluteFilePath, "utf-8");
                // Prefer pre-edit content from tool metadata (reliable) over reverse-engineering
                const original = typeof tr.metadata?.originalContent === "string"
                  ? (tr.metadata.originalContent as string)
                  : modified.replace(toolInput.new_string as string, () => toolInput.old_string as string);
                workspaceBus.emit("code:file_update", {
                  path: filePath,
                  diff: `${(toolInput.old_string as string).slice(0, 250)} → ${(toolInput.new_string as string).slice(0, 250)}`,
                  original: original.slice(0, 500_000),
                  modified: modified.slice(0, 500_000),
                  language,
                });
              } catch {
                const content = typeof toolInput.new_string === "string" ? toolInput.new_string : output.slice(0, 10_000);
                await emitCodeFileOpen(filePath, { content, touchedStatus: "modified" });
              }
            } else {
              // file_write → emit code:file_open (new/overwritten file)
              const content = typeof toolInput.content === "string" ? toolInput.content
                : typeof toolInput.new_string === "string" ? toolInput.new_string
                : output.slice(0, 10_000);
              await emitCodeFileOpen(filePath, { content, touchedStatus: "new" });
            }
            // Emitted inside the same queued task so it still arrives AFTER the file event.
            workspaceBus.emit("workspace:mode_suggest", { mode: "code", reason: "File operation detected" });
          });
        }
      } else if (tc.name === "shell_exec" || tc.name === "dotnet_build" || tc.name === "dotnet_test") {
        const command = typeof toolInput.command === "string" ? toolInput.command : undefined;
        workspaceBus.emit("code:terminal_output", { content: output.slice(0, 10_000), command });
        workspaceBus.emit("workspace:mode_suggest", { mode: "code", reason: "Shell execution detected" });
      }
    }
  }

  async buildTrajectoryReplayContext(params: {
    chatId: string;
    userId?: string;
    conversationId?: string;
    channelType?: string;
    sinceTimestamp?: number;
    taskRunId?: string;
  }): Promise<TrajectoryReplayContext | null> {
    const deps: TrajectoryReplayDeps = {
      trajectoryReplayRetriever: this.trajectoryReplayRetriever,
      taskExecutionStore: this.taskExecutionStore,
      userProfileStore: this.userProfileStore,
      memoryManager: this.memoryManager,
      projectPath: this.projectPath,
      providerRouter: this.providerRouter,
      resolveTaskRunId: (chatId, taskRunId) => this.resolveTaskRunId(chatId, taskRunId),
    };
    return buildTrajectoryReplayContextHelper(deps, params);
  }

  // ─── Goal decomposition helpers ───────────────────────────────────────────

  private get goalDecompositionDeps(): GoalDecompositionDeps {
    return {
      goalDecomposer: this.goalDecomposer,
      activeGoalTrees: this.activeGoalTrees,
      sessionManager: this.sessionManager,
      monitorLifecycle: this.monitorLifecycle,
      eventEmitter: this.eventEmitter,
      workspaceBus: this.workspaceBus,
    };
  }

  private async runProactiveGoalDecomposition(opts: {
    conversationScope: string;
    userMessage: string;
    chatId: string;
    session: Session;
    agentState: AgentState;
  }): Promise<AgentState> {
    return runProactiveGoalDecompositionHelper(this.goalDecompositionDeps, opts);
  }

  private async runReactiveGoalDecomposition(opts: {
    conversationScope: string;
    chatId: string;
    session: Session;
    responseText: string;
  }): Promise<void> {
    return runReactiveGoalDecompositionHelper(this.goalDecompositionDeps, opts);
  }

  /**
   * Best-effort vault write-hook trigger after an Edit/Write tool succeeds.
   * Lazily binds to the first registered unity-project vault. Failures are
   * non-fatal — the orchestrator must not block on vault staleness.
   */
  private async maybeFireVaultWriteHook(
    toolName: string,
    input: unknown,
  ): Promise<void> {
    if (!this.vaultRegistry) return;
    if (!/^(Edit|Write|file_edit|file_write)$/i.test(toolName)) return;
    const path = this.extractWriteToolPath(input);
    if (!path) return;
    if (!this.vaultWriteHook) {
      const target = this.vaultRegistry.list().find((v) => v.kind === 'unity-project');
      if (!target) return;
      const { installWriteHook } = await import("../vault/write-hook.js");
      this.vaultWriteHook = installWriteHook({
        vault: target as Parameters<typeof installWriteHook>[0]['vault'],
        budgetMs: this.vaultWriteHookBudgetMs,
      });
    }
    try { await this.vaultWriteHook.afterWrite(path); }
    catch { /* swallow — staleness is recoverable on next watcher tick */ }
  }

  private extractWriteToolPath(input: unknown): string | null {
    if (!input || typeof input !== 'object') return null;
    const o = input as Record<string, unknown>;
    const candidates = ['file_path', 'path', 'filePath', 'filename'];
    for (const k of candidates) {
      const v = o[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return null;
  }

}

/**
 * Vault write-hook bridge. Called after an Edit/Write tool completes; if the tool
 * produced a file path and a hook is available, asks the hook to reindex and
 * appends a stale-warning string to `result.warnings` when the hook reports one.
 */
export async function applyWriteHookToToolResult(
  result: { toolName: string; output?: { path?: string }; warnings?: string[] },
  hook: { afterWrite: (p: string) => Promise<string | null> } | null,
): Promise<void> {
  if (!hook) return;
  if (!(result.toolName === 'Edit' || result.toolName === 'Write')) return;
  const path = result.output?.path;
  if (!path) return;
  const warning = await hook.afterWrite(path);
  if (warning) {
    result.warnings = result.warnings ?? [];
    result.warnings.push(warning);
  }
}

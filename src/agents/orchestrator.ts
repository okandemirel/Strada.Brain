import { failureTarget } from "./orchestrator-tool-execution.js";
import type {
  IAIProvider,
  ConversationMessage,
  ToolCall,
  ToolResult,
  ProviderResponse,
  IStreamingProvider,
} from "./providers/provider.interface.js";
// Streaming-first single-shot LLM call: a slow reasoning model must not trip the
// FallbackChain's 90s first-response timer on the blocking chat() path (533b1e9).
import { streamOrChatText } from "./providers/provider.interface.js";
import { parseBatchOperations, type BatchOperation } from "./autonomy/batch-write-gate.js";
import { warrantsSupervisor } from "../goals/tree-shape.js";
import { DotnetProjectPresence, DOTNET_PROJECT_TOOLS } from "./dotnet-project-presence.js";
import { extractUserAuthorizedPaths } from "../security/user-authorized-paths.js";
import { isFailedTerminalKey } from "./autonomy/terminal-outcome.js";
import { ProviderHealthRegistry } from "./providers/provider-health.js";
import { isQuotaStop, QUOTA_LIMIT_RE } from "./orchestrator-runtime-utils.js";
import { AgentEngine } from "../agent-core/engine/agent-engine.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative as pathRelative } from "node:path";
import { detectLanguage } from "../dashboard/workspace-routes.js";
import type { ProviderManager } from "./providers/provider-manager.js";
import { canonicalizeProviderName } from "./providers/provider-identity.js";
import { getToolMetadata, type ITool, type ToolContext } from "./tools/tool.interface.js";
import type { ToolExecutionResult } from "./tools/tool-core.interface.js";
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
  buildDepsContext,
  buildCapabilityManifest,
  STRADA_STATIC_FRAMEWORK_KNOWLEDGE,
  buildToolUsageHints,
  type VaultAvailability,
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
  type AgentState,
  type StepResult,
} from "./agent-state.js";
import type { InstinctRetriever } from "./instinct-retriever.js";
import type { TrajectoryReplayRetriever } from "./trajectory-replay-retriever.js";
import { TeachingParser } from "../learning/feedback/teaching-parser.js";
import type { LearningPipeline } from "../learning/pipeline/learning-pipeline.js";
import type { InterventionEngine } from "../learning/intervention/intervention-engine.js";
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
  planVerifierPipeline,
  sanitizeVisibilityReviewDecision,
  InteractionPolicyStateMachine,
  userExplicitlyAskedForPlan,
} from "./autonomy/index.js";
import { MUTATION_TOOLS, WRITE_OPERATIONS, looksLikeWriteTool, extractFilePath, isVerificationToolName } from "./autonomy/constants.js";
import { DMPolicy, isDestructiveOperation, type DMPolicyConfig } from "../security/dm-policy.js";
import {
  checkReadOnlyBlock,
  createReadOnlyToolStub,
  getReadOnlySystemPrompt,
} from "../security/read-only-guard.js";
import type { TaskProgressSignal, TaskUsageEvent } from "../tasks/types.js";
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
import type { TaskManager } from "../tasks/task-manager.js";
import type { SoulLoader } from "./soul/index.js";
import type { SessionSummarizer } from "../memory/unified/session-summarizer.js";
import {
  resolveAutonomousModeWithDefault,
  type UserProfileStore,
  type UserProfile,
} from "../memory/unified/user-profile-store.js";
import type {
  TaskExecutionStore,
} from "../memory/unified/task-execution-store.js";
import type {
  RuntimeArtifactManager,
  TrajectoryReplayContext,
  TrajectoryStep,
  TrajectoryOutcome,
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
  formatRequestedPlan,
  normalizeInteractiveText as normalizePolicyText,
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
  isEmptyProviderResponse,
  isSingleProviderChain,
  recordProviderHealthFailure,
} from "./orchestrator-runtime-utils.js";
import {
  SystemClock,
  CapabilityRegistry,
  capabilityForTool,
  guardExecute,
  formatBlocked,
  type CallScope,
  type CapabilityAdapter,
  type Clock,
  type RunClock,
} from "../agent-core/control/index.js";
import {
  selectAgentRunner,
  type FlagSet,
  type AgentRunRequest,
  type IOStrategy,
  type RunnerHostOrchestrator,
  type TerminalStatus,
} from "../agent-core/runner/index.js";
import { type MessageKey } from "./resilience-messages.js";
import {
  buildPhaseOutcomeTelemetry as buildPhaseOutcomeTelemetryModel,
  toExecutionPhase as toExecutionPhaseModel,
} from "./orchestrator-phase-telemetry.js";
import {
  type WorkerRunResult,
  type WorkspaceLease,
} from "./supervisor/supervisor-types.js";
import type { SupervisorResult } from "../supervisor/supervisor-types.js";
import {
  buildStaticSupervisorAssignment as buildStaticSupervisorAssignmentHelper,
  buildCatalogAssignmentMetadata as buildCatalogAssignmentMetadataHelper,
  resolveProviderModelId as resolveProviderModelIdHelper,

  buildSupervisorExecutionStrategy as buildSupervisorExecutionStrategyHelper,
  buildSupervisorRolePrompt as buildSupervisorRolePromptHelper,
  stripInternalDecisionMarkers as stripInternalDecisionMarkersHelper,
  type SupervisorRoutingContext,
  type SupervisorAssignment,
  type SupervisorExecutionStrategy,
  type SupervisorRole,
} from "./orchestrator-supervisor-routing.js";
import {
  buildSupervisorActivationNarrative,
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
} from "./orchestrator-intervention-pipeline.js";
import {
  injectSoulPersonality,
  type ContextBuilderDeps,
} from "./orchestrator-context-builder.js";
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
// Agent Core v2 — the strangler seam. The Orchestrator IMPLEMENTS OrchestratorPort by binding
// its existing private methods (COMPOSE+ADAPT). Since THE FLIP this port IS the production
// route on every route (v2-all-routes+full-control-plane); v1 is the env-revert path only.
import { ModelGateway } from "../agent-core/model/model-gateway.js";
import type { SilentStreamPort } from "../agent-core/model/model-gateway.js";
import type { AgentRunSetupInput } from "../agent-core/runner/orchestrator-port.js";
import type { AgentEvent } from "../agent-core/events/agent-event.js";
import { estimateTextTokens } from "../common/token-estimator.js";


/** Self-improvement tools bypass phase-based write filtering — they have their own guards. */
const SELF_IMPROVEMENT_TOOLS: ReadonlySet<string> = new Set([
  "create_skill",
]);

/**
 * Phases in which a write may run.
 *
 * Mirrors buildWorkerToolDefinitions, which removes write tools from what the
 * model is offered in the other three. Keeping both in one place is what stops
 * the offer and the gate from drifting apart again.
 */
const PHASES_ALLOWING_WRITES: ReadonlySet<AgentPhase> = new Set([
  AgentPhase.EXECUTING,
  AgentPhase.COMPLETE,
  AgentPhase.FAILED,
]);
const TYPING_INTERVAL_MS = 4000;

// ─── Agent Core v2 — OrchestratorPort run-context (Phase 2d-2) ───────────────────────────────
// REFLECT_INTERVAL_AGENT_CORE + AgentCoreToolTurnResult moved to the engine tool-turn module
// (relocation Step 8 → src/agent-core/engine/tool-turn.ts); AgentCoreToolTurnResult is imported back.

// Relocation Step 0: the per-run context struct moved VERBATIM to the engine module
// (src/agent-core/engine/engine-deps.ts EngineRunContext); the old name stays as a local alias
// while the port methods still live here (they relocate in Steps 1-9).
type AgentCorePortRunContext = import("../agent-core/engine/engine-deps.js").EngineRunContext;

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
  /** Liveness ping per supervisor node transition — see SupervisorContext. */
  readonly onLiveness?: () => void;
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
  /** Project root for the deterministic shell-review allowlist (review.ts). */
  projectPath?: string;
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
/** How much of a tool result reaches the debug log. Results can be whole
 *  files; enough to identify what happened, not enough to flood. */
const TOOL_RESULT_LOG_PREVIEW = 300;
/**
 * A failed result gets more room than a successful one.
 *
 * A success needs a headline; a failure needs its reasons, and 300 characters
 * ends exactly where those begin. Measured across 2026-08-21: every attempt to
 * find out what evidence an agent had actually been handed hit this cut — a
 * failing compile's preview stopped at "status: failed", and a failing
 * play-mode run's stopped one line into the first assertion, before the
 * captured output that explains it.
 */
const TOOL_FAILURE_LOG_PREVIEW = 1200;

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
  /** Relocation Step 0: the engine facade — Steps 1-9 move the port's method clusters into it,
   *  ending with createAgentCorePort() → this.engine.createPort(). */
  private readonly engine: AgentEngine;
  /** Agent Core v2 — Phase 1b. Injectable time source for RunClock; SystemClock in prod,
   *  FakeClock in tests. Only consulted when `agentCoreFlagSet.runClock === true`. */
  private readonly agentCoreClock: Clock;
  /** Agent Core v2 — Phase 3b. Tool-substrate liveness registry; constructed + seeded by bootstrap
   *  only when `agentCoreFlagSet.capabilityRegistry === true`. Read by the guardExecute write-path
   *  wrap in executeToolCalls (flag-on); flag-off ⇒ undefined ⇒ behavior-neutral. */
  private readonly capabilityRegistry?: CapabilityRegistry;
  /** Agent Core v2 — Phase 3b step 2b. Per-capability revive adapters (e.g. mcp:strada → bridge
   *  lazy-reconnect), consulted by guardExecute to revive a `down` substrate ONCE before BLOCKED.
   *  Built alongside the registry by bootstrap; absent/unmapped ⇒ no revive (→ BLOCKED on down). */
  private readonly capabilityAdapters?: ReadonlyMap<string, CapabilityAdapter>;
  private readonly sessionManager: SessionManager;
  /**
   * Paths the user named, per chat.
   *
   * Recorded when the message arrives rather than looked up at tool time: by the
   * time a tool runs, the session the orchestrator can reach may hold no user
   * turn at all — measured, file_read was refused with "Path resolves outside
   * the project directory" for a document the user had named in the very
   * request that started the run.
   */
  /**
   * Shared across every Orchestrator in the process when one is supplied.
   *
   * Authorization is a property of what the user typed, not of the instance
   * that happened to receive it. Measured 2026-08-20: goal decomposition
   * rewrote "read /Users/okan/Downloads/PixelFlow_GDD.docx" into a sub-goal
   * that said only "read PixelFlow_GDD.docx", so the sub-agent's Orchestrator
   * could derive nothing and refused the document its task was about. Keyed by
   * chat id, so sharing the store never widens who may read what.
   */
  private readonly authorizedPathsByChat: Map<string, readonly string[]>;
  /**
   * Per-run answer to "is there anything for dotnet to build".
   *
   * Lazy: projectPath is assigned in the constructor body, after field
   * initialisers run.
   */
  private dotnetProjectPresence: DotnetProjectPresence | null = null;
  private get dotnetProject(): DotnetProjectPresence {
    this.dotnetProjectPresence ??= new DotnetProjectPresence(this.projectPath);
    return this.dotnetProjectPresence;
  }

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
  /**
   * How many failures on DIFFERENT targets before a tool is presumed broken.
   *
   * Kept well above the repeat threshold. Measured 2026-08-20: an agent probed
   * seven files that did not exist, one in each of seven modules — ordinary
   * exploration, every call a different path — and lost file_read for the rest
   * of the run. The tool was fine; the paths were not.
   */
  private static readonly MAX_DISTINCT_TOOL_ERRORS = 12;
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
  // Adaptive loop-detection config (ControlLoopTracker knobs) — threaded into the v2 autonomy
  // bundle (trio catch: the Step-5 sweep deleted these as "v1-only", but the config schema +
  // bootstrap still document/thread them; accepted-and-ignored config is worse than either).
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
  /** Fired after every tool execution so the task watchdog can see activity. */
  private onLiveness: (() => void) | null = null;
  /** Callback to hot-reload a newly created skill */
  private onSkillCreated?: (skillPath: string) => Promise<void>;
  private getSkillEntries?: () => readonly SkillEntry[];

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
    /** Share one authorization store so a sub-agent inherits what the user named. */
    authorizedPathsStore?: Map<string, readonly string[]>;
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
    /** Agent Core v2 — Phase 3b capability registry (seeded by bootstrap when the flag is on). */
    capabilityRegistry?: CapabilityRegistry;
    /** Agent Core v2 — Phase 3b step 2b: per-capability revive adapters (bootstrap builds the
     *  mcp:strada → tryStradaMcpReconnect adapter alongside the registry). */
    capabilityAdapters?: ReadonlyMap<string, CapabilityAdapter>;
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
    this.defaultLanguage = opts.defaultLanguage ?? "en";
    this.loopFingerprintThreshold = opts.loopFingerprintThreshold;
    this.loopFingerprintWindow = opts.loopFingerprintWindow;
    this.loopDensityThreshold = opts.loopDensityThreshold;
    this.loopDensityWindow = opts.loopDensityWindow;
    this.loopMaxRecoveryEpisodes = opts.loopMaxRecoveryEpisodes;
    this.loopStaleAnalysisThreshold = opts.loopStaleAnalysisThreshold;
    this.loopHardCapReplan = opts.loopHardCapReplan;
    this.loopHardCapBlock = opts.loopHardCapBlock;
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
    this.authorizedPathsByChat = opts.authorizedPathsStore ?? new Map<string, readonly string[]>();
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
    this.progressAssessmentEnabled = opts.progressAssessmentEnabled ?? true;
    this.maxIterations = opts.maxIterations;
    this.getIdentityState = opts.getIdentityState;
    this.crashRecoveryContext = opts.crashRecoveryContext;
    this.onSkillCreated = opts.onSkillCreated;
    this.getSkillEntries = opts.getSkillEntries;
    this.agentCoreFlagSet = opts.agentCoreFlagSet;
    this.agentCoreClock = opts.agentCoreClock ?? new SystemClock();
    this.capabilityRegistry = opts.capabilityRegistry;
    this.capabilityAdapters = opts.capabilityAdapters;

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

    // Relocation: the engine facade (constructed LAST so every ctor-assigned dep is live;
    // setter-backed fields must go in as lazy getters when their consumers relocate).
    this.engine = new AgentEngine({
      getSupervisorRoutingContext: () => this.getSupervisorRoutingContext(),
      resolveTaskRunId: (chatId?: string, explicitTaskRunId?: string) =>
        this.resolveTaskRunId(chatId, explicitTaskRunId),
      providerRouter: this.providerRouter,
      metricsRecorder: this.metricsRecorder,
      metrics: this.metrics,
      rateLimiter: this.rateLimiter,
      // Step 2 (budget/limits): unifiedBudgetManager is setter-backed → LAZY GETTER.
      unifiedBudgetManager: () => this.unifiedBudgetManager ?? null,
      taskConfig: this.taskConfig,
      maxIterations: this.maxIterations,
      streamInitialTimeoutMs: this.streamInitialTimeoutMs,
      streamStallTimeoutMs: this.streamStallTimeoutMs,
      // Step 3 (prepare-iteration): the tool registry is shell state → inject as a callback.
      buildWorkerToolDefinitions: (task, phase, role) => this.buildWorkerToolDefinitions(task, phase, role),
      // Step 4 (synthesis/projection).
      providerManager: this.providerManager,
      // Step 5b (review/verify): systemPrompt is mutable (rebuilt) → LAZY GETTER.
      systemPrompt: () => this.systemPrompt,
      taskClassifier: this.taskClassifier,
      userProfileStore: this.userProfileStore,
      onUsage: this.onUsage,
      defaultLanguage: this.defaultLanguage,
      // Step 6a (rendering).
      sessionManager: this.sessionManager,
      // Step 6b (reflection/end-turn dispatch, HIGHEST CARE): taskManager is setter-backed → LAZY.
      taskManager: () => this.taskManager,
      dmPolicy: this.dmPolicy,
      interactionPolicy: this.interactionPolicy,
      consensusManager: this.consensusManager,
      confidenceEstimator: this.confidenceEstimator,
      progressAssessmentEnabled: this.progressAssessmentEnabled,
      buildInterventionDeps: (getSystemPrompt) => this.buildInterventionDeps(getSystemPrompt),
      buildStructuredProgressSignal: (prompt, title, signal, language) =>
        this.buildStructuredProgressSignal(prompt, title, signal, language),
      getClarificationContext: () => this.getClarificationContext(),
      synthesizeUserFacingResponse: (p) => this.synthesizeUserFacingResponse(p),
      runProactiveGoalDecomposition: (opts) => this.runProactiveGoalDecomposition(opts),
      runReactiveGoalDecomposition: (opts) => this.runReactiveGoalDecomposition(opts),
      // Step 7 (run setup / bootstrap).
      soulLoader: this.soulLoader,
      vaultRegistry: this.vaultRegistry,
      embeddingProvider: this.embeddingProvider,
      instinctRetriever: this.instinctRetriever,
      modelIntelligence: this.modelIntelligence,
      autonomousDefaultEnabled: this.autonomousDefaultEnabled,
      autonomousDefaultHours: this.autonomousDefaultHours,
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
      currentSessionInstinctIds: this.currentSessionInstinctIds,
      // monitorLifecycle + stradaDeps are setter-backed (setMonitorLifecycle / runtime checkStradaDeps) → LAZY GETTERS.
      monitorLifecycle: () => this.monitorLifecycle,
      stradaDeps: () => this.stradaDeps,
      // The conformance guard reads a written module directory from disk; with
      // no root it cannot run and stays silent, which is how the gate shipped
      // inert on its first run.
      projectPath: () => this.projectPath,
      getContextBuilderContext: () => this.getContextBuilderDeps(),
      buildFreshRunSession: (request, queryText, supportsVision) =>
        this.buildFreshRunSession(request, queryText, supportsVision),
      buildFixedSupervisorExecutionStrategy: (prompt, identityKey, providerName, modelId, provider) =>
        this.buildFixedSupervisorExecutionStrategy(prompt, identityKey, providerName, modelId, provider),
      maybeUpdateUserProfileFromPrompt: (chatId, identityKey, queryText, userId) =>
        this.maybeUpdateUserProfileFromPrompt(chatId, identityKey, queryText, userId),
      getTaskExecutionContext: () => this.getTaskExecutionContext(),
      propagateInstinctIdsToChannel: (chatId, instinctIds) =>
        this.propagateInstinctIdsToChannel(chatId, instinctIds),
      // Step 8 (tool turn): the RCE-sensitive tool-execution primitives + batch classifier stay in
      // the shell → injected as callbacks (the turn orchestrates; it does not re-home the write gate).
      executeToolCalls: (chatId, toolCalls, options) => this.executeToolCalls(chatId, toolCalls, options),
      emitToolResult: (chatId, tc, tr) => this.emitToolResult(chatId, tc, tr),
      buildToolBatchProgressSignal: (params) => this.buildToolBatchProgressSignal(params),
      // BUG#1 P2: route the plain-loop live step DAG through the shell's MonitorLifecycle (lazy —
      // setter-backed), under the active episode root. The engine gates this on its suppression
      // guard, so it never collides with the supervisor/decomposed node-id streams.
      emitPlainLoopStep: (params) =>
        this.monitorLifecycle?.stepBatch(
          params.conversationScope,
          params.batchIndex,
          params.toolLabel,
          params.monitorScope,
        ),
      // Step 9 (port assembly): the shell residue the port binds — provider resilience, session
      // compaction, checkpoint, ALS scope, epoch rollover, trajectory credit, terminal-reason map,
      // and the ModelGateway construction (silentStream stays in the shell).
      buildTaskAwareProvider: (primaryName, task, phase, options) =>
        this.buildTaskAwareProvider(primaryName, task, phase, options),
      maybeCompactSession: (session, providerName, modelId, systemPrompt) =>
        this.maybeCompactSession(session, providerName, modelId, systemPrompt),
      saveBudgetExceededCheckpoint: (params) => this.saveBudgetExceededCheckpoint(params),
      withTaskExecutionContext: (context, run) => this.withTaskExecutionContext(context, run),
      portOnEpochRollover: (continued, epoch, agentState, runCtx) =>
        this.portOnEpochRollover(continued, epoch, agentState, runCtx),
      recordInRunTrajectoryCredit: (params) => this.recordInRunTrajectoryCredit(params),
      mapTerminalReasonToMessageKey: (reason, status) => this.mapTerminalReasonToMessageKey(reason, status),
      createGateway: () => new ModelGateway(this.silentStream as unknown as SilentStreamPort),
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



  // ───────────────────────────────────────────────────────────────────────────
  // Agent Core v2 — Phase 1b: RunClock construction + the live-signal VerdictInput.
  //
  // Reached ONLY when `agentCoreFlagSet.runClock === true`. The RunClock owns every
  // per-call deadline (CallScope token) + the task-scope silence accumulator; its typed
  // provider-stall / hard-timeout / silence signals feed the SAME FailureLedger the 1a
  // helper feeds (rules 2/4/6 become reachable). The flag-OFF path is byte-identical v1.
  // ───────────────────────────────────────────────────────────────────────────







  /**
   * Agent Core v2 (Step 3 / increment 3.2) — render the spine's user-facing resilience events to the
   * INTERACTIVE channel. This is the v2 analog of {@link applyInteractiveVerdict}'s rendering arm
   * (:1459-1487): on the v2 path the spine emits typed `AgentEvent`s through the bus→ioSink→onEvent
   * seam, and without translating them the user sees NOTHING when a provider backs off, asks, or the
   * run aborts — a UX regression vs v1. Mapping (robust: keyed on event type/status, never a humanized
   * reason string):
   *   - `backoff`   → `provider_slow` (v1 degraded tier, :1462). The event carries no failure
   *                   count/tier, so the no-param degraded message is rendered; the critical-tier
   *                   `provider_failing {attempt}/{max}` is deferred to a backoff-event enrichment.
   *   - `ask_user`  → the model's own `visibleText` when present, else `provider_ask_user` (:1478).
   *   - `show_plan` → `visibleText` verbatim (the plan body, not a resilience string).
   *   - `run.ending` whose reason is a control-plane STOP → `provider_abort` (v1's ledger-break
   *                   render, :1485). The reason carries the terminal cause; every value NOT in
   *                   {@link INTERACTIVE_NON_ABORT_RUN_ENDING_REASONS} (done/end_turn/max-tokens/
   *                   ask-block/epoch) is a stop. The happy `end_turn`/`done` already had the answer
   *                   rendered by the port dispatch (3.0), so they are skipped — no double-render.
   *                   (Empirically: a rule-4 inactivity stop is a SOFT stop → terminalStatus
   *                   "completed", so keying on `run.ended.status==="failed"` would MISS it; the
   *                   reason on `run.ending` is the faithful break signal.)
   * Everything else (lifecycle, heartbeat, model/tool streaming deltas, run.started/ending, step.x) is
   * a no-op here — not user-facing on the interactive path. The TERMINAL ANSWER is never rendered here
   * (the port's dispatch handlers own it); this strictly handles non-answer signals.
   *
   * `e` is typed `AgentEvent` but arrives via the `AgentRunEvent`-typed `onEvent` (the deferred
   * AgentEvent→TaskProgressUpdate seam — control-plane.ts), so the caller casts at the boundary.
   * `enqueue` appends the render to an ordered tail-promise chain (the caller drains it post-run);
   * v1-faithful, this does NOT throttle — one message per event, as applyInteractiveVerdict does.
   */
  private renderInteractiveResilienceEvent(
    e: AgentEvent,
    language: string,
    enqueue: (text: string, transient?: boolean) => void,
  ): void {
    this.engine.renderInteractiveResilienceEvent(e, language, enqueue);
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
  private trackToolError(chatId: string, toolName: string, isError: boolean, target?: string): void {
    if (!this.toolConsecutiveErrors.has(chatId)) this.toolConsecutiveErrors.set(chatId, new Map());
    const errs = this.toolConsecutiveErrors.get(chatId)!;
    const repeatKey = `${toolName}\u0000${target ?? ""}`;

    if (isError) {
      errs.set(toolName, (errs.get(toolName) ?? 0) + 1);
      errs.set(repeatKey, (errs.get(repeatKey) ?? 0) + 1);
    } else {
      // A success clears both: the tool works, and it works on this target.
      errs.delete(toolName);
      errs.delete(repeatKey);
    }
  }

  /**
   * Is this call worth refusing?
   *
   * Two questions, not one. The same call repeated is a loop and stops early.
   * The same TOOL failing on target after target is only evidence the tool is
   * broken once there have been many — an agent looking for files that are not
   * there is doing its job, and taking file_read away for it leaves the run
   * unable to read anything.
   */
  private toolIsCircuitBroken(chatId: string, toolName: string, target?: string): number | null {
    const errs = this.toolConsecutiveErrors.get(chatId);
    if (!errs) return null;

    const repeats = errs.get(`${toolName}\u0000${target ?? ""}`) ?? 0;
    if (repeats >= Orchestrator.MAX_CONSECUTIVE_TOOL_ERRORS) return repeats;

    const anyTarget = errs.get(toolName) ?? 0;
    return anyTarget >= Orchestrator.MAX_DISTINCT_TOOL_ERRORS ? anyTarget : null;
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
    // A goal tree used to force the supervisor unconditionally. The decomposer
    // is told to return a single-node tree when a task does not need splitting,
    // and it does — but nothing read that answer, so a one-goal tree still
    // bought capability triage, a node runner and a cross-provider verification
    // call, to run one agent loop. Read it: coordinate when there is something
    // to coordinate.
    const shouldForceSupervisor = warrantsSupervisor(params.goalTree);
    // GoalDecomposer.shouldDecompose is a length check — `prompt.length >= 60`,
    // and its own docstring calls it "a MINIMAL pre-filter: it only blocks
    // obviously trivial messages". It is a VETO, not an activator.
    //
    // It used to sit in this condition as `&& !isDecomposable`, which made it
    // sufficient on its own: any request longer than a tweet took the
    // supervisor path and the classifier's verdict was discarded. Measured,
    // "write one C# file under Assets/Scripts" is 113 characters and classifies
    // as code-generation/moderate — below the configured "complex" threshold,
    // so the classifier correctly said "no supervisor" and was overruled by the
    // length check. That routed a one-file edit through goal decomposition, a
    // wave planner and multi-agent dispatch.
    //
    // The classifier is the authority when there is one; the length heuristic
    // only stands in when there is not. Making length a hard veto instead would
    // be the opposite error — a genuinely complex short request ("refactor the
    // auth module") would be permanently denied the supervisor.
    //
    // Measured, with the threshold at "complex":
    //   "write one C# file under Assets/Scripts…"  113 chars, moderate -> direct
    //   the four-script Pixel Flow request          313 chars, complex  -> supervisor
    const isDecomposable = this.goalDecomposer?.shouldDecompose(coarsePlanningPrompt) ?? false;
    const meetsComplexity = classification
      ? this.shouldActivateSupervisor(classification)
      : isDecomposable;
    if (!shouldForceSupervisor && !meetsComplexity) {
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
        ...(params.onLiveness ? { onLiveness: params.onLiveness } : {}),
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


  setFrameworkPromptGenerator(generator: FrameworkPromptGenerator): void {
    this.frameworkPromptGenerator = generator;
    this.rebuildBaseSystemPrompt();
  }

  /**
   * Register a liveness signal fired after every tool execution.
   *
   * See IOrchestrator.setLivenessCallback: this hangs off tool execution rather
   * than any single control path, because a task running tools is not idle no
   * matter which path is driving it.
   */
  setLivenessCallback(callback: () => void): void {
    this.onLiveness = callback;
  }

  /**
   * Count what the vault holds for THIS project, for the tool-usage hint.
   *
   * Resolved by path rather than by registry presence: the self-vault of
   * Strada.Brain's own source is always registered, and counting it would tell
   * the agent this project is indexed when it is not — the exact mistake that
   * made the old hint counterproductive.
   *
   * listFiles() is synchronous by design here; the prompt is rebuilt on a
   * synchronous path and stats() is async.
   */
  private describeVaultAvailability(): VaultAvailability | undefined {
    if (!this.vaultRegistry || !this.projectPath) return undefined;
    try {
      const vault = this.vaultRegistry.resolveVaultForPath(this.projectPath);
      if (!vault) return { indexedFileCount: 0, frameworkFileCount: 0 };
      const files = vault.listFiles();
      const frameworkFileCount = files.filter((f) =>
        /(^|\/)Strada\.(Core|Modules)(\/|$)/i.test(f.path.replace(/\\/g, "/")),
      ).length;
      return { indexedFileCount: files.length, frameworkFileCount };
    } catch {
      // A vault that cannot be read is a vault the agent should not be sent to.
      return undefined;
    }
  }

  private rebuildBaseSystemPrompt(): void {
    const frameworkSection = this.frameworkPromptGenerator?.buildFrameworkKnowledgeSection();
    // Live section alone was a NAME LIST: namespaces and 40-per-namespace class
    // names, no usage contracts. Measured 2026-08-23 (PixelFlow): a run given
    // only that invented its own module shapes — Models/Systems folders, a
    // hand-rolled config — because nothing in context showed how ModuleConfig,
    // [Inject], [StradaSystem] or EntityMediator actually wire. The static
    // knowledge carries those contracts; the live list carries the current
    // inventory. A run needs BOTH.
    const knowledgeBase = frameworkSection
      ? STRADA_AGENT_PREAMBLE + frameworkSection + "\n\n" + STRADA_STATIC_FRAMEWORK_KNOWLEDGE
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
      buildToolUsageHints(this.describeVaultAvailability()) +
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



  private buildSupervisorExecutionStrategy(
    prompt: string,
    identityKey: string,
    fallbackProvider: IAIProvider,
    projectWorldFingerprint?: string,
  ): SupervisorExecutionStrategy {
    return buildSupervisorExecutionStrategyHelper(this.getSupervisorRoutingContext(), prompt, identityKey, fallbackProvider, projectWorldFingerprint);
  }

  /**
   * step5-parity (resurrected — deleted as "loop-only" but the CAPABILITY belongs to the engine):
   * a supervisor-assigned provider pin materializes a strategy with EVERY role on the pinned
   * provider+model and usesMultipleProviders=false, so a vision-pinned image subtask can never
   * silently run (and gate) on the identity default. Consumed by setupAgentCoreRun →
   * runCtx.fixedExecutionStrategy → prepareIteration's fixedExecutionStrategy param.
   */
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
    modelId?: string,
  ): void {
    this.engine.recordProviderUsage(providerName, usage, onUsage, modelId);
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
    this.engine.recordExecutionTrace(params);
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
    this.engine.recordPhaseOutcome(params);
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
      const synthesisResponse = await streamOrChatText(
        synthesisProvider,
        `${params.systemPrompt}\n\n${SUPERVISOR_SYNTHESIS_SYSTEM_PROMPT}${this.buildSupervisorRolePrompt(params.strategy, params.strategy.synthesizer)}`,
        synthesisRequest,
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
        params.strategy.synthesizer.modelId,
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
    executionResult: import("../goals/execution-result.js").ExecutionResult;
    chatId: string;
    conversationId?: string;
    userId?: string;
    channelType?: string;
    onUsage?: (usage: TaskUsageEvent) => void;
    childWorkerResults?: readonly WorkerRunResult[];
  }): Promise<string> {
    const identityKey = resolveIdentityKey(params.chatId, params.userId, params.conversationId, this.userProfileStore, params.channelType);
    const fallbackProvider = this.providerManager.getProvider(identityKey);

    // Per-user persona override (from profile, not global SoulLoader mutation) so the final
    // user-facing answer respects the user's selected persona, not just the global default.
    const synthesisProfile = this.userProfileStore?.getProfile(identityKey) ?? null;
    const synthesisPersonaContent = await this.resolvePersonaContent(synthesisProfile);

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
      // Use the full prompt with personality (soul) instead of the base systemPrompt.
      // Pass the per-user persona override (if any) so decomposed/multi-agent final
      // answers honor the selected persona; falls back to the global default soul.
      const soulEnrichedPrompt = injectSoulPersonality(
        this.getContextBuilderDeps(),
        this.systemPrompt,
        params.channelType,
        synthesisPersonaContent,
      );
      const synthesisResponse = await streamOrChatText(
        synthesisProvider,
        `${soulEnrichedPrompt}\n\n${SUPERVISOR_SYNTHESIS_SYSTEM_PROMPT}${this.buildSupervisorRolePrompt(strategy, strategy.synthesizer)}`,
        synthesisRequest,
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
        strategy.synthesizer.modelId,
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
    return this.engine.getLiveInteractiveTokenBudget();
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

  /**
   * GAP3 — the v2 background epoch-rollover side effects, replicating v1 runBackgroundTask's
   * end-of-epoch block VERBATIM over the run's runCtx deps. Called by
   * the spine EXACTLY ONCE per background epoch boundary (continue path AND the budget-exhausted
   * break path). NON-INTERACTIVE only. The spine owns the `consecutiveMaxTokens` reset (a spine local).
   *
   * Always (continue or stop):
   *  - recordPhaseOutcome({ status: continued ? "continued" : "blocked", … }) — phase telemetry that
   *    v1 emitted at every epoch boundary (the under-count this fix closes), keyed off the live
   *    executionStrategy.executor/.task (refreshed each step by prepareIteration) + agentState.phase.
   *  - persistExecutionMemory(identityKey, executionJournal) — durable journal flush per epoch.
   * Continue only (the auto-rollover into the next epoch):
   *  - taskPlanner.resetBudgetWindow() — without it the planner's budget window never resets (drift).
   *  - loop-detector amnesty: markVerificationClean IFF the epoch produced mutations, else PRESERVE
   *    the accumulated state (a no-mutation epoch is stalling — the detector should carry over).
   */
  private portOnEpochRollover(
    continued: boolean,
    epoch: number,
    agentState: AgentState,
    runCtx: AgentCorePortRunContext,
  ): void {
    // Phase telemetry (v1 runBackgroundTask end-of-epoch). recordPhaseOutcome strictly needs assignment + task; the live
    // executionStrategy is set by prepareIteration on every step, so after a completed inner `for` it
    // is present. Guard defensively so the load-bearing memory flush + planner reset below still run
    // even on the (unreachable in a real background run) no-strategy path.
    const executionStrategy = runCtx.executionStrategy;
    if (executionStrategy) {
      this.recordPhaseOutcome({
        chatId: runCtx.chatId,
        identityKey: runCtx.identityKey,
        assignment: executionStrategy.executor,
        phase: toExecutionPhaseModel(agentState.phase),
        status: continued ? "continued" : "blocked",
        task: executionStrategy.task,
        reason: continued
          ? "Background execution window reached its iteration budget and rolled into a new autonomous epoch."
          : "Background execution stopped after reaching the configured iteration budget.",
        telemetry: this.buildPhaseOutcomeTelemetry({
          state: agentState,
          projectWorldFingerprint: runCtx.projectWorldFingerprint,
        }),
      });
    }
    this.sessionManager.persistExecutionMemory(runCtx.identityKey, runCtx.executionJournal);

    if (!continued) return;

    runCtx.taskPlanner.resetBudgetWindow();
    // Only amnesty loop detection state if the epoch produced mutations. Without mutations, the agent
    // is stalling and the loop detector should carry its accumulated state across the epoch boundary
    // (v1 runBackgroundTask, continue-only).
    const controlLoopTracker = runCtx.controlLoopTracker;
    if (controlLoopTracker?.hadMutationsSinceLastReset()) {
      controlLoopTracker.markVerificationClean(agentState.iteration);
    } else {
      getLogger().warn("Epoch rolled without mutations — preserving loop detection state", {
        chatId: runCtx.chatId,
        epoch,
        readOnlyToolCalls: controlLoopTracker?.getConsecutiveReadOnlyToolCalls(),
      });
    }
  }

  /**
   * GAP4 — map a spine terminalReason to the resilience MessageKey for the terminal read-back
   * fallback (worker/background VERDICT-STOP terminals carry NO visible assistant message). Returns
   * `undefined` for a CLEAN terminal (done / end_turn / plan-review / goal-handoff / benign cancel /
   * unknown) so synthesizeFinal keeps the neutral "Task completed." — only a genuine stop surfaces a
   * reason. Reasons come from describeCancelReason (cancel-reason.ts:45) + the spine's literal
   * terminalReason assignments (v2-agent-runner.ts). A `failed` status without a recognized reason
   * still surfaces a generic abort (never a false success).
   */
  /**
   * Whether the run stopped because a provider has no quota left.
   *
   * The registry has known this all along — QUOTA_LIMIT_RE, recordQuotaExhausted,
   * a long cooldown in the fallback chain. The only place it was not known is
   * the sentence the user reads. Measured 2026-08-21: a run ended on Kimi's
   * "You've reached your usage limit for this billing cycle. Your quota will be
   * refreshed in the next cycle" and told the user "the AI provider is not
   * responding. Please try again later or switch to a different provider." The
   * provider had responded, precisely, and the advice was wrong.
   */
  private quotaStopped(): boolean {
    try {
      return isQuotaStop(ProviderHealthRegistry.getInstance().getAllEntries().values());
    } catch {
      // No registry, no claim: an unknown cause is not a quota cause.
      return false;
    }
  }

  private mapTerminalReasonToMessageKey(
    reason: string | undefined,
    status: TerminalStatus | undefined,
  ): MessageKey | undefined {
    if (reason) {
      // budget-exhausted:tokens | budget-exhausted:cost
      if (reason.startsWith("budget-exhausted")) {
        return reason.endsWith(":tokens") ? "token_budget_exceeded" : "provider_abort";
      }
      // provider-stall:* | hard-timeout:* | task-inactivity → provider not responding.
      if (
        reason.startsWith("provider-stall") ||
        reason.startsWith("hard-timeout") ||
        reason === "task-inactivity"
      ) {
        return "provider_abort";
      }
      // verdict-stop:health → abort; verdict-stop:loop-detected → stuck.
      if (reason.startsWith("verdict-stop")) {
        return reason.endsWith(":loop-detected") ? "task_stuck" : "provider_abort";
      }
      // ask_user terminals (gate or failure yielded "blocked").
      if (reason.includes("ask_user")) return "provider_ask_user";
      // persistent provider failure / max_tokens runaway / epoch-budget exhaustion → stuck.
      if (
        reason === "provider-failure" ||
        reason === "max-tokens-runaway" ||
        reason === "epoch-budget-exhausted"
      ) {
        return "task_stuck";
      }
      // 3.4 — background never reaches max-iterations here (it's interactive-only via the adapter),
      // but map it defensively to the localized notice rather than a false success.
      if (reason === "max-iterations") return "max_steps_reached";
      // A parent-cancelled wrapping a genuine cause → treat as abort (benign roots never reach here:
      // benign terminals carry a benign reason string but with a clean status, handled below).
      if (reason.startsWith("parent-cancelled")) return "provider_abort";
    }
    // Clean reasons (done / end_turn / plan-review / goal-handoff / user-cancel / task-winddown /
    // first-success-satisfied) → no message key (neutral fallback). But a hard-FAILED status with no
    // recognized reason must still avoid a false success.
    if (status === "failed") return this.quotaStopped() ? "provider_quota" : "provider_abort";
    return undefined;
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
      // The dotnet tools resolve availability once, at registration, from
      // whether the CLI is on PATH. That is half the precondition: a Unity
      // project has no .sln or .csproj until the Editor has generated them, and
      // `dotnet build` without one answers MSB1003. Measured across two runs —
      // three attempts, three MSB1003s — while unity_verify_change, which
      // compiles headlessly with no Editor, sat in the same block unused.
      if (DOTNET_PROJECT_TOOLS.has(definition.name) && !this.dotnetProject.check()) {
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

  /**
   * Absolute paths the user typed in their latest message for this chat.
   *
   * Read from the session each time rather than cached: the authorization is a
   * property of what the user just asked for, not of the run.
   */
  private userAuthorizedPathsFor(chatId: string, taskPrompt?: string): readonly string[] {
    // The run works from a task record, not from the chat session: measured, the
    // session under this chatId holds no user turn at all by the time a tool
    // runs (lastUserLength 0), so a session lookup can never see the request
    // that started the run. The task prompt is that request.
    const fromTask = extractUserAuthorizedPaths(taskPrompt ?? "");
    if (fromTask.length > 0) {
      const existing = this.authorizedPathsByChat.get(chatId) ?? [];
      this.authorizedPathsByChat.set(chatId, [...new Set([...existing, ...fromTask])]);
      return this.authorizedPathsByChat.get(chatId)!;
    }

    const remembered = this.authorizedPathsByChat.get(chatId);
    if (remembered && remembered.length > 0) return remembered;

    try {
      const session = this.sessionManager.getOrCreateSession(chatId);
      return extractUserAuthorizedPaths(this.sessionManager.extractLastUserMessage(session));
    } catch {
      // No session, no authorization — the restrictive answer.
      return [];
    }
  }

  /**
   * Record the paths this message names, before anything else runs.
   *
   * The authorization is still the user's: it comes from text they wrote, and
   * only ever grows from real incoming messages.
   */
  /**
   * Carry paths the user authorized into a run that did not receive their
   * message.
   *
   * The authorization is evidence of what the user typed, and it lived in
   * per-instance memory. Delegation builds a NEW Orchestrator (delegation
   * manager, agent manager), so a delegated worker started with an empty map
   * and refused the very file the request named. Measured 2026-08-20: the run
   * decomposed into multi-agent work and the first read of
   * /Users/okan/Downloads/PixelFlow_GDD.docx came back "Path resolves outside
   * the project directory" — the document the task was about.
   *
   * Only ever widens, and only with paths the parent already holds: a worker
   * cannot authorize itself.
   */
  /**
   * The store itself, so sub-agent orchestrators can share it rather than each
   * trying to re-derive authorization from a prompt that no longer carries it.
   */
  authorizationStore(): Map<string, readonly string[]> {
    return this.authorizedPathsByChat;
  }

  seedUserAuthorizedPaths(chatId: string, paths: readonly string[]): void {
    if (paths.length === 0) return;
    const existing = this.authorizedPathsByChat.get(chatId) ?? [];
    this.authorizedPathsByChat.set(chatId, [...new Set([...existing, ...paths])]);
  }

  /** Paths this run may read on the user's authority, for handing to a delegate. */
  userAuthorizedPathsSnapshot(chatId: string): readonly string[] {
    return this.authorizedPathsByChat.get(chatId) ?? [];
  }

  private rememberAuthorizedPaths(msg: IncomingMessage): void {
    const text = typeof msg.text === "string" ? msg.text : "";
    const named = extractUserAuthorizedPaths(text);
    if (named.length === 0) return;

    const existing = this.authorizedPathsByChat.get(msg.chatId) ?? [];
    this.authorizedPathsByChat.set(msg.chatId, [...new Set([...existing, ...named])]);
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
    this.rememberAuthorizedPaths(msg);
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
    // Whole-goal monitor unit: when this run was spawned by a parent goal that fanned
    // out across agents (msg.monitorScope set to the originating request's scope), its
    // monitor events JOIN the parent episode rather than minting a sibling conversation.
    // MONITOR-only — the AGENT chatId/session/identity above stay fresh by design. A
    // root run (no override, or override === own scope) owns episode create + terminal.
    const monitorScope = msg.monitorScope?.trim() || undefined;
    const isMonitorRootRun = !monitorScope || monitorScope === conversationScope;

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

    // Monitor lifecycle: emit simple DAG so monitor workspace always shows something.
    // A root run opens/continues its own episode; a re-scoped worker/agent run JOINs the
    // parent goal's open episode (no sibling conversation) and is monitor-silent if none
    // is open — only the whole-goal root owns episode creation.
    const conversationScopeForMonitor = resolveConversationScope(chatId, conversationId);
    if (isMonitorRootRun) {
      this.monitorLifecycle?.requestStart(conversationScopeForMonitor, text);
    } else {
      this.monitorLifecycle?.joinEpisode(conversationScopeForMonitor, text, monitorScope);
    }

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

    let runFailed = false;
    let terminalKey: string | undefined;
    try {
      // Agent Core v2 interactive driver — THE engine (cutover Step 5 deleted the v1
      // runAgentLoop and its route flag; every interactive turn runs the spine through the
      // real port). The persistent session and the wrapper (typing indicator + monitor +
      // persistence in the finally below) are unchanged from v1. Bare block keeps the
      // driver's locals scoped exactly as the old flag branch did.
      {
        //
        // `deliverFinal` is a NO-OP under the faithful port: the dispatch handlers
        // (portDispatchEndTurn/portDispatchReflection → emitVisibleBoundary →
        // sendVisibleAssistantMarkdown) ALREADY render the terminal answer to the channel DURING
        // the run; `synthesizeFinal` only reads it back into `AgentRunResult.finalText`. Rendering
        // here too would double-render. `externalSignal` is a never-aborting signal (interactive has
        // no user-cancel in v1) — built FRESH per turn, deliberately NOT hoisted to a shared module
        // constant, so any abort listener a provider call attaches (fetch/AbortSignal.any) is released
        // when this run is GC'd rather than accumulating on a long-lived signal. The AgentRunResult is
        // discarded — the port already rendered the answer, and the finally block persists the transcript.
        //
        // `onEvent` (increment 3.2): the spine's user-facing resilience events (backoff / ask_user /
        // show_plan / failed→abort) reach here via the bus→ioSink seam (control-plane.ts); v1 rendered
        // the equivalents inline in applyInteractiveVerdict (:1459-1487). Without this adapter they'd be
        // INVISIBLE on the v2 path. Renders are async but onEvent is sync and must NOT block the bus
        // (the BoundedSink contract), so they fire through an ordered tail-promise chain that we drain
        // (await renderTail) after the run — guaranteeing order + a complete persisted transcript.
        const runner = selectAgentRunner(this as unknown as RunnerHostOrchestrator, "interactive");
        const interactiveLang = (this.userProfileStore?.getProfile(identityKey)?.language ??
          this.defaultLanguage) as string;
        let renderTail: Promise<void> = Promise.resolve();
        const enqueueRender = (renderText: string, transient = false): void => {
          renderTail = renderTail
            .then(() =>
              // Transient mid-run status (backoff → provider_slow) goes to a system
              // pill and is NOT recorded to the transcript; terminal explanations and
              // interactive prompts stay recorded, visible answers. Both sinks append
              // to the same ordered tail-promise chain (drained by `await renderTail`).
              transient
                ? this.sessionManager.sendVisibleAssistantNotice(chatId, session, renderText)
                : this.sessionManager.sendVisibleAssistantMarkdown(chatId, session, renderText),
            )
            .catch((err) => {
              logger.warn("v2 interactive resilience render failed", {
                chatId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
        };
        const io: IOStrategy = {
          mode: "interactive",
          onEvent: (e) =>
            this.renderInteractiveResilienceEvent(e as unknown as AgentEvent, interactiveLang, enqueueRender),
          externalSignal: new AbortController().signal,
          deliverFinal: () => {},
        };
        const request: AgentRunRequest = {
          prompt: this.sessionManager.extractLastUserMessage(session) || text,
          chatId,
          channelType: msg.channelType,
          conversationId,
          userId,
          attachments: msg.attachments,
          interactiveSession: session,
        };
        // The run's own verdict, not a side channel. The V2 spine returns a
        // terminal rather than throwing, and the injected mapper is a
        // background-only hook the interactive path never reaches (port.ts:312
        // returns early whenever the session already holds an assistant reply,
        // which is the normal state of any conversation past its first turn).
        const runResult = await runner.run(request, io);
        terminalKey = this.mapTerminalReasonToMessageKey(runResult?.reason, runResult?.status);
        await renderTail; // drain the ordered resilience renders before the finally persists the transcript
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Unknown error";
      logger.error("Agent loop error", { chatId, error: errMsg });
      runFailed = true;
      await this.sessionManager.sendVisibleAssistantText(chatId, session, classifyErrorMessage(error));
    } finally {
      // A root run marks its episode terminal (rolls the workspace over on the next
      // request); a re-scoped worker run settles ONLY its own joined card via
      // joinEpisodeEnd so it never prematurely terminates the shared parent episode —
      // the whole-goal episode stays open until the ROOT run's requestEnd.
      if (isMonitorRootRun) {
        this.monitorLifecycle?.requestEnd(
          resolveConversationScope(chatId, conversationId),
          runFailed || isFailedTerminalKey(terminalKey),
        );
      } else {
        this.monitorLifecycle?.joinEpisodeEnd(resolveConversationScope(chatId, conversationId), false, monitorScope);
      }
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


  /** Propagate instinct IDs to the channel adapter for feedback attribution. */
  private propagateInstinctIdsToChannel(chatId: string, instinctIds: string[]): void {
    const ch = this.channel as unknown as Record<string, unknown>;
    if (typeof ch.setAppliedInstinctIds === "function") {
      (ch.setAppliedInstinctIds as (chatId: string, ids: string[]) => void)(chatId, instinctIds);
    }
  }

  /**
   * Issue #22 (SIBLING A) — the IN-RUN trajectory-credit trigger (the trigger the groundwork in
   * b794552 reserved for; default-OFF ⇒ this whole method is gated off ⇒ byte-identical to today).
   *
   * Fires from BOTH terminal hooks (v1 runAgentLoop finally, v2 persistTerminal) on a SUCCESSFUL
   * terminal, BEFORE {@link currentSessionInstinctIds}.delete clears the run's participating set.
   * Hands recordTrajectory the FULL participating set + the run's REAL minted taskRunId + the run's
   * REAL per-step results; recordTrajectory's existing computeTrajectoryCreditIds takes the DISJOINT
   * complement (only the per-turn-skipped planning/strategy instincts) and the existing
   * autoGenerateVerdict reinforces exactly that subset (no double-count).
   *
   * WHY this is the CORRECT trigger (and the route-level endTask is NOT — see doubleRecordResolution):
   *  - steps: the run's REAL StepResult[] (passed in from AgentState.stepResults). The bundle
   *    TaskPlanner's getTrajectorySteps() is EMPTY here — startTask is never called on the per-run
   *    bundle planner, so trackToolCall's `if (isTaskActive)` step-push is skipped — so the disjoint
   *    computation MUST be fed the real step tool names, or every participating instinct would wrongly
   *    look disjoint. The route-level planner's steps are likewise empty (obs 32423).
   *  - taskRunId: getTaskExecutionContext()?.taskRunId — the run's real minted T2 (same source
   *    persistExecutionMemory/metrics use), NOT the route-level T1 minted before the run.
   *  - appliedInstinctIds: the run's POPULATED participating set (currentSessionInstinctIds.get) —
   *    the route-level path fires at buffer time before the run and cannot supply it.
   *
   * Success-only: a benign-cancel / FAILED terminal passes success=false so autoGenerateVerdict
   * (recordTrajectory: `outcome.success && !hadErrors`) never reinforces a non-successful run.
   */
  private recordInRunTrajectoryCredit(params: {
    chatId: string;
    sessionId: string;
    taskDescription: string;
    success: boolean;
    finalOutput?: string;
    stepResults: readonly StepResult[];
  }): void {
    const pipeline = this.learningPipeline;
    // Gated off by default ⇒ zero extra work ⇒ byte-identical. Also short-circuit non-success: the
    // disjoint credit is reserved for clean successful runs (mirrors recordTrajectory's verdict gate).
    if (!pipeline?.isTrajectoryLevelCreditEnabled() || !params.success) {
      return;
    }
    // The run's participating instinct set — read here, BEFORE the caller's
    // currentSessionInstinctIds.delete. Empty ⇒ nothing to credit ⇒ skip (no empty trajectory row).
    const appliedInstinctIds = this.currentSessionInstinctIds.get(params.chatId) ?? [];
    if (appliedInstinctIds.length === 0) {
      return;
    }
    // Map the run's REAL per-step results to the minimal TrajectoryStep shape the disjoint
    // computation needs (it reads step.toolName; success/error result kept faithful for the row).
    // NOTE: input:{}, durationMs:0 here (and the outcome's durationMs:0/completionRate:1 below) are
    // persisted-row padding to satisfy the Trajectory shape — NOT load-bearing for credit, which
    // reads only step.toolName + outcome.success/hadErrors.
    const steps: TrajectoryStep[] = params.stepResults.map((sr, i) => ({
      stepNumber: i + 1,
      toolName: sr.toolName as TrajectoryStep["toolName"],
      input: {} as TrajectoryStep["input"],
      result: sr.success
        ? { kind: "success", output: sr.summary }
        : { kind: "error", error: { category: "unknown", message: sr.summary } },
      timestamp: sr.timestamp as TrajectoryStep["timestamp"],
      durationMs: 0 as TrajectoryStep["durationMs"],
    }));
    // Derive the error tally once from the source results (the discriminant the mapped step.result
    // carries is set from sr.success above, so reading the source avoids a double traversal).
    const errorCount = params.stepResults.filter((sr) => !sr.success).length;
    const outcome: TrajectoryOutcome = {
      success: params.success,
      finalOutput: params.finalOutput,
      totalSteps: steps.length,
      hadErrors: errorCount > 0,
      errorCount,
      durationMs: 0 as TrajectoryOutcome["durationMs"],
      completionRate: 1 as TrajectoryOutcome["completionRate"],
    };
    pipeline.recordTrajectory({
      sessionId: params.sessionId,
      chatId: params.chatId,
      // The run's OWN minted taskRunId (T2), not the route-level T1.
      taskRunId: this.getTaskExecutionContext()?.taskRunId,
      taskDescription: params.taskDescription,
      steps,
      outcome,
      // The FULL participating set; recordTrajectory credits only the disjoint complement.
      appliedInstinctIds: [...appliedInstinctIds],
    });
  }

  /** Record a metric end event (idempotent — endTask is a no-op for already-completed or unknown IDs) */

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
        systemPromptEstimate: systemPrompt ? estimateTextTokens(systemPrompt) : 0,
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
  /**
   * Whether a streaming error means this provider will refuse the next call too.
   *
   * The non-streaming fallback exists for a streaming GLITCH — the socket died,
   * the stream went silent — and retrying the same provider without streaming
   * is the right answer to that. It is the wrong answer to a refusal: a quota
   * 403 will refuse the second call exactly as it refused the first.
   *
   * Measured 2026-08-21, run 31: six Kimi calls in twenty-five seconds, six
   * 403s, alternating streaming and non-streaming, with the quota exhausted
   * before the run began. Every second call was spent asking a provider that
   * had just said no whether it still meant it.
   */
  private isProviderRefusal(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (/\b(?:401|403|429)\b/.test(message)) return true;
    return QUOTA_LIMIT_RE.test(message) && /error|refus|denied|insufficient/i.test(message);
  }

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
        // A refusal will refuse again. Record it so the health registry marks
        // this provider down and the chain stops choosing it, then rethrow so
        // the failover happens now rather than after a second wasted call.
        if (this.isProviderRefusal(err)) {
          const detail = err instanceof Error ? err.message : String(err);
          recordProviderHealthFailure(ProviderHealthRegistry.getInstance(), provider.name, detail, {
            isSingleProvider: isSingleProviderChain(provider),
          });
          getLogger().warn("Provider refused; not retrying it without streaming", {
            chatId,
            provider: provider.name,
          });
          throw err;
        }
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
        // Thread the project root so the deterministic project-scoped allowlist
        // can pre-approve canonical build/test/run commands (Unity batchmode,
        // dotnet build) before the LLM reviewer — the gate/reviewer deadlock
        // measured on 2026-08-23 must not recur.
        return this.reviewShellCommandWithProvider(chatId, command, mode, { ...options, projectPath: this.projectPath }, input);
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
      case "batch_execute": {
        // A second dispatch path: batch_execute calls tool.execute on each of
        // its operations directly, so none of them passes executeSingleToolCall
        // and none reaches the cases above. Before this case existed the batch
        // fell to `default` and was stamped approved without the operations
        // array ever being read — measured, 368 writes reached disk that way,
        // more than went through the gated path.
        const parsed = parseBatchOperations(input);
        if (parsed.kind === "unreviewable") {
          return { approved: false, reason: `batch cannot be reviewed: ${parsed.reason}` };
        }
        return this.reviewBatchedOperations(chatId, parsed.operations, mode, options);
      }
      default:
        return { approved: true };
    }
  }

  /**
   * Apply the direct-call rules to each operation a batch would dispatch.
   *
   * One refusal refuses the batch: the operations run in sequence against a
   * shared workspace, so approving the ones before a refused write would leave
   * the project half-changed by a batch the agent was told it could not run.
   */
  private async reviewBatchedOperations(
    chatId: string,
    operations: readonly BatchOperation[],
    mode: ToolExecutionMode,
    options: ToolExecutionOptions,
  ): Promise<SelfManagedWriteReview> {
    for (const operation of operations) {
      // Reads inside a batch are as free as reads outside one.
      if (!this.isWriteOperation(operation.tool)) continue;

      const review = await this.reviewSelfManagedWriteOperation(
        chatId,
        operation.tool,
        operation.input,
        mode,
        options,
      );
      if (!review.approved) {
        return {
          approved: false,
          reason: `batched ${operation.tool} was refused: ${review.reason ?? "no reason given"}`,
        };
      }
    }
    return { approved: true };
  }





  private recordAuxiliaryUsage(
    provider: string,
    usage: ProviderResponse["usage"] | undefined,
    sink?: (usage: TaskUsageEvent) => void,
  ): void {
    this.engine.recordAuxiliaryUsage(provider, usage, sink);
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

    // Honor a single-provider / hard-pinned strategy exactly: materialize the BARE pinned
    // provider AND model (getPrimaryProviderByName → buildPrimaryProvider, the same strict
    // materialization ProviderManager.getProvider uses for hard pins). getProviderByName would
    // build a resilient FALLBACK CHAIN over the pin — which both ignores the pin and, worse,
    // can silently re-send a PRIVATE/local-pinned conversation to a cloud sibling when the
    // pinned model stalls (trio-review HIGH). `?? null` (NOT the chain) on a missing method:
    // the caller's `?? currentProvider` then uses the assignment provider, which for a hard
    // pin IS the strictly-materialized pin.
    if (options?.usesMultipleProviders === false) {
      return (
        this.providerManager as {
          getPrimaryProviderByName?: (name: string, model?: string) => import("./providers/provider.interface.js").IAIProvider | null;
        }
      ).getPrimaryProviderByName?.(primaryName, modelId) ?? null;
    }
    // No router / no task classification → keep v1's resilient single-name materialization.
    if (!this.providerRouter || !task) {
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
    return this.engine.runVisibilityReview(params);
  }


  private async reviewShellCommandWithProvider(
    chatId: string,
    command: string,
    mode: ToolExecutionMode,
    options: ToolExecutionOptions,
    input: Record<string, unknown>,
  ): Promise<SelfManagedWriteReview> {
    return this.engine.reviewShellCommandWithProvider(chatId, command, mode, options, input);
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
      // Survives the lease swap above, so vault lookups still resolve to the
      // project the vault is registered against.
      sourceProjectPath: this.projectPath,
      // Files the user named in their own message, readable on that authority
      // even when they sit outside the project. Derived per call from the
      // session, so it is always this chat's most recent request and never
      // accumulates across conversations.
      userAuthorizedPaths: this.userAuthorizedPathsFor(chatId, options.taskPrompt),
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
      vaultRegistry: this.vaultRegistry,
    };

    // SPEED (intelligence-neutral): the LLM frequently batches several INDEPENDENT read-only tool
    // calls in a single turn (e.g. 3× file_read, grep + list_directory). Running them strictly
    // serial wastes wall-clock on I/O-bound waits that have no ordering dependency. We parallelize
    // ONLY the LEADING contiguous run of parallel-safe calls (read-only, not a write op, not
    // ask_user, not a registry-mutating control tool), then fall back to the existing serial loop
    // the instant a non-safe call appears — so a read AFTER a write in the same turn stays serial,
    // and every write/confirm/ask_user remains strictly ordered. Each parallel call still passes
    // through the FULL per-call gate chain (interactive resolution, read-only block, vault
    // interceptor, auto-disable, policy, intervention engine, guardExecute, trackToolError) — we cut
    // idle wait, never a gate or a reasoning pass. Results are keyed by toolCallId, and we assign
    // them back into `results` in the original toolCall order so the LLM's id-association and the
    // array order are both preserved exactly as the serial path produced them.
    let boundary = 0;
    for (const candidate of toolCalls) {
      if (!this.isParallelSafeToolCall(candidate)) break;
      boundary++;
    }

    if (boundary >= 2) {
      // Reserve a contiguous, deterministic substep-order block for the parallel group so the
      // emitted substep labels stay monotonic and match the serial-path ordering (the group runs
      // concurrently, but each call gets a stable pre-assigned order index).
      const parallelGroup = toolCalls.slice(0, boundary);
      const baseOrder = substepOrder;
      substepOrder += parallelGroup.length;
      const parallelResults = await Promise.all(
        parallelGroup.map((tc, idx) =>
          this.executeSingleToolCall(tc, baseOrder + idx, {
            chatId,
            mode,
            options,
            toolContext,
            goalCtx,
            logger,
          }),
        ),
      );
      results.push(...parallelResults);
    } else {
      // Fewer than 2 leading safe calls → nothing to parallelize; let the serial loop handle all.
      boundary = 0;
    }

    const remaining = toolCalls.slice(boundary);
    for (const tc of remaining) {
      const order = substepOrder;
      substepOrder++;
      const result = await this.executeSingleToolCall(tc, order, {
        chatId,
        mode,
        options,
        toolContext,
        goalCtx,
        logger,
      });
      results.push(result);
    }

    return results;
  }

  /**
   * A tool call is SAFE to run concurrently with its siblings in the same turn iff it is read-only,
   * not a write operation, not the interactive `ask_user` control tool, and not a tool that mutates
   * the dynamic tool registry. Anything we cannot positively classify as read-only is treated as
   * NOT parallel-safe (serial) — the conservative default. This gates only EXECUTION CONCURRENCY;
   * it never changes which tools run, their gating, or any reasoning.
   */
  private isParallelSafeToolCall(tc: ToolCall): boolean {
    const name = tc.name;
    if (name === "ask_user" || name === "show_plan") return false;
    if (WRITE_OPERATIONS.has(name)) return false;
    // create_skill mutates this.tools via a toolContext callback; keep it serial
    // so concurrent registrations never race.
    if (name === "create_skill") {
      return false;
    }
    // Require a POSITIVE read-only classification from the flattened metadata cache (which already
    // merges registration + intrinsic metadata with a WRITE_OPERATIONS fallback). Unknown → serial.
    return this.toolMetadataByName.get(name)?.readOnly === true;
  }

  /**
   * Execute ONE tool call through the full per-call gate chain and return its {@link ToolResult}.
   * Extracted verbatim from the body of {@link executeToolCalls}'s serial loop so the SAME pipeline
   * runs whether a call is dispatched serially or as part of the parallel leading group — only the
   * idle wait between independent read-only calls is removed, never a gate or a reasoning step.
   * `order` is the pre-assigned substep order index (so concurrent calls keep stable, monotonic
   * substep labels). Returns exactly one result for every input call (every branch produces one).
   */
  private async executeSingleToolCall(
    tc: ToolCall,
    order: number,
    ctx: {
      chatId: string;
      mode: ToolExecutionMode;
      options: ToolExecutionOptions;
      toolContext: ToolContext & { soulLoader?: SoulLoader | null; userProfileStore?: UserProfileStore };
      goalCtx?: import("../tasks/types.js").GoalContext;
      logger: ReturnType<typeof getLogger>;
    },
  ): Promise<ToolResult> {
    const { chatId, mode, options, toolContext, goalCtx, logger } = ctx;

    // The phase's write restriction used to live only in
    // buildWorkerToolDefinitions — that is, in what the model was SHOWN. A write
    // named in a response anyway went straight to the tool, because the rule was
    // a property of the menu rather than of the kitchen. Same shape as the
    // batch_execute hole: a restriction enforced on one path, and everything
    // arriving by another path exempt by construction.
    //
    // Applied only where the phase is known, so callers that attach no agent
    // state keep their behaviour; this tightens a known case rather than
    // guessing at unknown ones.
    const phase = options.agentState?.phase;
    if (
      phase !== undefined &&
      !PHASES_ALLOWING_WRITES.has(phase) &&
      this.isWriteOperation(tc.name) &&
      !SELF_IMPROVEMENT_TOOLS.has(tc.name)
    ) {
      return {
        toolCallId: tc.id,
        content:
          `Write operations are not available while the agent is ${phase}. ` +
          `Finish planning or reflecting first; writes run in the executing phase.`,
        isError: true,
      };
    }

    let activeToolCall = tc;
    const interactiveResolution = await this.resolveInteractiveToolCall(
      chatId,
      activeToolCall,
      mode,
      options.taskPrompt,
      options.userId,
    );
    if (interactiveResolution) {
      return interactiveResolution;
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
          return {
            toolCallId: activeToolCall.id,
            content:
              clarificationIntervention.gate ?? "Continue internally without asking the user yet.",
            isError: false,
          };
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
      return createReadOnlyToolStub(activeToolCall.name, activeToolCall.id);
    }

    const tool = this.tools.get(activeToolCall.name);
    if (!tool) {
      return {
        toolCallId: activeToolCall.id,
        content: `Error: unknown tool '${activeToolCall.name}'`,
        isError: true,
      };
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
              return {
                toolCallId: activeToolCall.id,
                content: intercepted.content,
                isError: false,
                metadata: intercepted.metadata,
              };
            }
          }
        }
      }
    }

    // Auto-disable tools that have failed repeatedly in this chat.
    //
    // Except the ones whose job is to report failure. A verification tool
    // answers isError when the VERIFICATION failed, not when the tool did:
    // measured, unity_verify_change ran its headless compile perfectly three
    // times, reported 27 compile errors each time, and was taken away from the
    // run for being unreliable. The agent was then left writing C# with no way
    // to find out whether it compiles — which is the state this tool exists to
    // prevent.
    const toolErrorCount = this.toolIsCircuitBroken(
      chatId,
      activeToolCall.name,
      failureTarget(activeToolCall.input),
    );
    if (toolErrorCount !== null && !isVerificationToolName(activeToolCall.name)) {
      return {
        toolCallId: activeToolCall.id,
        content: `Tool '${activeToolCall.name}' has failed ${toolErrorCount} consecutive times and is temporarily disabled for this conversation. Use a different approach or tool.`,
        isError: true,
      };
    }

    const toolMeta = this.toolMetadataByName.get(activeToolCall.name);
    if (toolMeta?.available === false) {
      return {
        toolCallId: activeToolCall.id,
        content: toolMeta.availabilityReason || `Tool '${activeToolCall.name}' is currently unavailable.`,
        isError: true,
      };
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
        return createReadOnlyToolStub(activeToolCall.name, activeToolCall.id);
      }

      const pendingWriteBlock = this.interactionPolicy.getWriteBlock(chatId, activeToolCall.name);
      if (pendingWriteBlock) {
        return {
          toolCallId: activeToolCall.id,
          content:
            `Plan approval is still required before '${activeToolCall.name}' can run. ` +
            `Reason: ${pendingWriteBlock.reason}. Revise or reshow the plan, or wait for the user to approve it first.`,
          isError: true,
        };
      }

      return {
        toolCallId: activeToolCall.id,
        content: executionPolicy.reason,
        isError: true,
      };
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
          return this.buildSelfManagedWriteRejection(
            activeToolCall.id,
            activeToolCall.name,
            mode,
            review.reason ?? "operation did not pass local safety review",
          );
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
            return {
              toolCallId: activeToolCall.id,
              content: "Operation cancelled by user.",
              isError: false,
            };
          }
        }
      }
    }

    const toolStart = Date.now();
    const substepId = `${activeToolCall.name}-${order}`;

    const emitSubstep = (status: "active" | "done" | "skipped"): void => {
      if (goalCtx && this.workspaceBus) {
        this.workspaceBus.emit("monitor:substep", {
          rootId: goalCtx.rootId,
          nodeId: goalCtx.nodeId,
          substep: { id: substepId, label: activeToolCall.name, status, order: order + 1 },
        });
      }
    };

    emitSubstep("active");

    try {
      // Phase 3b write-path guard (flag-gated, ADDITIVE): run the tool through guardExecute so a
      // down + un-revivable substrate capability returns the typed BLOCKED contract, and a real
      // success/failure feeds the registry's health. Unwired (flag off) → the plain call below,
      // byte-identical. A `down` substrate first gets ONE revive attempt via the per-capability
      // adapter (mcp:strada → bridge lazy-reconnect, wired by bootstrap); only an absent adapter or
      // a failed revive BLOCKs. The orchestrator's flattened toolMetadataByName carries only
      // `requiresBridge`, so the binding here distinguishes the bridge from in-process.
      let result: ToolExecutionResult;
      if (this.capabilityRegistry) {
        const capabilityId = capabilityForTool({ requiresBridge: toolMeta?.requiresBridge });
        const guarded = await guardExecute({
          registry: this.capabilityRegistry,
          capabilityId,
          adapter: this.capabilityAdapters?.get(capabilityId),
          run: () => tool.execute(activeToolCall.input, toolContext),
        });
        if (guarded.kind === "blocked") {
          // BLOCKED is non-progress, non-fatal — NOT counted as a tool error (mirrors the available
          // gate above), so it never trips the consecutive-error disable. Sanitized for parity with
          // the success path: the BLOCKED reason can embed a substrate transport-error fragment, so
          // redact/de-inject it defensively rather than push it raw.
          emitSubstep("skipped");
          return {
            toolCallId: activeToolCall.id,
            content: sanitizeToolResult(formatBlocked(guarded.blocked)),
            isError: true,
          };
        }
        result = guarded.value;
      } else {
        result = await tool.execute(activeToolCall.input, toolContext);
      }
      const toolDurationMs = Date.now() - toolStart;
      // A tool just ran: whatever else is true, this task is not hung. Fired
      // before anything that can throw, and regardless of the tool's outcome —
      // a failing tool is still activity, and a task retrying a failure is
      // exactly the case the watchdog must not mistake for silence.
      this.onLiveness?.();
      this.metrics?.recordToolCall(activeToolCall.name, toolDurationMs, !result.isError, result.isError ? String(result.content).slice(0, 200) : undefined);
      // Log the OUTCOME, not just the attempt.
      //
      // "Executing tool" was logged and nothing else, so a call that failed, was
      // rejected, or wrote to somewhere unexpected looked identical in the logs
      // to one that worked. That cost three live agent runs and a temporary
      // console.error patched into file_write to discover that writes were
      // landing in a leased temp workspace and being deleted — the logs alone
      // could not distinguish "wrote the file" from "wrote it into the void".
      //
      // Preview only: results can be whole files. The logger's redaction format
      // runs over this like any other field.
      logger.debug("Tool executed", {
        chatId,
        tool: activeToolCall.name,
        durationMs: toolDurationMs,
        isError: Boolean(result.isError),
        resultPreview: String(result.content ?? "").slice(
          0,
          result.isError ? TOOL_FAILURE_LOG_PREVIEW : TOOL_RESULT_LOG_PREVIEW,
        ),
      });
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

      this.trackToolError(chatId, activeToolCall.name, !!result.isError, failureTarget(activeToolCall.input));

      return {
        toolCallId: activeToolCall.id,
        content: sanitizeToolResult(result.content),
        isError: result.isError,
        metadata: result.metadata,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Unknown error";
      this.metrics?.recordToolCall(activeToolCall.name, Date.now() - toolStart, false, errMsg.slice(0, 200));
      logger.error("Tool execution error", {
        chatId,
        tool: activeToolCall.name,
        error: errMsg,
      });
      emitSubstep("skipped");

      this.trackToolError(chatId, activeToolCall.name, true, failureTarget(activeToolCall.input));

      return {
        toolCallId: activeToolCall.id,
        content: `Tool execution failed: ${classifyErrorMessage(error)}`,
        isError: true,
      };
    }
  }

  /**
   * Whether a tool call can change the project.
   *
   * A fixed allowlist cannot answer this for tools that did not exist when the
   * list was written. Tools registered at runtime are not in WRITE_OPERATIONS,
   * so every one of them read as non-write and skipped read-only mode, the
   * plan-review gate and write confirmation alike.
   *
   * Measured: an agent registered `dynamic_write_minified_file` — a shell-backed
   * file writer — and the policy classified it "non-write operations execute
   * without interactive confirmation". It then wrote five .asmdef files through
   * a shell, which ate the JSON quoting, and reported success on all five. The
   * project was left with four assembly definitions Unity cannot parse.
   *
   * So: the allowlist first, then what the tool says about itself, and for a
   * tool that says nothing, its shape. The default leans to "writes" because the
   * costs are lopsided — an unnecessary confirmation is a prompt, an unguarded
   * write is a corrupted project, and in read-only mode it is a broken promise.
   */
  private isWriteOperation(toolName: string): boolean {
    if (WRITE_OPERATIONS.has(toolName)) return true;

    // Registration is where this is decided — see registerTool, which applies the
    // allowlist, the tool's own declaration, and finally its shape. Reading the
    // result here keeps one source of truth instead of two that can disagree.
    return this.toolMetadataByName.get(toolName)?.readOnly === false;
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
        // Last resort for a tool nobody described: the allowlist AND its shape.
        // `!WRITE_OPERATIONS.has(name)` alone declared every runtime-registered
        // tool read-only, which is how a shell-backed file writer came to run
        // with no confirmation and corrupt five .asmdef files.
        (!WRITE_OPERATIONS.has(tool.name) && !looksLikeWriteTool(tool.name, tool)),
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
      goalStorage: this.goalStorage,
    };
  }

  private async runProactiveGoalDecomposition(opts: {
    conversationScope: string;
    userMessage: string;
    chatId: string;
    session: Session;
    agentState: AgentState;
  }): Promise<AgentState> {
    // Thread the resolved user language so a provider-outage notice surfaced from the
    // helper (all-providers-failed during decomposition) is localized, not hardcoded EN.
    return runProactiveGoalDecompositionHelper(this.goalDecompositionDeps, {
      ...opts,
      language: this.defaultLanguage,
    });
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

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // Agent Core v2 — OrchestratorPort implementation (Phase 2d-2). COMPOSE+ADAPT only.
  //
  // createAgentCorePort() returns the bound-method surface V2AgentRunner drives. Each method
  // DELEGATES to an existing private method (a pure reader) or ADAPTS an existing handler's
  // action-union to the flat V2 DTO at the binding. No v1 method body changes; the port only
  // READS. The whole tool turn is owned by the port's bound executeToolCalls closure (the V1
  // free-helper sequence), so the spine stays shape-agnostic and the V2 unit tests stay green.
  //
  // DEFAULT-ON since THE FLIP: this port serves ALL production routes (the shipped default is
  // v2-all-routes+full-control-plane); v1 is reachable only via the revert flag sets.
  // ═══════════════════════════════════════════════════════════════════════════════════════

  /** The resolved agent-core flag set, read by the route selector. undefined ⇒ a test constructed the
   *  orchestrator without one; bootstrap always passes a set (production default:
   *  `PRODUCTION_DEFAULT_FLAG_SET_ID` = v2-all-routes+full-control-plane since THE FLIP). */
  getAgentCoreFlagSet(): FlagSet | undefined {
    return this.agentCoreFlagSet;
  }

  /** The injected agent-core clock (SystemClock in prod, FakeClock in tests). */
  getAgentCoreClock(): Clock {
    return this.agentCoreClock;
  }

  /** The capability registry, when wired (Phase 3b). undefined when the flag is off. */
  getCapabilityRegistry(): CapabilityRegistry | undefined {
    return this.capabilityRegistry;
  }

  /**
   * Build the OrchestratorPort + the gateway/seed/health factory the V2 runner needs. The port
   * closes over a per-run {@link AgentCorePortRunContext} populated by `setupRun`; methods read it
   * lazily through a closure cell, so `setupRun` runs first (building the context) and every
   * per-iteration method sees the live state. Returns a frozen port object.
   */
  /**
   * The OrchestratorPort assembly the V2AgentRunner drives (relocation Step 9 → engine port.ts).
   * The engine owns the port; the shell just injects its residual callbacks (see the AgentEngine ctor).
   */
  createAgentCorePort(): ReturnType<AgentEngine["createPort"]> {
    return this.engine.createPort();
  }

  /**
   * Step 0 / gap #3 — build a FRESH per-run session from the request's userContent (v1 parity:
   * runBackgroundTask :3278-3289). Worker/background/delegated runs use this so parallel runs on one
   * chatId never collide on a shared persistent session; attachments/vision are seeded here.
   */
  private buildFreshRunSession(
    request: AgentRunSetupInput,
    queryText: string,
    supportsVision: boolean,
  ): Session {
    const userContent =
      request.userContent ??
      buildUserContent(
        queryText || DEFAULT_IMAGE_PROMPT,
        request.attachments ? [...request.attachments] : undefined, // readonly → mutable for buildUserContent
        supportsVision,
      );
    const initialUserMessage: ConversationMessage = { role: "user", content: userContent };
    return {
      messages: [initialUserMessage],
      visibleMessages: [initialUserMessage],
      lastActivity: new Date(),
    };
  }

  /**
   * Resolve the per-user persona override content (from the user's profile, NOT a global
   * SoulLoader mutation). Returns the active persona's SOUL content, or undefined when the
   * profile selects the default persona, has none, or no SoulLoader is configured.
   * Shared by every run path (runAgentLoop / runBackgroundTask / loadRunPersonalization /
   * synthesizeDecomposedFinal) so the user-facing answer honors the selected persona.
   */
  private async resolvePersonaContent(profile: UserProfile | null): Promise<string | undefined> {
    return this.engine.resolvePersonaContent(profile);
  }



  /** Provider-aware context-window trim for the v2 run (relocation Step 7 → setup.ts). */


  



  /** COMPOSE the 2 end-turn handlers on mode, ADAPT union → {agentState, finalText}. */

  /** BIND handlePlanPhaseTransition (no auto-transition; the goal-decomposition step follows). */

  /** ADAPT mutation→pure: project the terminal state + accumulated effects into the result fields. */

  

  

  

  /**
   * Diagnostic-blocked sanitizer factored from the byte-identical v1 inline at orchestrator.ts
   * ~5466-5483 / ~5716-5731. Faithful: same DIAGNOSTIC_BLOCKED_RE → task_stuck rewrite + the
   * loopDetectionBlocked mark. Shared by portDispatchReflection + portDispatchEndTurn.
   */
  


  /**
   * The FULL v1 tool turn behind the port's bound executeToolCalls seam. Runs the exact v1 free-
   * helper sequence (executeAndTrackTools → controlLoopTracker.markToolExecution → consensus →
   * recordStepResultsAndCheckReflection → content-blocks → refreshMemoryIfNeeded) and returns BOTH
   * the trace rows the spine projects AND the advanced AgentState. Faithful to the interactive
   * (orchestrator.ts ~5774-5879) and background (~4191-4289) tool-execution blocks.
   *
   * The spine calls this through `port.executeToolCalls(toolCalls, session, agentState)`; the
   * positional args are decoded here so the port stays the existing ExecuteToolCallsFn shape.
   */

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

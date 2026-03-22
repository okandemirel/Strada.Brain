import type { IAIProvider, ProviderResponse } from "./providers/provider.interface.js";
import type { ProviderManager } from "./providers/provider-manager.js";
import type { MetricsCollector } from "../dashboard/metrics.js";
import type { RateLimiter } from "../security/rate-limiter.js";
import type {
  ExecutionTraceSource,
  TaskClassification,
} from "../agent-core/routing/routing-types.js";
import type { TaskUsageEvent } from "../tasks/types.js";
import { AgentPhase } from "./agent-state.js";
import {
  buildProviderIntelligence,
  type ModelIntelligenceLookup,
} from "./providers/provider-knowledge.js";
import { createCatalogVersion } from "./supervisor/supervisor-types.js";
import { TaskClassifier } from "../agent-core/routing/task-classifier.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SupervisorRole = "planner" | "executor" | "reviewer" | "synthesizer";

export interface SupervisorAssignment {
  role: SupervisorRole;
  providerName: string;
  modelId?: string;
  provider: IAIProvider;
  reason: string;
  traceSource?: ExecutionTraceSource;
  assignmentVersion?: number;
  catalogVersion?: string;
}

export interface SupervisorExecutionStrategy {
  task: TaskClassification;
  planner: SupervisorAssignment;
  executor: SupervisorAssignment;
  reviewer: SupervisorAssignment;
  synthesizer: SupervisorAssignment;
  usesMultipleProviders: boolean;
}

/**
 * Readonly context interface carrying the Orchestrator fields
 * needed by supervisor-routing standalone functions.
 */
export interface SupervisorRoutingContext {
  readonly providerManager: ProviderManager;
  readonly providerRouter?: {
    resolve(
      task: TaskClassification,
      phase: string | undefined,
      opts: { identityKey: string; taskDescription?: string; projectWorldFingerprint?: string },
    ): { provider: string; reason: string; model?: string; assignmentVersion?: number };
    resolveWithCatalog?(
      task: TaskClassification,
      phase: string | undefined,
      opts: { identityKey: string; taskDescription?: string; projectWorldFingerprint?: string },
    ): { provider: string; reason: string; model?: string; assignmentVersion?: number };
  };
  readonly modelIntelligence?: ModelIntelligenceLookup;
  readonly metrics?: MetricsCollector;
  readonly rateLimiter?: RateLimiter;
  readonly taskClassifier: TaskClassifier;
}

// ─── Regex ────────────────────────────────────────────────────────────────────

const INTERNAL_DECISION_LINE_RE =
  /^\s*\*{0,2}(DONE_WITH_SUGGESTIONS|DONE|REPLAN|CONTINUE)\*{0,2}\s*$/gim;

// ─── Functions ────────────────────────────────────────────────────────────────

export function buildStaticSupervisorAssignment(
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
  return {
    role,
    providerName,
    modelId,
    provider,
    reason,
    traceSource,
    assignmentVersion: metadata?.assignmentVersion,
    catalogVersion: metadata?.catalogVersion,
  };
}

export function buildCatalogAssignmentMetadata(
  ctx: SupervisorRoutingContext,
  providerName: string,
  modelId: string | undefined,
  identityKey: string,
  assignmentVersion?: number,
): {
  assignmentVersion?: number;
  catalogVersion?: string;
} {
  const routingMetadata = ctx.providerManager.getRoutingMetadata?.(
    providerName,
    modelId,
    identityKey,
  );

  if (!routingMetadata) {
    return {
      assignmentVersion,
      catalogVersion: createCatalogVersion({
        provider: providerName,
        model: modelId,
        updatedAt: undefined,
        stale: false,
        degraded: false,
      }),
    };
  }

  return {
    assignmentVersion: assignmentVersion ?? routingMetadata.assignmentVersion,
    catalogVersion: createCatalogVersion({
      provider: routingMetadata.provider,
      model: routingMetadata.model,
      updatedAt: routingMetadata.catalog.updatedAt,
      stale: routingMetadata.catalog.stale,
      degraded: routingMetadata.catalog.degraded,
    }),
  };
}

export function getProviderByNameOrFallback(
  ctx: SupervisorRoutingContext,
  providerName: string | undefined,
  fallbackProvider: IAIProvider,
): { providerName: string; provider: IAIProvider } {
  const normalizedName = providerName?.trim();
  const resolved =
    (normalizedName ? ctx.providerManager.getProviderByName?.(normalizedName) : null) ??
    fallbackProvider;
  return {
    providerName: normalizedName || fallbackProvider.name,
    provider: resolved,
  };
}

export function resolveProviderModelId(
  ctx: SupervisorRoutingContext,
  providerName: string,
  identityKey: string,
): string | undefined {
  const normalizedProvider = providerName.trim().toLowerCase();
  const activeInfo = ctx.providerManager.getActiveInfo?.(identityKey);
  if (activeInfo?.providerName === normalizedProvider && activeInfo.model) {
    return activeInfo.model;
  }

  const executionCandidate = ctx.providerManager
    .listExecutionCandidates?.(identityKey)
    .find((candidate) => candidate.name === normalizedProvider);
  if (executionCandidate?.defaultModel) {
    return executionCandidate.defaultModel;
  }

  const availableCandidate = ctx.providerManager
    .listAvailable?.()
    .find((candidate) => candidate.name === normalizedProvider);
  return availableCandidate?.defaultModel;
}

export function resolveSupervisorAssignment(
  ctx: SupervisorRoutingContext,
  role: SupervisorRole,
  task: TaskClassification,
  phase: string | undefined,
  identityKey: string,
  fallbackName: string,
  fallbackProvider: IAIProvider,
  taskDescription?: string,
  projectWorldFingerprint?: string,
): SupervisorAssignment {
  const activeInfo = ctx.providerManager.getActiveInfo?.(identityKey);
  if (activeInfo?.selectionMode === "strada-hard-pin") {
    return buildStaticSupervisorAssignment(
      role,
      activeInfo.providerName,
      activeInfo.model,
      ctx.providerManager.getProvider(identityKey),
      `honored the explicit user hard pin for ${role}`,
      "supervisor-strategy",
      buildCatalogAssignmentMetadata(
        ctx,
        activeInfo.providerName,
        activeInfo.model,
        identityKey,
      ),
    );
  }

  if (!ctx.providerRouter) {
    const modelId = resolveProviderModelId(ctx, fallbackName, identityKey);
    return buildStaticSupervisorAssignment(
      role,
      fallbackName,
      modelId,
      fallbackProvider,
      "routing unavailable, reusing the current worker",
      undefined,
      buildCatalogAssignmentMetadata(ctx, fallbackName, modelId, identityKey),
    );
  }

  try {
    const routed =
      "resolveWithCatalog" in ctx.providerRouter &&
      typeof ctx.providerRouter.resolveWithCatalog === "function"
        ? ctx.providerRouter.resolveWithCatalog(task, phase, {
          identityKey,
          taskDescription,
          projectWorldFingerprint,
        })
        : ctx.providerRouter.resolve(task, phase, {
          identityKey,
          taskDescription,
          projectWorldFingerprint,
        });
    const resolved = getProviderByNameOrFallback(ctx, routed.provider, fallbackProvider);
    const modelId = "model" in routed && typeof routed.model === "string"
      ? routed.model
      : resolveProviderModelId(ctx, resolved.providerName, identityKey);
    return buildStaticSupervisorAssignment(
      role,
      resolved.providerName,
      modelId,
      resolved.provider,
      routed.reason,
      undefined,
      buildCatalogAssignmentMetadata(
        ctx,
        resolved.providerName,
        modelId,
        identityKey,
        "assignmentVersion" in routed && typeof routed.assignmentVersion === "number"
          ? routed.assignmentVersion
          : undefined,
      ),
    );
  } catch {
    // Routing failure is non-fatal — use fallback provider
  }

  const modelId = resolveProviderModelId(ctx, fallbackName, identityKey);
  return buildStaticSupervisorAssignment(
    role,
    fallbackName,
    modelId,
    fallbackProvider,
    "routing fallback, reusing the current worker",
    undefined,
    buildCatalogAssignmentMetadata(ctx, fallbackName, modelId, identityKey),
  );
}

export function buildSupervisorExecutionStrategy(
  ctx: SupervisorRoutingContext,
  prompt: string,
  identityKey: string,
  fallbackProvider: IAIProvider,
  projectWorldFingerprint?: string,
): SupervisorExecutionStrategy {
  const task = ctx.taskClassifier.classify(prompt);
  const activeInfo = ctx.providerManager.getActiveInfo?.(identityKey);
  if (activeInfo?.selectionMode === "strada-hard-pin") {
    const metadata = buildCatalogAssignmentMetadata(
      ctx,
      activeInfo.providerName,
      activeInfo.model,
      identityKey,
    );
    const buildPinnedAssignment = (
      role: SupervisorRole,
      reason: string,
    ): SupervisorAssignment =>
      buildStaticSupervisorAssignment(
        role,
        activeInfo.providerName,
        activeInfo.model,
        fallbackProvider,
        reason,
        "supervisor-strategy",
        metadata,
      );

    return {
      task,
      planner: buildPinnedAssignment(
        "planner",
        "honored the explicit user hard pin for planning",
      ),
      executor: buildPinnedAssignment(
        "executor",
        "honored the explicit user hard pin for execution",
      ),
      reviewer: buildPinnedAssignment(
        "reviewer",
        "honored the explicit user hard pin for review",
      ),
      synthesizer: buildPinnedAssignment(
        "synthesizer",
        "honored the explicit user hard pin for synthesis",
      ),
      usesMultipleProviders: false,
    };
  }
  const selected = getProviderByNameOrFallback(ctx, activeInfo?.providerName, fallbackProvider);
  const selectedProviderName = selected.providerName;
  const selectedProvider = selected.provider;

  const planner = resolveSupervisorAssignment(
    ctx,
    "planner",
    { ...task, type: "planning" },
    "planning",
    identityKey,
    selectedProviderName,
    selectedProvider,
    prompt,
    projectWorldFingerprint,
  );

  const executor = resolveSupervisorAssignment(
    ctx,
    "executor",
    task,
    "executing",
    identityKey,
    selectedProviderName,
    selectedProvider,
    prompt,
    projectWorldFingerprint,
  );

  let reviewer = resolveSupervisorAssignment(
    ctx,
    "reviewer",
    { ...task, type: "code-review" },
    "reflecting",
    identityKey,
    planner.providerName,
    planner.provider,
    prompt,
    projectWorldFingerprint,
  );
  if (
    reviewer.providerName === executor.providerName &&
    planner.providerName !== executor.providerName
  ) {
    reviewer = buildStaticSupervisorAssignment(
      "reviewer",
      planner.providerName,
      planner.modelId,
      planner.provider,
      "reused the planning worker as reviewer to keep execution and review separated",
      undefined,
      {
        assignmentVersion: planner.assignmentVersion,
        catalogVersion: planner.catalogVersion,
      },
    );
  }

  let synthesizer = resolveSupervisorAssignment(
    ctx,
    "synthesizer",
    { ...task, type: "simple-question" },
    undefined,
    identityKey,
    reviewer.providerName,
    reviewer.provider,
    prompt,
    projectWorldFingerprint,
  );
  if (synthesizer.providerName === executor.providerName) {
    if (reviewer.providerName !== executor.providerName) {
      synthesizer = buildStaticSupervisorAssignment(
        "synthesizer",
        reviewer.providerName,
        reviewer.modelId,
        reviewer.provider,
        "reused the reviewer as the user-facing synthesis worker to keep execution separate",
        undefined,
        {
          assignmentVersion: reviewer.assignmentVersion,
          catalogVersion: reviewer.catalogVersion,
        },
      );
    } else if (planner.providerName !== executor.providerName) {
      synthesizer = buildStaticSupervisorAssignment(
        "synthesizer",
        planner.providerName,
        planner.modelId,
        planner.provider,
        "reused the planner as the user-facing synthesis worker to keep execution separate",
        undefined,
        {
          assignmentVersion: planner.assignmentVersion,
          catalogVersion: planner.catalogVersion,
        },
      );
    }
  }

  const uniqueProviders = new Set([
    planner.providerName,
    executor.providerName,
    reviewer.providerName,
    synthesizer.providerName,
  ]);

  return {
    task,
    planner,
    executor,
    reviewer,
    synthesizer,
    usesMultipleProviders: uniqueProviders.size > 1,
  };
}

export function getSupervisorAssignmentForPhase(
  strategy: SupervisorExecutionStrategy,
  phase: AgentPhase,
): SupervisorAssignment {
  switch (phase) {
    case AgentPhase.PLANNING:
    case AgentPhase.REPLANNING:
      return strategy.planner;
    case AgentPhase.REFLECTING:
      return strategy.reviewer;
    case AgentPhase.EXECUTING:
    case AgentPhase.COMPLETE:
    case AgentPhase.FAILED:
    default:
      return strategy.executor;
  }
}

export function getPinnedToolTurnAssignment(
  strategy: SupervisorExecutionStrategy,
  phase: AgentPhase,
  pinnedProvider: SupervisorAssignment | null,
): SupervisorAssignment {
  if (!pinnedProvider || phase === AgentPhase.COMPLETE || phase === AgentPhase.FAILED) {
    return getSupervisorAssignmentForPhase(strategy, phase);
  }

  const role = getSupervisorAssignmentForPhase(strategy, phase).role;
  return buildStaticSupervisorAssignment(
    role,
    pinnedProvider.providerName,
    pinnedProvider.modelId,
    pinnedProvider.provider,
    "kept the active tool-turn provider pinned to preserve provider-specific tool context",
    "tool-turn-affinity",
    {
      assignmentVersion: pinnedProvider.assignmentVersion,
      catalogVersion: pinnedProvider.catalogVersion,
    },
  );
}

export function buildSupervisorRolePrompt(
  ctx: SupervisorRoutingContext,
  strategy: SupervisorExecutionStrategy,
  assignment: SupervisorAssignment,
): string {
  const providerCapabilities = ctx.providerManager.getProviderCapabilities?.(
    assignment.providerName,
    assignment.modelId,
  );
  const lines = [
    "## Orchestrator Assignment",
    "Strada Brain has already analyzed the user request and owns the overall decision-making.",
    "You are serving as a worker inside that orchestrated execution plan.",
    `Current worker role: ${assignment.role}`,
    "",
    "Execution strategy:",
    `- Planner: ${strategy.planner.providerName} (${strategy.planner.reason})`,
    `- Executor: ${strategy.executor.providerName} (${strategy.executor.reason})`,
    `- Reviewer: ${strategy.reviewer.providerName} (${strategy.reviewer.reason})`,
    `- Synthesizer: ${strategy.synthesizer.providerName} (${strategy.synthesizer.reason})`,
    "",
    "Role contract:",
    "- Do not emit internal tool-run checklists or instructions telling Strada which tools to invoke next. Use tools directly or return only phase-appropriate analysis.",
  ];

  switch (assignment.role) {
    case "planner":
      lines.push(
        "- Produce or revise the plan only.",
        "- Do not take over the full user conversation.",
        "- Give the executor concrete, verifiable steps.",
      );
      break;
    case "executor":
      lines.push(
        "- Execute the current plan and use tools when needed.",
        "- Do not treat your draft as the final user-facing answer.",
        "- Leave final presentation to the synthesizer unless the orchestrator explicitly surfaces a blocker.",
        "- If the task is still locally inspectable, do not hand it back to the user as a clarification request.",
      );
      break;
    case "reviewer":
      lines.push(
        "- Evaluate progress, verification, and failure signals.",
        "- Decide whether execution should continue, replan, or complete.",
        "- Do not rewrite the whole conversation as the final user answer.",
        "- Decide whether ambiguity is internally resolvable or truly requires user clarification.",
      );
      break;
    case "synthesizer":
      lines.push(
        "- Produce the final user-facing response for the orchestrator.",
        "- Preserve verified facts and blockers only.",
        "- Never mention internal control markers or provider identities.",
        "- Only ask the user a clarifying question when clarification review explicitly approved it.",
      );
      break;
  }

  return `\n\n${lines.join("\n")}\n${buildProviderIntelligence(
    assignment.providerName,
    assignment.modelId,
    ctx.modelIntelligence,
    providerCapabilities,
    assignment.providerName,
  )}\n`;
}

export function resolveConsensusReviewAssignment(
  ctx: SupervisorRoutingContext,
  preferredReviewer: SupervisorAssignment,
  currentAssignment: SupervisorAssignment,
  identityKey: string,
): SupervisorAssignment | null {
  if (preferredReviewer.providerName !== currentAssignment.providerName) {
    return preferredReviewer;
  }

  const fallbackReviewName = ctx.providerManager
    .listAvailable()
    .find((provider) => provider.name !== currentAssignment.providerName)?.name;
  if (!fallbackReviewName) {
    return null;
  }

  const fallbackReviewProvider = getProviderByNameOrFallback(
    ctx,
    fallbackReviewName,
    currentAssignment.provider,
  );
  return buildStaticSupervisorAssignment(
    "reviewer",
    fallbackReviewProvider.providerName,
    resolveProviderModelId(ctx, fallbackReviewProvider.providerName, identityKey),
    fallbackReviewProvider.provider,
    "selected an alternate reviewer to keep consensus verification cross-provider",
    undefined,
    buildCatalogAssignmentMetadata(
      ctx,
      fallbackReviewProvider.providerName,
      resolveProviderModelId(ctx, fallbackReviewProvider.providerName, identityKey),
      identityKey,
    ),
  );
}

export function recordProviderUsage(
  ctx: SupervisorRoutingContext,
  providerName: string,
  usage: ProviderResponse["usage"] | undefined,
  onUsage?: (usage: TaskUsageEvent) => void,
): void {
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  ctx.metrics?.recordTokenUsage(inputTokens, outputTokens, providerName);
  ctx.rateLimiter?.recordTokenUsage(inputTokens, outputTokens, providerName);
  onUsage?.({
    provider: providerName,
    inputTokens,
    outputTokens,
  });
}

export function stripInternalDecisionMarkers(text: string | null | undefined): string {
  if (!text) {
    return "";
  }
  return text.replace(INTERNAL_DECISION_LINE_RE, "").trim();
}

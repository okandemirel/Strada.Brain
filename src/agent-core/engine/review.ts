/**
 * Agent Core v2 — engine review/verify cluster (relocation Step 5b; blueprint:
 * project_v2_engine_relocation).
 *
 * The supervisor visibility + completion review and the /run shell-review, moved VERBATIM from
 * orchestrator.ts (mechanical this.X -> deps.X / imported-helper / accounting-fn). These run inside
 * the intervention pipeline (the shell's intervention-deps bundle delegates to the engine) and the
 * self-managed-write-review path. The routing wrappers collapse to direct *Helper calls over the
 * injected getSupervisorRoutingContext; recording flows through the accounting cluster fns
 * (ReviewDeps extends AccountingDeps); the review sub-helpers move together.
 *
 * Import rule (cycle safety): orchestrator-FREE leaves only — see engine-deps.ts.
 */

import type { ConversationMessage, MessageContent } from "../../agents/providers/provider-core.interface.js";
import type { ToolCall, ProviderResponse } from "../../agents/providers/provider.interface.js";
import type { UserProfileStore } from "../../memory/unified/user-profile-store.js";
import type { TaskClassification } from "../routing/routing-types.js";
import type { TaskUsageEvent } from "../../tasks/types.js";
import type { ToolExecutionMode } from "./engine-deps.js";
import { resolveIdentityKey } from "../../agents/orchestrator-text-utils.js";
import type {
  SupervisorExecutionStrategy,
} from "../../agents/orchestrator-supervisor-routing.js";
import {
  resolveSupervisorAssignment as resolveSupervisorAssignmentHelper,
  buildStaticSupervisorAssignment as buildStaticSupervisorAssignmentHelper,
  buildSupervisorRolePrompt as buildSupervisorRolePromptHelper,
  resolveProviderModelId as resolveProviderModelIdHelper,
} from "../../agents/orchestrator-supervisor-routing.js";
import { buildPhaseOutcomeTelemetry as buildPhaseOutcomeTelemetryModel } from "../../agents/orchestrator-phase-telemetry.js";
import { streamOrChatText } from "../../agents/providers/provider.interface.js";
import {
  VISIBILITY_REVIEW_SYSTEM_PROMPT,
  buildVisibilityReviewRequest,
  parseVisibilityReviewDecision,
  sanitizeVisibilityReviewDecision,
  planVerifierPipeline,
} from "../../agents/autonomy/index.js";
import { isVerificationToolName } from "../../agents/autonomy/constants.js";
import { matchProjectScopedAllowlist } from "../../agents/autonomy/project-shell-allowlist.js";
import {
  SHELL_REVIEW_SYSTEM_PROMPT,
  parseShellReviewDecision,
  isSafeShellFallback,
  normalizeInteractiveText as normalizePolicyText,
} from "../../agents/orchestrator-interaction-policy.js";
import {
  recordAuxiliaryUsage,
  recordExecutionTrace,
  recordPhaseOutcome,
  type AccountingDeps,
} from "./accounting.js";
import type { SynthesisDeps } from "./synthesis.js";

/** The dependency slice the review/verify cluster reads (grows only with this module). */
export interface ReviewDeps extends AccountingDeps, SynthesisDeps {
  /** LAZY getter — the base system prompt (the shell rebuilds it; read at call time). */
  readonly systemPrompt: () => string;
  readonly taskClassifier: {
    classify: (text: string) => TaskClassification;
  };
  readonly userProfileStore?: UserProfileStore;
  readonly onUsage?: (usage: import("../../tasks/types.js").TaskUsageEvent) => void;
  readonly defaultLanguage: string;
}

/** The subset of the shell's ToolExecutionOptions the shell-review reads (decoupled from Step 8). */
export interface ReviewShellOptions {
  userId?: string;
  taskPrompt?: string;
  sessionMessages?: ConversationMessage[];
  onUsage?: (usage: TaskUsageEvent) => void;
  /** The project the command runs against — enables the deterministic project-scoped allowlist. */
  projectPath?: string;
}

export interface SelfManagedWriteReview {
  approved: boolean;
  reason?: string;
}

export function extractConversationText(content: string | MessageContent[]): string {
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

export function summarizeMessagesForShellReview(messages?: ConversationMessage[]): string {
  if (!messages || messages.length === 0) {
    return "";
  }

  return messages
    .slice(-4)
    .map((message) => {
      const text = extractConversationText(message.content).replace(/\s+/g, " ").trim();
      if (!text) {
        return "";
      }
      return `${message.role}: ${text.slice(0, 220)}`;
    })
    .filter((line) => line.length > 0)
    .join("\n");
}

export function isVerificationProgressTool(toolCall: ToolCall): boolean {
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



export async function runVisibilityReview(
  deps: ReviewDeps,params: {
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
  const reviewer = resolveSupervisorAssignmentHelper(deps.getSupervisorRoutingContext(), 
    "reviewer",
    { ...params.strategy.task, type: "analysis" },
    "visibility-review",
    params.identityKey,
    params.strategy.reviewer.providerName,
    params.strategy.reviewer.provider,
    `${params.prompt}\n\nVisibility review.`,
  );

  const response = await streamOrChatText(
    reviewer.provider,
    `${deps.systemPrompt()}\n\n${VISIBILITY_REVIEW_SYSTEM_PROMPT}${buildSupervisorRolePromptHelper(deps.getSupervisorRoutingContext(), params.strategy, reviewer)}`,
    buildVisibilityReviewRequest({
      prompt: params.prompt,
      draft: params.draft,
      evidence: params.evidence,
      task: params.task,
      canInspectLocally: params.canInspectLocally,
    }),
  );
  recordExecutionTrace(deps, {
    chatId: params.chatId,
    identityKey: params.identityKey,
    assignment: reviewer,
    phase: "visibility-review",
    source: "visibility-review",
    task: params.task,
  });
  recordAuxiliaryUsage(deps, reviewer.providerName, response.usage, params.usageHandler);
  const decision = sanitizeVisibilityReviewDecision(
    parseVisibilityReviewDecision(response.text),
  );
  recordPhaseOutcome(deps, {
    chatId: params.chatId,
    identityKey: params.identityKey,
    assignment: reviewer,
    phase: "visibility-review",
    source: "visibility-review",
    status: decision?.decision === "internal_continue" ? "continued" : "approved",
    task: params.task,
    reason: decision?.reason ?? "Visibility review completed.",
    telemetry: buildPhaseOutcomeTelemetryModel({
      usage: response.usage,
    }),
  });
  return { decision, usage: response.usage };
}


export async function reviewShellCommandWithProvider(
  deps: ReviewDeps,
  chatId: string,
  command: string,
  mode: ToolExecutionMode,
  options: ReviewShellOptions,
  input: Record<string, unknown>,
): Promise<SelfManagedWriteReview> {
  const identityKey = resolveIdentityKey(chatId, options.userId, undefined, deps.userProfileStore);
  const provider = deps.providerManager.getProvider(identityKey);
  const taskPrompt = normalizePolicyText(options.taskPrompt);
  const recentContext = summarizeMessagesForShellReview(options.sessionMessages);
  const workingDirectory = normalizePolicyText(input["working_directory"]) || ".";
  const timeoutMs = Number(input["timeout_ms"] ?? 30000);
  const reviewAssignment = buildStaticSupervisorAssignmentHelper(
    "reviewer",
    provider.name,
    resolveProviderModelIdHelper(deps.getSupervisorRoutingContext(), provider.name, identityKey),
    provider,
    "reviewed whether a write-capable shell command should run autonomously",
  );
  const reviewTask = deps.taskClassifier.classify(taskPrompt || command);

  // Deterministic pre-approval for canonical project-scoped build/test/run
  // commands (Unity batchmode, dotnet build/test). Measured 2026-08-23: the LLM
  // reviewer rejected the exact Unity -runTests invocation the GAME NEVER RUN
  // gate demanded ("looks destructive"), deadlocking delivery. These patterns
  // are bounded by construction; everything else still goes to the reviewer.
  const allowlisted = matchProjectScopedAllowlist(command, options.projectPath);
  if (allowlisted) {
    recordPhaseOutcome(deps, {
      chatId,
      identityKey,
      assignment: reviewAssignment,
      phase: "shell-review",
      source: "shell-review",
      status: "approved",
      task: reviewTask,
      reason: `Deterministic allowlist: ${allowlisted.rule}`,
    });
    return { approved: true, reason: `deterministic allowlist (${allowlisted.rule})` };
  }

  try {
    const response = await streamOrChatText(
      provider,
      SHELL_REVIEW_SYSTEM_PROMPT,
      `Mode: ${mode}\n` +
        `Task: ${taskPrompt || "(not provided)"}\n` +
        `Working directory: ${workingDirectory}\n` +
        `Timeout ms: ${Number.isFinite(timeoutMs) ? timeoutMs : 30000}\n` +
        `Recent context:\n${recentContext || "(none)"}\n\n` +
        `Command:\n${command}`,
    );
    recordExecutionTrace(deps, {
      chatId,
      identityKey,
      assignment: reviewAssignment,
      phase: "shell-review",
      source: "shell-review",
      task: reviewTask,
    });

    recordAuxiliaryUsage(deps, provider.name, response.usage, options.onUsage ?? deps.onUsage);
    const decision = parseShellReviewDecision(response.text);

    if (
      decision?.decision === "approve" &&
      decision.taskAligned !== false &&
      decision.bounded !== false
    ) {
      recordPhaseOutcome(deps, {
        chatId,
        identityKey,
        assignment: reviewAssignment,
        phase: "shell-review",
        source: "shell-review",
        status: "approved",
        task: reviewTask,
        reason: decision.reason || "Shell review approved the autonomous command.",
        telemetry: buildPhaseOutcomeTelemetryModel({
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
      recordPhaseOutcome(deps, {
        chatId,
        identityKey,
        assignment: reviewAssignment,
        phase: "shell-review",
        source: "shell-review",
        status: "blocked",
        task: reviewTask,
        reason: decision.reason || "Shell review rejected the autonomous command.",
        telemetry: buildPhaseOutcomeTelemetryModel({
          usage: response.usage,
          failureReason: command,
        }),
      });
      return { approved: false, reason: decision.reason || "shell review rejected the command" };
    }
  } catch {
    recordPhaseOutcome(deps, {
      chatId,
      identityKey,
      assignment: reviewAssignment,
      phase: "shell-review",
      source: "shell-review",
      status: "failed",
      task: reviewTask,
      reason: "Shell review provider failed; falling back to bounded local heuristics.",
      telemetry: buildPhaseOutcomeTelemetryModel({
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

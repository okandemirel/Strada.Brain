import type { AgentState } from "../agent-state.js";
import { sanitizePromptInjection } from "../orchestrator-text-utils.js";
import type { TaskClassification } from "../../agent-core/routing/routing-types.js";
import type { LogEntry } from "../../utils/logger.js";
import type {
  CompletionReviewDecision,
  CompletionReviewEvidence,
  CompletionReviewStageResult,
} from "./completion-review.js";
import {
  buildCompletionReviewGate,
  buildCompletionReviewRequest,
  collectCompletionReviewEvidence,
  hasOpenReviewFindingsForDraft,
  mergeCompletionReviewDecisionWithStages,
  shouldRunCompletionReview,
} from "./completion-review.js";
import type { VerificationState } from "./self-verification.js";

export type VerifierName =
  | "build"
  | "targeted-repro"
  | "conformance"
  | "logs"
  | "completion-review"
  | "unity-console"
  | "same-error-repeat";

export type VerifierCheckStatus = "clean" | "issues" | "not_applicable";
export type VerifierPipelineDecision = "approve" | "continue" | "replan";

export interface VerifierCheck {
  readonly name: VerifierName;
  readonly status: VerifierCheckStatus;
  readonly summary: string;
  readonly gate?: string;
}

export interface VerifierPipelineEvidence extends CompletionReviewEvidence {
  readonly task: TaskClassification;
  readonly hasTerminalFailureReport: boolean;
  readonly conformanceRequired: boolean;
  readonly consecutiveSameErrors: number;
  readonly repeatedErrorSignature: string | null;
}

export interface VerifierPipelinePlan {
  readonly evidence: VerifierPipelineEvidence;
  readonly checks: readonly VerifierCheck[];
  readonly reviewRequired: boolean;
  readonly initialDecision: VerifierPipelineDecision;
  readonly gate?: string;
  readonly summary: string;
  readonly buildToolsAvailable?: boolean;
}

export interface VerifierPipelineResult {
  readonly decision: VerifierPipelineDecision;
  readonly gate?: string;
  readonly summary: string;
  readonly checks: readonly VerifierCheck[];
  readonly evidence: VerifierPipelineEvidence;
  readonly reviewDecision?: CompletionReviewDecision | null;
  readonly stageResults?: readonly CompletionReviewStageResult[];
}

export function planVerifierPipeline(params: {
  prompt: string;
  draft: string;
  state: AgentState;
  task: TaskClassification;
  verificationState: VerificationState;
  buildVerificationGate: string | null;
  conformanceGate: string | null;
  logEntries: readonly LogEntry[];
  chatId: string;
  taskStartedAtMs: number;
  buildToolsAvailable?: boolean;
}): VerifierPipelinePlan {
  const evidence = collectVerifierPipelineEvidence({
    state: params.state,
    task: params.task,
    verificationState: params.verificationState,
    logEntries: params.logEntries,
    chatId: params.chatId,
    taskStartedAtMs: params.taskStartedAtMs,
    draft: params.draft,
    conformanceGate: params.conformanceGate,
  });

  const checks: VerifierCheck[] = [];
  const buildCheck = params.buildToolsAvailable === false
    ? { name: "build" as const, status: "not_applicable" as const, summary: "Build tools unavailable in this environment." }
    : buildBuildVerifierCheck(params.buildVerificationGate);
  if (buildCheck) {
    checks.push(buildCheck);
  }

  const targetedCheck = params.buildToolsAvailable === false
    ? null
    : buildTargetedReproVerifierCheck(evidence);
  if (targetedCheck) {
    checks.push(targetedCheck);
  }

  const conformanceCheck = buildConformanceVerifierCheck(params.conformanceGate, evidence);
  if (conformanceCheck) {
    checks.push(conformanceCheck);
  }

  checks.push(buildLogVerifierCheck(evidence));

  const unityCheck = buildUnityConsoleVerifierCheck(params.verificationState);
  if (unityCheck) {
    checks.push(unityCheck);
  }

  const sameErrorCheck = buildSameErrorVerifierCheck(evidence);
  if (sameErrorCheck) {
    checks.push(sameErrorCheck);
  }

  const gatingChecks = checks.filter((check) => check.gate);
  if (gatingChecks.length > 0) {
    return {
      evidence,
      checks,
      reviewRequired: false,
      initialDecision: "continue",
      gate: buildVerifierPipelineGate("continue", gatingChecks, evidence),
      summary: "Static verifier checks still require more work.",
      buildToolsAvailable: params.buildToolsAvailable,
    };
  }

  if (evidence.hasTerminalFailureReport) {
    return {
      evidence,
      checks,
      reviewRequired: false,
      initialDecision: "approve",
      summary: "The current draft is an honest terminal failure report.",
      buildToolsAvailable: params.buildToolsAvailable,
    };
  }

  if (!shouldRunCompletionReview(evidence, params.draft, params.prompt)) {
    return {
      evidence,
      checks,
      reviewRequired: false,
      initialDecision: "approve",
      summary: "No additional verifier review is required for this draft.",
      buildToolsAvailable: params.buildToolsAvailable,
    };
  }

  return {
    evidence,
    checks,
    reviewRequired: true,
    initialDecision: "continue",
    summary: "Dynamic completion review is required before Strada can finish.",
    buildToolsAvailable: params.buildToolsAvailable,
  };
}

export function buildVerifierPipelineReviewRequest(params: {
  prompt: string;
  draft: string;
  state: AgentState;
  plan: VerifierPipelinePlan;
}): string {
  const checkSummary = params.plan.checks.length > 0
    ? params.plan.checks
      .map((check) => `- ${check.name}: ${check.status} — ${check.summary}`)
      .join("\n")
    : "(none)";

  return [
    buildCompletionReviewRequest({
      prompt: params.prompt,
      draft: params.draft,
      state: params.state,
      evidence: params.plan.evidence,
      buildToolsAvailable: params.plan.buildToolsAvailable,
    }),
    "",
    `Verifier pipeline status before review:\n${checkSummary}`,
    "",
    "Respect the verifier pipeline. If the current approach keeps failing a targeted repro/log/build/conformance check, prefer `replan` over another weak approval.",
  ].join("\n");
}

export function finalizeVerifierPipelineReview(
  plan: VerifierPipelinePlan,
  decision: CompletionReviewDecision | null,
  draft: string | null | undefined = "",
  stageResults: readonly CompletionReviewStageResult[] = [],
): VerifierPipelineResult {
  const mergedDecision = mergeCompletionReviewDecisionWithStages(decision, stageResults);
  const reviewCheck: VerifierCheck = buildCompletionReviewCheck(mergedDecision, draft);
  const checks = [...plan.checks, reviewCheck];

  if (!hasOpenReviewFindingsForDraft(mergedDecision, draft)) {
    return {
      decision: "approve",
      summary: mergedDecision?.summary?.trim() || "Verifier review approved completion.",
      checks,
      evidence: plan.evidence,
      reviewDecision: mergedDecision,
      stageResults,
    };
  }

  if (mergedDecision?.decision === "replan") {
    return {
      decision: "replan",
      gate: buildVerifierPipelineGate("replan", [reviewCheck], plan.evidence, mergedDecision),
      summary: mergedDecision.summary?.trim() || "Verifier review requested a replan.",
      checks,
      evidence: plan.evidence,
      reviewDecision: mergedDecision,
      stageResults,
    };
  }

  return {
    decision: "continue",
    gate: buildCompletionReviewGate(mergedDecision, plan.evidence),
    summary: mergedDecision?.summary?.trim() || "Verifier review requires more execution before completion.",
    checks,
    evidence: plan.evidence,
    reviewDecision: mergedDecision,
    stageResults,
  };
}

export function collectVerifierPipelineEvidence(params: {
  state: AgentState;
  task: TaskClassification;
  verificationState: VerificationState;
  logEntries: readonly LogEntry[];
  chatId: string;
  taskStartedAtMs: number;
  draft: string;
  conformanceGate: string | null;
}): VerifierPipelineEvidence {
  // Detect consecutive same errors
  const recentFailureSteps = params.state.stepResults
    .filter(s => !s.success)
    .slice(-5);

  let consecutiveSameErrors = 0;
  let repeatedErrorSignature: string | null = null;

  if (recentFailureSteps.length >= 2) {
    const signatures = recentFailureSteps.map(
      s => `${s.toolName}:${s.summary.slice(0, 80).toLowerCase().replace(/\s+/g, " ")}`,
    );
    const lastSig = signatures[signatures.length - 1]!;
    consecutiveSameErrors = 1;
    for (let i = signatures.length - 2; i >= 0; i--) {
      if (signatures[i] === lastSig) {
        consecutiveSameErrors++;
      } else {
        break;
      }
    }
    if (consecutiveSameErrors >= 2) {
      repeatedErrorSignature = lastSig;
    }
  }

  return {
    ...collectCompletionReviewEvidence({
      state: params.state,
      verificationState: params.verificationState,
      logEntries: params.logEntries,
      chatId: params.chatId,
      taskStartedAtMs: params.taskStartedAtMs,
    }),
    task: params.task,
    hasTerminalFailureReport: isTerminalFailureReport(params.draft),
    conformanceRequired: Boolean(params.conformanceGate),
    consecutiveSameErrors,
    repeatedErrorSignature,
  };
}

export function isTerminalFailureReport(text: string | null | undefined): boolean {
  if (!text) {
    return false;
  }

  const normalized = text.toLowerCase();
  const failurePatterns = [
    /\bfailed\b/,
    /\bfailure\b/,
    /\berror\b/,
    /\btimed out\b/,
    /\btimeout\b/,
    /\bmanual\b/,
    /\bintervention\b/,
    /\bunable\b/,
    /\bcannot\b/,
    /\bcan'?t\b/,
    /\bcould not\b/,
    /\bcouldn'?t\b/,
    /\brequires?\b/,
    /\bblocked\b/,
    /\bcorrupted\b/,
    /\bnot found\b/,
    /\bmissing\b/,
  ];
  const successPatterns = [
    /\bfixed\b/,
    /\bresolved\b/,
    /\bsuccessful\b/,
    /\bsucceeded\b/,
    /\bcompleted\b/,
    /\bcomplete\b/,
    /\bverified clean\b/,
    /\ball set\b/,
  ];
  const continuationPatterns = [
    /^\s*\*{0,2}\s*continue\b/,
    /\blet me\b/,
    /\bi(?:'ll| will)\b/,
    /\banaly[sz]e\b/,
    /\binvestigat(?:e|ing)\b/,
    /\btry again\b/,
    /\breplan\b/,
  ];

  const mentionsFailure = failurePatterns.some((pattern) => pattern.test(normalized));
  const claimsSuccess = successPatterns.some((pattern) => pattern.test(normalized));
  const keepsWorking = continuationPatterns.some((pattern) => pattern.test(normalized));
  return mentionsFailure && !claimsSuccess && !keepsWorking;
}

function buildBuildVerifierCheck(gate: string | null): VerifierCheck | null {
  if (gate) {
    return {
      name: "build",
      status: "issues",
      summary: "Compilable changes still require a clean verification pass.",
      gate,
    };
  }
  return {
    name: "build",
    status: "clean",
    summary: "No outstanding build/typecheck verification debt remains.",
  };
}

function buildTargetedReproVerifierCheck(
  evidence: VerifierPipelineEvidence,
): VerifierCheck | null {
  const recentFailureLines = evidence.recentFailures.slice(-3);
  const recentLogLines = evidence.recentLogIssues.slice(-3);
  const hasOpenFailurePath = recentFailureLines.length > 0 && !evidence.hasTerminalFailureReport;
  const hasUnverifiedLogIssue = recentLogLines.length > 0 && evidence.verificationStepCount === 0;

  if (!hasOpenFailurePath && !hasUnverifiedLogIssue) {
    return {
      name: "targeted-repro",
      status: "clean",
      summary: "No unresolved failing path still needs targeted repro or verification.",
    };
  }

  const issueLines = [
    ...recentFailureLines.map((line) => `- ${line}`),
    ...recentLogLines.map((entry) => `- [${entry.level}] ${entry.message}`),
  ];

  return {
    name: "targeted-repro",
    status: "issues",
    summary: "A failing path or runtime signal still needs targeted reproduction/verification.",
    gate: [
      "[TARGETED VERIFICATION REQUIRED] A failing path is still open.",
      issueLines.length > 0 ? `Unverified failure signals:\n${issueLines.join("\n")}` : "",
      `Task type: ${evidence.task.type}`,
      "Reproduce or re-run the exact failing path, inspect the concrete asset/log/error evidence, apply the fix, and rerun the relevant verification before declaring completion.",
    ].filter(Boolean).join("\n\n"),
  };
}

function buildConformanceVerifierCheck(
  conformanceGate: string | null,
  evidence: VerifierPipelineEvidence,
): VerifierCheck | null {
  if (conformanceGate) {
    return {
      name: "conformance",
      status: "issues",
      summary: "Strada.Core / Strada.Modules / Strada.MCP conformance still needs authoritative verification.",
      gate: conformanceGate,
    };
  }

  return {
    name: "conformance",
    status: evidence.touchedFiles.length > 0 ? "clean" : "not_applicable",
    summary: evidence.touchedFiles.length > 0
      ? "No outstanding framework conformance issue remains."
      : "No framework-touching code required conformance verification.",
  };
}

function buildLogVerifierCheck(evidence: VerifierPipelineEvidence): VerifierCheck {
  if (evidence.recentLogIssues.length === 0) {
    return {
      name: "logs",
      status: "clean",
      summary: "No unresolved warn/error log entries remain after the latest clean verification window.",
    };
  }

  return {
    name: "logs",
    status: "issues",
    summary: "Recent warn/error log entries still exist and must be explained, fixed, or honestly surfaced.",
  };
}

function buildCompletionReviewCheck(
  decision: CompletionReviewDecision | null,
  draft: string | null | undefined = "",
): VerifierCheck {
  if (!hasOpenReviewFindingsForDraft(decision, draft)) {
    return {
      name: "completion-review",
      status: "clean",
      summary: decision?.summary?.trim() || "Completion review approved the result.",
    };
  }

  return {
    name: "completion-review",
    status: "issues",
    summary: decision?.summary?.trim() || "Completion review found remaining issues.",
  };
}

function buildVerifierPipelineGate(
  decision: "continue" | "replan",
  checks: readonly VerifierCheck[],
  evidence: VerifierPipelineEvidence,
  reviewDecision?: CompletionReviewDecision | null,
): string {
  const lines = checks.map((check) => `- ${check.name}: ${check.summary}`);
  const gatedActions = checks
    .map((check) => check.gate?.trim())
    .filter((gate): gate is string => Boolean(gate));
  const findings = reviewDecision?.findings?.filter(Boolean) ?? [];
  const requiredActions = reviewDecision?.requiredActions?.filter(Boolean) ?? [];
  const logLines = evidence.recentLogIssues
    .slice(-5)
    .map((entry) => `- [${entry.level}] ${entry.message}`);

  const header = decision === "replan"
    ? "[VERIFIER PIPELINE: REPLAN REQUIRED] Internal verification shows the current approach should be replanned."
    : "[VERIFIER PIPELINE] Internal verification is not clean yet.";
  const tail = decision === "replan"
    ? "Preserve the useful evidence, discard the failing approach, create a new plan, and continue only after the new path has a clean verifier result."
    : "Continue internally. Resolve the failing verifier checks, rerun the relevant verification, and only then declare the task complete.";

  return [
    header,
    lines.length > 0 ? `Failed verifier checks:\n${lines.join("\n")}` : "",
    gatedActions.length > 0 ? `Required verifier actions:\n${gatedActions.join("\n\n")}` : "",
    findings.length > 0 ? `Reviewer findings:\n${findings.map((finding) => `- ${finding}`).join("\n")}` : "",
    requiredActions.length > 0 ? `Required actions:\n${requiredActions.map((action) => `- ${action}`).join("\n")}` : "",
    logLines.length > 0 ? `Recent log issues:\n${logLines.join("\n")}` : "",
    tail,
  ].filter(Boolean).join("\n\n");
}

function buildUnityConsoleVerifierCheck(
  verificationState: VerificationState,
): VerifierCheck | null {
  const errors = verificationState.unityConsoleErrors ?? [];
  const attempts = verificationState.unityErrorResolutionAttempts ?? 0;

  if (errors.length === 0) {
    return null;
  }

  const errorList = errors.slice(0, 5).map(e => `  ✗ ${e}`).join("\n");
  return {
    name: "unity-console" as VerifierName,
    status: "issues",
    summary: `${errors.length} Unity console error(s) remain after ${attempts} attempt(s).`,
    gate: [
      `[UNITY CONSOLE ERROR LOOP - Attempt ${attempts}]`,
      `Unity console still reports ${errors.length} error(s):`,
      errorList,
      errors.length > 5 ? `  ... and ${errors.length - 5} more` : "",
      "",
      "You MUST fix these errors before completion. Analyze each error, apply fixes, and run unity_verify_change again.",
      "Do NOT declare DONE or skip this — the task is incomplete until Unity console is clean.",
    ].filter(Boolean).join("\n"),
  };
}

const SAME_ERROR_REPEAT_THRESHOLD = 3;

function buildSameErrorVerifierCheck(
  evidence: VerifierPipelineEvidence,
): VerifierCheck | null {
  if (evidence.consecutiveSameErrors < SAME_ERROR_REPEAT_THRESHOLD) {
    return null;
  }

  return {
    name: "same-error-repeat" as VerifierName,
    status: "issues",
    summary: `Same error repeated ${evidence.consecutiveSameErrors} times — current approach is not working.`,
    gate: [
      `[REPEATED ERROR DETECTED] The same error has occurred ${evidence.consecutiveSameErrors} consecutive times.`,
      evidence.repeatedErrorSignature ? `Error pattern: ${sanitizePromptInjection(evidence.repeatedErrorSignature)}` : "",
      "",
      "Your current approach is NOT working. You MUST try a fundamentally different strategy:",
      "1. Re-read the relevant source files to check your assumptions",
      "2. Consider a completely different implementation approach",
      "3. If the same fix keeps failing, the root cause is different from what you think",
      "4. Do NOT retry the same fix again — it will fail for the same reason",
    ].filter(Boolean).join("\n"),
  };
}

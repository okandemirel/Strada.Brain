import type { AgentState } from "../agent-state.js";
import { completionOmitsNamedDeliverables, draftLeavesOpenInvestigations } from "./completion-review.js";
import { sanitizePromptInjection } from "../orchestrator-text-utils.js";
import type { TaskClassification } from "../../agent-core/routing/routing-types.js";
import type { LogEntry } from "../../utils/logger.js";
import type {
  CompletionReviewDecision,
  CompletionReviewEvidence,
  CompletionReviewStageResult,
} from "./completion-review.js";
import {
  collectCompletionReviewEvidence,
  isVerificationStep,
  MUTATION_TOOL_NAMES,
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
  /** A gating check that has asked its fill: the pipeline replans instead of asking again. */
  readonly escalate?: boolean;
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
  // Exhausted debt takes the gating path whatever the tooling says: with the
  // tools away, needsVerification() is false and the gate is null, and the
  // unavailable-tools branch read null as "no debt" (Codex 2026-09-11 #2).
  const exhaustedDebt = params.verificationState.buildGateExhausted === true && params.verificationState.pendingFiles.size > 0;
  const buildCheck = params.buildToolsAvailable === false && !exhaustedDebt
    ? buildUnavailableBuildToolsCheck(params.buildVerificationGate, evidence)
    : buildBuildVerifierCheck(params.buildVerificationGate, params.verificationState, evidence, `${params.chatId}:${params.taskStartedAtMs}`);
  if (buildCheck) {
    checks.push(buildCheck);
  }

  // Missing tooling used to skip this check entirely, which let a draft claim
  // completion over unreproduced failures precisely when nothing could have
  // verified it. Keep it active; the honest terminal failure report remains the
  // one accepted way out when the tooling truly cannot come back.
  const targetedCheck = params.buildToolsAvailable === false && evidence.hasTerminalFailureReport
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

  const unverifiedFailureCheck = buildUnverifiedFailureVerifierCheck(evidence);
  if (unverifiedFailureCheck) {
    checks.push(unverifiedFailureCheck);
  }

  const gatingChecks = checks.filter((check) => check.gate);
  if (gatingChecks.length > 0) {
    // "Replan" used to arrive only as an LLM review verdict. The deterministic
    // equivalent was already here and unread: the same-error check exists
    // precisely to say that the current approach is not working and a different
    // one is needed, which is what a replan is. Every other gating check means
    // "there is more to do on this approach" — continue.
    const decision: VerifierPipelineDecision = gatingChecks.some(
      (check) => check.name === ("same-error-repeat" as VerifierName) || check.escalate === true,
    )
      ? "replan"
      : "continue";
    return {
      evidence,
      checks,
      reviewRequired: false,
      initialDecision: decision,
      gate: buildVerifierPipelineGate(decision, gatingChecks, evidence),
      summary: decision === "replan"
        ? "The same error keeps recurring — the current approach needs replacing."
        : "Static verifier checks still require more work.",
      buildToolsAvailable: params.buildToolsAvailable,
    };
  }

  if (evidence.hasTerminalFailureReport) {
    // A failure report is honoured — once it has an attempt behind it. The
    // vocabulary check alone let a run say "could not, the edit failed" over a
    // trace holding one read and no failed call (report 2026-09-10 #38: the
    // terminal exit was judged by words, no attempt evidence asked). One ask,
    // then the report stands: a run that truly cannot attempt anything must
    // still be able to say so.
    const attempted =
      evidence.mutationStepCount > 0 ||
      evidence.verificationStepCount > 0 ||
      evidence.recentFailures.length > 0;
    if (WORK_TASK_TYPES.has(evidence.task.type) && !attempted) {
      const runKey = `${params.chatId}:${params.taskStartedAtMs}`;
      const asked = (zeroAttemptFailureGates.get(runKey) ?? 0) + 1;
      zeroAttemptFailureGates.set(runKey, asked);
      if (zeroAttemptFailureGates.size > 512) zeroAttemptFailureGates.delete(zeroAttemptFailureGates.keys().next().value as string);
      if (asked <= MAX_ZERO_ATTEMPT_FAILURE_GATES) {
        return {
          evidence,
          checks,
          reviewRequired: false,
          initialDecision: "continue",
          gate: buildFailureWithoutAttemptGate(evidence),
          summary: `The draft reports failure of a ${evidence.task.type} task, but the trace holds no attempt: no change, no verification, no failed call.`,
          buildToolsAvailable: params.buildToolsAvailable,
        };
      }
    }
    return {
      evidence,
      checks,
      reviewRequired: false,
      initialDecision: "approve",
      summary: "The current draft is an honest terminal failure report.",
      buildToolsAvailable: params.buildToolsAvailable,
    };
  }

  /**
   * WORK EVIDENCE. Every check in this pipeline is conditional on something
   * having happened: no pending files → build "clean", no failures → repro
   * "clean", no touched files → conformance "not applicable". A run that made
   * one read call and changed nothing therefore passed the whole pipeline and
   * was approved (audited 2026-09-10). A task whose type is to change
   * something must show a mutation or a verification, or say plainly that it
   * could not (a terminal failure report is honoured as before).
   *
   * Asked at BOTH doors. The check sat below the "no review required" return,
   * so a run with ZERO tool steps and the draft "Implemented successfully."
   * never reached it: the pipeline approved, the handler returned done, and
   * the task completed with nothing inspected, implemented or verified (Codex
   * 2026-09-12 AE#1).
   */
  const noWorkOutcome = (): VerifierPipelinePlan | undefined => {
    if (
      !WORK_TASK_TYPES.has(evidence.task.type) ||
      evidence.mutationStepCount > 0 ||
      evidence.verificationStepCount > 0 ||
      evidence.hasTerminalFailureReport
    ) {
      return undefined;
    }
    // Bounded: the gate asks twice, then demands a replan instead of asking
    // a third time (the text-only hard cap ends a run that still does nothing,
    // later and with a vaguer sentence). Keyed per run.
    const runKey = `${params.chatId}:${params.taskStartedAtMs}`;
    const asked = (noWorkGateEmissions.get(runKey) ?? 0) + 1;
    noWorkGateEmissions.set(runKey, asked);
    if (noWorkGateEmissions.size > 512) noWorkGateEmissions.delete(noWorkGateEmissions.keys().next().value as string);
    if (asked > MAX_NO_WORK_EVIDENCE_GATES) {
      return {
        evidence,
        checks,
        reviewRequired: false,
        initialDecision: "replan",
        gate: buildNoWorkEvidenceGate(evidence) + `\nThis is the ${asked}th completion claim with nothing done: the approach, not the wording, has to change.`,
        summary:
          `Reported completion of a ${evidence.task.type} task ${asked} times with no change made and no verification run; ` +
          "a report is not the work.",
        buildToolsAvailable: params.buildToolsAvailable,
      };
    }
    return {
      evidence,
      checks,
      reviewRequired: false,
      initialDecision: "continue",
      gate: buildNoWorkEvidenceGate(evidence),
      summary: `The draft reports completion of a ${evidence.task.type} task with no change made and no verification run.`,
      buildToolsAvailable: params.buildToolsAvailable,
    };
  };

  if (!shouldRunCompletionReview(evidence, params.draft, params.prompt)) {
    // The draft needs no review — but a claim that work was DONE still needs
    // work behind it (AE#1). Only a claim: the task classifier falls back to
    // "code-generation" for everything it cannot place, so gating every
    // unreviewed draft here would hold back the answer to "read this file and
    // tell me what it extends" — which is an answer, not a claim.
    if (draftClaimsWorkDone(params.draft)) {
      const noWork = noWorkOutcome();
      if (noWork) return noWork;
    }
    return {
      evidence,
      checks,
      reviewRequired: false,
      initialDecision: "approve",
      summary: "No additional verifier review is required for this draft.",
      buildToolsAvailable: params.buildToolsAvailable,
    };
  }

  // What used to happen here was four LLM review stages — code, simplify,
  // security, then a synthesizer. They were shown file paths, the draft's prose
  // and tool summaries truncated to 200 characters, and never a line of code, so
  // they could not check the thing they were named after. What they did catch,
  // when they caught anything, is a draft that declares completion while leaving
  // its own investigations open — and that is a property of the text, decidable
  // here without spending four model calls on every task that writes a file.
  const unaddressed = completionOmitsNamedDeliverables(params.prompt, params.draft);
  if (unaddressed.length > 0) {
    return {
      evidence,
      checks,
      reviewRequired: false,
      initialDecision: "continue",
      gate: buildUnaddressedDeliverablesGate(unaddressed),
      summary: `The draft reports completion without accounting for ${unaddressed.length} named deliverable(s).`,
      buildToolsAvailable: params.buildToolsAvailable,
    };
  }

  if (draftLeavesOpenInvestigations(params.draft)) {
    return {
      evidence,
      checks,
      reviewRequired: false,
      initialDecision: "continue",
      gate: buildOpenInvestigationsGate(),
      summary: "The draft declares completion while leaving its own investigations open.",
      buildToolsAvailable: params.buildToolsAvailable,
    };
  }

  const noWork = noWorkOutcome();
  if (noWork) return noWork;

  return {
    evidence,
    checks,
    reviewRequired: false,
    initialDecision: "approve",
    summary: "Static verifier checks passed and the draft leaves nothing open.",
    buildToolsAvailable: params.buildToolsAvailable,
  };
}

/**
 * Does this draft claim that WORK WAS DONE, as opposed to answering a
 * question?
 *
 * The task classifier falls back to "code-generation" for everything it
 * cannot place — a short prompt, a question, a non-English one — so the task
 * type alone cannot tell "Implemented successfully." from "It extends
 * MonoBehaviour." A claim of completed work is what needs work behind it.
 */
export function draftClaimsWorkDone(draft: string | null | undefined): boolean {
  const text = (draft ?? "").toLowerCase();
  if (text.trim() === "") return false;
  return /\b(?:implemented|created|added|wrote|written|built|fixed|repaired|refactored|renamed|removed|deleted|replaced|updated|migrated|wired|integrated|installed|generated|set\s+up|hooked\s+up|shipped|delivered|completed)\b/u.test(text);
}

/** Task types whose completion means something changed or something was run — never only read. */
// A string set, not TaskType: the classifier's own vocabulary carries
// "implementation" alongside the routing union's "code-generation".
const WORK_TASK_TYPES: ReadonlySet<string> = new Set([
  "implementation",
  "code-generation",
  "refactoring",
  "debugging",
  "destructive-operation",
]);

/** How many times the no-work gate asks before the run is failed as "reported, not done". */
const MAX_NO_WORK_EVIDENCE_GATES = 2;
/** A failure report with no attempt behind it is asked to try once; then it stands. */
const MAX_ZERO_ATTEMPT_FAILURE_GATES = 1;
const zeroAttemptFailureGates = new Map<string, number>();
/** The exhausted compile gate asks for an honest report twice; a third completion claim over unverified files is a replan. */
const MAX_UNPAID_DEBT_GATES = 2;
const unpaidDebtGateEmissions = new Map<string, number>();

function buildFailureWithoutAttemptGate(evidence: VerifierPipelineEvidence): string {
  return [
    "[FAILURE WITHOUT AN ATTEMPT] You report that the task could not be done, but this run's trace shows",
    `no attempt: ${evidence.totalStepCount} tool call(s), no change made, no verification run, no failed call.`,
    "",
    "A failure report needs the attempt behind it. Try the work — make the change, run the verification —",
    "and if it fails, report what failed and how. If nothing can even be attempted from here, say exactly",
    "what is missing (the tool, the file, the access) so the report names a real blocker, not a guess.",
  ].join("\n");
}

/** Per-run emission count for the no-work gate (chatId:taskStartedAtMs → asks). */
const noWorkGateEmissions = new Map<string, number>();
/** Test hook: forget every run's no-work gate count. */
export function resetNoWorkEvidenceGates(): void {
  zeroAttemptFailureGates.clear();
  unpaidDebtGateEmissions.clear();
  noWorkGateEmissions.clear();
}

/** Told to the agent when it reports a work task done without having done anything. */
function buildNoWorkEvidenceGate(evidence: VerifierPipelineEvidence): string {
  return [
    `[VERIFIER PIPELINE] NO WORK EVIDENCE: this is a ${evidence.task.type} task, and this run made no change`,
    `and ran no verification (${evidence.totalStepCount} tool call(s), ${evidence.inspectionStepCount} of them reads).`,
    "A report of completion is not completion. Either do the work — write the file, apply the edit, run the",
    "verification — or state plainly that it could not be done, naming the tool result that stopped you.",
  ].join("\n");
}

/** Told to the agent when its own draft still has loose ends. */
function buildOpenInvestigationsGate(): string {
  return [
    "Your draft declares the work complete and then lists things you have not established:",
    "open investigations, hedged runtime claims, or checks left for someone else to run.",
    "",
    "Close them or say plainly that they are unresolved. Confirm or eliminate each hypothesis,",
    "run the verification that would settle it, and only then report completion.",
  ].join("\n");
}



/** Told to the agent when it reports completion without accounting for what the task named. */
function buildUnaddressedDeliverablesGate(missing: readonly string[]): string {
  return [
    "You are reporting the work complete, but the task named deliverables your report never mentions:",
    ...missing.map((item) => `- ${item}`),
    "",
    "A deliverable may be built, or it may be genuinely blocked and said so plainly.",
    "It may not simply go unmentioned. Deliver each one, or name it and say what stopped you.",
  ].join("\n");
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
  // Detect consecutive same errors — SINCE THE LAST REPAIR. Successful steps
  // were filtered out before the streak was counted, so three identical
  // compile failures followed by a corrective write and a clean compile still
  // read as "the same error three times, the approach is not working" and the
  // finished repair was sent back for a replan (Codex 2026-09-12 AE#7). A
  // successful change or verification ENDS the streak; a successful read
  // between two identical failures does not, because it repaired nothing.
  const sinceRepair: Array<(typeof params.state.stepResults)[number]> = [];
  for (let i = params.state.stepResults.length - 1; i >= 0; i--) {
    const step = params.state.stepResults[i]!;
    if (step.success && (MUTATION_TOOL_NAMES.has(step.toolName) || isVerificationStep(step.toolName, step.summary))) break;
    if (!step.success) sinceRepair.unshift(step);
  }
  const recentFailureSteps = sinceRepair.slice(-5);

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
  // Only phrases that describe the RUN'S OWN outcome. Audited 2026-09-02: this
  // list also held "missing", "requires", "not found", "error" and "failure" —
  // words an ordinary completion report uses about the things it fixed — so
  // "Done. Implemented … The pig prefab was missing, so I generated one." was
  // approved as an honest terminal failure report (skipping the deliverables
  // review and downgrading the build gate) AND recorded by the campaign as a
  // failed sprint. One vocabulary miss moved a delivery both wrong ways at once.
  const failurePatterns = [
    /\bfailed\b/,
    /\btimed out\b/,
    /\btimeout\b/,
    /\bmanual\b/,
    /\bintervention\b/,
    /\bunable\b/,
    /\bcannot\b/,
    /\bcan'?t\b/,
    /\bcould not\b/,
    /\bcouldn'?t\b/,
    /\bblocked\b/,
    /\bcorrupted\b/,
  ];
  // "done" is deliberately absent: it is the protocol's completion token and
  // an honest blocker may end with it.
  const successPatterns = [
    /\bfixed\b/,
    /\bresolved\b/,
    /\bsuccessful\b/,
    /\bsucceeded\b/,
    /\bcompleted\b/,
    /\bcomplete\b/,
    /\bimplemented\b/,
    /\bdelivered\b/,
    /\bshipped\b/,
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

/**
 * Build tools are unavailable but the run still owes a verification pass.
 *
 * This used to collapse to `not_applicable`, which meant a disconnected Unity
 * bridge silently deleted the build gate: compilable changes sailed through to
 * "approve" unverified, milestones went green on drafts nobody compiled, and the
 * acceptance record said UNKNOWN. Absence of the tool is not absence of the
 * debt. With debt outstanding this check now hard-blocks; the only accepted
 * exits are restoring the tooling or an honest terminal failure report.
 */
function buildUnavailableBuildToolsCheck(
  gate: string | null,
  evidence: VerifierPipelineEvidence,
): VerifierCheck {
  if (gate === null) {
    return {
      name: "build",
      status: "not_applicable",
      summary: "Build tools unavailable, and no compilable verification debt is outstanding.",
    };
  }
  if (evidence.hasTerminalFailureReport) {
    return {
      name: "build",
      status: "issues",
      summary: "Compilable changes are unverified (build tools unavailable); the draft honestly reports the blockage.",
    };
  }
  return {
    name: "build",
    status: "issues",
    summary: "Compilable changes exist but the build/verification tooling is unavailable — completion cannot be verified.",
    gate: [
      "[VERIFICATION TOOLING UNAVAILABLE] You changed compilable code, but the build/verification tools",
      "(Unity bridge, compile/test runners) are not available in this environment.",
      "",
      "You may NOT declare this work complete unverified. Do one of the following:",
      "1. Restore the verification path — reconnect the Unity bridge / bring the compile-status,",
      "   PlayMode-test, or equivalent verification tool back, then run it and report its result.",
      "2. If the tooling genuinely cannot be restored from here, STOP and report the task as blocked:",
      "   state plainly which changes remain unverified and why verification was impossible.",
      "",
      "Do not restate completion without one of these. An unverified draft is not a deliverable.",
    ].join("\n"),
  };
}

function buildBuildVerifierCheck(
  gate: string | null,
  verificationState: VerificationState,
  evidence?: Pick<VerifierPipelineEvidence, "hasTerminalFailureReport">,
  runKey?: string,
): VerifierCheck | null {
  if (gate) {
    return {
      name: "build",
      status: "issues",
      summary: "Compilable changes still require a clean verification pass.",
      gate,
    };
  }
  if (verificationState.buildGateExhausted === true) {
    // The compile gate spent its asks and stopped; the debt did not go
    // anywhere. Audited 2026-09-02: this branch used to fall through to
    // "clean — no outstanding verification debt" over files nobody compiled.
    // Non-gating on purpose — the cap exists to end a loop the run cannot
    // break — but the record names the files rather than calling them clean.
    const pending = [...verificationState.pendingFiles];
    const shown = pending.slice(0, 8).join(", ");
    const rest = pending.length > 8 ? ` and ${pending.length - 8} more` : "";
    const summary =
      `Compilable changes were never verified: ${pending.length} file(s) still pending ` +
      `(${shown}${rest}) after the compile gate's ask budget was spent. ` +
      "The asking stopped; the debt did not.";
    // Report 2026-09-10 #38: this record used to be the whole consequence —
    // the run went on to the completion review and could be approved over
    // files nobody compiled. Unpaid debt now has two exits only: a clean
    // verification, or a plain failure report naming the files. A completion
    // claim gets that ask twice; the third is a replan.
    if (evidence?.hasTerminalFailureReport) {
      return { name: "build", status: "issues", summary };
    }
    const asked = runKey ? (unpaidDebtGateEmissions.get(runKey) ?? 0) + 1 : 1;
    if (runKey) {
      unpaidDebtGateEmissions.set(runKey, asked);
      if (unpaidDebtGateEmissions.size > 512) unpaidDebtGateEmissions.delete(unpaidDebtGateEmissions.keys().next().value as string);
    }
    return {
      name: "build",
      status: "issues",
      summary,
      escalate: asked > MAX_UNPAID_DEBT_GATES,
      gate: [
        `[VERIFICATION DEBT UNPAID] The compile gate asked its fill and ${pending.length} file(s) were never verified:`,
        ...pending.slice(0, 12).map((f) => `- ${f}`),
        ...(pending.length > 12 ? [`- and ${pending.length - 12} more`] : []),
        "",
        "You may NOT declare this work complete. Two exits only:",
        "1. Run a verification that passes (compile-status / PlayMode tests / the equivalent) and report its result.",
        "2. STOP and report the task as failed: name these files and say plainly why verification never passed.",
        "",
        "Do not restate completion without one of these.",
      ].join("\n"),
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
    // The summary said "needs authoritative verification" for every gate. That
    // is one of five, and it points a run blocked for a missing scene at the
    // Strada.Core source instead of at the scene. The gate opens with its own
    // tag; report that rather than a guess.
    const tag = /^\[([A-Z0-9 .]+)\]/.exec(conformanceGate)?.[1];
    return {
      name: "conformance",
      status: "issues",
      summary: tag
        ? `Strada conformance gate open: ${tag}.`
        : "Strada framework conformance is not yet satisfied.",
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

/**
 * A completion claimed on top of failures nobody re-checked.
 *
 * This is what the four LLM review stages were actually catching when they
 * caught anything: the agent hit failing steps, changed something, and declared
 * the work done without running the verification that would settle it. The claim
 * is unverifiable by inspection of prose — but "there were failures and no
 * verification ran afterwards" is a fact about the step list, so it is decided
 * here instead of being asked of a model that was never shown the code.
 */
function buildUnverifiedFailureVerifierCheck(
  evidence: VerifierPipelineEvidence,
): VerifierCheck | null {
  // Narrow deliberately. This fires only when the agent CHANGED something in
  // response to failures and then never checked: a read-only investigation that
  // hit a failed read has nothing to verify, and an honest "I could not do this"
  // report is the one completion that should not be argued with.
  if (
    evidence.recentFailures.length === 0 ||
    evidence.verificationStepCount > 0 ||
    evidence.mutationStepCount === 0 ||
    evidence.hasTerminalFailureReport
  ) {
    return null;
  }

  return {
    name: "unverified-failure" as VerifierName,
    status: "issues",
    summary: "Steps failed and nothing was verified afterwards.",
    gate: [
      "[UNVERIFIED FAILURE] Steps in this run failed and no verification has run since.",
      "",
      "Recent failures:",
      ...evidence.recentFailures.slice(-3).map((f) => `- ${sanitizePromptInjection(f)}`),
      "",
      "Run the verification that would settle whether they are fixed — a build, the",
      "relevant test, the console — and report what it returned. Do not declare the",
      "work complete on the strength of having changed something.",
    ].join("\n"),
  };
}

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

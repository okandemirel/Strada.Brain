/**
 * A failure that nothing in this run can verify.
 *
 * The targeted-repro and unverified-failure checks keep a failed step open
 * until a verification runs after it. Measured 2026-11-06 (golden run 4): a
 * write failed at run time (ENOTDIR), the next write succeeded, and the
 * project had no build and no tests. The worker was asked six times, loop
 * detection blocked the node, the goal ran again from the start, and the
 * re-run, with an empty failure history, completed without any verification.
 * The gate cost six calls, a block and a re-run, and protected nothing.
 *
 * The exit here is narrow. It applies only when ALL of these hold:
 * - the run's tool registry was measured, and none of its tools runs a check
 *   (`runsVerificationCheck`). The answer is read from the registry, never
 *   from the draft: "this project has no tests" in prose closes nothing;
 * - no verification step ran in this run;
 * - every open failure was followed by a successful call of the same tool
 *   (the step was re-run and worked; only the verification is missing);
 * - no warn/error log entry is open.
 * Then the draft must say plainly that the result is not verified. Until it
 * does, the gate asks for exactly that, once per draft; when it does, the
 * failure stops gating and the check records why, naming the registry.
 *
 * `shell_exec` is not a verification tool (constants.ts classifies it as
 * reading). A project whose only check is a shell command the worker never
 * ran is therefore treated as having none
 * (docs/memory/entries/2026-11-11-unverifiable-failure-closes-on-an-honest-report.md).
 */

import { PROGRESS_MUTATION_TOOLS, runsVerificationCheck } from "./constants.js";
import { isNodeScopedTask, selectNodeTools } from "./node-tool-offer.js";
import { sanitizePromptInjection } from "../../security/prompt-injection.js";
import type { CompletionReviewEvidence } from "./completion-review.js";

/** What the run's tool registry says about verification, and that it was the registry that said it. */
export interface VerificationToolingRecord {
  readonly source: "tool registry offered to this turn";
  /** How many tools the run was offered. */
  readonly offered: number;
  /** Those that run a check: a build, tests, the game. */
  readonly checkTools: readonly string[];
}

/**
 * Null when the registry was not measured, or when this turn's offer may hide
 * a check tool the registry holds: the ordinary gates apply.
 *
 * The names are the turn's offer: the registry minus the tools whose measured
 * availability is false (a dotnet tool with no project file, a Unity tool with
 * no bridge). Two narrowings hide tools that still run, and either one makes
 * the offer no measure of what is missing:
 * - restrictToProgressTools offers only the writers for one turn;
 * - a plan node that names a tool is offered the core set and that family
 *   (selectNodeTools), which withholds e.g. dotnet_build.
 */
export function measureVerificationTooling(
  toolNames: readonly string[] | undefined,
  taskDescription: string,
): VerificationToolingRecord | null {
  if (!toolNames || toolNames.length === 0) return null;
  if (toolNames.every((name) => PROGRESS_MUTATION_TOOLS.has(name))) return null;
  if (isNodeScopedTask(taskDescription) && selectNodeTools(taskDescription, toolNames.map((name) => ({ name }))).narrowed) {
    return null;
  }
  return {
    source: "tool registry offered to this turn",
    offered: toolNames.length,
    checkTools: toolNames.filter(runsVerificationCheck),
  };
}

/** The draft says its result is not verified. English and Turkish. */
const NOT_VERIFIED_RE =
  /\b(?:not\s+(?:been\s+|yet\s+)?verified|unverified|(?:could\s*n[o']?t|cannot|can'?t)\s+(?:be\s+)?verif(?:y|ied))\b|doğrulanma(?:dı|mış|madı)|doğrulanamadı|doğrulanamaz/iu;

export function draftSaysNotVerified(draft: string | null | undefined): boolean {
  return NOT_VERIFIED_RE.test(draft ?? "");
}

export type UnverifiableFailureOutcome = "ask" | "closed";

type Evidence = Pick<
  CompletionReviewEvidence,
  "recentFailures" | "recentFailuresRetriedOk" | "recentLogIssues" | "verificationStepCount"
> & { readonly hasTerminalFailureReport: boolean };

/** Null: this exit does not apply and the ordinary checks decide. */
export function unverifiableFailureOutcome(
  evidence: Evidence,
  tooling: VerificationToolingRecord | null,
  draft: string,
): UnverifiableFailureOutcome | null {
  if (!tooling || tooling.checkTools.length > 0) return null;
  if (evidence.hasTerminalFailureReport || evidence.verificationStepCount > 0) return null;
  if (evidence.recentFailures.length === 0 || evidence.recentFailuresRetriedOk !== true) return null;
  if (evidence.recentLogIssues.length > 0) return null;
  return draftSaysNotVerified(draft) ? "closed" : "ask";
}

export interface UnverifiableFailureCheck {
  readonly name: "unverifiable-failure";
  readonly status: "issues";
  readonly summary: string;
  readonly gate?: string;
}

export function unverifiableFailureCheck(
  outcome: UnverifiableFailureOutcome,
  evidence: Pick<CompletionReviewEvidence, "recentFailures">,
  tooling: VerificationToolingRecord,
): UnverifiableFailureCheck {
  const failures = evidence.recentFailures.slice(-3).map((f) => `- ${sanitizePromptInjection(f)}`);
  const measured =
    `none of the ${tooling.offered} tools in the ${tooling.source} runs a build, a test or another check`;
  if (outcome === "closed") {
    return {
      name: "unverifiable-failure",
      status: "issues",
      summary:
        `Not verified: ${evidence.recentFailures.length} failed step(s) were re-run successfully, ` +
        `${measured}, and the draft says the result is not verified.`,
    };
  }
  return {
    name: "unverifiable-failure",
    status: "issues",
    summary: `A failed step was re-run successfully, ${measured}, and the draft does not say the result is not verified.`,
    gate: [
      "[NO VERIFICATION TOOL] Steps in this run failed, and the same tools then succeeded:",
      ...failures,
      "",
      `Nothing here can verify that: ${measured}.`,
      "Do not report the work as verified or simply as done. Finish now with your report, and say in it",
      "plainly that the result is not verified: name what failed and that nothing in this project can check it.",
    ].join("\n"),
  };
}

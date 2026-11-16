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
 * The exit is decided from recorded facts only, one row per input in
 * {@link UnverifiableDecision} (the table goes into the evidence). It opens
 * only when every input allows it, and an input that cannot be read keeps the
 * gate. The draft's words never open it: three earlier versions leaned on a
 * soft signal that fell open when it was unsure (QA of #41, 2026-11-15/16).
 *
 * When it opens, the system tells the user itself: {@link unverifiedNotice}
 * builds "Not verified: …" from the record, in the task's language: each
 * failed call and its target, and the call that answered it and its target.
 * The run's final answer carries it whatever the draft says (agent-core
 * reflection.ts, settleVisibleBoundary, through {@link takeUnverifiedNotice}).
 * A draft that claims a check passed contradicts the record: the gate asks
 * once for an honest report. That reading can only add the ask; the notice
 * is attached either way.
 *
 * docs/memory/entries/2026-11-11-unverifiable-failure-closes-on-an-honest-report.md
 * records the alternatives.
 */

import { PROGRESS_MUTATION_TOOLS, runsVerificationCheck } from "./constants.js";
import { isNodeScopedTask, selectNodeTools } from "./node-tool-offer.js";
import { sanitizePromptInjection } from "../../security/prompt-injection.js";
import { measureProjectChecks, type ProjectCheckRecord } from "./verifier-pipeline-project-checks.js";
import type { CompletionReviewEvidence, FailureAnswer } from "./completion-review.js";
import { detectSupervisorFeedbackLanguage, type SupervisorFeedbackLanguage } from "../../supervisor/supervisor-feedback.js";

/** What the run's tool registry says about verification, and that it was the registry that said it. */
export interface VerificationToolingRecord {
  readonly source: "tool registry offered to this turn";
  /** How many tools the run was offered. */
  readonly offered: number;
  /** Those that run a check: a build, tests, the game. */
  readonly checkTools: readonly string[];
  /** What the project declares for shell_exec to run; null when shell_exec is not offered. */
  readonly projectChecks: ProjectCheckRecord | null;
}

/**
 * Why this turn's offer is no measure of what the registry holds, or null
 * when it is one. The names are the turn's offer: the registry minus the tools
 * whose measured availability is false (a dotnet tool with no project file, a
 * Unity tool with no bridge). Two narrowings hide tools that still run:
 * restrictToProgressTools offers only the writers for one turn, and a plan
 * node that names a tool is offered the core set and that family
 * (selectNodeTools), which withholds e.g. dotnet_build.
 */
export function offerUnknownBecause(toolNames: readonly string[] | undefined, taskDescription: string): string | null {
  if (!toolNames || toolNames.length === 0) return "no tool list was passed in";
  if (toolNames.every((name) => PROGRESS_MUTATION_TOOLS.has(name))) return "only the writers were offered this turn (restrictToProgressTools)";
  if (isNodeScopedTask(taskDescription) && selectNodeTools(taskDescription, toolNames.map((name) => ({ name }))).narrowed) {
    return "the plan node's offer was narrowed to the tools it names (selectNodeTools)";
  }
  return null;
}

/** Null when the offer or, with shell_exec offered, the project root cannot be read: the ordinary gates apply. */
export function measureVerificationTooling(
  toolNames: readonly string[] | undefined,
  taskDescription: string,
  projectPath?: string,
): VerificationToolingRecord | null {
  if (!toolNames || offerUnknownBecause(toolNames, taskDescription) !== null) return null;
  let projectChecks: ProjectCheckRecord | null = null;
  if (toolNames.includes("shell_exec")) {
    projectChecks = projectPath ? measureProjectChecks(projectPath) : null;
    if (!projectChecks) return null;
  }
  return {
    source: "tool registry offered to this turn",
    offered: toolNames.length,
    checkTools: toolNames.filter(runsVerificationCheck),
    projectChecks,
  };
}

// ─── The draft's claim: it can add one ask, never open anything ────────────

/** A phrase that says a check passed. English and Turkish; the Turkish negatives are other words. */
const CHECK_PASSED_RE =
  /\b(?:verified|tested|tests?\s+(?:pass(?:ed|es|ing)?|succeed(?:ed|s)?|(?:are|is)\s+green)|all\s+tests|(?:build|compil(?:e|ation))\s+(?:pass(?:ed|es)?|succeed(?:ed|s)?|is\s+(?:clean|green))|compiles\s+(?:cleanly|without\s+errors?))\b|test\s+edildi|test\s+ettim|doğrulandı|doğruladım|testler\s+geç(?:ti|iyor)|derleme\s+başarılı/giu;
/** A word in the three before a phrase that turns it around: "not verified", "could not be tested". */
const NEGATION_RE = /\b(?:not|no|never|nothing|cannot|can'?t|couldn'?t|wasn'?t|weren'?t|isn'?t|aren'?t|without|none)\b/iu;
/**
 * Where a clause ends: a negation behind it is about something else. "No
 * errors, verified it works" claims a check (QA of #41, 2026-11-16). The mark
 * must be followed by a space or the end, so "lantern.txt" is one word.
 */
const CLAUSE_END_RE = /[,;:.!?](?=\s|$)|\n/gu;

/** The draft says a check passed. Only the ask reads this. */
export function draftClaimsCheckPassed(draft: string | null | undefined): boolean {
  const text = draft ?? "";
  for (const match of text.matchAll(CHECK_PASSED_RE)) {
    const before = text.slice(0, match.index);
    const clauseStart = Math.max(0, ...[...before.matchAll(CLAUSE_END_RE)].map((end) => end.index + end[0].length));
    const window = before.slice(clauseStart).split(/\s+/u).filter(Boolean).slice(-3).join(" ");
    if (!NEGATION_RE.test(window)) return true;
  }
  return false;
}

// ─── The decision table ─────────────────────────────────────────────────────

export type DecisionEffect = "allows" | "keeps the gate" | "unknown: keeps the gate" | "asks once" | "no effect";

/** One input of the decision: what it asks, where it is read, what was read, and what an unknown does. */
export interface DecisionInput {
  readonly input: string;
  readonly source: string;
  readonly value: string;
  readonly whenUnknown: string;
  readonly effect: DecisionEffect;
}

export interface UnverifiableDecision {
  /** Every input that decides allows the exit. */
  readonly opens: boolean;
  readonly inputs: readonly DecisionInput[];
  /** Opened, and the draft claims a check passed for the first time in this run: ask once. */
  readonly ask: boolean;
  /** What the user is told when the exit opens without an ask, in the task's language. */
  readonly notice?: string;
  /** Why nothing here can check it, from the offer: what the worker's ask says. */
  readonly nothingCanCheck: string;
}

type Evidence = Pick<
  CompletionReviewEvidence,
  "recentFailures" | "recentFailuresRetriedOk" | "recentFailureAnswers" | "recentLogIssues" | "verificationStepCount"
> & { readonly hasTerminalFailureReport: boolean };

const KEEPS = "unknown: keeps the gate" as const;

function offerRow(toolNames: readonly string[] | undefined, taskDescription: string, tooling: VerificationToolingRecord | null): DecisionInput {
  const unknown = offerUnknownBecause(toolNames, taskDescription);
  const base = { input: "a tool that runs a check is offered", source: "the tool names offered to this turn", whenUnknown: "keeps the gate" };
  if (unknown) return { ...base, value: unknown, effect: KEEPS };
  const checks = (toolNames ?? []).filter(runsVerificationCheck);
  return checks.length > 0
    ? { ...base, value: `${checks.length} of ${toolNames!.length} run a check: ${checks.join(", ")}`, effect: "keeps the gate" }
    : { ...base, value: `none of the ${tooling?.offered ?? toolNames!.length} offered tools runs a check`, effect: "allows" };
}

function projectRow(
  toolNames: readonly string[] | undefined,
  taskDescription: string,
  projectPath: string | undefined,
  tooling: VerificationToolingRecord | null,
): DecisionInput {
  const base = { input: "the project declares a check shell_exec could run", source: "the project root's manifests", whenUnknown: "keeps the gate" };
  if (offerUnknownBecause(toolNames, taskDescription)) return { ...base, value: "not read: the offer itself is unknown", effect: KEEPS };
  if (!toolNames?.includes("shell_exec")) return { ...base, value: "shell_exec is not offered: nothing could run one", effect: "allows" };
  const checks = tooling?.projectChecks;
  if (!checks) return { ...base, value: projectPath ? "the project root could not be read" : "no project root was passed in", effect: KEEPS };
  return checks.found.length > 0
    ? { ...base, value: `declares ${checks.found.join(", ")}`, effect: "keeps the gate" }
    : { ...base, value: `none of the ${checks.looked.length} manifests looked for`, effect: "allows" };
}

/**
 * The table, and what it decides. Rows 1-6 decide whether the exit opens;
 * row 7 decides only whether it asks first.
 */
export function decideUnverifiableExit(params: {
  readonly evidence: Evidence;
  /** What measureVerificationTooling read; the project's manifests come from it. */
  readonly tooling: VerificationToolingRecord | null;
  readonly toolNames: readonly string[] | undefined;
  readonly taskDescription: string;
  readonly projectPath: string | undefined;
  readonly lastVerificationAt: number | null;
  readonly draft: string;
  readonly runKey: string;
  /** The task's prompt: the notice is written in its language. */
  readonly prompt: string;
}): UnverifiableDecision {
  const { evidence } = params;
  const checkRan = evidence.verificationStepCount > 0 || params.lastVerificationAt !== null;
  const failures = evidence.recentFailures.length;
  const answered = evidence.recentFailuresRetriedOk === true;
  const claims = draftClaimsCheckPassed(params.draft);
  const askedBefore = (claimAsks.get(params.runKey) ?? 0) > 0;
  const deciding: DecisionInput[] = [
    offerRow(params.toolNames, params.taskDescription, params.tooling),
    projectRow(params.toolNames, params.taskDescription, params.projectPath, params.tooling),
    {
      input: "a check already ran in this run",
      source: "the run's verification steps and the verification state's last verification time",
      value: checkRan ? `yes (${evidence.verificationStepCount} step(s) with a verdict)` : "no",
      whenUnknown: "always known",
      effect: checkRan ? "keeps the gate" : "allows",
    },
    {
      input: "every open failure was answered by a later success",
      source: "the run's step results: input signatures, and the paths writers named (failureAnsweredBy)",
      value: failures === 0
        ? "no failure is open: there is nothing for this exit to close"
        : answered
          ? howAnswered(evidence.recentFailureAnswers ?? [])
          : "no: a failed call was not run again, and no write of its path or file name followed it",
      whenUnknown: "a step without an input signature, or a writer without a path, is not answered: keeps the gate",
      effect: failures > 0 && answered ? "allows" : "keeps the gate",
    },
    {
      input: "no warn/error log entry is open",
      source: "the log ring buffer, after the last verification",
      value: `${evidence.recentLogIssues.length} open`,
      whenUnknown: "always known",
      effect: evidence.recentLogIssues.length === 0 ? "allows" : "keeps the gate",
    },
    {
      input: "the draft does not report that the run failed",
      source: "the draft (isTerminalFailureReport); it can only keep the gate",
      value: evidence.hasTerminalFailureReport ? "it does: the honest failure report's own exit applies" : "it does not",
      whenUnknown: "always known",
      effect: evidence.hasTerminalFailureReport ? "keeps the gate" : "allows",
    },
  ];
  const opens = deciding.every((row) => row.effect === "allows");
  const ask = opens && claims && !askedBefore;
  const claimRow: DecisionInput = {
    input: "the draft claims a check passed",
    source: "the draft (draftClaimsCheckPassed); it only adds one ask, the notice is attached either way",
    value: claims ? (askedBefore ? "yes, and it was asked once already" : "yes") : "no",
    whenUnknown: "always known",
    effect: ask ? "asks once" : "no effect",
  };
  const offered = params.toolNames?.length ?? 0;
  const shellOffered = params.toolNames?.includes("shell_exec") === true;
  const language = detectSupervisorFeedbackLanguage(params.prompt);
  return {
    opens,
    inputs: [...deciding, claimRow],
    ask,
    nothingCanCheck: NOTICE.en.nothing(offered, shellOffered),
    ...(opens && !ask
      ? { notice: unverifiedNotice(evidence.recentFailureAnswers ?? [], { offered, shellOffered }, claims, language) }
      : {}),
  };
}

/** "yes: 1 run again with the same input; 1 whose file name the same tool wrote later in another directory" */
function howAnswered(answers: readonly FailureAnswer[]): string {
  const count = (kind: FailureAnswer["kind"]) => answers.filter((a) => a.kind === kind).length;
  const parts = [
    count("rerun") > 0 ? `${count("rerun")} run again with the same input` : "",
    count("same-path") > 0 ? `${count("same-path")} whose path the same tool wrote later` : "",
    count("same-name") > 0 ? `${count("same-name")} whose file name the same tool wrote later in another directory` : "",
  ].filter(Boolean);
  return `yes: ${parts.join("; ")}`;
}

interface Words {
  readonly head: string;
  readonly rerun: (call: string, error: string) => string;
  readonly samePath: (call: string, error: string, tool: string, path: string) => string;
  readonly sameName: (call: string, error: string, tool: string, path: string) => string;
  readonly earlier: (n: number) => string;
  readonly nothing: (offered: number, shellOffered: boolean) => string;
  readonly why: (nothing: string) => string;
  readonly claim: string;
}

/** The notice's words, in the languages the system speaks to the user (supervisor-feedback.ts detects which). */
const NOTICE: Readonly<Record<SupervisorFeedbackLanguage, Words>> = {
  en: {
    head: "Not verified:",
    rerun: (call, error) => `${call} failed (${error}), then the same call, with the same input, succeeded.`,
    samePath: (call, error, tool, path) => `${call} failed (${error}), then ${tool} wrote ${path} again.`,
    sameName: (call, error, tool, path) =>
      `${call} failed (${error}), then ${tool} wrote ${path} (the same file name, in another directory).`,
    earlier: (n) => `${n} earlier failed step(s) are not listed.`,
    nothing: (offered, shellOffered) =>
      `none of the ${offered} available tools runs a build or a test` +
      (shellOffered ? ", and the project declares no build or test command" : ""),
    why: (nothing) => `Nothing here could check the result: ${nothing}.`,
    claim: "The report above mentions a check, but no check ran in this run.",
  },
  tr: {
    head: "Doğrulanmadı:",
    rerun: (call, error) => `${call} başarısız oldu (${error}); ardından aynı çağrı, aynı girdiyle, başarıyla koştu.`,
    samePath: (call, error, tool, path) => `${call} başarısız oldu (${error}); ardından ${tool} ${path} yolunu yeniden yazdı.`,
    sameName: (call, error, tool, path) =>
      `${call} başarısız oldu (${error}); ardından ${tool} ${path} dosyasını yazdı (aynı dosya adı, başka bir dizinde).`,
    earlier: (n) => `Daha önceki ${n} başarısız adım listelenmedi.`,
    nothing: (offered, shellOffered) =>
      `sunulan ${offered} aracın hiçbiri derleme ya da test çalıştırmıyor` +
      (shellOffered ? " ve proje hiçbir derleme ya da test komutu bildirmiyor" : ""),
    why: (nothing) => `Sonucu burada hiçbir şey denetleyemedi: ${nothing}.`,
    claim: "Yukarıdaki rapor bir denetimden söz ediyor, ama bu çalışmada hiçbir denetim koşmadı.",
  },
};

const clip = (text: string, max: number): string => sanitizePromptInjection(text).slice(0, max);

/** One failure and what answered it, as recorded: the failed call's target, its error, and the answering call's target. */
function answerSentence(answer: FailureAnswer, words: Words): string {
  const call = answer.failedTarget ? `${answer.tool} ${clip(answer.failedTarget, 120)}` : answer.tool;
  const error = clip(answer.error, 160);
  const target = clip(answer.answerTarget ?? "", 120);
  if (answer.kind === "same-path") return words.samePath(call, error, answer.tool, target);
  if (answer.kind === "same-name") return words.sameName(call, error, answer.tool, target);
  return words.rerun(call, error);
}

/**
 * What the user reads under the answer when the exit opens, in the task's
 * language. Built from the record: each failed call and its target, the call
 * that answered it and its target, and why nothing here could check the
 * result. It never says "redone": a write of another file is not a redo.
 */
export function unverifiedNotice(
  answers: readonly FailureAnswer[],
  offer: { readonly offered: number; readonly shellOffered: boolean },
  draftClaimsCheck: boolean,
  language: SupervisorFeedbackLanguage,
): string {
  const words = NOTICE[language];
  const shown = answers.slice(-3);
  return [
    words.head,
    ...shown.map((answer) => answerSentence(answer, words)),
    answers.length > shown.length ? words.earlier(answers.length - shown.length) : "",
    words.why(words.nothing(offer.offered, offer.shellOffered)),
    draftClaimsCheck ? words.claim : "",
  ].filter(Boolean).join(" ");
}

export interface UnverifiableFailureCheck {
  readonly name: "unverifiable-failure";
  readonly status: "issues";
  readonly summary: string;
  readonly gate?: string;
}

/** The check that stands in for targeted-repro and unverified-failure once the exit opens. */
export function unverifiableFailureCheck(
  decision: UnverifiableDecision,
  evidence: Pick<CompletionReviewEvidence, "recentFailures">,
  runKey: string,
): UnverifiableFailureCheck {
  if (!decision.ask) {
    return {
      name: "unverifiable-failure",
      status: "issues",
      summary: `${decision.notice ?? ""} (every input of the decision allowed the exit: evidence.unverifiableDecision)`,
    };
  }
  claimAsks.set(runKey, (claimAsks.get(runKey) ?? 0) + 1);
  if (claimAsks.size > 512) claimAsks.delete(claimAsks.keys().next().value as string);
  const failures = evidence.recentFailures.slice(-3).map((f) => `- ${sanitizePromptInjection(f)}`);
  return {
    name: "unverifiable-failure",
    status: "issues",
    summary: "The draft says a check passed, but no check ran in this run and nothing here can run one.",
    gate: [
      "[NO VERIFICATION TOOL] Your report says a check passed, but no check ran in this run. Steps failed, and later calls answered them:",
      ...failures,
      "",
      `Nothing here can verify that: ${decision.nothingCanCheck}.`,
      "Rewrite the report without claiming a check: say what you did and what failed. The user is told the result is not verified.",
    ].join("\n"),
  };
}

// ─── Per-run state: the one ask, and the notice the final answer carries ───

/** Run key (chatId:taskStartedAtMs) → asks made for a claimed check. */
const claimAsks = new Map<string, number>();
/** Run key → the notice of the run's latest approve with the exit open. */
const pendingNotices = new Map<string, string>();

export function unverifiableRunKey(chatId: string, taskStartedAtMs: number): string {
  return `${chatId}:${taskStartedAtMs}`;
}

/** Each verifier verdict replaces the run's notice: an approve with the exit open sets it, any other clears it. */
export function recordUnverifiedNotice(runKey: string, notice: string | undefined): void {
  if (notice === undefined) {
    pendingNotices.delete(runKey);
    return;
  }
  pendingNotices.set(runKey, notice);
  if (pendingNotices.size > 512) pendingNotices.delete(pendingNotices.keys().next().value as string);
}

/** The notice the run's final answer must carry, once. */
export function takeUnverifiedNotice(chatId: string, taskStartedAtMs: number): string | undefined {
  const key = unverifiableRunKey(chatId, taskStartedAtMs);
  const notice = pendingNotices.get(key);
  pendingNotices.delete(key);
  return notice;
}

/** The answer, then the notice: once, after a blank line. */
export function withUnverifiedNotice(text: string | undefined, notice: string | undefined): string | undefined {
  if (!notice) return text;
  const body = (text ?? "").trimEnd();
  if (body.includes(notice)) return text;
  return body ? `${body}\n\n${notice}` : notice;
}

/** Test hook. */
export function resetUnverifiableState(): void {
  claimAsks.clear();
  pendingNotices.clear();
}

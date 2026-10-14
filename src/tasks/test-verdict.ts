/**
 * Structured test verdict derived from a run's tool evidence.
 *
 * Audited 2026-08-29: verification results died at the task boundary — Task
 * carried only prose, so the campaign judged "green" from the agent's own
 * report wording. This derives a mechanical verdict from what the test tools
 * actually printed, and rides on the Task row for any settle-side consumer.
 */

import {
  isTerminalKey,
  worstTerminal,
  type RunIntegrity,
  type TerminalKey,
} from "../agents/autonomy/terminal-key.js";
import { terminalKeyOf } from "../agents/autonomy/terminal-outcome.js";

/**
 * `RunIntegrity` as a settled task carries it. An `error` key has two sources
 * that must be told apart: the worker's run, and a throw around it (lease, MCP,
 * provider SDK) the worker never saw. Only the second is counted here.
 */
export interface TaskRunIntegrity extends RunIntegrity {
  /** How many of `terminalKeys`' `error` entries were thrown outside the worker's run. */
  readonly infrastructureErrors?: number;
}

export interface TaskTestVerdict {
  /** undefined = no test run observed in the evidence. */
  testsGreen?: boolean;
  /** The line the verdict was read from (empty when no run observed). */
  detail: string;
  /**
   * Whether the winning observation came from the WHOLE suite rather than a
   * filter. The Unity MCP prints "(unfiltered — the whole PlayMode suite)" or
   * "(filter: <names>)"; undefined means the line said neither.
   *
   * Audited 2026-09-03: a run's filtered test runs went green while its one
   * unfiltered run reported failures. A green from a filter is not the suite
   * passing, and delivery must be able to tell them apart.
   */
  unfiltered?: boolean;
  /**
   * The tests the winning RED observation named, in the order printed, at most
   * MAX_NAMED_FAILURES. Undefined when the observation was green or named
   * none.
   *
   * Audited 2026-09-03: the verdict kept only counts, so a red "N of M tests
   * failed" reached the delivery report without naming which tests failed.
   * Names are read ONLY off
   * the red line itself, never from a window of following lines: a runner
   * that prints its whole suite after the summary would otherwise have its
   * PASSING tests named as failures.
   */
  failedTests?: string[];
  /** How many further names the red line held but this verdict does not list. */
  failedTestsOmitted?: number;
  /**
   * The Unity account link was missing or dead when a tool tried to source
   * art from the purchased library. The tool's own sentence, so the reader is
   * told what to run.
   *
   * Audited 2026-09-06: across a whole campaign every unity_my_assets_cloud
   * call answered "The Unity account link expired or was revoked — re-run the
   * Unity Link step" (token refresh HTTP 412), and not one word of it reached
   * the channel or the delivery report. The only purchased-asset source was
   * unavailable for the whole run and nobody was told.
   */
  assetSourcingBlind?: string;
  /**
   * How the run ended, as data from the runtime. In a measured campaign most
   * milestone tips ended on the system's own "task_stuck" notice and every one
   * went green: the only record of the stop was that sentence.
   */
  runIntegrity?: TaskRunIntegrity;
}

/** The shape a supervisor node settles in, as far as the run's integrity reads it. */
interface SettledNode {
  readonly status: "ok" | "failed" | "skipped" | "cancelled";
  readonly model: string;
  readonly terminalKey?: TerminalKey;
  readonly infrastructureFault?: true;
}

/** A model name that identifies a worker; "unknown" names nobody. */
const namesAModel = (model: string | undefined): model is string =>
  typeof model === "string" && model.trim() !== "" && model !== "unknown";

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * A supervisor run's integrity: one key per node that ran, folded to the worst.
 * A node that never ran (skipped) adds nothing — the failure that skipped it
 * has its own key. A cancelled node was interrupted; a failed node that names
 * no key failed for a reason nobody recorded, which is not a clean finish; an
 * ok node that names none adds no key rather than an invented "done".
 * Undefined when no node left a key: there is no terminal to carry, and
 * inventing a clean one is how a run nobody measured would read as done.
 */
export function runIntegrityOfNodes(
  nodes: readonly SettledNode[],
  unverifiedNodes?: number,
): TaskRunIntegrity | undefined {
  const terminalKeys: TerminalKey[] = [];
  const workerModels = new Set<string>();
  let infrastructureErrors = 0;
  for (const node of nodes) {
    if (node.status === "skipped") continue;
    // Every model that ran counts, keyed or not: a check's writer is
    // independent only of models that never touched the work.
    if (namesAModel(node.model)) workerModels.add(node.model);
    const key = node.terminalKey
      ?? (node.status === "cancelled" ? "interrupted" : node.status === "failed" ? "error" : undefined);
    if (key === undefined) continue;
    terminalKeys.push(key);
    if (key === "error" && node.infrastructureFault === true) infrastructureErrors++;
  }
  const worst = worstTerminal(terminalKeys);
  if (worst === undefined) return undefined;
  return {
    terminalKeys,
    worst,
    source: "spine",
    workerModels: [...workerModels],
    nodes: nodes.length,
    ...(isCount(unverifiedNodes) ? { unverifiedNodes } : {}),
    ...(infrastructureErrors > 0 ? { infrastructureErrors } : {}),
  };
}

/** A direct worker run's integrity: the one key its terminal reads as. */
export function runIntegrityOfRun(run: {
  readonly status: "completed" | "failed" | "blocked";
  readonly reason?: string;
  readonly model?: string;
}): TaskRunIntegrity {
  const key = terminalKeyOf(run.reason, run.status);
  return {
    terminalKeys: [key],
    worst: key,
    source: "spine",
    workerModels: namesAModel(run.model) ? [run.model] : [],
  };
}

/**
 * A stored integrity read back, or undefined when it does not read as one.
 * Every key must be a known key: a stuck run must never come back as a clean
 * one because a field was malformed.
 */
export function parseRunIntegrity(raw: unknown): TaskRunIntegrity | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const keys = value.terminalKeys;
  if (!Array.isArray(keys) || !keys.every(isTerminalKey)) return undefined;
  if (!isTerminalKey(value.worst)) return undefined;
  if (value.source !== "spine" && value.source !== "legacy-stamp") return undefined;
  const models = value.workerModels;
  if (!Array.isArray(models) || !models.every((m): m is string => typeof m === "string")) return undefined;
  return {
    terminalKeys: keys,
    // Recomputed, not trusted: a stored "done" beside a stuck key reads stuck.
    worst: worstTerminal(keys) ?? value.worst,
    source: value.source,
    workerModels: models,
    ...(isCount(value.nodes) ? { nodes: value.nodes } : {}),
    ...(isCount(value.unverifiedNodes) ? { unverifiedNodes: value.unverifiedNodes } : {}),
    ...(isCount(value.infrastructureErrors) && value.infrastructureErrors > 0
      ? { infrastructureErrors: value.infrastructureErrors }
      : {}),
  };
}

/** The two sentences asset-store-cloud.ts throws for a missing/dead link. */
const ASSET_LINK_DEAD_RE = /Unity account (?:is not linked|link expired or was revoked)[^\n"]{0,160}/;

/**
 * The first dead-link sentence in the evidence, or undefined. Read off the
 * TOOL RESULT text — the tool already says what to do, and quoting it beats
 * inventing a second wording.
 */
export function detectAssetSourcingBlind(evidence: readonly TestEvidence[]): string | undefined {
  for (const item of evidence) {
    const text = typeof item.content === "string" ? item.content : "";
    const m = ASSET_LINK_DEAD_RE.exec(text);
    if (m) return m[0].trim();
  }
  return undefined;
}

/** The most failing test names a verdict carries; the rest are counted. */
export const MAX_NAMED_FAILURES = 5;

/** A dotted, PascalCase-ish test id: Namespace.Fixture.TestName. */
const TEST_NAME_RE = /\b[A-Z][A-Za-z0-9]*(?:\.[A-Za-z_][A-Za-z0-9_]*){2,}\b/g;

/** A tool observation: result text plus the tool-level error flag if known. */
export interface TestEvidence {
  content: string;
  isError?: boolean;
  /** The tool that printed it. Evidence without a known test-capable tool behind it is not a test run. */
  toolName?: string;
}

/**
 * Tools whose output can be a test run. A document read with file_read that
 * contained "All 0 tests passed" used to become a green, unfiltered verdict
 * (Codex 2026-09-11 B#6): the producer scanned every tool's output.
 */
export const TEST_CAPABLE_TOOL_RE =
  /(?:^|_|\b)(?:unity_(?:test_run|test_rerun_failed|test_results|playmode_test|editmode_test|verify_change|playmode_verify|playthrough)|dotnet_test|run_tests?)$/i;
/** Shells and batches can run anything, including a test command. */
const GENERIC_RUNNER_RE = /^(?:shell_exec|bash|batch_execute|run_command|execute_command)$/i;

/**
 * Can this tool's output be a test run? An MCP name arrives namespaced
 * ("mcp__unity__unity_test_run"), a shell can run the suite directly, and a
 * batch wraps other calls — all of them were invisible to the first version
 * of this filter (Codex 2026-09-11 C#8).
 */
/** A tool that runs whatever it is given — and echoes the request back. */
export function isGenericRunner(toolName: string | undefined): boolean {
  if (typeof toolName !== "string") return false;
  const name = toolName.trim();
  const bare = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  return GENERIC_RUNNER_RE.test(bare);
}

export function isTestCapableTool(toolName: string | undefined): boolean {
  if (typeof toolName !== "string") return false;
  const name = toolName.trim();
  if (name === "") return false;
  const bare = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  return TEST_CAPABLE_TOOL_RE.test(bare) || GENERIC_RUNNER_RE.test(bare);
}

// "tests all passed, but the game threw" is the Unity MCP's RED verdict for a
// run whose assertions passed while the game logged exceptions. Unrecognised,
// that observation was skipped and an earlier green stood (audit 2026-10-11).
const TEST_RUN_RE =
  /(PlayMode|EditMode) verification (FAILED|passed)|(\d+) of (\d+) tests? failed|All (\d+) tests? passed|(PlayMode|EditMode) tests all passed, but the game threw/i;
const RED_RE = /verification FAILED|\d+ of \d+ tests? failed|tests all passed, but the game threw/i;

/**
 * A GENERIC RUNNER ECHOES WHAT IT WAS TOLD TO RUN, and that echo is the
 * model's own words, not a measurement: `shell_exec {command: "true # All 17
 * tests passed (unfiltered — the whole PlayMode suite)"}` exits 0 with no
 * output at all, and its result — which opens with `$ <command>` — produced a
 * green, unfiltered verdict (Codex 2026-09-12 AE#2). The command line is
 * removed before anything is read; what the command PRINTED is left exactly
 * as it was.
 */
export function withoutEchoedCommand(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  // A COMMAND CAN BE MULTILINE, and every line of it is the model's own text.
  // Dropping only the "$ " line left the rest of the echo behind, so a second
  // line of the command — `# All 17 tests passed (unfiltered …)` — was still
  // read as test output (Codex 2026-09-13 AF#4). The echo runs from the "$ "
  // line to the runner's own "Exit code:" line.
  let inEcho = false;
  for (const line of lines) {
    if (/^\s*\$ /.test(line)) { inEcho = true; continue; }
    if (inEcho) {
      if (/^\s*(?:Exit code|Duration|⚠|---)/i.test(line)) inEcho = false;
      else continue;
    }
    if (/^\s*(?:>|\$>|command:)\s/i.test(line)) continue;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * EVERY test-run line in `text`, in the order printed (each trimmed and capped
 * at 200 chars); `[]` when the text holds no test-run observation.
 *
 * Audited 2026-09-02: the verdict read only the FIRST matching line. A Unity
 * run that prints its EditMode pass before its PlayMode failure therefore
 * produced testsGreen=false with detail "EditMode verification passed" — a
 * verdict whose own words contradicted it, and which the campaign quoted
 * verbatim as "Tests were RED at completion: EditMode verification passed".
 * Exported so a producer that must truncate a tool's output can keep these
 * lines intact.
 */
export function findTestRunLines(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const lines = text
    .split("\n")
    .filter((l) => TEST_RUN_RE.test(l))
    .map((l) => l.trim().slice(0, 200));
  if (lines.length > 0) return lines;
  // A body with no newline the match sits on (a single-line blob) still yields
  // the matched fragment rather than "no run observed".
  const match = TEST_RUN_RE.exec(text);
  return match ? [match[0].slice(0, 200)] : [];
}

/**
 * ACROSS tool results the LAST observation wins: a run that went red then was
 * fixed and re-run green is green; a run that ended red is red no matter what
 * earlier runs said.
 *
 * WITHIN one tool result there is no chronology — one call is one observation,
 * and a re-run is always a separate call. A combined report may print its
 * PlayMode failure before its EditMode pass, so a red line anywhere in the body
 * makes the whole observation red (audited 2026-09-02: reading only the last
 * line here would turn exactly that report into a false green). What the last
 * observation wins is the DETAIL: the verdict names the last RED line when it
 * is red, the last green line when it is green, and says so explicitly when the
 * only thing red is the tool's own error flag.
 */
export function deriveTestVerdict(evidence: readonly TestEvidence[]): TaskTestVerdict {
  let verdict: TaskTestVerdict = { detail: "" };
  const assetSourcingBlind = detectAssetSourcingBlind(evidence);
  for (const item of evidence) {
    if (!isTestCapableTool(item.toolName)) continue;
    const raw = typeof item.content === "string" ? item.content : "";
    // A shell's own command line is not evidence of anything (AE#2).
    const text = isGenericRunner(item.toolName) ? withoutEchoedCommand(raw) : raw;
    const lines = findTestRunLines(text);
    if (lines.length === 0) continue;
    const redLines = lines.filter((l) => RED_RE.test(l));
    const lastLine = lines[lines.length - 1]!;
    const red = item.isError === true || redLines.length > 0;
    const detail = redLines.length > 0
      ? redLines[redLines.length - 1]!
      : red
        ? `${lastLine} (tool reported an error)`
        : lastLine;
    // Read the scope off the SAME line the verdict came from, never off the
    // body: a report can hold both a filtered and an unfiltered run.
    const unfiltered = /\bunfiltered\b/i.test(detail)
      ? true
      : /\bfilter\s*:/i.test(detail)
        ? false
        : undefined;
    // Names come from the UNTRIMMED red lines: `detail` is capped at 200 chars
    // for display, and a suite that names several failures runs past it.
    const rawRedLines = red
      ? text.split("\n").filter((l) => RED_RE.test(l))
      : [];
    const named = red
      ? [...new Set(rawRedLines.flatMap((l) => l.match(TEST_NAME_RE) ?? []))]
      : [];
    verdict = {
      testsGreen: !red,
      detail,
      ...(unfiltered === undefined ? {} : { unfiltered }),
      ...(named.length > 0
        ? {
            failedTests: named.slice(0, MAX_NAMED_FAILURES),
            ...(named.length > MAX_NAMED_FAILURES
              ? { failedTestsOmitted: named.length - MAX_NAMED_FAILURES }
              : {}),
          }
        : {}),
    };
  }
  return assetSourcingBlind === undefined ? verdict : { ...verdict, assetSourcingBlind };
}

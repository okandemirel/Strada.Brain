/**
 * Golden run of the failure paths: what the loop does when something goes
 * wrong, through the REAL bootstrap with only the edges of the process
 * replaced (src/tests/helpers/golden-run-harness.ts says what, and why).
 *
 * golden-run.test.ts pins the happy path. The paths that break most often
 * were seen only in a live run. Each run here pins one of them — every
 * provider call in order, what the tools reported, what reached the project,
 * what the user read, and how the task was recorded:
 *
 * 1. A short request never meets the supervisor: one worker, then the review
 *    of its draft.
 * 2. The supervisor throws. The orchestrator catches it and one worker runs
 *    the request. What the user is told about it is pinned.
 * 3. Everything fails once. The planner answers in prose and is asked again;
 *    a node's write is refused for its target, and the node writes the right
 *    path and finishes; the provider drops two calls of the next node, which
 *    is asked again at once without streaming and then on its next turn.
 * 4. A node's write fails at run time. Its next write succeeds, but the
 *    failure waits for a verification the project has none of, and the node
 *    is blocked; the blocked goal is resumed without waiting for a person
 *    and the node runs again.
 *
 * When a deliberate change alters the calls a run makes, the failure names
 * the step it expected and the call it got. Update that run's script in the
 * same commit and say in the message what changed in the loop and why.
 */

import { describe, it, expect, vi } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../../agents/providers/provider-registry.js", async (original) =>
  (await import("../helpers/golden-run-edges.js")).scriptedProviderRegistry(original));
vi.mock("../../core/bootstrap-channels.js", async (original) =>
  (await import("../helpers/golden-run-edges.js")).scriptedChannels(original));
vi.mock("../../vault/framework-vault-targets.js", async (original) =>
  (await import("../helpers/golden-run-edges.js")).noFrameworkVaultTargets(original));

import {
  offers,
  requires,
  say,
  textOf,
  toolResultIds,
  type ProviderCall,
  type Step,
} from "../helpers/golden-run-edges.js";
import {
  GOLDEN_RUN_TIMEOUT_MS,
  GOLDEN_WORKING_DIR,
  isolationDisabled,
  runGolden,
  settledWhenAnswered,
} from "../helpers/golden-run-harness.js";
import { TERMINAL_STATUSES, TaskStatus, type Task } from "../../tasks/types.js";
import { SupervisorBrain } from "../../supervisor/supervisor-brain.js";

// ─── Script pieces ───────────────────────────────────────────────────────────

const writeCall = (id: string, path: string, content: string) =>
  ({ id, name: "file_write", input: { path, content } });

/** The worker's prompt starts with its task. */
const isWorkerOn = (task: string) =>
  (call: ProviderCall): string | false =>
    !textOf(call.messages[0]).startsWith(task) && `the worker's task is not "${task.slice(0, 60)}…"`;

/** A fresh worker run: its first turn carries only the task. */
const isFirstTurn = (call: ProviderCall): string | false =>
  call.messages.length !== 1 && `the run is not fresh: ${call.messages.length} message(s)`;

const lastSays = (call: ProviderCall, marker: string): string | false =>
  !textOf(call.messages.at(-1)).includes(marker) && `the last message does not say "${marker}"`;

const carriesResult = (call: ProviderCall, id: string): string | false =>
  !toolResultIds(call.messages.at(-1)).includes(id) && `the last message carries no result for ${id}`;

function planStep(step: string, task: string): Step {
  return {
    step,
    check: (call) =>
      requires([
        isWorkerOn(task)(call),
        isFirstTurn(call),
        // One tool list in every phase (phase-write-access.ts): a write called now is refused.
        !offers(call, "file_write") && "the planning turn does not offer file_write",
      ]),
    reply: say("Plan: write the file with file_write, then report."),
  };
}

function actStep(
  step: string,
  task: string,
  writes: ReturnType<typeof writeCall>[],
  extra?: (call: ProviderCall) => string | false,
): Step {
  return {
    step,
    check: (call) =>
      requires([isWorkerOn(task)(call), !offers(call, "file_write") && "file_write is not offered", extra?.(call) ?? false]),
    reply: { text: "", toolCalls: writes, stopReason: "tool_use" },
  };
}

function reportStep(step: string, task: string, callIds: readonly string[], done: string): Step {
  return {
    step,
    check: (call) => requires([isWorkerOn(task)(call), ...callIds.map((id) => carriesResult(call, id))]),
    reply: say(done),
  };
}

function decomposeStep(step: string, request: string, reply: string, retry = false): Step {
  return {
    step,
    check: (call) => {
      const prompt = textOf(call.messages.at(-1));
      return requires([
        !prompt.includes("Decompose this task into sub-goals") && "this is not the goal decomposer",
        !prompt.includes(request) && "the decomposer is not given the request",
        retry && !prompt.startsWith("Previous attempt failed to produce valid JSON") &&
          "the second attempt does not say why the first was refused",
      ]);
    },
    reply: say(reply),
  };
}

const twoNodes = (first: string, second: string): string =>
  JSON.stringify({
    nodes: [
      { id: "s1", task: first, dependsOn: [], needsFurtherDecomposition: false },
      { id: "s2", task: second, dependsOn: ["s1"], needsFurtherDecomposition: false },
    ],
  });

/**
 * A worker that runs outside the supervisor has its final draft reviewed
 * before the user sees it, against the request it was given. Measured
 * 2026-11-06: the review's "User request" was the session's last user-role
 * message, which after a tool call is a tool result (no text) or a system
 * nudge, so the reviewer judged the draft without the request.
 */
function visibilityReviewStep(step: string, request: string, draft: string): Step {
  return {
    step,
    check: (call) => {
      const prompt = textOf(call.messages.at(-1));
      return requires([
        !prompt.startsWith("Decide whether the current worker draft is safe to surface") && "this is not the visibility review",
        !prompt.includes(`User request:\n${request}\n`) && `the reviewer is not shown the request "${request.slice(0, 60)}…"`,
        !prompt.includes(`Candidate visible draft:\n${draft}`) && `the reviewer is not shown "${draft}"`,
      ]);
    },
    reply: say('{"decision":"allow","reason":"the requested files are written"}'),
  };
}

function verifyStep(node: string, done: string): Step {
  return {
    step: `${node}: verify`,
    check: (call) => {
      const prompt = textOf(call.messages.at(-1));
      return requires([
        !prompt.startsWith("Review this supervisor worker result") && "this is not the node verifier",
        !prompt.includes(`Worker output:\n${done}`) && `the verifier is not shown "${done}"`,
      ]);
    },
    reply: say('{"verdict":"approve"}'),
  };
}

// ─── Run 1: a short request ──────────────────────────────────────────────────

/** Under 60 characters: the classifier rates it simple, so no supervisor is asked and no plan is decomposed. */
const SHORT_REQUEST = "Create notes/gamma.txt containing the word GAMMA.";
const GAMMA_DONE = "Wrote notes/gamma.txt.";

const SHORT_SCRIPT: readonly Step[] = [
  planStep("gamma: plan", SHORT_REQUEST),
  actStep("gamma: act", SHORT_REQUEST, [writeCall("call_gamma", "notes/gamma.txt", "GAMMA\n")]),
  reportStep("gamma: report", SHORT_REQUEST, ["call_gamma"], GAMMA_DONE),
  visibilityReviewStep("gamma: review the draft", SHORT_REQUEST, GAMMA_DONE),
];

// ─── Run 2: the supervisor throws ────────────────────────────────────────────

/** 120+ characters: the classifier rates it complex, so the supervisor is asked first. */
const FALLBACK_REQUEST =
  "Create two plain text files in the project: notes/delta.txt containing the word DELTA, " +
  "and notes/omega.txt containing the word OMEGA. Nothing else.";
const FALLBACK_DONE = "Wrote notes/delta.txt and notes/omega.txt.";
/** What the supervisor fails with. The orchestrator catches it and hands the request to one worker. */
const SUPERVISOR_FAULT = "golden run: the supervisor failed before planning";
/** The one sentence the user is told when the supervisor fails and one worker takes the request over. */
const FALLBACK_NOTICE = "Planning across several agents failed, so one agent is handling this request on its own.";
/** The note the task record keeps of it: what failed, and with which error. */
const FALLBACK_NOTE = `Supervisor failed; one agent takes the request over. Error: ${SUPERVISOR_FAULT}`;

const FALLBACK_SCRIPT: readonly Step[] = [
  planStep("worker: plan", FALLBACK_REQUEST),
  // A request this long is decomposed by the worker itself, inside its loop.
  decomposeStep(
    "worker: decompose its plan",
    FALLBACK_REQUEST,
    twoNodes("Create notes/delta.txt containing the word DELTA", "Create notes/omega.txt containing the word OMEGA"),
  ),
  actStep("worker: act", FALLBACK_REQUEST, [
    writeCall("call_delta", "notes/delta.txt", "DELTA\n"),
    writeCall("call_omega", "notes/omega.txt", "OMEGA\n"),
  ]),
  reportStep("worker: report", FALLBACK_REQUEST, ["call_delta", "call_omega"], FALLBACK_DONE),
  visibilityReviewStep("worker: review the draft", FALLBACK_REQUEST, FALLBACK_DONE),
];

// ─── Run 3: everything fails once ────────────────────────────────────────────

const RECOVERY_REQUEST =
  "Create two plain text files in the project: notes/alpha.txt containing the word ALPHA, " +
  "and notes/beta.txt containing the word BETA. Nothing else.";
const NODE_ALPHA = "Create notes/alpha.txt containing the word ALPHA";
const NODE_BETA = "Create notes/beta.txt containing the word BETA";
const ALPHA_DONE = "Wrote notes/alpha.txt.";
const BETA_DONE = "Wrote notes/beta.txt.";
const RECOVERY_ANSWER = `${ALPHA_DONE}\n\n${BETA_DONE}`;
/** Outside the project: file_write refuses it, and the worker must read the refusal and write again. */
const ESCAPING_PATH = "../outside/alpha.txt";
/** The provider drops two of beta's calls in a row, the way a busy upstream does. */
const PROVIDER_DROP = "503 Service Unavailable: the upstream is overloaded";
/** What the session is told when a turn's every attempt dropped. */
const isFailureNotice = (call: ProviderCall): boolean =>
  textOf(call.messages.at(-1)).startsWith("[System: The AI provider (deepseek) failed to respond") &&
  textOf(call.messages.at(-1)).includes(PROVIDER_DROP);

const RECOVERY_SCRIPT: readonly Step[] = [
  decomposeStep("decompose: the planner answers in prose", RECOVERY_REQUEST,
    "I would split this in two: first write alpha, then write beta."),
  decomposeStep("decompose again, told why the first answer was refused", RECOVERY_REQUEST,
    twoNodes(NODE_ALPHA, NODE_BETA), true),
  planStep("alpha: plan", NODE_ALPHA),
  actStep("alpha: act, on a path outside the project", NODE_ALPHA,
    [writeCall("call_alpha_escape", ESCAPING_PATH, "ALPHA\n")]),
  actStep("alpha: act again, after reading the refusal", NODE_ALPHA,
    [writeCall("call_alpha_fixed", "notes/alpha.txt", "ALPHA\n")],
    (call) => carriesResult(call, "call_alpha_escape")),
  // The refused write did nothing and the next write succeeded, so the
  // refusal leaves no failing path open: alpha is done on its first attempt.
  // Measured 2026-11-06, before the fix: the refusal waited for a
  // verification this project has none of; the worker was asked six times,
  // blocked, and alpha ran again from the start.
  reportStep("alpha: report", NODE_ALPHA, ["call_alpha_fixed"], ALPHA_DONE),
  planStep("beta: plan", NODE_BETA),
  // Two layers retry a dropped call. The turn asks again at once without
  // streaming; when that drops too, the turn ends empty with a notice in the
  // session, and the run's failure ledger allows the next turn.
  { ...actStep("beta: act, and the provider drops the call", NODE_BETA, []), reply: new Error(PROVIDER_DROP) },
  {
    ...actStep("beta: the same turn asked again without streaming, dropped again", NODE_BETA, [],
      (call) => isFailureNotice(call) && "the first drop already reached the session"),
    reply: new Error(PROVIDER_DROP),
  },
  actStep("beta: act, the next turn, told the provider failed", NODE_BETA, [writeCall("call_beta", "notes/beta.txt", "BETA\n")],
    (call) => !isFailureNotice(call) && "the session carries no notice of the drop"),
  reportStep("beta: report", NODE_BETA, ["call_beta"], BETA_DONE),
  // Cheapest node first (ResultAggregator): beta answered in three calls, alpha in four.
  verifyStep("beta", BETA_DONE),
  verifyStep("alpha", ALPHA_DONE),
];

// ─── Run 4: a write fails at run time ────────────────────────────────────────

const RUNTIME_REQUEST =
  "Create two plain text files in the project: notes/kappa.txt containing the word KAPPA, " +
  "and notes/sigma.txt containing the word SIGMA. Nothing else.";
const NODE_KAPPA = "Create notes/kappa.txt containing the word KAPPA";
const NODE_SIGMA = "Create notes/sigma.txt containing the word SIGMA";
const KAPPA_DONE = "Wrote notes/kappa.txt.";
const SIGMA_DONE = "Wrote notes/sigma.txt.";
const RUNTIME_ANSWER = `${KAPPA_DONE}\n\n${SIGMA_DONE}`;
/** Inside the project, under a FILE: the guard lets it through, and the filesystem fails the write. */
const UNDER_A_FILE = "README.md/kappa.txt";
/** What the worker answers a gate it cannot satisfy: the project has no build and no tests. */
const CANNOT_VERIFY = "notes/kappa.txt is written. This project has no build and no tests to run.";
/**
 * What the user is told when kappa is blocked: each step by its task, why it
 * did not finish, and that the executor resumes the goal on its own.
 */
const BLOCKED =
  "Steps finished: 0 of 2.\n\n" +
  `Could not finish "${NODE_KAPPA}" (it kept trying without making progress)\n` +
  `Did not start "${NODE_SIGMA}" (a step it depends on did not finish)\n\n` +
  "Retrying automatically now (automatic retry 1); finished steps are kept.";

/**
 * A step that failed at run time stays open until a verification runs after
 * it, and the project has none to run. The worker is told so after each
 * answer, told it is stalling, and blocked by loop detection after its third
 * text-only turn.
 */
function gateStep(n: number, marker: string): Step {
  return {
    step: `kappa: gate ${n}, "${marker}"`,
    check: (call) => requires([isWorkerOn(NODE_KAPPA)(call), lastSays(call, marker)]),
    reply: say(CANNOT_VERIFY),
  };
}
const UNVERIFIED = "[VERIFIER PIPELINE] Internal verification is not clean yet.";
const STALLING = "[STALE ANALYSIS DETECTED]";

const RUNTIME_SCRIPT: readonly Step[] = [
  decomposeStep("decompose", RUNTIME_REQUEST, twoNodes(NODE_KAPPA, NODE_SIGMA)),
  planStep("kappa: plan", NODE_KAPPA),
  actStep("kappa: act, on a path under a file", NODE_KAPPA,
    [writeCall("call_kappa_fails", UNDER_A_FILE, "KAPPA\n")]),
  actStep("kappa: act again, after reading the failure", NODE_KAPPA,
    [writeCall("call_kappa_fixed", "notes/kappa.txt", "KAPPA\n")],
    (call) => carriesResult(call, "call_kappa_fails")),
  reportStep("kappa: report", NODE_KAPPA, ["call_kappa_fixed"], KAPPA_DONE),
  gateStep(1, UNVERIFIED),
  gateStep(2, UNVERIFIED),
  gateStep(3, STALLING),
  gateStep(4, STALLING),
  gateStep(5, UNVERIFIED),
  gateStep(6, UNVERIFIED),
  // Loop detection blocks kappa, sigma is skipped, and the task is blocked.
  // The executor resumes the blocked goal at once: kappa runs again, fresh.
  planStep("kappa, resumed: plan", NODE_KAPPA),
  actStep("kappa, resumed: act", NODE_KAPPA, [writeCall("call_kappa", "notes/kappa.txt", "KAPPA\n")]),
  reportStep("kappa, resumed: report", NODE_KAPPA, ["call_kappa"], KAPPA_DONE),
  planStep("sigma: plan", NODE_SIGMA),
  actStep("sigma: act", NODE_SIGMA, [writeCall("call_sigma", "notes/sigma.txt", "SIGMA\n")]),
  reportStep("sigma: report", NODE_SIGMA, ["call_sigma"], SIGMA_DONE),
  verifyStep("kappa", KAPPA_DONE),
  verifyStep("sigma", SIGMA_DONE),
];

/**
 * The resumed task settles as usual (settledWhenAnswered). A blocked task
 * the executor has not resumed within RESUME_GRACE_MS is not going to be (the
 * resume is decided in the same tick as the block): the run settles there,
 * and the assertions say what is missing.
 */
const RESUME_GRACE_MS = 5_000;
function settledAfterResume(): (tasks: readonly Task[], delivered: readonly string[]) => boolean {
  let terminalSince: number | undefined;
  return (tasks, delivered) => {
    if (tasks.length > 1) return settledWhenAnswered(tasks, delivered);
    const only = tasks[0];
    if (!only || !TERMINAL_STATUSES.has(only.status)) return false;
    terminalSince ??= Date.now();
    return Date.now() - terminalSince > RESUME_GRACE_MS;
  };
}

// ─── The runs ────────────────────────────────────────────────────────────────

/** What bootstrap tells every chat when it starts: not part of any run. */
const SYSTEM_STATUS = expect.stringMatching(/^\*System Status\*\n/);

const texts = (run: { delivered: readonly { text: string }[] }): string[] => run.delivered.map((m) => m.text);
/** Every progress note the run's task records hold, oldest task first. */
const progressOf = (run: { tasks: readonly Task[] }): string[] => run.tasks.flatMap((t) => t.progress.map((p) => p.message));

describe("golden run: failure and recovery paths through the real bootstrap", () => {
  it("a short request goes straight to one worker: no supervisor, no decomposition, no node verifier", async () => {
    const run = await runGolden({ name: "short", request: SHORT_REQUEST, script: SHORT_SCRIPT, settled: settledWhenAnswered });

    expect(run.strayEntries, `the run wrote into ${GOLDEN_WORKING_DIR}`).toEqual([]);
    expect(isolationDisabled(run), "the run had no workspace leases").toEqual([]);
    expect(readdirSync(run.leaseRoot), "a lease was never released").toEqual([]);
    expect(run.violations).toEqual([]);
    expect(run.served).toEqual(SHORT_SCRIPT.map((s) => s.step));
    expect(readFileSync(join(run.project, "notes", "gamma.txt"), "utf8")).toBe("GAMMA\n");
    expect(existsSync(join(run.project, "README.md"))).toBe(true);
    expect(run.toolResults.map((r) => ({ id: r.toolCallId, isError: r.isError }))).toEqual([
      { id: "call_gamma", isError: false },
    ]);
    expect(run.tasks.map((t) => t.status), `task error: ${run.task?.error ?? "none"}`).toEqual([TaskStatus.completed]);
    expect(run.task?.result).toBe(GAMMA_DONE);
    expect(texts(run)).toEqual([SYSTEM_STATUS, GAMMA_DONE]);
    expect(progressOf(run).filter((m) => m.startsWith("Supervisor failed")), "no supervisor failed").toEqual([]);
  }, GOLDEN_RUN_TIMEOUT_MS);

  it("a supervisor that throws hands the request to one worker", async () => {
    const fault = vi.spyOn(SupervisorBrain.prototype, "execute").mockRejectedValueOnce(new Error(SUPERVISOR_FAULT));
    let supervisorCalls = 0;
    const run = await runGolden({
      name: "supervisor-throws",
      request: FALLBACK_REQUEST,
      script: FALLBACK_SCRIPT,
      settled: settledWhenAnswered,
    }).finally(() => {
      supervisorCalls = fault.mock.calls.length;
      fault.mockRestore();
    });

    expect(supervisorCalls, "the supervisor was never asked").toBe(1);
    expect(run.strayEntries, `the run wrote into ${GOLDEN_WORKING_DIR}`).toEqual([]);
    expect(isolationDisabled(run), "the run had no workspace leases").toEqual([]);
    expect(readdirSync(run.leaseRoot), "a lease was never released").toEqual([]);
    expect(run.violations).toEqual([]);
    expect(run.served).toEqual(FALLBACK_SCRIPT.map((s) => s.step));
    expect(readFileSync(join(run.project, "notes", "delta.txt"), "utf8")).toBe("DELTA\n");
    expect(readFileSync(join(run.project, "notes", "omega.txt"), "utf8")).toBe("OMEGA\n");

    // The task record: completed with the worker's answer, and a note of the
    // failure that names the supervisor's error. Until 2026-11-06 only a log
    // line said the supervisor had failed.
    expect(run.tasks.map((t) => t.status), `task error: ${run.task?.error ?? "none"}`).toEqual([TaskStatus.completed]);
    expect(run.task?.result).toBe(FALLBACK_DONE);
    expect(run.task?.error).toBeUndefined();
    expect(progressOf(run)).toContain(FALLBACK_NOTE);

    // What the user read, in order: one sentence that the supervisor failed
    // and one agent took the request over, before the worker's own plan.
    // Measured 2026-11-06, before the fix: nothing said so, and the worker's
    // plan read as though the request had been planned as usual.
    expect(texts(run)).toEqual([
      SYSTEM_STATUS,
      FALLBACK_NOTICE,
      expect.stringMatching(/^\*\*Execution Plan\*\*\n\nI broke this work into 2 steps\.\n/),
      FALLBACK_DONE,
    ]);
    expect(texts(run).filter((t) => t === FALLBACK_NOTICE), "the user is told once").toHaveLength(1);
  }, GOLDEN_RUN_TIMEOUT_MS);

  it("a node recovers from a refused tool, dropped provider calls and a planner that answered in prose", async () => {
    const run = await runGolden({
      name: "recovery",
      request: RECOVERY_REQUEST,
      script: RECOVERY_SCRIPT,
      settled: settledWhenAnswered,
    });

    expect(run.strayEntries, `the run wrote into ${GOLDEN_WORKING_DIR}`).toEqual([]);
    expect(isolationDisabled(run), "the run had no workspace leases").toEqual([]);
    expect(readdirSync(run.leaseRoot), "a lease was never released").toEqual([]);
    expect(run.violations).toEqual([]);
    expect(run.served).toEqual(RECOVERY_SCRIPT.map((s) => s.step));

    // What each tool reported back: the refusal first, then every write.
    expect(run.toolResults.map((r) => ({ id: r.toolCallId, isError: r.isError }))).toEqual([
      { id: "call_alpha_escape", isError: true },
      { id: "call_alpha_fixed", isError: false },
      { id: "call_beta", isError: false },
    ]);
    expect(run.toolResults[0]?.content).toMatch(/^Error: Path resolves outside the project directory/);
    expect(existsSync(join(run.project, "..", "outside"))).toBe(false);
    // The worker writes in a lease, so an escape that got through would land beside it.
    expect(existsSync(join(run.leaseRoot, "outside"))).toBe(false);

    // The work reached the project.
    expect(readFileSync(join(run.project, "notes", "alpha.txt"), "utf8")).toBe("ALPHA\n");
    expect(readFileSync(join(run.project, "notes", "beta.txt"), "utf8")).toBe("BETA\n");

    // One task, completed with the answer on its first attempt: nothing was
    // blocked and nothing resumed.
    expect(run.tasks.map((t) => t.status), `task error: ${run.task?.error ?? "none"}`).toEqual([TaskStatus.completed]);
    expect(run.task?.result).toBe(RECOVERY_ANSWER);
    expect(texts(run)).toEqual([SYSTEM_STATUS, RECOVERY_ANSWER]);
    // The supervisor ran this request and did not fail: no fallback sentence,
    // and no fallback note in the task record.
    expect(texts(run)).not.toContain(FALLBACK_NOTICE);
    expect(progressOf(run).filter((m) => m.startsWith("Supervisor failed")), "no supervisor failed").toEqual([]);
  }, GOLDEN_RUN_TIMEOUT_MS);

  it("a node whose write failed at run time waits for a verification: blocked, then resumed on its own", async () => {
    const run = await runGolden({
      name: "runtime-failure",
      request: RUNTIME_REQUEST,
      script: RUNTIME_SCRIPT,
      settled: settledAfterResume(),
    });

    expect(run.strayEntries, `the run wrote into ${GOLDEN_WORKING_DIR}`).toEqual([]);
    expect(run.violations).toEqual([]);
    expect(run.served).toEqual(RUNTIME_SCRIPT.map((s) => s.step));

    // What each tool reported back: the failed write first, then every write.
    expect(run.toolResults.map((r) => ({ id: r.toolCallId, isError: r.isError }))).toEqual([
      { id: "call_kappa_fails", isError: true },
      { id: "call_kappa_fixed", isError: false },
      { id: "call_kappa", isError: false },
      { id: "call_sigma", isError: false },
    ]);
    // The guard let the path through: the write ran, and the filesystem failed it.
    expect(run.toolResults[0]?.content).toMatch(/^Error: could not write file \(E[A-Z]+\)\n/);

    // The work reached the project.
    expect(readFileSync(join(run.project, "notes", "kappa.txt"), "utf8")).toBe("KAPPA\n");
    expect(readFileSync(join(run.project, "notes", "sigma.txt"), "utf8")).toBe("SIGMA\n");

    // The task records: the first run blocked, and the resume is a new task
    // in its lineage that completed with the answer.
    const [blocked, resumed] = run.tasks;
    expect(run.tasks.map((t) => t.status), `task error: ${run.task?.error ?? "none"}`).toEqual([
      TaskStatus.blocked,
      TaskStatus.completed,
    ]);
    expect(blocked?.result).toBe(BLOCKED);
    expect(blocked?.result, "an internal goal id reached the user").not.toMatch(/goal_/);
    expect(resumed?.parentId).toBe(blocked?.id);
    expect(resumed?.result).toBe(RUNTIME_ANSWER);

    // What the user read, in order: which step stopped and why, which step
    // never started, and that the work is being retried on its own; then the
    // answer. Measured 2026-11-06, before the fix: "Blocked:\n[goal_…]
    // blocked\n\nSkipped:\n[goal_…] Skipped: dependency failed", internal ids
    // with no reason, and nothing said the work was being resumed.
    expect(texts(run)).toEqual([SYSTEM_STATUS, BLOCKED, RUNTIME_ANSWER]);
    // The supervisor ran this request and did not fail: no fallback sentence,
    // and no fallback note in either task record.
    expect(texts(run)).not.toContain(FALLBACK_NOTICE);
    expect(progressOf(run).filter((m) => m.startsWith("Supervisor failed")), "no supervisor failed").toEqual([]);
  }, GOLDEN_RUN_TIMEOUT_MS);
});

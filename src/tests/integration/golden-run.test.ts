/**
 * Golden run: one small task through the real loop, end to end.
 *
 * The REAL bootstrap() runs every stage and wires every object; only the
 * edges of the process are replaced. What is replaced, and why a golden run
 * exists at all: src/tests/helpers/golden-run-harness.ts. The failure paths
 * have their own run: golden-run-recovery.test.ts.
 *
 * The chain it pins, in order: the message router hands the request to a
 * background task; the supervisor admits it and the goal decomposer splits it
 * into two dependent nodes; the execute-node bridge hands each node to the
 * background executor, which runs a worker loop on the orchestrator (plan,
 * act with file_write, report) in a workspace lease of the node's own; the
 * second node's prompt carries the first node's result; each node is
 * verified; the answer reaches the chat, the files reach the project when the
 * leases are published, and the task is recorded as completed.
 *
 * When a deliberate change alters the calls the loop makes, the failure names
 * the step it expected and the call it got. Update SCRIPT in the same commit
 * and say in the message what changed in the loop and why.
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
import { TaskStatus } from "../../tasks/types.js";
import { TURN_CONTEXT_HEADER } from "../../agents/turn-context.js";

// ─── The task ────────────────────────────────────────────────────────────────

/** 120+ characters: the classifier rates it complex, so the supervisor admits it. */
const REQUEST =
  "Create two plain text files in the project: notes/alpha.txt containing the word ALPHA, " +
  "and notes/beta.txt containing the word BETA. Nothing else.";
const NODE_ALPHA = "Create notes/alpha.txt containing the word ALPHA";
const NODE_BETA = "Create notes/beta.txt containing the word BETA";
const ALPHA_DONE = "Wrote notes/alpha.txt.";
const BETA_DONE = "Wrote notes/beta.txt.";
/** What the user is told: the supervisor joins the nodes' reports. */
const ANSWER = `${ALPHA_DONE}\n\n${BETA_DONE}`;

// ─── The script ──────────────────────────────────────────────────────────────

/** One supervisor node run by a worker: a plan turn, an action turn, a report turn. */
function workerSteps(node: "alpha" | "beta", task: string, done: string, carries?: string): Step[] {
  const isThisNode = (call: ProviderCall): string | false => {
    const prompt = textOf(call.messages[0]);
    if (!prompt.startsWith(task)) return `the worker's task is not "${task}"`;
    if (carries && !(prompt.includes("## Completed dependencies") && prompt.includes(carries))) {
      return `the prompt does not carry the dependency's result "${carries}"`;
    }
    return false;
  };
  const callId = `call_${node}`;
  return [
    {
      step: `${node}: plan`,
      check: (call) =>
        requires([
          isThisNode(call),
          !offers(call, "file_write") && "the planning turn does not offer file_write",
          !textOf(call.messages.at(-1)).includes("## Writes in this phase") &&
            "the planning turn's context does not say that a write is refused",
        ]),
      reply: say(`Plan: write notes/${node}.txt with file_write, then report.`),
    },
    {
      step: `${node}: act`,
      check: (call) =>
        requires([
          isThisNode(call),
          !offers(call, "file_write") && "file_write is not offered",
          toolResultIds(call.messages.at(-1)).length > 0 && "a tool already ran",
        ]),
      reply: {
        text: "",
        toolCalls: [
          { id: callId, name: "file_write", input: { path: `notes/${node}.txt`, content: `${node.toUpperCase()}\n` } },
        ],
        stopReason: "tool_use",
      },
    },
    {
      step: `${node}: report`,
      check: (call) =>
        requires([
          isThisNode(call),
          !toolResultIds(call.messages.at(-1)).includes(callId) && `the last message carries no result for ${callId}`,
        ]),
      reply: say(done),
    },
  ];
}

function verifyStep(node: "alpha" | "beta", done: string): Step {
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

const SCRIPT: readonly Step[] = [
  {
    step: "decompose the request",
    check: (call) => {
      const prompt = textOf(call.messages.at(-1));
      return requires([
        !prompt.startsWith("Decompose this task into sub-goals") && "this is not the goal decomposer",
        !prompt.includes(REQUEST) && "the decomposer is not given the request",
      ]);
    },
    reply: say(
      JSON.stringify({
        nodes: [
          { id: "s1", task: NODE_ALPHA, dependsOn: [], needsFurtherDecomposition: false },
          { id: "s2", task: NODE_BETA, dependsOn: ["s1"], needsFurtherDecomposition: false },
        ],
      }),
    ),
  },
  ...workerSteps("alpha", NODE_ALPHA, ALPHA_DONE),
  ...workerSteps("beta", NODE_BETA, BETA_DONE, ALPHA_DONE),
  verifyStep("alpha", ALPHA_DONE),
  verifyStep("beta", BETA_DONE),
];

// ─── The run ─────────────────────────────────────────────────────────────────

describe("golden run: a two-node task through the real bootstrap", () => {
  it("decomposes, hands each node to the executor, runs the worker loop and delivers", async () => {
    const run = await runGolden({ name: "two-nodes", request: REQUEST, script: SCRIPT, settled: settledWhenAnswered });
    const { task, project } = run;
    const answers = run.delivered.map((m) => m.text);

    // Nothing landed in the checkout the test runs from.
    expect(
      run.strayEntries,
      `the run wrote into the working directory ${GOLDEN_WORKING_DIR}: a path resolved against it`,
    ).toEqual([]);

    // Every provider call was the step the script expected, and every step ran.
    expect(run.violations).toEqual([]);
    expect(run.served).toEqual(SCRIPT.map((s) => s.step));

    // The tools ran: what file_write reported back to the worker, in order.
    expect(
      run.toolResults.map((r) => ({ id: r.toolCallId, name: r.name, isError: r.isError })),
    ).toEqual([
      { id: "call_alpha", name: "file_write", isError: false },
      { id: "call_beta", name: "file_write", isError: false },
    ]);
    expect(run.toolResults.map((r) => r.content)).toEqual([
      expect.stringMatching(/^File written: notes\/alpha\.txt\b/),
      expect.stringMatching(/^File written: notes\/beta\.txt\b/),
    ]);

    // The work reached the project.
    expect(readFileSync(join(project, "notes", "alpha.txt"), "utf8")).toBe("ALPHA\n");
    expect(readFileSync(join(project, "notes", "beta.txt"), "utf8")).toBe("BETA\n");
    expect(existsSync(join(project, "README.md"))).toBe(true);

    // It reached the project through workspace leases: each node's worker wrote into a lease
    // of its own, and its one file landed when the lease was published. Every lease was then
    // released. Until 2026-11-06 a golden run had no lease, and workers wrote the project directly.
    expect(isolationDisabled(run), "the run had no workspace leases").toEqual([]);
    expect(run.logged.filter((l) => l.message === "Workspace lease committed").map((l) => l.meta)).toEqual([
      expect.objectContaining({ files: 1, conflicts: 0 }),
      expect.objectContaining({ files: 1, conflicts: 0 }),
    ]);
    expect(readdirSync(run.leaseRoot), "a lease was never released").toEqual([]);

    // A node's worker sends one system prompt and one tool list, byte for byte, on every call.
    // What a step rebuilds (the plan, the iteration, the role, the phase's write rule) rides at
    // the end of the call's last user turn (src/agents/turn-context.ts): a system prompt or a
    // tool list that changed between calls made the provider's prefix cache miss the history.
    // Until 2026-11-11 the planning call's list had no write tools (phase-write-access.ts).
    for (const node of ["alpha", "beta"] as const) {
      const callFor = (step: string): ProviderCall => run.calls[run.served.indexOf(`${node}: ${step}`)]!;
      const [plan, act, report] = [callFor("plan"), callFor("act"), callFor("report")];
      expect(act.systemPrompt, `${node}: the system prompt changed between plan and act`).toBe(plan.systemPrompt);
      expect(report.systemPrompt, `${node}: the system prompt changed between act and report`).toBe(act.systemPrompt);
      expect(JSON.stringify(act.tools), `${node}: the tool list changed between plan and act`).toBe(JSON.stringify(plan.tools));
      expect(JSON.stringify(report.tools), `${node}: the tool list changed within EXECUTING`).toBe(JSON.stringify(act.tools));
      expect(textOf(act.messages.at(-1))).not.toContain("## Writes in this phase");
      expect(plan.systemPrompt).not.toContain("Current iteration");
      expect(textOf(act.messages.at(-1))).toContain(TURN_CONTEXT_HEADER);
      expect(textOf(report.messages.at(-1))).toMatch(/Current iteration: \d+/);
    }

    // The task is recorded as done, and the answer reached the chat.
    expect(task?.status, `task error: ${task?.error ?? "none"}`).toBe(TaskStatus.completed);
    expect(answers).toContain(ANSWER);
    // …and is the last thing the user read: nothing reported after it.
    expect(answers.at(-1)).toBe(ANSWER);
  }, GOLDEN_RUN_TIMEOUT_MS);
});

/**
 * A refused target that a later call put right does not hold the node open.
 *
 * Measured 2026-11-06 (golden run): a worker wrote outside the project, read
 * the refusal and wrote the right path. The refusal stayed a "failing path"
 * that only a verification could close, the project had no build and no tests
 * to run, and the node was asked six times and blocked. Both directions are
 * pinned: the refusal closes once the same tool succeeds; a tool that RAN and
 * failed still waits for a verification, even when its next call succeeds.
 *
 * The steps are made the way the loop makes them: the real file_write's
 * results, recorded by recordStepResultsAndCheckReflection.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentPhase, type AgentState } from "../agent-state.js";
import { recordStepResultsAndCheckReflection } from "../orchestrator-loop-utils.js";
import type { ToolResult } from "../providers/provider-core.interface.js";
import { FileWriteTool } from "../tools/file-write.js";
import { planVerifierPipeline, resetNoWorkEvidenceGates } from "./verifier-pipeline.js";

const sandbox = mkdtempSync(join(tmpdir(), "refused-target-"));
const project = join(sandbox, "project");
mkdirSync(project);
writeFileSync(join(project, "README.md"), "# a project with no build and no tests\n");
const ctx = { projectPath: project, workingDirectory: project, readOnly: false };

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  resetNoWorkEvidenceGates();
});

const TASK = "Create notes/kappa.txt containing the word KAPPA";
const DRAFT = "Wrote notes/kappa.txt.";
/** Outside the project: the guard refuses it before anything is written. */
const REFUSED = "../outside/kappa.txt";
/** Inside the project, under a FILE: the tool runs, and the filesystem fails it. */
const FAILS_AT_RUN_TIME = "README.md/kappa.txt";

type Call = readonly [tool: string, path: string];

/** Each call run for real, in order, and recorded as the loop records it. */
async function stateAfter(calls: readonly Call[]): Promise<AgentState> {
  let agentState: AgentState = {
    phase: AgentPhase.EXECUTING,
    taskDescription: TASK,
    iteration: 0,
    plan: "Write the file with file_write, then report.",
    stepResults: [],
    failedApproaches: [],
    reflectionCount: 0,
    lastReflection: null,
    consecutiveErrors: 0,
    learnedInsights: [],
  };
  const tool = new FileWriteTool();
  for (const [index, [name, path]] of calls.entries()) {
    const id = `call_${index}`;
    const result = name === "file_write"
      ? await tool.execute({ path, content: "KAPPA\n" }, ctx)
      : { content: `Read ${path}` };
    const toolResult: ToolResult = { toolCallId: id, content: result.content, isError: "isError" in result ? result.isError : undefined };
    ({ agentState } = recordStepResultsAndCheckReflection({
      agentState,
      toolCalls: [{ id, name, input: { path } }],
      toolResults: [toolResult],
      reflectInterval: 1_000,
    }));
  }
  return agentState;
}

async function verdictAfter(calls: readonly Call[]) {
  const state = await stateAfter(calls);
  return planVerifierPipeline({
    prompt: TASK,
    draft: DRAFT,
    state,
    task: { type: "implementation", complexity: "simple", criticality: "low" },
    verificationState: {
      pendingFiles: new Set(),
      touchedFiles: new Set(["notes/kappa.txt"]),
      hasCompilableChanges: false,
      lastBuildOk: null,
      lastVerificationAt: null,
    },
    buildVerificationGate: null,
    conformanceGate: null,
    logEntries: [],
    chatId: "chat-refused-target",
    taskStartedAtMs: Date.now() - 60_000,
    buildToolsAvailable: true,
  });
}

describe("a refused target, then the same tool succeeds", () => {
  it("approves: the refused call did nothing, so there is no failing path to re-run", async () => {
    const plan = await verdictAfter([["file_write", REFUSED], ["file_write", "notes/kappa.txt"]]);

    expect(plan.evidence.recentFailures).toEqual([]);
    expect(plan.checks.find((c) => c.name === "targeted-repro")?.status).toBe("clean");
    expect(plan.gate).toBeUndefined();
    expect(plan.initialDecision).toBe("approve");
  });
});

describe("what still waits for a verification", () => {
  it("a write that ran and failed, even when the next write succeeds", async () => {
    const plan = await verdictAfter([["file_write", FAILS_AT_RUN_TIME], ["file_write", "notes/kappa.txt"]]);

    expect(plan.evidence.recentFailures).toEqual([expect.stringMatching(/^file_write: Error: could not write file \(E[A-Z]+\)$/)]);
    expect(plan.initialDecision).toBe("continue");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
    expect(plan.gate).toContain("[UNVERIFIED FAILURE]");
  });

  it("a refused target that no later call of the same tool put right", async () => {
    const plan = await verdictAfter([["file_write", REFUSED], ["file_read", "README.md"]]);

    expect(plan.evidence.recentFailures).toEqual([expect.stringMatching(/^file_write: Error: Path resolves outside the project directory/)]);
    expect(plan.initialDecision).toBe("continue");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
  });

  it("a refused target whose only success came before it", async () => {
    const plan = await verdictAfter([["file_write", "notes/kappa.txt"], ["file_write", REFUSED]]);

    expect(plan.evidence.recentFailures).toHaveLength(1);
    expect(plan.initialDecision).toBe("continue");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
  });
});

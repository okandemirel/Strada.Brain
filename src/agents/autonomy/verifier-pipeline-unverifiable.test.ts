/**
 * A failure nothing in the run can verify closes once the draft says so.
 *
 * Measured 2026-11-06 (golden run 4): a write failed at run time, the next
 * write succeeded, and the project had no build and no tests. The failure
 * waited for a verification nothing could run: six asks, a block, a re-run
 * that completed unverified. Both directions are pinned here:
 * - the run's tool registry holds no check tool: the gate asks once for an
 *   honest report and closes on it, and the record names the registry;
 * - the registry holds one, or the offer was narrowed, or the failure was
 *   never re-run, or a check already ran: the gate stays as it was, whatever
 *   the draft says.
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
import type { LogEntry } from "../../utils/logger.js";
import { NODE_SCOPE_MARKER } from "./node-tool-offer.js";
import { planVerifierPipeline, resetNoWorkEvidenceGates } from "./verifier-pipeline.js";
import { draftSaysNotVerified } from "./verifier-pipeline-unverifiable.js";

const sandbox = mkdtempSync(join(tmpdir(), "unverifiable-failure-"));
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

const TASK = "Create notes/lantern.txt containing the word LANTERN";
const DONE = "Wrote notes/lantern.txt.";
const NOT_VERIFIED = "Wrote notes/lantern.txt. Not verified: this project has no build and no tests to run.";
/** Inside the project, under a FILE: the tool runs, and the filesystem fails it. */
const FAILS_AT_RUN_TIME = "README.md/lantern.txt";
/** A registry with no tool that runs a check. shell_exec is a shell, not a check. */
const NO_CHECK_TOOLS = ["file_read", "file_write", "file_edit", "list_directory", "grep_search", "shell_exec", "git_status"];
const NO_VERIFICATION_TOOL = "[NO VERIFICATION TOOL]";

type Call = readonly [tool: string, path: string];
const FAIL_THEN_FIX: readonly Call[] = [["file_write", FAILS_AT_RUN_TIME], ["file_write", "notes/lantern.txt"]];

/** Each call run for real, in order, and recorded as the loop records it. */
async function stateAfter(calls: readonly Call[], task: string): Promise<AgentState> {
  let agentState: AgentState = {
    phase: AgentPhase.EXECUTING,
    taskDescription: task,
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
      ? await tool.execute({ path, content: "LANTERN\n" }, ctx)
      : name === "dotnet_test"
        ? { content: "Passed! - Failed: 0, Passed: 3, Skipped: 0, Total: 3" }
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

async function verdictAfter(options: {
  calls?: readonly Call[];
  draft: string;
  tools: readonly string[] | undefined;
  task?: string;
  logEntries?: readonly LogEntry[];
  /** The project's source root; the README-only project unless a test says otherwise. */
  projectRoot?: string | null;
}) {
  const task = options.task ?? TASK;
  const state = await stateAfter(options.calls ?? FAIL_THEN_FIX, task);
  return planVerifierPipeline({
    prompt: task,
    draft: options.draft,
    state,
    task: { type: "implementation", complexity: "simple", criticality: "low" },
    verificationState: {
      pendingFiles: new Set(),
      touchedFiles: new Set(["notes/lantern.txt"]),
      hasCompilableChanges: false,
      lastBuildOk: null,
      lastVerificationAt: null,
    },
    buildVerificationGate: null,
    conformanceGate: null,
    logEntries: options.logEntries ?? [],
    chatId: "chat-unverifiable",
    taskStartedAtMs: Date.now() - 60_000,
    buildToolsAvailable: true,
    availableToolNames: options.tools,
    projectRoot: options.projectRoot === null ? undefined : options.projectRoot ?? project,
  });
}

/** A second project root holding these files, beside the README-only one. */
let extraRoots = 0;
function projectWith(files: Record<string, string>): string {
  const root = join(sandbox, `project-${++extraRoots}`);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

describe("a re-run failure in a run whose registry holds no check tool", () => {
  it("asks once for an honest report, and nothing else: no repro, no 'rerun the verification'", async () => {
    const plan = await verdictAfter({ draft: DONE, tools: NO_CHECK_TOOLS });

    expect(plan.initialDecision).toBe("continue");
    expect(plan.gate).toContain(NO_VERIFICATION_TOOL);
    expect(plan.gate).toMatch(/file_write: Error: could not write file \(E[A-Z]+\)/);
    expect(plan.gate).toContain(`none of the ${NO_CHECK_TOOLS.length} tools in the tool registry offered to this turn runs`);
    expect(plan.gate).toContain("say in it\nplainly that the result is not verified");
    expect(plan.gate).not.toContain("[TARGETED VERIFICATION REQUIRED]");
    expect(plan.gate).not.toContain("[UNVERIFIED FAILURE]");
    expect(plan.gate).not.toContain("rerun the relevant verification");
  });

  it("closes when the draft says the result is not verified, and the record names the registry it read", async () => {
    const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: NO_CHECK_TOOLS });

    expect(plan.gate).toBeUndefined();
    expect(plan.initialDecision).toBe("approve");
    expect(plan.evidence.verificationTooling).toEqual({
      source: "tool registry offered to this turn",
      offered: NO_CHECK_TOOLS.length,
      checkTools: [],
      shellOffered: true,
      projectCommands: {
        verdict: "none",
        root: project,
        rootSource: "the project's source root, not a workspace lease",
        manifests: [],
      },
    });
    const check = plan.checks.find((c) => c.name === "unverifiable-failure");
    expect(check?.status).toBe("issues");
    expect(check?.summary).toMatch(/^Not verified: 1 failed step\(s\) were re-run successfully, none of the 7 tools in the tool registry offered to this turn runs/);
    expect(plan.checks.find((c) => c.name === "targeted-repro")).toBeUndefined();
  });

  it("closes on a Turkish report too", async () => {
    const plan = await verdictAfter({ draft: "notes/lantern.txt yazıldı; doğrulanmadı, projede derleme/test yok.", tools: NO_CHECK_TOOLS });

    expect(plan.gate).toBeUndefined();
    expect(plan.initialDecision).toBe("approve");
  });
});

describe("what still waits for a verification, whatever the draft says", () => {
  it("the registry holds a tool that runs a check", async () => {
    const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: [...NO_CHECK_TOOLS, "unity_compile_status"] });

    expect(plan.evidence.verificationTooling?.checkTools).toEqual(["unity_compile_status"]);
    expect(plan.initialDecision).toBe("continue");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
    expect(plan.gate).toContain("[UNVERIFIED FAILURE]");
    expect(plan.gate).not.toContain(NO_VERIFICATION_TOOL);
  });

  it("the registry was not measured", async () => {
    const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: undefined });

    expect(plan.evidence.verificationTooling).toBeNull();
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
  });

  it("the turn was offered only the writers (restrictToProgressTools)", async () => {
    const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: ["file_write", "file_edit"] });

    expect(plan.evidence.verificationTooling).toBeNull();
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
  });

  it("a plan node's offer was narrowed to the tools it names, which may withhold a check tool", async () => {
    const task = `${TASK}\n\n${NODE_SCOPE_MARKER}\nUse grep_search to find the notes folder.`;
    const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: NO_CHECK_TOOLS, task });

    expect(plan.evidence.verificationTooling).toBeNull();
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
  });

  it("the failed tool was never re-run successfully", async () => {
    const plan = await verdictAfter({
      calls: [["file_write", FAILS_AT_RUN_TIME], ["file_read", "README.md"]],
      draft: NOT_VERIFIED,
      tools: NO_CHECK_TOOLS,
    });

    expect(plan.evidence.recentFailuresRetriedOk).toBe(false);
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
    expect(plan.gate).not.toContain(NO_VERIFICATION_TOOL);
  });

  it("a check already ran in this run: the run has a way to verify", async () => {
    const plan = await verdictAfter({
      calls: [["dotnet_test", "."], ...FAIL_THEN_FIX],
      draft: NOT_VERIFIED,
      tools: NO_CHECK_TOOLS,
    });

    expect(plan.evidence.verificationStepCount).toBe(1);
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
    expect(plan.gate).not.toContain(NO_VERIFICATION_TOOL);
  });

  it("a warn/error log entry is still open", async () => {
    const plan = await verdictAfter({
      draft: NOT_VERIFIED,
      tools: NO_CHECK_TOOLS,
      logEntries: [{ level: "error", message: "lantern service crashed", timestamp: new Date().toISOString(), meta: { chatId: "chat-unverifiable" } }],
    });

    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
    expect(plan.gate).not.toContain(NO_VERIFICATION_TOOL);
  });
});

describe("a shell in the offer: the project's manifests say whether it can verify", () => {
  const TEST_SCRIPT = JSON.stringify({ name: "p", scripts: { test: "node --test" } });
  const NPM_PLACEHOLDER = JSON.stringify({ name: "p", scripts: { test: 'echo "Error: no test specified" && exit 1' } });

  it("a package.json test script keeps the gate: the shell can run it", async () => {
    const root = projectWith({ "package.json": TEST_SCRIPT, "index.js": "" });
    const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: NO_CHECK_TOOLS, projectRoot: root });

    expect(plan.evidence.verificationTooling?.projectCommands).toMatchObject({
      verdict: "commands",
      root,
      manifests: ["package.json: scripts.test"],
    });
    expect(plan.initialDecision).toBe("continue");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
    expect(plan.gate).not.toContain(NO_VERIFICATION_TOOL);
  });

  it("npm's placeholder test script is no test: the exit applies and the record names the file it read", async () => {
    const root = projectWith({ "package.json": NPM_PLACEHOLDER, "index.js": "" });
    const asked = await verdictAfter({ draft: DONE, tools: NO_CHECK_TOOLS, projectRoot: root });
    expect(asked.gate).toContain(NO_VERIFICATION_TOOL);
    expect(asked.gate).toContain(
      `the project's source root, not a workspace lease (${root}) declares no build or test command ` +
      "(package.json: no build or test script (scripts.test is npm's placeholder))",
    );

    const closed = await verdictAfter({ draft: NOT_VERIFIED, tools: NO_CHECK_TOOLS, projectRoot: root });
    expect(closed.gate).toBeUndefined();
    expect(closed.initialDecision).toBe("approve");
  });

  it("a project type it does not recognise keeps the gate", async () => {
    const root = projectWith({ "src/main.rs": "fn main() {}\n" });
    const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: NO_CHECK_TOOLS, projectRoot: root });

    expect(plan.evidence.verificationTooling?.projectCommands?.verdict).toBe("unknown");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
    expect(plan.gate).not.toContain(NO_VERIFICATION_TOOL);
  });

  it("no project root to read keeps the gate", async () => {
    const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: NO_CHECK_TOOLS, projectRoot: null });

    expect(plan.evidence.verificationTooling?.projectCommands?.verdict).toBe("unknown");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
  });

  it("with no shell in the offer nothing runs the script, and the project is not read", async () => {
    const root = projectWith({ "package.json": TEST_SCRIPT });
    const noShell = NO_CHECK_TOOLS.filter((name) => name !== "shell_exec");
    const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: noShell, projectRoot: root });

    expect(plan.evidence.verificationTooling).toMatchObject({ shellOffered: false });
    expect(plan.evidence.verificationTooling?.projectCommands).toBeUndefined();
    expect(plan.gate).toBeUndefined();
    expect(plan.initialDecision).toBe("approve");
  });
});

describe("draftSaysNotVerified", () => {
  it.each([
    "Not verified: nothing here can check it.",
    "The result is unverified.",
    "This could not be verified.",
    "I can't verify this here.",
    "Sonuç doğrulanmadı.",
    "Bu adım doğrulanamadı.",
  ])("reads %j as saying it is not verified", (draft) => {
    expect(draftSaysNotVerified(draft)).toBe(true);
  });

  it.each(["Wrote notes/lantern.txt.", "Verified: all three tests pass.", "This project has no build and no tests to run."])(
    "does not read %j as saying it",
    (draft) => {
      expect(draftSaysNotVerified(draft)).toBe(false);
    },
  );
});

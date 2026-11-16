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

/** A second project root, holding only the given files: what the verdict reads the manifests from. */
let roots = 0;
function rootWith(files: Readonly<Record<string, string>>): string {
  const root = join(sandbox, `root-${roots++}`);
  mkdirSync(root);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  return root;
}

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
        : name === "shell_exec"
          ? { content: "$ npm test\n> vitest run\n Test Files  1 passed (1)\n      Tests  3 passed (3)" }
          : { content: `Read ${path}` };
    const toolResult: ToolResult = { toolCallId: id, content: result.content, isError: "isError" in result ? result.isError : undefined };
    const input = name === "shell_exec" ? { command: path } : { path };
    ({ agentState } = recordStepResultsAndCheckReflection({
      agentState,
      toolCalls: [{ id, name, input }],
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
  /** The project root the manifests are read from; the README-only project by default. */
  projectPath?: string | null;
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
    projectPath: options.projectPath === null ? undefined : (options.projectPath ?? project),
  });
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
      // shell_exec is offered, so the project's own manifests were read too, and named.
      projectChecks: {
        source: "project root manifests",
        looked: expect.arrayContaining(["package.json (test/build/check/lint scripts)", "Makefile (test/build/check targets)", "pyproject.toml", "go.mod"]),
        found: [],
      },
    });
    const check = plan.checks.find((c) => c.name === "unverifiable-failure");
    expect(check?.status).toBe("issues");
    expect(check?.summary).toMatch(/^Not verified: 1 failed step\(s\) were re-run successfully, none of the 7 tools in the tool registry offered to this turn runs/);
    expect(plan.checks.find((c) => c.name === "targeted-repro")).toBeUndefined();
  });

  it("says in the ask that shell_exec has nothing to run, and how many manifests it looked for", async () => {
    const plan = await verdictAfter({ draft: DONE, tools: NO_CHECK_TOOLS });
    const looked = plan.evidence.verificationTooling?.projectChecks?.looked.length;

    expect(looked).toBeGreaterThan(20);
    expect(plan.gate).toContain(`shell_exec has nothing to run: the project root declares no check (looked for ${looked} manifests`);
  });

  it("opens over package.json's npm-init placeholder, which runs no test", async () => {
    const root = rootWith({ "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', start: "node index.js" } }) });
    const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: NO_CHECK_TOOLS, projectPath: root });

    expect(plan.evidence.verificationTooling?.projectChecks?.found).toEqual([]);
    expect(plan.initialDecision).toBe("approve");
  });

  it("does not read the manifests when shell_exec is not offered: nothing could run them", async () => {
    const root = rootWith({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) });
    const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: NO_CHECK_TOOLS.filter((t) => t !== "shell_exec"), projectPath: root });

    expect(plan.evidence.verificationTooling?.projectChecks).toBeNull();
    expect(plan.initialDecision).toBe("approve");
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

  it.each([
    ["package.json with a test script", { "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) }, "package.json scripts.test"],
    ["package.json with a build script", { "package.json": JSON.stringify({ scripts: { build: "tsc -p ." } }) }, "package.json scripts.build"],
    ["an unreadable package.json", { "package.json": "{ not json" }, "package.json (unreadable)"],
    ["a Makefile with a test target", { Makefile: "CC=cc\ntest: all\n\t./run-tests\n" }, "Makefile test:"],
    ["a Python project", { "pyproject.toml": "[project]\nname = \"lantern\"\n" }, "pyproject.toml"],
    ["a Go module", { "go.mod": "module example.com/lantern\n" }, "go.mod"],
    ["a Rust crate", { "Cargo.toml": "[package]\nname = \"lantern\"\n" }, "Cargo.toml"],
    ["a C# project", { "Lantern.csproj": "<Project />\n" }, "*.sln / *.csproj"],
  ])("shell_exec is offered and the project root declares a check: %s", async (_label, files, found) => {
    const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: NO_CHECK_TOOLS, projectPath: rootWith(files) });

    expect(plan.evidence.verificationTooling?.projectChecks?.found).toEqual([found]);
    expect(plan.initialDecision).toBe("continue");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
    expect(plan.gate).toContain("[UNVERIFIED FAILURE]");
    expect(plan.gate).not.toContain(NO_VERIFICATION_TOOL);
  });

  it("a Makefile whose targets are not checks does not count", async () => {
    const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: NO_CHECK_TOOLS, projectPath: rootWith({ Makefile: "install:\n\tcp a b\n" }) });

    expect(plan.evidence.verificationTooling?.projectChecks?.found).toEqual([]);
    expect(plan.initialDecision).toBe("approve");
  });

  it("shell_exec is offered and the project root is unknown or unreadable", async () => {
    for (const projectPath of [null, join(sandbox, "no-such-root")]) {
      const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: NO_CHECK_TOOLS, projectPath });

      expect(plan.evidence.verificationTooling).toBeNull();
      expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
    }
  });

  it("a shell npm test already ran in this run: the pipeline counts it as a verification", async () => {
    const plan = await verdictAfter({
      calls: [["shell_exec", "npm test"], ...FAIL_THEN_FIX],
      draft: NOT_VERIFIED,
      tools: NO_CHECK_TOOLS,
    });

    expect(plan.evidence.verificationStepCount).toBe(1);
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
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

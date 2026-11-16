/**
 * A failure nothing in the run can verify: the exit opens on recorded facts
 * alone, and the user is told by the system that the result is not verified.
 *
 * Measured 2026-11-06 (golden run 4): a write failed at run time, the next
 * write succeeded, and the project had no build and no tests. The failure
 * waited for a verification nothing could run: six asks, a block, a re-run
 * that completed unverified. Both directions are pinned here, one input of
 * the decision table at a time:
 * - every input allows it: the exit opens whatever the draft says, the
 *   record carries the table, and the run's answer carries the system's
 *   "Not verified: …" (a draft claiming a check is asked once first);
 * - any input keeps the gate, or cannot be read: the gate stays as it was,
 *   whatever the draft says.
 *
 * The steps are made the way the loop makes them: the real file_write's
 * results, recorded by recordStepResultsAndCheckReflection.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentPhase, type AgentState } from "../agent-state.js";
import { recordStepResultsAndCheckReflection } from "../orchestrator-loop-utils.js";
import type { ToolResult } from "../providers/provider-core.interface.js";
import { FileWriteTool } from "../tools/file-write.js";
import type { LogEntry } from "../../utils/logger.js";
import { NODE_SCOPE_MARKER } from "./node-tool-offer.js";
import { planVerifierPipeline, resetNoWorkEvidenceGates } from "./verifier-pipeline.js";
import { draftClaimsCheckPassed, takeUnverifiedNotice, unverifiedNotice, withUnverifiedNotice } from "./verifier-pipeline-unverifiable.js";

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
  for (const [name, content] of Object.entries(files)) {
    // A name ending in "/" is a directory, with one file in it.
    if (name.endsWith("/")) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, "lantern-check.txt"), content);
    } else {
      writeFileSync(join(root, name), content);
    }
  }
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
const CLAIM_ASK = "[NO VERIFICATION TOOL] Your report says a check passed, but no check ran in this run.";
const CHAT = "chat-unverifiable";
/**
 * The notice for FAIL_THEN_FIX in the README-only project with NO_CHECK_TOOLS, as the system writes it:
 * the failed call's target and error, the call that answered it and its target, and why nothing could check.
 */
const NOTICE_RE =
  /^Not verified: file_write README\.md\/lantern\.txt failed \(Error: could not write file \(E[A-Z]+\)\), then file_write wrote notes\/lantern\.txt \(the same file name, in another directory\)\. Nothing here could check the result: none of the 7 available tools runs a build or a test, and the project declares no build or test command\.$/;
/** QA's drafts, 2026-11-16: each says "unverified" and claims a check at once. */
const CLAIMING_DRAFTS = [
  "Wrote notes/lantern.txt and verified it works; nothing is left unverified.",
  "Done: all tests pass and no unverified assumptions remain.",
  "Tamamlandı ve test edildi; doğrulanmamış bir şey kalmadı.",
];
/** QA's drafts, 2026-11-16: a "No"/"Nothing" before the comma is about another word, and the claim after it stands. */
const NEGATED_ELSEWHERE = ["No errors, verified it works.", "No problems: the build passed.", "Nothing broke; tested it by hand."];
const rowOf = (plan: { evidence: { unverifiableDecision?: { inputs: readonly { input: string; effect: string }[] } } }, input: string) =>
  plan.evidence.unverifiableDecision?.inputs.find((row) => row.input === input);
/** A program that crashed at run time, the same program running, and an unrelated command. */
const CRASHED = { content: "TypeError: Cannot read properties of undefined (reading 'glow')\n    at main.js:3:14", isError: true };
const RAN = { content: "lantern lit" };
const LISTED = { content: "README.md\nmain.js\nnotes" };

/**
 * A tool, its path (or command for shell_exec), what it reported when the call is not run for real, and
 * what file_write writes (LANTERN by default).
 */
type Call = readonly [tool: string, path: string, reported?: { readonly content: string; readonly isError?: boolean }, content?: string];
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
  for (const [index, [name, path, reported, content = "LANTERN\n"]] of calls.entries()) {
    const id = `call_${index}`;
    const result = reported
      ? reported
      : name === "file_write"
      ? await tool.execute({ path, content }, ctx)
      : name === "dotnet_test"
        ? { content: "Passed! - Failed: 0, Passed: 3, Skipped: 0, Total: 3" }
        : name === "shell_exec"
          ? { content: "$ npm test\n> vitest run\n Test Files  1 passed (1)\n      Tests  3 passed (3)" }
          : { content: `Read ${path}` };
    const toolResult: ToolResult = { toolCallId: id, content: result.content, isError: "isError" in result ? result.isError : undefined };
    const input = name === "shell_exec" ? { command: path } : name === "file_write" ? { path, content } : { path };
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
  /** The run's start: two verdicts with the same start are the same run. */
  startedAt?: number;
  lastVerificationAt?: number | null;
}) {
  const task = options.task ?? TASK;
  const state = await stateAfter(options.calls ?? FAIL_THEN_FIX, task);
  return planVerifierPipeline({
    ...pipelineInputs(
      task,
      options.draft,
      options.tools,
      options.projectPath === null ? undefined : (options.projectPath ?? project),
      options.logEntries,
      { startedAt: options.startedAt, lastVerificationAt: options.lastVerificationAt },
    ),
    state,
  });
}

function pipelineInputs(
  task: string,
  draft: string,
  tools: readonly string[] | undefined,
  projectPath: string | undefined,
  logEntries: readonly LogEntry[] = [],
  run: { readonly startedAt?: number; readonly lastVerificationAt?: number | null } = {},
): Omit<Parameters<typeof planVerifierPipeline>[0], "state"> {
  return {
    prompt: task,
    draft,
    task: { type: "implementation", complexity: "simple", criticality: "low" },
    verificationState: {
      pendingFiles: new Set(),
      touchedFiles: new Set(["notes/lantern.txt"]),
      hasCompilableChanges: false,
      lastBuildOk: null,
      lastVerificationAt: run.lastVerificationAt ?? null,
    },
    buildVerificationGate: null,
    conformanceGate: null,
    logEntries,
    chatId: CHAT,
    taskStartedAtMs: run.startedAt ?? Date.now() - 60_000,
    buildToolsAvailable: true,
    availableToolNames: tools,
    projectPath,
  };
}

describe("a re-run failure in a run whose registry holds no check tool", () => {
  it("opens on a draft that only says what it did: no ask, no repro, and the system writes the notice", async () => {
    const plan = await verdictAfter({ draft: DONE, tools: NO_CHECK_TOOLS });

    expect(plan.initialDecision).toBe("approve");
    expect(plan.gate).toBeUndefined();
    expect(plan.evidence.unverifiableDecision?.opens).toBe(true);
    expect(plan.evidence.unverifiableDecision?.notice).toMatch(NOTICE_RE);
    expect(plan.checks.find((c) => c.name === "targeted-repro")).toBeUndefined();
    expect(plan.checks.find((c) => c.name === ("unverified-failure" as never))).toBeUndefined();
  });

  it("puts the whole decision table in the evidence: every input, its source, what was read, and what an unknown does", async () => {
    const plan = await verdictAfter({ draft: DONE, tools: NO_CHECK_TOOLS });
    const inputs = plan.evidence.unverifiableDecision?.inputs ?? [];

    expect(inputs.map((row) => row.input)).toEqual([
      "a tool that runs a check is offered",
      "the project declares a check shell_exec could run",
      "a check already ran in this run",
      "every open failure was answered by a later success",
      "no warn/error log entry is open",
      "the draft does not report that the run failed",
      "the draft claims a check passed",
    ]);
    for (const row of inputs) {
      expect(row.source, row.input).not.toBe("");
      expect(row.value, row.input).not.toBe("");
      expect(row.whenUnknown, row.input).not.toBe("");
    }
    expect(inputs.slice(0, 6).map((row) => row.effect)).toEqual(Array(6).fill("allows"));
    expect(inputs[6]?.effect).toBe("no effect");
  });

  it("opens the same way when the draft says it is not verified, and the record names the registry it read", async () => {
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
    expect(check?.summary).toMatch(
      /^Not verified: file_write README\.md\/lantern\.txt failed \(Error: could not write file \(E[A-Z]+\)\), then file_write wrote notes\/lantern\.txt \(the same file name, in another directory\)\. Nothing here could check the result: none of the 7 available tools runs/,
    );
    expect(check?.summary).toContain("(every input of the decision allowed the exit: evidence.unverifiableDecision)");
    expect(plan.checks.find((c) => c.name === "targeted-repro")).toBeUndefined();
  });

  it("says in the record that shell_exec has nothing to run, and how many manifests it looked for", async () => {
    const plan = await verdictAfter({ draft: DONE, tools: NO_CHECK_TOOLS });
    const looked = plan.evidence.verificationTooling?.projectChecks?.looked.length;

    expect(looked).toBeGreaterThan(20);
    expect(rowOf(plan, "the project declares a check shell_exec could run")).toMatchObject({
      value: `none of the ${looked} manifests looked for`,
      effect: "allows",
    });
    expect(plan.evidence.unverifiableDecision?.notice).toContain("and the project declares no build or test command.");
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

  it("closes over a command that crashed and was run again with the same input, and says it was run again", async () => {
    const plan = await verdictAfter({
      calls: [["shell_exec", "node main.js", CRASHED], ["file_write", "main.js"], ["shell_exec", "node main.js", RAN]],
      draft: NOT_VERIFIED,
      tools: NO_CHECK_TOOLS,
    });

    expect(plan.evidence.recentFailureRetries).toEqual({ rerun: 1, rewritten: 0 });
    expect(plan.initialDecision).toBe("approve");
    expect(plan.checks.find((c) => c.name === "unverifiable-failure")?.summary).toMatch(
      /^Not verified: shell_exec failed \(TypeError: Cannot read properties of undefined \(reading 'glow'\)\), then the same call, with the same input, succeeded\. Nothing here could check/,
    );
  });

  it("records which later call answered the failure, with both targets", async () => {
    const plan = await verdictAfter({ draft: DONE, tools: NO_CHECK_TOOLS });

    expect(plan.evidence.recentFailureAnswers).toEqual([{
      tool: "file_write",
      error: expect.stringMatching(/^Error: could not write file \(E[A-Z]+\)$/),
      kind: "same-name",
      failedTarget: FAILS_AT_RUN_TIME,
      answerTarget: "notes/lantern.txt",
    }]);
    expect(rowOf(plan, "every open failure was answered by a later success")).toMatchObject({
      value: "yes: 1 whose file name the same tool wrote later in another directory",
      effect: "allows",
    });
  });

  it("closes over a write that failed and was written again at the same path, and says that path was written again", async () => {
    const denied = { content: "Error: could not write file (EACCES)", isError: true };
    const plan = await verdictAfter({
      calls: [["file_write", "notes/gamma.txt", denied, "GAMMA\n"], ["file_write", "./notes/gamma.txt", undefined, "GAMMA!\n"]],
      draft: DONE,
      tools: NO_CHECK_TOOLS,
    });

    expect(plan.evidence.recentFailureAnswers).toMatchObject([{ kind: "same-path", failedTarget: "notes/gamma.txt", answerTarget: "./notes/gamma.txt" }]);
    expect(plan.initialDecision).toBe("approve");
    expect(plan.evidence.unverifiableDecision?.notice).toMatch(
      /^Not verified: file_write notes\/gamma\.txt failed \(Error: could not write file \(EACCES\)\), then file_write wrote \.\/notes\/gamma\.txt again\. Nothing here could check/,
    );
  });

  it("closes on a Turkish report too", async () => {
    const plan = await verdictAfter({ draft: "notes/lantern.txt yazıldı; doğrulanmadı, projede derleme/test yok.", tools: NO_CHECK_TOOLS });

    expect(plan.gate).toBeUndefined();
    expect(plan.initialDecision).toBe("approve");
  });

  it.each([DONE, NOT_VERIFIED, "", "Yazdım.", ...CLAIMING_DRAFTS])("the draft does not decide whether it opens: %j", async (draft) => {
    const plan = await verdictAfter({ draft, tools: NO_CHECK_TOOLS });

    expect(plan.evidence.unverifiableDecision?.opens).toBe(true);
  });
});

describe("a draft that claims a check nothing ran", () => {
  it.each(CLAIMING_DRAFTS)("is asked once for an honest report, not approved: %j", async (draft) => {
    const startedAt = Date.now() - 40_000 - CLAIMING_DRAFTS.indexOf(draft);
    const plan = await verdictAfter({ draft, tools: NO_CHECK_TOOLS, startedAt });

    expect(plan.initialDecision).toBe("continue");
    expect(plan.gate).toContain(CLAIM_ASK);
    expect(plan.gate).toMatch(/file_write: Error: could not write file \(E[A-Z]+\)/);
    expect(plan.gate).toContain("Nothing here can verify that: none of the 7 available tools runs a build or a test");
    expect(plan.gate).not.toContain("[TARGETED VERIFICATION REQUIRED]");
    expect(rowOf(plan, "the draft claims a check passed")?.effect).toBe("asks once");
    // The run goes on: nothing is recorded for its answer yet.
    expect(takeUnverifiedNotice(CHAT, startedAt)).toBeUndefined();
  });

  it.each(NEGATED_ELSEWHERE)("is asked too when a negation in an earlier clause is about something else: %j", async (draft) => {
    const plan = await verdictAfter({ draft, tools: NO_CHECK_TOOLS, startedAt: Date.now() - 35_000 - NEGATED_ELSEWHERE.indexOf(draft) });

    expect(plan.initialDecision).toBe("continue");
    expect(plan.gate).toContain(CLAIM_ASK);
  });

  it("is asked only once in a run: the second claim is approved, and the notice says no check ran", async () => {
    const startedAt = Date.now() - 30_000;
    const first = await verdictAfter({ draft: CLAIMING_DRAFTS[0]!, tools: NO_CHECK_TOOLS, startedAt });
    const second = await verdictAfter({ draft: CLAIMING_DRAFTS[0]!, tools: NO_CHECK_TOOLS, startedAt });

    expect(first.gate).toContain(CLAIM_ASK);
    expect(second.gate).toBeUndefined();
    expect(second.initialDecision).toBe("approve");
    expect(rowOf(second, "the draft claims a check passed")).toMatchObject({ value: "yes, and it was asked once already", effect: "no effect" });
    expect(second.evidence.unverifiableDecision?.notice).toMatch(/ The report above mentions a check, but no check ran in this run\.$/);
  });
});

describe("the notice the run's answer carries", () => {
  it("is recorded by an approve with the exit open, and taken once", async () => {
    const startedAt = Date.now() - 20_000;
    const plan = await verdictAfter({ draft: DONE, tools: NO_CHECK_TOOLS, startedAt });

    expect(takeUnverifiedNotice(CHAT, startedAt)).toBe(plan.evidence.unverifiableDecision?.notice);
    expect(takeUnverifiedNotice(CHAT, startedAt)).toBeUndefined();
  });

  it("is cleared by a later verdict of the same run that does not open the exit", async () => {
    const startedAt = Date.now() - 10_000;
    await verdictAfter({ draft: DONE, tools: NO_CHECK_TOOLS, startedAt });
    const later = await verdictAfter({ draft: DONE, tools: [...NO_CHECK_TOOLS, "dotnet_test"], startedAt });

    expect(later.initialDecision).toBe("continue");
    expect(takeUnverifiedNotice(CHAT, startedAt)).toBeUndefined();
  });

  it("is written in the task's language: a Turkish task reads it in Turkish", async () => {
    const plan = await verdictAfter({
      task: "notes/lantern.txt dosyasını LANTERN kelimesiyle oluştur",
      draft: "notes/lantern.txt yazıldı.",
      tools: NO_CHECK_TOOLS,
    });

    expect(plan.initialDecision).toBe("approve");
    expect(plan.evidence.unverifiableDecision?.notice).toMatch(
      /^Doğrulanmadı: file_write README\.md\/lantern\.txt başarısız oldu \(Error: could not write file \(E[A-Z]+\)\); ardından file_write notes\/lantern\.txt dosyasını yazdı \(aynı dosya adı, başka bir dizinde\)\. Sonucu burada hiçbir şey denetleyemedi: sunulan 7 aracın hiçbiri derleme ya da test çalıştırmıyor ve proje hiçbir derleme ya da test komutu bildirmiyor\.$/,
    );
  });

  it("lists the last three failures and counts the earlier ones", () => {
    const answer = { tool: "shell_exec", error: "exit 1", kind: "rerun" as const };
    const notice = unverifiedNotice([answer, answer, answer, answer], { offered: 4, shellOffered: false }, true, "en");

    expect(notice).toBe(
      "Not verified: " +
        "shell_exec failed (exit 1), then the same call, with the same input, succeeded. ".repeat(3) +
        "1 earlier failed step(s) are not listed. Nothing here could check the result: none of the 4 available tools runs a build or a test. " +
        "The report above mentions a check, but no check ran in this run.",
    );
  });

  it("goes under the answer once, after a blank line", () => {
    expect(withUnverifiedNotice("Wrote it.", "Not verified: x.")).toBe("Wrote it.\n\nNot verified: x.");
    expect(withUnverifiedNotice("Wrote it.\n\nNot verified: x.", "Not verified: x.")).toBe("Wrote it.\n\nNot verified: x.");
    expect(withUnverifiedNotice("", "Not verified: x.")).toBe("Not verified: x.");
    expect(withUnverifiedNotice("Wrote it.", undefined)).toBe("Wrote it.");
  });
});

describe("what still waits for a verification, whatever the draft says", () => {
  it("the registry holds a tool that runs a check", async () => {
    const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: [...NO_CHECK_TOOLS, "unity_compile_status"] });

    expect(plan.evidence.verificationTooling?.checkTools).toEqual(["unity_compile_status"]);
    expect(rowOf(plan, "a tool that runs a check is offered")?.effect).toBe("keeps the gate");
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
    // What a runner finds with no script naming it (QA 2026-11-16).
    ["a tsconfig.json beside a package.json with only a start script",
      { "tsconfig.json": "{}\n", "package.json": JSON.stringify({ scripts: { start: "node dist/main.js" } }) }, "tsconfig.json"],
    ["a conftest.py and a test file, no configuration", { "conftest.py": "", "test_app.py": "def test_lit(): pass\n" },
      ["conftest.py", "test_app.py"]],
    ["a Python test file alone", { "test_app.py": "def test_lit(): pass\n" }, "test_app.py"],
    ["a Python test file named the other way", { "app_test.py": "def test_lit(): pass\n" }, "app_test.py"],
    ["a Go test file", { "lantern_test.go": "package lantern\n" }, "lantern_test.go"],
    ["a JavaScript test file", { "util.test.js": "test('lit', () => {});\n" }, "util.test.js"],
    ["a TypeScript spec file", { "util.spec.ts": "it('lit', () => {});\n" }, "util.spec.ts"],
    ["a tests/ directory", { "tests/": "" }, "tests/"],
    ["a test/ directory", { "test/": "" }, "test/"],
    ["a __tests__/ directory", { "__tests__/": "" }, "__tests__/"],
    ["a spec/ directory", { "spec/": "" }, "spec/"],
    ["vitest among the devDependencies, and a test file",
      { "package.json": JSON.stringify({ devDependencies: { vitest: "^4.0.0" } }), "util.test.js": "" },
      ["package.json devDependencies.vitest", "util.test.js"]],
    ["typescript among the dependencies", { "package.json": JSON.stringify({ dependencies: { typescript: "^5.0.0" } }) },
      "package.json dependencies.typescript"],
    ["jest among the devDependencies", { "package.json": JSON.stringify({ devDependencies: { jest: "^30.0.0" } }) },
      "package.json devDependencies.jest"],
  ])("shell_exec is offered and the project root declares a check: %s", async (_label, files, found) => {
    const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: NO_CHECK_TOOLS, projectPath: rootWith(files) });

    expect(plan.evidence.verificationTooling?.projectChecks?.found).toEqual([found].flat());
    expect(rowOf(plan, "the project declares a check shell_exec could run")?.effect).toBe("keeps the gate");
    expect(plan.initialDecision).toBe("continue");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
    expect(plan.gate).toContain("[UNVERIFIED FAILURE]");
    expect(plan.gate).not.toContain(NO_VERIFICATION_TOOL);
  });

  it("names that only look like tests, a file called tests, and packages that run no check do not count", async () => {
    const root = rootWith({
      "latest_news.py": "",
      "contest.md": "",
      tests: "not a directory\n",
      "package.json": JSON.stringify({ dependencies: { express: "^5.0.0" }, devDependencies: { nodemon: "^3.0.0" } }),
    });
    const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: NO_CHECK_TOOLS, projectPath: root });

    expect(plan.evidence.verificationTooling?.projectChecks?.found).toEqual([]);
    expect(plan.initialDecision).toBe("approve");
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
      expect(rowOf(plan, "the project declares a check shell_exec could run")?.effect).toBe("unknown: keeps the gate");
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
    expect(rowOf(plan, "a check already ran in this run")?.effect).toBe("keeps the gate");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
    expect(plan.gate).not.toContain(NO_VERIFICATION_TOOL);
  });

  it("a check ran earlier in this run, before the step window: the verification state remembers it", async () => {
    const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: NO_CHECK_TOOLS, lastVerificationAt: Date.now() - 120_000 });

    expect(plan.evidence.verificationStepCount).toBe(0);
    expect(rowOf(plan, "a check already ran in this run")?.effect).toBe("keeps the gate");
    expect(plan.evidence.unverifiableDecision?.opens).toBe(false);
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
  });

  it("the draft reports that the run failed: that report's own exit applies, and no notice is recorded", async () => {
    const startedAt = Date.now() - 50_000;
    const plan = await verdictAfter({ draft: "I could not finish: the first write failed.", tools: NO_CHECK_TOOLS, startedAt });

    expect(plan.evidence.hasTerminalFailureReport).toBe(true);
    expect(rowOf(plan, "the draft does not report that the run failed")?.effect).toBe("keeps the gate");
    expect(plan.evidence.unverifiableDecision?.opens).toBe(false);
    expect(plan.checks.find((c) => c.name === "unverifiable-failure")).toBeUndefined();
    expect(takeUnverifiedNotice(CHAT, startedAt)).toBeUndefined();
  });

  it("the registry was not measured", async () => {
    const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: undefined });

    expect(plan.evidence.verificationTooling).toBeNull();
    expect(rowOf(plan, "a tool that runs a check is offered")).toMatchObject({ value: "no tool list was passed in", effect: "unknown: keeps the gate" });
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
  });

  it("the turn was offered only the writers (restrictToProgressTools)", async () => {
    const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: ["file_write", "file_edit"] });

    expect(plan.evidence.verificationTooling).toBeNull();
    expect(rowOf(plan, "a tool that runs a check is offered")?.effect).toBe("unknown: keeps the gate");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
  });

  it("a plan node's offer was narrowed to the tools it names, which may withhold a check tool", async () => {
    const task = `${TASK}\n\n${NODE_SCOPE_MARKER}\nUse grep_search to find the notes folder.`;
    const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: NO_CHECK_TOOLS, task });

    expect(plan.evidence.verificationTooling).toBeNull();
    expect(rowOf(plan, "a tool that runs a check is offered")?.effect).toBe("unknown: keeps the gate");
    expect(rowOf(plan, "the project declares a check shell_exec could run")?.effect).toBe("unknown: keeps the gate");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
  });

  it("a command that crashed and was never run again, though the same tool later succeeded with another command", async () => {
    const plan = await verdictAfter({
      calls: [["shell_exec", "node main.js", CRASHED], ["file_write", "main.js"], ["shell_exec", "ls", LISTED]],
      draft: NOT_VERIFIED,
      tools: NO_CHECK_TOOLS,
    });

    expect(plan.evidence.recentFailures).toEqual([expect.stringMatching(/^shell_exec: TypeError/)]);
    expect(plan.evidence.recentFailuresRetriedOk).toBe(false);
    expect(plan.evidence.recentFailureRetries).toBeUndefined();
    expect(rowOf(plan, "every open failure was answered by a later success")?.effect).toBe("keeps the gate");
    expect(plan.initialDecision).toBe("continue");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
    expect(plan.gate).not.toContain(NO_VERIFICATION_TOOL);
  });

  it("a write that failed, followed by a write of another file: the failed file was never written (QA 2026-11-16)", async () => {
    const startedAt = Date.now() - 45_000;
    const plan = await verdictAfter({
      task: "Create notes/alpha.txt and notes/beta.txt",
      calls: [["file_write", "README.md/alpha.txt"], ["file_write", "notes/beta.txt"]],
      draft: "Wrote notes/beta.txt.",
      tools: NO_CHECK_TOOLS,
      startedAt,
    });

    expect(existsSync(join(project, "notes", "alpha.txt"))).toBe(false);
    expect(plan.evidence.recentFailuresRetriedOk).toBe(false);
    expect(plan.evidence.recentFailureAnswers).toBeUndefined();
    expect(rowOf(plan, "every open failure was answered by a later success")).toMatchObject({
      value: "no: a failed call was not run again, and no write of its path or file name followed it",
      effect: "keeps the gate",
    });
    expect(plan.initialDecision).toBe("continue");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
    expect(plan.gate).not.toContain(NO_VERIFICATION_TOOL);
    expect(takeUnverifiedNotice(CHAT, startedAt)).toBeUndefined();
  });

  it("a writer recorded without a target path cannot be matched to another write", async () => {
    const state = await stateAfter(FAIL_THEN_FIX, TASK);
    const unnamed = { ...state, stepResults: state.stepResults.map(({ targetPath: _dropped, ...step }) => step) };
    const plan = planVerifierPipeline({ ...pipelineInputs(TASK, DONE, NO_CHECK_TOOLS, project), state: unnamed });

    expect(plan.evidence.recentFailuresRetriedOk).toBe(false);
    expect(rowOf(plan, "every open failure was answered by a later success")?.effect).toBe("keeps the gate");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
  });

  it("a step recorded without an input signature cannot be matched to a re-run", async () => {
    const state = await stateAfter([["shell_exec", "node main.js", CRASHED], ["shell_exec", "node main.js", RAN]], TASK);
    const unsigned = { ...state, stepResults: state.stepResults.map(({ inputSignature: _dropped, ...step }) => step) };
    const plan = planVerifierPipeline({ ...pipelineInputs(TASK, NOT_VERIFIED, NO_CHECK_TOOLS, project), state: unsigned });

    expect(plan.evidence.recentFailuresRetriedOk).toBe(false);
    expect(rowOf(plan, "every open failure was answered by a later success")?.effect).toBe("keeps the gate");
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

    expect(rowOf(plan, "no warn/error log entry is open")?.effect).toBe("keeps the gate");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
    expect(plan.gate).not.toContain(NO_VERIFICATION_TOOL);
  });
});

describe("draftClaimsCheckPassed: what the one ask reads, and nothing else", () => {
  it.each([
    "Not verified: nothing here can check it.",
    "The result is unverified.",
    "This could not be verified.",
    "I can't verify this here.",
    "Sonuç doğrulanmadı.",
    "Bu adım doğrulanamadı.",
    "Wrote notes/lantern.txt.",
    "This project has no build and no tests to run.",
    "I did not run the tests; nothing was verified.",
    "It could not be tested.",
    "Wrote lantern.txt, not verified.",
  ])("reads %j as claiming no check", (draft) => {
    expect(draftClaimsCheckPassed(draft)).toBe(false);
  });

  it.each([
    "Verified: all three tests pass.",
    "The build passed and it compiles cleanly.",
    "Testler geçti.",
    ...CLAIMING_DRAFTS,
    // A negation in an earlier clause is about something else (QA 2026-11-16).
    ...NEGATED_ELSEWHERE,
  ])(
    "reads %j as claiming a check passed",
    (draft) => {
      expect(draftClaimsCheckPassed(draft)).toBe(true);
    },
  );
});

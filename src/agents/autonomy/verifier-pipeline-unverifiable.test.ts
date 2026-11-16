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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentPhase, type AgentState } from "../agent-state.js";
import { recordStepResultsAndCheckReflection } from "../orchestrator-loop-utils.js";
import type { ToolResult } from "../providers/provider-core.interface.js";
import { FileWriteTool } from "../tools/file-write.js";
import type { LogEntry } from "../../utils/logger.js";
import { NODE_SCOPE_MARKER } from "./node-tool-offer.js";
import { fileOnPath } from "./completion-review-answers.js";
import { BRAIN_STORE_DIR, INERT_KINDS, SCAN_LIMITS, SKIPPED_DIRS, inertKind, measureProjectChecks } from "./verifier-pipeline-project-checks.js";
import { PROJECT_DATA_DIR } from "../../core/database-backup.js";
import { planVerifierPipeline, resetNoWorkEvidenceGates } from "./verifier-pipeline.js";
import { draftClaimsCheckPassed, takeUnverifiedNotice, unverifiedNotice, withUnverifiedNotice } from "./verifier-pipeline-unverifiable.js";

const sandbox = mkdtempSync(join(tmpdir(), "unverifiable-failure-"));
const project = join(sandbox, "project");
mkdirSync(project);
writeFileSync(join(project, "README.md"), "# a project with no build and no tests\n");

/**
 * Another project root: a README.md and the given files. The calls run in it
 * and the verdict reads it, as the run's tools and the verifier share one root.
 */
let roots = 0;
function rootWith(files: Readonly<Record<string, string>>): string {
  const root = join(sandbox, `root-${roots++}`);
  mkdirSync(root);
  writeFileSync(join(root, "README.md"), "# another project\n");
  for (const [name, content] of Object.entries(files)) {
    // A name ending in "/" is a directory, with one file in it.
    if (name.endsWith("/")) {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, "lantern-check.txt"), content);
    } else {
      mkdirSync(dirname(join(root, name)), { recursive: true });
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
 * the failed call's target and error, why that path cannot exist (measured), the call that answered it and
 * its target, and why nothing could check.
 */
const NOTICE_RE =
  /^Not verified: file_write README\.md\/lantern\.txt failed \(Error: could not write file \(E[A-Z]+\)\): README\.md is a file, so that path cannot exist\. Then file_write wrote notes\/lantern\.txt, the same file name in another directory\. Nothing here could check the result: none of the 7 available tools runs a build or a test, and the project holds nothing a check could run on: its \d+ files, in \d+ directories, are all \.md or \.txt files \(the whole tree was read, up to 20000 entries and 12 levels deep\)\.$/;
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
/** A command over a document that failed at run time, and the same command once the document is there. */
const MISSING = { content: "cat: notes/lantern.txt: No such file or directory", isError: true };
const READ_BACK = { content: "LANTERN" };

/**
 * A tool, its path (or command for shell_exec), what it reported when the call is not run for real, and
 * what file_write writes (LANTERN by default).
 */
type Call = readonly [tool: string, path: string, reported?: { readonly content: string; readonly isError?: boolean }, content?: string];
const FAIL_THEN_FIX: readonly Call[] = [["file_write", FAILS_AT_RUN_TIME], ["file_write", "notes/lantern.txt"]];

/** Each call run for real in `root`, in order, and recorded as the loop records it. */
async function stateAfter(calls: readonly Call[], task: string, root = project): Promise<AgentState> {
  const ctx = { projectPath: root, workingDirectory: root, readOnly: false };
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
  /**
   * The project root the calls run in and the verdict reads; the README-only
   * project by default. null passes none, and a root that does not exist is
   * passed as it is: the calls then run in the README-only project.
   */
  projectPath?: string | null;
  /** The run's start: two verdicts with the same start are the same run. */
  startedAt?: number;
  lastVerificationAt?: number | null;
}) {
  const task = options.task ?? TASK;
  const root = options.projectPath && existsSync(options.projectPath) ? options.projectPath : project;
  const state = await stateAfter(options.calls ?? FAIL_THEN_FIX, task, root);
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
      // shell_exec is offered, so the project tree was read too, whole: its manifests, and the kind of every file.
      projectChecks: {
        source: "project tree",
        root: project,
        directoriesRead: expect.any(Number),
        filesRead: expect.any(Number),
        limits: SCAN_LIMITS,
        skipped: [...SKIPPED_DIRS, ".strada/ at the root"],
        notEntered: [],
        looked: expect.arrayContaining(["package.json (test/build/check/lint scripts)", "Makefile (test/build/check targets)", "pyproject.toml", "go.mod"]),
        found: [],
        inertKinds: INERT_KINDS,
        kindsSeen: [".md", ".txt"],
        otherFiles: [],
        otherWrites: [],
      },
    });
    const check = plan.checks.find((c) => c.name === "unverifiable-failure");
    expect(check?.status).toBe("issues");
    expect(check?.summary).toMatch(
      /^Not verified: file_write README\.md\/lantern\.txt failed \(Error: could not write file \(E[A-Z]+\)\): README\.md is a file, so that path cannot exist\. Then file_write wrote notes\/lantern\.txt, the same file name in another directory\. Nothing here could check the result: none of the 7 available tools runs/,
    );
    expect(check?.summary).toContain("(every input of the decision allowed the exit: evidence.unverifiableDecision)");
    expect(plan.checks.find((c) => c.name === "targeted-repro")).toBeUndefined();
  });

  it("says in the record and the notice what the scan read: every file, each of a kind that carries no check", async () => {
    const plan = await verdictAfter({ draft: DONE, tools: NO_CHECK_TOOLS });
    // Counted from the project tree itself, a source with no clock in it (the plan's run carries a start
    // time, docs/contracts/wall-clock-assertions.md): the record must hold exactly those counts.
    const measured = measureProjectChecks(project)!;
    const looked = measured.looked.length;

    expect(plan.evidence.verificationTooling?.projectChecks?.looked.length).toBe(looked);
    expect(looked).toBeGreaterThan(20);
    expect(plan.evidence.verificationTooling?.projectChecks?.filesRead).toBe(measured.filesRead);
    expect(plan.evidence.verificationTooling?.projectChecks?.directoriesRead).toBe(measured.directoriesRead);
    expect(rowOf(plan, "the project declares a check shell_exec could run")).toMatchObject({
      value: `all ${measured.filesRead} files, in all ${measured.directoriesRead} directories, are of kinds that carry no check ` +
        "(.md, .txt); not entered: nothing (limits: 20000 entries, 12 levels)",
      effect: "allows",
    });
    expect(plan.evidence.unverifiableDecision?.notice).toContain(
      `and the project holds nothing a check could run on: its ${measured.filesRead} files, in ${measured.directoriesRead} directories, ` +
        "are all .md or .txt files (the whole tree was read, up to 20000 entries and 12 levels deep).",
    );
  });

  it("does not enter a version-control store, and the record and the notice say which was not read", async () => {
    const root = rootWith({ ".git/config": "[core]\n", ".git/hooks/pre-commit": "#!/bin/sh\nnpm test\n" });
    const plan = await verdictAfter({ draft: DONE, tools: NO_CHECK_TOOLS, projectPath: root });

    expect(plan.evidence.verificationTooling?.projectChecks).toMatchObject({ notEntered: [".git"], otherFiles: [], found: [] });
    expect(rowOf(plan, "the project declares a check shell_exec could run")?.value).toContain("; not entered: .git (limits:");
    expect(plan.initialDecision).toBe("approve");
    expect(plan.evidence.unverifiableDecision?.notice).toContain("; not read: .git, which is version control).");
  });

  it("does not enter this assistant's own store at the root, the folder its vault and databases live in", async () => {
    const root = rootWith({ ".strada/vault/index.db": "SQLite format 3\n", ".git/config": "[core]\n" });
    const plan = await verdictAfter({ draft: DONE, tools: NO_CHECK_TOOLS, projectPath: root });

    expect(BRAIN_STORE_DIR).toBe(PROJECT_DATA_DIR);
    expect(plan.evidence.verificationTooling?.projectChecks?.notEntered).toEqual([".git", ".strada"]);
    expect(plan.initialDecision).toBe("approve");
    expect(plan.evidence.unverifiableDecision?.notice).toMatch(
      /; not read: \.git, which is version control and \.strada, which is Strada\.Brain's own store\)\.$/,
    );
  });

  it("enters a folder of that name below the root: only the root's is this assistant's", async () => {
    const plan = await verdictAfter({ draft: DONE, tools: NO_CHECK_TOOLS, projectPath: rootWith({ "app/.strada/run.js": "console.log(1);\n" }) });

    expect(plan.evidence.verificationTooling?.projectChecks).toMatchObject({ notEntered: [], otherFiles: ["app/.strada/run.js"] });
    expect(plan.initialDecision).toBe("continue");
  });

  it("does not read the manifests when shell_exec is not offered: nothing could run them", async () => {
    const root = rootWith({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) });
    const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: NO_CHECK_TOOLS.filter((t) => t !== "shell_exec"), projectPath: root });

    expect(plan.evidence.verificationTooling?.projectChecks).toBeNull();
    expect(plan.initialDecision).toBe("approve");
  });

  it("closes over a command that failed at run time and was run again with the same input, and says it was run again", async () => {
    // A command over documents only: the tree stays one that nothing can check (a crashed program does not, below).
    const plan = await verdictAfter({
      calls: [["shell_exec", "cat notes/lantern.txt", MISSING], ["file_write", "notes/lantern.txt"], ["shell_exec", "cat notes/lantern.txt", READ_BACK]],
      draft: NOT_VERIFIED,
      tools: NO_CHECK_TOOLS,
      projectPath: rootWith({}),
    });

    expect(plan.evidence.recentFailureRetries).toEqual({ rerun: 1, rewritten: 0 });
    expect(plan.initialDecision).toBe("approve");
    expect(plan.checks.find((c) => c.name === "unverifiable-failure")?.summary).toMatch(
      /^Not verified: shell_exec failed \(cat: notes\/lantern\.txt: No such file or directory\), then the same call, with the same input, succeeded\. Nothing here could check/,
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
      blockedBy: "README.md",
    }]);
    expect(rowOf(plan, "every open failure was answered by a later success")).toMatchObject({
      value: "yes: 1 whose path cannot exist (a directory of it is a file) and whose file name the same tool wrote later in another directory",
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

    expect(plan.evidence.recentFailureAnswers).toMatchObject([
      { kind: "same-path", failedTarget: "notes/gamma.txt", answerTarget: "./notes/gamma.txt" },
    ]);
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
      /^Doğrulanmadı: file_write README\.md\/lantern\.txt başarısız oldu \(Error: could not write file \(E[A-Z]+\)\): README\.md bir dosya, bu yüzden o yol var olamaz\. Ardından file_write aynı adlı dosyayı başka bir dizine yazdı: notes\/lantern\.txt\. Sonucu burada hiçbir şey denetleyemedi: sunulan 7 aracın hiçbiri derleme ya da test çalıştırmıyor ve projede bir denetimin üzerinde koşabileceği hiçbir şey yok: \d+ dizindeki \d+ dosyanın hepsi \.md ya da \.txt dosyası \(ağacın tamamı okundu, en çok 20000 girdi ve 12 düzey derinliğe kadar\)\.$/,
    );
  });

  it.each([
    ["en", "Not verified: file_write notes/a.txt failed (EACCES), then file_write wrote notes/a.txt again."],
    ["tr", "Doğrulanmadı: file_write notes/a.txt başarısız oldu (EACCES); ardından file_write notes/a.txt yolunu yeniden yazdı."],
  ] as const)("says the writer wrote the same path again (%s): only a writer answers by path", (language, head) => {
    const notice = unverifiedNotice(
      [{ tool: "file_write", error: "EACCES", kind: "same-path", failedTarget: "notes/a.txt", answerTarget: "notes/a.txt" }],
      { offered: 3, shellOffered: false },
      false,
      language,
    );

    expect(notice.startsWith(`${head} `)).toBe(true);
  });

  it.each([
    ["en", "and the project holds nothing a check could run on: its one file, in one directory, is a .md file " +
      "(the whole tree was read, up to 20000 entries and 12 levels deep; not read: .strada, which is Strada.Brain's own store)."],
    ["tr", "ve projede bir denetimin üzerinde koşabileceği hiçbir şey yok: 1 dizindeki tek dosya bir .md dosyası " +
      "(ağacın tamamı okundu, en çok 20000 girdi ve 12 düzey derinliğe kadar; Strada.Brain'in kendi deposu olan .strada okunmadı)."],
  ] as const)("says what the scan read, and what it did not enter (%s)", (language, tail) => {
    const scan = measureProjectChecks(rootWith({ ".strada/vault/index.db": "SQLite format 3\n" }))!;
    const answer = { tool: "shell_exec", error: "exit 1", kind: "rerun" as const };

    expect(scan).toMatchObject({ filesRead: 1, directoriesRead: 1, notEntered: [".strada"] });
    expect(unverifiedNotice([answer], { offered: 7, shellOffered: true, scan }, false, language).endsWith(` ${tail}`)).toBe(true);
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

  it("names that only look like tests declare no check, but a Python file, a file called tests and a package.json are not documents", async () => {
    const root = rootWith({
      "latest_news.py": "",
      "contest.md": "",
      tests: "not a directory\n",
      "package.json": JSON.stringify({ dependencies: { express: "^5.0.0" }, devDependencies: { nodemon: "^3.0.0" } }),
    });
    const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: NO_CHECK_TOOLS, projectPath: root });

    expect(plan.evidence.verificationTooling?.projectChecks?.found).toEqual([]);
    expect(plan.evidence.verificationTooling?.projectChecks?.otherFiles).toEqual(expect.arrayContaining(["latest_news.py", "tests", "package.json"]));
    expect(plan.evidence.verificationTooling?.projectChecks?.otherFiles).not.toContain("contest.md");
    expect(rowOf(plan, "the project declares a check shell_exec could run")?.effect).toBe("keeps the gate");
    expect(plan.initialDecision).toBe("continue");
  });

  it("the npm-init placeholder declares no check, but a package.json is not a kind that carries none (QA 2026-11-16)", async () => {
    const root = rootWith({ "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', start: "node index.js" } }) });
    const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: NO_CHECK_TOOLS, projectPath: root });

    expect(plan.evidence.verificationTooling?.projectChecks?.found).toEqual([]);
    expect(plan.evidence.verificationTooling?.projectChecks?.otherFiles).toEqual(["package.json"]);
    expect(plan.initialDecision).toBe("continue");
  });

  it("a Makefile whose targets are not checks declares none, but a Makefile is not a document (QA 2026-11-16)", async () => {
    const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: NO_CHECK_TOOLS, projectPath: rootWith({ Makefile: "install:\n\tcp a b\n" }) });

    expect(plan.evidence.verificationTooling?.projectChecks?.found).toEqual([]);
    expect(plan.evidence.verificationTooling?.projectChecks?.otherFiles).toEqual(["Makefile"]);
    expect(plan.initialDecision).toBe("continue");
  });

  it.each([
    ["a default Django project", {
      "manage.py": "import sys\n", "requirements.txt": "Django>=5.0\n",
      "shop/__init__.py": "", "shop/tests.py": "from django.test import TestCase\n", "shop/views.py": "",
    }, "manage.py"],
    ["a unittest tests.py at the root", { "tests.py": "import unittest\n" }, "tests.py"],
    ["a test.py at the root", { "test.py": "import unittest\n" }, "test.py"],
    ["pytest named in requirements.txt", { "requirements.txt": "pytest\n" }, "requirements.txt"],
    ["requirements in a folder of their own", { "requirements/dev.txt": "pytest\n" }, "requirements/dev.txt"],
    ["a doctest file pytest collects with no configuration", { "docs/test_usage.txt": ">>> 1 + 1\n2\n" }, "docs/test_usage.txt"],
    ["a test.sh", { "test.sh": "#!/bin/sh\n" }, "test.sh"],
    ["a test script in a folder", { "scripts/run_tests.sh": "#!/bin/sh\n" }, "scripts/run_tests.sh"],
    ["a Swift package", { "Package.swift": "// swift-tools-version:5.9\n" }, "Package.swift"],
    ["a Dart package", { "pubspec.yaml": "name: lantern\n" }, "pubspec.yaml"],
    ["an sbt build", { "build.sbt": "name := \"lantern\"\n" }, "build.sbt"],
    ["a PHPUnit configuration", { "phpunit.xml": "<phpunit/>\n" }, "phpunit.xml"],
    ["a program node --check reads", { "main.js": "console.log('lit');\n" }, "main.js"],
    ["a file with no extension", { lantern: "#!/usr/bin/env node\n" }, "lantern"],
  ])("shell_exec is offered and the tree holds a file that is not a document or an image: %s (QA 2026-11-16)", async (_label, files, named) => {
    const startedAt = Date.now() - 54_000 - named.length;
    const plan = await verdictAfter({ draft: NOT_VERIFIED, tools: NO_CHECK_TOOLS, projectPath: rootWith(files), startedAt });

    expect(plan.evidence.verificationTooling?.projectChecks?.otherFiles).toContain(named);
    expect(rowOf(plan, "the project declares a check shell_exec could run")).toMatchObject({
      value: expect.stringContaining(named),
      effect: "keeps the gate",
    });
    expect(plan.initialDecision).toBe("continue");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
    expect(plan.gate).not.toContain(NO_VERIFICATION_TOOL);
    expect(takeUnverifiedNotice(CHAT, startedAt)).toBeUndefined();
  });

  it("a program that crashed and was run again: the program is a file a check reads (node --check), so the gate stays", async () => {
    const startedAt = Date.now() - 55_000;
    const plan = await verdictAfter({
      calls: [["shell_exec", "node main.js", CRASHED], ["file_write", "main.js"], ["shell_exec", "node main.js", RAN]],
      draft: NOT_VERIFIED,
      tools: NO_CHECK_TOOLS,
      projectPath: rootWith({}),
      startedAt,
    });

    expect(plan.evidence.recentFailureRetries).toEqual({ rerun: 1, rewritten: 0 });
    expect(plan.evidence.verificationTooling?.projectChecks).toMatchObject({ otherFiles: ["main.js"], otherWrites: ["main.js"] });
    expect(rowOf(plan, "the project declares a check shell_exec could run")?.effect).toBe("keeps the gate");
    expect(plan.initialDecision).toBe("continue");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
    expect(takeUnverifiedNotice(CHAT, startedAt)).toBeUndefined();
  });

  it("a file this run wrote that the root read does not hold (a lease) is judged by its kind too", async () => {
    const plan = await verdictAfter({
      calls: [["file_write", "tools/main.js", { content: "Wrote tools/main.js" }], ...FAIL_THEN_FIX],
      draft: DONE,
      tools: NO_CHECK_TOOLS,
      projectPath: rootWith({}),
    });

    expect(plan.evidence.verificationTooling?.projectChecks).toMatchObject({ otherFiles: [], otherWrites: ["tools/main.js"] });
    expect(rowOf(plan, "the project declares a check shell_exec could run")).toMatchObject({
      value: "holds files of a kind that may carry a check: tools/main.js (written by this run)",
      effect: "keeps the gate",
    });
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
  });

  it("a verdict with no open failure does not scan the project tree", async () => {
    const plan = await verdictAfter({ calls: [["file_write", "notes/lantern.txt"]], draft: DONE, tools: NO_CHECK_TOOLS, projectPath: rootWith({}) });

    expect(plan.evidence.recentFailures).toEqual([]);
    expect(plan.evidence.verificationTooling).toBeUndefined();
    expect(plan.evidence.unverifiableDecision).toBeUndefined();
  });

  it.each([
    ["a package.json one level down", { "app/package.json": JSON.stringify({ scripts: { test: "node --test" } }) }, ["app/package.json scripts.test"]],
    ["a Python package in a folder", { "backend/pyproject.toml": "[project]\nname = \"lantern\"\n", "backend/tests/test_a.py": "def test_a(): pass\n" },
      ["backend/pyproject.toml", "backend/tests/"]],
    ["a C# project two levels down", { "src/App/App.csproj": "<Project />\n" }, ["src/App/*.sln / *.csproj"]],
    ["a Go module in a folder", { "server/go.mod": "module example.com/lantern\n" }, ["server/go.mod"]],
    ["a workspaces monorepo whose test lives in a package",
      { "package.json": JSON.stringify({ workspaces: ["packages/*"] }), "packages/a/package.json": JSON.stringify({ scripts: { test: "vitest run" } }) },
      ["packages/a/package.json scripts.test"]],
    // A folder name that is a cache in one project and the project in another is entered (QA 2026-11-16).
    ["a C# project in a folder named Library, with no .sln at the root", { "Library/Library.csproj": "<Project />\n" }, ["Library/*.sln / *.csproj"]],
    ["a package under tools/build", { "tools/build/package.json": JSON.stringify({ scripts: { test: "vitest run" } }) },
      ["tools/build/package.json scripts.test"]],
  ])("shell_exec is offered and a directory under the root declares a check: %s (QA 2026-11-16)", async (_label, files, found) => {
    const startedAt = Date.now() - 49_000 - found[0]!.length;
    const plan = await verdictAfter({
      calls: [["shell_exec", "node app/main.js", CRASHED], ["file_write", "app/main.js"], ["shell_exec", "node app/main.js", RAN]],
      draft: NOT_VERIFIED,
      tools: NO_CHECK_TOOLS,
      projectPath: rootWith(files),
      startedAt,
    });

    expect(plan.evidence.recentFailureRetries).toEqual({ rerun: 1, rewritten: 0 });
    expect(plan.evidence.verificationTooling?.projectChecks?.found).toEqual(found);
    expect(rowOf(plan, "the project declares a check shell_exec could run")?.effect).toBe("keeps the gate");
    expect(plan.initialDecision).toBe("continue");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
    expect(plan.gate).not.toContain(NO_VERIFICATION_TOOL);
    expect(takeUnverifiedNotice(CHAT, startedAt)).toBeUndefined();
  });

  it("a tree deeper than the scan's limit: what lies below is unread, so nothing is said of it", async () => {
    const startedAt = Date.now() - 51_000;
    const deep = Array.from({ length: SCAN_LIMITS.depth + 1 }, (_, i) => `d${i + 1}`).join("/");
    const plan = await verdictAfter({ draft: DONE, tools: NO_CHECK_TOOLS, projectPath: rootWith({ [`${deep}/`]: "" }), startedAt });

    expect(plan.evidence.verificationTooling?.projectChecks?.incomplete).toBe(`${deep}/ is deeper than ${SCAN_LIMITS.depth} levels`);
    expect(rowOf(plan, "the project declares a check shell_exec could run")?.effect).toBe("unknown: keeps the gate");
    expect(plan.initialDecision).toBe("continue");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
    expect(takeUnverifiedNotice(CHAT, startedAt)).toBeUndefined();
  });

  it("a linked directory is not followed, so the scan is incomplete", async () => {
    const root = rootWith({});
    const elsewhere = rootWith({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) });
    symlinkSync(elsewhere, join(root, "linked"), "junction");
    const plan = await verdictAfter({ draft: DONE, tools: NO_CHECK_TOOLS, projectPath: root });

    expect(plan.evidence.verificationTooling?.projectChecks?.incomplete).toBe("linked/ is a linked directory, not followed");
    expect(rowOf(plan, "the project declares a check shell_exec could run")?.effect).toBe("unknown: keeps the gate");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
  });

  it("a dependency folder is entered: only the version-control stores are skipped (QA 2026-11-16)", async () => {
    const plan = await verdictAfter({
      draft: DONE,
      tools: NO_CHECK_TOOLS,
      projectPath: rootWith({ "node_modules/left-pad/package.json": JSON.stringify({ scripts: { test: "tape test.js" } }) }),
    });

    expect(plan.evidence.verificationTooling?.projectChecks).toMatchObject({ found: ["node_modules/left-pad/package.json scripts.test"] });
    expect(plan.evidence.verificationTooling?.projectChecks?.skipped).not.toContain("node_modules");
    expect(plan.evidence.verificationTooling?.projectChecks?.incomplete).toBeUndefined();
    expect(plan.initialDecision).toBe("continue");
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
      projectPath: rootWith({}),
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

  it.each([
    ["two index.js files", "Create packages/a/index.js and packages/b/index.js", "packages/a/index.js", "packages/b/index.js"],
    ["two __init__.py files", "Create src/foo/__init__.py and src/bar/__init__.py", "src/foo/__init__.py", "src/bar/__init__.py"],
  ])("a write that failed, followed by a write of another file with the same name: %s (QA 2026-11-16)", async (_label, task, failed, written) => {
    const startedAt = Date.now() - 46_000 - failed.length;
    const root = rootWith({});
    const denied = { content: "Error: could not write file (EACCES)", isError: true };
    const plan = await verdictAfter({
      task,
      calls: [["file_write", failed, denied], ["file_write", written]],
      draft: `Created ${failed} and ${written}.`,
      tools: NO_CHECK_TOOLS,
      projectPath: root,
      startedAt,
    });

    // Nothing makes the failed path impossible: its directory is missing, not a file.
    expect(existsSync(join(root, failed))).toBe(false);
    expect(existsSync(join(root, written))).toBe(true);
    expect(plan.evidence.recentFailureAnswers).toBeUndefined();
    expect(rowOf(plan, "every open failure was answered by a later success")?.effect).toBe("keeps the gate");
    expect(plan.initialDecision).toBe("continue");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
    expect(plan.gate).not.toContain(NO_VERIFICATION_TOOL);
    expect(takeUnverifiedNotice(CHAT, startedAt)).toBeUndefined();
  });

  it("the run made the file that blocks the failed path: the record cannot say the path was impossible before (#88)", async () => {
    const startedAt = Date.now() - 52_000;
    const root = rootWith({});
    const plan = await verdictAfter({
      // The task names no path, so only the blocker's origin can keep the gate here.
      task: "Write the kappa note into the notes folder",
      calls: [["file_write", "notes"], ["file_write", "notes/kappa.txt"], ["file_write", "docs/kappa.txt"]],
      draft: "Wrote the kappa note.",
      tools: NO_CHECK_TOOLS,
      projectPath: root,
      startedAt,
    });

    expect(plan.evidence.recentFailures).toEqual([expect.stringMatching(/^file_write: Error: could not write file/)]);
    expect(existsSync(join(root, "notes", "kappa.txt"))).toBe(false);
    expect(plan.evidence.recentFailureAnswers).toBeUndefined();
    expect(rowOf(plan, "every open failure was answered by a later success")?.effect).toBe("keeps the gate");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
    expect(takeUnverifiedNotice(CHAT, startedAt)).toBeUndefined();
  });

  it("the run made the blocker through the root's real spelling: the record still names it (QA 2026-11-16)", async () => {
    const real = rootWith({});
    const linked = join(sandbox, `linked-root-${roots++}`);
    symlinkSync(real, linked, "junction");
    const plan = await verdictAfter({
      task: "Write the kappa note into the notes folder",
      calls: [["file_write", join(realpathSync(linked), "notes")], ["file_write", "notes/kappa.txt"], ["file_write", "docs/kappa.txt"]],
      draft: "Wrote the kappa note.",
      tools: NO_CHECK_TOOLS,
      projectPath: linked,
    });

    expect(plan.evidence.recentFailures).toEqual([expect.stringMatching(/^file_write: Error: could not write file/)]);
    expect(existsSync(join(real, "notes", "kappa.txt"))).toBe(false);
    expect(plan.evidence.recentFailureAnswers).toBeUndefined();
    expect(rowOf(plan, "every open failure was answered by a later success")?.effect).toBe("keeps the gate");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
  });

  it("a writer named a path outside both spellings of the root: the record cannot place it, so the blocker may be the run's", async () => {
    const root = rootWith({ notes: "a file the project had before the run\n" });
    const plan = await verdictAfter({
      task: "Write the kappa note into the notes folder",
      calls: [
        ["file_write", join(sandbox, "elsewhere", "notes"), { content: "Wrote it" }],
        ["file_write", "notes/kappa.txt"],
        ["file_write", "docs/kappa.txt"],
      ],
      draft: "Wrote the kappa note.",
      tools: NO_CHECK_TOOLS,
      projectPath: root,
    });

    expect(plan.evidence.recentFailures).toEqual([expect.stringMatching(/^file_write: Error: could not write file/)]);
    expect(plan.evidence.recentFailureAnswers).toBeUndefined();
    expect(rowOf(plan, "every open failure was answered by a later success")?.effect).toBe("keeps the gate");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
  });

  it("a writer that names no path ran in the run (shell_exec): it may have made the blocker, so the record cannot tell", async () => {
    const root = rootWith({ notes: "made by a shell command\n" });
    const plan = await verdictAfter({
      task: "Write the kappa note into the notes folder",
      calls: [["shell_exec", "printf x > notes", { content: "" }], ["file_write", "notes/kappa.txt"], ["file_write", "docs/kappa.txt"]],
      draft: "Wrote the kappa note.",
      tools: NO_CHECK_TOOLS,
      projectPath: root,
    });

    expect(plan.evidence.recentFailureAnswers).toBeUndefined();
    expect(rowOf(plan, "every open failure was answered by a later success")?.effect).toBe("keeps the gate");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
  });

  it("the task names the same file at two paths and only one was written (#88)", async () => {
    const startedAt = Date.now() - 53_000;
    const root = rootWith({});
    const plan = await verdictAfter({
      task: "Create notes/alpha.txt and docs/alpha.txt, each containing the word ALPHA",
      calls: [["file_write", "README.md/alpha.txt"], ["file_write", "docs/alpha.txt"]],
      draft: "Created notes/alpha.txt and docs/alpha.txt.",
      tools: NO_CHECK_TOOLS,
      projectPath: root,
      startedAt,
    });

    expect(existsSync(join(root, "notes", "alpha.txt"))).toBe(false);
    expect(plan.evidence.recentFailureAnswers).toBeUndefined();
    expect(rowOf(plan, "every open failure was answered by a later success")?.effect).toBe("keeps the gate");
    expect(plan.initialDecision).toBe("continue");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
    expect(takeUnverifiedNotice(CHAT, startedAt)).toBeUndefined();
  });

  it("a deletion that failed, followed by a deletion of another file with the same name (QA 2026-11-16)", async () => {
    const startedAt = Date.now() - 47_000;
    const root = rootWith({ "services/": "" });
    mkdirSync(join(root, "services", "a"));
    mkdirSync(join(root, "services", "b"));
    writeFileSync(join(root, "services", "a", "config.json"), "{}\n");
    const busy = { content: "Error: EBUSY: resource busy or locked", isError: true };
    const plan = await verdictAfter({
      task: "Delete services/a/config.json and services/b/config.json",
      calls: [["file_delete", "services/a/config.json", busy], ["file_delete", "services/b/config.json", { content: "Deleted services/b/config.json" }]],
      draft: "Deleted both config files.",
      tools: [...NO_CHECK_TOOLS, "file_delete"],
      projectPath: root,
      startedAt,
    });

    expect(existsSync(join(root, "services", "a", "config.json"))).toBe(true);
    expect(plan.evidence.recentFailureAnswers).toBeUndefined();
    expect(rowOf(plan, "every open failure was answered by a later success")?.effect).toBe("keeps the gate");
    expect(plan.initialDecision).toBe("continue");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
    expect(takeUnverifiedNotice(CHAT, startedAt)).toBeUndefined();
  });

  it("a deletion under a file, followed by a deletion of the same name elsewhere: only a writer that creates a file may answer by name", async () => {
    const startedAt = Date.now() - 48_000;
    const root = rootWith({ "services/": "" });
    mkdirSync(join(root, "services", "b"));
    const plan = await verdictAfter({
      calls: [
        ["file_delete", "README.md/config.json", { content: "Error: ENOTDIR: not a directory", isError: true }],
        ["file_delete", "services/b/config.json", { content: "Deleted services/b/config.json" }],
      ],
      draft: "Deleted the config file.",
      tools: [...NO_CHECK_TOOLS, "file_delete"],
      projectPath: root,
      startedAt,
    });

    expect(plan.evidence.recentFailureAnswers).toBeUndefined();
    expect(rowOf(plan, "every open failure was answered by a later success")?.effect).toBe("keeps the gate");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
    expect(takeUnverifiedNotice(CHAT, startedAt)).toBeUndefined();
  });

  it("a rename that failed, followed by another rename onto the same path: only the same call answers it", async () => {
    const state = await stateAfter(
      [["file_rename", "notes/b.txt", { content: "Error: ENOENT: no such file", isError: true }], ["file_rename", "notes/b.txt", { content: "Renamed" }]],
      TASK,
    );
    // The second call renamed another file onto notes/b.txt: same tool, same target, another input.
    const another = { ...state, stepResults: state.stepResults.map((step, i) => (i === 1 ? { ...step, inputSignature: "another-input" } : step)) };
    const plan = planVerifierPipeline({ ...pipelineInputs(TASK, DONE, [...NO_CHECK_TOOLS, "file_rename"], project), state: another });

    expect(plan.evidence.recentFailureAnswers).toBeUndefined();
    expect(rowOf(plan, "every open failure was answered by a later success")?.effect).toBe("keeps the gate");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
  });

  it.each(["file_edit", "file_delete", "file_delete_directory", "file_manage", "strada_create_module", "unity_generate_sprite"])(
    "%s failed, then succeeded on the same path with another input: only the same call answers a tool that does not create the file",
    async (tool) => {
      const state = await stateAfter([[tool, "notes/b.txt", { content: "Error: EBUSY", isError: true }], [tool, "notes/b.txt", { content: "Done" }]], TASK);
      // The second call acted on notes/b.txt with another input: same tool, same target, another call.
      const another = { ...state, stepResults: state.stepResults.map((step, i) => (i === 1 ? { ...step, inputSignature: "another-input" } : step)) };
      const plan = planVerifierPipeline({ ...pipelineInputs(TASK, DONE, [...NO_CHECK_TOOLS, tool], project), state: another });

      expect(another.stepResults.map((step) => step.targetPath)).toEqual(["notes/b.txt", "notes/b.txt"]);
      expect(plan.evidence.recentFailureAnswers).toBeUndefined();
      expect(rowOf(plan, "every open failure was answered by a later success")?.effect).toBe("keeps the gate");
      expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
    },
  );

  it("a write under a file, followed by its file name elsewhere, with no project root to measure it in", async () => {
    const plan = await verdictAfter({ draft: DONE, tools: NO_CHECK_TOOLS.filter((t) => t !== "shell_exec"), projectPath: null });

    expect(rowOf(plan, "the project declares a check shell_exec could run")?.effect).toBe("allows");
    expect(plan.evidence.recentFailureAnswers).toBeUndefined();
    expect(rowOf(plan, "every open failure was answered by a later success")?.effect).toBe("keeps the gate");
    expect(plan.gate).toContain("[TARGETED VERIFICATION REQUIRED]");
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

describe("fileOnPath: why a failed write's path cannot exist, measured in the project root", () => {
  it("names the directory of the path that is a file", () => {
    expect(fileOnPath(project, "README.md/lantern.txt")).toBe("README.md");
    expect(fileOnPath(project, "README.md/deeper/lantern.txt")).toBe("README.md");
  });

  it.each([
    ["the directories exist", "notes/lantern.txt"],
    ["a directory is missing", "packages/a/index.js"],
    ["the path is outside the root", "../elsewhere/lantern.txt"],
  ])("finds nothing when %s", (_label, target) => {
    expect(fileOnPath(project, target)).toBeNull();
  });

  it("finds nothing with no root", () => {
    expect(fileOnPath(undefined, "README.md/lantern.txt")).toBeNull();
  });

  it("measures nothing outside the root, even a file there", () => {
    writeFileSync(join(sandbox, "outside.txt"), "not the project's\n");

    expect(fileOnPath(project, "../outside.txt/lantern.txt")).toBeNull();
    expect(fileOnPath(project, join(sandbox, "outside.txt", "lantern.txt"))).toBeNull();
  });
});

describe("inertKind: the closed set of kinds that carry no check", () => {
  it.each(["README.md", "notes/kappa.txt", "docs/Guide.MARKDOWN", "art/logo.png", "LICENSE", ".gitignore", "contest.md", "latest.txt"])(
    "reads %j as a kind that carries no check",
    (path) => {
      expect(inertKind(path)).not.toBeNull();
    },
  );

  it.each([
    "main.js", "manage.py", "package.json", "Makefile", "test.sh", "notes", "logo.svg", "data.csv",
    // Names of a document kind that a tool reads: CMake's and pip's inputs, pytest's default doctest glob.
    "CMakeLists.txt", "requirements.txt", "dev-requirements.txt", "requirements/base.txt", "constraints.txt",
    "test_usage.txt", "docs/tests.md", "docs/spec.md",
  ])("reads %j as a kind that may carry one", (path) => {
    expect(inertKind(path)).toBeNull();
  });
});

describe("measureProjectChecks: none is said only of a whole tree", () => {
  it("stops at the entry limit: the tree is unread past it", () => {
    const root = rootWith({ "a.txt": "", "b.txt": "", "c.txt": "", "d.txt": "" });
    const record = measureProjectChecks(root, { entries: 3, depth: SCAN_LIMITS.depth });

    expect(record).toMatchObject({ found: [], directoriesRead: 1, incomplete: "the tree holds more than 3 entries" });
  });

  it("a directory it cannot read leaves the scan incomplete; an unreadable root gives no record", () => {
    const root = rootWith({ "app/": "" });
    const refused = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const readDirectory = (dir: string) => {
      if (dir === join(root, "app")) throw refused;
      return readdirSync(dir, { withFileTypes: true });
    };

    expect(measureProjectChecks(root, SCAN_LIMITS, readDirectory)).toMatchObject({ found: [], incomplete: "app/ could not be read (EACCES)" });
    expect(measureProjectChecks(root, SCAN_LIMITS, () => { throw refused; })).toBeNull();
  });

  it("reads every directory of a tree within the limits, and says so", () => {
    const root = rootWith({ "docs/": "", "src/lib/": "" });
    const record = measureProjectChecks(root);

    expect(record).toMatchObject({ found: [], directoriesRead: 4 });
    expect(record?.incomplete).toBeUndefined();
  });
});

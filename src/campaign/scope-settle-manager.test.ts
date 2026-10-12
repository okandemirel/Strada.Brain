/**
 * The settle path under the scope gate (GDD-drift plan W09, M2 + M3).
 *
 * In a measured campaign six of six milestones went green on prose: a worker's
 * report, the verifier's flags, its own tests — while five of their tips
 * carried the system's own "I got stuck" stamp. Here a campaign runs against a
 * real git project, a fake test writer and a fake acceptance runner, and the
 * settle path is held to the rule: a milestone is green only when its own GDD
 * rows (and every row that passed before) pass the system's checks in one
 * admitted run on the committed revision, judged with how the run ended.
 *
 * Every document, row and label here is invented.
 */

import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CampaignManager, UNMEASURABLE_PROOF_RE, type CampaignManagerOptions } from "./campaign-manager.js";
import type { CampaignPlanner } from "./campaign-planner.js";
import { CampaignStorage } from "./campaign-storage.js";
import { decodeRequirement } from "./requirement-identity.js";
import { applyReviewFindings } from "./review-findings.js";
import {
  ACCEPTANCE_DIR,
  type AcceptanceAuthorLike,
  type AcceptanceCheckBody,
  type AcceptanceSuiteRunner,
  type AcceptanceWriteResult,
  type AcceptanceWriter,
  type RequirementRow,
  type ScopeGateMode,
} from "./scope-types.js";
import type { Campaign } from "./types.js";
import type { TaskManager } from "../tasks/task-manager.js";
import { deriveTestVerdict } from "../tasks/test-verdict.js";
import type { RunIntegrity, TerminalKey } from "../agents/autonomy/terminal-key.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const GDD = [
  "# Ember Ferry — Game Design Document",
  "",
  "## 1. Overview",
  "A small ferry carries lanterns across a dark lake.",
  "",
  "## 2. Core Rules",
  "EF-1: The ferry must stop at every lit pier.",
  "EF-2: A rider must board only from a lit pier.",
  "EF-3: The ferry must never sink while a rider is aboard.",
  "",
  "## 3. Screens",
  "### 3.1 Dock Menu",
  "The dock menu must show a Launch button.",
  "",
].join("\n");

const LADDER = {
  milestones: [
    { title: "Sprint A — Rules", prompt: "build the ferry's rules", coveredSections: ["Core Rules"] },
    { title: "Sprint B — Mood", prompt: "build the lake's mood", coveredSections: ["Overview"] },
    { title: "Sprint C — Screens", prompt: "build the dock menu", coveredSections: ["Screens"] },
  ],
};

const WRITER: AcceptanceWriter = { provider: "checker", model: "checker-model-1", independence: "different-model" };
/** A name no game declares: a check body that uses it does not compile. */
const DOES_NOT_COMPILE = "FerryPierThatDoesNotExist";
const WORKER_MODEL = "worker-model-1";

interface FakeTask {
  id: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  result?: string;
  error?: string;
  verification?: Record<string, unknown>;
  cancelReason?: string;
}

const dirs: string[] = [];
const managers: CampaignManager[] = [];
afterEach(async () => {
  // Awaited: the probes a settle left running in the project must exit before it is removed.
  for (const manager of managers.splice(0)) await manager.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ctx = { chatId: "chat-1", channelType: "cli", userId: "owner-1" };

function gitIn(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

/** A fake test writer: a body for every row it is asked about, unless told otherwise. */
function fakeAuthor(
  opts: {
    writer?: AcceptanceWriter;
    unbound?: (row: RequirementRow) => string | undefined;
    faulted?: (row: RequirementRow) => string | undefined;
    /** The body a repair returns, when not the default one. */
    repaired?: (row: RequirementRow) => string | undefined;
  } = {},
) {
  const writer = opts.writer ?? WRITER;
  const bodyFor = (row: RequirementRow): AcceptanceCheckBody => ({
    rid: row.rid,
    body: `global::NUnit.Framework.Assert.That(PlaythroughView != null, "${row.label ?? row.rid}");`,
  });
  const write = vi.fn(async (rows: readonly RequirementRow[]): Promise<AcceptanceWriteResult> => {
    const checks: AcceptanceCheckBody[] = [];
    const unbound: Array<{ rid: string; missingObservable: string }> = [];
    const faulted: Array<{ rid: string; cause: "lint"; problems: string[] }> = [];
    for (const row of rows) {
      const missing = opts.unbound?.(row);
      const fault = opts.faulted?.(row);
      if (missing !== undefined) unbound.push({ rid: row.rid, missingObservable: missing });
      else if (fault !== undefined) faulted.push({ rid: row.rid, cause: "lint", problems: [fault] });
      else checks.push(bodyFor(row));
    }
    return { checks, unbound, faulted, writer, calls: 1 };
  });
  const repair = vi.fn(async (row: RequirementRow): Promise<AcceptanceWriteResult> => ({
    checks: [{ ...bodyFor(row), body: opts.repaired?.(row) ?? `${bodyFor(row).body} // repaired` }],
    unbound: [],
    faulted: [],
    writer,
    calls: 1,
  }));
  const author: AcceptanceAuthorLike = {
    write,
    regenerate: vi.fn(async (row) => repair(row)),
    repairCompile: vi.fn(async () => ({ checks: [], unbound: [], faulted: [], writer, calls: 1 })),
    rebind: vi.fn(async (row) => repair(row)),
    revise: vi.fn(async (row) => repair(row)),
    describe: () => `${writer.provider}:${writer.model}`,
  };
  return { author, write, repair };
}

function build(
  mode: ScopeGateMode,
  extra: Partial<CampaignManagerOptions> & {
    failing?: (label: string) => boolean;
    message?: (label: string) => string;
    runnerCalls?: string[];
    ladder?: typeof LADDER;
    git?: boolean;
    /** The worker's change leaves the checks' unchanged bytes unable to compile. */
    workerBroke?: () => boolean;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "strada-scope-settle-"));
  dirs.push(dir);
  const root = join(dir, "project");
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "Assets", "Game"), { recursive: true });
  mkdirSync(join(root, "Packages"), { recursive: true });
  writeFileSync(join(root, "Packages", "manifest.json"), JSON.stringify({ dependencies: { "com.strada.core": "1.0.0" } }));
  writeFileSync(join(root, "Assets", "Game", "Ferry.Game.asmdef"), JSON.stringify({ name: "Ferry.Game" }));
  writeFileSync(join(root, "Assets", "Game", "Ferry.cs"), "public class Ferry {}\n");
  if (extra.git !== false) {
    gitIn(root, "init", "-q");
    gitIn(root, "config", "user.email", "t@t");
    gitIn(root, "config", "user.name", "t");
    gitIn(root, "config", "commit.gpgsign", "false");
    gitIn(root, "add", "-A");
    gitIn(root, "commit", "-qm", "baseline");
  }

  const storage = new CampaignStorage(join(dir, "campaigns.db"));
  const tasks = new Map<string, FakeTask>();
  const submitted: string[] = [];
  const taskManager = Object.assign(new EventEmitter(), {
    submit: (_chatId: string, _channel: string, prompt: string) => {
      const task: FakeTask = { id: `task_${tasks.size + 1}`, status: "executing", createdAt: Date.now(), updatedAt: Date.now() };
      tasks.set(task.id, task);
      submitted.push(prompt);
      return task;
    },
    getStatus: (id: string) => tasks.get(id) ?? null,
    findLatestLineageTask: (id: string) => tasks.get(id) ?? null,
    findLineageRootId: (id: string) => id,
    isInLineage: (rootId: string, id: string) => rootId === id,
    priorProgressSummary: () => "",
    listTasks: () => [],
    listLiveInLineage: () => [],
    lineageHasDeliberateStop: () => false,
    resumeTask: () => null,
    cancel: (id: string, opts?: { reason?: string }) => {
      const task = tasks.get(id);
      if (task && task.status === "executing") {
        task.status = "cancelled";
        task.cancelReason = opts?.reason;
      }
    },
  });
  const planner = {
    planMilestones: vi.fn().mockResolvedValue(extra.ladder ?? LADDER),
    complete: vi.fn(async () => JSON.stringify({ rows: [] })),
    auditCoverage: vi.fn(async () => []),
    resolveCoverageGaps: vi.fn(async () => ({ open: [], closed: [] })),
  } as unknown as CampaignPlanner;
  const messages: string[] = [];
  const runnerCalls: string[] = extra.runnerCalls ?? [];
  const labelOfTest = (testName: string): string | undefined => {
    for (const c of storage.listActive()) {
      for (const file of storage.listAcceptance(c.id)) {
        const test = file.tests.find((t) => t.testName === testName);
        if (test) return c.requirements?.rows.find((r) => r.rid === test.rid)?.label ?? test.rid;
      }
    }
    return undefined;
  };
  const runner: AcceptanceSuiteRunner = async (projectRoot, runId, filter) => {
    const names = (filter.testFilter ?? "").split(";").filter((n) => n !== "");
    runnerCalls.push(filter.testFilter ?? "");
    // A check file that does not compile: the editor leaves the whole
    // acceptance assembly out of the run, and says why in its output.
    const folder = join(projectRoot, ...ACCEPTANCE_DIR.split("/"));
    const workerBroke = extra.workerBroke?.() === true;
    const broken = existsSync(folder)
      ? readdirSync(folder).filter(
          (f) => f.endsWith(".cs") && (readFileSync(join(folder, f), "utf8").includes(DOES_NOT_COMPILE) || (workerBroke && f.startsWith("Acceptance_"))),
        )
      : [];
    if (broken.length > 0) {
      mkdirSync(join(projectRoot, "Recordings", "tests"), { recursive: true });
      writeFileSync(
        join(projectRoot, "Recordings", "tests", "playmode-last.json"),
        JSON.stringify({ measuredAt: new Date().toISOString(), runId, result: "Passed", total: 0, passed: 0, failed: 0, skipped: 0, failedNames: [], filter: filter.testFilter ?? null, categories: null }),
      );
      return {
        content: [
          "PlayMode verification FAILED: no test executed, because the project does not compile — the test assembly was never built. Fix these first:",
          ...broken.map((f) => `  ${ACCEPTANCE_DIR}/${f}(12,9): error CS0103: The name '${DOES_NOT_COMPILE}' does not exist in the current context`),
        ].join("\n"),
      };
    }
    const failed = names.filter((n) => extra.failing?.(labelOfTest(n) ?? "") === true);
    mkdirSync(join(projectRoot, "Recordings", "tests"), { recursive: true });
    writeFileSync(
      join(projectRoot, "Recordings", "tests", "playmode-last.json"),
      JSON.stringify({
        measuredAt: new Date().toISOString(),
        runId,
        result: failed.length > 0 ? "Failed" : "Passed",
        total: names.length,
        passed: names.length - failed.length,
        failed: failed.length,
        skipped: 0,
        failedNames: failed,
        filter: filter.testFilter ?? null,
        categories: null,
      }),
    );
    const content = failed.length > 0 ? ["PlayMode verification FAILED", "", "Failed:", ...failed.flatMap((n) => [`  ${n}`, `      ${extra.message?.(labelOfTest(n) ?? "") ?? "Expected: True  But was: False"}`])].join("\n") : "PlayMode verification passed";
    return { content };
  };
  const { failing: _failing, message: _message, runnerCalls: _calls, ladder: _ladder, git: _git, workerBroke: _broke, ...options } = extra;
  const manager = new CampaignManager({
    storage,
    planner,
    taskManager: taskManager as unknown as TaskManager,
    messenger: async (_chatId, text) => {
      messages.push(text);
    },
    projectRoot: root,
    scopeGateMode: mode,
    retryAdoptionGraceMs: 10,
    completedSettleDelayMs: 0,
    maxMilestoneAttempts: 2,
    verifyCompile: async () => ({ ok: true, ran: true, errors: 0, detail: "compiles" }),
    acceptanceAuthor: fakeAuthor().author,
    runAcceptanceSuite: runner,
    ...options,
  });
  manager.attachEvents();
  managers.push(manager);
  return { manager, storage, root, tasks, submitted, messages, taskManager, runnerCalls };
}

type Harness = ReturnType<typeof build>;

const integrity = (key: TerminalKey, models: string[] = [WORKER_MODEL]): RunIntegrity => ({
  terminalKeys: [key],
  worst: key,
  source: "spine",
  workerModels: models,
});

let edits = 0;
/** The worker's sprint: a real code change in the tree, then the task settles completed. */
function completeSprint(
  h: Harness,
  opts: {
    key?: TerminalKey;
    /** The whole integrity the run carried, when one key does not say it. */
    integrity?: RunIntegrity & { infrastructureErrors?: number };
    verification?: Record<string, unknown>;
    result?: string;
    status?: "completed" | "failed";
    error?: string;
  } = {},
): string {
  const campaign = h.storage.listActive()[0]!;
  const milestone = campaign.milestones[campaign.currentMilestone]!;
  const taskId = milestone.taskId!;
  edits += 1;
  writeFileSync(join(h.root, "Assets", "Game", `Edit${edits}.cs`), `public class Edit${edits} {}\n`);
  const task = h.tasks.get(taskId)!;
  task.status = opts.status ?? "completed";
  task.updatedAt = Date.now();
  task.result = opts.result ?? "Sprint done: the ferry stops at lit piers.";
  if (opts.error !== undefined) task.error = opts.error;
  task.verification = { testsGreen: undefined, detail: "no test run observed", ...opts.verification, runIntegrity: opts.integrity ?? integrity(opts.key ?? "done") };
  if (task.status === "failed") h.taskManager.emit("task:failed", taskId, opts.error ?? task.result);
  else h.taskManager.emit("task:completed", taskId, task.result);
  return taskId;
}

/**
 * The NUnit record the worker's own red run left in the project, exactly as
 * Strada.MCP's writePlaymodeRunRecord writes it: Unity exits 2 when tests
 * failed, the verdict reason says so, a measured NUnit file states the run's
 * result as "Failed(Child)", and `unfiltered` is derived from the filters.
 */
function workerRecord(h: Harness, fields: Record<string, unknown>): void {
  mkdirSync(join(h.root, "Recordings", "tests"), { recursive: true });
  const record: Record<string, unknown> = {
    measuredAt: new Date().toISOString(),
    result: "Failed(Child)",
    skipped: 0,
    filter: null,
    categories: null,
    exceptions: 0,
    exitCode: 2,
    reason: "tests-failed",
    ...fields,
  };
  writeFileSync(
    join(h.root, "Recordings", "tests", "playmode-last.json"),
    JSON.stringify({ ...record, unfiltered: record.filter === null && record.categories === null }, null, 2),
  );
}

async function start(h: Harness): Promise<Campaign> {
  const started = h.manager.startFromGdd(ctx, GDD, "docs/GDD.md");
  await vi.waitFor(() => expect(h.submitted).toHaveLength(1), { timeout: 15_000 });
  return h.storage.get(started.id)!;
}

const byLabel = (c: Campaign, label: string): RequirementRow => c.requirements!.rows.find((r) => r.label === label)!;

describe("a milestone is green only by the judge (scope gate on, W09)", () => {
  it("a typed task_stuck with failing owned rows: a free bounce, a charged bounce, then parked with its rows queued and the next sprint submitted", async () => {
    const h = build("on", { failing: (label) => label === "EF-2" });
    const campaign = await start(h);
    expect(campaign.milestones[0]!.requirementIds?.length).toBeGreaterThan(0);

    completeSprint(h, { key: "task_stuck" });
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
    let now = h.storage.get(campaign.id)!;
    let m1 = now.milestones[0]!;
    expect(m1.status).toBe("running");
    expect(m1.scopeBounces).toBe(1);
    expect(m1.attempts).toBe(1); // the first bounce is free
    expect(m1.prompt).toContain("[SCOPE GATE — latest measurement]");
    expect(m1.prompt).toContain("EF-2");
    expect(m1.scopeVerdict?.green).toBe(false);
    expect(m1.scopeVerdict?.reasons.some((r) => r.code === "terminal" && r.terminal === "task_stuck")).toBe(true);
    expect(m1.scopeVerdict?.reasons.some((r) => r.code === "row-failing" && r.rid === byLabel(now, "EF-2").rid)).toBe(true);
    // The row's result is bound to the committed revision, in the form closure reads.
    expect(byLabel(now, "EF-2").last?.revision).toBe(gitIn(h.root, "rev-parse", "HEAD").trim());
    expect(byLabel(now, "EF-1").last?.outcome).toBe("pass");
    // The checks are the system's own commit.
    expect(gitIn(h.root, "log", "--format=%s")).toMatch(/campaign: acceptance checks for m1 \(system-owned\)/);
    expect(h.storage.listJudgements(campaign.id, "m1")).toHaveLength(1);

    completeSprint(h, { key: "task_stuck" });
    await vi.waitFor(() => expect(h.submitted).toHaveLength(3), { timeout: 20_000 });
    now = h.storage.get(campaign.id)!;
    m1 = now.milestones[0]!;
    expect(m1.scopeBounces).toBe(2);
    expect(m1.attempts).toBe(2); // charged
    // One block, the latest.
    expect(m1.prompt.split("[SCOPE GATE — latest measurement]")).toHaveLength(2);

    completeSprint(h, { key: "task_stuck" });
    await vi.waitFor(() => expect(h.storage.get(campaign.id)!.currentMilestone).toBe(1), { timeout: 20_000 });
    await vi.waitFor(() => expect(h.submitted).toHaveLength(4), { timeout: 20_000 });
    now = h.storage.get(campaign.id)!;
    m1 = now.milestones[0]!;
    expect(m1.status).toBe("failed");
    expect(m1.parked?.queued).toContain(byLabel(now, "EF-2").rid);
    expect(m1.attempts).toBe(2);
    const queuedIds = (now.pendingCoverageGaps ?? []).map((g) => decodeRequirement(g).identity?.id);
    expect(queuedIds).toContain(byLabel(now, "EF-2").rid);
    expect(now.state).toBe("executing");
    expect(h.messages.some((m) => m.includes("PARKED"))).toBe(true);
  }, 90_000);

  it("stuck, but every owned row passed checks written by a different model: green, with the scope-proven caveat", async () => {
    const h = build("on");
    const campaign = await start(h);
    completeSprint(h, { key: "task_stuck" });
    await vi.waitFor(() => expect(h.storage.get(campaign.id)!.currentMilestone).toBe(1), { timeout: 20_000 });
    const m1 = h.storage.get(campaign.id)!.milestones[0]!;
    expect(m1.status).toBe("green");
    expect(m1.scopeVerdict?.green).toBe(true);
    expect(m1.scopeVerdict?.basis).toBe("proven");
    expect(m1.scopeVerdict?.caveats?.join(" ")).toMatch(/scope proven/);
  }, 60_000);

  it("the same rows written by a worker's own model do not prove scope: a stuck run is not green", async () => {
    const h = build("on", { acceptanceAuthor: fakeAuthor({ writer: { provider: "worker", model: WORKER_MODEL, independence: "same-model" } }).author });
    const campaign = await start(h);
    completeSprint(h, { key: "task_stuck" });
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
    const m1 = h.storage.get(campaign.id)!.milestones[0]!;
    expect(m1.status).toBe("running");
    expect(m1.scopeVerdict?.green).toBe(false);
  }, 60_000);

  it("a milestone that owns no rows: green on done and passing gates (vacuous); a spent gate is not green", async () => {
    const h = build("on");
    const campaign = await start(h);
    completeSprint(h);
    await vi.waitFor(() => expect(h.storage.get(campaign.id)!.currentMilestone).toBe(1), { timeout: 20_000 });
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
    // m2 owns no row: done, compiles, gates passed.
    completeSprint(h);
    await vi.waitFor(() => expect(h.storage.get(campaign.id)!.currentMilestone).toBe(2), { timeout: 20_000 });
    const m2 = h.storage.get(campaign.id)!.milestones[1]!;
    expect(m2.requirementIds ?? []).toHaveLength(0);
    expect(m2.status).toBe("green");
    expect(m2.scopeVerdict?.basis).toBe("vacuous");
  }, 60_000);

  it("a vacuous milestone whose no-work bounce was spent is not green: the second completion no longer stands either way", async () => {
    const h = build("on");
    const campaign = await start(h);
    completeSprint(h);
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
    // m2 completes having changed nothing: the no-work gate bounces once…
    await new Promise((r) => setTimeout(r, 1100));
    const settleUntouched = (): void => {
      const c = h.storage.get(campaign.id)!;
      const task = h.tasks.get(c.milestones[c.currentMilestone]!.taskId!)!;
      task.status = "completed";
      task.result = "done (allegedly)";
      task.verification = { detail: "no test run observed", runIntegrity: integrity("done") };
      h.taskManager.emit("task:completed", task.id, task.result);
    };
    settleUntouched();
    await vi.waitFor(() => expect(h.submitted).toHaveLength(3), { timeout: 20_000 });
    expect(h.storage.get(campaign.id)!.milestones[1]!.noWorkBounced).toBe(true);
    // …and the second untouched completion is judged: the spent gate fails it.
    settleUntouched();
    await vi.waitFor(() => expect(h.submitted).toHaveLength(4), { timeout: 20_000 });
    const m2 = h.storage.get(campaign.id)!.milestones[1]!;
    expect(m2.status).not.toBe("green");
    expect(m2.scopeVerdict?.reasons.some((r) => r.code === "gate-failed" && r.detail.includes("noWork"))).toBe(true);
  }, 60_000);

  it("a red record naming only acceptance tests is the gate's to judge; a mixed list fails the sprint as before", async () => {
    const h = build("on");
    const campaign = await start(h);
    // Verdicts as the producer's reader derives them: a filtered run's red line names its tests.
    const filtered = (names: string[]) =>
      deriveTestVerdict([{ toolName: "unity_playmode_verify", content: `PlayMode verification FAILED: ${names.length} of ${names.length} tests failed (filter: ${names.join(";")})` }]);
    completeSprint(h, { verification: { ...filtered(["Strada.Acceptance.M1.Acceptance_M1.R001_aaaaaa"]) } });
    await vi.waitFor(() => expect(h.storage.get(campaign.id)!.currentMilestone).toBe(1), { timeout: 20_000 });
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
    expect(h.storage.get(campaign.id)!.milestones[0]!.status).toBe("green");

    completeSprint(h, { verification: { ...filtered(["Strada.Acceptance.M2.Acceptance_M2.R001_bbbbbb", "Ferry.Tests.DockTests.Opens"]) } });
    await vi.waitFor(() => expect(h.submitted).toHaveLength(3), { timeout: 20_000 });
    const m2 = h.storage.get(campaign.id)!.milestones[1]!;
    expect(m2.status).toBe("running");
    expect(m2.attempts).toBe(2); // the failure path charged it
    expect(m2.prompt).toMatch(/Tests were RED at completion/);
  }, 60_000);

  it("an unfiltered run's red line names no test, as production derives it: this attempt's fresh record, red only on acceptance checks, leaves the sprint to the gate", async () => {
    const h = build("on");
    const campaign = await start(h);
    const acceptance = "Strada.Acceptance.M1.Acceptance_M1.R001_aaaaaa";
    // What the verification tool prints for a whole-suite run, read by the producer's own reader.
    const verdict = deriveTestVerdict([
      {
        toolName: "unity_playmode_verify",
        content: [
          "PlayMode verification FAILED: 1 of 9 tests failed (unfiltered — the whole PlayMode suite).",
          "",
          "Failed:",
          `  ${acceptance}`,
          "      Expected: True  But was: False",
        ].join("\n"),
      },
    ]);
    expect(verdict.testsGreen).toBe(false);
    expect(verdict.failedTests).toBeUndefined();
    workerRecord(h, { total: 9, passed: 8, failed: 1, failedNames: [acceptance] });
    completeSprint(h, { verification: { ...verdict } });
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
    const m1 = h.storage.get(campaign.id)!.milestones[0]!;
    expect(m1.prompt).not.toMatch(/Tests were RED at completion/);
    expect(m1.attempts).toBe(1);
    expect(h.storage.get(campaign.id)!.currentMilestone).toBe(1);
    expect(m1.scopeVerdict?.green).toBe(true);
    expect(m1.status).toBe("green");
  }, 60_000);

  it("no prose verdict, and the producer's record red only on acceptance checks (exit 2, 'Failed(Child)'): the sprint is the gate's to judge", async () => {
    const h = build("on");
    const campaign = await start(h);
    workerRecord(h, { total: 9, passed: 8, failed: 1, failedNames: ["Strada.Acceptance.M1.Acceptance_M1.R001_aaaaaa"] });
    completeSprint(h);
    // The next sprint, or this one again when it was charged: either way a second submit.
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
    const m1 = h.storage.get(campaign.id)!.milestones[0]!;
    expect(m1.prompt).not.toMatch(/Tests were RED at completion/);
    expect(m1.attempts).toBe(1);
    expect(h.storage.get(campaign.id)!.currentMilestone).toBe(1);
    expect(m1.scopeVerdict?.green).toBe(true);
    expect(m1.status).toBe("green");
  }, 60_000);

  it("a record red only on acceptance names fails the sprint as before when it is red for another reason too, or is another run", async () => {
    const h = build("on", { maxMilestoneAttempts: 3 });
    const campaign = await start(h);
    const acceptance = "Strada.Acceptance.M1.Acceptance_M1.R001_aaaaaa";
    // No prose verdict; the record names only an acceptance check — and counts two runtime exceptions.
    workerRecord(h, { total: 9, passed: 8, failed: 1, failedNames: [acceptance], exceptions: 2 });
    completeSprint(h);
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
    let m1 = h.storage.get(campaign.id)!.milestones[0]!;
    expect(m1.attempts).toBe(2);
    expect(m1.prompt).toMatch(/Tests were RED at completion \(NUnit record\)/);
    expect(m1.scopeVerdict).toBeUndefined();

    // A red line naming nothing, beside a record of ANOTHER run (its counts are not the line's).
    const verdict = deriveTestVerdict([
      { toolName: "unity_playmode_verify", content: "PlayMode verification FAILED: 3 of 9 tests failed (unfiltered — the whole PlayMode suite)." },
    ]);
    workerRecord(h, { total: 2, passed: 1, failed: 1, failedNames: [acceptance], filter: acceptance });
    completeSprint(h, { verification: { ...verdict } });
    await vi.waitFor(() => expect(h.storage.get(campaign.id)!.milestones[0]!.prompt).toMatch(/Tests were RED at completion: PlayMode verification FAILED: 3 of 9/), { timeout: 20_000 });
    m1 = h.storage.get(campaign.id)!.milestones[0]!;
    expect(m1.scopeVerdict).toBeUndefined();
  }, 60_000);

  it("an outage key takes the existing outage path with the attempt uncharged", async () => {
    const h = build("on");
    const campaign = await start(h);
    completeSprint(h, { key: "provider_quota" });
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
    const m1 = h.storage.get(campaign.id)!.milestones[0]!;
    expect(m1.attempts).toBe(1);
    expect(m1.status).toBe("running");
    expect(m1.scopeVerdict).toBeUndefined(); // it never reached the judge
  }, 60_000);

  it("a lost publication is the machinery's, not the sprint's: one uncharged resubmit, then the budget applies", async () => {
    const h = build("on");
    const campaign = await start(h);
    const lost = "PUBLICATION FAILED: the workspace commit threw before the work reached the project (disk full). The workspace is kept for salvage.";
    completeSprint(h, { status: "failed", error: lost, key: "error", result: lost });
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
    let m1 = h.storage.get(campaign.id)!.milestones[0]!;
    expect(m1.attempts).toBe(1);
    expect(m1.scopeResubmits).toBe(1);
    completeSprint(h, { status: "failed", error: lost, key: "error", result: lost });
    await vi.waitFor(() => expect(h.submitted).toHaveLength(3), { timeout: 20_000 });
    m1 = h.storage.get(campaign.id)!.milestones[0]!;
    expect(m1.attempts).toBe(2);
  }, 60_000);

  it("the uncharged resubmit is spent only when a resubmit follows: a lost publication at the attempt limit leaves it for the next budget", async () => {
    const h = build("on");
    const campaign = await start(h);
    completeSprint(h, { status: "failed", error: "ran out of steps", result: "ran out of steps", key: "max_steps_reached" });
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
    expect(h.storage.get(campaign.id)!.milestones[0]!.attempts).toBe(2);
    const lost = "PUBLICATION FAILED: the workspace commit threw before the work reached the project (disk full). The workspace is kept for salvage.";
    completeSprint(h, { status: "failed", error: lost, key: "error", result: lost });
    // No attempt is left, so nothing is resubmitted: the milestone goes down the exhausted path.
    await vi.waitFor(() => expect(h.storage.get(campaign.id)!.state).toBe("failed"), { timeout: 20_000 });
    const m1 = h.storage.get(campaign.id)!.milestones[0]!;
    expect(h.submitted).toHaveLength(2);
    expect(m1.scopeResubmits ?? 0).toBe(0);
  }, 60_000);

  it("W01's rule on a completed run: an outage under the machinery's own error takes the outage path", async () => {
    const h = build("on");
    const campaign = await start(h);
    // One node's bridge threw (the machinery's), another stopped on the provider's quota.
    completeSprint(h, {
      integrity: { terminalKeys: ["error", "provider_quota"], worst: "error", source: "spine", workerModels: [WORKER_MODEL], infrastructureErrors: 1 },
    });
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
    const m1 = h.storage.get(campaign.id)!.milestones[0]!;
    expect(m1.scopeVerdict).toBeUndefined(); // the outage path, never the judge
    expect(m1.scopeResubmits ?? 0).toBe(0);
    expect(m1.attempts).toBe(1);
  }, 60_000);

  it("W01's rule on a completed run: an error the worker's own run raised is red, not an uncharged resubmit", async () => {
    // Rows the worker's own model wrote, so no independent check proves the scope past the error.
    const h = build("on", { acceptanceAuthor: fakeAuthor({ writer: { provider: "worker", model: WORKER_MODEL, independence: "same-model" } }).author });
    const campaign = await start(h);
    // A node of the worker's run failed with no reason recorded: no infrastructure error is counted.
    completeSprint(h, {
      integrity: { terminalKeys: ["error", "done"], worst: "error", source: "spine", workerModels: [WORKER_MODEL] },
    });
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
    const m1 = h.storage.get(campaign.id)!.milestones[0]!;
    const terminal = m1.scopeVerdict?.reasons.find((r) => r.code === "terminal");
    expect(terminal?.reasonClass).toBe("red");
    expect(m1.scopeBounces).toBe(1);
    expect(m1.scopeResubmits ?? 0).toBe(0);
  }, 60_000);

  it("a tampered check is red, and the stored bytes are put back", async () => {
    const h = build("on", { failing: (label) => label === "EF-2" });
    const campaign = await start(h);
    completeSprint(h); // EF-2 fails: a free bounce, and the checks are now committed
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
    const file = h.storage.listAcceptance(campaign.id)[0]!;
    const abs = join(h.root, ...file.path.split("/"));
    expect(readFileSync(abs, "utf8")).toBe(file.source);
    writeFileSync(abs, file.source.replace("Assert.That(", "Assert.That(true || "));

    completeSprint(h);
    await vi.waitFor(() => expect(h.submitted).toHaveLength(3), { timeout: 20_000 });
    const m1 = h.storage.get(campaign.id)!.milestones[0]!;
    const tamper = m1.scopeVerdict?.reasons.find((r) => r.code === "tamper");
    expect(tamper?.reasonClass).toBe("red");
    expect(tamper?.detail).toMatch(/restored to the system's bytes/);
    expect(readFileSync(abs, "utf8")).toBe(file.source);
  }, 60_000);

  it("a worker file outside the folder that answers for a check is named as the worker's, not as a restored system file", async () => {
    const h = build("on");
    const campaign = await start(h);
    writeFileSync(join(h.root, "Assets", "Game", "Spoof.cs"), "namespace Strada.Acceptance.M1 { public class Spoof {} }\n");
    completeSprint(h);
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
    const m1 = h.storage.get(campaign.id)!.milestones[0]!;
    const tamper = m1.scopeVerdict?.reasons.filter((r) => r.code === "tamper") ?? [];
    expect(tamper).toHaveLength(1);
    expect(tamper[0]!.detail).toMatch(/outside Assets\/StradaAcceptance/);
    expect(tamper[0]!.detail).toContain("Assets/Game/Spoof.cs");
    expect(tamper[0]!.detail).not.toMatch(/restored to the system's bytes/);
  }, 60_000);

  it("a check fault calls the writer without charging; past its budget the milestone parks and the row is a check fault", async () => {
    const author = fakeAuthor({ faulted: (row) => (row.label === "EF-3" ? "the check asserts on a literal only" : undefined) });
    const h = build("on", { acceptanceAuthor: author.author });
    const campaign = await start(h);
    completeSprint(h);
    await vi.waitFor(() => expect(h.storage.get(campaign.id)!.currentMilestone).toBe(1), { timeout: 20_000 });
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
    const now = h.storage.get(campaign.id)!;
    const m1 = now.milestones[0]!;
    expect(author.write).toHaveBeenCalled();
    // Never bounced or charged for the system's own check: the one settle parked it,
    // and a park spends the attempt budget so the ladder's walk skips it.
    expect(h.submitted).toHaveLength(2);
    expect(m1.scopeBounces ?? 0).toBe(0);
    expect(m1.status).toBe("failed");
    expect(m1.attempts).toBe(2);
    expect(m1.parked?.reasons.some((r) => r.reasonClass === "check-fault" && r.rid === byLabel(now, "EF-3").rid)).toBe(true);
    expect(m1.parked?.queued).not.toContain(byLabel(now, "EF-3").rid);
    expect(byLabel(now, "EF-3").status).toBe("check-fault");
    expect(now.checkFaults ?? []).toContain(byLabel(now, "EF-3").rid);
  }, 60_000);

  it("a row the writer cannot observe gets one uncharged round naming what to expose, and is red after it", async () => {
    const author = fakeAuthor({ unbound: (row) => (row.label === "EF-1" ? "the pier the ferry is docked at" : undefined) });
    const h = build("on", { acceptanceAuthor: author.author });
    const campaign = await start(h);
    completeSprint(h);
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
    let m1 = h.storage.get(campaign.id)!.milestones[0]!;
    const unbound = m1.scopeVerdict?.reasons.find((r) => r.code === "row-unbound");
    expect(unbound?.reasonClass).toBe("unmeasurable");
    expect(unbound?.detail).toBe("the pier the ferry is docked at");
    expect(m1.attempts).toBe(1);
    expect(m1.scopeBounces ?? 0).toBe(0);
    expect(h.submitted[1]).toContain("expose: the pier the ferry is docked at");

    completeSprint(h);
    await vi.waitFor(() => expect(h.submitted).toHaveLength(3), { timeout: 20_000 });
    m1 = h.storage.get(campaign.id)!.milestones[0]!;
    expect(m1.scopeVerdict?.reasons.find((r) => r.code === "row-unbound")?.reasonClass).toBe("red");
    expect(m1.scopeBounces).toBe(1);
  }, 60_000);

  it("a campaign from before the gate gets its rows at its next settle, and the chat is told what was read", async () => {
    const h = build("on");
    const campaign = await start(h);
    // In flight before the gate: no rows, no owners.
    const before = h.storage.get(campaign.id)!;
    before.requirements = undefined;
    before.scopeGateSince = undefined;
    for (const m of before.milestones) m.requirementIds = undefined;
    h.storage.save(before);
    const told = h.messages.length;
    completeSprint(h);
    await vi.waitFor(() => expect(h.storage.get(campaign.id)!.currentMilestone).toBe(1), { timeout: 20_000 });
    expect(h.storage.get(campaign.id)!.requirements?.rows.length).toBeGreaterThan(0);
    expect(h.messages.slice(told).some((m) => m.startsWith("📋 GDD rows:"))).toBe(true);
  }, 60_000);

  it("a regression stays a regression after the run that found it, also on a row a parked milestone owns", async () => {
    let failing: (label: string) => boolean = (label) => label === "EF-2";
    const h = build("on", { failing: (label) => failing(label) });
    const campaign = await start(h);
    // m1 parks on EF-2; EF-1 and EF-3 passed, and m1 is not a proven green.
    for (let settle = 0; settle < 3; settle++) {
      completeSprint(h);
      await vi.waitFor(() => expect(h.submitted).toHaveLength(settle + 2), { timeout: 20_000 });
    }
    let now = h.storage.get(campaign.id)!;
    expect(now.milestones[0]!.parked).toBeDefined();
    expect(now.currentMilestone).toBe(1);
    // m2's work breaks EF-1, which had passed.
    failing = (label) => label === "EF-2" || label === "EF-1";
    completeSprint(h);
    await vi.waitFor(() => expect(h.submitted).toHaveLength(5), { timeout: 20_000 });
    now = h.storage.get(campaign.id)!;
    let m2 = now.milestones[1]!;
    const regressed = byLabel(now, "EF-1").rid;
    expect(m2.scopeVerdict?.reasons.some((r) => r.code === "regression" && r.rid === regressed)).toBe(true);
    // The queued row that never passed is not m2's to answer for.
    expect(m2.scopeVerdict?.reasons.some((r) => r.rid === byLabel(now, "EF-2").rid)).toBe(false);
    // Still broken on the next settle: still a regression, not a green that forgot it.
    completeSprint(h);
    await vi.waitFor(() => expect(h.submitted).toHaveLength(6), { timeout: 20_000 });
    now = h.storage.get(campaign.id)!;
    m2 = now.milestones[1]!;
    expect(now.currentMilestone).toBe(1);
    expect(m2.status).not.toBe("green");
    expect(m2.scopeVerdict?.reasons.some((r) => r.code === "regression" && r.rid === regressed)).toBe(true);
    expect(m2.scopeBounces).toBe(2);
  }, 90_000);
});

describe("the system repairs its own checks, never charged (W09)", () => {
  it("a check bound to something the game does not register is written again and measured again in the same settle", async () => {
    const author = fakeAuthor();
    const h = build("on", {
      acceptanceAuthor: author.author,
      failing: (label) => label === "EF-1" && (author.author.regenerate as ReturnType<typeof vi.fn>).mock.calls.length === 0,
      message: () => "[strada-acceptance:no-service] IFerryDock is not registered",
    });
    const campaign = await start(h);
    completeSprint(h);
    await vi.waitFor(() => expect(h.storage.get(campaign.id)!.currentMilestone).toBe(1), { timeout: 20_000 });
    const now = h.storage.get(campaign.id)!;
    const m1 = now.milestones[0]!;
    expect(author.author.regenerate).toHaveBeenCalledTimes(1);
    expect((author.author.regenerate as ReturnType<typeof vi.fn>).mock.calls[0]![0].label).toBe("EF-1");
    expect(m1.status).toBe("green");
    expect(m1.attempts).toBe(1);
    expect(m1.writerRepairs).toEqual({ compile: 0, rebinds: 1, disputes: 0 });
    // Two verdicts were not stored: the repaired one is the milestone's.
    expect(h.storage.listJudgements(campaign.id, "m1")).toHaveLength(1);
    const file = h.storage.listAcceptance(campaign.id).find((f) => f.milestoneId === "m1")!;
    expect(file.revisions).toBe(2);
    expect(file.tests.find((t) => t.rid === byLabel(now, "EF-1").rid)?.check?.body).toMatch(/repaired/);
    expect(byLabel(now, "EF-1").checks.filter((c) => c.kind === "test" && c.supersededAtMs !== undefined)).toHaveLength(1);
  }, 60_000);

  it("a worker's dispute of a failing check goes to its writer, and the revised check is what decides", async () => {
    const author = fakeAuthor();
    const h = build("on", {
      acceptanceAuthor: author.author,
      failing: (label) => label === "EF-2" && (author.author.revise as ReturnType<typeof vi.fn>).mock.calls.length === 0,
    });
    const campaign = await start(h);
    const testName = (): string => {
      const c = h.storage.get(campaign.id)!;
      const ref = byLabel(c, "EF-2").checks.find((x) => x.kind === "test");
      return ref?.kind === "test" ? ref.testName : "";
    };
    // The first settle writes the checks; EF-2 fails and the worker is sent back.
    completeSprint(h);
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
    expect(author.author.revise).not.toHaveBeenCalled();
    completeSprint(h, { result: `Built the boarding rule.\nACCEPTANCE DISPUTE ${testName()}: a rider may board from a pier being lit, the GDD says lit` });
    await vi.waitFor(() => expect(h.storage.get(campaign.id)!.currentMilestone).toBe(1), { timeout: 20_000 });
    expect(author.author.revise).toHaveBeenCalledTimes(1);
    const [row, , reason] = (author.author.revise as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(row.label).toBe("EF-2");
    expect(reason).toMatch(/a rider may board from a pier being lit/);
    const m1 = h.storage.get(campaign.id)!.milestones[0]!;
    expect(m1.status).toBe("green");
    expect(m1.writerRepairs?.disputes).toBe(1);
  }, 60_000);

  it("a file the system rewrote that no longer compiles is the system's fault: never charged, and its good siblings are not rebound", async () => {
    const author = fakeAuthor({ repaired: (row) => `global::NUnit.Framework.Assert.That(${DOES_NOT_COMPILE} != null, "${row.label ?? row.rid}");` });
    const h = build("on", {
      acceptanceAuthor: author.author,
      failing: (label) => label === "EF-2" && (author.author.revise as ReturnType<typeof vi.fn>).mock.calls.length === 0,
    });
    const campaign = await start(h);
    const testName = (): string => {
      const ref = byLabel(h.storage.get(campaign.id)!, "EF-2").checks.find((x) => x.kind === "test");
      return ref?.kind === "test" ? ref.testName : "";
    };
    // EF-2 fails on checks that compiled, EF-1 and EF-3 pass: one free bounce.
    completeSprint(h);
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
    let now = h.storage.get(campaign.id)!;
    expect(byLabel(now, "EF-1").last?.outcome).toBe("pass");
    expect(now.milestones[0]!.scopeBounces).toBe(1);
    // The worker disputes EF-2; the writer's revision of it does not compile,
    // and every check in the file it shares is left out of the next run.
    completeSprint(h, { result: `Built the boarding rule.\nACCEPTANCE DISPUTE ${testName()}: a rider may board from a pier being lit` });
    await vi.waitFor(() => expect(h.submitted).toHaveLength(3), { timeout: 40_000 });
    now = h.storage.get(campaign.id)!;
    const m1 = now.milestones[0]!;
    expect(author.author.revise).toHaveBeenCalledTimes(1);
    expect(m1.scopeVerdict?.green).toBe(false);
    // Nothing the worker did broke these bytes: no row is red, and nothing is charged.
    expect(m1.scopeVerdict?.reasons.filter((r) => r.reasonClass === "red")).toEqual([]);
    for (const label of ["EF-1", "EF-2", "EF-3"]) {
      expect(byLabel(now, label).last?.outcome, label).toBe("check-fault");
      expect(byLabel(now, label).last?.compiledBefore, label).toBe(false);
    }
    // A fault that survived its one repair parks the milestone for a person; the worker is not sent back for it.
    expect(m1.status).toBe("failed");
    expect(m1.parked?.reasons.filter((r) => r.reasonClass === "red")).toEqual([]);
    expect(m1.parked?.queued).toEqual([]);
    expect(byLabel(now, "EF-1").status).toBe("check-fault");
    expect(h.submitted[2]).not.toContain("THE MILESTONE IS NOT GREEN");
    // The checks that passed were not rebound to a surface that never changed.
    expect(author.author.rebind).not.toHaveBeenCalled();
  }, 60_000);

  it("the other direction: bytes that compiled and that the worker's change broke are rebound, and the rebound check decides", async () => {
    const author = fakeAuthor();
    const rebound = (): number => (author.author.rebind as ReturnType<typeof vi.fn>).mock.calls.length;
    let refactored = false;
    const h = build("on", {
      acceptanceAuthor: author.author,
      failing: (label) => label === "EF-2" && !refactored,
      workerBroke: () => refactored && rebound() === 0,
    });
    const campaign = await start(h);
    completeSprint(h);
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
    const bytes = h.storage.listAcceptance(campaign.id)[0]!.sha256;
    // The worker's refactor removes what the unchanged checks name.
    refactored = true;
    completeSprint(h);
    await vi.waitFor(() => expect(h.storage.get(campaign.id)!.currentMilestone).toBe(1), { timeout: 40_000 });
    const m1 = h.storage.get(campaign.id)!.milestones[0]!;
    expect(rebound()).toBeGreaterThan(0);
    expect(author.author.repairCompile).not.toHaveBeenCalled();
    expect(h.storage.listAcceptance(campaign.id)[0]!.sha256).not.toBe(bytes);
    expect(m1.status).toBe("green");
    expect(m1.attempts).toBe(1);
  }, 60_000);
});

describe("the final milestone (scope gate on, W09)", () => {
  const ONE_RUNG = { milestones: [{ title: "Sprint A — Everything", prompt: "build the ferry game", coveredSections: ["Core Rules", "Screens"] }] };

  /** Spend the final milestone's delivery bounces so the gate decides on this settle. */
  const atTheGate = (h: Harness, id: string, fields: Partial<Campaign["milestones"][number]> = {}): void => {
    const c = h.storage.get(id)!;
    Object.assign(c.milestones[c.currentMilestone]!, { deliveryVerificationBounces: 2, sceneHygieneBounces: 2, visualMismatchBounces: 1, ...fields });
    h.storage.save(c);
  };

  it("results are bound to the revision the gate's closure reads, and no system commit lands between the run and the gate", async () => {
    const h = build("on", { ladder: ONE_RUNG });
    const campaign = await start(h);
    atTheGate(h, campaign.id);
    completeSprint(h);
    await vi.waitFor(() => expect(h.storage.get(campaign.id)!.state).toBe("failed"), { timeout: 30_000 });
    const c = h.storage.get(campaign.id)!;
    const m1 = c.milestones[0]!;
    expect(m1.scopeVerdict?.green).toBe(true);
    expect(m1.status).toBe("green");
    const head = gitIn(h.root, "rev-parse", "HEAD").trim();
    for (const row of c.requirements!.rows.filter((r) => r.owner === "m1")) expect(row.last?.revision).toBe(head);
    // Every row passed on the revision the closure reads: none is held as unclosed.
    expect((m1.deliveryProofsMissing ?? []).join(" | ")).not.toMatch(/GDD requirement\(s\) no sprint closed/);
    expect((m1.deliveryProofsMissing ?? []).join(" | ")).not.toMatch(/GDD row\(s\) not passing/);
    expect(c.lastError).toMatch(/NOT DELIVERED|delivery proofs still missing/);
  }, 60_000);

  it("a check the system repairs at the final milestone is its own commit, and the gate does not read it as the tree moving under its proofs", async () => {
    const author = fakeAuthor();
    const h = build("on", {
      ladder: ONE_RUNG,
      acceptanceAuthor: author.author,
      failing: (label) => label === "EF-1" && (author.author.regenerate as ReturnType<typeof vi.fn>).mock.calls.length === 0,
      message: () => "[strada-acceptance:no-service] IFerryDock is not registered",
    });
    const campaign = await start(h);
    atTheGate(h, campaign.id);
    completeSprint(h);
    await vi.waitFor(() => expect(h.storage.get(campaign.id)!.state).toBe("failed"), { timeout: 30_000 });
    const c = h.storage.get(campaign.id)!;
    const m1 = c.milestones[0]!;
    // The repair landed between the gate's first read and its last.
    expect(author.author.regenerate).toHaveBeenCalledTimes(1);
    expect(gitIn(h.root, "log", "--format=%s").match(/campaign: acceptance checks for m1 \(system-owned\)/g)).toHaveLength(2);
    expect(m1.scopeVerdict?.green).toBe(true);
    const proofs = (m1.deliveryProofsMissing ?? []).join(" | ");
    expect(proofs).not.toMatch(/the project changed while its proofs were being read/);
    expect(proofs).not.toMatch(/GDD requirement\(s\) no sprint closed/);
    expect(m1.deliveryFailureKinds ?? []).not.toContain("treeMoved");
    const head = gitIn(h.root, "rev-parse", "HEAD").trim();
    for (const row of c.requirements!.rows.filter((r) => r.owner === "m1")) expect(row.last?.revision).toBe(head);
  }, 60_000);

  it("…while a publication that lands in the same window is still the tree moving under the proofs", async () => {
    const author = fakeAuthor();
    let root = "";
    let published = false;
    const h = build("on", {
      ladder: ONE_RUNG,
      acceptanceAuthor: author.author,
      failing: (label) => label === "EF-1" && (author.author.regenerate as ReturnType<typeof vi.fn>).mock.calls.length === 0,
      message: () => "[strada-acceptance:no-service] IFerryDock is not registered",
      // A worker's lease publishes into the project while the compile is read.
      verifyCompile: async () => {
        if (!published && root !== "") {
          published = true;
          writeFileSync(join(root, "Assets", "Game", "Late.cs"), "public class Late {}\n");
          gitIn(root, "add", "-A", "--", "Assets/Game");
          gitIn(root, "commit", "-qm", "worker: late publication");
        }
        return { ok: true, ran: true, errors: 0, detail: "compiles" };
      },
    });
    root = h.root;
    const campaign = await start(h);
    atTheGate(h, campaign.id);
    completeSprint(h);
    await vi.waitFor(() => expect(h.storage.get(campaign.id)!.state).toBe("failed"), { timeout: 30_000 });
    const m1 = h.storage.get(campaign.id)!.milestones[0]!;
    expect(published).toBe(true);
    expect(author.author.regenerate).toHaveBeenCalledTimes(1);
    expect((m1.deliveryProofsMissing ?? []).join(" | ")).toMatch(/the project changed while its proofs were being read/);
  }, 60_000);

  it("a project without git binds results to its content fingerprint — the revision closure reads there — so passing rows close", async () => {
    const h = build("on", { ladder: ONE_RUNG, git: false });
    const campaign = await start(h);
    atTheGate(h, campaign.id);
    completeSprint(h);
    await vi.waitFor(() => expect(h.storage.get(campaign.id)!.state).toBe("failed"), { timeout: 30_000 });
    const c = h.storage.get(campaign.id)!;
    const m1 = c.milestones[0]!;
    expect(m1.scopeVerdict?.green).toBe(true);
    const revisions = new Set(c.requirements!.rows.filter((r) => r.owner === "m1").map((r) => r.last?.revision));
    expect(revisions.size).toBe(1);
    const [revision] = [...revisions];
    expect(revision).toMatch(/\S/);
    expect((m1.deliveryProofsMissing ?? []).join(" | ")).not.toMatch(/GDD requirement\(s\) no sprint closed/);
  }, 60_000);

  it("a park at the last milestone falls through to the delivery gate, which names the failing rows", async () => {
    const h = build("on", { ladder: ONE_RUNG, failing: (label) => label === "EF-2" });
    const campaign = await start(h);
    const rid = byLabel(h.storage.get(campaign.id)!, "EF-2").rid;
    // The milestone's scope bounces are spent, and so is the row's repair budget.
    const c0 = h.storage.get(campaign.id)!;
    const spent = (n: number) => ({
      id: `mcov${n}-${n}`,
      title: `Coverage completion ${n}.1 — boarding`,
      prompt: "- EF-2",
      status: "failed" as const,
      attempts: 2,
      requirementIds: [rid],
    });
    c0.milestones.unshift(spent(1), spent(2));
    c0.currentMilestone = 2;
    h.storage.save(c0);
    atTheGate(h, campaign.id, { scopeBounces: 2 });
    completeSprint(h);
    await vi.waitFor(() => expect(h.storage.get(campaign.id)!.state).toBe("failed"), { timeout: 30_000 });
    const c = h.storage.get(campaign.id)!;
    const m1 = c.milestones[2]!;
    expect(m1.parked?.queued).toEqual([rid]);
    expect(m1.status).toBe("failed");
    const proofs = (m1.deliveryProofsMissing ?? []).join(" | ");
    expect(proofs).toMatch(/1 GDD row\(s\) not passing on [0-9a-f]{8}: EF-2/);
    expect(m1.deliveryFailureKinds).toContain("scopeRowsFailing");
    expect(c.lastError).toMatch(/NOT DELIVERED|delivery proofs still missing/);
  }, 60_000);
});

describe("partial delivery (scope gate on, W09)", () => {
  it("a parked milestone counts as settled: a spent coverage sprint leads to the final proof sprint, not a stop", async () => {
    const h = build("on");
    const campaign = await start(h);
    const stored = h.storage.get(campaign.id)!;
    const [m1, m2, m3] = stored.milestones;
    Object.assign(m1!, { status: "failed", attempts: 2, parked: { atMs: Date.now(), reasons: [], queued: [] } });
    Object.assign(m2!, { status: "green" });
    Object.assign(m3!, { status: "green" });
    h.tasks.set("task_mcov", { id: "task_mcov", status: "executing", createdAt: Date.now(), updatedAt: Date.now() });
    stored.milestones.push({ id: "mcov1", title: "Coverage completion 1.1 — dock menu", prompt: "- The dock menu must show a Launch button.", status: "running", attempts: 2, taskId: "task_mcov" });
    stored.currentMilestone = 3;
    stored.pendingCoverageGaps = undefined;
    h.storage.save(stored);
    completeSprint(h, { status: "failed", error: "still no Launch button", result: "still no Launch button", key: "max_steps_reached" });
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
    const now = h.storage.get(campaign.id)!;
    expect(now.state).toBe("executing");
    expect(now.milestones.at(-1)!.id).toMatch(/^mfinal/);
    expect(now.currentMilestone).toBe(now.milestones.length - 1);
    expect(h.submitted[1]).toContain("FINAL DELIVERY PROOFS");
  }, 60_000);
});

describe("a check the independent review called weak (scope gate on, W09 + W13)", () => {
  const ONE_RUNG = { milestones: [{ title: "Sprint A — Everything", prompt: "build the ferry game", coveredSections: ["Core Rules", "Screens"] }] };
  const reviewText = (weakChecks: Array<{ rid: string; why: string }>): string =>
    ["VERDICT: NOT DELIVERABLE", "BLOCKERS: 1. a weak check", JSON.stringify({ weakChecks, missing: [] })].join("\n");

  /** The delivery decision was taken this round: delivered, or held with the final sprint's resumption armed. */
  const settledRound = (h: Harness, id: string): boolean => {
    const c = h.storage.get(id)!;
    return c.state === "done" || (c.state === "failed" && c.autoReviveAt !== undefined);
  };

  /** Every delivery proof but the scope gate's own stands: the suite, the play-through, the build, the player and the GDD on disk. */
  const deliveryProofsStand = (h: Harness): void => {
    Object.assign(h.manager as unknown as Record<string, unknown>, {
      measureDeliverySuite: async () => ({
        run: {
          found: true,
          total: 4,
          passed: 4,
          failed: 0,
          skipped: 0,
          green: true,
          unfiltered: true,
          failedNames: [],
          measuredAt: new Date().toISOString(),
          detail: "PlayMode verification passed: 4 of 4 tests passed (unfiltered — the whole PlayMode suite)",
        },
      }),
      measurePlaythrough: () => ({ found: true, ok: true, reasons: [], actions: 12, frames: { count: 5, flat: 0, maxMotionShare: 0.3 } }),
      measureBuild: async () => ({ ran: true, ok: true, target: "StandaloneOSX", artifactPath: join(h.root, "Builds", "Ferry.app"), sizeBytes: 1_000_000, durationMs: 1_000, scenes: 1 }),
      measurePlayerRun: async () => ({ found: true, ok: true, reasons: [] }),
      measureGddClaims: () => ({ lines: [] }),
      gddDriftOf: () => undefined,
      measureDeliveryStructure: () => ({ lines: [] }),
    });
  };

  it("holds delivery naming the row, is asked once a round, and the next settle replaces the check once — its writer told why — and delivers", async () => {
    const author = fakeAuthor();
    const why = "it asserts that a view exists, not that a rider boards only from a lit pier";
    const prompts: string[] = [];
    let weakRid = "";
    const h = build("on", {
      ladder: ONE_RUNG,
      acceptanceAuthor: author.author,
      deliveryResumeDelayMs: 50,
      independentReviewer: async ({ prompt }) => {
        prompts.push(prompt);
        return { ok: true, model: "reviewer-model", text: reviewText(prompts.length === 1 ? [{ rid: weakRid, why }] : []), ms: 1 };
      },
    });
    deliveryProofsStand(h);
    const campaign = await start(h);
    weakRid = byLabel(h.storage.get(campaign.id)!, "EF-2").rid;
    completeSprint(h);
    // Round one: every other proof stands, the review reopens EF-2, and delivery is held on it.
    await vi.waitFor(() => expect(settledRound(h, campaign.id)).toBe(true), { timeout: 30_000 });
    let c = h.storage.get(campaign.id)!;
    let m1 = c.milestones[0]!;
    expect(c.state).toBe("failed");
    expect(prompts).toHaveLength(1);
    const proofs = (m1.deliveryProofsMissing ?? []).join(" | ");
    expect(proofs).toMatch(/the independent review reopened 1 GDD row\(s\) whose check it found weak \(EF-2 \(§2\)\)/);
    expect(m1.deliveryFailureKinds).toContain("reviewReopened");
    expect(c.lastError).toContain("EF-2");
    const retired = byLabel(c, "EF-2").checks.find((x) => x.kind === "test" && x.weak !== undefined);
    expect(retired?.kind === "test" ? retired.supersededAtMs : undefined).toBeDefined();
    // The final milestone carries the row, so no coverage sprint is queued for it.
    expect(c.pendingCoverageGaps ?? []).toEqual([]);

    // Round two: the campaign resumes the final sprint by itself; its settle writes the one replacement.
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
    completeSprint(h);
    await vi.waitFor(() => expect(h.storage.get(campaign.id)!.state).toBe("done"), { timeout: 30_000 });
    c = h.storage.get(campaign.id)!;
    m1 = c.milestones[0]!;
    expect(author.author.regenerate).toHaveBeenCalledTimes(1);
    const [row, problems] = (author.author.regenerate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(row.label).toBe("EF-2");
    expect(problems).toEqual([why]);
    expect(author.write).toHaveBeenCalledTimes(1);
    const file = h.storage.listAcceptance(campaign.id).find((f) => f.milestoneId === "m1")!;
    const tests = file.tests.filter((t) => t.rid === weakRid);
    expect(tests).toHaveLength(1);
    expect(tests[0]!.check?.body).toMatch(/repaired/);
    expect(byLabel(c, "EF-2").last?.outcome).toBe("pass");
    expect(m1.scopeVerdict?.green).toBe(true);
    expect(prompts).toHaveLength(2);
  }, 90_000);

  it("a weak check on a row an earlier milestone owns is queued for a coverage sprint", async () => {
    const prompts: string[] = [];
    let weakRid = "";
    const h = build("on", {
      independentReviewer: async ({ prompt }) => {
        prompts.push(prompt);
        return { ok: true, model: "reviewer-model", text: reviewText([{ rid: weakRid, why: "it asserts a literal" }]), ms: 1 };
      },
    });
    deliveryProofsStand(h);
    const campaign = await start(h);
    weakRid = byLabel(h.storage.get(campaign.id)!, "EF-2").rid;
    for (let sprint = 0; sprint < 3; sprint++) {
      completeSprint(h);
      if (sprint < 2) await vi.waitFor(() => expect(h.submitted).toHaveLength(sprint + 2), { timeout: 20_000 });
    }
    await vi.waitFor(() => expect(settledRound(h, campaign.id)).toBe(true), { timeout: 30_000 });
    const c = h.storage.get(campaign.id)!;
    expect(c.state).toBe("failed");
    expect(prompts).toHaveLength(1);
    expect((c.milestones.at(-1)!.deliveryProofsMissing ?? []).join(" | ")).toMatch(/reopened 1 GDD row\(s\) whose check it found weak \(EF-2/);
    const queued = (c.pendingCoverageGaps ?? []).map((g) => decodeRequirement(g).identity?.id);
    expect(queued).toEqual([weakRid]);
  }, 90_000);

  it("the settle writes the replacement with the reviewer's reason, and a retired test leaves its file even when no replacement is written yet", async () => {
    const author = fakeAuthor();
    const regenerated: Array<{ label: string | undefined; problems: readonly string[] }> = [];
    author.author.regenerate = vi.fn(async (row: RequirementRow, problems: readonly string[]): Promise<AcceptanceWriteResult> => {
      regenerated.push({ label: row.label, problems });
      return row.label === "EF-2"
        ? { checks: [], unbound: [{ rid: row.rid, missingObservable: "the pier a rider boards from" }], faulted: [], writer: WRITER, calls: 1 }
        : { checks: [{ rid: row.rid, body: `global::NUnit.Framework.Assert.That(PlaythroughView != null, "${row.label} replaced");` }], unbound: [], faulted: [], writer: WRITER, calls: 1 };
    });
    let settles = 0;
    const h = build("on", { acceptanceAuthor: author.author, failing: (label) => label === "EF-1" && settles === 1 });
    const campaign = await start(h);
    settles = 1;
    completeSprint(h);
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
    // The review's shape, applied by its own function: EF-2 and EF-3 retired as weak.
    const stored = h.storage.get(campaign.id)!;
    const ef2 = byLabel(stored, "EF-2");
    const ef3 = byLabel(stored, "EF-3");
    const oldName = (r: RequirementRow): string => (r.checks.find((x) => x.kind === "test") as { testName: string }).testName;
    stored.requirements = applyReviewFindings(
      stored.requirements!,
      { found: true, weakChecks: [{ rid: ef2.rid, why: "EF-2 asserts a literal" }, { rid: ef3.rid, why: "EF-3 asserts a literal" }], missing: [], unreadable: [] },
      { gddText: stored.gddText, atMs: Date.now() },
    ).ledger;
    h.storage.save(stored);
    expect(h.storage.listAcceptance(campaign.id)[0]!.source).toContain(oldName(ef2).split(".").at(-1)!);

    settles = 2;
    completeSprint(h);
    await vi.waitFor(() => expect(h.submitted).toHaveLength(3), { timeout: 20_000 });
    expect(regenerated).toEqual([
      { label: "EF-2", problems: ["EF-2 asserts a literal"] },
      { label: "EF-3", problems: ["EF-3 asserts a literal"] },
    ]);
    expect(author.write).toHaveBeenCalledTimes(1);
    const file = h.storage.listAcceptance(campaign.id).find((f) => f.milestoneId === "m1")!;
    const now = h.storage.get(campaign.id)!;
    expect(file.tests.map((t) => t.rid).sort()).toEqual([byLabel(now, "EF-1").rid, ef3.rid].sort());
    expect(file.source).not.toContain(oldName(ef2).split(".").at(-1)!);
    expect(file.source).toContain("EF-3 replaced");
    // EF-2 has no check now, and the worker is asked once to expose what its writer could not observe.
    expect(now.milestones[0]!.scopeVerdict?.reasons.find((r) => r.rid === ef2.rid)?.code).toBe("row-unbound");
  }, 60_000);
});

describe("shadow records and decides nothing (W09)", () => {
  it("the same settles make the same decisions as off, with a verdict recorded and the checks taken back out of the project", async () => {
    const decisions = async (mode: ScopeGateMode) => {
      const h = build(mode, { failing: (label) => label === "EF-2" });
      const campaign = await start(h);
      completeSprint(h, { key: "task_stuck", result: "Sprint done." });
      await vi.waitFor(() => expect(h.storage.get(campaign.id)!.currentMilestone).toBe(1), { timeout: 20_000 });
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
      const c = h.storage.get(campaign.id)!;
      return { h, c, view: c.milestones.map((m) => ({ id: m.id, status: m.status, attempts: m.attempts })), state: c.state, submissions: h.submitted.length };
    };
    const off = await decisions("off");
    const shadow = await decisions("shadow");
    expect(shadow.view).toEqual(off.view);
    expect(shadow.state).toBe(off.state);
    expect(shadow.submissions).toBe(off.submissions);
    // Off read nothing; shadow judged, recorded, and committed nothing.
    expect(off.c.milestones[0]!.scopeVerdict).toBeUndefined();
    expect(off.h.storage.listJudgements(off.c.id)).toHaveLength(0);
    expect(shadow.c.milestones[0]!.scopeVerdict?.mode).toBe("shadow");
    expect(shadow.c.milestones[0]!.scopeVerdict?.green).toBe(false);
    expect(shadow.h.storage.listJudgements(shadow.c.id)).toHaveLength(1);
    expect(gitIn(shadow.h.root, "log", "--format=%s")).not.toMatch(/acceptance checks/);
    expect(existsSync(join(shadow.h.root, ...ACCEPTANCE_DIR.split("/")))).toBe(false);
    expect(shadow.h.runnerCalls.length).toBeGreaterThan(0);
  }, 90_000);
});

describe("off is today's path (W09)", () => {
  it("off calls no writer and no runner, writes no verdict, and settles a stuck completion as before", async () => {
    const author = fakeAuthor();
    const runnerCalls: string[] = [];
    const h = build("off", { acceptanceAuthor: author.author, runnerCalls });
    const campaign = await start(h);
    completeSprint(h, { key: "task_stuck" });
    await vi.waitFor(() => expect(h.storage.get(campaign.id)!.currentMilestone).toBe(1), { timeout: 20_000 });
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
    expect(author.write).not.toHaveBeenCalled();
    expect(runnerCalls).toHaveLength(0);
    const c = h.storage.get(campaign.id)!;
    expect(c.requirements).toBeUndefined();
    expect(c.milestones[0]!.status).toBe("green");
    expect(c.milestones[0]!.scopeVerdict).toBeUndefined();
  }, 60_000);
});

describe("the time box (scope gate on, W09)", () => {
  it("splits the open rows: half stay, in GDD order, the rest move to a split sprint, and the directive names the kept rows", async () => {
    const h = build("on", { milestoneTimeBoxMs: 60_000, failing: () => true });
    const campaign = await start(h);
    // The milestone has run past its box.
    const stored = h.storage.get(campaign.id)!;
    stored.milestones[0]!.startedAtMs = Date.now() - 2 * 3_600_000;
    h.storage.save(stored);
    completeSprint(h, { status: "failed", error: "ran out of steps", result: "ran out of steps", key: "max_steps_reached" });
    await vi.waitFor(() => expect(h.storage.get(campaign.id)!.milestones.some((m) => m.id === "m1-tb1")).toBe(true), { timeout: 20_000 });
    const now = h.storage.get(campaign.id)!;
    const m1 = now.milestones[0]!;
    const split = now.milestones[1]!;
    expect(split.id).toBe("m1-tb1");
    expect(split.timeBoxSplitFrom).toBe("m1");
    const owned = (id: string) => now.requirements!.rows.filter((r) => r.owner === id).map((r) => r.label);
    // Three open rows: two stay (⌈3/2⌉), one moves.
    expect(owned("m1")).toEqual(["EF-1", "EF-2"]);
    expect(owned("m1-tb1")).toEqual(["EF-3"]);
    expect(byLabel(now, "EF-3").ownership.at(-1)?.reason).toBe("time-box-split");
    expect(m1.prompt).toContain("EF-1");
    expect(m1.prompt).toContain("EF-2");
    expect(m1.prompt).not.toMatch(/report precisely what remains/);
    expect(m1.prompt).toContain("time-box split 1");
  }, 60_000);

  it("a third overrun parks a milestone that owns rows instead of stopping the campaign, and the ladder moves on", async () => {
    const h = build("on", { milestoneTimeBoxMs: 60_000, failing: (label) => label === "EF-2" });
    const campaign = await start(h);
    const stored = h.storage.get(campaign.id)!;
    // Past two narrowings already, with no attempt left.
    Object.assign(stored.milestones[0]!, { startedAtMs: Date.now() - 5 * 3_600_000, timeBoxEscalations: 2, attempts: 2 });
    h.storage.save(stored);
    completeSprint(h, { status: "failed", error: "ran out of steps", result: "ran out of steps", key: "max_steps_reached" });
    await vi.waitFor(() => expect(h.submitted).toHaveLength(2), { timeout: 20_000 });
    const now = h.storage.get(campaign.id)!;
    const m1 = now.milestones[0]!;
    expect(now.state).toBe("executing");
    expect(now.currentMilestone).toBe(1);
    expect(m1.status).toBe("failed");
    expect(m1.parked?.queued.length).toBe(3);
    const queued = (now.pendingCoverageGaps ?? []).map((g) => decodeRequirement(g).identity?.id).sort();
    expect(queued).toEqual(["EF-1", "EF-2", "EF-3"].map((label) => byLabel(now, label).rid).sort());
    expect(h.messages.some((m) => m.includes("PARKED") && m.includes("time box"))).toBe(true);
  }, 60_000);

  it("never splits the last planned milestone into one after it: its rows stay, half of them first", async () => {
    const ONE_RUNG = { milestones: [{ title: "Sprint A — Everything", prompt: "build the ferry game", coveredSections: ["Core Rules", "Screens"] }] };
    const h = build("on", { ladder: ONE_RUNG, milestoneTimeBoxMs: 60_000, failing: () => true });
    const campaign = await start(h);
    const stored = h.storage.get(campaign.id)!;
    stored.milestones[0]!.startedAtMs = Date.now() - 2 * 3_600_000;
    h.storage.save(stored);
    completeSprint(h, { status: "failed", error: "ran out of steps", result: "ran out of steps", key: "max_steps_reached" });
    await vi.waitFor(() => expect(h.storage.get(campaign.id)!.milestones[0]!.timeBoxEscalations).toBe(1), { timeout: 20_000 });
    const now = h.storage.get(campaign.id)!;
    const m1 = now.milestones[0]!;
    // Still the delivery sprint: nothing was inserted after it, and it owns every row it owned.
    expect(now.milestones.map((m) => m.id)).toEqual(["m1"]);
    const owned = now.requirements!.rows.filter((r) => r.owner === "m1");
    expect(owned.length).toBeGreaterThan(2);
    expect(m1.prompt).toContain("EF-1");
    expect(m1.prompt).toMatch(/stay with this sprint/);
    expect(m1.prompt).not.toMatch(/report precisely what remains/);
    expect(m1.prompt).not.toMatch(/time-box split/);
  }, 60_000);
});

describe("the final milestone's missing proofs (W09)", () => {
  it("the check-fault wording revives twice and then asks a person", () => {
    expect(UNMEASURABLE_PROOF_RE.test("system-written acceptance checks could not be made to work for 2 row(s), so a person decides")).toBe(true);
    expect(UNMEASURABLE_PROOF_RE.test("the acceptance run was not admitted: no acceptance runner is configured")).toBe(true);
    expect(UNMEASURABLE_PROOF_RE.test("2 GDD row(s) not passing on abcdef12: EF-1")).toBe(false);
  });
});

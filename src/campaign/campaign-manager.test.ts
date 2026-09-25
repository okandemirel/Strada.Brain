import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SYSTEM_INTERRUPTION_MARKER } from "../tasks/interruption.js";
import { extractLookDescription } from "./visual-conformance.js";
import { FILE_MTIME_TOLERANCE_MS } from "./file-freshness.js";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, statSync, symlinkSync, chmodSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { execSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EvidenceLedger, artifactDigest } from "./evidence-ledger.js";
import { DELIVERY_PIECE_ORDER, DeliveryPackageStore, assembleDeliveryPackage } from "./delivery-package.js";
import { ProducerFailure } from "./producer-failure.js";
import { requirementKey, CampaignManager, stripTimeBoxDirectives, UNMEASURABLE_PROOF_RE, UNRUNNABLE_HERE_RE, hasUnmeasurableProof, proofsSpanTwoRevisions } from "./campaign-manager.js";
import { CampaignStorage } from "./campaign-storage.js";
import { encodeRequirement } from "./requirement-identity.js";
import { describeBuild } from "./campaign-status.js";
import type { CampaignPlanner } from "./campaign-planner.js";
import { GDD_AUDIT_FULL_CHARS } from "./campaign-planner.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { IncomingMessage } from "../channels/channel-messages.interface.js";
import type { Task } from "../tasks/types.js";
import { TaskStatus } from "../tasks/types.js";

/** The sprint "ran unity_playthrough before reporting": the suite refreshes the verdict on every completion. */
let onTaskCompleted: (() => void) | undefined;
/** The NUnit record a settling sprint leaves behind; undefined = it ran no suite. */
let runRecordOnSettle: Record<string, unknown> | undefined;
/**
 * The campaign's own run of the whole suite at the final sprint (CMP-8): the
 * harness answers with the record a settling sprint would leave, stamped with
 * the run id the campaign issued for this run.
 */
const suiteRunner = async (root: string, runId: string): Promise<void> => {
  if (!runRecordOnSettle) return;
  mkdirSync(join(root, "Recordings", "tests"), { recursive: true });
  const record: Record<string, unknown> = { measuredAt: new Date().toISOString(), ...runRecordOnSettle, runId };
  if (record.measuredAt === null) delete record.measuredAt;
  writeFileSync(join(root, "Recordings", "tests", "playmode-last.json"), JSON.stringify(record));
};
/** Real git checkouts a test made, cleaned up with the fixture. */
const repos: string[] = [];

class FakeTaskManager extends EventEmitter {
  submitted: Array<{ prompt: string; chatId: string }> = [];
  resumed: string[] = [];
  private counter = 0;
  private statuses = new Map<string, TaskStatus>();
  private parents = new Map<string, string>();
  private results = new Map<string, string>();

  submit(chatId: string, _channelType: string, prompt: string, opts?: { parentId?: string }): Task {
    this.counter += 1;
    const id = `task_${this.counter}`;
    this.submitted.push({ chatId, prompt });
    this.prompts.set(id, prompt);
    this.statuses.set(id, TaskStatus.executing);
    this.createdAts.set(id, Date.now());
    // Production links a retry to its parent, so the LINEAGE ROOT stays the
    // first attempt; the fake dropped the fourth argument and every task was
    // its own root, which made freshness look per-attempt for free (Codex
    // 2026-09-11, Q2 step 2).
    if (opts?.parentId) this.parents.set(id, opts.parentId);
    return { id, chatId, status: TaskStatus.executing } as unknown as Task;
  }

  private prompts = new Map<string, string>();

  findLineageRootId(taskId: string): string | null {
    let current = taskId;
    for (let depth = 0; depth < 50; depth++) {
      const parent = this.parents.get(current);
      if (!parent) break;
      current = parent;
    }
    return current === taskId ? null : current;
  }

  /** The real manager lists a chat's recent tasks; the sweep needs prompts. */
  listTasks(chatId: string, limit = 10): Array<{ id: string; status: string; chatId: string; prompt: string }> {
    return [...this.statuses.entries()]
      .slice(-limit)
      .map(([id, status]) => ({ id, status: String(status), chatId, prompt: this.prompts.get(id) ?? "" }));
  }

  createdAts = new Map<string, number>();
  updatedAts = new Map<string, number>();

  verifications = new Map<string, { testsGreen?: boolean; detail: string; unfiltered?: boolean }>();

  getStatus(taskId: string): Task | null {
    const status = this.statuses.get(taskId);
    return status
      ? ({
          id: taskId,
          status,
          result: this.results.get(taskId),
          createdAt: this.createdAts.get(taskId) ?? Date.now(),
          updatedAt: this.updatedAts.get(taskId) ?? Date.now(),
          verification: this.verifications.get(taskId),
          // The real store persists cancel_reason and every reader of a
          // cancelled task asks for it; a fake that dropped it made a
          // supersession look like a person's stop order.
          ...(this.parents.has(taskId) ? { parentId: this.parents.get(taskId) } : {}),
          ...(this.cancelReasons.has(taskId) ? { cancelReason: this.cancelReasons.get(taskId) } : {}),
        } as unknown as Task)
      : null;
  }

  cancelled: string[] = [];
  cancelReasons = new Map<string, string | undefined>();
  cancel(taskId: string, opts?: { reason?: string }): void {
    // The real manager refuses a terminal row, EXCEPT to withdraw a
    // supersession when a person cancels deliberately (Codex 2026-09-11 J#3).
    // A fake that overwrote a person's stop with the campaign's own
    // supersession hid exactly that (J#7).
    const current = this.statuses.get(taskId);
    const terminal = current === TaskStatus.completed || current === TaskStatus.failed || current === TaskStatus.cancelled;
    if (terminal) {
      if (current === TaskStatus.cancelled && this.cancelReasons.get(taskId) === "superseded" && opts?.reason === "user") {
        this.cancelReasons.set(taskId, "user");
        this.cancelled.push(taskId);
      }
      return;
    }
    this.cancelled.push(taskId);
    this.cancelReasons.set(taskId, opts?.reason);
    this.statuses.set(taskId, TaskStatus.cancelled);
  }

  markTerminal(taskId: string, status: TaskStatus, result?: string): void {
    this.statuses.set(taskId, status);
    if (result !== undefined) this.results.set(taskId, result);
  }

  /** Simulate the executor's keep-alive minting a retry under a new id. */
  setStatus(taskId: string, status: TaskStatus): void {
    this.statuses.set(taskId, status);
  }

  addRetry(parentId: string, status: TaskStatus = TaskStatus.executing): string {
    this.counter += 1;
    const id = `task_${this.counter}`;
    this.statuses.set(id, status);
    this.parents.set(id, parentId);
    // A retry replays the mission, so it carries the parent's prompt — the
    // identity the terminal-campaign sweep matches on.
    const inherited = this.prompts.get(parentId);
    if (inherited) this.prompts.set(id, inherited);
    return id;
  }

  isInLineage(rootId: string, taskId: string): boolean {
    let current: string | undefined = taskId;
    while (current) {
      if (current === rootId) return true;
      current = this.parents.get(current);
    }
    return false;
  }

  /**
   * A deliberate stop ANYWHERE in the lineage tree, as the real store's
   * recursive query does — siblings included (Codex 2026-09-11 L#2).
   */
  lineageHasDeliberateStop(taskId: string): boolean {
    const root = this.findLineageRootId(taskId) ?? taskId;
    for (const [id, status] of this.statuses) {
      if (String(status) !== "cancelled") continue;
      if (this.cancelReasons.get(id) !== "user") continue;
      if (id === root || this.isInLineage(root, id)) return true;
    }
    return false;
  }

  /** Every unfinished task of the lineage, as the real store's query does. */
  listLiveInLineage(taskId: string): Array<{ id: string }> {
    const root = this.findLineageRootId(taskId) ?? taskId;
    const out: Array<{ id: string }> = [];
    for (const [id, status] of this.statuses) {
      if (["completed", "cancelled", "failed"].includes(String(status))) continue;
      if (id === root || this.isInLineage(root, id)) out.push({ id });
    }
    return out;
  }

  findLatestLineageTask(rootId: string): Task | null {
    let latest = rootId;
    for (const [child, parent] of this.parents) {
      if (this.isInLineage(rootId, parent) || parent === rootId) latest = child;
    }
    return this.getStatus(latest);
  }

  priorProgressSummary(taskId: string): string {
    return this.progressBlocks.get(taskId) ?? "";
  }
  progressBlocks = new Map<string, string>();

  findLineageRootId(taskId: string): string {
    let current = taskId;
    while (this.parents.has(current)) current = this.parents.get(current)!;
    return current;
  }

  resumeTask(taskId: string): Task | null {
    this.resumed.push(taskId);
    return this.submit("cli-local", "cli", `resumed:${taskId}`);
  }

  /** Keep the stored status in sync with emitted lifecycle events, as the real manager does. */
  override emit(event: string, ...args: unknown[]): boolean {
    const taskId = args[0] as string;
    if (event === "task:failed") this.statuses.set(taskId, TaskStatus.failed);
    if (event === "task:blocked") this.statuses.set(taskId, TaskStatus.blocked);
    if (event === "task:cancelled") this.statuses.set(taskId, TaskStatus.cancelled);
    if (event === "task:completed") {
      this.statuses.set(taskId, TaskStatus.completed);
      this.results.set(taskId, String(args[1] ?? ""));
      onTaskCompleted?.();
    }
    return super.emit(event, ...args);
  }
}

const LADDER = {
  milestones: [
    { title: "Sprint A — Foundations", prompt: "build the foundations, verify compile" },
    { title: "Sprint B — Elements", prompt: "build the elements, PlayMode green" },
    { title: "Sprint C — Delivery", prompt: "integrate, full suite, DELIVERY REPORT" },
  ],
};

describe("CampaignManager", () => {
  let dir: string;
  let projectRoot: string;
  let storage: CampaignStorage;
  let tasks: FakeTaskManager;
  let messages: Array<{ chatId: string; text: string }>;
  let manager: CampaignManager;
  /** Simulates the messenger being down exactly when the delivery report is sent. */
  let messengerDownFor: RegExp | undefined;
  /** Runs INSIDE the messenger's await — for races that settle mid-send. */
  let messengerHook: (() => void) | undefined;

  const ctx = { chatId: "cli-local", channelType: "cli", userId: "u1" };
  /** What the compiler answers at the delivery gate; green unless a test says otherwise. */
  let compileVerdict: { ok: boolean; ran: boolean; errors?: number; detail?: string } = { ok: true, ran: true };
  /** What the harness's vision provider answers when a test sets it; unset = no answer (not checked). */
  let visionChat: (() => Promise<{ text: string }>) | undefined;
  /** Artifacts the campaign played inside the built player, and what the fake player leaves behind. */
  let playerRuns: string[] = [];
  let playerVerdictOnRun: { ok: boolean; extra: Record<string, unknown> } | undefined;
  /**
   * Runs inside the delivery gate, right after the player has been played:
   * the window in which a person can revive the campaign into a new
   * generation (Codex 2026-09-12 AD#9).
   */
  let afterPlayerRun: (() => void) | undefined;
  const writePlayerVerdict = (ok: boolean, extra: Record<string, unknown> = {}, root: string = projectRoot): void => {
    const dir = join(root, "Recordings", "player-playthrough");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "playthrough-verdict.json"),
      JSON.stringify({
        ok,
        reasons: ok ? [] : ["session 1 never ended after 60 actions (phases seen: Playing)"],
        record: { medium: "player", scene: "Entry", session: 1, autoStarted: false, actions: 12, outcome: ok ? "Won" : "None", reachedOutcome: ok },
        frames: { count: 5, flat: 0, maxMotionShare: 0.3 },
        perf: { medium: "player", bootSeconds: 1.1, playSeconds: 10, playFrames: 600, avgFps: 60, worstFrameMs: 40 },
        measuredAt: new Date().toISOString(),
        ...extra,
      }),
    );
  };
  /** Files the campaign handed to the chat (the newest gameplay frame with a delivery report). */
  let attached: Array<{ chatId: string; name: string; url?: string; type: string }> = [];
  /** What the campaign's own player build answers at the delivery gate; a real artifact unless a test says otherwise. */
  /** The target the campaign asked its builder for (the GDD's platform). */
  let buildTargetsAsked: Array<string | undefined> = [];
  let buildVerdict: import("./types.js").PlayerBuildEvidence = {
    ran: true, ok: true, target: "StandaloneOSX", artifactPath: "/tmp/Builds/StandaloneOSX/Game.app", sizeBytes: 88_000_000, durationMs: 120_000, scenes: 2,
  };

  /**
   * What unity_playthrough leaves behind. The delivery gate requires an ok
   * verdict newer than the final sprint (measured 2026-09-10: delivered green,
   * never played), so every test that expects delivery starts with one; the
   * tests about the gate itself remove or fail it.
   */
  const writePlaythroughVerdict = (ok: boolean, extra: Record<string, unknown> = {}): string => {
    const path = join(projectRoot, "Recordings", "playthrough", "playthrough-verdict.json");
    mkdirSync(join(projectRoot, "Recordings", "playthrough"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        ok,
        reasons: ok ? [] : ["session 1 never ended after 60 actions (phases seen: Playing)"],
        record: { scene: "Entry", session: 1, autoStarted: false, actions: 12, outcome: ok ? "Won" : "None", reachedOutcome: ok },
        frames: { count: 5, flat: 0, maxMotionShare: 0.3 },
        measuredAt: new Date().toISOString(),
        ...extra,
      }),
    );
    return path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "campaign-mgr-"));
    projectRoot = join(dir, "project");
    mkdirSync(join(projectRoot, "docs"), { recursive: true });
    writeFileSync(join(projectRoot, "docs", "Game_GDD.md"), "# Test GDD\n\nElement schedule: ...");
    writePlaythroughVerdict(true);
    storage = new CampaignStorage(join(dir, "campaigns.db"));
    tasks = new FakeTaskManager();
    runRecordOnSettle = { total: 42, passed: 42, failed: 0, skipped: 0, unfiltered: true };
    onTaskCompleted = () => {
      const verdict = join(projectRoot, "Recordings", "playthrough", "playthrough-verdict.json");
      if (existsSync(verdict)) {
        const now = new Date();
        utimesSync(verdict, now, now);
      }
      // A sprint that RAN the suite leaves its NUnit record; the final sprint
      // is held to that file rather than to prose (Codex 2026-09-11 D#13).
      if (runRecordOnSettle) {
        mkdirSync(join(projectRoot, "Recordings", "tests"), { recursive: true });
        // `measuredAt: null` means "a record with no stamp of its own", which
        // is what a copied file looks like (Codex 2026-09-11 G#4).
        const record: Record<string, unknown> = { measuredAt: new Date().toISOString(), ...runRecordOnSettle };
        if (record.measuredAt === null) delete record.measuredAt;
        writeFileSync(join(projectRoot, "Recordings", "tests", "playmode-last.json"), JSON.stringify(record));
      }
    };
    messages = [];
    messengerDownFor = undefined;
    compileVerdict = { ok: true, ran: true };
    attached = [];
    buildTargetsAsked = [];
    visionChat = undefined;
    playerRuns = [];
    playerVerdictOnRun = { ok: true, extra: {} };
    afterPlayerRun = undefined;
    buildVerdict = {
      ran: true, ok: true, target: "StandaloneOSX", artifactPath: "/tmp/Builds/StandaloneOSX/Game.app", sizeBytes: 88_000_000, durationMs: 120_000, scenes: 2,
    };

    const planner = {
      planMilestones: vi.fn().mockResolvedValue(LADDER),
      // A campaign always HAS an audit; a fixture without one made every
      // delivery read "coverage audit could not run", which the gate now sees
      // in the round it happened (Codex 2026-09-12 S#1).
      auditCoverage: vi.fn().mockResolvedValue([]),
      // A requirement no sprint closed is OPEN until evidence says otherwise:
      // the audit's default answer is the conservative one (Codex U).
      resolveCoverageGaps: vi.fn(async (_gdd: string, reqs: readonly string[]) => ({ closed: [], open: [...reqs] })),
    } as unknown as CampaignPlanner;

    manager = new CampaignManager({
      storage,
      // The gate measures the compiler; tests drive it through this.
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      visionProvider: { provider: { chat: async () => (visionChat ? visionChat() : { text: "" }), capabilities: { vision: true } } as never, name: "vision" },
      attach: async (chatId, a) => { attached.push({ chatId, name: a.name, url: a.url, type: a.type }); },
      planner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => {
        if (messengerDownFor?.test(text)) throw new Error("messenger unavailable");
        // A test can make the world move DURING the send: sending is an
        // await, and what settles inside it is exactly the AK#7 race.
        messengerHook?.();
        messages.push({ chatId, text });
      },
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
      // The bounded self-revival of an implementation failure, driven in real
      // time by the tests below (Codex 2026-09-11 F#1).
      implementationReviveDelayMs: 10,
    });
    manager.attachEvents();
  });

  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
    for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  /**
   * Fail the current sprint until the campaign STOPS — through its bounded
   * self-revivals with a changed approach (Codex 2026-09-11 F#1), so a test
   * that means "a spent budget ends the campaign" still means it.
   */
  const failUntilStopped = async (campaignId: string, reason: string): Promise<void> => {
    for (let round = 0; round < 12; round++) {
      const current = storage.get(campaignId)!;
      // A campaign that is `failed` WITH a revival armed has not stopped: the
      // self-revival keeps the state until its timer fires (F#1).
      if ((current.state === "failed" && !current.autoReviveAt) || current.state === "done") return;
      const submitted = tasks.submitted.length;
      tasks.emit("task:failed", `task_${submitted}`, reason);
      await waitFor(() => {
        const after = storage.get(campaignId)!;
        const stopped = after.state === "failed" && !after.autoReviveAt;
        expect(stopped || tasks.submitted.length > submitted).toBe(true);
      }, { timeout: 15_000 });
    }
    throw new Error(`campaign ${campaignId} never stopped after 12 failed rounds`);
  };

  /**
   * vitest's waitFor defaults to ONE second, and these tests do real
   * filesystem work: under a loaded machine the suite failed a different
   * handful of them on every run. Five seconds by default, and a caller can
   * still ask for more.
   */
  // FIFTEEN seconds, not five: these settles do real filesystem work — a git
  // repo, Unity-shaped fixtures, compile and play-through verdict files — and
  // under a full-suite run on a loaded machine a five-second ceiling made this
  // file flake about one run in three (measured 2026-09-12). A slow machine is
  // not a defect in the ladder; a test that fails for being slow hides the
  // ones that fail for being wrong.
  const waitFor = (fn: () => void | Promise<void>, opts?: { timeout?: number; interval?: number }): Promise<void> =>
    vi.waitFor(fn, { timeout: 15_000, ...opts });

  const settleMilestone = (result: string, explicitTaskId?: string) => {
    const last = tasks.submitted.length;
    // The settling task is the newest SUBMITTED one — a test that minted
    // retries of its own has to say which.
    const taskId = explicitTaskId ?? `task_${last}`;
    // The delivery gate requires the FINAL milestone to carry an observed
    // green test verdict; give every settle one so ladder tests exercise the
    // walk rather than the gate (the gate has its own test).
    tasks.verifications.set(taskId, {
      testsGreen: true,
      detail: "All 42 tests passed (unfiltered — the whole PlayMode suite)",
      unfiltered: true,
    });
    tasks.emit("task:completed", taskId, result);
  };

  it("GDD mode: plans the ladder and submits sprint 1 immediately (no approval gate)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    expect(campaign.state).toBe("planning");

    await waitFor(() => {
      expect(tasks.submitted).toHaveLength(1);
    });
    expect(tasks.submitted[0]!.prompt).toContain("foundations");
    expect(storage.get(campaign.id)!.state).toBe("executing");
    // The ladder announcement went to the origin conversation.
    expect(messages.some((m) => m.text.includes("Milestone ladder ready"))).toBe(true);
  });

  it("walks the ladder: sprint completion auto-submits the next sprint", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));

    settleMilestone("sprint A done, committed");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(tasks.submitted[1]!.prompt).toContain("elements");

    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    settleMilestone("final report");
    await waitFor(() => {
      expect(storage.get(campaign.id)!.state).toBe("done");
    });
    expect(messages.at(-1)!.text).toContain("Campaign delivery");
  });

  it("retries a failed milestone with the failure appended, then fails loudly", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));

    tasks.emit("task:failed", "task_1", "compile exploded");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(tasks.submitted[1]!.prompt).toContain("compile exploded");

    tasks.emit("task:failed", "task_2", "compile exploded again");
    // The spent budget is not the end any more: the campaign self-revives
    // with a changed approach, twice, and THEN stops (Codex 2026-09-11 F#1).
    await waitFor(() => {
      expect(messages.some((m) => m.text.includes("Retrying with a changed approach"))).toBe(true);
    });
    await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(2));
    expect(tasks.submitted.at(-1)!.prompt).toContain("Do NOT repeat that approach");
    await failUntilStopped(campaign.id, "compile exploded again");
    expect(storage.get(campaign.id)!.state).toBe("failed");
    expect(storage.get(campaign.id)!.autoReviveAt).toBeUndefined();
    expect(messages.at(-1)!.text).toContain("Campaign stopped");
  });

  it("nudges a blocked sprint with the autonomous mandate instead of waiting on a person", async () => {
    manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));

    tasks.emit("task:blocked", "task_1", "blocked:ask_user");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(tasks.submitted[1]!.prompt).toContain("do not ask the user");
  });

  it("idea mode: drafts the GDD, gates on approval, builds after 'evet'", async () => {
    const campaign = manager.startFromIdea(ctx, "a match-3 where pigs fly");
    expect(campaign.state).toBe("drafting-gdd");
    expect(tasks.submitted).toHaveLength(1);
    expect(tasks.submitted[0]!.prompt).toContain("pigs fly");

    // Draft completes; the GDD file exists in docs/.
    tasks.emit("task:completed", "task_1", "wrote docs/Game_GDD.md");
    await waitFor(() => {
      expect(storage.get(campaign.id)!.state).toBe("awaiting-approval");
    });
    expect(messages.at(-1)!.text).toContain("Game_GDD.md");

    // A random message from another chat is not consumed by the gate.
    expect(await manager.tryHandleApproval("other-chat", "evet")).toBe(false);

    // Revision feedback re-drafts instead of launching.
    expect(await manager.tryHandleApproval("cli-local", "daha fazla bölüm ekle")).toBe(true);
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(tasks.submitted[1]!.prompt).toContain("daha fazla bölüm ekle");

    // Second draft lands, designer approves → ladder plans, sprint 1 starts.
    tasks.emit("task:completed", "task_2", "revised GDD written");
    await waitFor(() => {
      expect(storage.get(campaign.id)!.state).toBe("awaiting-approval");
    });
    expect(await manager.tryHandleApproval("cli-local", "evet")).toBe(true);
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    expect(storage.get(campaign.id)!.state).toBe("executing");
  });

  it("re-drafts when a 'completed' draft never wrote the GDD file", async () => {
    rmSync(join(projectRoot, "docs", "Game_GDD.md"));
    const campaign = manager.startFromIdea(ctx, "a puzzle game");
    expect(campaign.state).toBe("drafting-gdd");

    tasks.emit("task:completed", "task_1", "I described the GDD in chat");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(tasks.submitted[1]!.prompt).toContain("never wrote the GDD file");
  });

  it("resumeActive resubmits the in-flight milestone when the task died with the process", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    // Simulate crash: the task is terminally failed but its event never arrived.
    tasks.markTerminal("task_1", TaskStatus.failed);

    await manager.resumeActive();
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(storage.get(campaign.id)!.state).toBe("executing");
  });

  it("adopts the executor's own retry instead of resubmitting and burning an attempt", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));

    // Keep-alive parks task_1 as blocked and mints task_2 as its retry.
    const retryId = tasks.addRetry("task_1");
    tasks.emit("task:blocked", "task_1", "Transient failure — provider cooldown. Auto-retry 1/10 in ~30s.");

    // After the grace window the campaign adopts the retry: no resubmission.
    await waitFor(() => {
      const fresh = storage.get(campaign.id)!;
      expect(fresh.milestones[0]!.taskId).toBe(retryId);
    });
    expect(tasks.submitted).toHaveLength(1);
    expect(storage.get(campaign.id)!.milestones[0]!.attempts).toBe(1); // untouched

    // The adopted retry completing walks the ladder normally.
    tasks.emit("task:completed", retryId, "sprint A done via retry");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
  });

  it("resumes a paused (startup-recovered) GDD draft instead of wedging forever", async () => {
    // Drafts are replayed from their checkpoint; sprints are resubmitted
    // (see the test below) because their prompt carries the latest measurement.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const stored = storage.get(campaign.id)!;
    stored.state = "drafting-gdd";
    stored.draftTaskId = "task_1";
    storage.save(stored);
    tasks.markTerminal("task_1", TaskStatus.paused);

    await manager.resumeActive();
    expect(tasks.resumed).toContain("task_1");
    await waitFor(() => {
      const fresh = storage.get(campaign.id)!;
      expect(fresh.draftTaskId).not.toBe("task_1");
    });
  });

  it("a paused SPRINT is resubmitted with the milestone's current prompt, not replayed from a stale root", async () => {
    // Measured 2026-09-08 04:18: the replay quoted a 29-sprints-old root
    // prompt with no delivery gate; the milestone held the current one.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const stored = storage.get(campaign.id)!;
    stored.state = "executing";
    stored.milestones[0]!.taskId = "task_1";
    stored.milestones[0]!.attempts = 1;
    storage.save(stored);
    tasks.markTerminal("task_1", TaskStatus.paused);

    await manager.resumeActive();
    expect(tasks.resumed).not.toContain("task_1");
    expect(tasks.cancelled).toContain("task_1");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    const fresh = storage.get(campaign.id)!;
    expect(fresh.milestones[0]!.attempts).toBe(1);
    expect(fresh.milestones[0]!.taskId).not.toBe("task_1");
  });

  it("revival cancels the old lineage's live tip before resubmitting", async () => {
    // 2026-09-02 19:23: the executor's boot re-arm revived the old blocked
    // lineage while the campaign resubmitted the sprint — two runs of the
    // same prompt against the same repo.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const stored = storage.get(campaign.id)!;
    stored.state = "failed";
    stored.milestones[0]!.attempts = 2;
    storage.save(stored);
    tasks.markTerminal("task_1", TaskStatus.blocked);

    const handled = await manager.tryHandleRevive("cli-local", "kampanya devam");
    expect(handled).toBe(true);
    expect(tasks.cancelled).toContain("task_1");
    // The cancel is a supersession: the resubmitted attempt is task_1's child,
    // and the executor's keep-alive must not read it as a stop order
    // (measured 2026-09-08 15:19: it did, for every attempt after the first).
    expect(tasks.cancelReasons.get("task_1")).toBe("superseded");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
  });

  it("a retirement the campaign can come back from is a supersession, not a stop order (Codex 2026-09-11 F#6)", async () => {
    // A campaign that stops short of delivery may revive — by its own budget
    // or by a person — and the revived mission descends from these tasks. A
    // HARD cancel poisons every descendant, so the executor's keep-alive and
    // goal auto-resume abandoned the revived mission's recovery.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    await failUntilStopped(campaign.id, "compile error CS0246");
    expect(storage.get(campaign.id)!.state).toBe("failed");
    // Whatever this retirement cancelled, it cancelled as a supersession: the
    // campaign can come back from it, and the delivery paths' own tests cover
    // the case where there is live work to retire.
    for (const id of tasks.cancelled) {
      expect(tasks.cancelReasons.get(id)).toBe("superseded");
    }
  });

  it("a third time-box overrun charges an attempt instead of running unbounded", async () => {
    // Measured 2026-09-01: after escalation 2/2 the box switched off and m6
    // ran 33h. The third overrun must be a charged, narrowest-scope retry.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const stored = storage.get(campaign.id)!;
    stored.milestones[0]!.timeBoxEscalations = 2;
    stored.milestones[0]!.startedAtMs = Date.now() - 7 * 60 * 60_000; // past a 6h box
    storage.save(stored);

    // A blocked settle drives reconcile → escalateIfPastTimeBox.
    tasks.emit("task:blocked", "task_1", "Transient failure — provider hiccup");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));

    const after = storage.get(campaign.id)!;
    expect(after.state).toBe("executing");
    expect(after.milestones[0]!.attempts).toBe(2); // charged
    expect(tasks.submitted[1]!.prompt).toContain("TIME BOX EXHAUSTED");
  });

  it("a time box that outlives the attempt budget still gets the bounded recovery (Codex 2026-09-11 H#6)", async () => {
    // This path wrote `failed` with no appointment at all: a sprint that ran
    // long was the one kind of exhaustion the autonomous recovery never saw.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const overrun = (): void => {
      const stored = storage.get(campaign.id)!;
      stored.milestones[0]!.timeBoxEscalations = 2;
      stored.milestones[0]!.attempts = 2; // budget already spent
      stored.milestones[0]!.startedAtMs = Date.now() - 7 * 60 * 60_000;
      storage.save(stored);
    };
    overrun();
    tasks.emit("task:blocked", `task_${tasks.submitted.length}`, "Transient failure — provider hiccup");
    await waitFor(() => {
      expect(messages.some((m) => m.text.includes("Retrying with a changed approach"))).toBe(true);
    }, { timeout: 15_000 });
    const revived = storage.get(campaign.id)!;
    expect(revived.implementationRevives).toBe(1);
    expect(revived.milestones[0]!.prompt).toContain("Do NOT repeat that approach");
    // The revival's ten-millisecond appointment has already fired here, so the
    // proof it was armed is the resubmission it produced.
    await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(1), { timeout: 15_000 });
    expect(revived.milestones[0]!.timeBoxEscalations ?? 0).toBe(0); // a fresh box for the new approach

    // …and it still ends: the budget is the same bounded one.
    for (let i = 0; i < 6; i++) {
      const stored = storage.get(campaign.id)!;
      if (stored.state === "failed" && !stored.autoReviveAt) break;
      await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(i + 1), { timeout: 15_000 }).catch(() => undefined);
      overrun();
      tasks.emit("task:blocked", `task_${tasks.submitted.length}`, "Transient failure — provider hiccup");
      await new Promise((r) => setTimeout(r, 120));
    }
    const stopped = storage.get(campaign.id)!;
    expect(stopped.implementationRevives).toBeLessThanOrEqual(2);
  });

  it("cancels the abandoned lineage on EVERY resubmit, not only on revive", async () => {
    // Measured live 2026-09-03: a resubmit pointed the milestone at a new task
    // and forgot the old lineage, whose keep-alive resurrected it at 09:19,
    // 09:37, 09:53 and 10:20 — all after the campaign had delivered. Once the
    // campaign stopped referencing that lineage, nothing could find it.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    // The sprint blocks; the executor's keep-alive mints a retry under a new
    // id, so the lineage tip is no longer the task the milestone points at.
    const retryId = tasks.addRetry("task_1", TaskStatus.blocked);
    tasks.updatedAts.set("task_1", Date.now() - 30 * 60_000);
    tasks.updatedAts.set(retryId, Date.now() - 30 * 60_000);
    tasks.emit("task:failed", "task_1", "the sprint failed outright");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));

    expect(tasks.cancelled).toContain(retryId);
  });

  it("an EXECUTOR cancellation of an exhausted milestone still self-revives (Codex 2026-09-11 L#5)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));

    // The milestone has spent its attempts and its task is cancelled with NO
    // reason — the executor's own retirement, not a person's stop. The
    // campaign used to end here: failed, no appointment, zero submissions,
    // with another milestone still pending.
    const staged = storage.get(campaign.id)!;
    const taskId = staged.milestones[0]!.taskId!;
    staged.milestones[0]!.attempts = 2;
    storage.save(staged);
    const before = tasks.submitted.length;
    tasks.cancel(taskId);
    tasks.emit("task:cancelled", taskId);

    await waitFor(() => {
      const after = storage.get(campaign.id)!;
      expect(after.autoReviveAt !== undefined || tasks.submitted.length > before).toBe(true);
    });
    const after = storage.get(campaign.id)!;
    expect(after.lastError ?? "").not.toContain("was cancelled");
  });

  it("a milestone that has not run yet is not 'legacy', and a shared preamble is not ownership (Codex 2026-09-12 P#11)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const stored = storage.get(campaign.id)!;
    // Real sprint prompts run past 120 characters, and two sprints of one
    // campaign open the same way — that shared opening is the whole point.
    const preamble =
      "You are continuing the campaign for the game described in the design document docs/Game_GDD.md. Work only inside the project root and ";
    stored.milestones[0]!.prompt = `${preamble}build the foundations, verify compile.`;
    stored.milestones[1]!.prompt = `${preamble}build the elements, PlayMode green.`;
    expect(preamble.length).toBeGreaterThanOrEqual(120);

    // A mission that shares the first 120 characters of a PRE-UPGRADE
    // milestone's prompt and then diverges: prefix matching cancelled it.
    const sharesPreamble = tasks.submit(
      "cli-local", "cli", `${stored.milestones[0]!.prompt.slice(0, 120)}AND SOMETHING ELSE ENTIRELY`,
    ).id;
    tasks.markTerminal(sharesPreamble, TaskStatus.blocked);
    // …and a mission carrying the WHOLE prompt of a milestone that has never
    // been submitted: that milestone is not pre-upgrade, so it owns nothing.
    const matchesUnsubmitted = tasks.submit(
      "cli-local", "cli", `${stored.milestones[1]!.prompt}\n\nAND SOMETHING ELSE ENTIRELY`,
    ).id;
    tasks.markTerminal(matchesUnsubmitted, TaskStatus.blocked);

    stored.milestones[0]!.taskIds = undefined; // ran under the old code
    stored.milestones[1]!.taskId = undefined;  // never submitted
    stored.milestones[1]!.taskIds = undefined;
    stored.state = "done";
    stored.deliveryReported = true;
    storage.save(stored);

    await manager.resumeActive();

    expect(tasks.cancelled).not.toContain(sharesPreamble);
    expect(tasks.cancelled).not.toContain(matchesUnsubmitted);
  });

  it("a task that QUOTES a legacy milestone's prompt is not that milestone (Codex 2026-09-12 Q#4)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const stored = storage.get(campaign.id)!;
    // Someone asks a question ABOUT the sprint's instructions. It carries the
    // whole prompt, and the ownership scan cancelled it.
    const quoting = tasks.submit(
      "cli-local", "cli", `Please explain this earlier instruction, do not execute it:\n\n${stored.milestones[0]!.prompt}`,
    ).id;
    tasks.markTerminal(quoting, TaskStatus.blocked);
    // …while the milestone's OWN pre-upgrade task opens with it.
    const itsOwn = tasks.submit("cli-local", "cli", `${stored.milestones[0]!.prompt}\n\nContinue.`).id;
    tasks.markTerminal(itsOwn, TaskStatus.blocked);

    for (const m of stored.milestones) m.taskIds = undefined;
    stored.milestones[0]!.taskId = "task_gone";
    stored.state = "done";
    stored.deliveryReported = true;
    storage.save(stored);

    await manager.resumeActive();

    expect(tasks.cancelled).not.toContain(quoting);
    expect(tasks.cancelled).toContain(itsOwn);
  });

  it("a campaign persisted BEFORE ownership existed still retires its orphans (Codex 2026-09-11 O#11)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const stored = storage.get(campaign.id)!;
    // An orphan carrying the milestone's prompt, and a ledger that does not
    // exist — exactly what an upgraded campaign looks like.
    const orphanId = tasks.submit("cli-local", "cli", stored.milestones[0]!.prompt).id;
    tasks.markTerminal(orphanId, TaskStatus.blocked);
    for (const m of stored.milestones) m.taskIds = undefined;
    stored.milestones[0]!.taskId = "task_gone";
    stored.state = "done";
    stored.deliveryReported = true;
    storage.save(stored);

    await manager.resumeActive();

    expect(tasks.cancelled).toContain(orphanId);
  });

  it("does NOT retire another mission that merely shares an opening (Codex 2026-09-11 L#4)", async () => {
    // Two unrelated task roots in one chat whose prompts share their first
    // 120 characters — a generic final-proof opening is enough — and
    // retirement cancelled both. Ownership is recorded, not inferred.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const stored = storage.get(campaign.id)!;
    const stranger = tasks.submit("cli-local", "cli", `${stored.milestones[0]!.prompt}\n\nAND SOMETHING ELSE ENTIRELY`).id;
    tasks.markTerminal(stranger, TaskStatus.blocked);
    stored.state = "done";
    stored.deliveryReported = true;
    storage.save(stored);

    await manager.resumeActive();

    expect(tasks.cancelled).not.toContain(stranger);
    expect(tasks.cancelReasons.get(stranger)).toBeUndefined();
  });

  it("cancels an ABANDONED mission the campaign no longer points at (Codex 2026-09-11 L#4)", async () => {
    // Measured live 2026-09-03: two orphan roots (task_3f52a987 and
    // task_ea50a818) kept reviving after delivery. Walking milestone.taskId
    // could not reach them — the milestone pointed at the task that
    // delivered, not at the lineages earlier resubmits had abandoned.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const stored = storage.get(campaign.id)!;
    // The campaign's OWN first task, abandoned when the milestone was
    // re-pointed: ownership is recorded as it is submitted, so retirement
    // reaches it without guessing from its wording (Codex 2026-09-11 L#4).
    const orphanId = stored.milestones[0]!.taskId!;
    expect(stored.milestones[0]!.taskIds).toContain(orphanId);
    tasks.markTerminal(orphanId, TaskStatus.blocked);
    stored.milestones[0]!.taskId = "task_gone";
    stored.state = "done";
    stored.deliveryReported = true;
    storage.save(stored);

    await manager.resumeActive();

    expect(tasks.cancelled).toContain(orphanId);
  });

  it("retires the lineage ROOT so future children inherit the cancel", async () => {
    // Measured live 2026-09-03 11:04, a seventh resurrection: cancelling only
    // the live end retires nothing — the next continuation mints a fresh
    // child whose ancestry holds no cancel at all.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const stored = storage.get(campaign.id)!;
    const rootId = stored.milestones[0]!.taskId!;
    const childId = tasks.addRetry(rootId, TaskStatus.blocked);
    tasks.markTerminal(rootId, TaskStatus.blocked);
    stored.milestones[0]!.taskId = "task_gone";
    stored.state = "done";
    stored.deliveryReported = true;
    storage.save(stored);

    await manager.resumeActive();

    expect(tasks.cancelled).toContain(childId);
    expect(tasks.cancelled).toContain(rootId);
  });

  it("cancels a delivered campaign's stragglers at boot, not only on delivery", async () => {
    // Measured live 2026-09-03 09:19 and 09:37: minutes after delivery the
    // executor's keep-alive re-arm revived a blocked pre-delivery task and
    // resubmitted the sprint against a game that had already shipped. The
    // campaign was already terminal, so nothing resumed it and nothing
    // cancelled its lineage.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const stored = storage.get(campaign.id)!;
    stored.state = "done";
    stored.deliveryReported = true;
    storage.save(stored);
    // The old lineage is alive again (a keep-alive retry under a new id).
    const retryId = tasks.addRetry("task_1");

    await manager.resumeActive();

    expect(tasks.cancelled).toContain(retryId);
  });

  it("names the structural problem while the test gate is still bouncing", async () => {
    runRecordOnSettle = undefined; // this sprint leaves no NUnit record
    // Measured live 2026-09-04 04:05: bounced for a missing verdict, the
    // sprint never learned its scenes render nothing — and ADDED two more
    // CreatePrimitive scripts while it worked.
    mkdirSync(join(projectRoot, "ProjectSettings"), { recursive: true });
    mkdirSync(join(projectRoot, "Assets", "Scenes"), { recursive: true });
    mkdirSync(join(projectRoot, "Assets", "Prefabs"), { recursive: true });
    writeFileSync(join(projectRoot, "Assets", "Scenes", "Game.unity"), "GameObject:\n  m_Name: Root");
    writeFileSync(join(projectRoot, "Assets", "Prefabs", "Ball.prefab"), "MeshRenderer:\n  m_Materials: []");
    writeFileSync(
      join(projectRoot, "ProjectSettings", "EditorBuildSettings.asset"),
      "EditorBuildSettings:\n  m_Scenes:\n  - enabled: 1\n    path: Assets/Scenes/Game.unity",
    );

    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    // Final sprint completes with NO test verdict → the test gate bounces.
    tasks.emit("task:completed", "task_3", "shipping it");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));

    const prompt = tasks.submitted[3]!.prompt;
    expect(prompt).toContain("DELIVERY VERIFICATION REQUIRED");
    // The structural verdict lives in ONE place, refreshed at every submit —
    // the <<MEASURED NOW>> block — never as a second sentence inside the gate.
    // Measured 2026-09-08 05:25: a days-old "ALSO, ALREADY MEASURED: the
    // scenes render NOTHING … bind them" sat beside a fresh "placeholder art"
    // measurement, and the sprint followed the stale one for an hour.
    expect(prompt).not.toContain("ALREADY MEASURED");
    expect(prompt).toContain("<<MEASURED NOW");
    expect(prompt.indexOf("<<MEASURED NOW")).toBe(prompt.lastIndexOf("<<MEASURED NOW"));
  });

  it("a legacy 'ALSO, ALREADY MEASURED' paragraph is removed when the final sprint is resubmitted", async () => {
    mkdirSync(join(projectRoot, "ProjectSettings"), { recursive: true });
    mkdirSync(join(projectRoot, "Assets", "Scenes"), { recursive: true });
    writeFileSync(join(projectRoot, "Assets", "Scenes", "Game.unity"), "GameObject:\n  m_Name: Root");
    writeFileSync(
      join(projectRoot, "ProjectSettings", "EditorBuildSettings.asset"),
      "EditorBuildSettings:\n  m_Scenes:\n  - enabled: 1\n    path: Assets/Scenes/Game.unity",
    );
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    // A gate block written before 2026-09-08 left this paragraph in the
    // persisted prompt. The art-gate and revive paths resubmit WITHOUT cutting
    // the old gate block (only a verification bounce cuts it), so the strip in
    // attachStructureMeasurement is what removes it there.
    const stored = storage.get(campaign.id)!;
    const finalIndex = stored.milestones.length - 1;
    stored.milestones[finalIndex]!.prompt +=
      "\n\nALSO, ALREADY MEASURED: The shipped scenes render NOTHING: bind them in the scene.\n" +
      "Deterministic path: unity_bind_sprite.";
    stored.state = "failed";
    stored.milestones[finalIndex]!.attempts = 2;
    storage.save(stored);
    tasks.markTerminal("task_3", TaskStatus.blocked);

    const handled = await manager.tryHandleRevive("cli-local", "kampanya devam");
    expect(handled).toBe(true);
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));
    const prompt = tasks.submitted[3]!.prompt;
    expect(prompt).not.toContain("ALREADY MEASURED");
    expect(prompt).not.toContain("render NOTHING: bind them");
    expect(prompt).not.toContain("Deterministic path: unity_bind_sprite.");
    expect(prompt).toContain("<<MEASURED NOW");
  });

  it("the planner's BUILD HYGIENE bullet mid-list is replaced too, not kept beside nothing (Codex review 2026-09-08)", async () => {
    const campaign = await reachFinalSprint();
    const stored = storage.get(campaign.id)!;
    const finalIndex = stored.milestones.length - 1;
    stored.milestones[finalIndex]!.prompt = stored.milestones[finalIndex]!.prompt.replace(
      /\n\nBUILD HYGIENE \(final sprint\):[\s\S]*$/,
      "\n\nDeliverables:\n- Wire the HUD.\n- BUILD HYGIENE: old wording — scenes must be deleted or disabled.\n- Ship it.",
    );
    stored.state = "failed";
    stored.milestones[finalIndex]!.attempts = 2;
    storage.save(stored);
    tasks.markTerminal("task_3", TaskStatus.blocked);

    expect(await manager.tryHandleRevive("cli-local", "kampanya devam")).toBe(true);
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));
    const prompt = tasks.submitted[3]!.prompt;
    expect(prompt).not.toContain("old wording");
    expect(prompt).toContain("- Wire the HUD.\n- Ship it.");
    expect(prompt).toContain("BUILD HYGIENE (final sprint): when you are done, the FIRST enabled scene in Build Settings");
    expect(prompt.indexOf("BUILD HYGIENE")).toBe(prompt.lastIndexOf("BUILD HYGIENE"));
  });

  it("a bounce's stale DELIVERY REFUSED paragraph is dropped when the measurement is refreshed (Codex review 2026-09-08)", async () => {
    const campaign = await reachFinalSprint();
    const stored = storage.get(campaign.id)!;
    const finalIndex = stored.milestones.length - 1;
    stored.milestones[finalIndex]!.prompt +=
      "\n\nDELIVERY REFUSED — THE GAME IS NOT BUILT AS THE GDD SPECIFIES: OLD: the scenes render NOTHING\n" +
      "Fix the game, not the report: place the project's own prefabs in the scenes the build ships.\n" +
      "DO NOT AUDIT: counting what exists is not the task — binding it into the shipped scenes is.";
    stored.state = "failed";
    stored.milestones[finalIndex]!.attempts = 2;
    storage.save(stored);
    tasks.markTerminal("task_3", TaskStatus.blocked);

    expect(await manager.tryHandleRevive("cli-local", "kampanya devam")).toBe(true);
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));
    const prompt = tasks.submitted[3]!.prompt;
    expect(prompt).not.toContain("OLD: the scenes render NOTHING");
    // Either the gate passes now (paragraph gone) or it names the CURRENT refusal.
    const marker = "DELIVERY REFUSED — THE GAME IS NOT BUILT AS THE GDD SPECIFIES:";
    if (prompt.includes(marker)) {
      const measured = /REFUSED: ([^\n]+)/.exec(prompt)?.[1];
      expect(measured).toBeTruthy();
      expect(prompt).toContain(`${marker} ${measured}`);
    }
  });

  it("an older BUILD HYGIENE paragraph in the persisted prompt is replaced by the current wording", async () => {
    const campaign = await reachFinalSprint();
    const stored = storage.get(campaign.id)!;
    const finalIndex = stored.milestones.length - 1;
    // The planner's own heading form ("BUILD HYGIENE: …", campaign-planner.ts)
    // carried the old wording too (review 2026-09-08).
    stored.milestones[finalIndex]!.prompt = stored.milestones[finalIndex]!.prompt.replace(
      /\n\nBUILD HYGIENE \(final sprint\):[\s\S]*$/,
      "\n\nBUILD HYGIENE: old wording — must be deleted or disabled in Build Settings.",
    );
    stored.state = "failed";
    stored.milestones[finalIndex]!.attempts = 2;
    storage.save(stored);
    tasks.markTerminal("task_3", TaskStatus.blocked);

    expect(await manager.tryHandleRevive("cli-local", "kampanya devam")).toBe(true);
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));
    const prompt = tasks.submitted[3]!.prompt;
    expect(prompt).not.toContain("old wording");
    expect(prompt).toContain("must be DISABLED in Build Settings");
    expect(prompt.indexOf("BUILD HYGIENE")).toBe(prompt.lastIndexOf("BUILD HYGIENE"));
  });

  it("a hygiene line the planner wrote in ITS OWN CASE is replaced too (Codex 2026-09-12 U#F9)", async () => {
    // The stored final prompt of the live campaign said "Build hygiene: leave
    // EXACTLY ONE entry scene enabled" — a planner's paraphrase. Both strips
    // matched only the shouted form, so that line stayed for ever beside the
    // newer rule, and a game that spans several scenes was told to disable
    // the scenes it loads.
    const campaign = await reachFinalSprint();
    const stored = storage.get(campaign.id)!;
    const finalIndex = stored.milestones.length - 1;
    stored.milestones[finalIndex]!.prompt = stored.milestones[finalIndex]!.prompt.replace(
      /\n\nBUILD HYGIENE \(final sprint\):[\s\S]*$/,
      "\n\nDeliverables:\n- Wire the HUD.\n- Build hygiene: leave EXACTLY ONE entry scene enabled in Build Settings.\n- Ship it.",
    );
    stored.state = "failed";
    stored.milestones[finalIndex]!.attempts = 2;
    storage.save(stored);
    tasks.markTerminal("task_3", TaskStatus.blocked);

    expect(await manager.tryHandleRevive("cli-local", "kampanya devam")).toBe(true);
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));
    const prompt = tasks.submitted[3]!.prompt;
    expect(prompt).not.toMatch(/EXACTLY ONE entry scene/i);
    expect(prompt).toContain("every scene enabled after it must be one the game itself loads");
    // The rest of the deliverables list is untouched.
    expect(prompt).toContain("Wire the HUD");
    expect(prompt).toContain("Ship it");
  });

  it("refuses delivery on a FILTERED green — the whole suite must be seen", async () => {
    runRecordOnSettle = undefined; // this sprint leaves no NUnit record
    // Audited 2026-09-03: the delivered PixelFlow build's filtered runs were
    // green while its one unfiltered run reported 6 of 173 failing, including
    // WinLevel_ReachesWonState ("LevelWon event did not fire").
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    tasks.verifications.set("task_3", {
      testsGreen: true,
      detail: "PlayMode verification passed: 2 of 2 tests passed (filter: PixelFlowGameplayWinLossTests)",
      unfiltered: false,
    });
    tasks.emit("task:completed", "task_3", "green, shipping");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));

    expect(storage.get(campaign.id)!.state).toBe("executing");
    expect(tasks.submitted[3]!.prompt).toContain("FILTERED");
    expect(messages.some((m) => m.text.includes("Campaign delivery"))).toBe(false);
  });

  it("names the tests that were RED on the way in the delivery report", async () => {
    // Audited 2026-09-03: "6 of 173 tests failed" reached the report without
    // ever naming WinLevel_ReachesWonState — the failure that means the core
    // loop does not work.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    tasks.verifications.set("task_3", {
      testsGreen: true,
      detail: "179 of 179 tests passed (unfiltered — the whole PlayMode suite)",
      unfiltered: true,
      failedTests: ["YourGame.PixelFlow.PlayModeTests.PixelFlowGameplayWinLossTests.WinLevel_ReachesWonState"],
      failedTestsOmitted: 5,
    } as never);
    tasks.emit("task:completed", "task_3", "green, shipping");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"), { timeout: 15_000 });
    // `done` is persisted BEFORE the report is gathered and sent, so waiting
    // on the state alone races the delivery message (green locally, red in CI).
    await waitFor(() => expect(messages.some((m) => m.text.includes("Campaign delivery"))).toBe(true), { timeout: 15_000 });

    const report = messages.map((m) => m.text).find((t) => t.includes("Campaign delivery"))!;
    expect(report).toContain("WinLevel_ReachesWonState");
    expect(report).toContain("+5 more");
    // A DELIVERED campaign is not recoverable: whatever it retired was hard
    // cancelled, so nothing resumes writing to a shipped game (F#6). A task
    // that already finished is left alone, as the real manager leaves it.
    for (const id of tasks.cancelled) expect(tasks.cancelReasons.get(id)).toBeUndefined();
  });

  it("bounces the final sprint for a missing play-through even when the suite is green (measured 2026-09-10)", async () => {
    rmSync(join(projectRoot, "Recordings"), { recursive: true, force: true });
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    expect(tasks.submitted[2]!.prompt).toContain("PLAY-THROUGH (final sprint): the game must register ONE Strada.Core.Play.IPlaythroughDriver");
    expect(tasks.submitted[2]!.prompt).toContain("run unity_build_player");

    tasks.verifications.set("task_3", {
      testsGreen: true,
      detail: "PlayMode verification passed: 179 of 179 tests passed (unfiltered — the whole PlayMode suite)",
      unfiltered: true,
    });
    tasks.emit("task:completed", "task_3", "green, shipping");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));

    const prompt = tasks.submitted[3]!.prompt;
    expect(prompt).toContain("the suite is green and the project compiles, but the game was not shown to be PLAYABLE");
    expect(prompt).toContain("PLAY-THROUGH REQUIRED: no play-through of the game as it now stands was observed");
    expect(prompt).not.toContain("no test run was observed");
    expect(storage.get(campaign.id)!.state).not.toBe("done");
    expect(storage.get(campaign.id)!.milestones[2]!.playthroughVerdict).toEqual({ found: false });

    // A failed verdict bounces too, and the bounce repeats its reasons.
    writePlaythroughVerdict(false);
    tasks.verifications.set("task_4", {
      testsGreen: true,
      detail: "PlayMode verification passed: 179 of 179 tests passed (unfiltered — the whole PlayMode suite)",
      unfiltered: true,
    });
    tasks.emit("task:completed", "task_4", "green, shipping");
    await waitFor(() => expect(tasks.submitted).toHaveLength(5));
    expect(tasks.submitted[4]!.prompt).toContain("PLAY-THROUGH REQUIRED: the last play-through FAILED: session 1 never ended");
  });

  it("holds the GDD's own numbers against the play-through timing: a blown boot budget bounces, a met one is reported (2026-09-10)", async () => {
    const gdd = "# GDD\n\nThe game must load in under 1 second. Target 60 fps.";
    writePlaythroughVerdict(true, { perf: { medium: "editor-playmode-batch", bootSeconds: 2.4, playSeconds: 30, playFrames: 900, avgFps: 30, worstFrameMs: 90 } });
    // THE SHIPPED ARTIFACT'S BOOT TIME is what the document's boot budget
    // means, and the built player is what runs here (Codex 2026-09-12 Z): the
    // editor's 2.4 s is a different machine's measurement of a different
    // thing.
    playerVerdictOnRun = {
      ok: true,
      extra: { perf: { medium: "player", bootSeconds: 2.4, playSeconds: 10, playFrames: 600, avgFps: 60, worstFrameMs: 40 } },
    };
    const campaign = manager.startFromGdd(ctx, gdd, "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    const green = { testsGreen: true, detail: "PlayMode verification passed: 179 of 179 tests passed (unfiltered — the whole PlayMode suite)", unfiltered: true };
    tasks.verifications.set("task_3", green);
    tasks.emit("task:completed", "task_3", "green, shipping");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));
    const prompt = tasks.submitted[3]!.prompt;
    expect(prompt).toContain("the suite is green, the project compiles and the game was played, but the GDD's own numbers are NOT met");
    expect(prompt).toContain("THE GDD'S OWN NUMBERS ARE NOT MET: boot time ≤ 1 s measured 2.4 s");
    // The batch-editor frame rate is a floor, not the player's: reported, never a refusal.
    expect(prompt).not.toContain("frame rate ≥ 60 fps measured");
    // The play-through stood, so the campaign built and played the player: its frame rate answers the fps claim; the boot budget still fails.
    expect(storage.get(campaign.id)!.milestones[2]!.gddClaims).toEqual([
      // Document order (Codex 2026-09-11 B#19): the boot budget is written first.
      "GDD boot time ≤ 1 s: NOT MET — scene load → services in 2.4 s (player)",
      "GDD frame rate ≥ 60 fps: MET — 60.0 fps average over 600 frames in the built player (real rendering), worst frame 40 ms",
    ]);

    writePlaythroughVerdict(true, { perf: { medium: "editor-playmode-batch", bootSeconds: 0.6, playSeconds: 30, playFrames: 900, avgFps: 30 } });
    playerVerdictOnRun = {
      ok: true,
      extra: { perf: { medium: "player", bootSeconds: 0.6, playSeconds: 10, playFrames: 600, avgFps: 60, worstFrameMs: 40 } },
    };
    tasks.verifications.set("task_4", green);
    tasks.emit("task:completed", "task_4", "green, shipping");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"), { timeout: 15_000 });
    // `done` is persisted BEFORE the report is gathered and sent, so waiting
    // on the state alone races the delivery message (green locally, red in CI).
    await waitFor(() => expect(messages.some((m) => m.text.includes("Campaign delivery"))).toBe(true), { timeout: 15_000 });
    const report = messages.map((m) => m.text).join("\n");
    expect(report).toContain("GDD boot time ≤ 1 s: MET — scene load → services in 0.6 s (player)");
    // Delivered: the campaign built and played the player, whose frame rate answers the claim.
    expect(report).toContain("GDD frame rate ≥ 60 fps: MET — 60.0 fps average over 600 frames in the built player (real rendering), worst frame 40 ms");
  });

  it("does not announce a delivery the store refused (Codex 2026-09-12 AD#9)", async () => {
    // While the last gates were settling, a person revived the campaign: the
    // stored row moved to a new generation. persist() correctly drops the old
    // generation's save — and this handler went on regardless, cancelling the
    // live work of the generation that had replaced it and announcing "game
    // build complete" for a campaign that was already running its next
    // attempt.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    const green = { testsGreen: true, detail: "PlayMode verification passed: 179 of 179 tests passed (unfiltered — the whole PlayMode suite)", unfiltered: true };
    afterPlayerRun = () => {
      const live = storage.get(campaign.id)!;
      live.stopGeneration = (live.stopGeneration ?? 0) + 1;
      live.state = "executing";
      storage.save(live);
    };
    tasks.verifications.set("task_3", green);
    tasks.emit("task:completed", "task_3", "green, shipping");

    await new Promise((r) => setTimeout(r, 1500));
    const after = storage.get(campaign.id)!;
    expect(after.stopGeneration).toBe(1);
    expect(after.state).not.toBe("done");
    expect(after.deliveryReported).not.toBe(true);
    expect(messages.some((m) => m.text.includes("game build complete"))).toBe(false);
  });

  it("builds the player itself at delivery: a failed build bounces, a built one is the report's artifact line (2026-09-10)", async () => {
    buildVerdict = { ran: true, ok: false, reasons: ["the report says built but nothing exists at /tmp/Builds/StandaloneOSX/Game.app"], target: "StandaloneOSX" };
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    const green = { testsGreen: true, detail: "PlayMode verification passed: 179 of 179 tests passed (unfiltered — the whole PlayMode suite)", unfiltered: true };
    tasks.verifications.set("task_3", green);
    tasks.emit("task:completed", "task_3", "green, shipping");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));
    const prompt = tasks.submitted[3]!.prompt;
    expect(prompt).toContain("the suite is green, the game was played and the GDD's numbers hold, but the PLAYER DOES NOT BUILD");
    expect(prompt).toContain("PLAYER BUILD FAILED: the campaign built the player from the project root and it did not produce a runnable artifact — the report says built but nothing exists");
    expect(storage.get(campaign.id)!.milestones[2]!.buildVerdict).toMatchObject({ ran: true, ok: false });

    buildVerdict = { ran: true, ok: true, target: "StandaloneOSX", artifactPath: "/tmp/Builds/StandaloneOSX/Game.app", sizeBytes: 88_000_000, durationMs: 120_000, scenes: 2 };
    tasks.verifications.set("task_4", green);
    tasks.emit("task:completed", "task_4", "green, shipping");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"), { timeout: 15_000 });
    // `done` is persisted BEFORE the report is gathered and sent, so waiting
    // on the state alone races the delivery message (green locally, red in CI).
    await waitFor(() => expect(messages.some((m) => m.text.includes("Campaign delivery"))).toBe(true), { timeout: 15_000 });
    const report = messages.map((m) => m.text).join("\n");
    expect(report).toContain("delivery artifact: /tmp/Builds/StandaloneOSX/Game.app (StandaloneOSX, 83.9 MB, built in 120 s)");
  });

  it("does not build while earlier proofs are missing, and says so instead of passing", async () => {
    rmSync(join(projectRoot, "Recordings"), { recursive: true, force: true });
    let builds = 0;
    buildVerdict = { ran: true, ok: true, target: "StandaloneOSX", artifactPath: "/x", sizeBytes: 1 };
    const original = buildVerdict;
    manager = new CampaignManager({
      storage,
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async () => { builds++; return original; },
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot,
    });
    manager.attachEvents();
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    tasks.verifications.set("task_3", { testsGreen: true, detail: "179 of 179 tests passed (unfiltered — the whole PlayMode suite)", unfiltered: true });
    tasks.emit("task:completed", "task_3", "green, shipping");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));
    expect(builds, "a build was attempted on a tree with no play-through").toBe(0);
    expect(storage.get(campaign.id)!.milestones[2]!.buildVerdict).toEqual({ ran: false, detail: "not attempted: earlier delivery proofs are missing (suite, compile or play-through)" });
  });

  it("the delivery report names the play-through and that the game does not start itself", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    tasks.verifications.set("task_3", {
      testsGreen: true,
      detail: "PlayMode verification passed: 179 of 179 tests passed (unfiltered — the whole PlayMode suite)",
      unfiltered: true,
    });
    tasks.emit("task:completed", "task_3", "green, shipping");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"), { timeout: 15_000 });
    // `done` is persisted BEFORE the report is gathered and sent, so waiting
    // on the state alone races the delivery message (green locally, red in CI).
    await waitFor(() => expect(messages.some((m) => m.text.includes("Campaign delivery"))).toBe(true), { timeout: 15_000 });
    const report = messages.map((m) => m.text).join("\n");
    expect(report).toContain("play-through OK in Entry: session 1 played to Won in 12 actions");
    expect(report).toContain("does not start play by itself after boot");
    expect(storage.get(campaign.id)!.milestones[2]!.playthroughVerdict).toMatchObject({ found: true, ok: true, autoStarted: false });
  });

  it("a document that opens on a menu is not reported as broken for doing so (Codex 2026-09-12 V, Job 3.9)", async () => {
    // The system told every final sprint to make the game start playing by
    // itself and called an idle first screen a defect — one game's shape
    // imposed on all of them. The vehicle's own document says "cold boot
    // ≤ 6 s to Home"; the report called that a defect.
    const gdd = "# GDD\n\nCold boot ≤ 6 s to Home on a mid device. Tap PLAY on Home to start a level.";
    const campaign = manager.startFromGdd(ctx, gdd, "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1), { timeout: 15_000 });
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2), { timeout: 15_000 });
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3), { timeout: 15_000 });

    // The final sprint is told to prove the document's OWN entry route.
    const finalPrompt = tasks.submitted[2]!.prompt;
    expect(finalPrompt).toContain("This document opens on Home, so play must NOT start by itself");
    expect(finalPrompt).toContain("through the same controls a person uses");

    tasks.verifications.set("task_3", {
      testsGreen: true,
      detail: "PlayMode verification passed: 179 of 179 tests passed (unfiltered — the whole PlayMode suite)",
      unfiltered: true,
    });
    tasks.emit("task:completed", "task_3", "green, shipping");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"), { timeout: 15_000 });
    // `done` is persisted BEFORE the report is gathered and sent, so waiting
    // on the state alone races the delivery message (green locally, red in CI).
    await waitFor(() => expect(messages.some((m) => m.text.includes("Campaign delivery"))).toBe(true), { timeout: 15_000 });

    const report = messages.map((m) => m.text).join("\n");
    expect(report).not.toContain("sees an idle screen");
    expect(report).toContain("the game opens on Home, as the document specifies");
    // …and the route nobody drove is still named as unproven.
    expect(report).toContain("that route is NOT proven");
  });

  it("refuses delivery while a GDD-scheduled element has no trace in code, and delivers once it does (spec-scope wired 2026-09-10)", async () => {
    writeFileSync(
      join(projectRoot, "docs", "Game_GDD.md"),
      "# GDD\n\n## Element schedule\n\n| Unlock | Element | Notes |\n|---|---|---|\n| L1 | Cube | basic |\n| L7 | Dragon Boss | set piece |\n",
    );
    mkdirSync(join(projectRoot, "Assets", "Scripts"), { recursive: true });
    writeFileSync(join(projectRoot, "Assets", "Scripts", "Cube.cs"), "public class Cube {}");
    const campaign = manager.startFromGdd(ctx, readFileSync(join(projectRoot, "docs", "Game_GDD.md"), "utf8"), "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    const green = { testsGreen: true, detail: "PlayMode verification passed: 179 of 179 tests passed (unfiltered — the whole PlayMode suite)", unfiltered: true };
    tasks.verifications.set("task_3", green);
    tasks.emit("task:completed", "task_3", "green, shipping");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));
    const prompt = tasks.submitted[3]!.prompt;
    expect(prompt).toContain("L7 Dragon Boss");
    expect(prompt).toContain("the code never mentions");
    expect(storage.get(campaign.id)!.state).not.toBe("done");
    expect(storage.get(campaign.id)!.milestones[2]!.structureRefused).toBe(true);

    writeFileSync(join(projectRoot, "Assets", "Scripts", "DragonBoss.cs"), "public class DragonBoss {}");
    tasks.verifications.set("task_4", green);
    tasks.emit("task:completed", "task_4", "dragon built, shipping");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"), { timeout: 15_000 });
    expect(storage.get(campaign.id)!.milestones[2]!.structureFindings?.join("\n")).toContain("all 2 scheduled element(s) have a trace in code");
  });

  it("refuses a silent delivery: the GDD asks for audio, clips exist, no shipped scene reaches one (2026-09-10)", async () => {
    const HEADER = "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n";
    const scene = (extra: string): string =>
      `${HEADER}--- !u!1 &1\nGameObject:\n  m_Name: Main Camera\n--- !u!20 &900\nCamera:\n  m_Enabled: 1\n  orthographic: 1\n--- !u!1 &2\nGameObject:\n  m_Name: Pig\n--- !u!212 &8\nSpriteRenderer:\n  m_Enabled: 1\n  m_Sprite: {fileID: 21300000, guid: 22222222222222222222222222222222, type: 3}\n${extra}`;
    const meta = (rel: string, guid: string): void => writeFileSync(join(projectRoot, `${rel}.meta`), `fileFormatVersion: 2\nguid: ${guid}\n`);
    mkdirSync(join(projectRoot, "Assets", "Scenes"), { recursive: true });
    mkdirSync(join(projectRoot, "Assets", "Art"), { recursive: true });
    mkdirSync(join(projectRoot, "Assets", "Audio"), { recursive: true });
    mkdirSync(join(projectRoot, "ProjectSettings"), { recursive: true });
    writeFileSync(join(projectRoot, "ProjectSettings", "EditorBuildSettings.asset"), "EditorBuildSettings:\n  m_Scenes:\n  - enabled: 1\n    path: Assets/Scenes/Main.unity\n    guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
    writeFileSync(join(projectRoot, "Assets", "Scenes", "Main.unity"), scene(""));
    meta("Assets/Scenes/Main.unity", "5ce5e5e5e5e5e5e5e5e5e5e5e5e5e5e5");
    writeFileSync(join(projectRoot, "Assets", "Art", "pig.png"), "pixels");
    meta("Assets/Art/pig.png", "22222222222222222222222222222222");
    writeFileSync(join(projectRoot, "Assets", "Audio", "merge.wav"), "RIFF");
    meta("Assets/Audio/merge.wav", "33333333333333333333333333333333");
    const gdd = "# GDD\n\n## Audio\nMusic base loop per area; SFX for tap, merge and win; audio ducks on pause.\n";
    writeFileSync(join(projectRoot, "docs", "Game_GDD.md"), gdd);
    const campaign = manager.startFromGdd(ctx, gdd, "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    const green = { testsGreen: true, detail: "PlayMode verification passed: 179 of 179 tests passed (unfiltered — the whole PlayMode suite)", unfiltered: true };
    tasks.verifications.set("task_3", green);
    tasks.emit("task:completed", "task_3", "green, shipping");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));
    expect(tasks.submitted[3]!.prompt).toContain("DELIVERY REFUSED — THE GAME IS NOT BUILT AS THE GDD SPECIFIES: the GDD specifies audio (");
    expect(tasks.submitted[3]!.prompt).toContain("the delivery is silent");
    expect(storage.get(campaign.id)!.milestones[2]!.structureRefused).toBe(true);

    // An AudioSource bound to the clip: no longer silent, delivers.
    writeFileSync(
      join(projectRoot, "Assets", "Scenes", "Main.unity"),
      scene("--- !u!82 &300\nAudioSource:\n  m_Enabled: 1\n  m_audioClip: {fileID: 8300000, guid: 33333333333333333333333333333333, type: 3}\n"),
    );
    tasks.verifications.set("task_4", green);
    tasks.emit("task:completed", "task_4", "audio wired, shipping");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"), { timeout: 15_000 });
    expect(storage.get(campaign.id)!.milestones[2]!.structureFindings?.join("\n")).toContain("1 AudioSource(s), 1 bound to a clip; 1 of the project's 1 clip(s) are reachable");
  });

  it("hands the newest gameplay frame to the chat with the delivery report (portal file delivery 2026-09-10)", async () => {
    mkdirSync(join(projectRoot, "Recordings", "playthrough"), { recursive: true });
    writeFileSync(join(projectRoot, "Recordings", "playthrough", "frame_00012.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    tasks.verifications.set("task_3", { testsGreen: true, detail: "179 of 179 tests passed (unfiltered — the whole PlayMode suite)", unfiltered: true });
    tasks.emit("task:completed", "task_3", "green, shipping");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"));
    await waitFor(() => expect(attached).toHaveLength(1));
    expect(attached[0]).toMatchObject({ chatId: "cli-local", name: "frame_00012.png", type: "image" });
    expect(attached[0]!.url).toBe(join(projectRoot, "Recordings", "playthrough", "frame_00012.png"));
  });

  it("plays the built player at delivery: its frame rate answers the GDD, and a failed run bounces (2026-09-10)", async () => {
    const gdd = "# GDD\n\nTarget 60 fps on mid-range phones. Ships on Android.";
    // The campaign builds for the platform the GDD names, so the frame rate
    // it measures answers the claim (Codex 2026-09-11 B#11).
    buildVerdict = { ran: true, ok: true, target: "Android", artifactPath: "/tmp/Builds/Android/Game.apk", sizeBytes: 88_000_000, durationMs: 120_000, scenes: 2 };
    playerVerdictOnRun = { ok: true, extra: { perf: { medium: "player", bootSeconds: 1.1, playSeconds: 10, playFrames: 420, avgFps: 42, worstFrameMs: 70 } } };
    const campaign = manager.startFromGdd(ctx, gdd, "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    const green = { testsGreen: true, detail: "PlayMode verification passed: 179 of 179 tests passed (unfiltered — the whole PlayMode suite)", unfiltered: true };
    tasks.verifications.set("task_3", green);
    tasks.emit("task:completed", "task_3", "green, shipping");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));
    expect(playerRuns).toEqual(["/tmp/Builds/Android/Game.apk"]);
    expect(buildTargetsAsked).toContain("android");
    expect(tasks.submitted[3]!.prompt).toContain("THE GDD'S OWN NUMBERS ARE NOT MET: frame rate ≥ 60 fps measured 42 fps");
    expect(storage.get(campaign.id)!.milestones[2]!.playerPlaythrough).toMatchObject({ found: true, ok: true, perf: { medium: "player", avgFps: 42 } });

    // The player runs but the session never ends: the run itself blocks.
    playerVerdictOnRun = { ok: false, extra: {} };
    tasks.verifications.set("task_4", green);
    tasks.emit("task:completed", "task_4", "green, shipping");
    await waitFor(() => expect(tasks.submitted).toHaveLength(5));
    expect(tasks.submitted[4]!.prompt).toContain("PLAYER PLAY-THROUGH FAILED: the campaign built the player and played it (unity_run_player); play-through FAILED in Entry: session 1 never ended");

    // Fast enough and played to an outcome: delivered, with the player line in the report.
    playerVerdictOnRun = { ok: true, extra: {} };
    tasks.verifications.set("task_5", green);
    tasks.emit("task:completed", "task_5", "green, shipping");
    // Say WHICH proof went missing when this fails (CI coverage 2026-09-10
    // reported only "expected 'failed' to be 'done'").
    await waitFor(() => {
      const c = storage.get(campaign.id)!;
      const m = c.milestones[2];
      const verdictPath = join(projectRoot, "Recordings", "playthrough", "playthrough-verdict.json");
      const mtime = existsSync(verdictPath) ? statSync(verdictPath).mtimeMs : "absent";
      const rootId = m?.taskId ? tasks.findLineageRootId(m.taskId) : "none";
      const why = `${c.lastError ?? ""} | proofsMissing=${JSON.stringify(m?.deliveryProofsMissing ?? [])} | attempts=${m?.attempts}`
        + ` | taskId=${m?.taskId} root=${rootId} rootCreatedAt=${rootId === "none" ? "?" : tasks.getStatus(rootId)?.createdAt} verdictMtime=${mtime} now=${Date.now()}`;
      expect(c.state, why).toBe("done");
    }, { timeout: 15_000 });
    const report = messages.map((m) => m.text).join("\n");
    expect(report).toContain("GDD frame rate ≥ 60 fps: MET — 60.0 fps average over 600 frames in the built player (real rendering)");
    expect(report).toContain("inside the built player: play-through OK in Entry");
  });

  it("a measurement that could NOT run is a missing proof at delivery, never a pass (Codex 2026-09-11 B#2)", async () => {
    const gdd = "# GDD\n\nA small game.";
    compileVerdict = { ok: false, ran: false, detail: "the Unity bridge is not connected" };
    const campaign = manager.startFromGdd(ctx, gdd, "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    const green = { testsGreen: true, detail: "PlayMode verification passed: 42 of 42 tests passed (unfiltered — the whole PlayMode suite)", unfiltered: true };
    tasks.verifications.set("task_3", green);
    tasks.emit("task:completed", "task_3", "green, shipping");

    await waitFor(() => expect(tasks.submitted).toHaveLength(4));
    const m = storage.get(campaign.id)!.milestones[2]!;
    expect(m.deliveryProofsMissing?.join(" ")).toContain("the compile check did not run");
    expect(storage.get(campaign.id)!.state).not.toBe("done");
    // …and the builder that cannot run is named too, once the compile stands.
    compileVerdict = { ok: true, ran: true, errors: 0 };
    buildVerdict = { ran: false, detail: "no player builder is configured" };
    tasks.verifications.set("task_4", green);
    tasks.emit("task:completed", "task_4", "green, shipping");
    await waitFor(() => {
      const missing = storage.get(campaign.id)!.milestones[2]!.deliveryProofsMissing?.join(" ") ?? "";
      expect(missing).toContain("the player build did not run");
    }, { timeout: 15_000 });
    expect(storage.get(campaign.id)!.state).not.toBe("done");
  });

  it("a non-final sprint that does not compile is bounced, then fails — it does not advance the ladder (Codex 2026-09-11 B#14)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    compileVerdict = { ok: false, ran: true, errors: 12, detail: "Headless compile failed with 12 error(s)." };
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    // Still sprint 1: the tree does not build, so the ladder did not move on.
    expect(storage.get(campaign.id)!.currentMilestone).toBe(0);
    expect(tasks.submitted[1]!.prompt).toContain("THE PROJECT DOES NOT COMPILE");
    expect(storage.get(campaign.id)!.milestones[0]!.status).not.toBe("green");
    settleMilestone("sprint A done again");
    await waitFor(() => expect(tasks.submitted.length).toBeGreaterThanOrEqual(3));
    expect(storage.get(campaign.id)!.currentMilestone).toBe(0);
    compileVerdict = { ok: true, ran: true, errors: 0 };
  });

  it("a verdict earned BEFORE a delivery bounce is stale for the attempt after it (Codex 2026-09-11 B#4)", async () => {
    const gdd = "# GDD\n\nA small game.";
    // The completion hook stops touching the verdict: nothing re-plays the game.
    onTaskCompleted = () => {};
    writePlaythroughVerdict(true);
    const campaign = manager.startFromGdd(ctx, gdd, "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    // A verdict earned during the FIRST attempt at the final sprint: written
    // one millisecond after that attempt began, and never renewed.
    const firstAttemptStart = storage.get(campaign.id)!.milestones[2]!.attemptStartedAtMs!;
    expect(firstAttemptStart).toBeGreaterThan(0);
    const verdictPath = writePlaythroughVerdict(true);
    const earned = new Date(firstAttemptStart + 1);
    utimesSync(verdictPath, earned, earned);
    // A real bounce comes minutes after the verdict (a player build and run);
    // here it can come within the file-clock allowance, which would read the
    // old verdict as a tick-late fresh one. Let the clock pass the allowance.
    const pastAllowance = earned.getTime() + FILE_MTIME_TOLERANCE_MS + 10 - Date.now();
    if (pastAllowance > 0) await new Promise((r) => setTimeout(r, pastAllowance));
    const green = { testsGreen: true, detail: "PlayMode verification passed: 42 of 42 tests passed (unfiltered — the whole PlayMode suite)", unfiltered: true };
    tasks.verifications.set("task_3", green);
    // The player run fails, so the sprint bounces with the verdict still on disk.
    playerVerdictOnRun = { ok: false, extra: {} };
    tasks.emit("task:completed", "task_3", "green, shipping");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));

    // Second attempt: the game was NOT replayed, and the old verdict no longer
    // counts — the attempt clock moved even though the milestone clock did not.
    const secondAttemptStart = storage.get(campaign.id)!.milestones[2]!.attemptStartedAtMs!;
    expect(secondAttemptStart).toBeGreaterThan(firstAttemptStart);
    playerVerdictOnRun = { ok: true, extra: {} };
    tasks.verifications.set("task_4", green);
    tasks.emit("task:completed", "task_4", "green, shipping");
    await waitFor(() => {
      const m = storage.get(campaign.id)!.milestones[2]!;
      expect(m.playthroughVerdict?.stale === true || m.playthroughVerdict?.found === false).toBe(true);
    }, { timeout: 15_000 });
    expect(storage.get(campaign.id)!.state).not.toBe("done");
  });

  it("the runtime dump that withdraws a structural refusal is THIS sprint's, and only from an ok play-through (Codex 2026-09-11 B#5)", () => {
    const runtime = { renderers: 247, worldRenderers: 12, spriteRenderers: 9, meshRenderers: 3, canvases: 1, particleSystems: 0, audioSources: 2, audioPlaying: 1, sprites: ["Hero"], meshes: [], primitiveMeshes: [] };
    const withMilestones = (milestones: unknown[], current: number) => ({ milestones, currentMilestone: current }) as never;
    const latest = (c: unknown) => (manager as unknown as { latestRuntimeEvidence: (c: unknown) => unknown }).latestRuntimeEvidence(c);
    // An earlier sprint's dump does not speak for the sprint being delivered.
    expect(latest(withMilestones([{ playthroughVerdict: { found: true, ok: true, runtime } }, { playthroughVerdict: { found: true, ok: true } }], 1))).toBeUndefined();
    // A current verdict that is not ok proves nothing either.
    expect(latest(withMilestones([{ playthroughVerdict: { found: true, ok: false, runtime } }], 0))).toBeUndefined();
    // This sprint, played to an outcome: the dump counts.
    expect(latest(withMilestones([{ playthroughVerdict: { found: true, ok: true, runtime } }], 0))).toMatchObject({ worldRenderers: 12 });
  });

  it("records how the plan covers the GDD's sections and says what stayed unplanned (structural planner 2026-09-10)", async () => {
    const structured = {
      milestones: [
        { title: "Sprint A — Foundations", prompt: "build the foundations, verify compile", coveredSections: ["1. Core Loop"], deliverables: ["Main scene"] },
        { title: "Sprint B — Elements", prompt: "build the elements, PlayMode green", coveredSections: ["3. Element schedule"], deliverables: [] },
        { title: "Sprint C — Delivery", prompt: "integrate, full suite, DELIVERY REPORT", coveredSections: [], deliverables: ["player build"] },
      ],
      excluded: ["leaderboards: the GDD says none in v1"],
      uncoveredSections: ["6. Audio"],
      totalSections: 3,
      minMilestones: 3,
      maxMilestones: 6,
    };
    manager = new CampaignManager({
      storage,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      planner: { planMilestones: vi.fn().mockResolvedValue(structured), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot,
    });
    manager.attachEvents();
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const stored = storage.get(campaign.id)!;
    expect(stored.planCoverage).toEqual({ covered: 2, total: 3, uncovered: ["6. Audio"], excluded: ["leaderboards: the GDD says none in v1"], minMilestones: 3, maxMilestones: 6 });
    expect(stored.milestones[0]!.coveredSections).toEqual(["1. Core Loop"]);
    expect(stored.milestones[0]!.deliverables).toEqual(["Main scene"]);
    expect(stored.milestones[2]!.coveredSections).toBeUndefined();
    const ladderMsg = messages.map((m) => m.text).find((t) => t.includes("Milestone ladder ready"))!;
    expect(ladderMsg).toContain("Sprint A — Foundations — 1. Core Loop");
    expect(ladderMsg).toContain("Plan covers 2/3 GDD sections (ladder sized 3–6 from the measured scope); UNPLANNED: 6. Audio; excluded by the GDD: leaderboards: the GDD says none in v1.");
  });

  it("the NUnit run record outranks the tool's prose: a red file bounces a 'green' sentence, an unfiltered file delivers a 'filtered' one (2026-09-10)", async () => {
    const writeRun = (record: Record<string, unknown>): void => { runRecordOnSettle = record; };
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    // Prose says green and unfiltered; the file says 10 failed.
    writeRun({ total: 215, passed: 205, failed: 10, failedNames: ["Game.Tests.WinLevel_ReachesWonState"], filter: null, categories: null, unfiltered: true });
    tasks.verifications.set("task_3", { testsGreen: true, detail: "PlayMode verification passed: 215 of 215 tests passed (unfiltered — the whole PlayMode suite)", unfiltered: true });
    tasks.emit("task:completed", "task_3", "green, shipping");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));
    const m = storage.get(campaign.id)!.milestones[2]!;
    // A red record at completion is a FAILED attempt (Codex 2026-09-11 B#14), not a green sprint bounced later.
    expect(m.testVerdict).toBeUndefined();
    expect(m.status).not.toBe("green");
    expect(m.testRunSource).toBe("nunit");
    expect(m.testFailures).toEqual(["Game.Tests.WinLevel_ReachesWonState"]);
    expect(storage.get(campaign.id)!.state).toBe("executing");

    // Prose says filtered; the file says the whole suite passed with no filter.
    writeRun({ total: 215, passed: 215, failed: 0, failedNames: [], filter: null, categories: null, unfiltered: true });
    tasks.verifications.set("task_4", { testsGreen: true, detail: "PlayMode verification passed: 12 of 12 tests passed (filter: Something)", unfiltered: false });
    tasks.emit("task:completed", "task_4", "green, shipping");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"), { timeout: 15_000 });
    expect(storage.get(campaign.id)!.milestones[2]!.testVerdict).toBe("PlayMode verification passed: 215 of 215 tests passed (unfiltered — the whole PlayMode suite)");
  });

  it("a record the reader calls RED for any reason stops the sprint (Codex 2026-09-12 V)", async () => {
    // The gate asked only whether `failed > 0`, so a run whose own result was
    // "Failed", or that threw, or whose counts did not add up, advanced the
    // ladder as green. And a malformed failure name threw inside the reader,
    // where a best-effort catch swallowed the whole red record.
    const writeRun = (record: Record<string, unknown>): void => { runRecordOnSettle = record; };
    const reds: Array<Record<string, unknown>> = [
      // The runner's own verdict is a failure while every counter looks fine.
      { total: 1, passed: 1, failed: 0, skipped: 0, result: "Failed", unfiltered: true },
      // A runtime exception during the run.
      { total: 42, passed: 42, failed: 0, skipped: 0, exceptions: 1, unfiltered: true },
      // Counts that do not add up.
      { total: 42, passed: 40, failed: 0, skipped: 0, unfiltered: true },
      // A suite most of which never ran.
      { total: 100, passed: 1, failed: 0, skipped: 99, unfiltered: true },
      // A failed test whose NAME is malformed — the reader used to throw here.
      { total: 1, passed: 0, failed: 1, failedNames: [{ toString: null }], unfiltered: true },
    ];

    for (const red of reds) {
      tasks = new FakeTaskManager();
      storage.close();
      storage = new CampaignStorage(join(dir, `campaigns-red-${reds.indexOf(red)}.db`));
      manager = new CampaignManager({
        storage,
        planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
        taskManager: tasks as unknown as TaskManager,
        messenger: async (chatId, text) => { messages.push({ chatId, text }); },
        projectRoot, retryAdoptionGraceMs: 10, completedSettleDelayMs: 0, milestoneTimeBoxMs: 60 * 60_000,
        runPlaymodeSuite: suiteRunner,
        verifyCompile: async () => ({ ok: true, ran: true, errors: 0 }),
      });
      manager.attachEvents();
      const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      await waitFor(() => expect(tasks.submitted).toHaveLength(1), { timeout: 15_000 });
      writeRun(red);
      settleMilestone("all green, shipping");
      // The sprint does not advance: the attempt is retried instead.
      await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(1), { timeout: 15_000 });
      const after = storage.get(campaign.id)!;
      expect(after.milestones[0]!.status).not.toBe("green");
      expect(after.currentMilestone).toBe(0);
    }

    // …and a genuinely green record still advances the ladder.
    runRecordOnSettle = { total: 42, passed: 42, failed: 0, skipped: 0, unfiltered: true };
  });

  it("a vision model's explicit NO bounces the final sprint once; a YES delivers with the match in the report (2026-09-10)", async () => {
    const gdd = [
      "# GDD", "12.  ART DIRECTION", "12.1 Visual Style",
      "Two-layer look: crisp flat pixel-art canvases on softly rendered dimensional stages, ",
      "plus plump, glossy 3D-feel pigs with 2D-animation snappiness that read instantly against ",
      "the destructible layer, in bright warm colour with heavy contrast for readability.",
    ].join("\n");
    const answers = ["The frame shows a flat grey grid and no pigs.\nMATCH: no", "Plump pigs on a warm stage, as described.\nMATCH: yes"];
    let asked = 0;
    visionChat = async () => { asked++; return { text: answers.shift() ?? "MATCH: yes" }; };
    const campaign = manager.startFromGdd(ctx, gdd, "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    // A frame of the running game captured during the final sprint.
    mkdirSync(join(projectRoot, "Recordings", "playthrough"), { recursive: true });
    writeFileSync(join(projectRoot, "Recordings", "playthrough", "frame_00040.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    const green = { testsGreen: true, detail: "PlayMode verification passed: 179 of 179 tests passed (unfiltered — the whole PlayMode suite)", unfiltered: true };
    tasks.verifications.set("task_3", green);
    tasks.emit("task:completed", "task_3", "green, shipping");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));
    expect(asked).toBe(1);
    expect(tasks.submitted[3]!.prompt).toContain("LOOK DOES NOT MATCH THE GDD: a vision model judged the newest captured frame");
    expect(tasks.submitted[3]!.prompt).toContain("flat grey grid and no pigs");
    expect(storage.get(campaign.id)!.milestones[2]!.visualMismatchBounces).toBe(1);

    // The retry captures its OWN frame: the judgement is of the game as it is
    // now, not of the screenshot the bounced attempt left (Codex 2026-09-11 C#28).
    writeFileSync(join(projectRoot, "Recordings", "playthrough", "frame_00041.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    tasks.verifications.set("task_4", green);
    tasks.emit("task:completed", "task_4", "look fixed, shipping");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"), { timeout: 15_000 });
    // The REPORT, not the state: `done` is persisted before the report is
    // gathered and sent, so asserting on the state alone races the delivery
    // message (green locally, red in CI).
    await waitFor(
      () => expect(messages.map((m) => m.text).join("\n")).toContain("MATCH — Plump pigs on a warm stage, as described."),
      { timeout: 15_000 },
    );
  });

  it("measures what the shipped scenes hold at EVERY sprint end, not only at delivery (2026-09-10)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    const first = storage.get(campaign.id)!.milestones[0]!;
    expect(first.status).toBe("green");
    expect(first.structureFindings?.length ?? 0).toBeGreaterThan(0);
    expect(first.structureRefused).not.toBe(true);
  });

  it("delivers on an UNFILTERED green", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    tasks.verifications.set("task_3", {
      testsGreen: true,
      detail: "PlayMode verification passed: 179 of 179 tests passed (unfiltered — the whole PlayMode suite)",
      unfiltered: true,
    });
    tasks.emit("task:completed", "task_3", "green, shipping");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"));
  });

  /**
   * SCENE HYGIENE. Measured on the delivered PixelFlow tree 2026-09-03: 20
   * scenes on disk, 14 enabled in Build Settings, and the person who opened
   * the delivery could not tell which one is the game.
   */
  const buildSettings = (scenes: ReadonlyArray<[string, number]>, disabled: readonly string[] = []): void => {
    mkdirSync(join(projectRoot, "ProjectSettings"), { recursive: true });
    const lines = ["%YAML 1.1", "EditorBuildSettings:", "  m_Scenes:"];
    for (const [rel, objects] of scenes) {
      mkdirSync(join(projectRoot, rel, ".."), { recursive: true });
      writeFileSync(
        join(projectRoot, rel),
        Array.from({ length: objects }, () => "GameObject:\n  m_Name: X").join("\n"),
      );
      lines.push("  - enabled: 1", `    path: ${rel}`);
    }
    for (const rel of disabled) lines.push("  - enabled: 0", `    path: ${rel}`);
    writeFileSync(join(projectRoot, "ProjectSettings", "EditorBuildSettings.asset"), lines.join("\n"));
  };

  /** The delivered tree's real enabled set and GameObject counts. */
  const REAL_DELIVERED_BUILD: ReadonlyArray<[string, number]> = [
    ["Assets/Scenes/Gameplay.unity", 3],
    ["Assets/Scenes/Main.unity", 6],
    ["Assets/Scenes/UfoShowcase.unity", 5],
    ["Assets/Scenes/AssembledGame.unity", 2],
    ["Assets/Scenes/ModuleBoundary.unity", 3],
    ["Assets/InitTestScene4abd18f9.unity", 5],
    ["Assets/Scenes/LiveOpsAssembled.unity", 3],
    ["Assets/Scenes/AssembledMain.unity", 3],
    ["Assets/Scenes/AssembledUfoRuntime.unity", 3],
    ["Assets/Modules/LiveOpsModule/Scenes/LiveOpsVisualAssembly.unity", 1],
    ["Assets/Scenes/LiveOpsVisualsVerified.unity", 3],
    ["Assets/Scenes/LiveOpsPresentation.unity", 4],
    ["Assets/Scenes/TargetedLevel151Verification.unity", 5],
    ["Assets/Scenes/ProductionMain.unity", 17],
  ];

  /** Walk the ladder to the final sprint (task_3 in flight). */
  const reachFinalSprint = async (gddText = "# GDD"): Promise<ReturnType<typeof manager.startFromGdd>> => {
    const campaign = manager.startFromGdd(ctx, gddText, "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    return campaign;
  };

  it("the FINAL sprint is told which scene opens the game, and to disable scaffolding (Codex 2026-09-11 B#15)", async () => {
    await reachFinalSprint();

    expect(tasks.submitted[0]!.prompt).not.toContain("BUILD HYGIENE");
    const finalPrompt = tasks.submitted[2]!.prompt;
    expect(finalPrompt).toContain("BUILD HYGIENE");
    // A boot/menu/level build needs several enabled scenes; what matters is
    // which one is FIRST and that scaffolding is disabled.
    expect(finalPrompt).toContain("the FIRST enabled scene in Build Settings");
    expect(finalPrompt).not.toContain("EXACTLY ONE");
    // The write-back declines deletions of files the system did not write
    // (measured 2026-09-08: twelve scene deletes, none applied), so the
    // instruction is to disable, and says why deleting is wasted.
    expect(finalPrompt).toContain("must be DISABLED in Build Settings");
    expect(finalPrompt).toContain("Do NOT delete scene files that existed before this sprint");
    expect(finalPrompt).not.toContain("deleted or disabled");
    expect(finalPrompt).toContain("name the entry scene");
  });

  it("the FINAL sprint carries the CURRENT structural measurement, not just a gate bounce", async () => {
    // Measured live 2026-09-04 10:32: the refusal was computed only inside
    // the delivery-gate bounce, so the persisted m7 prompt held no "render
    // NOTHING", no unbound-art list and no CreatePrimitive line. Every sprint
    // resubmitted by an outage, a revival or a restart ran blind.
    buildSettings([["Assets/Scenes/Main.unity", 1]]);
    mkdirSync(join(projectRoot, "Assets", "Prefabs"), { recursive: true });
    writeFileSync(
      join(projectRoot, "Assets", "Prefabs", "Pig.prefab"),
      "%YAML 1.1\n--- !u!1 &7\nGameObject:\n  m_Name: Pig\n" +
        "--- !u!212 &8\nSpriteRenderer:\n  m_Sprite: {fileID: 21300000, guid: 22222222222222222222222222222222, type: 3}\n",
    );
    writeFileSync(
      join(projectRoot, "Assets", "Prefabs", "Pig.prefab.meta"),
      "fileFormatVersion: 2\nguid: 11111111111111111111111111111111\n",
    );

    await reachFinalSprint();

    const finalPrompt = tasks.submitted[2]!.prompt;
    expect(finalPrompt).toContain("MEASURED NOW");
    expect(finalPrompt).toContain("render NOTHING");
    expect(finalPrompt).toContain("Assets/Prefabs/Pig.prefab");
    // Earlier sprints are not judged on the whole tree's delivery shape.
    expect(tasks.submitted[0]!.prompt).not.toContain("MEASURED NOW");
  });

  it("delivers the real delivered shape and discloses every enabled scene", async () => {
    buildSettings(REAL_DELIVERED_BUILD, ["Assets/Scenes/Unused.unity"]);
    const campaign = await reachFinalSprint();

    settleMilestone("green, shipping");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"), { timeout: 15_000 });
    // `done` is persisted BEFORE the report is gathered and sent, so waiting
    // on the state alone races the delivery message (green locally, red in CI).
    await waitFor(() => expect(messages.some((m) => m.text.includes("Campaign delivery"))).toBe(true), { timeout: 15_000 });

    const report = messages.find((m) => m.text.includes("Campaign delivery"))!.text;
    // The build's FIRST enabled scene is what a person opens; the richest is
    // named beside it (Codex 2026-09-11 C#26).
    expect(report).toContain("FIRST enabled scene");
    expect(report).toContain("ProductionMain.unity");
    expect(report).toContain("13 other scenes are enabled");
    expect(report).toContain("10 of them");
    expect(report).toContain("TargetedLevel151Verification.unity");
    // The three that match neither rule are NOT called scaffolding.
    expect(report).toContain("3 match neither rule");
    // Untidy is disclosed, never refused — deleting a user's scenes is not
    // this system's call.
    expect(storage.get(campaign.id)!.milestones[2]!.sceneHygieneUnresolved).toBeUndefined();
  });

  it("a clean single-scene build discloses no scaffolding at all", async () => {
    buildSettings([["Assets/Scenes/Main.unity", 24]]);
    const campaign = await reachFinalSprint();

    settleMilestone("green, shipping");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"), { timeout: 15_000 });
    // `done` is persisted BEFORE the report is gathered and sent, so waiting
    // on the state alone races the delivery message (green locally, red in CI).
    await waitFor(() => expect(messages.some((m) => m.text.includes("Campaign delivery"))).toBe(true), { timeout: 15_000 });

    const report = messages.find((m) => m.text.includes("Campaign delivery"))!.text;
    expect(report).toContain("Assets/Scenes/Main.unity");
    expect(report).not.toContain("scaffolding");
    expect(report).not.toContain("other scenes are enabled");
  });

  it("refuses delivery when the build has no enabled scene at all", async () => {
    buildSettings([], ["Assets/Scenes/Main.unity"]);
    const campaign = await reachFinalSprint();

    settleMilestone("green, shipping");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));

    expect(storage.get(campaign.id)!.state).toBe("executing");
    expect(storage.get(campaign.id)!.milestones[2]!.sceneHygieneBounces).toBe(1);
    expect(tasks.submitted[3]!.prompt).toContain("NO ENTRY SCENE");
    expect(tasks.submitted[3]!.prompt).toContain("no scene is enabled");
    expect(messages.some((m) => m.text.includes("Campaign delivery"))).toBe(false);
  });

  it("a build with NO scene a person can open is not delivered (Codex 2026-09-12 R#7)", async () => {
    // This used to deliver with the refusal as a footnote: "🏁 Campaign
    // delivery" above "NO scene a person can open". The gate's own sentence is
    // "a delivery nobody can open is not a delivery", and the campaign is held
    // to it — the same rule the structural check and the compiler get. It is
    // not a wedge: the campaign revives its final sprint by itself.
    buildSettings([], ["Assets/Scenes/Main.unity"]);
    const campaign = await reachFinalSprint();

    let taskNo = 3;
    while (storage.get(campaign.id)!.state === "executing" && taskNo < 9) {
      const before = tasks.submitted.length;
      tasks.verifications.set(`task_${taskNo}`, {
        testsGreen: true,
        detail: "All 42 tests passed (unfiltered — the whole PlayMode suite)",
        unfiltered: true,
      });
      tasks.emit("task:completed", `task_${taskNo}`, "shipping it, honest");
      await waitFor(() =>
        expect(tasks.submitted.length > before || storage.get(campaign.id)!.state !== "executing").toBe(true),
      );
      taskNo++;
    }

    const after = storage.get(campaign.id)!;
    expect(after.state).not.toBe("done");
    expect(after.milestones[2]!.sceneHygieneBounces).toBe(2);
    expect(after.lastError).toContain("no scene a person can open");
    // …and every finding still travels with it.
    const said = messages.map((m) => m.text).join("\n");
    expect(said).toContain("NO ENTRY SCENE");
  });

  it("writes HOW_TO_RUN.md from measured facts and links it from the report", async () => {
    runRecordOnSettle = { total: 179, passed: 179, failed: 0, skipped: 0, unfiltered: true };
    // Measured 2026-09-03: the delivered project had no README at all, and
    // the report — a chat message — was the only thing that ever named the
    // entry scene.
    buildSettings(REAL_DELIVERED_BUILD);
    mkdirSync(join(projectRoot, "ProjectSettings"), { recursive: true });
    writeFileSync(
      join(projectRoot, "ProjectSettings", "ProjectVersion.txt"),
      "m_EditorVersion: 6000.3.22f1\nm_EditorVersionWithRevision: 6000.3.22f1 (1c726e1fb402)\n",
    );
    const coreLoopGdd = "# GDD\n\nCore mechanic\nTap a pig on the conveyor to send it to a tray slot.\n";
    writeFileSync(join(projectRoot, "docs", "Game_GDD.md"), coreLoopGdd);

    // The document on disk is the approved one (plan 1.9): the intake is given the same text.
    const campaign = await reachFinalSprint(coreLoopGdd);
    tasks.verifications.set("task_3", {
      testsGreen: true,
      detail: "PlayMode verification passed: 179 of 179 tests passed (unfiltered — the whole PlayMode suite)",
      unfiltered: true,
    });
    tasks.emit("task:completed", "task_3", "green, shipping");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"));

    const readme = readFileSync(join(projectRoot, "HOW_TO_RUN.md"), "utf8");
    expect(readme).toContain("6000.3.22f1");
    expect(readme).toContain("Assets/Scenes/ProductionMain.unity");
    expect(readme).toContain("Tap a pig on the conveyor");
    expect(readme).toContain("179 of 179");
    expect(readme).toContain("-testPlatform PlayMode");
    expect(readme).toContain("TargetedLevel151Verification.unity");
    expect(readme).not.toContain("Unknown");

    const report = messages.find((m) => m.text.includes("Campaign delivery"))!.text;
    expect(report).toContain("HOW_TO_RUN.md");
  });

  it("stores a delivery package a LATER PROCESS reads — the chat message is no longer the only copy", async () => {
    // plan 6.1. Everything a reviewer needs lived in one chat message: after a
    // restart, or in another browser, the portal had milestone titles and
    // nothing else. The package is a row keyed by the campaign.
    runRecordOnSettle = { total: 179, passed: 179, failed: 0, skipped: 0, unfiltered: true };
    buildSettings(REAL_DELIVERED_BUILD);
    mkdirSync(join(projectRoot, "ProjectSettings"), { recursive: true });
    writeFileSync(join(projectRoot, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.3.22f1\n");
    const gdd = "# GDD\n\nCore mechanic\nTap a pig on the conveyor to send it to a tray slot.\n";
    writeFileSync(join(projectRoot, "docs", "Game_GDD.md"), gdd);
    const campaign = await reachFinalSprint(gdd);
    tasks.verifications.set("task_3", {
      testsGreen: true,
      detail: "PlayMode verification passed: 179 of 179 tests passed (unfiltered — the whole PlayMode suite)",
      unfiltered: true,
    });
    tasks.emit("task:completed", "task_3", "green, shipping");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"));

    // The report POINTS AT the package rather than being it.
    const report = messages.find((m) => m.text.includes("Campaign delivery"))!.text;
    expect(report).toContain("Delivery package");
    expect(report).toContain(campaign.id);

    // A DIFFERENT PROCESS, reading the same row: this is the restart case.
    const store = new DeliveryPackageStore(join(projectRoot, ".strada", "delivery-packages.db"));
    try {
      const latest = store.latest(campaign.id);
      expect(latest?.revision).toBe(1);
      // Every piece is a row, in order — including the ones nothing measured.
      expect(latest?.package.pieces.map((p) => p.id)).toEqual([...DELIVERY_PIECE_ORDER]);
      const run = latest!.package.pieces.find((p) => p.id === "run-command")!;
      expect(run.state).toBe("present");
      expect(run.locators?.some((l) => l.value === "HOW_TO_RUN.md")).toBe(true);
      expect(run.locators?.some((l) => l.value.includes("-testPlatform PlayMode"))).toBe(true);
      // The checklist is the ladder as the campaign recorded it.
      const checklist = latest!.package.pieces.find((p) => p.id === "checklist")!;
      expect((checklist.items ?? []).length).toBeGreaterThan(0);
      // Nothing here claims a cost the budget ledger cannot key to this work.
      const cost = latest!.package.pieces.find((p) => p.id === "cost")!;
      expect(cost.summary).toContain("cost NOT MEASURED");
    } finally {
      store.close();
    }

    // …and what the portal is served is that row, not what a page assembled.
    const view = manager.describeDeliveryPackages();
    expect(view.latest?.campaignId).toBe(campaign.id);
    expect(view.index[0]).toMatchObject({ campaignId: campaign.id, revision: 1 });
    expect(view.note).toBeUndefined();
  });

  it("never serves another campaign's package for the campaign the card is showing", async () => {
    const campaign = await reachFinalSprint();
    // Some earlier campaign's package is the newest one on the machine.
    const store = new DeliveryPackageStore(join(projectRoot, ".strada", "delivery-packages.db"));
    store.put(
      assembleDeliveryPackage({
        campaign: { id: "campaign_earlier", projectRoot, state: "done", milestones: [], createdAt: 1, updatedAt: 2 },
      }),
    );
    store.close();

    const view = manager.describeDeliveryPackages();
    // The card shows THIS campaign's ladder, so it is told this campaign has no
    // package — not handed the other one, which would need an explanation.
    expect(view.latest).toBeNull();
    expect(view.note).toContain(campaign.id);
    expect(view.note).toContain("no stored delivery package yet");
    expect(view.index.map((r) => r.campaignId)).toEqual(["campaign_earlier"]);
  });

  it("HOW_TO_RUN.md says Unknown, with the reason, for what nothing measured", async () => {
    runRecordOnSettle = { total: 179, passed: 179, failed: 0, skipped: 0, unfiltered: true };
    // No ProjectVersion.txt, no core-mechanic field in the GDD, and a final
    // sprint whose verdict named no suite: three unmeasured fields that must
    // read as unmeasured, not be quietly dropped.
    buildSettings([["Assets/Scenes/Main.unity", 9]]);
    const campaign = await reachFinalSprint();
    tasks.verifications.set("task_3", {
      testsGreen: true,
      detail: "All 42 tests passed (unfiltered)",
      unfiltered: true,
    });
    tasks.emit("task:completed", "task_3", "green, shipping");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"));

    const readme = readFileSync(join(projectRoot, "HOW_TO_RUN.md"), "utf8");
    expect(readme).toContain("Unknown — ProjectSettings/ProjectVersion.txt could not be read");
    expect(readme).toContain("names no core-mechanic field");
    // (A delivered campaign now always carries an unfiltered run record, so the
    // "which suite ran" field can no longer be Unknown at delivery — Codex
    // 2026-09-11 D#13.)
    // What WAS measured is still stated.
    expect(readme).toContain("Assets/Scenes/Main.unity");
    // The record is the source of the suite line now (Codex 2026-09-11 D#13).
    expect(readme).toContain("179 of 179 tests passed");
  });

  it("keeps refusing delivery while the final sprint has attempts left", async () => {
    runRecordOnSettle = undefined; // this sprint leaves no NUnit record
    // Measured live 2026-09-03 08:33: the gate bounced once, the second
    // attempt also ran no tests, the single bounce was spent, and the ladder
    // delivered a game whose suite was never seen to pass.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    // Final sprint completes with NO test verdict — twice.
    tasks.emit("task:completed", "task_3", "shipping it");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));
    expect(tasks.submitted[3]!.prompt).toContain("DELIVERY VERIFICATION REQUIRED");

    // Other gates (visual evidence, no-work) can bounce a settle first, so
    // keep settling until the delivery gate has spent its budget.
    let taskNo = 4;
    while ((storage.get(campaign.id)!.milestones[2]!.deliveryVerificationBounces ?? 0) < 2 && taskNo < 9) {
      const submittedBefore = tasks.submitted.length;
      tasks.emit("task:completed", `task_${taskNo}`, "shipping it, honest");
      await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(submittedBefore));
      taskNo++;
    }

    const after = storage.get(campaign.id)!;
    expect(after.state).toBe("executing");
    expect(after.milestones[2]!.deliveryVerificationBounces).toBe(2);
    // The repeat is charged, so the milestone's attempt budget bounds it.
    expect(after.milestones[2]!.attempts).toBeGreaterThan(1);
    expect(messages.some((m) => m.text.includes("Campaign delivery"))).toBe(false);
  });

  it("refuses delivery when the FINAL sprint never ran its tests (one bounce)", async () => {
    runRecordOnSettle = undefined; // this sprint leaves no NUnit record
    // Audited 2026-09-01: "full unfiltered suite" was only prose in the
    // planner prompt — a final sprint whose task printed no test result
    // carried no verdict and delivery was declared anyway.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    // Final sprint completes with NO observed test verdict.
    tasks.emit("task:completed", "task_3", "everything works, shipping it");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));

    expect(storage.get(campaign.id)!.state).toBe("executing");
    expect(tasks.submitted[3]!.prompt).toContain("DELIVERY VERIFICATION REQUIRED");
    expect(messages.some((m) => m.text.includes("Campaign delivery"))).toBe(false);
  });

  // ── Structural delivery gate (audited 2026-09-03) ────────────────────────
  // 7/7 sprints green and 11351 captured frames said nothing about a delivery
  // whose entry scene held zero renderer components.

  /** Writes a file plus the .meta sidecar Unity uses to address it by guid. */
  const putAsset = (rel: string, body: string, guid?: string): void => {
    const abs = join(projectRoot, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
    if (guid) writeFileSync(`${abs}.meta`, `fileFormatVersion: 2\nguid: ${guid}\n`);
  };
  const UNITY_HEADER = "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n";
  const CAMERA_DOC = "--- !u!20 &900\nCamera:\n  m_Enabled: 1\n  orthographic: 0\n";
  const PIG_PREFAB =
    `${UNITY_HEADER}--- !u!1 &7\nGameObject:\n  m_Name: Pig\n` +
    "--- !u!212 &8\nSpriteRenderer:\n  m_Enabled: 1\n  m_Materials:\n" +
    "  - {fileID: 2100000, guid: aaaabbbbccccddddeeeeffff00001111, type: 2}\n" +
    "  m_Sprite: {fileID: 21300000, guid: 22222222222222222222222222222222, type: 3}\n";

  const buildList = (scenes: string[]): void =>
    putAsset(
      "ProjectSettings/EditorBuildSettings.asset",
      `EditorBuildSettings:\n  m_Scenes:\n${scenes
        .map((p, i) => `  - enabled: 1\n    path: ${p}\n    guid: ${String(i).padStart(32, "a")}\n`)
        .join("")}`,
    );

  /** The delivered PixelFlow shape: a scene with a camera and nothing else. */
  const writeSlopProject = (): void => {
    buildList(["Assets/Scenes/ProductionMain.unity"]);
    putAsset("Assets/Scenes/ProductionMain.unity", `${UNITY_HEADER}${CAMERA_DOC}`, "5ce5e5e5e5e5e5e5e5e5e5e5e5e5e5e5");
    putAsset("Assets/Prefabs/Pig.prefab", PIG_PREFAB, "11111111111111111111111111111111");
    putAsset("Assets/Art/pig.png", "pixels", "22222222222222222222222222222222");
    putAsset(
      "Assets/Scripts/PlayfieldBuilder.cs",
      "class PlayfieldBuilder { void B() { GameObject.CreatePrimitive(PrimitiveType.Cube); } }",
      "66666666666666666666666666666666",
    );
  };

  /** The same project with the prefab actually placed in the shipped scene. */
  const writeBuiltProject = (): void => {
    writeSlopProject();
    putAsset(
      "Assets/Scenes/ProductionMain.unity",
      `${UNITY_HEADER}${CAMERA_DOC}--- !u!1001 &1001\nPrefabInstance:\n  m_Modification:\n    m_Modifications: []\n` +
        "  m_SourcePrefab: {fileID: 100100000, guid: 11111111111111111111111111111111, type: 3}\n",
      "5ce5e5e5e5e5e5e5e5e5e5e5e5e5e5e5",
    );
  };

  const runLadderToDelivery = async (campaignGdd = "# GDD"): Promise<ReturnType<typeof manager.startFromGdd>> => {
    const campaign = manager.startFromGdd(ctx, campaignGdd, "docs/Game_GDD.md");
    // Five seconds, not vitest's default one: these settles do real filesystem
    // work and the default timed out under a full-suite run twice today —
    // a slow machine is not a defect in the ladder.
    const settled = (n: number): Promise<void> =>
      waitFor(() => expect(tasks.submitted).toHaveLength(n), { timeout: 15_000 });
    await settled(1);
    settleMilestone("sprint A done");
    await settled(2);
    settleMilestone("sprint B done");
    await settled(3);
    return campaign;
  };

  it("tells the channel ONCE when the Unity link is dead, and the report carries it", async () => {
    // Audited 2026-09-06: three dead-link failures in one campaign, zero words
    // to the person who alone can re-link. The purchased library is the only
    // real-art source; its death is news.
    const DEAD = "The Unity account link expired or was revoked — re-run the Unity Link step. Detail: token refresh returned HTTP 412";
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));

    // settleMilestone() overwrites the verification with its own green; set
    // ours and emit directly, green AND blind, so the ladder still walks.
    const GREEN = "All 42 tests passed (unfiltered — the whole PlayMode suite)";
    tasks.verifications.set("task_1", { testsGreen: true, detail: GREEN, unfiltered: true, assetSourcingBlind: DEAD } as never);
    tasks.emit("task:completed", "task_1", "sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    const told = messages.filter((m) => m.text.includes("Asset sourcing is BLIND"));
    expect(told).toHaveLength(1);
    expect(told[0]!.text).toContain("strada unity-link");
    expect(storage.get(campaign.id)!.milestones[0]!.assetSourcingBlind).toContain("HTTP 412");

    // A second affected sprint does not repeat the alarm…
    tasks.verifications.set("task_2", { testsGreen: true, detail: GREEN, unfiltered: true, assetSourcingBlind: DEAD } as never);
    tasks.emit("task:completed", "task_2", "sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    expect(messages.filter((m) => m.text.includes("Asset sourcing is BLIND"))).toHaveLength(1);

    // …but the delivery report names every sprint it happened to.
    compileVerdict = { ok: true, ran: true, errors: 0 };
    tasks.verifications.set("task_3", {
      testsGreen: true,
      detail: "PlayMode verification passed: 179 of 179 tests passed (unfiltered — the whole PlayMode suite)",
      unfiltered: true,
    });
    tasks.emit("task:completed", "task_3", "shipping it");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"), { timeout: 15_000 });
    // `done` is persisted BEFORE the report is gathered and sent, so waiting
    // on the state alone races the delivery message (green locally, red in CI).
    await waitFor(() => expect(messages.some((m) => m.text.includes("Campaign delivery"))).toBe(true), { timeout: 15_000 });
    const report = messages.map((m) => m.text).find((t) => t.includes("Campaign delivery"))!;
    expect(report).toContain("asset sourcing BLIND");
    expect((report.match(/purchased library was unreachable/g) ?? []).length).toBe(2);
  });

  it("refuses to deliver a tree that does not compile, and says so first", async () => {
    // Measured live 2026-09-04 21:37: Sprint 7 was committed green (1296
    // files, f674e8d) and the campaign delivered while the tree carried 37
    // compile errors — found seconds later by the real-tree guardian, and by
    // no gate at all. Every other gate reads what a run REPORTED; none asked
    // the compiler.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    compileVerdict = { ok: false, ran: true, errors: 37, detail: "Headless compile failed with 37 error(s)." };
    // An UNFILTERED green — the strongest evidence a sprint can bring. It is
    // still not delivery while the project does not build.
    tasks.verifications.set("task_3", {
      testsGreen: true,
      detail: "PlayMode verification passed: 179 of 179 tests passed (unfiltered — the whole PlayMode suite)",
      unfiltered: true,
    });
    tasks.emit("task:completed", "task_3", "shipping it");

    await waitFor(() => expect(tasks.submitted).toHaveLength(4));
    expect(storage.get(campaign.id)!.state).toBe("executing");
    // The compiler leads the bounce: a suite run means nothing until it builds.
    const prompt = tasks.submitted[3]!.prompt;
    expect(prompt).toContain("THE PROJECT DOES NOT COMPILE");
    expect(prompt).toContain("37 error(s)");
    expect(prompt.indexOf("THE PROJECT DOES NOT COMPILE")).toBeLessThan(
      prompt.indexOf("DELIVERY VERIFICATION REQUIRED"),
    );
  });

  it("delivers on an unfiltered green once the project compiles", async () => {
    // The other half of the same gate: it must not become a wall.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    compileVerdict = { ok: true, ran: true, errors: 0 };
    tasks.verifications.set("task_3", {
      testsGreen: true,
      detail: "PlayMode verification passed: 179 of 179 tests passed (unfiltered — the whole PlayMode suite)",
      unfiltered: true,
    });
    tasks.emit("task:completed", "task_3", "shipping it");

    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"), { timeout: 15_000 });
    // `done` is persisted BEFORE the report is gathered and sent, so waiting
    // on the state alone races the delivery message (green locally, red in CI).
    await waitFor(() => expect(messages.some((m) => m.text.includes("Campaign delivery"))).toBe(true), { timeout: 15_000 });
    const report = messages.map((m) => m.text).find((t) => t.includes("Campaign delivery"))!;
    expect(report).toContain("compiles");
  });

  it("a sprint that FAILED still records the gap it reported (Codex 2026-09-12 T#3)", async () => {
    // The gap was recorded beside each excerpt, and the paths that return
    // early never reached one: a sprint could fail with a capability marker in
    // its output and leave nothing for the delivery gate to see.
    const campaign = await runLadderToDelivery();
    const failing = storage.get(campaign.id)!.milestones[2]!.taskId!;
    tasks.emit(
      "task:failed",
      failing,
      "EVIDENCE UNAVAILABLE — no tool for it in this run: unity_create_scene (the Unity bridge is not connected). " +
      "That work is NOT done.\n\nthe sprint could not finish",
    );

    await waitFor(() => {
      expect(storage.get(campaign.id)!.milestones[2]!.capabilityGap).toContain("unity_create_scene");
    });
  });

  it("a capability gap is THIS run's, not a permanent mark (Codex 2026-09-12 T#2)", async () => {
    // Merging the new gap with the old made it permanent, and the delivery
    // gate scans every milestone: one report of a missing tool meant the
    // campaign could never deliver again, however many clean runs followed.
    const campaign = await runLadderToDelivery();
    // The final sprint reports a gap and bounces…
    settleMilestone(
      "EVIDENCE UNAVAILABLE — no tool for it in this run: unity_create_scene (the Unity bridge is not connected). " +
      "That work is NOT done.\n\nintegrated, all 42 tests pass",
    );
    await waitFor(() => expect(storage.get(campaign.id)!.milestones[2]!.capabilityGap).toBeDefined());

    // …a sprint is scheduled for the work, and the next attempt of the sprint
    // that reported it starts with NO gap: the tool may be back by then, and
    // the old mark must not decide for it.
    await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(3));
    settleMilestone("the scene is built now, all 42 tests pass");

    await waitFor(() => {
      const m = storage.get(campaign.id)!.milestones.find((x) => x.coverageGap?.includes("unity_create_scene"));
      expect(m?.status === "green" || m?.status === "running").toBe(true);
    });
    const cleared = storage.get(campaign.id)!.milestones.find((x) => x.coverageGap?.includes("unity_create_scene"))!;
    expect(cleared.capabilityGap).toBeUndefined();

  });

  it("a capability gap its repair CLOSED is not scheduled again (Codex 2026-09-12 U#F1)", async () => {
    // Scheduling the gap as work made it satisfiable (T#2), but nothing ever
    // cleared the field on the sprint that reported it — and capability work
    // reopens completed sprints, because a fresh audit outranks a finished
    // one. So a SUCCESSFUL repair was scheduled again on every settlement:
    // an endless series of coverage sprints instead of a delivery.
    // Since 2026-09-17 every coverage sprint is asked about at closure (audit
    // 06.1), this one included: the audit says the repaired capability IS
    // delivered, so the campaign delivers. (A green sprint's own word is not
    // evidence; the audit's answer is.)
    (manager as unknown as { planner: { resolveCoverageGaps: unknown } }).planner.resolveCoverageGaps =
      vi.fn(async (_gdd: string, reqs: readonly string[]) => ({ closed: [...reqs], open: [] }));
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    const settled = (n: number): Promise<void> =>
      waitFor(() => expect(tasks.submitted).toHaveLength(n), { timeout: 15_000 });
    await settled(1);
    // The FIRST sprint reports the gap — a historical mark on a milestone the
    // ladder never revisits, unlike the final sprint's own per-attempt read.
    settleMilestone(
      "EVIDENCE UNAVAILABLE — no tool for it in this run: unity_generate_audio (the Unity bridge is not connected). " +
      "That work is NOT done.\n\nsprint A done",
    );
    await settled(2);
    await waitFor(() => expect(storage.get(campaign.id)!.milestones[0]!.capabilityGap).toContain("unity_generate_audio"));
    settleMilestone("sprint B done");
    await settled(3);

    // Delivery appends the repair sprint for it…
    settleMilestone("integrated, all 42 tests pass");
    await settled(4);
    const repair = storage.get(campaign.id)!.milestones.find((m) => m.coverageGap?.includes("unity_generate_audio"));
    expect(repair).toBeDefined();

    // …the repair succeeds, and the campaign DELIVERS: no second round for
    // work that is done, and the mark it closed is gone.
    // …the repair succeeds, and every sprint after it reports success too. A
    // bounded walk: the defect is unbounded, so running out of settles IS the
    // failure this test is looking for.
    for (let i = 0; i < 12 && storage.get(campaign.id)!.state === "executing"; i++) {
      const before = tasks.submitted.length;
      settleMilestone("the missing audio is generated and bound, a frame is captured, all 42 tests pass");
      await waitFor(
        () => expect(tasks.submitted.length > before || storage.get(campaign.id)!.state !== "executing").toBe(true),
        { timeout: 15_000 },
      );
    }

    const after = storage.get(campaign.id)!;
    expect(after.state).toBe("done");
    // The mark its repair closed is gone, and the work was scheduled ONCE.
    expect(after.milestones[0]!.capabilityGap).toBeUndefined();
    expect(after.milestones.filter((m) => m.coverageGap?.includes("unity_generate_audio"))).toHaveLength(1);
  });

  it("a capability requirement is repaired TWICE, then reported (Codex 2026-09-12 V#1)", async () => {
    // Capability work reopens completed sprints, and every round minted a new
    // sprint identity with a fresh attempt budget for the same requirement —
    // while this path returns before any delivery counter is charged. Codex
    // ran twenty cycles: twenty-three sprints, forty submissions, all three
    // revival counters still at zero, campaign still `executing`.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    const settled = (n: number): Promise<void> =>
      waitFor(() => expect(tasks.submitted).toHaveLength(n), { timeout: 15_000 });
    await settled(1);
    settleMilestone(
      "EVIDENCE UNAVAILABLE — no tool for it in this run: unity_generate_audio (the Unity bridge is not connected). " +
      "That work is NOT done.\n\nsprint A done",
    );
    await settled(2);
    settleMilestone("sprint B done");
    await settled(3);
    settleMilestone("integrated, all 42 tests pass");
    await settled(4);

    // Every repair for it fails; every other sprint reports success. The walk
    // is bounded, so a ladder that keeps growing IS the failure here.
    for (let i = 0; i < 40 && storage.get(campaign.id)!.state === "executing"; i++) {
      const live = storage.get(campaign.id)!;
      const current = live.milestones[live.currentMilestone]!;
      const before = tasks.submitted.length;
      if (current.id.startsWith("mcov")) tasks.emit("task:failed", `task_${before}`, "still no tool for the audio work");
      else settleMilestone("the proofs are green");
      await waitFor(
        () => expect(tasks.submitted.length > before || storage.get(campaign.id)!.state !== "executing").toBe(true),
        { timeout: 15_000 },
      );
    }

    const end = storage.get(campaign.id)!;
    expect(end.state).not.toBe("executing");
    expect(end.state).not.toBe("done");
    // Two repairs for the requirement, and then it is REPORTED, not repaired.
    const repairs = end.milestones.filter((m) => m.coverageGap?.includes("unity_generate_audio"));
    expect(repairs).toHaveLength(2);
    expect(`${end.lastError}`).toMatch(/unity_generate_audio|no sprint closed/);
  });

  it("a GREEN repair that still reports the gap closes nothing, and the budget still stops (Codex 2026-09-12 V#3)", async () => {
    // A milestone can go green and carry a fresh capability gap of its own,
    // and reconciliation treated every green repair as closure — so the
    // repair reconciled the very gap it was reporting, both marks vanished,
    // and the campaign delivered with the work never done.
    const GAP =
      "EVIDENCE UNAVAILABLE — no tool for it in this run: unity_generate_audio (the Unity bridge is not connected). " +
      "That work is NOT done.";
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    const settled = (n: number): Promise<void> =>
      waitFor(() => expect(tasks.submitted).toHaveLength(n), { timeout: 15_000 });
    await settled(1);
    settleMilestone(`${GAP}\n\nsprint A done`);
    await settled(2);
    settleMilestone("sprint B done");
    await settled(3);
    settleMilestone("integrated, all 42 tests pass");
    await settled(4);

    // Every repair reports SUCCESS and reports the missing tool in the same
    // breath — the exact shape that erased both marks.
    for (let i = 0; i < 40 && storage.get(campaign.id)!.state === "executing"; i++) {
      const live = storage.get(campaign.id)!;
      const current = live.milestones[live.currentMilestone]!;
      const before = tasks.submitted.length;
      settleMilestone(current.id.startsWith("mcov") ? `${GAP}\n\ndid what I could, all 42 tests pass` : "the proofs are green");
      await waitFor(
        () => expect(tasks.submitted.length > before || storage.get(campaign.id)!.state !== "executing").toBe(true),
        { timeout: 15_000 },
      );
    }

    const end = storage.get(campaign.id)!;
    expect(end.state).not.toBe("done");
    expect(end.milestones.filter((m) => m.coverageGap?.includes("unity_generate_audio"))).toHaveLength(2);
    expect(`${end.lastError}`).toMatch(/unity_generate_audio|no sprint closed/);
    // The mark on the sprint that reported it is still there: nothing proved
    // the work.
    expect(end.milestones[0]!.capabilityGap).toContain("unity_generate_audio");
  });

  it("the capability gap survives a long report (Codex 2026-09-12 S#10)", async () => {
    // The gap is reported at the TOP of a node's output and the milestone
    // keeps the last 500 characters, so a long report pushed it out of the
    // excerpt and the delivery gate found nothing to block on.
    const campaign = await runLadderToDelivery();
    settleMilestone(
      "EVIDENCE UNAVAILABLE — no tool for it in this run: unity_create_scene (the Unity bridge is not connected). " +
      "That work is NOT done.\n\n" + "x".repeat(2_000) + "\nintegrated, all 42 tests pass",
    );

    await waitFor(() => expect(storage.get(campaign.id)!.milestones.length).toBeGreaterThan(3));

    const after = storage.get(campaign.id)!;
    expect(after.milestones[2]!.resultExcerpt).not.toContain("EVIDENCE UNAVAILABLE");
    expect(after.milestones[2]!.capabilityGap).toContain("unity_create_scene");
    expect(after.state).not.toBe("done");
    expect(after.milestones.some((m) => m.coverageGap?.includes("unity_create_scene"))).toBe(true);
  });

  it("a sprint with no tool for part of its work blocks delivery (Codex 2026-09-12 R#1)", async () => {
    // Measured live 2026-09-12: the Unity Editor was down, unity_create_scene
    // was hidden, and the node reported the gap. Delivery may not step over a
    // piece of work nothing in the run could even attempt.
    const campaign = await runLadderToDelivery();
    settleMilestone(
      "EVIDENCE UNAVAILABLE — no tool for it in this run: unity_create_scene (the Unity bridge is not connected). " +
      "That work is NOT done and nothing in this report should be read as proof of it.\n\nintegrated, all 42 tests pass",
    );

    await waitFor(() => expect(storage.get(campaign.id)!.milestones.length).toBeGreaterThan(3));

    const after = storage.get(campaign.id)!;
    expect(after.state).not.toBe("done");
    // The work nothing could attempt is SCHEDULED, not marked forever: a
    // sprint carries it, and delivery waits for that sprint.
    const gapSprint = after.milestones.find((m) => m.coverageGap?.includes("unity_create_scene"));
    expect(gapSprint).toBeDefined();
    // Scheduled, and possibly already picked up — either way delivery waits
    // for it. (CI caught this as "running" where the local run saw "pending".)
    expect(["pending", "running"]).toContain(gapSprint!.status);
  });

  it("does NOT declare delivery once the structural refusal has outlasted its budget", async () => {
    // Measured live 2026-09-04 21:37. The campaign printed
    //   🏁 Campaign delivery — game built, 1 sprint did NOT land green
    // directly above
    //   REFUSAL STANDS, bounce budget spent: The shipped scenes render NOTHING
    //   … 360 assets that no enabled scene reaches
    // The findings were right; the first line a person reads said the opposite.
    writeSlopProject();
    const campaign = await runLadderToDelivery();

    // Every gate bounces this tree for its own reason; keep completing until
    // the ladder runs out of budget, which is the state under test.
    for (let i = 0; i < 8 && storage.get(campaign.id)!.state === "executing"; i++) {
      const before = tasks.submitted.length;
      settleMilestone(`integrated, all 42 tests pass (round ${i})`);
      await new Promise((r) => setTimeout(r, 120));
      if (tasks.submitted.length === before) break;
    }

    await waitFor(() => expect(storage.get(campaign.id)!.state).not.toBe("executing"));
    expect(storage.get(campaign.id)!.state).toBe("failed");
    const report = messages.map((m) => m.text).find((t) => t.includes("NOT DELIVERED"))!;
    expect(report).toBeDefined();
    // The refusal is the headline, not a footnote…
    expect(report.split("\n")[0]).toContain("NOT DELIVERED");
    // …and nothing is hidden: the findings still travel with it.
    expect(report).toContain("render NOTHING");
    expect(report).toContain("kampanya devam");
    // Never a done campaign, and never a delivery flag.
    expect(storage.get(campaign.id)!.state).not.toBe("done");
    expect(storage.get(campaign.id)!.deliveryReported).not.toBe(true);
  });

  it("refuses delivery when the shipped scenes render nothing and the art sits unbound", async () => {
    writeSlopProject();
    const campaign = await runLadderToDelivery();

    settleMilestone("integrated, all 42 tests pass");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));

    const after = storage.get(campaign.id)!;
    expect(after.state).toBe("executing");
    expect(after.milestones[2]!.structureRefused).toBe(true);
    // The bounce shares the delivery budget rather than opening a new one.
    expect(after.milestones[2]!.deliveryVerificationBounces).toBe(1);
    const prompt = tasks.submitted[3]!.prompt;
    expect(prompt).toContain("DELIVERY REFUSED — THE GAME IS NOT BUILT AS THE GDD SPECIFIES");
    expect(prompt).toContain("Assets/Scenes/ProductionMain.unity");
    expect(prompt).toContain("0 renderer components");
    expect(prompt).toContain("Assets/Prefabs/Pig.prefab");
    expect(prompt).toContain("GameObject.CreatePrimitive");
    expect(messages.some((m) => m.text.includes("Campaign delivery"))).toBe(false);
  });

  it("delivers a scene that places real prefabs, and the report says what it measured", async () => {
    writeBuiltProject();
    const campaign = await runLadderToDelivery();

    settleMilestone("integrated, all 42 tests pass");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"));

    expect(storage.get(campaign.id)!.milestones[2]!.structureRefused).not.toBe(true);
    const report = messages.at(-1)!.text;
    expect(report).toContain("What the shipped scenes actually contain");
    expect(report).toContain("Shipped scenes PLACE 1 renderer component");
    expect(report).toContain("Assets/Scenes/ProductionMain.unity");
  });

  it("discloses the GDD's own dimensionality against the shipped scenes, without refusing", async () => {
    // Audited 2026-09-03: the GDD says "plump, glossy 3D-feel pigs" and the
    // delivered scenes had no mesh renderers and bound none of the project's
    // 62 imported models. A stylised 3D-feel look CAN be built from sprites,
    // so this is disclosure with counts — the reader judges.
    writeBuiltProject();
    const campaign = await runLadderToDelivery(
      "# GDD\n\n12. ART DIRECTION\nplump, glossy 3D-feel pigs on softly rendered dimensional stages.",
    );

    settleMilestone("integrated, all 42 tests pass");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"), { timeout: 15_000 });
    // `done` is persisted BEFORE the report is gathered and sent, so waiting
    // on the state alone races the delivery message (green locally, red in CI).
    await waitFor(() => expect(messages.some((m) => m.text.includes("Campaign delivery"))).toBe(true), { timeout: 15_000 });

    const report = messages.at(-1)!.text;
    expect(report).toContain("The GDD asks for 3D");
    expect(report).toContain("0 mesh renderer(s)");
    expect(report).toContain("1 sprite renderer(s)");
    expect(report).toContain("Camera projection in the shipped scenes: 0 orthographic, 1 perspective");
    // Disclosure only — the campaign still delivered.
    expect(storage.get(campaign.id)!.milestones[2]!.structureRefused).not.toBe(true);
  });

  it("says the shipped scenes were NOT structurally checked rather than passing silently", async () => {
    // No Assets/ tree at all: the check cannot measure, and the delivery
    // report must not read like one that measured and found nothing wrong.
    const campaign = await runLadderToDelivery();
    settleMilestone("integrated, all 42 tests pass");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"), { timeout: 15_000 });
    // `done` is persisted BEFORE the report is gathered and sent, so waiting
    // on the state alone races the delivery message (green locally, red in CI).
    await waitFor(() => expect(messages.some((m) => m.text.includes("Campaign delivery"))).toBe(true), { timeout: 15_000 });

    const report = messages.at(-1)!.text;
    expect(report).toContain("NOT measured: no Assets/ directory");
    expect(storage.get(campaign.id)!.milestones[2]!.structureRefused).not.toBe(true);
  });

  it("a milestone retry carries the previous attempt's progress without persisting it", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));

    tasks.progressBlocks.set(
      "task_1",
      "\n\nPREVIOUS ATTEMPT PROGRESS (verify before redoing any of it):\n- Assets/Scripts/Board.cs",
    );
    tasks.emit("task:failed", "task_1", "compile exploded");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));

    // The SUBMITTED prompt carries the progress block…
    expect(tasks.submitted[1]!.prompt).toContain("PREVIOUS ATTEMPT PROGRESS");
    expect(tasks.submitted[1]!.prompt).toContain("Assets/Scripts/Board.cs");
    // …but the persisted milestone prompt does not (no accumulation).
    const fresh = storage.get(campaign.id)!;
    expect(fresh.milestones[0]!.prompt).not.toContain("PREVIOUS ATTEMPT PROGRESS");
  });

  it("strips retry-machinery noise from the failure tail and keeps only one tail", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));

    // (Reaped/Auto-retry wording is settlement-deferred by design, so the
    // noise strip is exercised with the non-deferring machinery preface.)
    tasks.emit(
      "task:failed",
      "task_1",
      "Transient failure — worker crashed mid-epoch. Board.cs does not compile",
    );
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    const prompt1 = storage.get(campaign.id)!.milestones[0]!.prompt;
    expect(prompt1).toContain("Board.cs does not compile");
    expect(prompt1).not.toContain("Transient failure —");
  });

  it("rejects a completion that left the repository untouched (one no-work bounce)", async () => {
    const { execFileSync } = await import("node:child_process");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-qm", "baseline");
    // Commit timestamps are second-granular; the sprint must start strictly
    // after the baseline's second for "unchanged since sprint start" to hold.
    await new Promise((r) => setTimeout(r, 1100));

    // The approved text is the file already committed: intake writes nothing,
    // so the tree is exactly as untouched as the sprint left it (plan 1.9).
    const campaign = manager.startFromGdd(ctx, readFileSync(join(projectRoot, "docs", "Game_GDD.md"), "utf8"), "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));

    // Completion with a clean tree and no commits since the sprint began.
    settleMilestone("sprint A done (allegedly)");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    const bounced = storage.get(campaign.id)!;
    expect(bounced.milestones[0]!.status).toBe("running");
    expect(bounced.milestones[0]!.prompt).toContain("NO WORK DETECTED");
    expect(bounced.milestones[0]!.attempts).toBe(1); // bounce burned no attempt

    // Second completion stands either way (one bounce per milestone).
    settleMilestone("sprint A done again");
    await waitFor(() => expect(storage.get(campaign.id)!.milestones[0]!.status).toBe("green"));
  });

  it("time-box forces scope narrowing when a sprint spins past its budget", async () => {
    // Measured 2026-08-31: m6 ran 22h at attempts=1 because bounces and
    // deferrals deliberately never burn attempts — nothing bounded the run.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));

    // Backdate the clock past the box, then settle badly.
    const stored = storage.get(campaign.id)!;
    stored.milestones[0]!.startedAtMs = Date.now() - 3 * 60 * 60_000;
    storage.save(stored);

    tasks.emit("task:failed", "task_1", "compile still red");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));

    const fresh = storage.get(campaign.id)!;
    expect(tasks.submitted[1]!.prompt).toContain("TIME BOX");
    expect(tasks.submitted[1]!.prompt).toContain("NARROW THE SCOPE");
    expect(fresh.milestones[0]!.timeBoxEscalations).toBe(1);
    expect(fresh.milestones[0]!.attempts).toBe(1); // escalation burns no attempt

    // A second overrun replaces the directive instead of stacking it.
    // Measured 2026-09-07 14:20: "TIME BOX (6h …, escalation 1/2)" and
    // "TIME BOX (7h …, escalation 1/2)" back to back in one prompt.
    const again = storage.get(campaign.id)!;
    again.milestones[0]!.startedAtMs = Date.now() - 3 * 60 * 60_000;
    storage.save(again);
    tasks.emit("task:failed", "task_2", "compile still red");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3), { timeout: 15_000 });
    const prompt = tasks.submitted[2]!.prompt;
    expect(prompt.match(/TIME BOX \(/g)).toHaveLength(1);
    expect(prompt).toContain("escalation 2/2");
    expect(messages.some((m) => m.text.includes("narrowing scope"))).toBe(true);
  });

  it("the time box does not supersede an attempt that finished while it warned (Codex 2026-09-13 AK#7)", async () => {
    // Sending the warning is an await, and a worker that completes during it
    // has published its work: the escalation cancelled a task that had just
    // succeeded, submitted a replacement, and the queued completion was then
    // discarded as a stale ancestor's.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const stored = storage.get(campaign.id)!;
    stored.milestones[0]!.startedAtMs = Date.now() - 3 * 60 * 60_000;
    storage.save(stored);

    // The task settles DURING the warning send, which is what `tell` awaits.
    messengerHook = () => { tasks.setStatus("task_1", TaskStatus.completed); };
    const escalated = await (manager as unknown as {
      escalateIfPastTimeBox(c: unknown, m: unknown): Promise<boolean>;
    }).escalateIfPastTimeBox(storage.get(campaign.id), storage.get(campaign.id)!.milestones[0]);
    messengerHook = undefined;

    expect(escalated).toBe(true);
    // No replacement: the finished attempt answers for itself.
    expect(tasks.submitted).toHaveLength(1);
    expect(tasks.cancelled).not.toContain("task_1");
  });

  it("the time-box binds the ADOPTION path too (a sprint cannot spin forever unadjudicated)", async () => {
    // Measured 2026-09-01: m6 ran 7h+ with timeBoxEscalations=0 because every
    // settle was adopted as an executor retry and never reached an outcome.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));

    const stored = storage.get(campaign.id)!;
    stored.milestones[0]!.startedAtMs = Date.now() - 4 * 60 * 60_000;
    storage.save(stored);

    // Executor mints a live retry under a new id: the adoption path.
    const retryId = tasks.addRetry("task_1", TaskStatus.executing);
    tasks.emit("task:blocked", "task_1", "Reaped: no progress signal for 60 minutes.");
    void retryId;

    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    const fresh = storage.get(campaign.id)!;
    expect(fresh.milestones[0]!.timeBoxEscalations).toBe(1);
    expect(tasks.submitted[1]!.prompt).toContain("NARROW THE SCOPE");
  });

  it("an outage-caused settle parks the campaign WITHOUT charging an attempt, and recovery resubmits", async () => {
    // Measured 2026-09-01 16:16: attempts 1→2 during a four-account quota
    // wall. And 2026-09-08 01:08: a resubmit into the wall seeded a 2000-file
    // lease and blocked 38 s later — so the park happens BEFORE any submit.
    const { ProviderHealthRegistry } = await import("../agents/providers/provider-health.js");
    const { setLiveChainMemberNames } = await import("../agents/providers/provider-outage.js");
    const registry = ProviderHealthRegistry.getInstance();
    registry.clearProviderState("cm-cool");
    setLiveChainMemberNames(["cm-cool"]);

    try {
      const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      await waitFor(() => expect(tasks.submitted).toHaveLength(1));
      expect(storage.get(campaign.id)!.milestones[0]!.attempts).toBe(1);

      // The chain goes down while the task runs; the settle carries the outage.
      registry.recordOverloaded("cm-cool", "quota wall");
      tasks.updatedAts.set("task_1", Date.now() - 30 * 60_000);
      tasks.emit("task:failed", "task_1", "Task execution failed: All providers are in cooldown. Auto-retry 1/10 in ~30s.");
      await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));
      expect(tasks.submitted).toHaveLength(1); // parked, not resubmitted into the wall
      expect(storage.get(campaign.id)!.autoReviveAt).toBeGreaterThan(Date.now());
      expect(storage.get(campaign.id)!.milestones[0]!.attempts).toBe(1); // not charged

      registry.clearProviderState("cm-cool");
      (manager as unknown as { scheduleAutoRevive(id: string, ms: number): void }).scheduleAutoRevive(campaign.id, 20);
      await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    } finally {
      setLiveChainMemberNames([]);
      registry.clearProviderState("cm-cool");
    }
  });

  it("does not wait for a retry nobody promised when the chain is healthy", async () => {
    // Measured 2026-09-07 07:51: "provider_unavailable" in a blocked task's
    // sub-goal note, every provider healthy, 22 minutes deferred to a
    // keep-alive retry that never existed.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    tasks.emit(
      "task:blocked",
      "task_1",
      "Completed:\nI got stuck on this task after multiple approaches.\n\nBlocked:\n[goal_x] provider_unavailable",
    );
    // Judged now — attempt 2 submitted within seconds, not after a 10-minute re-check.
    await waitFor(() => expect(tasks.submitted).toHaveLength(2), { timeout: 15_000 });
    expect(storage.get(campaign.id)!.milestones[0]!.reconcileDeferredSince).toBeUndefined();
  });

  it("a graceful shutdown does not charge the milestone an attempt", async () => {
    // Measured 2026-09-03 06:45: a daemon restart aborted the in-flight run
    // with "shutting down", the milestone was charged its second attempt and
    // the campaign stopped — on a routine deploy, with no revival armed.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    tasks.updatedAts.set("task_1", Date.now() - 30 * 60_000);
    tasks.emit("task:blocked", "task_1", `${SYSTEM_INTERRUPTION_MARKER} The task was stopped before it finished (shutting down). Any changes it made have been kept.`);
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));

    expect(storage.get(campaign.id)!.milestones[0]!.attempts).toBe(1);
    expect(storage.get(campaign.id)!.state).toBe("executing");
  });

  it("a game defect that MENTIONS shutdown is charged like any other failure", async () => {
    // Codex 2026-09-12 AD#14, reproduced: the exemption was a regex over the
    // task's output, so "The shutdown menu does not save progress" bought
    // unlimited free retries — twenty failures, twenty resubmissions, with
    // attempts unchanged and the time box never applied.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const stored = storage.get(campaign.id)!;
    stored.milestones[0]!.startedAtMs = Date.now() - 4 * 60 * 60_000; // past the 1h box
    storage.save(stored);

    tasks.emit("task:blocked", "task_1", "The shutdown menu does not save progress.");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    // The time box applies: the scope is narrowed. A real shutdown is judged
    // before the box and would leave it untouched.
    expect(storage.get(campaign.id)!.milestones[0]!.timeBoxEscalations).toBe(1);

    // …and a worker that QUOTES the marker inside its own prose does not get
    // the exemption either: the system writes it at the start of the message,
    // and that position is the claim.
    const second = storage.get(campaign.id)!;
    second.milestones[0]!.startedAtMs = Date.now() - 4 * 60 * 60_000;
    second.milestones[0]!.timeBoxEscalations = 0;
    storage.save(second);
    tasks.emit("task:blocked", "task_2", `The log said ${SYSTEM_INTERRUPTION_MARKER} but the sprint simply failed.`);
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    expect(storage.get(campaign.id)!.milestones[0]!.timeBoxEscalations).toBe(1);
  });

  it("a shutdown never ends a sprint, even at its last attempt", async () => {
    // Measured live 2026-09-03 21:24: the sprint sat at 2/2, a routine deploy
    // stopped the process, and the exemption — gated behind canRetry — did
    // not run, so the deploy itself ended the campaign.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const stored = storage.get(campaign.id)!;
    stored.milestones[0]!.attempts = 2; // budget already spent
    storage.save(stored);
    tasks.updatedAts.set("task_1", Date.now() - 30 * 60_000);

    tasks.emit("task:blocked", "task_1", `${SYSTEM_INTERRUPTION_MARKER} The task was stopped before it finished (shutting down). Any changes it made have been kept.`);
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));

    const after = storage.get(campaign.id)!;
    expect(after.state).toBe("executing");
    expect(after.milestones[0]!.attempts).toBe(2);
  });

  it("a BLOCKED outage settle also parks without charging an attempt", async () => {
    const { ProviderHealthRegistry } = await import("../agents/providers/provider-health.js");
    const { setLiveChainMemberNames } = await import("../agents/providers/provider-outage.js");
    const registry = ProviderHealthRegistry.getInstance();
    registry.clearProviderState("cm-cool2");
    setLiveChainMemberNames(["cm-cool2"]);

    try {
      const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      await waitFor(() => expect(tasks.submitted).toHaveLength(1));
      registry.recordOverloaded("cm-cool2", "quota wall");
      tasks.updatedAts.set("task_1", Date.now() - 30 * 60_000);
      tasks.emit("task:blocked", "task_1", "Blocked:\n[goal_1] blocked:provider_unavailable. Auto-retry 2/10 in ~30s.");
      await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));
      expect(tasks.submitted).toHaveLength(1);
      expect(storage.get(campaign.id)!.milestones[0]!.attempts).toBe(1); // not charged
      registry.clearProviderState("cm-cool2");
      (manager as unknown as { scheduleAutoRevive(id: string, ms: number): void }).scheduleAutoRevive(campaign.id, 20);
      await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    } finally {
      setLiveChainMemberNames([]);
      registry.clearProviderState("cm-cool2");
    }
  });

  it("a dead retry promise stops the deferral loop (ghost keep-alive)", async () => {
    // Measured live 2026-08-30 15:33-15:55: keep-alive budget exhausted, no
    // task active anywhere, yet reconcile re-deferred every cycle to a retry
    // that no longer existed — the campaign idled behind a ghost promise.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));

    // Tip promises a 1s retry but its updatedAt is 10 minutes old: promise dead.
    tasks.updatedAts.set("task_1", Date.now() - 10 * 60_000);
    tasks.emit(
      "task:blocked",
      "task_1",
      "Transient failure — worker crashed. Auto-retry 1/10 in ~1s.",
    );
    // Not deferred: the outcome is judged and the retry branch resubmits.
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(storage.get(campaign.id)!.milestones[0]!.status).toBe("running");
  });

  it("doubled settle emissions cannot consume the deferral and burn an attempt", async () => {
    // Measured 2026-08-29 19:04: one handler logged the defer, the second
    // (same second, doubled task:blocked emission) consumed the one-shot flag
    // and submitted attempt 2 into a 68-minute quota wall.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));

    const parkText = "Transient failure — All providers are in cooldown. Auto-retry 2/10 in ~4105s.";
    tasks.emit("task:blocked", "task_1", parkText);
    tasks.emit("task:blocked", "task_1", parkText);

    // Both settles defer (grace 10ms + settle chain) — no resubmission, no
    // attempt burn, campaign still executing on the parked lineage.
    await new Promise((r) => setTimeout(r, 250));
    expect(tasks.submitted).toHaveLength(1);
    const fresh = storage.get(campaign.id)!;
    expect(fresh.state).toBe("executing");
    expect(fresh.milestones[0]!.attempts).toBe(1);
    expect(fresh.milestones[0]!.reconcileDeferredSince).toBeGreaterThan(0);
  });

  it("a stop during a full provider outage arms self-revival and revives when the chain recovers", async () => {
    // Measured 2026-08-29 (00:58 and 12:27): "failed on quota" meant failed
    // until a person typed "kampanya devam" — hours of operator attention for
    // a scheduled, known-duration wait.
    const { ProviderHealthRegistry } = await import("../agents/providers/provider-health.js");
    const { setLiveChainMemberNames } = await import("../agents/providers/provider-outage.js");
    const registry = ProviderHealthRegistry.getInstance();
    registry.clearProviderState("claude");
    setLiveChainMemberNames(["claude"]);

    try {
      const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      await waitFor(() => expect(tasks.submitted).toHaveLength(1));
      // The chain goes down while the task runs. Non-outage wording (reconcile
      // must not defer) — the health check at submit time is what parks it.
      registry.recordOverloaded("claude", "quota wall");
      tasks.emit("task:failed", "task_1", "2 fresh plans produced nothing new");

      await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));
      expect(tasks.submitted).toHaveLength(1);
      const parked = storage.get(campaign.id)!;
      expect(parked.autoReviveAt).toBeGreaterThan(Date.now());
      expect(messages.at(-1)!.text).toContain("Self-revival armed");

      // The chain recovers; the (privately re-scheduled, short) appointment fires.
      registry.clearProviderState("claude");
      (manager as unknown as { scheduleAutoRevive(id: string, ms: number): void })
        .scheduleAutoRevive(campaign.id, 20);
      await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("executing"));
      const revived = storage.get(campaign.id)!;
      expect(revived.autoReviveAt).toBeUndefined();
      expect(tasks.submitted.length).toBeGreaterThanOrEqual(2);
    } finally {
      setLiveChainMemberNames([]);
      registry.clearProviderState("claude");
    }
  });

  it("'kampanya devam' revives a failed campaign with a fresh attempt budget", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    tasks.emit("task:failed", "task_1", "boom");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    // Through the bounded self-revivals first (Codex 2026-09-11 F#1) — only a
    // campaign that has spent those stops and waits for a person.
    await failUntilStopped(campaign.id, "boom again");

    const beforeRevive = tasks.submitted.length;
    const consumed = await manager.tryHandleRevive("cli-local", "kampanya devam");
    expect(consumed).toBe(true);
    await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(beforeRevive));
    const fresh = storage.get(campaign.id)!;
    expect(fresh.state).toBe("executing");
    expect(fresh.milestones[0]!.attempts).toBe(1); // fresh budget, one new attempt
  });

  it("commits the working tree when a milestone goes green", async () => {
    rmSync(join(projectRoot, "Recordings"), { recursive: true, force: true }); // Recordings/ never enters the envelope
    const { execFileSync } = await import("node:child_process");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8" });
    git("init");
    git("config", "user.email", "test@test.local");
    git("config", "user.name", "Test");

    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));

    writeFileSync(join(projectRoot, "SprintWork.cs"), "class SprintWork {}");
    tasks.emit("task:completed", "task_1", "sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));

    // Recordings/ is Strada's own output (the run record the sprint left); it
    // is never committed — see DEFAULT_WORKSPACE_COPY_EXCLUDES.
    // …and `.strada/` is Strada's own state (the evidence ledger the compile
    // ticket writes, lease bookkeeping): also never committed.
    expect(
      git("status", "--porcelain")
        .replace(/^\?\? Recordings\/$/m, "")
        .replace(/^\?\? \.strada\/$/m, "")
        .trim(),
    ).toBe(""); // tree clean
    expect(git("log", "-1", "--pretty=%s")).toContain("milestone green");
    expect(storage.get(campaign.id)!.state).toBe("executing");
    // …and the note NAMES WHAT LANDED. "Committed 1 file(s) as abcdef" says
    // nothing about which requirement the work implements, so the coverage
    // audit could close any of them by quoting it (Codex 2026-09-13 AJ).
    const note = storage.get(campaign.id)!.milestones[0]!.commitNote ?? "";
    expect(note).toMatch(/Committed \d+ file\(s\) as `[0-9a-f]+`:/);
    expect(note).toContain("SprintWork.cs");
  });

  it("keeps Recordings/ and .strada out of the envelope, and untracks what an earlier envelope swept in", async () => {
    // Measured 2026-09-07 21:33: one envelope commit added 2 300 capture
    // frames from eight runs to the user's history.
    const { execFileSync } = await import("node:child_process");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8" });
    git("init");
    git("config", "user.email", "test@test.local");
    git("config", "user.name", "Test");
    mkdirSync(join(projectRoot, "Recordings", "old-run"), { recursive: true });
    writeFileSync(join(projectRoot, "Recordings", "old-run", "frame_0.png"), "x");
    git("add", "-A");
    git("commit", "-q", "-m", "an earlier envelope swept Recordings in");

    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    writeFileSync(join(projectRoot, "SprintWork.cs"), "class SprintWork {}");
    mkdirSync(join(projectRoot, "Recordings", "this-run"), { recursive: true });
    writeFileSync(join(projectRoot, "Recordings", "this-run", "frame_0.png"), "y");
    tasks.emit("task:completed", "task_1", "sprint A done");
    // The envelope commit shells out to git several times; under machine load
    // (measured 2026-09-10 with a sprite generator running) it overran
    // waitFor's default second and this test failed for reasons unrelated to
    // what it asserts.
    await waitFor(() => expect(tasks.submitted).toHaveLength(2), { timeout: 15_000 });

    expect(git("log", "-1", "--pretty=%s")).toContain("milestone green");
    expect(git("ls-files", "--", "Recordings").trim()).toBe(""); // untracked now
    expect(git("show", "--stat", "--format=", "HEAD")).toContain("SprintWork.cs");
    expect(git("show", "--stat", "--format=", "HEAD")).not.toContain("this-run");
    expect(existsSync(join(projectRoot, "Recordings", "old-run", "frame_0.png"))).toBe(true); // still on disk
    expect(storage.get(campaign.id)!.state).toBe("executing");
  });

  it("appends a coverage-remediation sprint when the audit finds GDD gaps", async () => {
    // Isolated fixtures: the beforeEach manager stays subscribed to the shared
    // emitter, and two managers double-handling one campaign is not a
    // production shape (exactly one CampaignManager attaches per process).
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-coverage.db"));
    const planner = {
      planMilestones: vi.fn().mockResolvedValue(LADDER),
      auditCoverage: vi
        .fn()
        .mockResolvedValueOnce(["Dragon boss: no milestone implemented it"])
        .mockResolvedValue([]),
      // The repair landed the boss, and the delivery audit says so: a GREEN
      // repair's requirement is judged on the evidence now, not waived by the
      // sprint's own status (Codex 2026-09-12 AD#2).
      resolveCoverageGaps: vi.fn(async (_gdd: string, reqs: readonly string[]) => ({ closed: [...reqs], open: [] })),
    } as unknown as CampaignPlanner;
    manager = new CampaignManager({
      storage,
      planner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => messages.push({ chatId, text }),
      projectRoot,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    manager.attachEvents();

    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    settleMilestone("final report"); // last planned milestone → audit fires, finds a gap
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));
    expect(tasks.submitted[3]!.prompt).toContain("Dragon boss");
    expect(storage.get(campaign.id)!.state).toBe("executing");

    // The remediation sprint now inherits the visual-evidence gate (its bar
    // demands a captured frame), so a first completion with no frames on disk
    // bounces once — the gap-closing sprint is exactly the one that must not
    // be allowed to go green blind.
    settleMilestone("dragon implemented");
    await waitFor(() => expect(tasks.submitted).toHaveLength(5));
    expect(tasks.submitted[4]!.prompt).toContain("VISUAL EVIDENCE MISSING");

    settleMilestone("dragon implemented, frames captured");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"));
  });

  it("issues a TICKET for every producer dispatch and discloses its receipt (Codex 2026-09-12 AC Job 2)", async () => {
    // The receiver had no production caller at all, so its refusals
    // constrained nothing (Codex 2026-09-13 AF#1). Every dispatch is now
    // written down before it runs and judged after — and today's producers
    // emit no receipt, which is what the report says.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    settleMilestone("green, shipping");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"), { timeout: 15_000 });
    // `done` is persisted BEFORE the report is gathered and sent, so waiting
    // on the state alone races the delivery message (green locally, red in CI).
    await waitFor(() => expect(messages.some((m) => m.text.includes("Campaign delivery"))).toBe(true), { timeout: 15_000 });

    const report = messages.map((m) => m.text).join("\n");
    expect(report).toContain("**Producer receipts**");
    expect(report).toContain("Receipt checks are informational in this version");
    // The build and the play-through were both dispatched under a ticket, and
    // neither producer sent a receipt back.
    expect(report).toMatch(/player-build receipt.*REFUSED \(EVIDENCE_MISSING\)/);
    expect(report).toMatch(/playthrough receipt.*REFUSED \(EVIDENCE_MISSING\)/);

    // …and the tickets are on disk, bound to this campaign's own sprint.
    const ledger = new EvidenceLedger(join(projectRoot, ".strada", "campaign-evidence.db"));
    try {
      const last = storage.get(campaign.id)!.milestones.at(-1)!;
      const rows = ledger.forMilestone(campaign.id, last.id);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.state !== "pending")).toBe(true);
      expect(rows.map((r) => r.kind)).toContain("player-build");
    } finally {
      ledger.close();
    }
  });


  it("JUDGES a receipt a producer actually stamped (Codex 2026-09-12 AC Job 2)", async () => {
    // The other half of the loop: when the builder answers with a receipt
    // naming the run it was given, the ledger records an admitted decision
    // instead of EVIDENCE_MISSING.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, `campaigns-receipt-${messages.length}.db`));
    const revision = (): string => {
      try {
        return execFileSync("git", ["-C", projectRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      } catch {
        return "";
      }
    };
    manager = new CampaignManager({
      storage,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string, evidenceRunId?: string) => {
        buildTargetsAsked.push(target);
        const receipt = JSON.stringify({
          schemaVersion: 1,
          runId: evidenceRunId,
          kind: "player-build",
          medium: "builder",
          revision: revision(),
          ...(target === undefined ? {} : { target }),
          execution: { completed: true, exitCode: 0, timedOut: false },
        });
        return { ...buildVerdict, receipt };
      },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    manager.attachEvents();

    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    settleMilestone("green, shipping");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"), { timeout: 15_000 });

    const ledger = new EvidenceLedger(join(projectRoot, ".strada", "campaign-evidence.db"));
    try {
      const last = storage.get(campaign.id)!.milestones.at(-1)!;
      const builds = ledger.forMilestone(campaign.id, last.id).filter((r) => r.kind === "player-build");
      expect(builds.length).toBeGreaterThan(0);
      // The producer's own bytes reached the receiver: the decision is about
      // THIS record — its hash is stored — and not "no receipt came back".
      expect(builds.every((r) => (r.recordSha256 ?? "").length === 64)).toBe(true);
      expect(builds.every((r) => r.refusal !== "EVIDENCE_MISSING")).toBe(true);
      // This fixture's tree is a directory with NO repository, and the
      // producer says the same of it — an answer both sides can agree on, so
      // the record is admitted rather than called dirty (Codex 2026-09-13
      // AI#6; before that fix `git status` failing here read as dirt).
      expect(builds.map((r) => r.refusal ?? "admitted")).toContain("admitted");
    } finally {
      ledger.close();
    }
    expect(messages.map((m) => m.text).join("\n")).toMatch(/player-build receipt.*admitted \(run /);
  });

  it("ADMITS a complete play-through receipt through the production path (Codex 2026-09-13 AH#6)", async () => {
    // A correct player run could not produce an admissible receipt: the
    // player path was never given the run id, so it stamped none, and the
    // wrapper never measured the artifact after the run — every real
    // play-through settled "ARTIFACT_MISSING: nobody measured the artifact
    // that ran". This is the whole loop, end to end, on a clean tree.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, `campaigns-admit-${messages.length}.db`));
    const git = (...args: string[]): string => execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8" });
    const artifact = join(projectRoot, "Builds", "StandaloneOSX", "Game.app");
    mkdirSync(join(projectRoot, "Builds", "StandaloneOSX"), { recursive: true });
    writeFileSync(artifact, "the bytes that were built");
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-qm", "baseline");
    // The tree the receipts are bound to is whatever HEAD is when the run
    // happens: every sprint commits its own work here, the way a real one does.
    const head = (): string => git("rev-parse", "HEAD").trim();
    const didWork = async (n: number): Promise<void> => {
      // Commit timestamps are second-granular, so a sprint's work must land
      // strictly after the second the sprint began in.
      await new Promise((r) => setTimeout(r, 1100));
      writeFileSync(join(projectRoot, `work-${n}.txt`), `sprint ${n}`);
      git("add", "-A");
      git("commit", "-qm", `sprint ${n}`);
    };
    buildVerdict = { ran: true, ok: true, target: "StandaloneOSX", artifactPath: artifact, sizeBytes: 25, durationMs: 120_000, scenes: 2 };
    const sessionsAsked: Array<string | undefined> = [];

    manager = new CampaignManager({
      storage,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string, evidenceRunId?: string) => {
        buildTargetsAsked.push(target);
        return {
          ...buildVerdict,
          receipt: JSON.stringify({
            schemaVersion: 1, runId: evidenceRunId, kind: "player-build", medium: "builder", revision: head(),
            ...(target === undefined ? {} : { target }),
            artifactSha256: artifactDigest(artifact),
            execution: { completed: true, exitCode: 0, timedOut: false },
          }),
        };
      },
      // What Strada.MCP's unity_run_player stamps for the run it was given.
      runPlayer: async (root, artifactPlayed, spec, dispatch) => {
        playerRuns.push(artifactPlayed);
        sessionsAsked.push(spec?.sessions);
        // What the real producer writes: the verdict stamped with the run id
        // it was given, and a receipt naming that file's bytes (plan 1.3).
        writePlayerVerdict(true, { runId: dispatch?.runId }, root);
        const verdictRel = join("Recordings", "player-playthrough", "playthrough-verdict.json");
        const verdictBytes = readFileSync(join(root, verdictRel), "utf8");
        return {
          receipt: JSON.stringify({
            schemaVersion: 1, runId: dispatch?.runId, kind: "playthrough", medium: "player", revision: head(),
            ...(dispatch?.target === undefined ? {} : { target: dispatch.target }),
            artifactSha256: artifactDigest(artifactPlayed),
            execution: { completed: true, exitCode: 0, timedOut: false },
            sessionCount: 1,
            sessions: [{
              requestedIndex: 1, index: 1, observedIndex: 1, identityVerified: true,
              identitySource: "active-session", actions: 12, outcome: "Won", reachedOutcome: true, seconds: 9,
            }],
            payload: { verdictPath: verdictRel, verdictSha256: createHash("sha256").update(verdictBytes).digest("hex") },
          }),
        };
      },
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    manager.attachEvents();

    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    await didWork(1);
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    await didWork(2);
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    await didWork(3);
    settleMilestone("green, shipping");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"), { timeout: 15_000 });

    const ledger = new EvidenceLedger(join(projectRoot, ".strada", "campaign-evidence.db"));
    try {
      const last = storage.get(campaign.id)!.milestones.at(-1)!;
      const plays = ledger.forMilestone(campaign.id, last.id).filter((r) => r.kind === "playthrough");
      expect(plays.length).toBeGreaterThan(0);
      // ADMITTED: the run id reached the player, the receipt came back for
      // that run, and the artifact was measured on both sides of it.
      expect(plays.map((r) => r.refusal ?? "admitted")).toContain("admitted");
      expect(plays.some((r) => (r.recordSha256 ?? "").length === 64)).toBe(true);
      // The run was asked for one session and the receipt answered for it;
      // the ticket says which, so a record that skipped it could not settle.
      expect(sessionsAsked).not.toHaveLength(0);
    } finally {
      ledger.close();
    }
    await waitFor(() => expect(messages.map((m) => m.text).join("\n")).toMatch(/playthrough receipt.*admitted \(run /));
  }, 30_000);

  it("the play-through ticket names the sessions the run was asked for (Codex 2026-09-12 AC J1)", async () => {
    // A ticket with no session requirement admits a record that played
    // nothing: the sessions the run was asked for are what make an empty
    // record a refusal. Measured against the production path directly.
    const git = (...args: string[]): string => execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8" });
    const artifact = join(projectRoot, "Builds", "StandaloneOSX", "Game.app");
    mkdirSync(join(projectRoot, "Builds", "StandaloneOSX"), { recursive: true });
    writeFileSync(artifact, "the bytes that were built");
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-qm", "baseline");
    const revision = git("rev-parse", "HEAD").trim();

    let withSessions = true;
    const campaign = {
      id: "c_ticket", chatId: "chat", channelType: "cli", userId: "u", projectRoot,
      state: "executing", draftAttempts: 0, milestones: [], currentMilestone: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
    } as unknown as Campaign;
    const milestone = { id: "m_play", title: "Delivery", prompt: "p", status: "running", attempts: 1 };
    const build = { ran: true, ok: true, target: "StandaloneOSX", artifactPath: artifact, sizeBytes: 25, durationMs: 1, scenes: 1 };
    const player = new CampaignManager({
      storage,
      runPlayer: async (root, artifactPlayed, _spec, dispatch) => {
        writePlayerVerdict(true, {}, root);
        return {
          receipt: JSON.stringify({
            schemaVersion: 1, runId: dispatch?.runId, kind: "playthrough", medium: "player", revision,
            ...(dispatch?.target === undefined ? {} : { target: dispatch.target }),
            artifactSha256: artifactDigest(artifactPlayed),
            execution: { completed: true, exitCode: 0, timedOut: false },
            sessionCount: 1,
            ...(withSessions
              ? {
                sessions: [{
                  requestedIndex: 1, index: 1, observedIndex: 1, identityVerified: true,
                  identitySource: "active-session", actions: 12, outcome: "Won", reachedOutcome: true, seconds: 9,
                }],
              }
              : {}),
          }),
        };
      },
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async () => {},
      projectRoot,
    });
    const measure = (m: unknown): Promise<unknown> =>
      (player as unknown as { measurePlayerRun(m: unknown, b: unknown, c: unknown): Promise<unknown> })
        .measurePlayerRun(m, build, campaign);

    await measure(milestone);
    withSessions = false;
    const second = { ...milestone, id: "m_play_empty" };
    await measure(second);

    const ledger = new EvidenceLedger(join(projectRoot, ".strada", "campaign-evidence.db"));
    try {
      const played = ledger.forMilestone(campaign.id, "m_play");
      expect(played.map((r) => r.refusal ?? "admitted")).toEqual(["admitted"]);
      // The SAME run, with the session the ticket asked for left out of the
      // record, is refused by name — not admitted as "nothing to check".
      const empty = ledger.forMilestone(campaign.id, "m_play_empty");
      expect(empty.map((r) => r.refusal)).toEqual(["SESSION_MISSING"]);
      expect(empty[0]!.detail ?? "").toContain("session 1 was asked for");
    } finally {
      ledger.close();
    }
  }, 20_000);

  it("a play-through that FAILED still settles on the receipt that explains it (Codex 2026-09-13 AI#11)", async () => {
    // The producer measured a deadline kill and said so; the failure was
    // thrown and the receipt dropped, so the ledger recorded EVIDENCE_MISSING
    // — "no receipt came back" — about a run that had explained itself.
    const git = (...args: string[]): string => execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8" });
    const artifact = join(projectRoot, "Builds", "StandaloneOSX", "Game.app");
    mkdirSync(join(projectRoot, "Builds", "StandaloneOSX"), { recursive: true });
    writeFileSync(artifact, "the bytes that were built");
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-qm", "baseline");
    const revision = git("rev-parse", "HEAD").trim();

    const campaign = {
      id: "c_failed_play", chatId: "chat", channelType: "cli", userId: "u", projectRoot,
      state: "executing", draftAttempts: 0, milestones: [], currentMilestone: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
    } as unknown as Campaign;
    const player = new CampaignManager({
      storage,
      runPlayer: async (_root, artifactPlayed, _spec, dispatch) => {
        throw new ProducerFailure(
          "Player: Game.app; exit -1 — the player was killed at its deadline",
          JSON.stringify({
            schemaVersion: 1, runId: dispatch?.runId, kind: "playthrough", medium: "player", revision,
            ...(dispatch?.target === undefined ? {} : { target: dispatch.target }),
            artifactSha256: artifactDigest(artifactPlayed),
            execution: { completed: false, exitCode: -1, timedOut: true },
          }),
        );
      },
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async () => {},
      projectRoot,
    });

    const build = { ran: true, ok: true, target: "StandaloneOSX", artifactPath: artifact, sizeBytes: 25, durationMs: 1, scenes: 1 };
    const measured = await (player as unknown as { measurePlayerRun(m: unknown, b: unknown, c: unknown): Promise<{ found: boolean }> })
      .measurePlayerRun({ id: "m_killed", title: "Delivery", prompt: "p", status: "running", attempts: 1 }, build, campaign);
    // The failure is still a failure: nothing was played.
    expect(measured.found).toBe(false);

    const ledger = new EvidenceLedger(join(projectRoot, ".strada", "campaign-evidence.db"));
    try {
      const rows = ledger.forMilestone(campaign.id, "m_killed");
      // THE PRODUCER'S OWN BYTES reached the receiver: the refusal is about
      // the run that did not finish, not about a receipt nobody sent.
      expect(rows.map((r) => r.refusal)).toEqual(["PROCESS_INCOMPLETE"]);
      expect((rows[0]!.recordSha256 ?? "").length).toBe(64);
    } finally {
      ledger.close();
    }
  }, 20_000);

  it("a project with NO repository is not a dirty one (Codex 2026-09-13 AI#6)", async () => {
    // `git status` fails outside a repository and the failure read as "dirty",
    // so every receipt from a correct project outside git was refused
    // SOURCE_DIRTY. There is no git init here on purpose.
    const artifact = join(projectRoot, "Builds", "StandaloneOSX", "Game.app");
    mkdirSync(join(projectRoot, "Builds", "StandaloneOSX"), { recursive: true });
    writeFileSync(artifact, "the bytes that were built");
    expect(existsSync(join(projectRoot, ".git"))).toBe(false);

    const campaign = {
      id: "c_no_git", chatId: "chat", channelType: "cli", userId: "u", projectRoot,
      state: "executing", draftAttempts: 0, milestones: [], currentMilestone: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
    } as unknown as Campaign;
    const player = new CampaignManager({
      storage,
      runPlayer: async (root, artifactPlayed, _spec, dispatch) => {
        writePlayerVerdict(true, {}, root);
        return {
          receipt: JSON.stringify({
            schemaVersion: 1, runId: dispatch?.runId, kind: "playthrough", medium: "player",
            // What a producer states for a tree it CONFIRMED has no
            // repository — the same answer the coordinator binds.
            revision: "",
            ...(dispatch?.target === undefined ? {} : { target: dispatch.target }),
            artifactSha256: artifactDigest(artifactPlayed),
            execution: { completed: true, exitCode: 0, timedOut: false },
            sessionCount: 1,
            sessions: [{
              requestedIndex: 1, index: 1, identityVerified: true, identitySource: "start-acceptance",
              actions: 12, outcome: "Won", reachedOutcome: true, seconds: 9,
            }],
          }),
        };
      },
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async () => {},
      projectRoot,
    });

    const build = { ran: true, ok: true, target: "StandaloneOSX", artifactPath: artifact, sizeBytes: 25, durationMs: 1, scenes: 1 };
    await (player as unknown as { measurePlayerRun(m: unknown, b: unknown, c: unknown): Promise<unknown> })
      .measurePlayerRun({ id: "m_nogit", title: "Delivery", prompt: "p", status: "running", attempts: 1 }, build, campaign);

    const ledger = new EvidenceLedger(join(projectRoot, ".strada", "campaign-evidence.db"));
    try {
      const rows = ledger.forMilestone(campaign.id, "m_nogit");
      expect(rows.map((r) => r.refusal ?? "admitted")).toEqual(["admitted"]);
    } finally {
      ledger.close();
    }
  }, 20_000);

  it("the compile dispatch runs under a ticket, and EITHER producer may answer it (Codex 2026-09-13 AI)", async () => {
    // The compile behind every delivery was a file a worker could have
    // written: this dispatch had no ticket at all. And which producer answers
    // it is the tool's decision — a live editor or a headless compiler — so a
    // ticket naming one medium refused the other.
    const campaign = {
      id: "c_compile", chatId: "chat", channelType: "cli", userId: "u", projectRoot,
      state: "executing", draftAttempts: 0, milestones: [], currentMilestone: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
    } as unknown as Campaign;
    const receiptFor = (runId: string, medium: string, exitCode: number | null): string => JSON.stringify({
      schemaVersion: 1, runId, kind: "compile", medium, revision: "",
      execution: { completed: true, exitCode, timedOut: false },
    });

    const managerWith = (medium: string, exitCode: number | null) => new CampaignManager({
      storage,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async (_root: string, runId?: string) => ({
        ok: true, ran: true, errors: 0, detail: "compiles",
        ...(runId === undefined ? {} : { receipt: receiptFor(runId, medium, exitCode) }),
      }),
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async () => {},
      projectRoot,
    });
    const measure = async (m: string, exitCode: number | null, milestoneId: string): Promise<void> => {
      await (managerWith(m, exitCode) as unknown as { measureCompile(c: unknown, m: unknown): Promise<unknown> })
        .measureCompile(campaign, { id: milestoneId, title: "Sprint", prompt: "p", status: "running", attempts: 1 });
    };

    // The LIVE EDITOR answers: it owns no process, so it states no exit code.
    await measure("editor", null, "m_editor");
    // A HEADLESS COMPILER answers the same dispatch: its own exit code is 0.
    await measure("compiler", 0, "m_compiler");
    // …and a producer that is neither is refused by name.
    await measure("player", 0, "m_player");

    const ledger = new EvidenceLedger(join(projectRoot, ".strada", "campaign-evidence.db"));
    try {
      expect(ledger.forMilestone(campaign.id, "m_editor").map((r) => r.refusal ?? "admitted")).toEqual(["admitted"]);
      expect(ledger.forMilestone(campaign.id, "m_compiler").map((r) => r.refusal ?? "admitted")).toEqual(["admitted"]);
      const wrong = ledger.forMilestone(campaign.id, "m_player");
      expect(wrong.map((r) => r.refusal)).toEqual(["MEDIUM_MISMATCH"]);
      expect(wrong[0]!.detail ?? "").toContain("asked for compiler or editor, got player");
      // The ticket records what it would accept, in order.
      expect(wrong[0]!.medium).toBe("compiler,editor");
    } finally {
      ledger.close();
    }
  }, 20_000);

  it("a verdict that is not the file the producer wrote is NOT MEASURED (Codex 2026-09-13 AJ#12)", async () => {
    // The delivery is judged from the verdict FILE — its frame rate, its
    // frames, its errors — and an admitted receipt said nothing about those
    // bytes, so nothing connected the evidence to the measurement consumed.
    const git = (...args: string[]): string => execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8" });
    const artifact = join(projectRoot, "Builds", "StandaloneOSX", "Game.app");
    mkdirSync(join(projectRoot, "Builds", "StandaloneOSX"), { recursive: true });
    writeFileSync(artifact, "the bytes that were built");
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-qm", "baseline");
    const revision = git("rev-parse", "HEAD").trim();
    const verdictRel = join("Recordings", "player-playthrough", "playthrough-verdict.json");

    const campaign = {
      id: "c_verdict_bind", chatId: "chat", channelType: "cli", userId: "u", projectRoot,
      state: "executing", draftAttempts: 0, milestones: [], currentMilestone: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
    } as unknown as Campaign;
    let tamper = false;
    const player = new CampaignManager({
      storage,
      runPlayer: async (root, artifactPlayed, _spec, dispatch) => {
        writePlayerVerdict(true, {}, root);
        const bytes = readFileSync(join(root, verdictRel), "utf8");
        const receipt = JSON.stringify({
          schemaVersion: 1, runId: dispatch?.runId, kind: "playthrough", medium: "player", revision,
          ...(dispatch?.target === undefined ? {} : { target: dispatch.target }),
          artifactSha256: artifactDigest(artifactPlayed),
          execution: { completed: true, exitCode: 0, timedOut: false },
          sessionCount: 1,
          sessions: [{
            requestedIndex: 1, index: 1, identityVerified: true, identitySource: "start-acceptance",
            actions: 12, outcome: "Won", reachedOutcome: true, seconds: 9,
          }],
          payload: { verdictPath: verdictRel, verdictSha256: createHash("sha256").update(bytes).digest("hex") },
        });
        // Something replaces the verdict between the run and the read.
        if (tamper) writeFileSync(join(root, verdictRel), bytes.replace('"ok":true', '"ok":false'));
        return { receipt };
      },
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async () => {},
      projectRoot,
    });
    const build = { ran: true, ok: true, target: "StandaloneOSX", artifactPath: artifact, sizeBytes: 25, durationMs: 1, scenes: 1 };
    const measure = (id: string): Promise<{ found: boolean; missingRunner?: string }> =>
      (player as unknown as { measurePlayerRun(m: unknown, b: unknown, c: unknown): Promise<{ found: boolean; missingRunner?: string }> })
        .measurePlayerRun({ id, title: "Delivery", prompt: "p", status: "running", attempts: 1 }, build, campaign);

    // The untouched file is the file the receipt names, and the run counts.
    const honest = await measure("m_bound");
    expect(honest.found).toBe(true);

    tamper = true;
    const swapped = await measure("m_swapped");
    expect(swapped.found).toBe(false);
    expect(swapped.missingRunner).toContain("is not the file the producer wrote");
  }, 20_000);

  it("a receipt that measured ANOTHER file authenticates nothing (Codex 2026-09-13 AK#12)", async () => {
    // The receipt named `Recordings/decoy.json` and hashed it honestly, while
    // the gate read the canonical verdict beside it: the check authenticated
    // bytes nobody consumed, so a good-looking decoy passed a bad run.
    const git = (...args: string[]): string => execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8" });
    const artifact = join(projectRoot, "Builds", "StandaloneOSX", "Game.app");
    mkdirSync(join(projectRoot, "Builds", "StandaloneOSX"), { recursive: true });
    writeFileSync(artifact, "the bytes that were built");
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-qm", "baseline");
    const revision = git("rev-parse", "HEAD").trim();

    const campaign = {
      id: "c_decoy", chatId: "chat", channelType: "cli", userId: "u", projectRoot,
      state: "executing", draftAttempts: 0, milestones: [], currentMilestone: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
    } as unknown as Campaign;
    const player = new CampaignManager({
      storage,
      runPlayer: async (root, artifactPlayed, _spec, dispatch) => {
        writePlayerVerdict(true, {}, root);
        // A decoy the producer chose, hashed truthfully.
        const decoyRel = join("Recordings", "decoy.json");
        writeFileSync(join(root, decoyRel), '{"ok":true,"decoy":true}');
        return {
          receipt: JSON.stringify({
            schemaVersion: 1, runId: dispatch?.runId, kind: "playthrough", medium: "player", revision,
            ...(dispatch?.target === undefined ? {} : { target: dispatch.target }),
            artifactSha256: artifactDigest(artifactPlayed),
            execution: { completed: true, exitCode: 0, timedOut: false },
            sessionCount: 1,
            sessions: [{
              requestedIndex: 1, index: 1, identityVerified: true, identitySource: "start-acceptance",
              actions: 12, outcome: "Won", reachedOutcome: true, seconds: 9,
            }],
            payload: {
              verdictPath: decoyRel,
              verdictSha256: createHash("sha256").update('{"ok":true,"decoy":true}').digest("hex"),
            },
          }),
        };
      },
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async () => {},
      projectRoot,
    });
    const build = { ran: true, ok: true, target: "StandaloneOSX", artifactPath: artifact, sizeBytes: 25, durationMs: 1, scenes: 1 };
    const measured = await (player as unknown as {
      measurePlayerRun(m: unknown, b: unknown, c: unknown): Promise<{ found: boolean; missingRunner?: string }>;
    }).measurePlayerRun({ id: "m_decoy", title: "Delivery", prompt: "p", status: "running", attempts: 1 }, build, campaign);

    expect(measured.found).toBe(false);
    expect(measured.missingRunner).toContain("are not the bytes being judged");
  }, 20_000);

  /**
   * Plan 1.3 (audit C missed #1, #2): an admitted receipt without a verdict
   * digest bound nothing, and the verdict's run id was compared with the
   * milestone attempt id while the producer had been handed a ticket id.
   */
  describe("admission is binding (plan 1.2, 1.3)", () => {
    const bindingFixture = (
      produce: (root: string, dispatch: { runId?: string; target?: string }, artifactPlayed: string, revision: string) => { receipt?: string },
    ): { measure: (id: string) => Promise<{ found: boolean; missingRunner?: string }> } => {
      const git = (...args: string[]): string => execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8" });
      const artifact = join(projectRoot, "Builds", "StandaloneOSX", "Game.app");
      mkdirSync(join(projectRoot, "Builds", "StandaloneOSX"), { recursive: true });
      writeFileSync(artifact, "the bytes that were built");
      git("init", "-q");
      git("config", "user.email", "t@t");
      git("config", "user.name", "t");
      git("add", "-A");
      git("commit", "-qm", "baseline");
      const revision = git("rev-parse", "HEAD").trim();
      const campaign = {
        id: "c_binding", chatId: "chat", channelType: "cli", userId: "u", projectRoot,
        state: "executing", draftAttempts: 0, milestones: [], currentMilestone: 0,
        createdAt: Date.now(), updatedAt: Date.now(),
      } as unknown as Campaign;
      const player = new CampaignManager({
        storage,
        runPlayer: async (root, artifactPlayed, _spec, dispatch) => produce(root, dispatch ?? {}, artifactPlayed, revision),
        planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
        taskManager: tasks as unknown as TaskManager,
        messenger: async () => {},
        projectRoot,
      });
      const build = { ran: true, ok: true, target: "StandaloneOSX", artifactPath: artifact, sizeBytes: 25, durationMs: 1, scenes: 1 };
      return {
        measure: (id) =>
          (player as unknown as { measurePlayerRun(m: unknown, b: unknown, c: unknown): Promise<{ found: boolean; missingRunner?: string }> })
            .measurePlayerRun({ id, title: "Delivery", prompt: "p", status: "running", attempts: 1 }, build, campaign),
      };
    };
    const verdictRel = join("Recordings", "player-playthrough", "playthrough-verdict.json");
    const receiptFor = (dispatch: { runId?: string; target?: string }, artifactPlayed: string, revision: string, payload?: Record<string, unknown>): string =>
      JSON.stringify({
        schemaVersion: 1, runId: dispatch.runId, kind: "playthrough", medium: "player", revision,
        ...(dispatch.target === undefined ? {} : { target: dispatch.target }),
        artifactSha256: artifactDigest(artifactPlayed),
        execution: { completed: true, exitCode: 0, timedOut: false },
        sessionCount: 1,
        sessions: [{ requestedIndex: 1, index: 1, identityVerified: true, identitySource: "start-acceptance", actions: 12, outcome: "Won", reachedOutcome: true, seconds: 9 }],
        ...(payload === undefined ? {} : { payload }),
      });

    it("an ADMITTED receipt that names no verdict digest is a missing proof, not a pass", async () => {
      const { measure } = bindingFixture((root, dispatch, artifactPlayed, revision) => {
        writePlayerVerdict(true, {}, root);
        return { receipt: receiptFor(dispatch, artifactPlayed, revision) }; // no payload at all
      });
      const unbound = await measure("m_unbound");
      expect(unbound.found).toBe(false);
      expect(unbound.missingRunner).toContain("names no verdict digest");
    });

    it("a REFUSED receipt beside a green verdict is a missing proof, and a valid retry then delivers (plan 1.2)", async () => {
      // The 0-A.6 residue: a receipt saying execution.completed: false was
      // refused by the receiver — and the green file was read anyway.
      let completed = false;
      const { measure } = bindingFixture((root, dispatch, artifactPlayed, revision) => {
        writePlayerVerdict(true, { runId: dispatch.runId }, root);
        const bytes = readFileSync(join(root, verdictRel), "utf8");
        const receipt = JSON.parse(receiptFor(dispatch, artifactPlayed, revision, { verdictPath: verdictRel, verdictSha256: createHash("sha256").update(bytes).digest("hex") })) as Record<string, unknown>;
        receipt["execution"] = { completed, exitCode: completed ? 0 : null, timedOut: false };
        return { receipt: JSON.stringify(receipt) };
      });
      const refused = await measure("m_refused");
      expect(refused.found).toBe(false);
      expect(refused.missingRunner).toContain("refused (PROCESS_INCOMPLETE)");
      // Guard: the refused row in the ledger does not block the retry that is admitted.
      completed = true;
      const retried = await measure("m_refused");
      expect(retried.found).toBe(true);
    });

    it("when this deployment's producers emit receipts, a producer that returns NONE is refused (Codex round 4 #1)", async () => {
      const artifact = join(projectRoot, "Builds", "StandaloneOSX", "Game.app");
      mkdirSync(join(projectRoot, "Builds", "StandaloneOSX"), { recursive: true });
      writeFileSync(artifact, "the bytes that were built");
      const campaign = {
        id: "c_no_receipt", chatId: "chat", channelType: "cli", userId: "u", projectRoot,
        state: "executing", draftAttempts: 0, milestones: [], currentMilestone: 0, createdAt: Date.now(), updatedAt: Date.now(),
      } as unknown as Campaign;
      const strict = new CampaignManager({
        storage,
        receiptsExpected: true,
        runPlayer: async (root) => { writePlayerVerdict(true, {}, root); return {}; },
        planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
        taskManager: tasks as unknown as TaskManager,
        messenger: async () => {},
        projectRoot,
      });
      const build = { ran: true, ok: true, target: "StandaloneOSX", artifactPath: artifact, sizeBytes: 25, durationMs: 1, scenes: 1 };
      const measured = await (strict as unknown as { measurePlayerRun(m: unknown, b: unknown, c: unknown): Promise<{ found: boolean; missingRunner?: string }> })
        .measurePlayerRun({ id: "m_none", title: "Delivery", prompt: "p", status: "running", attempts: 1 }, build, campaign);
      expect(measured.found).toBe(false);
      expect(measured.missingRunner).toContain("returned no receipt");
    });

    it("a refused BUILD receipt ships no artifact, and a refused COMPILE receipt measured nothing (plan 1.2)", async () => {
      const git = (...args: string[]): string => execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8" });
      const artifact = join(projectRoot, "Builds", "StandaloneOSX", "Game.app");
      mkdirSync(join(projectRoot, "Builds", "StandaloneOSX"), { recursive: true });
      writeFileSync(artifact, "the bytes that were built");
      git("init", "-q");
      git("config", "user.email", "t@t");
      git("config", "user.name", "t");
      git("add", "-A");
      git("commit", "-qm", "baseline");
      const revision = git("rev-parse", "HEAD").trim();
      let buildKind = "compile"; // a receipt for the wrong kind of work: KIND_MISMATCH
      let compileKind = "player-build";
      const campaign = {
        id: "c_slots", chatId: "chat", channelType: "cli", userId: "u", projectRoot, gddText: "# GDD",
        state: "executing", draftAttempts: 0, milestones: [{ id: "m1", title: "t", prompt: "p", status: "running", attempts: 1 }], currentMilestone: 0,
        createdAt: Date.now(), updatedAt: Date.now(),
      } as unknown as Campaign;
      const gated = new CampaignManager({
        storage,
        buildPlayer: async (_root, target, runId) => ({
          ran: true, ok: true, target: "StandaloneOSX", artifactPath: artifact, sizeBytes: 25, durationMs: 1, scenes: 1,
          receipt: JSON.stringify({
            schemaVersion: 1, runId, kind: buildKind, medium: "builder", revision, ...(target === undefined ? {} : { target }),
            artifactSha256: artifactDigest(artifact), execution: { completed: true, exitCode: 0, timedOut: false },
          }),
        }),
        runPlaymodeSuite: suiteRunner,
        verifyCompile: async (_root, runId) => ({
          ok: true, ran: true,
          receipt: JSON.stringify({ schemaVersion: 1, runId, kind: compileKind, medium: "compiler", revision, execution: { completed: true, exitCode: 0, timedOut: false } }),
        }),
        planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
        taskManager: tasks as unknown as TaskManager,
        messenger: async () => {},
        projectRoot,
      });
      const internals = gated as unknown as {
        measureBuild(c: unknown): Promise<{ ran: boolean; ok?: boolean; detail?: string }>;
        measureCompile(c: unknown, m: unknown): Promise<{ ran: boolean; ok: boolean; detail?: string }>;
      };
      const refusedBuild = await internals.measureBuild(campaign);
      expect(refusedBuild.ran).toBe(false);
      expect(refusedBuild.detail).toContain("refused (KIND_MISMATCH)");
      const refusedCompile = await internals.measureCompile(campaign, campaign.milestones[0]);
      // Refused is neither a pass nor "not run": the verifier's answer stays, the refusal rides with it (round 4 #2).
      expect(refusedCompile.ran).toBe(true);
      expect(refusedCompile.ok).toBe(false);
      expect(refusedCompile.refused).toContain("refused (KIND_MISMATCH)");
      expect(refusedCompile.detail).toContain("refused (KIND_MISMATCH)");
      // Guards: the same producers, answering for the work they were asked for, are admitted.
      buildKind = "player-build";
      compileKind = "compile";
      expect((await internals.measureBuild(campaign)).ok).toBe(true);
      expect((await internals.measureCompile(campaign, campaign.milestones[0])).ok).toBe(true);
      // …and a ledger that cannot record the ticket is an explicit failure, not an unticketed pass.
      const issue = vi.spyOn(EvidenceLedger.prototype, "issue").mockImplementationOnce(() => { throw new Error("disk full"); });
      try {
        const unrecorded = await internals.measureCompile(campaign, campaign.milestones[0]);
        expect(unrecorded.ran).toBe(false);
        expect(unrecorded.refused).toContain("could not record the ticket");
      } finally {
        issue.mockRestore();
      }
      // …and a settlement that did not settle ("conflict", "unknown-run") is a refusal too (round 4 #5).
      const settle = vi.spyOn(EvidenceLedger.prototype, "settle").mockImplementationOnce(() => "conflict");
      try {
        const conflicted = await internals.measureCompile(campaign, campaign.milestones[0]);
        expect(conflicted.refused).toContain("could not record the receipt (conflict)");
      } finally {
        settle.mockRestore();
      }
    });

    it("the run id the producer stamps is the id it was GIVEN — the ticket's, one namespace", async () => {
      let stamp: (runId: string | undefined) => string | undefined = (runId) => runId;
      const { measure } = bindingFixture((root, dispatch, artifactPlayed, revision) => {
        writePlayerVerdict(true, { runId: stamp(dispatch.runId) }, root);
        const bytes = readFileSync(join(root, verdictRel), "utf8");
        return { receipt: receiptFor(dispatch, artifactPlayed, revision, { verdictPath: verdictRel, verdictSha256: createHash("sha256").update(bytes).digest("hex") }) };
      });
      // Guard: a producer that echoes the ticket's run id is this run's proof.
      const honest = await measure("m_ticket_id");
      expect(honest.found).toBe(true);
      // A verdict stamped with another run's id is not this run's, whatever its clock says.
      stamp = () => "another-run";
      const foreign = await measure("m_other_id");
      expect(foreign.found).toBe(false);
    });
  });

  it("the final sprint is asked for the batch the producer will accept (Codex 2026-09-13 AK#3)", async () => {
    // The contract demanded `sessions="all"`, and the producer refuses that
    // request when the document's rounds are long: the worker could satisfy
    // neither the gate nor the tool, and a correct game could not be
    // delivered. The demand names what this coordinator itself would ask.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, `campaigns-demand-${messages.length}.db`));
    manager = new CampaignManager({
      storage,
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    manager.attachEvents();

    const gdd = "# GDD\n\nThe game ships 30 levels. Each round lasts 300 seconds. You win a level by clearing it.";
    // The document on disk is what the gates judge (plan 1.9): the fixture's
    // sample GDD is replaced by this one, as intake does.
    mkdirSync(join(projectRoot, "docs"), { recursive: true });
    writeFileSync(join(projectRoot, "docs", "Game_GDD.md"), gdd);
    manager.startFromGdd(ctx, gdd, "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    const finalPrompt = tasks.submitted[2]!.prompt;
    // Five 300-second rounds is what one run's budget allows.
    // An unknown catalogue with long rounds is DISCOVERED with one session
    // (plan 0-B.4): the worker is told the same call the gate will make.
    expect(finalPrompt).toContain('unity_playthrough sessions="1"');
    expect(finalPrompt).toContain('with sessions: "1"');
    expect(finalPrompt).not.toContain('sessions="all"');
  }, 20_000);

  it("an audit that RAN discharges the unreadable-queue flag (Codex 2026-09-13 AF#2)", async () => {
    // The flag is persisted now, so it must be cleared by the thing that
    // answers it: a fresh audit re-establishes the requirements.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const live = storage.get(campaign.id)!;
    live.coverageQueueUnreadable = true;
    storage.save(live);

    const build = (manager as unknown as {
      buildCoverageRemediation(c: Campaign): Promise<unknown>;
    }).buildCoverageRemediation.bind(manager);
    const carrying = storage.get(campaign.id)!;
    expect(carrying.coverageQueueUnreadable).toBe(true);
    await build(carrying);
    expect(carrying.coverageQueueUnreadable).toBeUndefined();
  });

  it("builds from the GDD the message NAMED, not the newest one (Codex 2026-09-12 AD#6)", () => {
    // Codex reproduced the discard: the manager chose a repository document
    // by filename distance and modification time, so a different, newer GDD
    // could win over the one the message pointed at.
    mkdirSync(join(projectRoot, "docs"), { recursive: true });
    writeFileSync(join(projectRoot, "docs", "Space_GDD.md"), "# Space\n\nThe game the message asked for.\n" + "x".repeat(400));
    writeFileSync(join(projectRoot, "docs", "Game_GDD.md"), "# Other\n\nA newer document nobody asked for.\n" + "y".repeat(400));

    const named = manager.startFromGddFromDocs({ ...ctx, chatId: "chat-named" }, "docs/Space_GDD.md");
    expect(named?.gddPath).toBe("docs/Space_GDD.md");

    // A path that does not exist is a refusal, not a hint: discovery used to
    // start a campaign on whatever other design the repo held (audit 06.4).
    const missing = manager.startFromGddFromDocs({ ...ctx, chatId: "chat-missing" }, "docs/Nope.md");
    expect(missing).toBeUndefined();
    // …while a message that named nothing still discovers.
    const discovered = manager.startFromGddFromDocs({ ...ctx, chatId: "chat-discover" });
    expect(discovered?.gddPath).toBeDefined();
  });

  it("a message naming a GDD that cannot be read gets told so, and no other design is built (audit 06.4)", async () => {
    mkdirSync(join(projectRoot, "docs"), { recursive: true });
    writeFileSync(join(projectRoot, "docs", "Game_GDD.md"), "# Other\n\nA newer document nobody asked for.\n" + "y".repeat(400));
    const before = tasks.submitted.length;
    const msg = {
      channelType: "cli", chatId: "chat-unreadable", userId: "u1",
      text: "build the game from the GDD at docs/Nope.md",
      timestamp: new Date(),
    } as unknown as IncomingMessage;
    expect(await manager.tryHandleIncoming(msg)).toBe(true);
    const said = messages.filter((m) => m.chatId === "chat-unreadable").map((m) => m.text).join("\n");
    expect(said).toContain("docs/Nope.md");
    expect(said).toContain("could not read");
    expect(said).not.toContain("Building from");
    expect(tasks.submitted.length).toBe(before);
    expect(storage.hasActiveForChat("chat-unreadable")).toBe(false);
  });

  it("asks the requirements it has NOT judged yet (Codex 2026-09-12 AD#16)", async () => {
    // Reproduced by Codex in a project with no git history: the resolver
    // judges at most 30 requirements per call and a closure with no revision
    // is never cached, so the same first thirty were asked on every pass and
    // the thirty-first was never judged at all.
    const seen: string[][] = [];
    const openRequirements = (manager as unknown as {
      openRequirements(c: Campaign): Promise<{ open: string[] }>;
    }).openRequirements.bind(manager);
    (manager as unknown as { planner: { resolveCoverageGaps: unknown } }).planner.resolveCoverageGaps =
      vi.fn(async (_gdd: string, reqs: readonly string[]) => {
        const asked = reqs.slice(0, 30);
        seen.push([...asked]);
        return { closed: [], open: [...asked] };
      });

    const campaign = {
      id: "c_rotate", chatId: "chat1", channelType: "cli", projectRoot,
      gddText: "# GDD", gddPath: "docs/Game_GDD.md", state: "executing", currentMilestone: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
      milestones: Array.from({ length: 31 }, (_unused, i) => ({
        id: `mcov1-${i}`, title: `Req${i + 1}`, prompt: "p", status: "failed",
        attempts: 2, fromAudit: true, coverageGap: `Req${i + 1}: absent`,
      })),
    } as unknown as Campaign;

    await openRequirements(campaign);
    await openRequirements(campaign);

    const everAsked = new Set(seen.flat());
    expect(seen[0]).toHaveLength(30);
    // The second pass reaches the one the first could not.
    expect(everAsked.size).toBe(31);
    expect(everAsked.has("Req31: absent")).toBe(true);
  });

  it("a LEGACY green repair with no coverageGap and no audit mark is still an obligation (Codex plan review #5)", async () => {
    // Rows written before `coverageGap` existed carry their requirement in
    // the prompt's own line. Widening closure membership to every coverage
    // sprint must not drop them, and a green one without the audit mark is
    // exactly the row that used to escape.
    const seen: string[][] = [];
    const openRequirements = (manager as unknown as {
      openRequirements(c: Campaign): Promise<{ open: string[] }>;
    }).openRequirements.bind(manager);
    (manager as unknown as { planner: { resolveCoverageGaps: unknown } }).planner.resolveCoverageGaps =
      vi.fn(async (_gdd: string, reqs: readonly string[]) => {
        seen.push([...reqs]);
        return { closed: [], open: [...reqs] };
      });
    const campaign = {
      id: "c_legacy", chatId: "chat1", channelType: "cli", projectRoot,
      gddText: "# GDD", gddPath: "docs/Game_GDD.md", state: "executing", currentMilestone: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
      milestones: [{
        id: "mcov1", title: "Coverage completion 1.1 — Save progress across restarts: no milestone i",
        prompt: "The audit found this undelivered:\r\n- Save progress across restarts: no milestone implemented it\r\n\r\nImplement it.",
        status: "green", attempts: 1,
      }],
    } as unknown as Campaign;

    const result = await openRequirements(campaign);
    expect(seen.flat()).toContain("Save progress across restarts: no milestone implemented it");
    expect(result.open).toContain("Save progress across restarts: no milestone implemented it");
  });

  it("31 correct requirements without git are all judged in ONE pass, and a finished game delivers (plan 0-B.12)", async () => {
    // The resolver judges thirty per call and the manager asked once,
    // stamping everything it returned — the unasked remainder came back as
    // "open" — so a project without git (nothing to cache a closure against)
    // closed the same thirty every pass and left the thirty-first open until
    // the delivery budget stopped a finished game (Codex 2026-09-17).
    const seen: string[][] = [];
    // A project WITHOUT git: nothing to cache a closure against.
    const noGit = mkdtempSync(join(tmpdir(), "no-git-"));
    const gitless = new CampaignManager({
      storage,
      // The PRODUCTION shape: at most thirty judged, the rest returned unasked.
      planner: {
        planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]),
        resolveCoverageGaps: vi.fn(async (_gdd: string, reqs: readonly string[]) => {
          const asked = reqs.slice(0, 30);
          seen.push([...asked]);
          return { closed: [...asked], open: [], unasked: reqs.slice(30) };
        }),
      } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async () => {},
      projectRoot: noGit,
    });
    const openRequirements = (gitless as unknown as {
      openRequirements(c: Campaign): Promise<{ open: string[] }>;
    }).openRequirements.bind(gitless);
    const campaign = {
      id: "c_all_windows", chatId: "chat1", channelType: "cli", userId: "u", projectRoot: noGit, draftAttempts: 0,
      gddText: "# GDD", gddPath: "docs/Game_GDD.md", state: "executing", currentMilestone: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
      milestones: Array.from({ length: 31 }, (_unused, i) => ({
        id: `mcov1-${i}`, title: `Req${i + 1}`, prompt: "p", status: "green",
        attempts: 1, coverageGap: `Req${i + 1}: absent`,
      })),
    } as unknown as Campaign;

    const result = await openRequirements(campaign);
    // Two windows in one pass: thirty, then the thirty-first.
    expect(seen.map((w) => w.length)).toEqual([30, 1]);
    expect(new Set(seen.flat()).size).toBe(31);
    expect(result.open).toEqual([]);
    // Every requirement carries this pass's stamp.
    expect(campaign.milestones.every((m) => typeof m.coverageJudgedAtMs === "number")).toBe(true);
  });

  it("a pass is bounded, and only what was actually asked is stamped (plan 0-B.12 guard)", async () => {
    const seen: string[][] = [];
    const noGit = mkdtempSync(join(tmpdir(), "no-git-"));
    const gitless = new CampaignManager({
      storage,
      planner: {
        planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]),
        resolveCoverageGaps: vi.fn(async (_gdd: string, reqs: readonly string[]) => {
          const asked = reqs.slice(0, 30);
          seen.push([...asked]);
          return { closed: [], open: [...asked], unasked: reqs.slice(30) };
        }),
      } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async () => {},
      projectRoot: noGit,
    });
    const openRequirements = (gitless as unknown as {
      openRequirements(c: Campaign): Promise<{ open: string[] }>;
    }).openRequirements.bind(gitless);
    const campaign = {
      id: "c_bounded", chatId: "chat1", channelType: "cli", userId: "u", projectRoot: noGit, draftAttempts: 0,
      gddText: "# GDD", gddPath: "docs/Game_GDD.md", state: "executing", currentMilestone: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
      milestones: Array.from({ length: 160 }, (_unused, i) => ({
        id: `mcov1-${i}`, title: `Req${i + 1}`, prompt: "p", status: "failed",
        attempts: 1, coverageGap: `Req${i + 1}: absent`,
      })),
    } as unknown as Campaign;

    const first = await openRequirements(campaign);
    expect(seen).toHaveLength(5);
    const stamped = campaign.milestones.filter((m) => typeof m.coverageJudgedAtMs === "number");
    expect(stamped).toHaveLength(150);
    // …and the ten nobody asked are still OPEN, not silently delivered
    // (Codex 2026-09-17 on 2b44aa8f).
    for (let i = 151; i <= 160; i++) expect(first.open).toContain(`Req${i}: absent`);
    // The next pass asks the ten nobody asked yet, first.
    seen.length = 0;
    await openRequirements(campaign);
    expect(seen[0]!.slice(0, 10)).toEqual(Array.from({ length: 10 }, (_u, i) => `Req${151 + i}: absent`));
  });

  it("151 correct requirements without git close across passes: the tree's fingerprint binds the closures (Codex wave 0-A review 2026-09-17 #2)", async () => {
    // Reproduced: each pass closed 150, left one open, and the next pass
    // re-asked the 150 (an empty revision held no closure) and left one open
    // again, until the delivery budget stopped a finished game.
    const seen: string[][] = [];
    const noGit = mkdtempSync(join(tmpdir(), "no-git-fp-"));
    writeFileSync(join(noGit, "Game.cs"), "class Game {}");
    const gitless = new CampaignManager({
      storage,
      planner: {
        planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]),
        resolveCoverageGaps: vi.fn(async (_gdd: string, reqs: readonly string[]) => {
          const asked = reqs.slice(0, 30);
          seen.push([...asked]);
          return { closed: [...asked], open: [], unasked: reqs.slice(30) };
        }),
      } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async () => {},
      projectRoot: noGit,
    });
    const openRequirements = (gitless as unknown as {
      openRequirements(c: Campaign): Promise<{ open: string[] }>;
    }).openRequirements.bind(gitless);
    const campaign = {
      id: "c_fp", chatId: "chat1", channelType: "cli", userId: "u", projectRoot: noGit, draftAttempts: 0,
      gddText: "# GDD", gddPath: "docs/Game_GDD.md", state: "executing", currentMilestone: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
      milestones: Array.from({ length: 151 }, (_unused, i) => ({
        id: `mcov1-${i}`, title: `Req${i + 1}`, prompt: "p", status: "failed",
        attempts: 1, coverageGap: `Req${i + 1}: absent`,
      })),
    } as unknown as Campaign;

    const first = await openRequirements(campaign);
    expect(seen).toHaveLength(5);
    expect(first.open).toEqual(["Req151: absent"]);
    // The 150 closures are bound to the tree, not to nothing.
    expect(campaign.milestones.filter((m) => m.coverageClosed === true && (m.coverageClosedRevision ?? "").startsWith("fp:"))).toHaveLength(150);
    // The next pass asks ONLY the one nobody asked, and the game is closed.
    seen.length = 0;
    const second = await openRequirements(campaign);
    expect(seen).toEqual([["Req151: absent"]]);
    expect(second.open).toEqual([]);
    // Guard: a tree that changed under the closures is re-judged.
    writeFileSync(join(noGit, "Game.cs"), "class Game { /* edited */ }");
    seen.length = 0;
    await openRequirements(campaign);
    expect(seen.flat().length).toBeGreaterThan(1);
  });

  it("the fingerprint sees a same-length rewrite, walks a symlink cycle once, and skips build folders only at the root (Codex round 3 #6-#9)", () => {
    const noGit = mkdtempSync(join(tmpdir(), "no-git-fp2-"));
    mkdirSync(join(noGit, "Assets", "Library"), { recursive: true });
    mkdirSync(join(noGit, "Library"), { recursive: true });
    writeFileSync(join(noGit, "Assets", "Game.cs"), "class Game { int x = 1; }");
    writeFileSync(join(noGit, "Assets", "Library", "Util.cs"), "class Util {}");
    writeFileSync(join(noGit, "Library", "cache.bin"), "cache");
    const gitless = new CampaignManager({
      storage,
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async () => {},
      projectRoot: noGit,
    });
    const fingerprint = (): string => (gitless as unknown as { projectFingerprint(): string }).projectFingerprint();
    const first = fingerprint();
    expect(first).toMatch(/^fp:[0-9a-f]{64}$/);
    expect(fingerprint()).toBe(first);
    // A build folder at the root is not content; a source folder of the same name is.
    writeFileSync(join(noGit, "Library", "cache.bin"), "CACHE");
    expect(fingerprint()).toBe(first);
    writeFileSync(join(noGit, "Assets", "Library", "Util.cs"), "class Util { }");
    const sourceChanged = fingerprint();
    expect(sourceChanged).not.toBe(first);
    // A same-length rewrite with its mtime restored still moves the fingerprint (ctime does not restore).
    const before = statSync(join(noGit, "Assets", "Game.cs"));
    writeFileSync(join(noGit, "Assets", "Game.cs"), "class Game { int x = 2; }");
    utimesSync(join(noGit, "Assets", "Game.cs"), before.atime, before.mtime);
    expect(fingerprint()).not.toBe(sourceChanged);
    // Two symlinks back to the root are walked once each, and the walk terminates.
    symlinkSync(noGit, join(noGit, "Assets", "a"));
    symlinkSync(noGit, join(noGit, "Assets", "b"));
    const looped = fingerprint();
    expect(looped).toMatch(/^fp:/);
    expect(fingerprint()).toBe(looped);
    // Retargeting a directory link is a change, even when both targets were walked already (round 4 #4).
    mkdirSync(join(noGit, "Assets", "A"), { recursive: true });
    mkdirSync(join(noGit, "Assets", "B"), { recursive: true });
    writeFileSync(join(noGit, "Assets", "A", "a.cs"), "class A {}");
    writeFileSync(join(noGit, "Assets", "B", "b.cs"), "class B {}");
    symlinkSync(join(noGit, "Assets", "A"), join(noGit, "Assets", "zLink"));
    const towardsA = fingerprint();
    rmSync(join(noGit, "Assets", "zLink"));
    symlinkSync(join(noGit, "Assets", "B"), join(noGit, "Assets", "zLink"));
    expect(fingerprint()).not.toBe(towardsA);
  });

  describe("the catalogue is covered in one gate, per artifact (plan 1.10)", () => {
    const range = (sessions: string | undefined, catalogue: number): number[] => {
      if (sessions === undefined || sessions === "all") return Array.from({ length: Math.min(12, catalogue) }, (_u, i) => i + 1);
      const out: number[] = [];
      for (const part of sessions.split(",")) {
        const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
        if (!m) continue;
        const a = Number(m[1]);
        const b = m[2] === undefined ? a : Number(m[2]);
        for (let i = a; i <= b; i++) out.push(i);
      }
      return out;
    };
    const record = (indices: number[], catalogue: number): Record<string, unknown> => ({
      record: {
        medium: "player", scene: "Entry", session: indices[0] ?? 1, autoStarted: false, actions: 12, outcome: "Won", reachedOutcome: true,
        sessionCount: catalogue,
        sessions: indices.map((index) => ({ index, requestedIndex: index, identityVerified: true, identitySource: "start-acceptance", outcome: "Won", reachedOutcome: true, actions: 12, seconds: 9 })),
      },
    });
    const gdd = "# GDD\n\nThe game ships 13 levels. You win a level by clearing it.";

    it("a 13-level game: the gate asks for session 13 itself, and the whole catalogue is covered", async () => {
      const artifact = join(projectRoot, "Builds", "gate", "Game.app");
      mkdirSync(join(projectRoot, "Builds", "gate"), { recursive: true });
      writeFileSync(artifact, "the bytes that were built");
      const asked: Array<string | undefined> = [];
      const campaign = {
        id: "c_gate13", chatId: "chat", channelType: "cli", userId: "u", projectRoot, gddText: gdd,
        state: "executing", draftAttempts: 0, milestones: [], currentMilestone: 0, createdAt: Date.now(), updatedAt: Date.now(),
      } as unknown as Campaign;
      const player = new CampaignManager({
        storage,
        runPlayer: async (root, _artifact, spec) => {
          asked.push(spec?.sessions);
          writePlayerVerdict(true, record(range(spec?.sessions, 13), 13), root);
          return {};
        },
        planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
        taskManager: tasks as unknown as TaskManager,
        messenger: async () => {},
        projectRoot,
      });
      const build = { ran: true, ok: true, target: "StandaloneOSX", artifactPath: artifact, sizeBytes: 25, durationMs: 1, scenes: 1 };
      const measured = await (player as unknown as { measurePlayerRun(m: unknown, b: unknown, c: unknown): Promise<{ found: boolean; ok?: boolean }> })
        .measurePlayerRun({ id: "m_gate", title: "Delivery", prompt: "p", status: "running", attempts: 1 }, build, campaign);
      expect(measured.found).toBe(true);
      // Discovery with one session, then the rest of the catalogue (round 5 #1).
      expect(asked).toEqual(["1", "2-13"]);
      const covered = (player as unknown as { verifiedSessionsFor(c: unknown, a: string): readonly number[] }).verifiedSessionsFor(campaign, artifact);
      expect(covered).toEqual(Array.from({ length: 13 }, (_u, i) => i + 1));
      // …and a second measurement re-measures rather than looping: the game is covered
      // (the catalogue is known from the milestone the caller stored the verdict on).
      campaign.milestones = [{ id: "m_gate", title: "Delivery", prompt: "p", status: "green", attempts: 1, playerPlaythrough: { found: true, ok: true, sessionCount: 13 } }] as never;
      asked.length = 0;
      await (player as unknown as { measurePlayerRun(m: unknown, b: unknown, c: unknown): Promise<unknown> })
        .measurePlayerRun({ id: "m_gate2", title: "Delivery", prompt: "p", status: "running", attempts: 1 }, build, campaign);
      expect(asked).toEqual(["1-12"]);
    });

    it("a red round feeds no coverage, and the claims see the WORST round's timing (round 5 #3, #4)", async () => {
      const artifact = join(projectRoot, "Builds", "worst", "Game.app");
      mkdirSync(join(projectRoot, "Builds", "worst"), { recursive: true });
      writeFileSync(artifact, "the bytes that were built");
      const campaign = {
        id: "c_worst", chatId: "chat", channelType: "cli", userId: "u", projectRoot, gddText: gdd,
        state: "executing", draftAttempts: 0, milestones: [], currentMilestone: 0, createdAt: Date.now(), updatedAt: Date.now(),
      } as unknown as Campaign;
      let redFirst = true;
      let slowFirst = true;
      const player = new CampaignManager({
        storage,
        runPlayer: async (root, _artifact, spec) => {
          const indices = range(spec?.sessions, 13);
          const fps = slowFirst && indices[0] === 1 ? 10 : 60;
          writePlayerVerdict(!(redFirst && indices[0] === 1), { ...record(indices, 13), perf: { medium: "player", bootSeconds: 1.1, playSeconds: 10, playFrames: 600, avgFps: fps, worstFrameMs: fps === 10 ? 200 : 40 } }, root);
          return {};
        },
        planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
        taskManager: tasks as unknown as TaskManager,
        messenger: async () => {},
        projectRoot,
      });
      const build = { ran: true, ok: true, target: "StandaloneOSX", artifactPath: artifact, sizeBytes: 25, durationMs: 1, scenes: 1 };
      const measure = (id: string) => (player as unknown as { measurePlayerRun(m: unknown, b: unknown, c: unknown): Promise<PlaythroughEvidence> })
        .measurePlayerRun({ id, title: "Delivery", prompt: "p", status: "running", attempts: 1 }, build, campaign);
      const covered = (player as unknown as { verifiedSessionsFor(c: unknown, a: string): readonly number[] });
      // Round 1 is RED: nothing is remembered, and the gate does not walk on.
      const red = await measure("m_red");
      expect(red.ok).toBe(false);
      expect(covered.verifiedSessionsFor(campaign, artifact)).toEqual([]);
      // Now green: session 1 at 10 fps, then 2-13 at 60 fps — the claims must see 10.
      redFirst = false;
      const green = await measure("m_green");
      expect(green.ok).toBe(true);
      expect(covered.verifiedSessionsFor(campaign, artifact)).toEqual(Array.from({ length: 13 }, (_u, i) => i + 1));
      expect(green.perf?.avgFps).toBe(10);
      expect(green.perf?.worstFrameMs).toBe(200);
      // #21: every round's sessions survive with their own clocks, and play
      // time is the longest round's, never a sum.
      expect(green.sessions?.map((s) => s.index)).toEqual(Array.from({ length: 13 }, (_u, i) => i + 1));
      expect(green.perf?.playSeconds).toBe(10);
      // #22: the worst timing is remembered against the artifact across gates —
      // a later gate whose own rounds all run at 60 still answers for the 10.
      slowFirst = false;
      const later = await measure("m_later");
      expect(later.perf?.avgFps).toBe(10);
      expect(campaign.verifiedSessions?.perfByArtifact?.[artifactDigest(artifact)!]?.avgFps).toBe(10);
    });

    it("a secondary target walks its own catalogue and answers for its own coverage (round 5 #2)", async () => {
      const a = join(projectRoot, "Builds", "sec", "GameA.app");
      const b = join(projectRoot, "Builds", "sec", "GameB.app");
      mkdirSync(join(projectRoot, "Builds", "sec"), { recursive: true });
      writeFileSync(a, "artifact A");
      writeFileSync(b, "artifact B");
      const campaign = {
        id: "c_sec", chatId: "chat", channelType: "cli", userId: "u", projectRoot, gddText: gdd,
        state: "executing", draftAttempts: 0, milestones: [], currentMilestone: 0, createdAt: Date.now(), updatedAt: Date.now(),
      } as unknown as Campaign;
      const askedB: Array<string | undefined> = [];
      const player = new CampaignManager({
        storage,
        runPlayer: async (root, played, spec) => {
          if (played === b) askedB.push(spec?.sessions);
          writePlayerVerdict(true, record(range(spec?.sessions, 13), 13), root);
          return {};
        },
        planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
        taskManager: tasks as unknown as TaskManager,
        messenger: async () => {},
        projectRoot,
      });
      const milestone = { id: "m_sec", title: "Delivery", prompt: "p", status: "running", attempts: 1 } as unknown as CampaignMilestone;
      const build = {
        ran: true, ok: true, target: "StandaloneOSX", artifactPath: a, sizeBytes: 25, durationMs: 1, scenes: 1,
        artifacts: [{ target: "StandaloneOSX", artifactPath: a }, { target: "StandaloneLinux64", artifactPath: b }],
      };
      await (player as unknown as { measurePlayerRun(m: unknown, b: unknown, c: unknown): Promise<unknown> }).measurePlayerRun(milestone, build, campaign);
      expect(askedB).toEqual(["1", "2-13"]);
      const covered = (player as unknown as { verifiedSessionsFor(c: unknown, a: string): readonly number[] });
      expect(covered.verifiedSessionsFor(campaign, b)).toEqual(Array.from({ length: 13 }, (_u, i) => i + 1));
      // …and the per-target record names the artifact its claims are judged against.
      expect(milestone.playerRunsByTarget?.map((r) => r.artifactPath)).toEqual([a, b]);
    });

    it("guard: two targets keep their own coverage — the sessions one played are not the other's", async () => {
      const a = join(projectRoot, "Builds", "two", "GameA.app");
      const b = join(projectRoot, "Builds", "two", "GameB.app");
      mkdirSync(join(projectRoot, "Builds", "two"), { recursive: true });
      writeFileSync(a, "artifact A");
      writeFileSync(b, "artifact B");
      const campaign = {
        id: "c_two_targets", chatId: "chat", channelType: "cli", userId: "u", projectRoot, gddText: gdd,
        state: "executing", draftAttempts: 0, milestones: [], currentMilestone: 0, createdAt: Date.now(), updatedAt: Date.now(),
      } as unknown as Campaign;
      const player = new CampaignManager({
        storage,
        runPlayer: async (root, played, spec) => {
          // B only ever manages three levels; A plays whatever it is asked.
          writePlayerVerdict(true, record(played === b ? [1, 2, 3] : range(spec?.sessions, 13), 13), root);
          return {};
        },
        planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
        taskManager: tasks as unknown as TaskManager,
        messenger: async () => {},
        projectRoot,
      });
      const build = {
        ran: true, ok: true, target: "StandaloneOSX", artifactPath: a, sizeBytes: 25, durationMs: 1, scenes: 1,
        artifacts: [{ target: "StandaloneOSX", artifactPath: a }, { target: "StandaloneLinux64", artifactPath: b }],
      };
      await (player as unknown as { measurePlayerRun(m: unknown, b: unknown, c: unknown): Promise<unknown> })
        .measurePlayerRun({ id: "m_two", title: "Delivery", prompt: "p", status: "running", attempts: 1 }, build, campaign);
      const covered = (player as unknown as { verifiedSessionsFor(c: unknown, a: string): readonly number[] });
      expect(covered.verifiedSessionsFor(campaign, a)).toEqual(Array.from({ length: 13 }, (_u, i) => i + 1));
      expect(covered.verifiedSessionsFor(campaign, b)).toEqual([1, 2, 3]);
      expect(Object.keys(campaign.verifiedSessions?.byArtifact ?? {})).toHaveLength(2);
    });
  });

  describe("the approved GDD has one version (plan 1.9 / audit 06.2 / D06)", () => {
    const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
    const internals = (m: CampaignManager) => m as unknown as { gddDriftOf(c: Campaign): string | undefined; gddTextOf(c: Campaign): string | undefined };

    it("intake fixes the hash; an edit on disk is a named drift until the amendment is acknowledged", () => {
      const gdd = "# GDD\n\nThe game ships 3 levels.";
      mkdirSync(join(projectRoot, "docs"), { recursive: true });
      writeFileSync(join(projectRoot, "docs", "Game_GDD.md"), gdd);
      const campaign = manager.startFromGdd(ctx, gdd, "docs/Game_GDD.md");
      expect(campaign.gddSha256).toBe(sha(gdd));
      expect(storage.get(campaign.id)!.gddSha256).toBe(sha(gdd));
      expect(internals(manager).gddDriftOf(campaign)).toBeUndefined();
      // Someone appends a section after approval: the gates would judge a document nobody approved.
      writeFileSync(join(projectRoot, "docs", "Game_GDD.md"), gdd + "\n\n## Multiplayer\n\nFour players online.");
      const drift = internals(manager).gddDriftOf(campaign);
      expect(drift).toContain("is not the approved document");
      // The accessor reads the disk (what workers read), never a silent choice between versions.
      expect(internals(manager).gddTextOf(campaign)).toContain("Multiplayer");
      // An explicit amendment takes the file as approved again.
      const amended = manager.amendGdd(campaign.id);
      expect(amended).toBe(sha(gdd + "\n\n## Multiplayer\n\nFour players online."));
      expect(internals(manager).gddDriftOf(storage.get(campaign.id)!)).toBeUndefined();
    });

    it("approval freezes the document on disk at that moment; an intake path cannot leave the project; 'amend gdd' re-approves by hash (round 6 #3, #4, #5)", async () => {
      // #3: an idea-mode campaign awaiting approval — the text on disk when
      // the person says yes is the approved one, by hash, not whatever the
      // first delivery gate later finds.
      mkdirSync(join(projectRoot, "docs"), { recursive: true });
      const drafted = "# GDD\n\nDrafted: 2 levels.";
      writeFileSync(join(projectRoot, "docs", "Drafted_GDD.md"), drafted);
      const awaiting = {
        id: "c_await", chatId: "chat-approve", channelType: "cli", userId: "u", projectRoot, gddPath: "docs/Drafted_GDD.md",
        state: "awaiting-approval", draftAttempts: 1, milestones: [], currentMilestone: 0, createdAt: Date.now(), updatedAt: Date.now(),
      } as unknown as Campaign;
      storage.save(awaiting);
      expect(await manager.tryHandleApproval("chat-approve", "yes")).toBe(true);
      const approved = storage.get("c_await")!;
      expect(approved.gddSha256).toBe(sha(drafted));
      writeFileSync(join(projectRoot, "docs", "Drafted_GDD.md"), drafted + "\n\n## Multiplayer");
      expect(internals(manager).gddDriftOf(storage.get("c_await")!)).toContain("is not the approved document");
      // The approval's planning pass persists its own copy of the campaign;
      // the amendment is sent once that has landed.
      await waitFor(() => expect(storage.get("c_await")!.state).toBe("executing"));
      // #5: the amendment is a chat command, scoped to the chat's campaign.
      expect(await manager.tryHandleIncoming({ chatId: "chat-approve", text: "amend gdd" } as never)).toBe(true);
      expect(internals(manager).gddDriftOf(storage.get("c_await")!)).toBeUndefined();
      expect(storage.get("c_await")!.gddSha256).toBe(sha(drafted + "\n\n## Multiplayer"));
      // #4: a path that leaves the project is not written; the text stands alone.
      const outside = manager.startFromGdd({ ...ctx, chatId: "chat-outside" }, "# GDD\n\nEscape.", "../escaped-gdd.md");
      expect(existsSync(join(projectRoot, "..", "escaped-gdd.md"))).toBe(false);
      expect(outside.gddPath).toBeUndefined();
      expect(outside.gddText).toBe("# GDD\n\nEscape.");
      // Round 7 #5: a LEAF that is a symlink out of the project is not written through; a
      // folder whose name merely starts with dots is fine.
      const victim = join(dir, "victim.md");
      writeFileSync(victim, "untouched");
      symlinkSync(victim, join(projectRoot, "docs", "Linked_GDD.md"));
      const linked = manager.startFromGdd({ ...ctx, chatId: "chat-linked" }, "# GDD\n\nThrough the link.", "docs/Linked_GDD.md");
      expect(readFileSync(victim, "utf8")).toBe("untouched");
      expect(linked.gddPath).toBeUndefined();
      // Round 8 #13: a DANGLING symlink out of the project is not "missing".
      symlinkSync(join(dir, "absent-victim.md"), join(projectRoot, "docs", "Dangling_GDD.md"));
      const dangling = manager.startFromGdd({ ...ctx, chatId: "chat-dangling" }, "# GDD\n\nThrough a dangling link.", "docs/Dangling_GDD.md");
      expect(existsSync(join(dir, "absent-victim.md"))).toBe(false);
      expect(dangling.gddPath).toBeUndefined();
      // Round 9 #35: a dangling link whose target is INSIDE the project is
      // legitimate — the document has simply not been written yet — and was
      // refused, losing the path the person gave.
      mkdirSync(join(projectRoot, "design"), { recursive: true });
      symlinkSync(join("..", "design", "Inside_GDD.md"), join(projectRoot, "docs", "Inside_GDD.md"));
      const inside = manager.startFromGdd({ ...ctx, chatId: "chat-inside" }, "# GDD\n\nThrough a contained link.", "docs/Inside_GDD.md");
      expect(inside.gddPath).toBe("docs/Inside_GDD.md");
      expect(readFileSync(join(projectRoot, "design", "Inside_GDD.md"), "utf8")).toBe("# GDD\n\nThrough a contained link.");
      // A chain of contained links is followed too…
      symlinkSync(join("..", "docs", "Inside_GDD.md"), join(projectRoot, "design", "Chained_GDD.md"));
      const chained = manager.startFromGdd({ ...ctx, chatId: "chat-chained" }, "# GDD\n\nChained.", "design/Chained_GDD.md");
      expect(chained.gddPath).toBe("design/Chained_GDD.md");
      // …and a LOOP runs out of hops instead of spinning.
      symlinkSync(join(projectRoot, "docs", "LoopB_GDD.md"), join(projectRoot, "docs", "LoopA_GDD.md"));
      symlinkSync(join(projectRoot, "docs", "LoopA_GDD.md"), join(projectRoot, "docs", "LoopB_GDD.md"));
      const looped = manager.startFromGdd({ ...ctx, chatId: "chat-loop" }, "# GDD\n\nLoop.", "docs/LoopA_GDD.md");
      expect(looped.gddPath).toBeUndefined();
      mkdirSync(join(projectRoot, "..design"), { recursive: true });
      const dotted = manager.startFromGdd({ ...ctx, chatId: "chat-dotted" }, "# GDD\n\nDotted.", "..design/GDD.md");
      expect(dotted.gddPath).toBe("..design/GDD.md");
      expect(readFileSync(join(projectRoot, "..design", "GDD.md"), "utf8")).toBe("# GDD\n\nDotted.");
    });

    it("an amendment survives a stale save from planning, and a row with nothing to approve is not approved (round 7 #4, #7)", async () => {
      mkdirSync(join(projectRoot, "docs"), { recursive: true });
      const text = "# GDD\n\nRevision one.";
      writeFileSync(join(projectRoot, "docs", "Rev_GDD.md"), text);
      const campaign = manager.startFromGdd({ ...ctx, chatId: "chat-rev" }, text, "docs/Rev_GDD.md");
      await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("executing"));
      // A stale copy from before the amendment…
      const stale = storage.get(campaign.id)!;
      writeFileSync(join(projectRoot, "docs", "Rev_GDD.md"), text + " Amended.");
      expect(manager.amendGdd(campaign.id)).toBe(sha(text + " Amended."));
      // …saved afterwards does not restore the old document.
      (manager as unknown as { persist(c: Campaign): boolean }).persist(stale);
      expect(storage.get(campaign.id)!.gddSha256).toBe(sha(text + " Amended."));
      expect(storage.get(campaign.id)!.gddText).toBe(text + " Amended.");
      // #4: nothing to approve — the gate stays.
      const empty = {
        id: "c_empty", chatId: "chat-empty", channelType: "cli", userId: "u", projectRoot, gddPath: "docs/Missing_GDD.md",
        state: "awaiting-approval", draftAttempts: 1, milestones: [], currentMilestone: 0, createdAt: Date.now(), updatedAt: Date.now(),
      } as unknown as Campaign;
      storage.save(empty);
      expect(await manager.tryHandleApproval("chat-empty", "yes")).toBe(true);
      expect(storage.get("c_empty")!.state).toBe("awaiting-approval");
      expect(storage.get("c_empty")!.gddSha256).toBeUndefined();
    });

    it("a row from before the hash takes the text it holds as approved (migration), and a text-only intake cannot drift", () => {
      const gdd = "# GDD\n\nThe game ships 2 levels.";
      mkdirSync(join(projectRoot, "docs"), { recursive: true });
      writeFileSync(join(projectRoot, "docs", "Old_GDD.md"), gdd);
      const old = { ...manager.startFromGdd(ctx, gdd, "docs/Old_GDD.md"), gddSha256: undefined } as Campaign;
      delete (old as { gddSha256?: string }).gddSha256;
      expect(internals(manager).gddDriftOf(old)).toBeUndefined();
      expect(old.gddSha256).toBe(sha(gdd));
      expect(storage.get(old.id)!.gddSha256).toBe(sha(gdd));
      // …and a drift after the migration is still seen.
      writeFileSync(join(projectRoot, "docs", "Old_GDD.md"), gdd + " Edited.");
      expect(internals(manager).gddDriftOf(old)).toContain("is not the approved document");
      // No file: nothing to drift from; the intake text is the document.
      const textOnly = manager.startFromGdd(ctx, "# GDD\n\nText only.");
      expect(textOnly.gddSha256).toBe(sha("# GDD\n\nText only."));
      expect(internals(manager).gddDriftOf(textOnly)).toBeUndefined();
      expect(internals(manager).gddTextOf(textOnly)).toBe("# GDD\n\nText only.");
    });
  });

  it("a requirement is not its diagnostics (Codex 2026-09-12 AD#15)", () => {
    // Reproduced by Codex: the same missing capability reported as "…,
    // attempt 1" and "…, attempt 2" were two requirements. Each rewording got
    // a fresh repair budget, and the changed text let the previous one be
    // reconciled away unfixed — twenty iterations, twenty repairs, nineteen
    // descriptions cleared.
    const base = "EVIDENCE UNAVAILABLE — no tool for it in this run: audio generator unavailable";
    expect(requirementKey(`${base}, attempt 1`)).toBe(requirementKey(`${base}, attempt 2`));
    expect(requirementKey(`${base} (attempt 3 of 5)`)).toBe(requirementKey(base));
    expect(requirementKey(`${base} — try 7`)).toBe(requirementKey(base));
    expect(requirementKey("Shop: absent at 2026-09-12T21:14:00Z")).toBe(requirementKey("Shop: absent"));
    expect(requirementKey("Shop: absent run a1b2c3d4")).toBe(requirementKey("Shop: absent"));
    // …and two DIFFERENT requirements are still different.
    expect(requirementKey("Save: absent")).not.toBe(requirementKey("Shop: absent"));
    // A number that is part of what was asked for is not a diagnostic tail.
    expect(requirementKey("The game ships 12 levels")).toBe("The game ships 12 levels");
  });

  it("never headlines a campaign that is not done as complete (Codex 2026-09-12 AD#10)", () => {
    // Reproduced by Codex: a campaign with green milestones and a clean
    // compile that FAILED because no entry scene could be opened — an error
    // without the "NOT DELIVERED" prefix and an empty missing-proof list —
    // was headlined "🏁 Campaign delivery — game build complete". And a
    // stored `{state:"done", milestones: []}` produced the same headline.
    const report = (over: Partial<Campaign>): string =>
      (manager as unknown as { buildDeliveryReport(c: Campaign): string }).buildDeliveryReport({
        id: "c1", chatId: "chat1", channelType: "cli", projectRoot,
        gddPath: "docs/Game_GDD.md", state: "done", currentMilestone: 0,
        milestones: [{ id: "m1", title: "Sprint A", prompt: "p", status: "green", attempts: 1 }],
        createdAt: Date.now(), updatedAt: Date.now(),
        ...over,
      } as Campaign);

    expect(report({ state: "failed", lastError: "no entry scene could be opened" })).toContain("NOT DELIVERED");
    expect(report({ state: "failed", lastError: "no entry scene could be opened" })).toContain("no entry scene");
    expect(report({ state: "failed" })).toContain("recorded no cause");
    // A record with no sprint at all says so instead of reading as a delivery.
    expect(report({ milestones: [] })).toContain("carries no sprint at all");
    // …and a campaign that really is done still reads as delivered.
    expect(report({})).toContain("game build complete");
  });

  it("a GREEN repair does not erase the requirement it did not implement (Codex 2026-09-12 AD#2)", async () => {
    // Reproduced by Codex: audit one finds Save missing, repair one goes
    // green without implementing it, audit two finds it again, repair two
    // goes green too. `openRequirements` looked only at FAILED repairs, so
    // with the audit rounds spent nothing was open and the campaign could
    // finish with the feature absent.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, `campaigns-green-repair-${messages.length}.db`));
    const planner = {
      planMilestones: vi.fn().mockResolvedValue(LADDER),
      auditCoverage: vi.fn().mockResolvedValue(["Save progress across restarts: no milestone implemented it"]),
      // The delivery audit is asked, and it says the requirement is still not
      // delivered — whatever the repair's own status says.
      resolveCoverageGaps: vi.fn(async (_gdd: string, reqs: readonly string[]) => ({ closed: [], open: [...reqs] })),
    } as unknown as CampaignPlanner;
    manager = new CampaignManager({
      storage,
      planner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => messages.push({ chatId, text }),
      projectRoot,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    manager.attachEvents();

    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    mkdirSync(join(projectRoot, "Recordings", "playthrough"), { recursive: true });
    writeFileSync(join(projectRoot, "Recordings", "playthrough", "frame_00099.png"), Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(4096, 7)]));
    settleMilestone("final report"); // the audit finds Save missing → a repair sprint

    // Every repair reports success without the feature; the campaign must
    // never call that delivered.
    for (let i = 0; i < 10 && storage.get(campaign.id)!.state === "executing"; i++) {
      const before = tasks.submitted.length;
      settleMilestone("all 42 tests pass, frames captured");
      await waitFor(
        () => expect(tasks.submitted.length > before || storage.get(campaign.id)!.state !== "executing").toBe(true),
        { timeout: 15_000 },
      );
    }
    expect(storage.get(campaign.id)!.state).not.toBe("done");
    const report = messages.map((m) => m.text).join("\n");
    expect(report).toContain("Save progress across restarts");
  });

  it("a QUEUED repair that went green without its requirement is still asked at closure (audit 06.1)", async () => {
    // Five gaps from one audit: four are scheduled, the fifth is queued and
    // drained by the next round WITHOUT the audit mark. Closure membership
    // was "failed, or created by an audit", so the drained sprint — green,
    // requirement not implemented — was never asked about and the campaign
    // could finish with the feature absent.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, `campaigns-queued-green-${messages.length}.db`));
    const QUEUED = "Leaderboard: no milestone implemented the score table";
    const planner = {
      planMilestones: vi.fn().mockResolvedValue(LADDER),
      auditCoverage: vi
        .fn()
        .mockResolvedValueOnce([
          "Save progress across restarts: no milestone implemented it",
          "Settings menu: no milestone implemented it",
          "Pause overlay: no milestone implemented it",
          "Tutorial prompts: no milestone implemented it",
          QUEUED,
        ])
        .mockResolvedValue([]),
      // Everything else closes; the queued one is still not delivered.
      resolveCoverageGaps: vi.fn(async (_gdd: string, reqs: readonly string[]) => ({
        closed: reqs.filter((r) => r !== QUEUED),
        open: reqs.filter((r) => r === QUEUED),
      })),
    } as unknown as CampaignPlanner;
    manager = new CampaignManager({
      storage,
      planner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => messages.push({ chatId, text }),
      projectRoot,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    manager.attachEvents();

    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    mkdirSync(join(projectRoot, "Recordings", "playthrough"), { recursive: true });
    writeFileSync(join(projectRoot, "Recordings", "playthrough", "frame_00099.png"), Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(4096, 7)]));
    settleMilestone("final report"); // the audit finds five gaps → four sprints, one queued

    for (let i = 0; i < 14 && storage.get(campaign.id)!.state === "executing"; i++) {
      const before = tasks.submitted.length;
      settleMilestone("all 42 tests pass, frames captured");
      await waitFor(
        () => expect(tasks.submitted.length > before || storage.get(campaign.id)!.state !== "executing").toBe(true),
        { timeout: 15_000 },
      );
    }
    // The queued gap got its own sprint (drained from the queue, no audit mark)…
    const drained = storage.get(campaign.id)!.milestones.find((m) => m.coverageGap === QUEUED);
    expect(drained).toBeDefined();
    expect(drained!.fromAudit).not.toBe(true);
    // …and although it went green, the campaign is not delivered with the
    // requirement still open.
    expect(storage.get(campaign.id)!.state).not.toBe("done");
    expect(messages.map((m) => m.text).join("\n")).toContain("Leaderboard");
  });

  it("schedules one gap sprint per audit finding, art first, and moves past a spent one", async () => {
    // Measured 2026-09-07: art + audio + story in ONE remediation sprint;
    // four attempts, the time-box narrowed three of them to something that
    // was never the art, and the campaign delivered with all three open.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-gap-sprints.db"));
    const planner = {
      planMilestones: vi.fn().mockResolvedValue(LADDER),
      auditCoverage: vi
        .fn()
        .mockResolvedValueOnce([
          "Audio production: base music loop and SFX are not covered",
          "Art production: pig skins and area backgrounds are not covered",
          "Story and theme content: area naming vignettes are not covered",
        ])
        .mockResolvedValue([]),
    } as unknown as CampaignPlanner;
    manager = new CampaignManager({
      storage,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      planner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => {
        messages.push({ chatId, text });
      },
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    manager.attachEvents();

    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    settleMilestone("final report");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4), { timeout: 15_000 });

    const ids = storage.get(campaign.id)!.milestones.map((m) => m.id);
    expect(ids).toEqual(["m1", "m2", "m3", "mcov1", "mcov1-2", "mcov1-3"]);
    const first = storage.get(campaign.id)!.milestones[3]!;
    expect(first.title).toContain("Art production");
    expect(first.prompt).toContain("- Art production");
    expect(first.prompt).not.toContain("Audio production");

    // The art sprint spends both attempts: the campaign moves to the audio gap.
    tasks.emit("task:failed", "task_4", "no art was made");
    await waitFor(() => expect(tasks.submitted).toHaveLength(5), { timeout: 15_000 });
    tasks.emit("task:failed", "task_5", "no art was made");
    await waitFor(() => expect(tasks.submitted).toHaveLength(6), { timeout: 15_000 });
    const after = storage.get(campaign.id)!;
    expect(after.state).toBe("executing");
    expect(after.milestones[3]!.status).toBe("failed");
    expect(after.currentMilestone).toBe(4);
    expect(tasks.submitted[5]!.prompt).toContain("Audio production");
    expect(messages.at(-1)!.text).toContain("Moving on to");
  });

  /**
   * A campaign whose coverage-remediation sprint spends both attempts on
   * "Dragon boss", and whose FINAL PROOF sprint then reports green. The
   * evidence audit for the unclosed requirement answers with `resolve`.
   */
  const runToSpentRemediation = async (
    resolve: (reqs: readonly string[]) => { closed: string[]; open: string[] } = (reqs) => ({ closed: [], open: [...reqs] }),
    beforeFinalSettle?: (campaignId: string) => void,
  ): Promise<ReturnType<typeof manager.startFromGdd>> => {
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, `campaigns-partial-${messages.length}.db`));
    const planner = {
      planMilestones: vi.fn().mockResolvedValue(LADDER),
      auditCoverage: vi.fn().mockResolvedValue(["Dragon boss: no milestone implemented it"]),
      resolveCoverageGaps: vi.fn(async (_gdd: string, reqs: readonly string[]) => resolve(reqs)),
    } as unknown as CampaignPlanner;
    manager = new CampaignManager({
      storage,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      planner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => {
        if (messengerDownFor?.test(text)) throw new Error("messenger unavailable");
        // A test can make the world move DURING the send: sending is an
        // await, and what settles inside it is exactly the AK#7 race.
        messengerHook?.();
        messages.push({ chatId, text });
      },
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    manager.attachEvents();

    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    settleMilestone("final report"); // audit finds the gap → mcov1 appended
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));

    // The remediation sprint burns both its attempts without landing green.
    tasks.emit("task:failed", "task_4", "the boss scene will not compile");
    await waitFor(() => expect(tasks.submitted).toHaveLength(5));
    tasks.emit("task:failed", "task_5", "the boss scene will not compile");

    // Not `done` on that: the game was never re-proven after the remediation
    // touched it. A final proof sprint is the ladder's last milestone now.
    await waitFor(() => expect(tasks.submitted).toHaveLength(6));
    expect(storage.get(campaign.id)!.state).toBe("executing");
    expect(tasks.submitted[5]!.prompt).toContain("FINAL DELIVERY PROOFS");
    expect(tasks.submitted[5]!.prompt).toContain("Dragon boss");
    expect(storage.get(campaign.id)!.milestones.at(-1)!.id).toMatch(/^mfinal-/);
    // The proof sprint captured a frame of the running game.
    mkdirSync(join(projectRoot, "Recordings", "playthrough"), { recursive: true });
    writeFileSync(join(projectRoot, "Recordings", "playthrough", "frame_00099.png"), Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(4096, 7)]));
    beforeFinalSettle?.(campaign.id);
    settleMilestone("final proofs green");
    return campaign;
  };

  it("a spent coverage-remediation sprint does not deliver by itself: a FINAL PROOF sprint runs the whole gate, and required work nothing closed is NOT delivered (Codex 2026-09-11 B#1, 2026-09-12 U)", async () => {
    // Audited 2026-09-02: a remediation sprint (mcovN) that exhausted its
    // attempts after every planned sprint had gone green ended the campaign
    // with "❌ Campaign stopped" — nothing at all was reported about the game
    // that was actually built, and the gaps it failed to close were never
    // named either. So the ladder learned to run a final proof sprint and
    // report everything.
    // …and then it DELIVERED on those mechanical proofs with the feature
    // still missing: "Dragon boss" was named in the report under a headline
    // that said the game was built (Codex 2026-09-12 U, Job 2.7). Exhaustion
    // stops the repair; it does not waive the requirement.
    const campaign = await runToSpentRemediation();

    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"), { timeout: 15_000 });
    const stopped = storage.get(campaign.id)!;
    // Everything the ladder DID prove is still green and still reported.
    expect(stopped.milestones.filter((m) => m.status === "green")).toHaveLength(4);
    expect(stopped.milestones.at(-1)!.status).toBe("green");
    expect(stopped.milestones.at(-2)!.status).toBe("failed");
    expect(stopped.lastError).toContain("Dragon boss");
    expect(stopped.milestones.at(-1)!.deliveryFailureKinds).toContain("unclosedGaps");

    const report = messages.at(-1)!.text;
    expect(report).toContain("NOT DELIVERED");
    expect(report).toContain("Sprint A — Foundations");
    expect(report).toContain("Dragon boss: no milestone implemented it");
    expect(report).not.toContain("Campaign stopped");
    // No reviewer wired here: the report says so instead of implying a review.
    expect(report).toContain("Independent review");
    expect(report).toContain("UNAVAILABLE");
    // The structure block is measured at delivery, on the tree delivered:
    // this fixture has no Assets/, and the report says exactly that.
    expect(report).toContain("NOT measured: no Assets/ directory");
  });

  it("…and delivers when the evidence audit finds the unclosed requirement delivered after all (Codex 2026-09-12 U)", async () => {
    // The other direction of the same gate: a sprint's failure is not the
    // requirement's verdict either. When the ladder's evidence shows the work
    // landed — a later sprint did it, or the failed sprint's own commits did —
    // the requirement is closed and the campaign delivers.
    const campaign = await runToSpentRemediation((reqs) => ({ closed: [...reqs], open: [] }));

    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"), { timeout: 15_000 });
    const delivered = storage.get(campaign.id)!;
    expect(delivered.milestones.at(-2)!.coverageClosed).toBe(true);
    // …with the revision it was read on beside it, or the next round cannot
    // tell whether the closure still describes the tree (V#4). This fixture
    // is not a git checkout, so the recorded revision is the empty one.
    expect(delivered.milestones.at(-2)!.coverageClosedRevision).toBeDefined();
    expect(delivered.deliveryReported).toBe(true);
    const report = messages.at(-1)!.text;
    expect(report).toContain("Campaign delivery");
    expect(report).toContain("requirement found delivered by the evidence audit");
    // …and the report does not also call that requirement undelivered: the
    // sprint's own history stands, its requirement's closure is stated as
    // what it is (Codex 2026-09-12 V#7).
    expect(report).toContain("the evidence audit then found its requirement delivered");
    expect(report).not.toMatch(/are NOT delivered: Dragon boss/);
  });

  it("a stored closure from ANOTHER revision is judged again (Codex 2026-09-12 V#4)", async () => {
    // The flag was permanent and carried no revision, so a requirement found
    // delivered once was never judged again: the code implementing it could
    // be removed afterwards and the gate would never look. The matching and
    // unknown-revision cases are unit-tested in prose-only.test.ts.
    const asked: string[][] = [];
    const campaign = await runToSpentRemediation(
      (reqs) => {
        asked.push([...reqs]);
        return { closed: [], open: [...reqs] };
      },
      (id) => {
        // A closure recorded on a revision this delivery is not.
        const live = storage.get(id)!;
        const repair = live.milestones.find((m) => m.coverageGap?.includes("Dragon boss"))!;
        repair.coverageClosed = true;
        repair.coverageClosedRevision = "0".repeat(40);
        storage.save(live);
      },
    );

    await waitFor(() => expect(asked.length).toBeGreaterThan(0), { timeout: 15_000 });
    expect(asked[0]![0]).toContain("Dragon boss");
    const after = storage.get(campaign.id)!;
    expect(after.state).not.toBe("done");
    expect(`${after.lastError}`).toContain("Dragon boss");
    // …and the closure the audit has just WITHDRAWN is gone: left standing,
    // the report called the same requirement delivered on the sprint's line
    // and NOT DELIVERED in its headline (Codex 2026-09-12 W#8).
    const repair = after.milestones.find((m) => m.coverageGap?.includes("Dragon boss"))!;
    expect(repair.coverageClosed).toBeUndefined();
    expect(repair.coverageClosedRevision).toBeUndefined();
    expect(messages.at(-1)!.text).not.toContain("found delivered by the evidence audit");
  });

  it("the partial-delivery path answers for the requirements nobody closed (Codex 2026-09-12 V#5)", async () => {
    // Reproduced by Codex on a restored ladder: an exhausted repair with a
    // green final behind it measured the shipped tree, found no structural
    // refusal, and set `done` — the requirement its own sprint had named was
    // never judged, and the evidence audit was not asked at all.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1), { timeout: 15_000 });

    const restored = storage.get(campaign.id)!;
    restored.milestones = [
      { ...restored.milestones[0]!, status: "green", taskId: undefined },
      {
        id: "mcov1",
        title: "Coverage completion 1.1 — Boss",
        coverageGap: "Boss: absent",
        prompt: "Implement the boss.\n- Boss: absent\n",
        status: "running",
        attempts: 2,
        taskId: "task_1",
      },
      { id: "mfinal1", title: "Final delivery proofs", prompt: "Prove it.", status: "green", attempts: 1 },
    ] as never;
    restored.currentMilestone = 1;
    restored.state = "executing";
    storage.save(restored);

    tasks.emit("task:failed", "task_1", "the boss scene will not compile");

    await waitFor(() => expect(storage.get(campaign.id)!.state).not.toBe("executing"), { timeout: 15_000 });
    const after = storage.get(campaign.id)!;
    expect(after.state).toBe("failed");
    expect(`${after.lastError}`).toContain("Boss: absent");
    expect(messages.at(-1)!.text).toContain("NOT DELIVERED");
  });

  it("two failed repairs for ONE requirement are asked about once (Codex 2026-09-12 W#2)", async () => {
    // Each was asked separately, and opposite answers — one id delivered, the
    // other not — stamped BOTH of them closed.
    const asked: string[][] = [];
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1), { timeout: 15_000 });

    const restored = storage.get(campaign.id)!;
    restored.milestones = [
      { ...restored.milestones[0]!, status: "green", taskId: undefined },
      { id: "mcov1", title: "Coverage completion 1.1 — Boss", coverageGap: "Boss: absent", prompt: "Implement the boss.\n- Boss: absent\n", status: "failed", attempts: 2 },
      { id: "mcov2", title: "Coverage completion 2.1 — Boss", coverageGap: "Boss: absent", prompt: "Implement the boss.\n- Boss: absent\n", status: "running", attempts: 2, taskId: "task_1" },
      { id: "mfinal1", title: "Final delivery proofs", prompt: "Prove it.", status: "green", attempts: 1 },
    ] as never;
    restored.currentMilestone = 2;
    restored.state = "executing";
    storage.save(restored);
    (manager as unknown as { planner: { resolveCoverageGaps: unknown } }).planner.resolveCoverageGaps =
      vi.fn(async (_gdd: string, reqs: readonly string[]) => {
        asked.push([...reqs]);
        return { closed: [], open: [...reqs] };
      });

    tasks.emit("task:failed", "task_1", "the boss scene will not compile");
    await waitFor(() => expect(storage.get(campaign.id)!.state).not.toBe("executing"), { timeout: 15_000 });

    // ONE question for one requirement, however many sprints tried it.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual(["Boss: absent"]);
    const after = storage.get(campaign.id)!;
    expect(after.state).toBe("failed");
    expect(after.milestones.filter((m) => m.coverageClosed === true)).toHaveLength(0);
  });

  /**
   * A campaign on a REAL clean checkout, so a recorded closure can hold for
   * the revision it names — the git-less fixture leaves every revision
   * unknown, and unknown binds nothing.
   */
  const onACleanCheckout = async (
    rows: Array<Record<string, unknown>>,
    resolve: (reqs: readonly string[]) => { closed: string[]; open: string[] },
    asked: string[][],
  ): Promise<{ id: string; head: string }> => {
    const { execFileSync } = await import("node:child_process");
    const repoRoot = mkdtempSync(join(tmpdir(), "campaign-clean-repo-"));
    repos.push(repoRoot);
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    writeFileSync(join(repoRoot, "docs", "Game_GDD.md"), "# GDD\n\nThe game ships a boss.");
    const git = (...args: string[]): void => { execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }); };
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-q", "-m", "the tree the closure was read on");
    const head = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, `campaigns-clean-${repos.length}.db`));
    manager = new CampaignManager({
      storage,
      planner: {
        planMilestones: vi.fn().mockResolvedValue(LADDER),
        auditCoverage: vi.fn().mockResolvedValue([]),
        resolveCoverageGaps: vi.fn(async (_gdd: string, reqs: readonly string[]) => {
          asked.push([...reqs]);
          return resolve(reqs);
        }),
      } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot: repoRoot,
      retryAdoptionGraceMs: 10, completedSettleDelayMs: 0, milestoneTimeBoxMs: 60 * 60_000,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => ({ ok: true, ran: true, errors: 0 }),
    });
    manager.attachEvents();
    const campaign = manager.startFromGdd(ctx, "# GDD\n\nThe game ships a boss.", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1), { timeout: 15_000 });
    const restored = storage.get(campaign.id)!;
    restored.milestones = [
      { ...restored.milestones[0]!, status: "green", taskId: undefined },
      ...rows.map((r) => ({ ...r, head })),
      { id: "mfinal1", title: "Final delivery proofs", prompt: "Prove it.", status: "green", attempts: 1 },
    ] as never;
    restored.currentMilestone = 1;
    restored.state = "executing";
    storage.save(restored);
    return { id: campaign.id, head };
  };

  it("a sibling row's stale closure is withdrawn with its requirement (Codex 2026-09-12 X#5)", async () => {
    // The closure check ran BEFORE grouping, so a second repair for the same
    // requirement kept its stale closure while the fresh judgment said open —
    // and the report rendered its delivered line anyway.
    const asked: string[][] = [];
    const { id, head } = await onACleanCheckout(
      [
        { id: "mcov1", title: "c", coverageGap: "Boss: absent", prompt: "p", status: "running", attempts: 2, taskId: "task_1" },
        { id: "mcov2", title: "c", coverageGap: "Boss: absent", prompt: "p", status: "failed", attempts: 2, coverageClosed: true },
      ],
      (reqs) => ({ closed: [], open: [...reqs] }),
      asked,
    );
    // The cached row's closure names THIS revision, so it would hold.
    const seeded = storage.get(id)!;
    seeded.milestones[2]!.coverageClosedRevision = head;
    storage.save(seeded);

    tasks.emit("task:failed", "task_1", "the boss scene will not compile");
    await waitFor(() => expect(storage.get(id)!.state).not.toBe("executing"), { timeout: 15_000 });

    const after = storage.get(id)!;
    expect(asked).toEqual([["Boss: absent"]]);
    expect(after.milestones.filter((m) => m.coverageClosed === true)).toHaveLength(0);
    expect(after.state).not.toBe("done");
    expect(messages.map((m) => m.text).join("\n")).not.toContain("found delivered by the evidence audit");
  });

  it("a tree EDITED during the audit closes nothing (Codex 2026-09-12 Y#3)", async () => {
    // HEAD equality says nothing about uncommitted work, so an
    // implementation change landing inside the audit's own await was stamped
    // as a closure of the tree the audit had read.
    const asked: string[][] = [];
    let editDuringAudit: (() => void) | undefined;
    const { id } = await onACleanCheckout(
      [{ id: "mcov1", title: "c", coverageGap: "Boss: absent", prompt: "p", status: "running", attempts: 2, taskId: "task_1" }],
      (reqs) => {
        editDuringAudit?.();
        return { closed: [...reqs], open: [] };
      },
      asked,
    );
    const repoRoot = storage.get(id)!.projectRoot;
    editDuringAudit = () => {
      mkdirSync(join(repoRoot, "Assets"), { recursive: true });
      writeFileSync(join(repoRoot, "Assets", "Boss.cs"), "// the boss, uncommitted");
    };

    tasks.emit("task:failed", "task_1", "the boss scene will not compile");
    await waitFor(() => expect(storage.get(id)!.state).not.toBe("executing"), { timeout: 15_000 });

    const after = storage.get(id)!;
    expect(asked).toHaveLength(1);
    // The audit said delivered; the tree it judged is not the tree in front
    // of us, so nothing is closed and the requirement still blocks.
    expect(after.milestones.find((m) => m.id === "mcov1")!.coverageClosed).toBeUndefined();
    expect(after.state).not.toBe("done");
    expect(`${after.lastError}`).toContain("Boss: absent");
  });

  it("a requirement that differs only in CASE is its own requirement (Codex 2026-09-12 X#2)", async () => {
    // `gapKey` lowercases, which is right for scheduling one sprint per
    // requirement and wrong for closure: "Assets/Art/Hero.png" and
    // ".../hero.png" are two files, and a verdict about one closed the other.
    const asked: string[][] = [];
    const { id } = await onACleanCheckout(
      [
        { id: "mcov1", title: "c", coverageGap: "Boss: absent", prompt: "p", status: "running", attempts: 2, taskId: "task_1" },
        { id: "mcov2", title: "c", coverageGap: "boss: ABSENT", prompt: "p", status: "failed", attempts: 2 },
        // A row whose requirement survives only as a TRUNCATED TITLE: it may
        // be reported, never closed, however the audit answers.
        { id: "mcov3", title: "Coverage completion 1.1 — Boss", prompt: "no bullet here", status: "failed", attempts: 2 },
      ],
      (reqs) => ({
        closed: reqs.filter((r) => r !== "boss: ABSENT"),
        open: reqs.filter((r) => r === "boss: ABSENT"),
      }),
      asked,
    );

    tasks.emit("task:failed", "task_1", "the boss scene will not compile");
    await waitFor(() => expect(storage.get(id)!.state).not.toBe("executing"), { timeout: 15_000 });

    const after = storage.get(id)!;
    expect(asked[0]!.slice().sort()).toEqual(["Boss", "Boss: absent", "boss: ABSENT"]);
    // Only the row whose own text the audit closed is closed.
    expect(after.milestones.find((m) => m.id === "mcov1")!.coverageClosed).toBe(true);
    expect(after.milestones.find((m) => m.id === "mcov2")!.coverageClosed).toBeUndefined();
    // The audit said the title row's requirement was delivered; a title
    // cannot carry that, so it stays open.
    expect(after.milestones.find((m) => m.id === "mcov3")!.coverageClosed).toBeUndefined();
    expect(`${after.lastError}`).toContain("Boss");
    // …and the one still open keeps the campaign from delivering.
    expect(after.state).not.toBe("done");
    expect(`${after.lastError}`).toContain("boss: ABSENT");
  });

  it("an obsolete writer submits no work either (Codex 2026-09-12 Y#2)", async () => {
    // `persist` refuses a save from an earlier generation (X#1), but
    // submission happens BEFORE that refusal: a caller holding a pre-revival
    // copy still minted a task, and the stored ladder never owned it — an
    // orphan with a live lineage.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1), { timeout: 15_000 });
    const stale = structuredClone(storage.get(campaign.id)!);

    // A person revives: a new generation on the stored row.
    const revived = storage.get(campaign.id)!;
    revived.stopGeneration = (revived.stopGeneration ?? 0) + 1;
    storage.save(revived);

    const before = tasks.submitted.length;
    (manager as unknown as { submitCurrentMilestone(c: unknown): void }).submitCurrentMilestone(stale);
    expect(tasks.submitted.length).toBe(before);

    // …and the current generation still submits.
    (manager as unknown as { submitCurrentMilestone(c: unknown): void }).submitCurrentMilestone(storage.get(campaign.id)!);
    expect(tasks.submitted.length).toBe(before + 1);
  });

  it("a save from an EARLIER generation is refused (Codex 2026-09-12 X#1)", async () => {
    // A person revived the campaign while a settlement was awaiting; when it
    // returned, its copy — old state, old ladder, the stop that revival had
    // cleared — was written back over the revived row. Codex reproduced it
    // through the independent reviewer's await.
    let id: string | undefined;
    const campaign = await runToSpentRemediation(
      (reqs) => {
        // The revival happens while the audit is in flight: a new generation,
        // a cleared stop and a state of its own.
        if (id !== undefined) {
          const live = storage.get(id)!;
          live.stopGeneration = (live.stopGeneration ?? 0) + 1;
          live.stopRequestedAt = undefined;
          live.state = "planning";
          live.lastError = "revived by a person";
          storage.save(live);
        }
        return { closed: [...reqs], open: [] };
      },
      (cid) => { id = cid; },
    );

    // The settlement's own writes are dropped: the revived row stands…
    const submittedAtRevival = tasks.submitted.length;
    await new Promise((r) => setTimeout(r, 500));
    const after = storage.get(campaign.id)!;
    expect(after.stopGeneration).toBe(1);
    expect(after.state).toBe("planning");
    expect(after.lastError).toBe("revived by a person");
    expect(after.deliveryReported).not.toBe(true);
    // …AND IT ANNOUNCES NOTHING. The handler went on past the refused save:
    // it cancelled the live work of the generation that had replaced it and
    // reported "game build complete" for a row already running its next
    // generation (Codex 2026-09-12 AD#9).
    expect(messages.some((m) => m.text.includes("game build complete"))).toBe(false);
    // …and it submits no work either: `persist` refuses the save, but the
    // task was minted BEFORE that refusal and the stored ladder never owned
    // it — an orphan with a live lineage (Codex 2026-09-12 Y#2).
    expect(tasks.submitted.length).toBe(submittedAtRevival);
  });

  it("a stop recorded DURING the coverage audit is not lost, on either terminal path (Codex 2026-09-12 W#1)", async () => {
    // `openRequirements` holds its copy of the campaign across a provider
    // call that takes seconds, and wrote that copy back over the stop the
    // cancellation handler had just recorded — the delivery gate then found
    // no stop and delivered the game.
    let id: string | undefined;
    const stopMidAudit = (reqs: readonly string[]): { closed: string[]; open: string[] } => {
      if (id !== undefined) {
        const live = storage.get(id)!;
        live.stopRequestedAt = Date.now();
        storage.save(live);
      }
      // Everything is closed, so nothing but the stop can block delivery.
      return { closed: [...reqs], open: [] };
    };

    const campaign = await runToSpentRemediation(stopMidAudit, (cid) => { id = cid; });
    await waitFor(() => expect(storage.get(campaign.id)!.state).not.toBe("executing"), { timeout: 15_000 });
    const after = storage.get(campaign.id)!;
    expect(after.stopRequestedAt).toBeDefined();
    expect(after.state).not.toBe("done");
    expect(`${after.lastError}`).toContain("stopped");

    // …and the partial-delivery path, which never had the check at all.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-stop-partial.db"));
    let partialId: string | undefined;
    manager = new CampaignManager({
      storage,
      planner: {
        planMilestones: vi.fn().mockResolvedValue(LADDER),
        auditCoverage: vi.fn().mockResolvedValue([]),
        resolveCoverageGaps: vi.fn(async (_gdd: string, reqs: readonly string[]) => {
          if (partialId !== undefined) {
            const live = storage.get(partialId)!;
            live.stopRequestedAt = Date.now();
            storage.save(live);
          }
          return { closed: [...reqs], open: [] };
        }),
      } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot, retryAdoptionGraceMs: 10, completedSettleDelayMs: 0, milestoneTimeBoxMs: 60 * 60_000,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => ({ ok: true, ran: true, errors: 0 }),
    });
    manager.attachEvents();
    const partial = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    partialId = partial.id;
    await waitFor(() => expect(tasks.submitted).toHaveLength(1), { timeout: 15_000 });
    const restored = storage.get(partial.id)!;
    restored.milestones = [
      { ...restored.milestones[0]!, status: "green", taskId: undefined },
      { id: "mcov1", title: "Coverage completion 1.1 — Boss", coverageGap: "Boss: absent", prompt: "Implement the boss.\n- Boss: absent\n", status: "running", attempts: 2, taskId: "task_1" },
      { id: "mfinal1", title: "Final delivery proofs", prompt: "Prove it.", status: "green", attempts: 1 },
    ] as never;
    restored.currentMilestone = 1;
    restored.state = "executing";
    storage.save(restored);

    tasks.emit("task:failed", "task_1", "the boss scene will not compile");
    await waitFor(() => expect(storage.get(partial.id)!.state).not.toBe("executing"), { timeout: 15_000 });
    const partialAfter = storage.get(partial.id)!;
    expect(partialAfter.stopRequestedAt).toBeDefined();
    expect(partialAfter.state).not.toBe("done");
    expect(`${partialAfter.lastError}`).toContain("stopped");
  });

  it("bounces a remediation sprint once when the placeholder-art count did not drop, then accepts a drop", async () => {
    // Measured 2026-09-07: four remediation attempts, 410/429 placeholder
    // sprites before and after each, nothing compared the two numbers.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-art-gate.db"));
    const planner = {
      planMilestones: vi.fn().mockResolvedValue(LADDER),
      auditCoverage: vi.fn().mockResolvedValue(["Art production: pig skins are not covered"]),
    } as unknown as CampaignPlanner;
    manager = new CampaignManager({
      storage,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      planner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => {
        messages.push({ chatId, text });
      },
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    let art = { sprites: 100, placeholders: 95 };
    (manager as unknown as { measurePlaceholderArt: () => { sprites: number; placeholders: number } })
      .measurePlaceholderArt = () => art;
    manager.attachEvents();

    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1), { timeout: 15_000 });
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2), { timeout: 15_000 });
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3), { timeout: 15_000 });
    settleMilestone("final report");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4)); // mcov1, baseline 95/100 recorded

    // The art is unchanged. Earlier one-shot gates (visual evidence) may
    // bounce first; the art gate speaks on the completion that reaches it.
    for (let i = 0; i < 3 && !storage.get(campaign.id)!.milestones.at(-1)!.artBounced; i++) {
      const before = tasks.submitted.length;
      settleMilestone("pig skins implemented and verified");
      await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(before), { timeout: 15_000 });
    }
    const bounced = storage.get(campaign.id)!.milestones.at(-1)!;
    expect(bounced.artBounced).toBe(true);
    expect(bounced.placeholderArtAtStart).toEqual({ sprites: 100, placeholders: 95 });
    expect(tasks.submitted.at(-1)!.prompt).toContain("ART NOT PRODUCED: when this sprint began, 95 of 100");
    expect(tasks.submitted.at(-1)!.prompt).toContain("unity_generate_sprite");
    // The in-place rule (measured 2026-09-09: 12 *_Real.png beside the placeholders, count unchanged).
    expect(tasks.submitted.at(-1)!.prompt).toContain("SAME name and the SAME path as the placeholder");
    expect(bounced.attempts).toBe(1); // a bounce is not a spent attempt

    art = { sprites: 103, placeholders: 95 }; // eight real sprites ADDED under new names; placeholders untouched
    // Other one-shot gates (visual evidence, no-work) may still take a
    // completion each; the art gate must not take another one.
    const mcov1 = () => storage.get(campaign.id)!.milestones.find((m) => m.id === "mcov1")!;
    for (let i = 0; i < 3 && mcov1().status === "running"; i++) {
      const before = tasks.submitted.length;
      settleMilestone("pig skins drawn with the local model and bound");
      await waitFor(
        () => expect(mcov1().status !== "running" || tasks.submitted.length > before).toBe(true),
        { timeout: 15_000 },
      );
    }
    expect(mcov1().status).toBe("green");
    expect(tasks.submitted.filter((t) => t.prompt.includes("ART NOT PRODUCED")).length).toBe(1);
  });

  it("a game defect that merely SOUNDS like missing tooling still revives; only the campaign's own tooling wording stops the loop (Codex 2026-09-11 D#3, D#4)", () => {
    const unmeasurable = (m: string) => (manager as unknown as { constructor: unknown }) && UNMEASURABLE_PROOF_RE.test(m);
    // The campaign's own wording for absent tooling.
    expect(unmeasurable("the compile check did not run: no compile verifier is configured")).toBe(true);
    expect(unmeasurable("no test verifier is configured")).toBe(true);
    // …but a suite nobody RAN is missing work, not missing tooling: three such
    // rounds used to escalate as an infrastructure verdict while the tools were
    // present and working (Codex 2026-09-11 F#5).
    expect(unmeasurable("no test run was observed")).toBe(false);
    expect(unmeasurable("the player build did not run: unity_build_player is not registered")).toBe(true);
    // A GAME defect, whatever words it uses.
    expect(unmeasurable("play-through: IPlaythroughDriver is not registered in the service container")).toBe(false);
    expect(unmeasurable("the project does not compile (12 error(s))")).toBe(false);
    expect(unmeasurable("inside the built player: session 1 never ended")).toBe(false);

    // A sprint that had NO TOOL for part of its work is the same class as
    // absent tooling: no retry produces the tool (Codex 2026-09-12 R#1).
    expect(unmeasurable("a sprint could not do part of its work — no tool for it in this run: unity_create_scene (the Unity bridge is not connected)")).toBe(true);

    // ANY unmeasurable proof counts: requiring ALL of them let one
    // game-shaped proof beside it reset the counter forever (D#3).
    expect(hasUnmeasurableProof(["no test verifier is configured", "the project does not compile (3 error(s))"])).toBe(true);
    expect(hasUnmeasurableProof(["no test run was observed", "the project does not compile (3 error(s))"])).toBe(false);
    expect(hasUnmeasurableProof(["the project does not compile (3 error(s))"])).toBe(false);
    expect(hasUnmeasurableProof([])).toBe(false);
  });

  it("the envelope does not commit without the project write lock (Codex 2026-09-12 S#4)", async () => {
    // The handle's `acquired` was never read, so the envelope staged and
    // committed the project beside whatever the other writer was doing.
    const repo = mkdtempSync(join(tmpdir(), "envelope-lock-"));
    try {
      execSync("git init -q && git -c user.email=a@b -c user.name=t commit -qm first --allow-empty", { cwd: repo });
      writeFileSync(join(repo, "work.cs"), "the sprint's work", "utf8");
      const held = join(repo, ".strada", "locks", "project-write.lock");
      mkdirSync(held, { recursive: true });
      writeFileSync(
        join(held, "owner"),
        JSON.stringify({ pid: process.pid, host: hostname(), token: "someone-else", at: new Date().toISOString() }),
      );

      const mgr = new CampaignManager({
        storage,
        planner: { planMilestones: vi.fn(), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
        taskManager: tasks as unknown as TaskManager,
        messenger: async () => undefined,
        projectRoot: repo,
        projectLockTimeoutMs: 50,
      });
      const note = await (mgr as unknown as {
        commitMilestoneWork(c: unknown, m: unknown): Promise<string>;
      }).commitMilestoneWork({ id: "c1" }, { id: "m1" });

      expect(note).toContain("SKIPPED");
      // Nothing was committed: the tree still holds the sprint's work.
      expect(execSync("git status --porcelain", { cwd: repo, encoding: "utf8" })).toContain("work.cs");
      expect(execSync("git log --oneline", { cwd: repo, encoding: "utf8" }).trim().split("\n")).toHaveLength(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("proofs that span two revisions are not a verdict (Codex 2026-09-12 R#16)", () => {
    // The gate reads compile, suite, play-through, build and shipped tree one
    // at a time; a publication landing between two reads produced a verdict
    // set no revision of the game ever had — and it delivered.
    expect(proofsSpanTwoRevisions("a".repeat(40), "b".repeat(40))).toBe(true);
    expect(proofsSpanTwoRevisions("a".repeat(40), "a".repeat(40))).toBe(false);
    // A project that is not a git tree is measured exactly as before.
    expect(proofsSpanTwoRevisions("", "b".repeat(40))).toBe(false);
    expect(proofsSpanTwoRevisions("a".repeat(40), "")).toBe(false);
    expect(proofsSpanTwoRevisions("", "")).toBe(false);
  });

  it("only a HOST incapability exempts the player run; a broken bundle still blocks (Codex 2026-09-11 D#2)", () => {
    expect(UNRUNNABLE_HERE_RE.test("exec format error")).toBe(true);
    expect(UNRUNNABLE_HERE_RE.test("unsupported artifact on this host")).toBe(true);
    expect(UNRUNNABLE_HERE_RE.test("requires a device")).toBe(true);
    // A corrupt build is not a host limitation.
    expect(UNRUNNABLE_HERE_RE.test("Cannot run player: Game_Data is missing")).toBe(false);
    expect(UNRUNNABLE_HERE_RE.test("the player crashed on launch")).toBe(false);
    // …and NEITHER IS OUR OWN MISSING TOOL. Treating an unconfigured runner as
    // host incapability waived playing the game and reached `done` with an
    // artifact nobody had run (Codex 2026-09-11 F#12). It is still an
    // unmeasurable proof, so the campaign revives and then asks a person.
    expect(UNRUNNABLE_HERE_RE.test("no player runner is configured")).toBe(false);
    expect(UNMEASURABLE_PROOF_RE.test("no player runner is configured")).toBe(true);

    // A HOST that cannot run the artifact does not EXEMPT the proof either —
    // it only moves it out of this machine's reach: the campaign revives
    // twice and then asks for a machine that can run it (Codex 2026-09-12
    // R#13). Delivered-and-never-played was the alternative.
    expect(UNMEASURABLE_PROOF_RE.test(
      "the built player was never run on a machine that can run it: exec format error",
    )).toBe(true);
  });

  it("the player run is allowed what the document asks for (Codex 2026-09-12 T#8)", async () => {
    // Every run used the tool's 45-second session deadline, so a game whose
    // own document asks for a 90-second round could not be played to its
    // outcome — the proof was impossible, not missing.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-run-spec.db"));
    const specs: Array<unknown> = [];
    manager = new CampaignManager({
      storage,
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot, retryAdoptionGraceMs: 10, completedSettleDelayMs: 0, milestoneTimeBoxMs: 60 * 60_000,
      deliveryResumeDelayMs: 20,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => ({ ok: true, ran: true, errors: 0 }),
      buildPlayer: async () => buildVerdict,
      runPlayer: async (root, artifact, spec) => {
        specs.push(spec);
        writePlayerVerdict(true, {}, root);
      },
    });
    manager.attachEvents();
    const gdd = "# GDD\n\nThe game ships 3 levels. A round lasts 60-90 seconds. It loads in under 4 seconds. Up to 40 taps per session.";
    const campaign = manager.startFromGdd(ctx, gdd, "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    settleMilestone("integrated, all 42 tests pass");

    await waitFor(() => expect(specs.length).toBeGreaterThan(0));

    // 90 s with headroom for a driven run, the boot budget doubled (never
    // below the tool's own 30 s), and every level the document claims.
    // …and the catalogue is unknown, so the first run DISCOVERS it with one
    // session (plan 0-B.4, round 5 #1) instead of asking "all".
    expect(specs[0]).toMatchObject({ deadlineSeconds: 150, bootDeadlineSeconds: 30, sessions: "1" });
    // …and this document states no win or lose condition, so the run is not
    // told to demand one: an endless session is a game behaving as designed
    // (Codex 2026-09-13 AG#3).
    expect(specs[0]?.outcomeRequired).toBeUndefined();

    // A document that states one DOES ask for it.
    const withWin = (manager as unknown as {
      playerRunSpec(c: { gddText: string }): { outcomeRequired?: boolean };
    }).playerRunSpec({ gddText: "# GDD\n\nWin condition: clear every blocker. A round lasts 60-90 seconds." } as never);
    expect(withWin.outcomeRequired).toBe(true);
    // …and the ACTION budget the document states, with headroom: the runner
    // stopped every session at its own sixty actions, so a session with a
    // longer allowance still ended without an outcome (Codex 2026-09-12 U#3).
    expect(specs[0]).toMatchObject({ maxActions: 75 });

    // A GAME BIGGER THAN ONE RUN asks for the batch a run can verify. "all"
    // is resolved by the producer against its own catalogue, which no single
    // run can answer past twelve sessions — so the ticket could never be
    // settled and a run that played everything it could was refused (Codex
    // 2026-09-13 AI#5). Nothing is assumed from the DOCUMENT's number: only a
    // catalogue a run actually reported changes the request.
    const askedFor = (sessionCount?: number): string | undefined =>
      (manager as unknown as {
        playerRunSpec(c: unknown): { sessions?: string };
      }).playerRunSpec({
        gddText: gdd,
        milestones: sessionCount === undefined
          ? []
          : [{ id: "m", title: "t", prompt: "p", status: "green", attempts: 1, playerPlaythrough: { found: true, ok: true, sessionCount } }],
      } as never).sessions;
    // …and the coordinator never asks "all" (round 5 #1): unknown is
    // discovered with one session, a known catalogue is asked for by name.
    expect(askedFor(undefined)).toBe("1");
    expect(askedFor(3)).toBe("1-3");
    expect(askedFor(12)).toBe("1-12");
    expect(askedFor(13)).toBe("1-12");
    expect(askedFor(3000)).toBe("1-12");

    // A RUN THAT FOUND NOTHING reports no catalogue at all, and a catalogue of
    // zero is a game that registers none — neither is a measurement of size,
    // so an EARLIER run that did answer is the one that counts.
    const milestonesOf = (runs: Array<{ found: boolean; sessionCount?: number }>) =>
      runs.map((r, i) => ({ id: `m${i}`, title: "t", prompt: "p", status: "green", attempts: 1, playerPlaythrough: r }));
    const asked = (runs: Array<{ found: boolean; sessionCount?: number }>): string | undefined =>
      (manager as unknown as { playerRunSpec(c: unknown): { sessions?: string } })
        .playerRunSpec({ gddText: gdd, milestones: milestonesOf(runs) } as never).sessions;
    // A DOCUMENT WHOSE ROUNDS ARE LONG fits fewer sessions in one run, and
    // the producer REFUSES a request that needs more wall-clock than a run
    // may take — so asking for twelve five-minute rounds came back "nothing
    // was played" (Codex 2026-09-13 AJ#1).
    const longRounds = (manager as unknown as { playerRunSpec(c: unknown): { sessions?: string; deadlineSeconds?: number } })
      .playerRunSpec({ gddText: "# G\nThe game ships 3000 levels. Each round lasts 300 seconds.", milestones: [] } as never);
    expect(longRounds.deadlineSeconds).toBe(465);
    // An UNKNOWN catalogue with rounds too long for the whole cap is discovered
    // with one session: a range guessed from time asked for levels that do
    // not exist (plan 0-B.4, AK#4).
    expect(longRounds.sessions).toBe("1");
    // …AND NEVER MORE LEVELS THAN THE GAME HAS. Time and the producer's cap
    // bounded the batch, the catalogue did not, so a three-level game with
    // long rounds was asked for sessions 1-5 and its driver refused levels 4
    // and 5 — a broken play-through for a correct game (Codex 2026-09-13
    // AK#4).
    const threeLongRounds = (manager as unknown as { playerRunSpec(c: unknown): { sessions?: string } })
      .playerRunSpec({
        gddText: "# G\nThe game ships 3 levels. Each round lasts 300 seconds.",
        milestones: [{ id: "m", title: "t", prompt: "p", status: "green", attempts: 1, playerPlaythrough: { found: true, ok: true, sessionCount: 3 } }],
      } as never).sessions;
    expect(threeLongRounds).toBe("1-3");
    // THE NEXT SESSIONS NOBODY HAS PLAYED YET. Asking for the first batch
    // every time left session 13 of a 13-level game never played at all
    // (Codex 2026-09-13 AJ#11) — and coverage measured on ANOTHER build says
    // nothing about this one.
    const artifact = join(projectRoot, "Builds", "cursor", "Game.app");
    mkdirSync(join(projectRoot, "Builds", "cursor"), { recursive: true });
    writeFileSync(artifact, "the bytes that were built");
    const digest = artifactDigest(artifact)!;
    const cursorFor = (verified?: { artifact: string; indices: number[] }): string | undefined =>
      (manager as unknown as { playerRunSpec(c: unknown): { sessions?: string } }).playerRunSpec({
        gddText: gdd,
        ...(verified === undefined ? {} : { verifiedSessions: verified }),
        milestones: [{
          id: "m", title: "t", prompt: "p", status: "green", attempts: 1,
          playerPlaythrough: { found: true, ok: true, sessionCount: 13 },
          buildVerdict: { ran: true, ok: true, artifactPath: artifact },
        }],
      } as never).sessions;
    expect(cursorFor(undefined)).toBe("1-12");
    expect(cursorFor({ artifact: digest, indices: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] })).toBe("13");
    expect(cursorFor({ artifact: digest, indices: [1, 3] })).toBe("2,4,5,6,7,8,9,10,11,12,13");
    // Coverage of another artifact is not coverage of this one.
    expect(cursorFor({ artifact: "f".repeat(64), indices: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] })).toBe("1-12");
    // Everything played: the request re-measures the first batch rather than
    // claiming the game is covered.
    expect(cursorFor({ artifact: digest, indices: Array.from({ length: 13 }, (_unused, i) => i + 1) })).toBe("1-12");

    expect(asked([{ found: true, sessionCount: 13 }, { found: true, sessionCount: 0 }])).toBe("1-12");
    // THE LATEST measurement is the one that counts: the game grows, so an
    // early run that found three levels does not describe it any more.
    expect(asked([{ found: true, sessionCount: 3 }, { found: true, sessionCount: 13 }])).toBe("1-12");
    // …and the coordinator never asks "all" (round 5 #1): a known small
    // catalogue by name, an unknown one by discovery.
    expect(asked([{ found: true, sessionCount: 13 }, { found: true, sessionCount: 3 }])).toBe("1-3");
    expect(asked([{ found: false, sessionCount: 13 }])).toBe("1");
    expect(asked([{ found: true }])).toBe("1");
  });

  it("a verdict file that cannot be cleared stops the run rather than measuring the old one (Codex 2026-09-12 Y#5)", async () => {
    // Every player run writes one verdict path; the previous one is removed
    // first so a verdict can only be this run's. When that removal FAILS, the
    // old verdict is what the reader would find — so the run does not happen
    // and the gate says the player was not run.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-unclearable.db"));
    const played: string[] = [];
    manager = new CampaignManager({
      storage,
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot, retryAdoptionGraceMs: 10, completedSettleDelayMs: 0, milestoneTimeBoxMs: 60 * 60_000,
      deliveryResumeDelayMs: 20,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => ({ ok: true, ran: true, errors: 0 }),
      buildPlayer: async () => buildVerdict,
      runPlayer: async (root, artifact) => { played.push(artifact); writePlayerVerdict(true, {}, root); },
    });
    manager.attachEvents();
    // The verdict PATH is a directory: rmSync cannot remove it.
    mkdirSync(join(projectRoot, "Recordings", "player-playthrough", "playthrough-verdict.json"), { recursive: true });

    const campaign = manager.startFromGdd(ctx, "# GDD\n\nRelease on macOS. The game ships 3 levels.", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1), { timeout: 15_000 });
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2), { timeout: 15_000 });
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3), { timeout: 15_000 });
    settleMilestone("integrated, all 42 tests pass");

    for (let i = 0; i < 12 && storage.get(campaign.id)!.state === "executing"; i++) {
      const before = tasks.submitted.length;
      settleMilestone("integrated, all 42 tests pass");
      await waitFor(
        () => expect(tasks.submitted.length > before || storage.get(campaign.id)!.state !== "executing").toBe(true),
        { timeout: 15_000 },
      );
    }
    expect(played).toHaveLength(0);
    const stoppedHere = storage.get(campaign.id)!;
    expect(stoppedHere.state).not.toBe("done");
    expect(`${stoppedHere.lastError}`).toContain("the player was not run");
    rmSync(join(projectRoot, "Recordings", "player-playthrough", "playthrough-verdict.json"), { recursive: true, force: true });
  });

  it("the GDD's numbers are held against EVERY target that ran (Codex 2026-09-12 Y#J4.3)", async () => {
    // "Windows and Linux; at least 60 fps" with Windows at 60 and Linux at 10
    // passed: only the primary's evidence reached the claim check, and a
    // secondary's play-through `ok` says nothing about a frame-rate budget.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-per-target-fps.db"));
    manager = new CampaignManager({
      storage,
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot, retryAdoptionGraceMs: 10, completedSettleDelayMs: 0, milestoneTimeBoxMs: 60 * 60_000,
      deliveryResumeDelayMs: 20,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => ({ ok: true, ran: true, errors: 0 }),
      buildPlayer: async (_root: string, target?: string) => ({
        ran: true, ok: true,
        target: target === "linux" ? "StandaloneLinux64" : "StandaloneWindows64",
        artifactPath: target === "linux" ? "/tmp/Builds/Linux/Game.x86_64" : "/tmp/Builds/Windows/Game.exe",
        sizeBytes: 70_000_000, durationMs: 90_000, scenes: 2,
      }),
      // Both players play to a clean outcome; the Linux one runs at 10 fps.
      runPlayer: async (root, artifact) => {
        const fps = artifact.includes("Linux") ? 10 : 60;
        writePlayerVerdict(true, {
          perf: { medium: "player", bootSeconds: 1.1, playSeconds: 10, playFrames: 600, avgFps: fps, worstFrameMs: 40 },
        }, root);
      },
    });
    manager.attachEvents();
    const gdd = "# GDD\n\nRelease on Windows and Linux. Target 60 fps. The game ships 3 levels.";
    const campaign = manager.startFromGdd(ctx, gdd, "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1), { timeout: 15_000 });
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2), { timeout: 15_000 });
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3), { timeout: 15_000 });
    settleMilestone("integrated, all 42 tests pass");

    // Driven to a terminal state: `deliveryProofsMissing` is cleared between
    // rounds, so the durable evidence is the campaign's own stop.
    for (let i = 0; i < 12 && storage.get(campaign.id)!.state === "executing"; i++) {
      const before = tasks.submitted.length;
      settleMilestone("integrated, all 42 tests pass");
      await waitFor(
        () => expect(tasks.submitted.length > before || storage.get(campaign.id)!.state !== "executing").toBe(true),
        { timeout: 15_000 },
      );
    }
    const stopped = storage.get(campaign.id)!;
    expect(stopped.state).not.toBe("done");
    expect(`${stopped.lastError}`).toContain("in the built player for");
    expect(`${stopped.lastError}`).toContain("frame rate");
    // The secondary's own evidence is kept, not a sentence about it.
    const runs = storage.get(campaign.id)!.milestones[2]!.playerRunsByTarget ?? [];
    expect(runs[1]!.evidence?.perf?.avgFps).toBe(10);
  });

  it("two targets cannot own ONE artifact (Codex 2026-09-12 Y#5)", async () => {
    // A build that writes both targets to the same path has produced one
    // product; the second target's "proof" would be the first one's file read
    // twice. It is not a build of its own, and the gate says so.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-shared-artifact.db"));
    const played: string[] = [];
    manager = new CampaignManager({
      storage,
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot, retryAdoptionGraceMs: 10, completedSettleDelayMs: 0, milestoneTimeBoxMs: 60 * 60_000,
      deliveryResumeDelayMs: 20,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => ({ ok: true, ran: true, errors: 0 }),
      // Both targets report the SAME artifact path.
      buildPlayer: async (_root: string, target?: string) => ({
        ran: true, ok: true,
        target: target === "linux" ? "StandaloneLinux64" : "StandaloneWindows64",
        artifactPath: "/tmp/Builds/shared/Game",
        sizeBytes: 70_000_000, durationMs: 90_000, scenes: 2,
      }),
      runPlayer: async (root, artifact) => { played.push(artifact); writePlayerVerdict(true, {}, root); },
    });
    manager.attachEvents();
    const campaign = manager.startFromGdd(ctx, "# GDD\n\nRelease on Windows and Linux. The game ships 3 levels.", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1), { timeout: 15_000 });
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2), { timeout: 15_000 });
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3), { timeout: 15_000 });
    settleMilestone("integrated, all 42 tests pass");

    await waitFor(() => expect(played.length).toBeGreaterThan(0), { timeout: 15_000 });
    // One product, one run — and the second target counts as unbuilt.
    expect(played).toHaveLength(1);
    await waitFor(
      () => expect(storage.get(campaign.id)!.milestones[2]!.buildVerdict?.unbuiltTargets ?? []).toContain("linux"),
      { timeout: 15_000 },
    );
    expect(storage.get(campaign.id)!.state).not.toBe("done");
  });

  it("a per-target result from a previous round does not survive a round without it (Codex 2026-09-12 Y#5)", async () => {
    // The list was only assigned when a secondary target existed, so a
    // previous round's failed secondary stayed on the milestone into a round
    // that had none — and the delivery gate reads it as a missing proof.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-stale-targets.db"));
    manager = new CampaignManager({
      storage,
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot, retryAdoptionGraceMs: 10, completedSettleDelayMs: 0, milestoneTimeBoxMs: 60 * 60_000,
      deliveryResumeDelayMs: 20,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => ({ ok: true, ran: true, errors: 0 }),
      buildPlayer: async () => buildVerdict,
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); writePlayerVerdict(true, {}, root); },
    });
    manager.attachEvents();
    const campaign = manager.startFromGdd(ctx, "# GDD\n\nRelease on macOS. The game ships 3 levels.", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1), { timeout: 15_000 });
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2), { timeout: 15_000 });
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3), { timeout: 15_000 });

    const seeded = storage.get(campaign.id)!;
    seeded.milestones[2]!.playerRunsByTarget = [{ target: "a target that is gone", ok: false, detail: "stale" }];
    storage.save(seeded);

    settleMilestone("integrated, all 42 tests pass");
    await waitFor(() => expect(playerRuns.length).toBeGreaterThan(0), { timeout: 15_000 });
    await waitFor(
      () => expect(storage.get(campaign.id)!.milestones[2]!.playerRunsByTarget).toBeUndefined(),
      { timeout: 15_000 },
    );
  });

  it("a duration table is an allowance too (Codex 2026-09-12 W#9, AB Job 3.6)", async () => {
    // The spec excluded minimum-duration claims, so "each round must last at
    // least 90 seconds" produced no allowance at all and the producer's
    // 45-second default cut every round short: a correct game could not pass.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-run-floor.db"));
    const specs: Array<unknown> = [];
    manager = new CampaignManager({
      storage,
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot, retryAdoptionGraceMs: 10, completedSettleDelayMs: 0, milestoneTimeBoxMs: 60 * 60_000,
      deliveryResumeDelayMs: 20,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => ({ ok: true, ran: true, errors: 0 }),
      buildPlayer: async () => buildVerdict,
      runPlayer: async (root, artifact, spec) => { specs.push(spec); writePlayerVerdict(true, {}, root); },
    });
    manager.attachEvents();
    // The durations in a LABEL/VALUE TABLE, the shape the vehicle's document
    // uses — no prose pattern sees it, so the run kept the producer's
    // 45-second default (Codex 2026-09-12 AB, Job 3.6).
    const gdd = [
      "# GDD",
      "",
      "The game ships 3 levels.",
      "",
      "2.4 Session Design",
      "Parameter",
      "Target",
      "Rationale",
      "Median level duration",
      "60–150 s (Normal), 150–300 s (Hard)",
      "Fits coffee-break sessions",
    ].join("\n");
    const campaign = manager.startFromGdd(ctx, gdd, "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1), { timeout: 15_000 });
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2), { timeout: 15_000 });
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3), { timeout: 15_000 });
    settleMilestone("integrated, all 42 tests pass");

    await waitFor(() => expect(specs.length).toBeGreaterThan(0), { timeout: 15_000 });
    // 300 s with the same headroom every allowance gets.
    expect(specs[0]).toMatchObject({ deadlineSeconds: 465 });
    expect(storage.get(campaign.id)!.id).toBe(campaign.id);
  });

  it("a run that wrote a GREEN verdict and then failed is a missing proof, not a pass (audit 09.1)", async () => {
    // The wrapper threw after the producer wrote its file (adapter timeout,
    // transport error, a failure after writing). The fresh green file was
    // read anyway, credited to the coverage and returned as proof.
    const campaign = {
      id: "c_green_then_throw", chatId: "chat", channelType: "cli", userId: "u", projectRoot,
      state: "executing", draftAttempts: 0, milestones: [], currentMilestone: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
    } as unknown as Campaign;
    let throwAfterWrite = false;
    const player = new CampaignManager({
      storage,
      runPlayer: async (root) => {
        writePlayerVerdict(true, {
          record: {
            medium: "player", scene: "Entry", session: 1, autoStarted: false, actions: 12, outcome: "Won", reachedOutcome: true,
            sessionCount: 1,
            sessions: [{ index: 1, observedIndex: 1, identityVerified: true, identitySource: "start-acceptance", actions: 12, outcome: "Won", reachedOutcome: true }],
          },
        }, root);
        if (throwAfterWrite) throw new Error("the player adapter timed out after 30000ms");
      },
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async () => {},
      projectRoot,
    });
    const artifact = join(projectRoot, "Builds", "Game.x86_64");
    mkdirSync(join(projectRoot, "Builds"), { recursive: true });
    writeFileSync(artifact, "binary");
    const build = { ran: true, ok: true, target: "StandaloneLinux64", artifactPath: artifact, sizeBytes: 6, durationMs: 1, scenes: 1 };
    const measure = (id: string): Promise<{ found: boolean; ok?: boolean; missingRunner?: string }> =>
      (player as unknown as { measurePlayerRun(m: unknown, b: unknown, c: unknown): Promise<{ found: boolean; ok?: boolean; missingRunner?: string }> })
        .measurePlayerRun({ id, title: "Delivery", prompt: "p", status: "running", attempts: 1 }, build, campaign);

    // Guard: the same green file from a run that finished is a pass, and
    // the coverage learned from it.
    const honest = await measure("m_honest");
    expect(honest.found).toBe(true);
    expect(honest.ok).toBe(true);
    expect(campaign.verifiedSessions).toBeDefined();

    throwAfterWrite = true;
    campaign.verifiedSessions = undefined;
    const before = JSON.stringify(campaign.verifiedSessions ?? null);
    const failed = await measure("m_green_then_throw");
    expect(failed.found).toBe(false);
    expect(failed.missingRunner).toContain("reported failure after writing a passing verdict");
    expect(failed.missingRunner).toContain("timed out");
    // …and the coverage did not learn from it.
    expect(JSON.stringify(campaign.verifiedSessions ?? null)).toBe(before);
  }, 20_000);

  it("a RED verdict after a reported failure does not feed the coverage, and a foreign-host failure keeps its classification (Codex 2026-09-17)", async () => {
    const campaign = {
      id: "c_red_then_throw", chatId: "chat", channelType: "cli", userId: "u", projectRoot,
      state: "executing", draftAttempts: 0, milestones: [], currentMilestone: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
    } as unknown as Campaign;
    let verdictOk = false;
    let failWith: string | undefined = "the player adapter timed out after 30000ms";
    const player = new CampaignManager({
      storage,
      runPlayer: async (root) => {
        writePlayerVerdict(verdictOk, {
          record: {
            medium: "player", scene: "Entry", session: 1, autoStarted: false, actions: 12, outcome: "Won", reachedOutcome: true,
            sessionCount: 1,
            sessions: [{ index: 1, observedIndex: 1, identityVerified: true, identitySource: "start-acceptance", actions: 12, outcome: "Won", reachedOutcome: true }],
          },
        }, root);
        if (failWith !== undefined) throw new Error(failWith);
      },
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async () => {},
      projectRoot,
    });
    const artifact = join(projectRoot, "Builds", "Game2.x86_64");
    mkdirSync(join(projectRoot, "Builds"), { recursive: true });
    writeFileSync(artifact, "binary2");
    const measure = (id: string, artifactPath: string, target: string): Promise<{ found: boolean; ok?: boolean; missingRunner?: string; unrunnableHere?: string }> =>
      (player as unknown as { measurePlayerRun(m: unknown, b: unknown, c: unknown): Promise<{ found: boolean; ok?: boolean; missingRunner?: string; unrunnableHere?: string }> })
        .measurePlayerRun({ id, title: "Delivery", prompt: "p", status: "running", attempts: 1 }, { ran: true, ok: true, target, artifactPath, sizeBytes: 7, durationMs: 1, scenes: 1 }, campaign);

    // Red verdict with a completed session, then the wrapper fails: the red
    // stays red, and the session is NOT remembered.
    const red = await measure("m_red_then_throw", artifact, "StandaloneLinux64");
    expect(red.found).toBe(true);
    expect(red.ok).toBe(false);
    expect(campaign.verifiedSessions).toBeUndefined();

    // A green file + "not a player this machine can run" on a foreign artifact
    // is this host's limit, not missing work.
    verdictOk = true;
    failWith = "Game.apk is not a player this machine can run — nothing was played";
    const apk = join(projectRoot, "Builds", "Game.apk");
    writeFileSync(apk, "apk-bytes");
    const foreign = await measure("m_apk_green", apk, "Android");
    expect(foreign.found).toBe(false);
    expect(foreign.unrunnableHere).toContain("not a player this machine can run");
    expect(foreign.missingRunner).toBeUndefined();
    expect(campaign.verifiedSessions).toBeUndefined();
  }, 20_000);

  it("…and a SECONDARY target that wrote green and then failed is not ok either (Codex plan review #8)", async () => {
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-secondary-green-throw.db"));
    manager = new CampaignManager({
      storage,
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot, retryAdoptionGraceMs: 10, completedSettleDelayMs: 0, milestoneTimeBoxMs: 60 * 60_000,
      deliveryResumeDelayMs: 20,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => ({ ok: true, ran: true, errors: 0 }),
      buildPlayer: async (_root: string, target?: string) => ({
        ran: true,
        ok: true,
        target: target === "linux" ? "StandaloneLinux64" : "StandaloneWindows64",
        artifactPath: target === "linux" ? "/tmp/Builds/Linux/Game.x86_64" : "/tmp/Builds/Windows/Game.exe",
        sizeBytes: 70_000_000, durationMs: 90_000, scenes: 2,
      }),
      runPlayer: async (root, artifact) => {
        // Both write a green verdict; the Linux wrapper then fails.
        writePlayerVerdict(true, {}, root);
        if (artifact.includes("Linux")) throw new Error("transport closed before the run acknowledged");
      },
    });
    manager.attachEvents();
    const campaign = manager.startFromGdd(ctx, "# GDD\n\nRelease on Windows and Linux. The game ships 3 levels.", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1), { timeout: 15_000 });
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2), { timeout: 15_000 });
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3), { timeout: 15_000 });
    settleMilestone("integrated, all 42 tests pass");
    await waitFor(
      () => expect((storage.get(campaign.id)!.milestones[2]!.playerRunsByTarget ?? []).length).toBe(2),
      { timeout: 15_000 },
    );
    const runs = storage.get(campaign.id)!.milestones[2]!.playerRunsByTarget ?? [];
    expect(runs[0]!.ok).toBe(true);
    expect(runs[1]!.ok).toBe(false);
    expect(runs[1]!.detail).toContain("reported failure after writing a passing verdict");
  }, 30_000);

  it("every target the build produced is played, not just the first (Codex 2026-09-12 W#11)", async () => {
    // `measureBuild` built both required platforms and returned ONE artifact,
    // so the second was never played: a player that crashes at launch there
    // was invisible to the gate and the campaign delivered.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-two-targets.db"));
    const played: string[] = [];
    manager = new CampaignManager({
      storage,
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot, retryAdoptionGraceMs: 10, completedSettleDelayMs: 0, milestoneTimeBoxMs: 60 * 60_000,
      deliveryResumeDelayMs: 20,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => ({ ok: true, ran: true, errors: 0 }),
      buildPlayer: async (_root: string, target?: string) => ({
        ran: true,
        ok: true,
        target: target === "linux" ? "StandaloneLinux64" : "StandaloneWindows64",
        artifactPath: target === "linux" ? "/tmp/Builds/Linux/Game.x86_64" : "/tmp/Builds/Windows/Game.exe",
        sizeBytes: 70_000_000, durationMs: 90_000, scenes: 2,
      }),
      runPlayer: async (root, artifact) => {
        played.push(artifact);
        // The Windows player plays; the Linux one dies at launch.
        if (artifact.includes("Linux")) throw new Error("the player exited immediately with code 139");
        writePlayerVerdict(true, {}, root);
      },
    });
    manager.attachEvents();
    const gdd = "# GDD\n\nRelease on Windows and Linux. The game ships 3 levels.";
    const campaign = manager.startFromGdd(ctx, gdd, "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1), { timeout: 15_000 });
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2), { timeout: 15_000 });
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3), { timeout: 15_000 });
    settleMilestone("integrated, all 42 tests pass");

    await waitFor(() => expect(played.length).toBeGreaterThan(1), { timeout: 15_000 });
    // BOTH artifacts were played…
    expect(played.some((p) => p.includes("Windows"))).toBe(true);
    expect(played.some((p) => p.includes("Linux"))).toBe(true);
    // …and the one that died is a missing proof, not a footnote: the sprint is
    // bounced with it named, and the campaign is not delivered.
    // The second target's failure is recorded per target…
    await waitFor(
      () => expect((storage.get(campaign.id)!.milestones[2]!.playerRunsByTarget ?? []).length).toBe(2),
      { timeout: 15_000 },
    );
    // …and it keeps the campaign from delivering: every sprint from here on
    // reports success, and the ladder still must not reach `done`.
    for (let i = 0; i < 12 && storage.get(campaign.id)!.state === "executing"; i++) {
      const before = tasks.submitted.length;
      settleMilestone("everything is green now");
      await waitFor(
        () => expect(tasks.submitted.length > before || storage.get(campaign.id)!.state !== "executing").toBe(true),
        { timeout: 15_000 },
      );
    }
    expect(storage.get(campaign.id)!.state).not.toBe("done");
    expect(`${storage.get(campaign.id)!.lastError}`).toContain("built player for");
    const runs = storage.get(campaign.id)!.milestones[2]!.playerRunsByTarget ?? [];
    expect(runs).toHaveLength(2);
    expect(runs[0]!.ok).toBe(true);
    expect(runs[1]!.ok).toBe(false);
    expect(runs[1]!.detail).toContain("code 139");
    // ONE RUN PER ARTIFACT IN A MEASUREMENT, however many times the build
    // names it (Y#5). Later rounds measure again, so this counts the first
    // measurement only — the primary, then each distinct secondary.
    expect(played.slice(0, 2).filter((p) => p.includes("Linux"))).toHaveLength(1);
    expect(played.slice(0, 2).filter((p) => p.includes("Windows"))).toHaveLength(1);

  });

  it("a target this machine cannot RUN is pending, not waived (Codex 2026-09-12 R#13)", async () => {
    // The disclosure said "NOT MEASURED: the built artifact cannot be run on
    // this machine" and the campaign delivered anyway — a game nobody had
    // played, shipped as finished.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-foreign-host.db"));
    manager = new CampaignManager({
      storage,
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot, retryAdoptionGraceMs: 10, completedSettleDelayMs: 0, milestoneTimeBoxMs: 60 * 60_000,
      deliveryResumeDelayMs: 20,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => ({ ok: true, ran: true, errors: 0 }),
      // An .apk on this machine: built, and not executable HERE.
      buildPlayer: async () => ({
        ran: true, ok: true, target: "Android", artifactPath: "/tmp/Builds/Android/Game.apk",
        sizeBytes: 60_000_000, durationMs: 90_000, scenes: 2,
      }),
      // The PRODUCER's own refusal, word for word: it is not an OS execution
      // error, so the primary path used to miss it entirely and report a
      // missing proof with no cause (Codex 2026-09-12 AA).
      runPlayer: async () => {
        throw new Error(
          "Error: /tmp/Builds/Android/Game.apk is not a player this machine can run " +
          "(an .apk, WebGL folder or missing executable) — nothing was played.",
        );
      },
    });
    manager.attachEvents();
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    const green = { testsGreen: true, detail: "PlayMode verification passed: 42 of 42 tests passed (unfiltered — the whole PlayMode suite)", unfiltered: true };
    for (let round = 0; round < 12; round++) {
      const c = storage.get(campaign.id)!;
      if (c.state !== "executing") break;
      const id = c.milestones[2]!.taskId!;
      tasks.verifications.set(id, green);
      tasks.emit("task:completed", id, "green, shipping");
      await new Promise((r) => setTimeout(r, 150));
    }

    const after = storage.get(campaign.id)!;
    expect(after.state).not.toBe("done");
    expect(messages.map((m) => m.text).join("\n")).toContain("never run on a machine that can run it");
  });

  it("an audit that could not RUN is not an audit that passed (Codex 2026-09-12 R#11)", async () => {
    // The campaign delivered with "coverage audit could not run: …" as a note:
    // the game was never compared to its own design document, and the report
    // read exactly like an audited one.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-audit-down.db"));
    manager = new CampaignManager({
      storage,
      planner: {
        planMilestones: vi.fn().mockResolvedValue(LADDER),
        auditCoverage: vi.fn().mockRejectedValue(new Error("All providers are in cooldown")),
      } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot, retryAdoptionGraceMs: 10, completedSettleDelayMs: 0, milestoneTimeBoxMs: 60 * 60_000,
      deliveryResumeDelayMs: 20,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => ({ ok: true, ran: true, errors: 0 }),
    });
    manager.attachEvents();
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    const green = { testsGreen: true, detail: "PlayMode verification passed: 42 of 42 tests passed (unfiltered — the whole PlayMode suite)", unfiltered: true };
    for (let round = 0; round < 12; round++) {
      const c = storage.get(campaign.id)!;
      if (c.state !== "executing") break;
      const id = c.milestones[2]!.taskId!;
      tasks.verifications.set(id, green);
      tasks.emit("task:completed", id, "green, shipping");
      await new Promise((r) => setTimeout(r, 150));
    }

    const after = storage.get(campaign.id)!;
    expect(after.state).not.toBe("done");
    expect(messages.map((m) => m.text).join("\n")).toContain("coverage audit did not run");
  });

  it("a proof this MACHINE cannot produce stops the campaign and asks a person, instead of reviving forever (Codex 2026-09-11 C#2)", async () => {
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-unmeasurable.db"));
    manager = new CampaignManager({
      storage,
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      // No compile verifier at all: this machine cannot answer that question.
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot, retryAdoptionGraceMs: 10, completedSettleDelayMs: 0, milestoneTimeBoxMs: 60 * 60_000,
      deliveryResumeDelayMs: 20,
    });
    manager.attachEvents();
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    const green = { testsGreen: true, detail: "PlayMode verification passed: 42 of 42 tests passed (unfiltered — the whole PlayMode suite)", unfiltered: true };
    // Keep completing the final sprint; the compile check can never run.
    for (let round = 0; round < 12; round++) {
      const c = storage.get(campaign.id)!;
      if (c.state === "failed" && c.autoReviveAt === undefined) break;
      const id = storage.get(campaign.id)!.milestones[2]!.taskId!;
      tasks.verifications.set(id, green);
      tasks.emit("task:completed", id, "green, shipping");
      await new Promise((r) => setTimeout(r, 150));
    }
    const stopped = storage.get(campaign.id)!;
    expect(stopped.state).toBe("failed");
    // No appointment: retrying cannot change a missing tool.
    expect(stopped.autoReviveAt).toBeUndefined();
    expect(messages.map((m) => m.text).join("\n")).toContain("This machine cannot produce the missing proof");
    // A stop SHORT of delivery is recoverable — by a person, or by the
    // campaign's own budget — so its cancels are supersessions and the
    // executor may still recover a revived mission (Codex 2026-09-11 F#6).
    for (const id of tasks.cancelled) expect(tasks.cancelReasons.get(id)).toBe("superseded");
  });

  it("at the final sprint the RECORD is the proof: green prose with no record does not deliver, and an unrelated stale file changes nothing (Codex 2026-09-11 D#13)", async () => {
    // No record at all, but the sprint reports a green unfiltered suite.
    runRecordOnSettle = undefined;
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    const green = { testsGreen: true, detail: "PlayMode verification passed: 215 of 215 tests passed (unfiltered — the whole PlayMode suite)", unfiltered: true };
    tasks.verifications.set("task_3", green);
    tasks.emit("task:completed", "task_3", "green, shipping");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));
    expect(storage.get(campaign.id)!.milestones[2]!.testVerdict).toBeUndefined();
    expect(storage.get(campaign.id)!.state).not.toBe("done");
    // The same evidence with a STALE file present behaves identically — the
    // file's presence is not what decides it.
    mkdirSync(join(projectRoot, "Recordings", "tests"), { recursive: true });
    const record = join(projectRoot, "Recordings", "tests", "playmode-last.json");
    writeFileSync(record, JSON.stringify({ total: 215, passed: 215, failed: 0, skipped: 0, unfiltered: true }));
    const old = new Date(Date.now() - 6 * 60 * 60_000);
    utimesSync(record, old, old);
    tasks.verifications.set("task_4", green);
    tasks.emit("task:completed", "task_4", "green, shipping");
    await new Promise((r) => setTimeout(r, 400));
    expect(storage.get(campaign.id)!.milestones[2]!.testVerdict).toBeUndefined();
    expect(storage.get(campaign.id)!.state).not.toBe("done");
  });

  it("a delivery cannot claim the document was implemented when the document is gone (Codex 2026-09-11 H#5)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1), { timeout: 15_000 });
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2), { timeout: 15_000 });
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3), { timeout: 15_000 });
    // The document disappears before the final sprint settles.
    rmSync(join(projectRoot, "docs", "Game_GDD.md"), { force: true });
    const stored = storage.get(campaign.id)!;
    stored.gddText = undefined;
    storage.save(stored);

    for (let i = 0; i < 8 && storage.get(campaign.id)!.state === "executing"; i++) {
      const before = tasks.submitted.length;
      settleMilestone(`shipping it (round ${i})`);
      await waitFor(() => {
        expect(tasks.submitted.length > before || storage.get(campaign.id)!.state !== "executing").toBe(true);
      }, { timeout: 15_000 });
    }
    const after = storage.get(campaign.id)!;
    expect(after.state).not.toBe("done");
    expect(after.milestones[2]!.deliveryProofsMissing!.join(" ")).toContain("the GDD could not be read at delivery");
  });

  it("a queued GDD requirement blocks delivery and survives the final proof sprint (Codex 2026-09-11 I#4)", async () => {
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-queued-gaps.db"));
    const gaps = Array.from({ length: 6 }, (_, i) => `Mechanic ${i + 1}: no milestone implemented it`);
    manager = new CampaignManager({
      storage,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      planner: {
        planMilestones: vi.fn().mockResolvedValue(LADDER),
        auditCoverage: vi.fn().mockResolvedValueOnce(gaps).mockResolvedValue([]),
      } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
      deliveryResumeDelayMs: 20,
      implementationReviveDelayMs: 10,
    });
    manager.attachEvents();
    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    settleMilestone("final report");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));
    expect(storage.get(campaign.id)!.pendingCoverageGaps).toHaveLength(2);

    // Every gap sprint FAILS its attempts, which is what appends the final
    // proof sprint — and the queue must not be stranded by it.
    for (let i = 0; i < 30; i++) {
      const stored = storage.get(campaign.id)!;
      if (stored.state !== "executing") break;
      const before = tasks.submitted.length;
      tasks.emit("task:failed", `task_${before}`, "gap sprint gave up");
      await waitFor(() => {
        const after = storage.get(campaign.id)!;
        expect(tasks.submitted.length > before || after.state !== "executing").toBe(true);
      });
    }
    const after = storage.get(campaign.id)!;
    // THE QUEUE IS DRAINED, final proof sprint or not: every named
    // requirement has its own sprint by the time the run settles.
    expect(after.pendingCoverageGaps ?? []).toHaveLength(0);
    const titles = after.milestones.filter((m) => m.id.startsWith("mcov")).map((m) => m.title).join(" ");
    for (let i = 1; i <= 6; i++) expect(titles).toContain(`Mechanic ${i}:`);
  });

  it("a still-queued requirement is a missing delivery proof (Codex 2026-09-11 I#4)", async () => {
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-queued-proof.db"));
    manager = new CampaignManager({
      storage,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
      deliveryResumeDelayMs: 20,
      implementationReviveDelayMs: 10,
    });
    manager.attachEvents();
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    // A requirement the audit named is waiting when the final sprint settles.
    // It carries its plan-6.2 identity, as an audit's requirement does: the
    // proof line names the REQUIREMENT, never its id (Codex round 13 #30).
    const withQueue = storage.get(campaign.id)!;
    withQueue.pendingCoverageGaps = [
      encodeRequirement({
        id: "req-001-fedcba987654",
        lineage: "req-001-fedcba987654",
        text: "Save system: no milestone implemented it",
        gddSha256: "b".repeat(64),
        gddRevision: 1,
      }),
    ];
    storage.save(withQueue);
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    settleMilestone("green, shipping");
    await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(3));

    const after = storage.get(campaign.id)!;
    expect(after.state).not.toBe("done");
    const proofs = after.milestones[2]!.deliveryProofsMissing!.join(" ");
    expect(proofs).toContain("have no sprint yet");
    expect(proofs).toContain("Save system: no milestone implemented it");
    expect(proofs).not.toContain("rid:");
  });

  it("an UNREADABLE requirement queue is disclosed, never delivered over (Codex 2026-09-12 AD#18)", async () => {
    // The persisted queue hydrated as `undefined` when its JSON was
    // truncated, which reads as "nothing is waiting": the requirements a
    // previous round found stopped existing. With the audit rounds spent,
    // nothing rediscovers them either — so the delivery gate must say the
    // obligations are unknown instead of reporting a finished game.
    const campaign = await runToSpentRemediation(
      (reqs) => ({ closed: [...reqs], open: [] }),
      (cid) => {
        // A HALF-WRITTEN ROW, as a crash leaves it: the queue's JSON is
        // truncated. `save()` cannot express this — that is the point.
        (storage as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): void } } }).db
          .prepare("UPDATE campaigns SET pending_coverage_gaps = ? WHERE id = ?")
          .run('["Save: absent"', cid);
      },
    );

    await waitFor(
      () =>
        expect(
          storage
            .get(campaign.id)!
            .milestones.flatMap((m) => m.deliveryProofsMissing ?? [])
            .join(" "),
        ).toContain("requirement queue could not be read"),
      { timeout: 15_000 },
    );
    expect(storage.get(campaign.id)!.state).not.toBe("done");
  });

  it("a two-platform GDD builds BOTH, and a build of another platform proves neither (Codex 2026-09-11 F#11, L#10, L#12)", async () => {
    writeFileSync(join(projectRoot, "docs", "Game_GDD.md"), "# GDD\n\nShips on Steam for Windows and later on iOS. Target 60 fps.");
    const campaign = manager.startFromGdd(ctx, "# GDD\n\nShips on Steam for Windows and later on iOS. Target 60 fps.", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    settleMilestone("green, shipping");
    await waitFor(() => expect(buildTargetsAsked.length).toBeGreaterThan(0));

    // EVERY named platform is built. Building only the first and disclosing
    // the rest made every multi-platform GDD unsatisfiable: the missing
    // platform blocked delivery and the next round asked for the first one
    // again, for ever (L#10).
    expect(buildTargetsAsked).toContain("windows");
    expect(buildTargetsAsked).toContain("ios");
    const stored = storage.get(campaign.id)!;
    // …and the platform it did NOT build is named where a person reads it,
    // as a structured field so a FAILED build cannot lose it (J#21).
    // …and this stub answers a macOS artifact whatever it is asked for, so
    // NEITHER requested platform was built: a valid StandaloneOSX artifact
    // used to satisfy "Release on Windows" and the campaign reached done (L#12).
    expect(stored.milestones[2]!.buildVerdict?.unbuiltTargets).toEqual(["windows", "ios"]);
    expect(stored.milestones[2]!.buildVerdict?.ok).toBe(false);
    expect(describeBuild(stored.milestones[2]!.buildVerdict!)).toContain("ios");
    expect(describeBuild({ ...stored.milestones[2]!.buildVerdict!, ok: false, reasons: ["compiler failed", "SDK missing"] }))
      .toContain("ios");
    expect(describeBuild({ ...stored.milestones[2]!.buildVerdict!, ran: false })).toContain("ios");
    // …and a builder that THROWS keeps them too.
    const throwing = new CampaignManager({
      storage,
      buildPlayer: async () => { throw new Error("SDK missing"); },
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async () => {},
      projectRoot,
    });
    const threw = await (throwing as unknown as { measureBuild(c: unknown): Promise<{ unbuiltTargets?: string[]; ran: boolean }> })
      .measureBuild({ id: "c_platforms", gddText: "Ships on Steam for Windows and later on iOS.", milestones: [], currentMilestone: 0 });
    expect(threw.ran).toBe(false);
    expect((threw as { requestedTarget?: string }).requestedTarget).toBe("windows");
    expect(threw.unbuiltTargets).toEqual(["windows", "ios"]);

    // With NO BUILDER at all the requested platforms are still named (K#13).
    const noBuilder = new CampaignManager({
      storage,
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async () => {},
      projectRoot,
    });
    const measured = await (noBuilder as unknown as { measureBuild(c: unknown): Promise<{ unbuiltTargets?: string[]; requestedTarget?: string }> })
      .measureBuild({ id: "c_platforms", gddText: "Ships on Steam for Windows and later on iOS.", milestones: [], currentMilestone: 0 });
    expect(measured.requestedTarget).toBe("windows");
    expect(measured.unbuiltTargets).toEqual(["ios"]);

    // A verdict persisted before the field existed still shows it (K#13).
    expect(describeBuild({
      ran: true, ok: true, target: "windows", artifactPath: "/p/Game.exe", sizeBytes: 1,
      reasons: ["the GDD also asks for ios; this build is windows only"],
    } as never)).toContain("ios");

    // A BUILDER THAT HONOURS THE ASK leaves nothing unbuilt: the two-platform
    // document is satisfiable, which it was not while only the first target
    // was ever requested (L#10).
    const asked: string[] = [];
    const honest = new CampaignManager({
      storage,
      buildPlayer: async (_root: string, target?: string) => {
        asked.push(String(target));
        return { ran: true, ok: true, target: String(target), artifactPath: `/p/Game.${target}`, sizeBytes: 1 };
      },
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async () => {},
      projectRoot,
    });
    const both = await (honest as unknown as { measureBuild(c: unknown): Promise<{ unbuiltTargets?: string[]; ok?: boolean }> })
      .measureBuild({ id: "c_platforms", gddText: "Ships on Steam for Windows and later on iOS.", milestones: [], currentMilestone: 0 });
    expect(asked).toEqual(["windows", "ios"]);
    // THREE platforms are three builds: a cap of any size would quietly leave
    // the last one unbuilt (Codex 2026-09-11 review O, mutation table).
    asked.length = 0;
    const three = await (honest as unknown as { measureBuild(c: unknown): Promise<{ unbuiltTargets?: string[] }> })
      .measureBuild({ id: "c_platforms", gddText: "Ships on Windows, on Android, and on iOS.", milestones: [], currentMilestone: 0 });
    expect(asked).toEqual(["windows", "android", "ios"]);
    expect(three.unbuiltTargets).toBeUndefined();
    expect(both.unbuiltTargets).toBeUndefined();
    expect(both.ok).toBe(true);
    // …and a platform nobody built is missing WORK, not a footnote (K#15).
    expect(stored.milestones[2]!.deliveryProofsMissing!.join(" ")).toContain("no build of them exists");
    expect(storage.get(campaign.id)!.state).not.toBe("done");
  });

  it("retiring a campaign cancels EVERY live task of its lineage, not just the tip (Codex 2026-09-11 I#7)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    // An older descendant of the FIRST sprint's lineage, still blocked,
    // carrying a prompt that matches no milestone — only the lineage walk
    // can find it — with a live tip beyond it.
    const orphan = tasks.addRetry("task_1", TaskStatus.blocked);
    (tasks as unknown as { prompts: Map<string, string> }).prompts.set(orphan, "an unrelated continuation");
    const tip = tasks.addRetry(orphan, TaskStatus.executing);
    (tasks as unknown as { prompts: Map<string, string> }).prompts.set(tip, "an unrelated continuation");

    settleMilestone("green, shipping", "task_3");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"));

    expect(tasks.cancelled).toContain(orphan);
    expect(tasks.cancelled).toContain(tip);
  });

  it("a supersession event does not stop the replacement it made way for (Codex 2026-09-11 J#1)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    // The campaign replaces task_1 with a child, marking the old one
    // superseded; the cancellation event arrives afterwards.
    const replacement = tasks.addRetry("task_1", TaskStatus.blocked);
    (tasks as unknown as { prompts: Map<string, string> }).prompts.set(replacement, tasks.submitted[0]!.prompt);
    const stored = storage.get(campaign.id)!;
    stored.milestones[0]!.taskId = replacement;
    storage.save(stored);
    tasks.cancel("task_1", { reason: "superseded" });
    tasks.emit("task:cancelled", "task_1", "cancelled");
    await new Promise((r) => setTimeout(r, 200));

    const after = storage.get(campaign.id)!;
    expect(after.lastError ?? "").not.toContain("was cancelled");
    expect(after.state).not.toBe("failed");
  });

  it("a stop order in the MIDDLE of the lineage is found (Codex 2026-09-11 J#6)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    // root (the milestone's task) → … → middle (cancelled by a person) → tip,
    // with enough nodes between them that a small visit budget would miss it.
    const chain: string[] = [];
    let chainEnd = "task_1";
    for (let i = 0; i < 10; i++) {
      chainEnd = tasks.addRetry(chainEnd, TaskStatus.blocked);
      chain.push(chainEnd);
    }
    // The stop order sits in the MIDDLE of the chain: far from the task the
    // walk is asked about and far from the tip, so a short visit budget
    // cannot reach it by luck.
    const middle = chain[5]!;
    const tip = chain.at(-1)!;
    for (const id of [middle, tip]) {
      (tasks as unknown as { prompts: Map<string, string> }).prompts.set(id, tasks.submitted[0]!.prompt);
    }
    tasks.cancel(middle, { reason: "user" });
    tasks.emit("task:blocked", tip, "still stuck");

    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));
    expect(storage.get(campaign.id)!.lastError).toContain("NOT DELIVERED");
  });

  it("the lineage walk looks at the milestone's OWN task first (Codex 2026-09-11 K#7)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const chain: string[] = [];
    for (let i = 0; i < 5; i++) {
      chain.push(tasks.addRetry(chain.at(-1) ?? "task_1", TaskStatus.blocked));
    }
    const asked: string[] = [];
    const realGetStatus = tasks.getStatus.bind(tasks);
    vi.spyOn(tasks, "getStatus").mockImplementation((id: string) => {
      asked.push(id);
      return realGetStatus(id);
    });
    (manager as unknown as { lineageWasCancelledOnPurpose(id: string): boolean }).lineageWasCancelledOnPurpose("task_1");
    vi.restoreAllMocks();
    // The tip lookup happens first by construction; what matters is that the
    // WALK reaches the asked-about task before it walks the chain back from
    // the tip, so a long chain cannot push it past the visit budget.
    const middle = chain.slice(0, -1); // the nodes only the walk touches
    const firstMiddle = Math.min(...middle.map((id) => asked.indexOf(id)).filter((i) => i >= 0));
    expect(asked.indexOf("task_1")).toBeGreaterThanOrEqual(0);
    expect(asked.indexOf("task_1")).toBeLessThan(firstMiddle);
  });

  it("a cancelled task under a LIVE child still stops the campaign (Codex 2026-09-11 J#2)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    // A person cancels the sprint; the executor's retry is already running.
    const child = tasks.addRetry("task_1", TaskStatus.executing);
    (tasks as unknown as { prompts: Map<string, string> }).prompts.set(child, tasks.submitted[0]!.prompt);
    tasks.cancel("task_1", { reason: "user" });
    tasks.emit("task:cancelled", "task_1", "cancelled");

    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));
    expect(storage.get(campaign.id)!.lastError).toContain("NOT DELIVERED");
    // …and the live child is retired rather than adopted.
    expect(tasks.cancelled).toContain(child);
  });

  it("a cancel on an ADOPTED lineage's ancestor still reaches the campaign (Codex 2026-09-11 K#8)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    // The executor mints a retry and the campaign adopts it, so the milestone
    // no longer points at task_1.
    const adopted = tasks.addRetry("task_1", TaskStatus.executing);
    (tasks as unknown as { prompts: Map<string, string> }).prompts.set(adopted, tasks.submitted[0]!.prompt);
    const moved = storage.get(campaign.id)!;
    moved.milestones[0]!.taskId = adopted;
    storage.save(moved);
    // A person cancels the ancestor the ladder has moved past.
    tasks.markTerminal("task_1", TaskStatus.blocked);
    tasks.cancel("task_1", { reason: "user" });
    tasks.emit("task:cancelled", "task_1", "cancelled");

    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));
    expect(storage.get(campaign.id)!.lastError).toContain("NOT DELIVERED");
  });

  it("the same shape with a SUPERSESSION keeps working (Codex 2026-09-11 J#2)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const child = tasks.addRetry("task_1", TaskStatus.executing);
    (tasks as unknown as { prompts: Map<string, string> }).prompts.set(child, tasks.submitted[0]!.prompt);
    // The campaign replaced task_1 itself; that is not a stop order.
    tasks.cancel("task_1", { reason: "superseded" });
    tasks.emit("task:cancelled", "task_1", "cancelled");
    await new Promise((r) => setTimeout(r, 250));
    expect(storage.get(campaign.id)!.state).not.toBe("failed");
  });

  it("a sprint cancelled ON PURPOSE stops the campaign instead of continuing its work (Codex 2026-09-11 I#6)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    // A person cancels the sprint: not a supersession, a stop order.
    tasks.cancel("task_1", { reason: "user" });
    tasks.emit("task:cancelled", "task_1", "cancelled");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));
    const after = storage.get(campaign.id)!;
    expect(tasks.submitted).toHaveLength(1); // nothing resubmitted
    expect(after.autoReviveAt).toBeUndefined();
    expect(after.lastError).toContain("NOT DELIVERED");
    expect(messages.at(-1)!.text).toContain("was cancelled");
  });

  it("an EXECUTOR cancellation is not a person's stop order (Codex 2026-09-11 K#6)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    // No reason at all: how an automatic retirement looks in the store.
    tasks.cancel("task_1");
    tasks.emit("task:cancelled", "task_1", "cancelled");
    await new Promise((r) => setTimeout(r, 250));
    const after = storage.get(campaign.id)!;
    expect(after.lastError ?? "").not.toContain("was cancelled");
    expect(messages.map((m) => m.text).join(" ")).not.toContain("the campaign stops here");
  });

  it("the campaign's OWN supersession is not a stop order (Codex 2026-09-11 I#6)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    // This is the mark the campaign uses when it replaces an attempt itself.
    tasks.cancel("task_1", { reason: "superseded" });
    tasks.emit("task:cancelled", "task_1", "cancelled");
    await new Promise((r) => setTimeout(r, 200));
    const after = storage.get(campaign.id)!;
    expect(after.lastError ?? "").not.toContain("was cancelled");
    expect(messages.map((m) => m.text).join(" ")).not.toContain("the campaign stops here");
  });

  it("a revival after a deliberate stop starts a NEW lineage (Codex 2026-09-11 J#7)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    // A person stops the sprint, then asks for it again.
    tasks.cancel("task_1", { reason: "user" });
    const stopped = storage.get(campaign.id)!;
    stopped.state = "failed";
    stopped.milestones[0]!.taskId = "task_1";
    storage.save(stopped);

    expect(await manager.tryHandleRevive("cli-local", "kampanya devam")).toBe(true);
    await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(1));

    // The new attempt does not descend from the cancelled one, so nothing
    // reads that stop as its own.
    const newTaskId = storage.get(campaign.id)!.milestones[0]!.taskId!;
    expect((tasks as unknown as { parents: Map<string, string> }).parents.get(newTaskId)).toBeUndefined();
  });

  it("a busy project postpones the appointment instead of losing it (Codex 2026-09-11 J#5)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    // Another campaign holds the project while this one's appointment is due.
    const busy = storage.get(campaign.id)!;
    busy.state = "failed";
    busy.autoReviveAt = Date.now() - 1_000;
    storage.save(busy);
    const other = manager.startFromGdd({ ...ctx, chatId: "cli-other" }, "# Other GDD", "docs/Game_GDD.md");
    expect(other.id).not.toBe(campaign.id);

    (manager as unknown as { scheduleAutoRevive(id: string, ms: number, at?: number): void })
      .scheduleAutoRevive(campaign.id, 10, busy.autoReviveAt);
    await new Promise((r) => setTimeout(r, 200));

    const after = storage.get(campaign.id)!;
    // The appointment moved forward; it did not disappear.
    expect(after.autoReviveAt).toBeGreaterThan(Date.now());
    expect(after.state).toBe("failed");
  });

  it("an older revival timer cannot fire a newer appointment early (Codex 2026-09-11 H#3)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const parked = storage.get(campaign.id)!;
    parked.state = "failed";
    const firstAppointment = Date.now() + 5_000;
    parked.autoReviveAt = firstAppointment;
    storage.save(parked);
    // The timer is armed FOR that appointment…
    (manager as unknown as { scheduleAutoRevive(id: string, ms: number, at?: number): void })
      .scheduleAutoRevive(campaign.id, 10, firstAppointment);
    // …and a second pause replaces it before the timer fires.
    const reparked = storage.get(campaign.id)!;
    reparked.autoReviveAt = Date.now() + 60_000;
    storage.save(reparked);

    await new Promise((r) => setTimeout(r, 200));
    expect(tasks.submitted).toHaveLength(1); // the stale timer did nothing
    expect(storage.get(campaign.id)!.autoReviveAt).toBe(reparked.autoReviveAt);
  });

  it("a cancel during the revival pause cancels the revival (Codex 2026-09-11 H#2)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    // Park the campaign with an appointment, as a self-revival does.
    const parked = storage.get(campaign.id)!;
    parked.state = "failed";
    parked.autoReviveAt = Date.now() + 10_000;
    parked.milestones[0]!.taskId = "task_1";
    storage.save(parked);
    // …then a person cancels the parked sprint.
    tasks.cancel("task_1", { reason: "user" });

    const submittedBefore = tasks.submitted.length;
    (manager as unknown as { scheduleAutoRevive(id: string, ms: number): void }).scheduleAutoRevive(campaign.id, 10);
    await new Promise((r) => setTimeout(r, 200));
    const after = storage.get(campaign.id)!;
    expect(tasks.submitted).toHaveLength(submittedBefore);
    expect(after.autoReviveAt).toBeUndefined();
    expect(after.lastError).toContain("cancelled while its retry was pending");
  });

  it("a FAILED gap sprint does not count the requirement as covered, and identity is the whole text (Codex 2026-09-11 J#13)", async () => {
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-gap-identity.db"));
    const long = "The save system must preserve all unlocked levels and scores across sessions";
    const sharesPrefix = "The save system must preserve all unlocked levels and scores in the cloud too";
    const auditCoverage = vi.fn()
      .mockResolvedValueOnce([long])
      .mockResolvedValueOnce([long, sharesPrefix])
      .mockResolvedValue([]);
    manager = new CampaignManager({
      storage,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
      implementationReviveDelayMs: 10,
    });
    manager.attachEvents();
    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    settleMilestone("final report");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));

    const first = storage.get(campaign.id)!.milestones.filter((m) => m.id.startsWith("mcov"));
    expect(first).toHaveLength(1);
    // The requirement is stored WHOLE, not truncated into the title.
    expect(first[0]!.coverageGap).toBe(long);

    // Two requirements sharing the first 60 characters are TWO requirements,
    // and a repeated one is still one: the queue drain is where a persisted
    // list is read back (Codex 2026-09-11 J#12, J#13).
    const queued = storage.get(campaign.id)!;
    queued.pendingCoverageGaps = [sharesPrefix, sharesPrefix, "Boss fight: absent"];
    storage.save(queued);
    for (let i = 0; i < 10 && storage.get(campaign.id)!.state === "executing"; i++) {
      const before = tasks.submitted.length;
      tasks.emit("task:failed", `task_${before}`, "gap sprint gave up");
      await waitFor(() => {
        const after = storage.get(campaign.id)!;
        expect(tasks.submitted.length > before || after.state !== "executing").toBe(true);
      });
      if ((storage.get(campaign.id)!.pendingCoverageGaps ?? []).length === 0) break;
    }
    const gaps = storage.get(campaign.id)!.milestones.filter((m) => m.id.startsWith("mcov"));
    expect(gaps.filter((m) => m.coverageGap === sharesPrefix)).toHaveLength(1);
    expect(gaps.filter((m) => m.coverageGap === long)).toHaveLength(1);
    expect(gaps.filter((m) => m.coverageGap === "Boss fight: absent")).toHaveLength(1);
  });

  it("a pending final proof sprint is RUN, not stepped over (Codex 2026-09-11 K#9)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    // The ladder after a remediation round: a spent gap sprint, and a final
    // proof sprint that has never run.
    const staged = storage.get(campaign.id)!;
    staged.milestones = [
      ...staged.milestones.slice(0, 2).map((m) => ({ ...m, status: "green" as const })),
      { id: "mcov1", title: "Coverage completion 1.1 — Save", prompt: "close the save gap", status: "running" as const, attempts: 2, taskId: "task_3", coverageGap: "Save: absent" },
      { id: "mfinal-4", title: "Final delivery proofs", prompt: "prove it", status: "pending" as const, attempts: 0 },
    ];
    staged.currentMilestone = 2;
    storage.save(staged);

    tasks.emit("task:failed", "task_3", "gap sprint gave up");
    await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(3));

    const after = storage.get(campaign.id)!;
    // It did not declare delivery from the structural check alone.
    expect(after.state).toBe("executing");
    expect(after.milestones[after.currentMilestone]!.id).toBe("mfinal-4");
    expect(tasks.submitted.at(-1)!.prompt).toContain("prove it");

    // …and with an OLDER final sprint already green in the ladder, it is the
    // UNPROVEN one that runs: a green mfinal proved an earlier tree.
    const twoFinals = storage.get(campaign.id)!;
    twoFinals.milestones = [
      { ...twoFinals.milestones[0]!, status: "green" as const },
      { id: "mfinal-2", title: "Final delivery proofs", prompt: "proved once", status: "green" as const, attempts: 1 },
      { id: "mcov9", title: "Coverage completion 9.1 — Audio", prompt: "close the audio gap", status: "running" as const, attempts: 2, taskId: "task_9", coverageGap: "Audio: absent" },
      { id: "mfinal-9", title: "Final delivery proofs", prompt: "prove it again", status: "pending" as const, attempts: 0 },
    ];
    twoFinals.currentMilestone = 2;
    twoFinals.state = "executing";
    twoFinals.pendingCoverageGaps = undefined;
    storage.save(twoFinals);
    const before = tasks.submitted.length;
    tasks.emit("task:failed", "task_9", "gap sprint gave up");
    await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(before));
    expect(tasks.submitted.at(-1)!.prompt).toContain("prove it again");
    expect(tasks.submitted.at(-1)!.prompt).not.toContain("proved once");
  });

  it("a recorded stop blocks the next submission AND delivery (Codex 2026-09-12 P#12)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));

    // The stop is recorded while a completion handler is still in flight.
    const stored = storage.get(campaign.id)!;
    stored.stopRequestedAt = Date.now();
    storage.save(stored);
    const before = tasks.submitted.length;

    // Nothing more is submitted: the marker was written by nothing reading it.
    (manager as unknown as { submitCurrentMilestone(c: unknown): void }).submitCurrentMilestone(storage.get(campaign.id)!);
    expect(tasks.submitted).toHaveLength(before);

    // …and a settle that WOULD have delivered stops instead of shipping.
    const staged = storage.get(campaign.id)!;
    staged.milestones = [
      { ...staged.milestones[0]!, status: "green" as const },
      { id: "mlast", title: "Final delivery proofs", prompt: "prove it", status: "running" as const, attempts: 0, taskId: "task_p12" },
    ];
    staged.currentMilestone = 1;
    staged.state = "executing";
    staged.stopRequestedAt = Date.now();
    storage.save(staged);
    settleMilestone("green, shipping", "task_p12");
    await new Promise((r) => setTimeout(r, 250));

    // The campaign does not ship. (Which guard catches it — the submission
    // one or the delivery one — is belt-and-braces; that it cannot reach
    // `done` past a recorded stop is the contract.)
    expect(storage.get(campaign.id)!.state).not.toBe("done");
  });

  it("a stop queued against an OLD generation does not fail the revived campaign (Codex 2026-09-11 L#3)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const taskId = storage.get(campaign.id)!.milestones[0]!.taskId!;

    // A person cancels; the stop is recorded the moment it is seen.
    tasks.cancel(taskId, { reason: "user" });
    tasks.emit("task:cancelled", taskId);
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));
    expect(storage.get(campaign.id)!.stopRequestedAt).toBeGreaterThan(0);

    // The person revives it: a new generation, with the old stop behind it.
    await manager.tryHandleRevive(ctx.chatId, "kampanya devam");
    await waitFor(() => expect(storage.get(campaign.id)!.state).not.toBe("failed"));
    const revived = storage.get(campaign.id)!;
    expect(revived.stopGeneration ?? 0).toBeGreaterThan(0);
    expect(revived.stopRequestedAt).toBeUndefined();

    // A second cancellation event for the OLD task must not stop the new run.
    tasks.emit("task:cancelled", taskId);
    await new Promise((r) => setTimeout(r, 120));
    expect(storage.get(campaign.id)!.state).not.toBe("failed");
  });

  it("a SIBLING's cancellation event reaches the campaign (Codex 2026-09-11 O#10)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const root = storage.get(campaign.id)!.milestones[0]!.taskId!;

    // root → A and root → B; the milestone has adopted B. A person cancels A.
    // The guard knew about it; the EVENT reached no handler at all.
    const siblingA = tasks.submit("cli-local", "cli", "retry A", { parentId: root });
    const siblingB = tasks.submit("cli-local", "cli", "retry B", { parentId: root });
    const adopted = storage.get(campaign.id)!;
    adopted.milestones[0]!.taskId = siblingB.id;
    storage.save(adopted);
    tasks.cancel(siblingA.id, { reason: "user" });
    tasks.emit("task:cancelled", siblingA.id);

    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));
    expect(storage.get(campaign.id)!.lastError ?? "").toContain("cancelled");
  });

  it("a stop on a SIBLING retry stops the campaign too (Codex 2026-09-11 L#2)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const root = storage.get(campaign.id)!.milestones[0]!.taskId!;

    // The mission's own retry tree: root → A and root → B. The milestone has
    // adopted B; a person cancels A. Neither descends from the other, so
    // walking upward from B never saw the stop and the campaign carried on.
    const siblingA = tasks.submit("cli-local", "cli", "retry A", { parentId: root });
    const siblingB = tasks.submit("cli-local", "cli", "retry B", { parentId: root });
    tasks.cancel(siblingA.id, { reason: "user" });
    const adopted = storage.get(campaign.id)!;
    adopted.milestones[0]!.taskId = siblingB.id;
    storage.save(adopted);

    expect(
      (manager as unknown as { lineageWasCancelledOnPurpose(id: string): boolean })
        .lineageWasCancelledOnPurpose(siblingB.id),
    ).toBe(true);
  });

  it("outstanding SPRINTS come before the final proof, and an old final never rewinds the ladder (Codex 2026-09-11 L#14)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    // A pending sprint still sits ahead of the final. Jumping to the final
    // reached `done` with that sprint never run at all.
    const staged = storage.get(campaign.id)!;
    staged.milestones = [
      { ...staged.milestones[0]!, status: "green" as const },
      { id: "mcov1", title: "Coverage 1 — Save", prompt: "close save", status: "running" as const, attempts: 2, taskId: "task_s1", coverageGap: "Save: absent" },
      { id: "mcov2", title: "Coverage 2 — Audio", prompt: "close audio", status: "green" as const, attempts: 1, coverageGap: "Audio: absent" },
      { id: "mcov3", title: "Coverage 3 — Story", prompt: "close story", status: "pending" as const, attempts: 0, coverageGap: "Story: absent" },
      { id: "mfinal-1", title: "Final delivery proofs", prompt: "prove it", status: "pending" as const, attempts: 0 },
    ];
    staged.currentMilestone = 1;
    staged.state = "executing";
    staged.pendingCoverageGaps = undefined;
    storage.save(staged);
    tasks.emit("task:failed", "task_s1", "gap sprint gave up");
    await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(3));
    expect(storage.get(campaign.id)!.milestones[storage.get(campaign.id)!.currentMilestone]!.id).toBe("mcov3");
    expect(tasks.submitted.at(-1)!.prompt).toContain("close story");

    // …and when only finals are left, it is the LAST one, not an older failed
    // one sitting earlier in the ladder — which advanced back into work that
    // had already spent its attempts.
    const finals = storage.get(campaign.id)!;
    finals.milestones = [
      { ...finals.milestones[0]!, status: "green" as const },
      { id: "mfinal-old", title: "Final delivery proofs", prompt: "proved once", status: "failed" as const, attempts: 0 },
      { id: "mcov9", title: "Coverage 9 — spent", prompt: "spent", status: "running" as const, attempts: 2, taskId: "task_s9", coverageGap: "X: absent" },
      { id: "mfinal-new", title: "Final delivery proofs", prompt: "prove it again", status: "pending" as const, attempts: 0 },
    ];
    finals.currentMilestone = 2;
    finals.state = "executing";
    storage.save(finals);
    const before = tasks.submitted.length;
    tasks.emit("task:failed", "task_s9", "gap sprint gave up");
    await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(before));
    expect(tasks.submitted.at(-1)!.prompt).toContain("prove it again");
  });

  it("an EXHAUSTED final proof is not a delivery, and the final runs LAST (Codex 2026-09-11 O#3, O#4)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    // A final that failed at its limit, and a gap sprint that has spent its
    // attempts: the campaign measured the structure alone and declared `done`
    // with the delivery gate's proofs never having stood once.
    const staged = storage.get(campaign.id)!;
    staged.milestones = [
      { ...staged.milestones[0]!, status: "green" as const },
      { id: "mfinal-2", title: "Final delivery proofs", prompt: "prove it", status: "failed" as const, attempts: 2 },
      { id: "mcov1", title: "Coverage 1 — Save", prompt: "close save", status: "running" as const, attempts: 2, taskId: "task_x1", coverageGap: "Save: absent" },
    ];
    staged.currentMilestone = 2;
    staged.state = "executing";
    staged.pendingCoverageGaps = undefined;
    storage.save(staged);
    tasks.emit("task:failed", "task_x1", "gap sprint gave up");
    await waitFor(() => expect(storage.get(campaign.id)!.state).not.toBe("executing"));

    const after = storage.get(campaign.id)!;
    expect(after.state).not.toBe("done");
    expect(after.lastError ?? "").toContain("never passed the delivery gate");
  });

  it("a final proof selected for a rerun is moved to the END of the ladder (Codex 2026-09-11 O#3)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    // The final sits BEFORE the exhausted gap. Running it in place meant its
    // completion advanced straight back into that gap, round after round.
    const staged = storage.get(campaign.id)!;
    staged.milestones = [
      { ...staged.milestones[0]!, status: "green" as const },
      { id: "mfinal-2", title: "Final delivery proofs", prompt: "prove it", status: "pending" as const, attempts: 0 },
      { id: "mcov1", title: "Coverage 1 — Save", prompt: "close save", status: "running" as const, attempts: 2, taskId: "task_x2", coverageGap: "Save: absent" },
    ];
    staged.currentMilestone = 2;
    staged.state = "executing";
    staged.pendingCoverageGaps = undefined;
    storage.save(staged);
    const before = tasks.submitted.length;
    tasks.emit("task:failed", "task_x2", "gap sprint gave up");
    await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(before));

    const after = storage.get(campaign.id)!;
    expect(after.milestones.at(-1)!.id).toBe("mfinal-2");
    expect(after.currentMilestone).toBe(after.milestones.length - 1);
    expect(tasks.submitted.at(-1)!.prompt).toContain("prove it");
  });

  it("work scheduled AFTER a green final invalidates its proof instead of riding on it (Codex 2026-09-11 L#13)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    // A final proof already green, a gap sprint that has spent its attempts,
    // and a requirement still queued. The drained gap used to be appended
    // AFTER the final, so its own work was never proved by anything.
    const staged = storage.get(campaign.id)!;
    staged.milestones = [
      { ...staged.milestones[0]!, status: "green" as const },
      { id: "mfinal-2", title: "Final delivery proofs", prompt: "proved once", status: "green" as const, attempts: 1 },
      { id: "mcov1", title: "Coverage 1 — Save", prompt: "close save", status: "running" as const, attempts: 2, taskId: "task_g1", coverageGap: "Save: absent" },
    ];
    staged.currentMilestone = 2;
    staged.state = "executing";
    staged.pendingCoverageGaps = ["Story: absent"];
    storage.save(staged);
    tasks.emit("task:failed", "task_g1", "gap sprint gave up");
    await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(3));

    const after = storage.get(campaign.id)!;
    const ids = after.milestones.map((m) => m.id);
    const gapAt = ids.findIndex((id) => id.startsWith("mcov") && id !== "mcov1");
    // The new sprint sits BEFORE the final proof…
    expect(gapAt).toBeGreaterThanOrEqual(0);
    expect(gapAt).toBeLessThan(ids.lastIndexOf("mfinal-2"));
    expect(after.currentMilestone).toBe(gapAt);
    // …and that final is no longer green: it measured a tree this work changes.
    expect(after.milestones.find((m) => m.id === "mfinal-2")!.status).not.toBe("green");
    expect(after.state).toBe("executing");
  });

  it("a gap sprint that ran after a green final does not deliver on that final's proof (Codex 2026-09-11 L#13)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    // Nothing queued, the gap sprint exhausted: the campaign used to declare
    // `done` from the structural check alone, with the gap's own changes
    // never compiled and the final's proofs describing an earlier tree.
    const staged = storage.get(campaign.id)!;
    staged.milestones = [
      { ...staged.milestones[0]!, status: "green" as const },
      { id: "mfinal-2", title: "Final delivery proofs", prompt: "prove it", status: "green" as const, attempts: 1 },
      { id: "mcov1", title: "Coverage 1 — Save", prompt: "close save", status: "running" as const, attempts: 2, taskId: "task_g2", coverageGap: "Save: absent" },
    ];
    staged.currentMilestone = 2;
    staged.state = "executing";
    staged.pendingCoverageGaps = undefined;
    storage.save(staged);
    const before = tasks.submitted.length;
    tasks.emit("task:failed", "task_g2", "gap sprint gave up");
    await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(before));

    const after = storage.get(campaign.id)!;
    expect(after.state).toBe("executing");
    expect(after.milestones[after.currentMilestone]!.id).toBe("mfinal-2");
    expect(tasks.submitted.at(-1)!.prompt).toContain("prove it");
  });

  it("an OLD green final sprint does not rewind the ladder or satisfy the proofs (Codex 2026-09-11 K#9, K#10)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    const staged = storage.get(campaign.id)!;
    staged.milestones = [
      { ...staged.milestones[0]!, status: "green" as const },
      { id: "mfinal-old", title: "Final delivery proofs", prompt: "proved once", status: "green" as const, attempts: 1 },
      { id: "mcov1", title: "Coverage completion 1.1 — Save", prompt: "close the save gap", status: "green" as const, attempts: 1, coverageGap: "Save: absent" },
      { id: "mcov2", title: "Coverage completion 1.2 — Audio", prompt: "close the audio gap", status: "running" as const, attempts: 2, taskId: "task_3", coverageGap: "Audio: absent" },
      { id: "mfinal-new", title: "Final delivery proofs", prompt: "prove it again", status: "pending" as const, attempts: 0 },
    ];
    staged.currentMilestone = 3;
    staged.pendingCoverageGaps = ["Story: absent"];
    storage.save(staged);

    tasks.emit("task:failed", "task_3", "gap sprint gave up");
    await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(3));

    const after = storage.get(campaign.id)!;
    const ids = after.milestones.map((m) => m.id);
    // The queued gap went in before the sprint that still has to prove the
    // game, NOT before the one that already did.
    expect(ids.indexOf("mfinal-old")).toBeLessThan(ids.findIndex((id) => id.startsWith("mcov")));
    const lastGap = ids.map((id, i) => (id.startsWith("mcov") ? i : -1)).reduce((max, i) => Math.max(max, i), -1);
    expect(lastGap).toBeLessThan(ids.indexOf("mfinal-new"));
    // …and the sprint it is running is the one that still has to prove the
    // game, not the one that proved an earlier version of it.
    expect(tasks.submitted.at(-1)!.prompt).not.toContain("proved once");
  });

  it("a drained gap is inserted BEFORE the final proof sprint (Codex 2026-09-11 J#11)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    // The ladder a coverage round leaves behind: a spent gap sprint as the
    // current milestone, a final proof sprint after it, and a requirement
    // still queued.
    const staged = storage.get(campaign.id)!;
    staged.milestones = [
      ...staged.milestones.slice(0, 2).map((m) => ({ ...m, status: "green" as const })),
      { id: "mcov1", title: "Coverage completion 1.1 — Save", prompt: "close the save gap", status: "running" as const, attempts: 2, coverageGap: "Save: absent" },
      { id: "mfinal-4", title: "Final delivery proofs", prompt: "prove it", status: "pending" as const, attempts: 0 },
    ];
    staged.currentMilestone = 2;
    staged.pendingCoverageGaps = ["Audio: absent"];
    staged.milestones[2]!.taskId = "task_3";
    storage.save(staged);

    tasks.emit("task:failed", "task_3", "gap sprint gave up");
    await waitFor(() => expect((storage.get(campaign.id)!.pendingCoverageGaps ?? []).length).toBe(0));

    const ids = storage.get(campaign.id)!.milestones.map((m) => m.id);
    const finalAt = ids.findIndex((id) => id.startsWith("mfinal"));
    const lastGapAt = ids.map((id, i) => (id.startsWith("mcov") ? i : -1)).reduce((max, i) => Math.max(max, i), -1);
    expect(finalAt).toBeGreaterThan(0);
    expect(lastGapAt).toBeLessThan(finalAt);
    // …and the campaign is working THE NEW sprint — not the exhausted one it
    // just failed, and not the final proofs.
    const current = storage.get(campaign.id)!;
    const running = current.milestones[current.currentMilestone]!;
    expect(running.id).not.toBe("mcov1");
    expect(running.coverageGap).toBe("Audio: absent");
    expect(running.attempts).toBeLessThanOrEqual(1);
  });

  it("a repeated audit entry gets ONE sprint (Codex 2026-09-11 I#5)", async () => {
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-dupe-gaps.db"));
    manager = new CampaignManager({
      storage,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      planner: {
        planMilestones: vi.fn().mockResolvedValue(LADDER),
        auditCoverage: vi.fn().mockResolvedValueOnce([
          "Save: absent", "Save: absent", "Boss fight: absent", "Save: absent",
        ]).mockResolvedValue([]),
      } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
      implementationReviveDelayMs: 10,
    });
    manager.attachEvents();
    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    settleMilestone("final report");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));

    const gapTitles = storage.get(campaign.id)!.milestones.filter((m) => m.id.startsWith("mcov")).map((m) => m.title);
    expect(gapTitles.filter((t) => t.includes("Save: absent"))).toHaveLength(1);
    expect(gapTitles.filter((t) => t.includes("Boss fight: absent"))).toHaveLength(1);
    expect(storage.get(campaign.id)!.pendingCoverageGaps ?? []).toHaveLength(0);
  });

  it("with NO player runner configured the game is not delivered (Codex 2026-09-11 H#8)", async () => {
    // F#12 removed the phrase from the host-incapability regex and the early
    // return set the waiver field directly, so nothing changed: Codex reached
    // `done` with an artifact nobody had run.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-no-runner.db"));
    manager = new CampaignManager({
      storage,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      // runPlayer: deliberately absent — this deployment configured none.
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
      deliveryResumeDelayMs: 20,
      implementationReviveDelayMs: 10,
    });
    manager.attachEvents();
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1), { timeout: 15_000 });
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2), { timeout: 15_000 });
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3), { timeout: 15_000 });
    // Through the delivery bounces: every one of them completes green, and
    // none of them plays the game.
    for (let i = 0; i < 12 && storage.get(campaign.id)!.state === "executing"; i++) {
      const before = tasks.submitted.length;
      settleMilestone(`green, shipping (round ${i})`);
      await waitFor(() => {
        expect(tasks.submitted.length > before || storage.get(campaign.id)!.state !== "executing").toBe(true);
      }, { timeout: 15_000 });
    }
    const after = storage.get(campaign.id)!;
    expect(after.state).not.toBe("done");
    expect(after.milestones[2]!.deliveryProofsMissing!.join(" ")).toContain("no player runner is configured");
  });

  it("delivery rounds that keep ending with the SAME proofs missing stop, and progress starts the budget again (Codex 2026-09-11 H#1)", async () => {
    // Codex measured 100 completions producing 100 submissions: the "resumes
    // by itself with a fresh budget" path had no durable counter at all.
    runRecordOnSettle = undefined; // every sprint completes without running the suite
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-delivery-budget.db"));
    manager = new CampaignManager({
      storage,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
      deliveryResumeDelayMs: 20,
      implementationReviveDelayMs: 10,
    });
    manager.attachEvents();
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1), { timeout: 15_000 });
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2), { timeout: 15_000 });
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3), { timeout: 15_000 });

    for (let i = 0; i < 30; i++) {
      const stored = storage.get(campaign.id)!;
      if (stored.state === "failed" && !stored.autoReviveAt) break;
      const before = tasks.submitted.length;
      // The MEASUREMENTS move every round while the missing proof does not:
      // a play-through whose action and frame counts climb used to produce a
      // new signature every round, so the budget never charged (Codex I#1).
      // The WORDING of the failure alternates while the gate outcome does not:
      // a prose classifier flips its identity here, the structured one does
      // not (Codex 2026-09-11 K#3, K#4).
      writePlaythroughVerdict(false, {
        reasons: [i % 2 === 0
          ? `session 1 never ended after ${60 + i} actions (phases seen: Playing)`
          : `every frame is flat after ${60 + i} actions (no motion at all)`],
        record: { scene: "Entry", session: 1, autoStarted: false, actions: 60 + i, outcome: "None", reachedOutcome: false },
        frames: { count: 100 + i, flat: 0, maxMotionShare: 0.4 },
      });
      settleMilestone(`shipping it (round ${i})`);
      await waitFor(() => {
        const after = storage.get(campaign.id)!;
        expect(tasks.submitted.length > before || (after.state === "failed" && !after.autoReviveAt)).toBe(true);
      }, { timeout: 15_000 });
    }
    const stopped = storage.get(campaign.id)!;
    expect(stopped.state).toBe("failed");
    expect(stopped.autoReviveAt).toBeUndefined();
    expect(stopped.lastError).toContain("NOT DELIVERED");
    expect(stopped.deliveryRevives).toBe(4); // three rounds allowed, the fourth stops
    expect(messages.at(-1)!.text).toContain("ended with exactly the same proofs missing");
    // Bounded, not unlimited: nowhere near a submission per completion.
    expect(tasks.submitted.length).toBeLessThan(20);
  });

  it("an ABSENT and a STALE play-through are the same unmet proof, and the budget charges for both (Codex 2026-09-11 L#8)", async () => {
    // Alternating between no verdict file and an old one produced two
    // signatures, so every round looked like progress: eight rounds, counter
    // still 1, revival armed every time, and no game improvement at all.
    runRecordOnSettle = undefined;
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-stale-budget.db"));
    manager = new CampaignManager({
      storage,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
      deliveryResumeDelayMs: 20,
      implementationReviveDelayMs: 10,
    });
    manager.attachEvents();
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1), { timeout: 15_000 });
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2), { timeout: 15_000 });
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3), { timeout: 15_000 });

    for (let i = 0; i < 12; i++) {
      const stored = storage.get(campaign.id)!;
      if (stored.state === "failed" && !stored.autoReviveAt) break;
      const before = tasks.submitted.length;
      // Round after round: no record at all, then a record that predates the
      // attempt. Neither proves anything about THIS attempt.
      const verdictPath = join(projectRoot, "Recordings", "playthrough", "playthrough-verdict.json");
      if (i % 2 === 0) {
        rmSync(join(projectRoot, "Recordings", "playthrough"), { recursive: true, force: true });
      } else {
        // A record that predates the attempt: green, and about an earlier tree.
        writePlaythroughVerdict(true, { measuredAt: new Date(Date.now() - 3 * 3600_000).toISOString() });
      }
      settleMilestone(`shipping it (round ${i})`);
      // The settle handler touches the verdict's mtime; the stamp inside it
      // is what makes this record stale, and it stays old.
      if (i % 2 === 1 && existsSync(verdictPath)) {
        const old = new Date(Date.now() - 3 * 3600_000);
        utimesSync(verdictPath, old, old);
      }
      await waitFor(() => {
        const after = storage.get(campaign.id)!;
        expect(tasks.submitted.length > before || (after.state === "failed" && !after.autoReviveAt)).toBe(true);
      }, { timeout: 15_000 });
    }

    const stopped = storage.get(campaign.id)!;
    expect(stopped.state).toBe("failed");
    expect(stopped.autoReviveAt).toBeUndefined();
    expect(stopped.deliveryRevives).toBe(4);
  });

  it("a play-through that could not drive the game says so in its identity (Codex 2026-09-11 L#7)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    // The session refused to start at all. That is different work from a
    // session that ran and captured no frames, and the budget must not treat
    // fixing one as "exactly the same proofs missing".
    writePlaythroughVerdict(false, {
      record: { scene: "Entry", session: 1, missing: "no IPlaythroughDriver is registered", outcome: "None", reachedOutcome: false },
    });
    settleMilestone("shipping it");
    await waitFor(() => expect(storage.get(campaign.id)!.milestones[2]!.deliveryFailureKinds).toBeDefined());

    const refusedToStart = storage.get(campaign.id)!.milestones[2]!.deliveryFailureKinds!;
    expect(refusedToStart).toContain("playthroughUndriveable");

    // Now the session starts and drives, and captures nothing. Real progress,
    // and the identity has to say so or the budget charges it as a repeat.
    const before = tasks.submitted.length;
    writePlaythroughVerdict(false, {
      record: { scene: "Entry", session: 1, autoStarted: false, actions: 40, outcome: "None", reachedOutcome: false },
      frames: { count: 0, flat: 0, maxMotionShare: 0 },
    });
    settleMilestone("shipping it again");
    await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(before));

    const noFrames = storage.get(campaign.id)!.milestones[2]!.deliveryFailureKinds!;
    expect(noFrames).toContain("playthroughNoFrames");
    expect(noFrames).not.toEqual(refusedToStart);
  });

  it("ALTERNATING defects cannot bounce for ever (Codex 2026-09-11 O#5)", async () => {
    // Two failures that take turns each reset the per-signature counter, so
    // twelve rounds ran with it stuck at one and the campaign never stopped.
    runRecordOnSettle = undefined;
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-total-budget.db"));
    manager = new CampaignManager({
      storage,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
      deliveryResumeDelayMs: 20,
      implementationReviveDelayMs: 10,
    });
    manager.attachEvents();
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1), { timeout: 15_000 });
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2), { timeout: 15_000 });
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3), { timeout: 15_000 });

    for (let i = 0; i < 60; i++) {
      const stored = storage.get(campaign.id)!;
      if (stored.state === "failed" && !stored.autoReviveAt) break;
      const before = tasks.submitted.length;
      // Actions and no frames, then frames and no actions, round after round.
      writePlaythroughVerdict(false, i % 2 === 0
        ? {
            record: { scene: "Entry", session: 1, autoStarted: false, actions: 40, outcome: "None", reachedOutcome: false },
            frames: { count: 0, flat: 0, maxMotionShare: 0 },
          }
        : {
            record: { scene: "Entry", session: 1, autoStarted: false, actions: 0, outcome: "None", reachedOutcome: false },
            frames: { count: 12, flat: 0, maxMotionShare: 0.4 },
          });
      settleMilestone(`shipping it (round ${i})`);
      await waitFor(() => {
        const after = storage.get(campaign.id)!;
        expect(tasks.submitted.length > before || (after.state === "failed" && !after.autoReviveAt)).toBe(true);
      }, { timeout: 15_000 });
    }

    const stopped = storage.get(campaign.id)!;
    expect(stopped.state).toBe("failed");
    expect(stopped.autoReviveAt).toBeUndefined();
    // The per-signature counter never got past its first round; the total did.
    expect(stopped.deliveryRevives).toBeLessThanOrEqual(3);
    expect(stopped.deliveryRoundsTotal).toBeGreaterThan(3);
    expect(stopped.lastError).toContain("NOT DELIVERED");
  });

  it("an upgraded signature FORMAT is not progress (Codex 2026-09-11 L#9)", () => {
    // A milestone persisted before the structured identity existed carried a
    // prose signature; the new format never matched it, so a campaign three
    // rounds into its budget started again at one and could never stop.
    const source = readFileSync(new URL("./campaign-manager.ts", import.meta.url), "utf8");
    const at = source.indexOf("const formatChanged =");
    expect(at).toBeGreaterThan(0);
    expect(source.slice(at, at + 400)).toContain("STRUCTURED_SIGNATURE_PREFIX");
    const repeatingAt = source.indexOf("const repeating = stored === signature || formatChanged;");
    expect(repeatingAt).toBeGreaterThan(at);
    // …and the identity is built from THIS round's structural measurement.
    const kindsAt = source.indexOf("milestone.deliveryFailureKinds = kinds;");
    expect(kindsAt).toBeGreaterThan(0);
    // The window holds the whole kinds block, comments included: the flags
    // are computed there, never read from what a previous round stored.
    expect(source.slice(kindsAt - 900, kindsAt)).toContain("milestone.structureRefused === true");
    expect(source.slice(kindsAt - 900, kindsAt)).toContain("unclosedAtGate.length > 0");
  });

  it("at the final sprint a record with no timestamp of its own is not proof (Codex 2026-09-11 G#4)", async () => {
    // A copied record has a fresh mtime by construction, so an mtime is not
    // freshness; the record has to say when it ran.
    runRecordOnSettle = { total: 42, passed: 42, failed: 0, skipped: 0, unfiltered: true, measuredAt: null };
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    settleMilestone("green, shipping");
    await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(3));
    expect(storage.get(campaign.id)!.milestones[2]!.testVerdict).toBeUndefined();
    expect(storage.get(campaign.id)!.state).not.toBe("done");

    // The same record WITH its stamp delivers.
    runRecordOnSettle = { total: 42, passed: 42, failed: 0, skipped: 0, unfiltered: true };
    settleMilestone("green, shipping");
    await waitFor(() => expect(storage.get(campaign.id)!.milestones[2]!.testVerdict).toBeDefined(), { timeout: 15_000 });
  });

  it("a STALE NUnit record cannot be laundered into fresh proof by the prose fallback (Codex 2026-09-11 C#10)", async () => {
    runRecordOnSettle = undefined; // this sprint leaves no NUnit record
    mkdirSync(join(projectRoot, "Recordings", "tests"), { recursive: true });
    const record = join(projectRoot, "Recordings", "tests", "playmode-last.json");
    writeFileSync(record, JSON.stringify({ total: 215, passed: 215, failed: 0, skipped: 0, unfiltered: true, measuredAt: new Date().toISOString() }));
    const old = new Date(Date.now() - 6 * 60 * 60_000);
    utimesSync(record, old, old);
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    // The worker read the OLD result and reports it as green prose.
    tasks.verifications.set("task_3", { testsGreen: true, detail: "PlayMode verification passed: 215 of 215 tests passed (unfiltered — the whole PlayMode suite)", unfiltered: true });
    tasks.emit("task:completed", "task_3", "green, shipping");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));
    const m = storage.get(campaign.id)!.milestones[2]!;
    expect(m.testVerdict).toBeUndefined();
    expect(m.testRunSource).toBe("nunit");
    expect(storage.get(campaign.id)!.state).not.toBe("done");
  });

  it("a CANCELLED coverage sprint does not start a final proof sprint (Codex 2026-09-11 C#1)", async () => {
    // A manager of its own, on its own task manager and storage: two managers
    // on one emitter double-handle every event.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-cancel.db"));
    const planner = {
      planMilestones: vi.fn().mockResolvedValue(LADDER),
      auditCoverage: vi.fn().mockResolvedValue(["Dragon boss: no milestone implemented it"]),
    } as unknown as CampaignPlanner;
    manager = new CampaignManager({
      storage, planner,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async () => buildVerdict,
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot, retryAdoptionGraceMs: 10, completedSettleDelayMs: 0, milestoneTimeBoxMs: 60 * 60_000,
    });
    manager.attachEvents();
    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    settleMilestone("final report");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));
    tasks.emit("task:failed", "task_4", "the boss scene will not compile");
    await waitFor(() => expect(tasks.submitted).toHaveLength(5));
    // A person stops it: no new sprint is started on that.
    tasks.emit("task:cancelled", "task_5", "stopped by the operator");
    await new Promise((r) => setTimeout(r, 300));
    expect(tasks.submitted).toHaveLength(5);
    expect(storage.get(campaign.id)!.milestones.some((m) => m.id.startsWith("mfinal"))).toBe(false);
  });

  it("adopting an executor retry advances the freshness clock (Codex 2026-09-11 C#9)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const before = storage.get(campaign.id)!.milestones[0]!.attemptStartedAtMs!;
    await new Promise((r) => setTimeout(r, 5));
    (manager as unknown as { adoptTask: (c: unknown, id: string) => void }).adoptTask(storage.get(campaign.id), "task_retry");
    const after = storage.get(campaign.id)!.milestones[0]!;
    expect(after.taskId).toBe("task_retry");
    expect(after.attemptStartedAtMs!).toBeGreaterThan(before);
  });

  it("…to when that retry STARTED, not to when it was noticed (Codex 2026-09-13 AK#6)", async () => {
    // Adoption can happen long after the retry began, and stamping the
    // observation time made the retry's OWN proof — a suite record it wrote
    // thirty seconds in — older than its own attempt, so a green record read
    // back stale and the sprint was told its work did not count.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const retryStartedAt = Date.now() - 60_000;
    const retry = tasks.submit("cli-local", "cli", "the retry", { parentId: "task_1" });
    (tasks as unknown as { createdAts: Map<string, number> }).createdAts.set(retry.id, retryStartedAt);

    (manager as unknown as { adoptTask: (c: unknown, id: string) => void }).adoptTask(storage.get(campaign.id), retry.id);

    const after = storage.get(campaign.id)!.milestones[0]!;
    expect(after.taskId).toBe(retry.id);
    expect(after.attemptStartedAtMs).toBe(retryStartedAt);
    // A retry this coordinator cannot read still moves the clock forward
    // rather than leaving the abandoned attempt's evidence eligible.
    (manager as unknown as { adoptTask: (c: unknown, id: string) => void }).adoptTask(storage.get(campaign.id), "task_unknown");
    expect(storage.get(campaign.id)!.milestones[0]!.attemptStartedAtMs!).toBeGreaterThan(retryStartedAt);
  });

  it("the art bounce does not fight a GDD that ASKED for flat art (Codex 2026-09-11 B#17)", () => {
    const flatGdd = [
      "# GDD", "## Art Direction",
      "A minimalist geometric look: solid colour shapes, no gradients, no texture detail anywhere.",
      "Every element reads as a silhouette at 64 px, and the palette never exceeds four colours.",
      "Nothing is shaded; the whole game is flat colour on flat colour, deliberately.",
    ].join("\n");
    const milestone = { id: "mcov1", title: "Art", prompt: "make art", status: "running", attempts: 1, placeholderArtAtStart: { sprites: 20, placeholders: 19 } } as never;
    const withFlat = { id: "c1", gddText: flatGdd, milestones: [milestone] } as never;
    const withoutFlat = { id: "c1", gddText: "# GDD\n\n## Art Direction\n" + "Lush painted scenes with deep shading and hand-drawn detail everywhere you look, warm and textured. ".repeat(3), milestones: [milestone] } as never;
    // The art did NOT drop, so the gate would fire on its own terms.
    (manager as unknown as { measurePlaceholderArt: () => { sprites: number; placeholders: number } }).measurePlaceholderArt =
      () => ({ sprites: 20, placeholders: 19 });
    const bounce = (c: unknown) => (manager as unknown as { placeholderArtGate: (c: unknown, m: unknown) => string | undefined }).placeholderArtGate(c, milestone);
    // The pixels are identical; only the document differs. (The project fixture
    // has no sprites, so the non-flat path returns undefined for its own
    // reason; what this pins is that the FLAT document short-circuits first.)
    expect(bounce(withFlat)).toBeUndefined();
    // …and a document that asked for painted art still gets the bounce.
    expect(bounce(withoutFlat)).toContain("ART NOT PRODUCED");
  });

  it("a failed remediation attempt retries with the art directive when the placeholder count did not drop", async () => {
    // Measured 2026-09-07: five attempts ended blocked/failed; the
    // completion-time gate never spoke and no retry saw the recipe.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-art-retry.db"));
    const planner = {
      planMilestones: vi.fn().mockResolvedValue(LADDER),
      auditCoverage: vi.fn().mockResolvedValue(["Art production: pig skins are not covered"]),
    } as unknown as CampaignPlanner;
    manager = new CampaignManager({
      storage,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      planner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => {
        messages.push({ chatId, text });
      },
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    (manager as unknown as { measurePlaceholderArt: () => { sprites: number; placeholders: number } })
      .measurePlaceholderArt = () => ({ sprites: 100, placeholders: 95 });
    manager.attachEvents();

    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    settleMilestone("final report");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4), { timeout: 15_000 });

    tasks.emit("task:failed", "task_4", "compile still red");
    await waitFor(() => expect(tasks.submitted).toHaveLength(5), { timeout: 15_000 });
    const retry = tasks.submitted[4]!.prompt;
    expect(retry).toContain("The previous attempt ended");
    expect(retry).toContain("ART NOT PRODUCED: when this sprint began, 95 of 100");
    expect(retry.match(/ART NOT PRODUCED/g)).toHaveLength(1);
    expect(storage.get(campaign.id)!.milestones.at(-1)!.artBounced).toBeUndefined(); // a directive, not a bounce
  });

  it("real sprites added under new names satisfy the art gate — no directive on the retry", async () => {
    // Measured 2026-09-07 15:15: Ufo.png and SeatRed.png drawn beside the
    // 410 placeholders; the placeholder count alone would have bounced it.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-art-added.db"));
    const planner = {
      planMilestones: vi.fn().mockResolvedValue(LADDER),
      auditCoverage: vi.fn().mockResolvedValue(["Art production: pig skins are not covered"]),
    } as unknown as CampaignPlanner;
    manager = new CampaignManager({
      storage,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      planner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => {
        messages.push({ chatId, text });
      },
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    let art = { sprites: 100, placeholders: 95 };
    (manager as unknown as { measurePlaceholderArt: () => { sprites: number; placeholders: number } })
      .measurePlaceholderArt = () => art;
    manager.attachEvents();

    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    settleMilestone("final report");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4), { timeout: 15_000 });

    art = { sprites: 103, placeholders: 95 }; // three real sprites added, placeholders untouched
    tasks.emit("task:failed", "task_4", "compile still red");
    await waitFor(() => expect(tasks.submitted).toHaveLength(5), { timeout: 15_000 });
    expect(tasks.submitted[4]!.prompt).not.toContain("ART NOT PRODUCED");
    void campaign;
  });

  it("the delivery report carries the independent reviewer's verdict verbatim, or says it did not run", async () => {
    // User's ask 2026-09-07: "çifte teyit" — a second model's verdict on every delivery.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-review.db"));
    const seenPrompts: string[] = [];
    manager = new CampaignManager({
      storage,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
      independentReviewer: async ({ prompt }) => {
        seenPrompts.push(prompt);
        return { ok: true, model: "fake-astra", text: "VERDICT: NOT DELIVERABLE\nBLOCKERS: 1. no pigs", ms: 1234 };
      },
    });
    manager.attachEvents();
    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    settleMilestone("final report");
    await waitFor(() => expect(storage.get(campaign.id)!.deliveryReported).toBe(true), { timeout: 15_000 });
    const report = messages.at(-1)!.text;
    expect(report).toContain("Independent review (fake-astra via Codex, read-only, 1s)");
    expect(report).toContain("> VERDICT: NOT DELIVERABLE");
    expect(seenPrompts[0]).toContain("VERDICT: DELIVERABLE | NOT DELIVERABLE");
    expect(seenPrompts[0]).toContain("docs/Game_GDD.md");
  });

  it("withholds the report when the campaign moves on WHILE the review is gathered (Codex 2026-09-13 AF#6)", async () => {
    // The generation check ran before the reviewer's await; a person reviving
    // the campaign inside that await still got the old generation's "game
    // build complete".
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, `campaigns-review-race-${messages.length}.db`));
    let campaignId: string | undefined;
    manager = new CampaignManager({
      storage,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
      independentReviewer: async () => {
        // A person revives the campaign while the opinion is being gathered.
        const live = storage.get(campaignId!)!;
        live.stopGeneration = (live.stopGeneration ?? 0) + 1;
        live.state = "executing";
        storage.save(live);
        return { ok: true, model: "fake-astra", text: "VERDICT: DELIVERABLE", ms: 5 };
      },
    });
    manager.attachEvents();
    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    campaignId = campaign.id;
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    const before = messages.length;
    settleMilestone("final report");

    await new Promise((r) => setTimeout(r, 1500));
    expect(storage.get(campaign.id)!.stopGeneration).toBe(1);
    expect(messages.slice(before).some((m) => m.text.includes("game build complete"))).toBe(false);
    expect(storage.get(campaign.id)!.deliveryReported).not.toBe(true);
  });

  it("a spent coverage-remediation sprint is NOT a delivery when the measured tree is refused", async () => {
    // Measured 2026-09-07 07:00: state=done under a "⛔ NOT DELIVERED"
    // headline, with structure findings two days stale.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-partial-refused.db"));
    const planner = {
      planMilestones: vi.fn().mockResolvedValue(LADDER),
      auditCoverage: vi.fn().mockResolvedValue(["Pig skins: no milestone made them"]),
    } as unknown as CampaignPlanner;
    manager = new CampaignManager({
      storage,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      planner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => {
        messages.push({ chatId, text });
      },
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    // The planned ladder passes its own delivery gate; the tree is refused
    // only when measured again at the partial delivery, after the
    // remediation sprint failed to change it.
    (manager as unknown as {
      measureDeliveryStructure: (c: { milestones: Array<{ id: string }> }) => { refusal?: string; lines: string[] };
    }).measureDeliveryStructure = (c) =>
      c.milestones.some((m) => m.id.startsWith("mcov"))
        ? {
            refusal: "The shipped scenes render NOTHING: 0 renderer components",
            lines: ["Project art: 429 sprite textures — 410 of them placeholder-grade"],
          }
        : { lines: ["Project art: 429 sprite textures"] };
    manager.attachEvents();

    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1), { timeout: 15_000 });
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2), { timeout: 15_000 });
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3), { timeout: 15_000 });
    settleMilestone("final report");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4), { timeout: 15_000 });
    tasks.emit("task:failed", "task_4", "no art was made");
    await waitFor(() => expect(tasks.submitted).toHaveLength(5), { timeout: 15_000 });
    tasks.emit("task:failed", "task_5", "no art was made");

    // The final proof sprint measures the tree as it is; the refusal stands
    // through its bounce budget and the campaign is NOT delivered.
    await waitFor(() => expect(tasks.submitted).toHaveLength(6), { timeout: 15_000 });
    expect(tasks.submitted[5]!.prompt).toContain("FINAL DELIVERY PROOFS");
    for (let round = 0; round < 4 && storage.get(campaign.id)!.state !== "failed"; round++) {
      const before = tasks.submitted.length;
      mkdirSync(join(projectRoot, "Recordings", "playthrough"), { recursive: true });
      writeFileSync(join(projectRoot, "Recordings", "playthrough", `frame_0009${round}.png`), Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(4096, 7 + round)]));
      settleMilestone("final proofs green");
      await waitFor(() => {
        const c = storage.get(campaign.id)!;
        expect(c.state === "failed" || tasks.submitted.length > before).toBe(true);
      }, { timeout: 15_000 });
    }
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"), { timeout: 15_000 });
    const delivered = storage.get(campaign.id)!;
    // The refusal now stops the FINAL PROOF sprint's own gate: the campaign
    // fails with the measured reason and resumes itself with a fresh budget
    // (Codex 2026-09-11 B#1) instead of a one-shot partial delivery.
    expect(delivered.lastError).toContain("do not render the project's own art");
    expect(delivered.autoReviveAt).toBeGreaterThan(Date.now());
    const report = messages.map((m) => m.text).find((t) => t.includes("NOT DELIVERED"))!;
    expect(report).toContain("NOT DELIVERED");
    expect(report).toContain("410 of them placeholder-grade");
  });

  it("bounces a completion once when the sprint demanded a capture and none exists", async () => {
    const planner = {
      planMilestones: vi.fn().mockResolvedValue({
        milestones: [
          { title: "Sprint A — Visual", prompt: "build it; end with a captured frame proving something renders" },
          { title: "Sprint B — Next", prompt: "continue the work with more building" },
        ],
      }),
    } as unknown as CampaignPlanner;
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-capture.db"));
    manager = new CampaignManager({
      storage,
      planner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => messages.push({ chatId, text }),
      projectRoot,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); }, // no Recordings/ dir → no evidence
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    manager.attachEvents();

    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));

    settleMilestone("done, everything renders (it says)");
    // Bounced: resubmitted with the missing-evidence demand, attempts NOT burned.
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(tasks.submitted[1]!.prompt).toContain("VISUAL EVIDENCE MISSING");
    const fresh = storage.get(campaign.id)!;
    expect(fresh.milestones[0]!.status).toBe("running");
    expect(fresh.milestones[0]!.attempts).toBe(1);

    // Second completion stands (one-shot bounce) and the ladder advances.
    settleMilestone("done again");
    await waitFor(() => expect(storage.get(campaign.id)!.milestones[0]!.status).toBe("green"));
  });

  it("a completion whose last test run was red is not green (mechanical test gate)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));

    tasks.verifications.set("task_1", {
      testsGreen: false,
      detail: "PlayMode verification FAILED: 5 of 95 tests failed",
    });
    tasks.emit("task:completed", "task_1", "sprint A complete, everything works great");

    // Routed to the retry path with the red run named — not green.
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    const fresh = storage.get(campaign.id)!;
    expect(fresh.milestones[0]!.status).not.toBe("green");
    expect(tasks.submitted[1]!.prompt).toContain("Tests were RED at completion");

    // A green-verdict completion passes.
    tasks.verifications.set("task_2", { testsGreen: true, detail: "All 95 tests passed" });
    tasks.emit("task:completed", "task_2", "sprint A complete for real");
    await waitFor(() => expect(storage.get(campaign.id)!.milestones[0]!.status).toBe("green"));
  });

  it("capture evidence demands meaningful, non-identical frames", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const milestone = storage.get(campaign.id)!.milestones[0]!;
    milestone.taskId = "task_1";
    const gate = (m: unknown) =>
      (manager as unknown as { freshCaptureEvidence(x: unknown): { found: boolean } }).freshCaptureEvidence(m);

    const rec = join(projectRoot, "Recordings");
    mkdirSync(rec, { recursive: true });

    // A tiny file is not evidence.
    writeFileSync(join(rec, "frame_000.png"), Buffer.alloc(300, 7));
    expect(gate(milestone).found).toBe(false);

    // Several byte-identical "frames" are not evidence (unchanging screen).
    writeFileSync(join(rec, "frame_000.png"), Buffer.alloc(4096, 7));
    writeFileSync(join(rec, "frame_001.png"), Buffer.alloc(4096, 7));
    expect(gate(milestone).found).toBe(false);

    // Distinct meaningful frames pass.
    writeFileSync(join(rec, "frame_001.png"), Buffer.alloc(4096, 9));
    expect(gate(milestone).found).toBe(true);
  });

  it("reconcile judges outcomes INSIDE the per-campaign settle chain: a doubled settle cannot judge the final sprint twice", async () => {
    // Audited 2026-09-02: reconcileMilestoneAfterSettle ran from a bare
    // setTimeout outside enqueueSettle. Two settle emissions for one task
    // (task-manager has no terminal guard; appendTaskNotice re-emits
    // task:blocked) scheduled two reconciles; when the lineage tip had landed
    // completed and the outcome path crossed a real async boundary (the
    // coverage audit on the final sprint), the second reconcile re-entered
    // the green path: two billable audits and two delivery reports.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-reconcile.db"));
    let auditCalls = 0;
    const planner = {
      planMilestones: vi.fn().mockResolvedValue(LADDER),
      auditCoverage: vi.fn(async () => {
        auditCalls += 1;
        await new Promise((r) => setTimeout(r, 40));
        return [];
      }),
    } as unknown as CampaignPlanner;
    manager = new CampaignManager({
      storage,
      planner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => messages.push({ chatId, text }),
      projectRoot,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    manager.attachEvents();

    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    // Final sprint: the executor parks task_3 (emitted twice) and its own
    // retry lands completed inside the grace window.
    writePlaythroughVerdict(true); // the retry played the game before reporting
    const retryId = tasks.addRetry("task_3", TaskStatus.completed);
    tasks.markTerminal(retryId, TaskStatus.completed, "final report via retry");
    tasks.verifications.set(retryId, {
      testsGreen: true,
      detail: "All 42 tests passed (unfiltered — the whole PlayMode suite)",
      unfiltered: true,
    });
    // The retry ran the suite: its record is on disk before the settle.
    mkdirSync(join(projectRoot, "Recordings", "tests"), { recursive: true });
    writeFileSync(
      join(projectRoot, "Recordings", "tests", "playmode-last.json"),
      JSON.stringify({ measuredAt: new Date().toISOString(), total: 42, passed: 42, failed: 0, skipped: 0, unfiltered: true }),
    );
    tasks.emit("task:blocked", "task_3", "Transient failure — worker crashed mid-epoch.");
    tasks.emit("task:blocked", "task_3", "Transient failure — worker crashed mid-epoch.");

    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"));
    await new Promise((r) => setTimeout(r, 120));
    expect(auditCalls).toBe(1);
    expect(messages.filter((m) => m.text.includes("Campaign delivery"))).toHaveLength(1);
    expect(tasks.submitted).toHaveLength(3);
  });

  it("proofs still missing after the bounce budget: NOT DELIVERED, named, and the final sprint resumes by itself (non-waivable 2026-09-10)", async () => {
    rmSync(join(projectRoot, "Recordings"), { recursive: true, force: true });
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    const green = { testsGreen: true, detail: "PlayMode verification passed: 179 of 179 tests passed (unfiltered — the whole PlayMode suite)", unfiltered: true };
    // Green suite, no play-through, every time: the gate bounces while the budget lasts…
    for (let round = 0; round < 6 && storage.get(campaign.id)!.state === "executing"; round++) {
      const before = tasks.submitted.length;
      tasks.verifications.set(`task_${before}`, green);
      tasks.emit("task:completed", `task_${before}`, "shipping it");
      await waitFor(() => {
        const state = storage.get(campaign.id)!.state;
        expect(state !== "executing" || tasks.submitted.length > before).toBe(true);
      });
    }
    // …and then it does NOT deliver.
    const after = storage.get(campaign.id)!;
    expect(after.state).toBe("failed");
    expect(after.deliveryReported).not.toBe(true);
    expect(after.lastError).toMatch(/^delivery proofs still missing after the bounce budget: play-through: NOT observed/);
    expect(after.milestones[2]!.deliveryProofsMissing).toEqual([expect.stringMatching(/^play-through: NOT observed/)]);
    const report = messages.map((m) => m.text).find((t) => t.includes("NOT DELIVERED"))!;
    expect(report.split("\n")[0]).toContain("NOT DELIVERED — the final sprint's proofs are missing: play-through: NOT observed");
    expect(report).toContain("resumes by itself in 15 min");
    expect(report).toContain("kampanya devam");
    // Resumes on its own: the revive is armed.
    expect(after.autoReviveAt).toBeGreaterThan(Date.now() + 10 * 60_000);
    expect(messages.some((m) => m.text.includes("Campaign delivery — game build"))).toBe(false);
  });

  it("a final sprint that never ran a test is NOT delivered (was: delivered with a caveat)", async () => {
    runRecordOnSettle = undefined; // this sprint leaves no NUnit record
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    for (let round = 0; round < 8 && storage.get(campaign.id)!.state === "executing"; round++) {
      const before = tasks.submitted.length;
      tasks.emit("task:completed", `task_${before}`, "shipping it again");
      await waitFor(() => {
        const state = storage.get(campaign.id)!.state;
        expect(state !== "executing" || tasks.submitted.length > before).toBe(true);
      });
    }
    const after = storage.get(campaign.id)!;
    expect(after.state).toBe("failed");
    expect(after.lastError).toContain("no test run was observed");
    const report = messages.map((m) => m.text).find((t) => t.includes("NOT DELIVERED"))!;
    expect(report).toContain("no test run was observed");
    expect(report).toMatch(/NO observed test run/);
  });

  it("revival resets the bounce COUNTERS the gates read, not just the booleans", async () => {
    runRecordOnSettle = undefined; // this sprint leaves no NUnit record
    // Measured live 2026-09-04 16:18. reviveAtCurrentMilestone cleared
    // deliveryVerificationBounced while deliveryVerificationBounces stayed at
    // 2 of 2, so `spent < maxMilestoneAttempts` was false and the delivery
    // gate could not fire. Sprint 7 shipped green on a verdict carrying no
    // unfiltered flag, minutes after an unfiltered run reported 32 of 185
    // failing.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    // Spend both delivery bounces on the final sprint.
    tasks.emit("task:completed", "task_3", "shipping it");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));
    tasks.emit("task:completed", "task_4", "shipping it again");
    await waitFor(() => expect(tasks.submitted).toHaveLength(5));
    expect(storage.get(campaign.id)!.milestones[2]!.deliveryVerificationBounces).toBe(2);

    await failUntilStopped(campaign.id, "boom");
    const beforeRevive = tasks.submitted.length;
    expect(await manager.tryHandleRevive("cli-local", "kampanya devam")).toBe(true);
    await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(beforeRevive));

    const revived = storage.get(campaign.id)!.milestones[2]!;
    expect(revived.deliveryVerificationBounces ?? 0).toBe(0);
    expect(revived.sceneHygieneBounces ?? 0).toBe(0);

    // And the gate can actually fire again: a completion with no verdict is
    // bounced instead of delivering.
    const beforeBounce = tasks.submitted.length;
    tasks.emit("task:completed", `task_${beforeBounce}`, "shipping it after revive");
    await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(beforeBounce));
    expect(storage.get(campaign.id)!.state).toBe("executing");
  });

  it("revival restores the delivery-verification gate along with the other evidence gates", async () => {
    runRecordOnSettle = undefined; // this sprint leaves no NUnit record
    // Audited 2026-09-02: reviveAtCurrentMilestone reset the visual and
    // no-work bounces ("fresh budget = fresh gates") but not
    // deliveryVerificationBounced, so a revived final sprint could never be
    // bounced for a missing test run again.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    tasks.emit("task:completed", "task_3", "shipping it"); // delivery bounce spent
    await waitFor(() => expect(tasks.submitted).toHaveLength(4));
    expect(storage.get(campaign.id)!.milestones[2]!.deliveryVerificationBounced).toBe(true);
    tasks.emit("task:failed", "task_4", "boom");
    await waitFor(() => expect(tasks.submitted).toHaveLength(5));
    await failUntilStopped(campaign.id, "boom again");

    const submittedBeforeRevive = tasks.submitted.length;
    expect(await manager.tryHandleRevive("cli-local", "kampanya devam")).toBe(true);
    await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(submittedBeforeRevive));
    const revived = storage.get(campaign.id)!.milestones[2]!;
    expect(revived.deliveryVerificationBounced).toBe(false);
    expect(revived.visualEvidenceBounced).toBe(false);

    // The revived sprint completes with no test run, so the delivery gate
    // must bounce it again instead of declaring delivery.
    //
    // This used to take TWO completions: the delivery bounce's own text says
    // "capture a frame", and the visual gate re-scanned the live prompt, so a
    // directive this manager appended armed a gate the planner never asked
    // for and spent a spurious bounce first. The gate now reads the planner's
    // recorded demand (audited 2026-09-04), so one completion is one bounce.
    const beforeBounce = tasks.submitted.length;
    tasks.emit("task:completed", `task_${beforeBounce}`, "shipping it after revive");
    await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(beforeBounce));
    expect(storage.get(campaign.id)!.state).toBe("executing");
    expect(storage.get(campaign.id)!.milestones[2]!.deliveryVerificationBounced).toBe(true);
  });

  it("a provider outage during PLANNING parks with self-revival and replans when the chain recovers", async () => {
    // Audited 2026-09-02: planAndLaunch's catch set state=failed with no
    // autoReviveAt, so a quota wall hit before the ladder existed was dead
    // until a human typed "kampanya devam" — the planner's own contract
    // comment promised the caller would park with a self-revival appointment.
    const { ProviderHealthRegistry } = await import("../agents/providers/provider-health.js");
    const { setLiveChainMemberNames } = await import("../agents/providers/provider-outage.js");
    const registry = ProviderHealthRegistry.getInstance();
    registry.clearProviderState("claude");
    registry.recordOverloaded("claude", "quota wall");
    setLiveChainMemberNames(["claude"]);

    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-plan-outage.db"));
    const planner = {
      planMilestones: vi
        .fn()
        .mockRejectedValueOnce(new Error("All providers are in cooldown (quota exhausted)"))
        .mockResolvedValue(LADDER),
    } as unknown as CampaignPlanner;
    manager = new CampaignManager({
      storage,
      planner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => messages.push({ chatId, text }),
      projectRoot,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    manager.attachEvents();

    try {
      const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));
      const parked = storage.get(campaign.id)!;
      expect(parked.autoReviveAt).toBeGreaterThan(Date.now());
      expect(storage.listAwaitingAutoRevive().map((c) => c.id)).toContain(campaign.id);
      expect(messages.at(-1)!.text).toContain("Self-revival armed");
      expect(tasks.submitted).toHaveLength(0);

      // The chain recovers; the appointment fires and must REPLAN (no ladder
      // exists yet), then start sprint 1.
      registry.clearProviderState("claude");
      (manager as unknown as { scheduleAutoRevive(id: string, ms: number): void })
        .scheduleAutoRevive(campaign.id, 20);
      await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("executing"));
      expect(tasks.submitted).toHaveLength(1);
      expect(storage.get(campaign.id)!.autoReviveAt).toBeUndefined();
    } finally {
      setLiveChainMemberNames([]);
      registry.clearProviderState("claude");
    }
  });

  it("a transiently blocked GDD draft is ADOPTED from the executor's retry, not redrafted and charged", async () => {
    // Audited 2026-09-02: onDraftSettled reacted to a keep-alive block
    // instantly — draftAttempts += 1 and a second draft task with no lineage,
    // while the executor's own retry ran untracked. Four blips failed the
    // campaign before a real draft was attempted; each blip also spent one
    // of the designer's revision rounds (same counter).
    const campaign = manager.startFromIdea(ctx, "a match-3 where pigs fly");
    expect(tasks.submitted).toHaveLength(1);

    const retryId = tasks.addRetry("task_1");
    tasks.emit("task:blocked", "task_1", "Transient failure — provider hiccup. Auto-retry 1/10 in ~30s.");

    await waitFor(() => expect(storage.get(campaign.id)!.draftTaskId).toBe(retryId));
    expect(tasks.submitted).toHaveLength(1); // no second drafter
    expect(storage.get(campaign.id)!.draftAttempts).toBe(0); // no revision round spent

    // The adopted retry lands the GDD → the approval gate opens normally.
    tasks.emit("task:completed", retryId, "wrote docs/Game_GDD.md");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("awaiting-approval"));
  });

  it("an outage-caused draft settle PARKS with self-revival instead of redrafting into the wall", async () => {
    // Audited 2026-09-02: the draft path answered a measured full outage by
    // resubmitting the draft uncharged — a fresh LLM task every ~11 minutes
    // (the deferral re-check horizon) into a chain where no member is
    // available, with no park and no self-revival appointment. The milestone
    // and planning paths both park; this one looped. Parking still charges no
    // revision round — the outage is not the draft's failure.
    const { ProviderHealthRegistry } = await import("../agents/providers/provider-health.js");
    const { setLiveChainMemberNames } = await import("../agents/providers/provider-outage.js");
    const registry = ProviderHealthRegistry.getInstance();
    registry.clearProviderState("cm-draft");
    registry.recordOverloaded("cm-draft", "quota wall");
    setLiveChainMemberNames(["cm-draft"]);
    try {
      const campaign = manager.startFromIdea(ctx, "a match-3 where pigs fly");
      // Dead retry promise (tip idle past its horizon) so the settle is judged.
      tasks.updatedAts.set("task_1", Date.now() - 30 * 60_000);
      tasks.emit("task:failed", "task_1", "Task execution failed: All providers are in cooldown. Auto-retry 1/10 in ~30s.");
      await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));

      const parked = storage.get(campaign.id)!;
      expect(tasks.submitted).toHaveLength(1); // no redraft into the cooling chain
      expect(parked.draftAttempts).toBe(0); // outage charges no revision round
      expect(parked.autoReviveAt).toBeGreaterThan(Date.now());
      expect(messages.at(-1)!.text).toContain("Self-revival armed");
    } finally {
      setLiveChainMemberNames([]);
      registry.clearProviderState("cm-draft");
    }
  });

  it("draft deferral is time-bounded: a tip that keeps promising a retry cannot defer forever", async () => {
    // Audited 2026-09-02: reconcileMilestoneAfterSettle bounds its deferral at
    // 24h (reconcileDeferredSince); the draft counterpart had no clock at all,
    // so a lineage tip whose updatedAt kept refreshing (the promise never
    // reads dead) re-deferred every horizon forever — no draft, no failure,
    // no message, and the one-campaign-per-project slot held.
    const campaign = manager.startFromIdea(ctx, "a match-3 where pigs fly");
    expect(tasks.submitted).toHaveLength(1);

    // A live promise: the tip was touched just now, so it is not dead.
    tasks.updatedAts.set("task_1", Date.now());
    tasks.emit("task:blocked", "task_1", "Reaped: no progress for 15m. Auto-retry 1/10 in ~600s.");
    await waitFor(() => expect(storage.get(campaign.id)!.draftDeferredSince).toBeGreaterThan(0));
    expect(tasks.submitted).toHaveLength(1); // deferred, nothing redrafted

    // 25 hours of exactly this — the tip still promises a retry that never lands.
    const deferring = storage.get(campaign.id)!;
    deferring.draftDeferredSince = Date.now() - 25 * 60 * 60_000;
    storage.save(deferring);
    tasks.updatedAts.set("task_1", Date.now());
    tasks.emit("task:blocked", "task_1", "Reaped: no progress for 15m. Auto-retry 1/10 in ~600s.");

    // Past the bound the outcome is judged: the round is charged (no outage
    // measured here) and a fresh draft is issued with the cause named.
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    const judged = storage.get(campaign.id)!;
    expect(judged.draftAttempts).toBe(1);
    expect(judged.draftDeferredSince).toBeUndefined();
    expect(tasks.submitted[1]!.prompt).toContain("The previous draft attempt");
  });

  it("a GDD draft that completed while the process was down is judged on restart, not redrafted", async () => {
    // Audited 2026-09-02: resumeOne's "landed while we were down" branch was
    // gated on state === "executing", so a drafting-gdd campaign whose draft
    // had completed fell through to submitDraft — a whole new LLM draft, no
    // revision note, no attempt charged, and the approval gate never opened.
    const campaign = manager.startFromIdea(ctx, "a match-3 where pigs fly");
    expect(tasks.submitted).toHaveLength(1);
    // The draft completed, but its settlement event died with the process.
    tasks.markTerminal("task_1", TaskStatus.completed, "wrote docs/Game_GDD.md");

    await manager.resumeActive();
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("awaiting-approval"));
    expect(tasks.submitted).toHaveLength(1); // no redraft
    expect(storage.get(campaign.id)!.gddPath).toBe("docs/Game_GDD.md");
    expect(messages.at(-1)!.text).toContain("GDD drafted");
  });

  it("finds a GDD the draft wrote in a docs/ subfolder instead of redrafting", async () => {
    // Audited 2026-09-02: findNewestGddPath was a flat readdirSync(docs), so
    // docs/design/Ashen_GDD.md was invisible and the campaign redrafted.
    rmSync(join(projectRoot, "docs", "Game_GDD.md"));
    mkdirSync(join(projectRoot, "docs", "design"), { recursive: true });
    writeFileSync(join(projectRoot, "docs", "design", "Ashen_GDD.md"), "# Ashen GDD\n\nElement schedule: ...");
    const campaign = manager.startFromIdea(ctx, "a roguelike about ash");

    tasks.emit("task:completed", "task_1", "wrote docs/design/Ashen_GDD.md");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("awaiting-approval"));
    expect(storage.get(campaign.id)!.gddPath).toBe("docs/design/Ashen_GDD.md");
    expect(tasks.submitted).toHaveLength(1);
  });

  it("a draft that keeps completing without a discoverable GDD is bounded by the draft budget", async () => {
    // Audited 2026-09-02: the no-file branch called submitDraft without ever
    // touching draftAttempts — full LLM draft tasks forever, no message, no
    // failure, the one-campaign-per-project slot wedged with no revive path.
    rmSync(join(projectRoot, "docs", "Game_GDD.md"));
    const campaign = manager.startFromIdea(ctx, "a puzzle game about nothing");

    for (let n = 1; n <= 3; n++) {
      tasks.emit("task:completed", `task_${n}`, "I described the GDD in chat");
      await waitFor(() => expect(tasks.submitted).toHaveLength(n + 1));
      expect(storage.get(campaign.id)!.draftAttempts).toBe(n);
      expect(tasks.submitted[n]!.prompt).toContain("never wrote the GDD file");
    }
    // The fourth landing without a file exhausts the budget: stop loudly.
    tasks.emit("task:completed", "task_4", "I described the GDD in chat");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));
    expect(tasks.submitted).toHaveLength(4);
    expect(storage.get(campaign.id)!.lastError).toMatch(/no \*GDD\*\.md was found under docs\/ \(searched recursively\)/);
    expect(messages.at(-1)!.text).toContain("kampanya devam");
  });

  it("a fresh attempt starts with a fresh deferral clock: a stale reconcileDeferredSince cannot charge its first reap", async () => {
    // Audited 2026-09-02: reconcileDeferredSince was cleared only on the
    // judge path (line ~894); revive, bounces, escalations and restarts all
    // began a new attempt with the old clock. Past 24h the deferral was
    // skipped and an ordinary keep-alive reap — whose text promises the
    // executor's own retry — was charged as a failed attempt and resubmitted.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    tasks.emit("task:failed", "task_1", "boom");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    await failUntilStopped(campaign.id, "boom again");

    // The parked milestone carries a deferral clock from a long-ago wall.
    const parked = storage.get(campaign.id)!;
    parked.milestones[0]!.reconcileDeferredSince = Date.now() - 25 * 60 * 60_000;
    storage.save(parked);

    const beforeRevive = tasks.submitted.length;
    expect(await manager.tryHandleRevive("cli-local", "kampanya devam")).toBe(true);
    await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(beforeRevive));
    expect(storage.get(campaign.id)!.milestones[0]!.attempts).toBe(1);

    // The revived attempt's very first reap: the executor promises a retry.
    tasks.emit("task:blocked", `task_${tasks.submitted.length - 1}`, "Reaped: no progress for 15m. Auto-retry 2/10 in ~600s.");
    await new Promise((r) => setTimeout(r, 250));

    const fresh = storage.get(campaign.id)!;
    expect(tasks.submitted.length).toBe(beforeRevive + 1); // deferred, not resubmitted
    expect(fresh.state).toBe("executing");
    expect(fresh.milestones[0]!.attempts).toBe(1); // not charged
    // The clock was reset by the fresh attempt and the reap deferred against
    // it, so it is either freshly stamped or cleanly absent — never the
    // 25-hour-old value the revived attempt inherited.
    expect(fresh.milestones[0]!.reconcileDeferredSince ?? Date.now()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("a double-tapped approval plans ONE ladder and starts ONE sprint", async () => {
    // Audited 2026-09-02: tryHandleApproval awaited the channel round-trip
    // before any state write, so two concurrent "evet" (double-tap, redelivery,
    // fire-and-forget web/Discord dispatch) both found the campaign
    // awaiting-approval: two billable planning passes, the second overwrote
    // the ladder, and two sprint-1 tasks were submitted (one orphaned).
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-approve.db"));
    const planMilestones = vi.fn().mockResolvedValue(LADDER);
    manager = new CampaignManager({
      storage,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      planner: { planMilestones } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => {
        messages.push({ chatId, text });
        await new Promise((r) => setTimeout(r, 5)); // a real channel round-trip
      },
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    manager.attachEvents();

    const campaign = manager.startFromIdea(ctx, "a match-3 where pigs fly");
    tasks.emit("task:completed", "task_1", "wrote docs/Game_GDD.md");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("awaiting-approval"));

    const consumed = await Promise.all([
      manager.tryHandleApproval("cli-local", "evet"),
      manager.tryHandleApproval("cli-local", "evet"),
    ]);
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("executing"));
    await new Promise((r) => setTimeout(r, 60));

    expect(consumed.filter(Boolean)).toHaveLength(1);
    expect(planMilestones).toHaveBeenCalledTimes(1);
    expect(tasks.submitted).toHaveLength(2); // the draft + exactly one sprint 1
    expect(messages.filter((m) => m.text.includes("Milestone ladder ready"))).toHaveLength(1);
  });

  it("two concurrent REVISION replies draft once (Codex 2026-09-12 X)", async () => {
    // The approval branch claims the gate before its announcement; the
    // revision branch still announced first, and that announcement is a real
    // await with no per-chat serialization — so two replies both found the
    // campaign awaiting approval, both submitted a draft, and only one was
    // counted or owned (Codex measured: drafts 2, draftAttempts 1).
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-revise.db"));
    manager = new CampaignManager({
      storage,
      planner: { planMilestones: vi.fn().mockResolvedValue(LADDER) } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => {
        messages.push({ chatId, text });
        await new Promise((r) => setTimeout(r, 5)); // a real channel round-trip
      },
      projectRoot, retryAdoptionGraceMs: 10, completedSettleDelayMs: 0, milestoneTimeBoxMs: 60 * 60_000,
    });
    manager.attachEvents();

    const campaign = manager.startFromIdea(ctx, "a match-3 where pigs fly");
    tasks.emit("task:completed", "task_1", "wrote docs/Game_GDD.md");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("awaiting-approval"), { timeout: 15_000 });
    const before = tasks.submitted.length;

    const consumed = await Promise.all([
      manager.tryHandleApproval("cli-local", "daha fazla bölüm ekle"),
      manager.tryHandleApproval("cli-local", "ve bir boss ekle"),
    ]);

    // One reply is handled, one draft is submitted, and the campaign owns it.
    expect(consumed.filter(Boolean)).toHaveLength(1);
    expect(tasks.submitted.length - before).toBe(1);
    const after = storage.get(campaign.id)!;
    expect(after.draftAttempts).toBe(1);
    expect(after.draftTaskId).toBe(`task_${tasks.submitted.length}`);
    expect(after.state).toBe("drafting-gdd");
  });

  it("re-sharing a revised GDD under the same filename rewrites docs/ so sprints build the new design", async () => {
    // Audited 2026-09-02: persistSuppliedGdd was "idempotent per name" — an
    // existence check only — so GDD.docx v2 left docs/GDD.md holding v1 while
    // the ladder was planned from v2 and every sprint prompt pointed agents at
    // the v1 file. The whole build ran against the superseded design.
    const v1 = "# GDD v1\n" + "core loop: match three tiles and clear the board. ".repeat(8);
    const v2 = "# GDD v2 REVISED\n" + "core loop: match FOUR tiles; a dragon boss guards level 5. ".repeat(8);
    const share = (text: string): IncomingMessage =>
      ({
        channelType: "cli",
        chatId: "cli-local",
        userId: "u1",
        text: "",
        attachments: [{ type: "document", name: "GDD.md", data: Buffer.from(text, "utf8") }],
        timestamp: new Date(),
      }) as unknown as IncomingMessage;

    expect(await manager.tryHandleIncoming(share(v1))).toBe(true);
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    expect(readFileSync(join(projectRoot, "docs", "GDD.md"), "utf8")).toBe(v1);

    // The first build ends; the designer revises the document and re-shares it.
    const first = storage.listActive()[0]!;
    first.state = "cancelled";
    storage.save(first);

    expect(await manager.tryHandleIncoming(share(v2))).toBe(true);
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(readFileSync(join(projectRoot, "docs", "GDD.md"), "utf8")).toBe(v2);
    expect(storage.listActive()[0]!.gddPath).toBe("docs/GDD.md");
  });

  it("the failure tail is REPLACED across revives — exactly one tail, the latest", async () => {
    // Audited 2026-09-02: the strip regex ended on "do not repeat it." but the
    // appended tail continues "do not repeat it — and do NOT spend…", so the
    // strip never matched and every revived budget stacked another stale
    // "The previous attempt ended…" block into the persisted sprint prompt.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    tasks.emit("task:failed", "task_1", "compile exploded in Board.cs");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    await failUntilStopped(campaign.id, "compile exploded in Board.cs again");

    const beforeRevive = tasks.submitted.length;
    expect(await manager.tryHandleRevive("cli-local", "kampanya devam")).toBe(true);
    await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(beforeRevive));
    const beforeRed = tasks.submitted.length;
    tasks.emit("task:failed", `task_${beforeRed}`, "PlayMode red: 3 of 9 tests failed");
    await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(beforeRed));

    const prompt = storage.get(campaign.id)!.milestones[0]!.prompt;
    expect(prompt.match(/The previous attempt ended/g) ?? []).toHaveLength(1);
    // …and the self-revival's own tail is kept to one copy too (F#1).
    expect(prompt.match(/A ROUND OF ATTEMPTS ENDED/g) ?? []).toHaveLength(1);
    expect(prompt).toContain("PlayMode red: 3 of 9 tests failed");
    // The ATTEMPT tail is the latest failure only; the earlier cause survives
    // exactly once, in the revival tail that exists to prevent a repeat.
    const attemptTail = prompt.slice(prompt.indexOf("The previous attempt ended"));
    expect(attemptTail).not.toContain("compile exploded");
    expect(prompt).toContain("build the foundations"); // the sprint body survives the strip
  });

  it("every gap the audit NAMED gets a sprint, past the round budget (Codex 2026-09-11 F#9)", async () => {
    // Nine gaps, four per round, two audit rounds: the ninth used to be
    // narrated into a note and the campaign delivered `done` with a
    // requirement it had itself identified as missing.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-gap-queue.db"));
    const gaps = Array.from({ length: 9 }, (_, i) => `Mechanic ${i + 1}: no milestone implemented it`);
    const planner = {
      planMilestones: vi.fn().mockResolvedValue(LADDER),
      auditCoverage: vi.fn().mockResolvedValueOnce(gaps).mockResolvedValue([]),
    } as unknown as CampaignPlanner;
    manager = new CampaignManager({
      storage,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      planner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => { messages.push({ chatId, text }); },
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
      implementationReviveDelayMs: 10,
    });
    manager.attachEvents();

    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    settleMilestone("final report");
    await waitFor(() => expect(tasks.submitted).toHaveLength(4), { timeout: 15_000 });

    // Round 1 schedules four and QUEUES five.
    expect(storage.get(campaign.id)!.pendingCoverageGaps).toHaveLength(5);

    // Drive every scheduled gap sprint to completion; the queue must empty.
    for (let i = 0; i < 20 && storage.get(campaign.id)!.state === "executing"; i++) {
      const before = tasks.submitted.length;
      settleMilestone(`gap ${i} implemented, all 42 tests pass`);
      await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(before), { timeout: 15_000 }).catch(() => undefined);
      if (tasks.submitted.length === before) break;
    }
    const finished = storage.get(campaign.id)!;
    expect(finished.pendingCoverageGaps ?? []).toHaveLength(0);
    // One sprint per named gap, all nine of them.
    const gapSprints = finished.milestones.filter((m) => m.id.startsWith("mcov"));
    expect(gapSprints).toHaveLength(9);
    for (let i = 1; i <= 9; i++) {
      expect(gapSprints.some((m) => m.title.includes(`Mechanic ${i}:`))).toBe(true);
    }
  });

  it("a clean coverage verdict from a WINDOWED audit is caveated, not reported as audited clean", async () => {
    // Audited 2026-09-02: past the audit threshold the GDD is windowed for
    // the audit too, and an empty `missing` cleared coverageAuditNote as
    // "genuinely audited clean" — a verdict that never named its scope.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-windowed-audit.db"));
    const planner = {
      planMilestones: vi.fn().mockResolvedValue(LADDER),
      auditCoverage: vi.fn().mockResolvedValue([]),
      // A requirement no sprint closed is OPEN until evidence says otherwise:
      // the audit's default answer is the conservative one (Codex U).
      resolveCoverageGaps: vi.fn(async (_gdd: string, reqs: readonly string[]) => ({ closed: [], open: [...reqs] })),
    } as unknown as CampaignPlanner;
    manager = new CampaignManager({
      storage,
      planner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => messages.push({ chatId, text }),
      projectRoot,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    manager.attachEvents();

    const hugeGdd = "# GDD\n" + "core loop line\n".repeat(Math.ceil(GDD_AUDIT_FULL_CHARS / 15) + 100);
    expect(hugeGdd.length).toBeGreaterThan(GDD_AUDIT_FULL_CHARS);
    const campaign = manager.startFromGdd(ctx, hugeGdd, "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    settleMilestone("final report");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"));

    expect(storage.get(campaign.id)!.coverageAuditNote).toMatch(/WINDOWED GDD/);
    expect(messages.at(-1)!.text).toContain("WINDOWED GDD");
  });

  it("a green whose visual gate never ran SAYS so in the delivery report", async () => {
    // Audited 2026-09-02: the visual-evidence gate runs only when the
    // planner-authored prompt happens to contain "captur"; nothing validated
    // that it did, and the report had no mark for it — a sprint whose gate
    // never ran rendered byte-identically to one that passed it.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done"); // LADDER prompts never demand a capture; no Recordings/
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));
    settleMilestone("final report");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"));

    const done = storage.get(campaign.id)!;
    expect(done.milestones.map((m) => m.visualEvidence)).toEqual([
      "none-gate-not-demanded",
      "none-gate-not-demanded",
      "none-gate-not-demanded",
    ]);
    const report = messages.at(-1)!.text;
    expect(report).toMatch(/Sprint A — Foundations — .*visual gate NOT run/);
    expect(report).toMatch(/Sprint A — Foundations: no fresh captured frame .*never demanded a capture/);
  });

  it("a delivery report lost in the crash window is re-sent on the next boot, once", async () => {
    // Audited 2026-09-02: state=done was persisted BEFORE the report was sent,
    // and tell() swallows a messenger failure — so a crash or an outbound
    // failure in that window lost the report permanently: a done campaign is
    // not active, not revivable and not queryable, and the finished game was
    // never announced.
    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await waitFor(() => expect(tasks.submitted).toHaveLength(3));

    messengerDownFor = /Campaign delivery/;
    settleMilestone("final sprint done, all tests green");
    await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"));
    expect(messages.some((m) => m.text.includes("Campaign delivery"))).toBe(false);
    expect(storage.get(campaign.id)!.deliveryReported).toBe(false);

    // Next boot: the messenger is back and the unreported delivery is re-sent.
    messengerDownFor = undefined;
    await manager.resumeActive();
    await waitFor(() =>
      expect(messages.filter((m) => m.text.includes("Campaign delivery"))).toHaveLength(1),
    );
    expect(storage.get(campaign.id)!.deliveryReported).toBe(true);

    // And only once — a later boot must not re-announce a delivered game.
    await manager.resumeActive();
    expect(messages.filter((m) => m.text.includes("Campaign delivery"))).toHaveLength(1);
  });

  it("a boot that finds a FAILED tip past its time box escalates instead of silently resubmitting", async () => {
    // Audited 2026-09-02: resumeOne judged only a `completed` tip. A failed or
    // blocked tip fell through to submitCurrentMilestone({countAttempt:false}),
    // which never consults the time box — so across repeated restarts a sprint
    // was relaunched forever with attempts frozen and no escalation.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));

    // The sprint died with the process after running well past its 1h box.
    const running = storage.get(campaign.id)!;
    running.milestones[0]!.startedAtMs = Date.now() - 2 * 60 * 60_000;
    storage.save(running);
    tasks.markTerminal("task_1", TaskStatus.failed, "worker died: compile error CS0246");

    await manager.resumeActive();
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));

    const after = storage.get(campaign.id)!;
    expect(after.milestones[0]!.timeBoxEscalations).toBe(1);
    expect(after.milestones[0]!.prompt).toContain("NARROW THE SCOPE NOW");
    expect(messages.at(-1)!.text).toContain("narrowing scope");
  });

  it("a boot that finds a FAILED tip charges the attempt, and a spent budget stops the campaign", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));
    expect(storage.get(campaign.id)!.milestones[0]!.attempts).toBe(1);

    tasks.markTerminal("task_1", TaskStatus.failed, "compile error CS0246");
    await manager.resumeActive();
    await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(storage.get(campaign.id)!.milestones[0]!.attempts).toBe(2); // charged
    expect(tasks.submitted[1]!.prompt).toContain("The previous attempt ended failed");

    // A second restart on a second dead tip: the budget is spent, so the
    // campaign stops loudly instead of relaunching the sprint again.
    tasks.markTerminal("task_2", TaskStatus.failed, "compile error CS0246 again");
    await manager.resumeActive();
    // The spent budget self-revives with a changed approach first (Codex
    // 2026-09-11 F#1) and stops only once those are spent too.
    await waitFor(() => expect(messages.some((m) => m.text.includes("Retrying with a changed approach"))).toBe(true));
    await failUntilStopped(campaign.id, "compile error CS0246 again");
    expect(storage.get(campaign.id)!.state).toBe("failed");
    expect(messages.at(-1)!.text).toContain("Campaign stopped");
  });

  it("a boot during a provider outage parks the dead tip WITHOUT charging an attempt, and recovery resubmits", async () => {
    const { ProviderHealthRegistry } = await import("../agents/providers/provider-health.js");
    const { setLiveChainMemberNames } = await import("../agents/providers/provider-outage.js");
    const registry = ProviderHealthRegistry.getInstance();
    registry.clearProviderState("cm-boot");
    setLiveChainMemberNames(["cm-boot"]);
    try {
      const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      await waitFor(() => expect(tasks.submitted).toHaveLength(1));
      registry.recordOverloaded("cm-boot", "quota wall");
      tasks.markTerminal("task_1", TaskStatus.failed, "All providers are in cooldown");

      await manager.resumeActive();
      // Measured 2026-09-08 01:08: the boot resubmitted straight into the
      // wall. Now it parks with a revival appointment and charges nothing.
      await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));
      expect(tasks.submitted).toHaveLength(1);
      expect(storage.get(campaign.id)!.autoReviveAt).toBeGreaterThan(Date.now());
      expect(storage.get(campaign.id)!.milestones[0]!.attempts).toBe(1); // not charged
      registry.clearProviderState("cm-boot");
      (manager as unknown as { scheduleAutoRevive(id: string, ms: number): void }).scheduleAutoRevive(campaign.id, 20);
      await waitFor(() => expect(tasks.submitted).toHaveLength(2));
    } finally {
      setLiveChainMemberNames([]);
      registry.clearProviderState("cm-boot");
    }
  });

  it("a restart while state='planning' resumes the persisted ladder instead of replanning", async () => {
    // Audited 2026-09-02: planAndLaunch persists the ladder and only then
    // awaits the messenger round-trip that announces it; state flips to
    // executing after that. A restart inside that window found state=planning
    // with a complete ladder already in storage and threw it away — a second
    // billable planning pass, and a ladder that can differ from the one the
    // designer was shown.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-planning.db"));
    const planMilestones = vi.fn().mockResolvedValue(LADDER);
    manager = new CampaignManager({
      storage,
      planner: { planMilestones } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => messages.push({ chatId, text }),
      projectRoot,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    manager.attachEvents();

    const now = Date.now();
    storage.save({
      id: "campaign_planning_1",
      chatId: "cli-local",
      channelType: "cli",
      userId: "u1",
      projectRoot,
      state: "planning",
      gddPath: "docs/Game_GDD.md",
      draftAttempts: 0,
      milestones: LADDER.milestones.map((m, i) => ({
        id: `m${i + 1}`,
        title: m.title,
        prompt: m.prompt,
        status: "pending" as const,
        attempts: 0,
      })),
      currentMilestone: 0,
      createdAt: now,
      updatedAt: now,
    });

    await manager.resumeActive();
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));

    expect(planMilestones).not.toHaveBeenCalled();
    expect(tasks.submitted[0]!.prompt).toContain("foundations");
    const fresh = storage.get("campaign_planning_1")!;
    expect(fresh.state).toBe("executing");
    expect(fresh.milestones).toHaveLength(3);
    expect(fresh.milestones[0]!.attempts).toBe(1);
  });

  it("an idea-mode restart before the draft was submitted re-drafts, never plans from another game's GDD", async () => {
    // Audited 2026-09-02: newCampaign persists state="planning" and submitDraft
    // flips it to drafting-gdd, so a restart in that window resumed into
    // planAndLaunch — which picks the NEWEST docs/*GDD*.md by mtime. On a repo
    // that already holds another game's GDD (docs/Game_GDD.md here), the whole
    // ladder would be planned for the wrong game and the idea silently lost.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-idea.db"));
    const planMilestones = vi.fn().mockResolvedValue(LADDER);
    manager = new CampaignManager({
      storage,
      planner: { planMilestones } as unknown as CampaignPlanner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => messages.push({ chatId, text }),
      projectRoot,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    manager.attachEvents();

    const now = Date.now();
    storage.save({
      id: "campaign_idea_1",
      chatId: "cli-local",
      channelType: "cli",
      userId: "u1",
      projectRoot,
      state: "planning",
      ideaText: "a match-3 where pigs fly",
      draftAttempts: 0,
      milestones: [],
      currentMilestone: 0,
      createdAt: now,
      updatedAt: now,
    });

    await manager.resumeActive();
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));

    expect(planMilestones).not.toHaveBeenCalled();
    expect(tasks.submitted[0]!.prompt).toContain("a match-3 where pigs fly");
    const fresh = storage.get("campaign_idea_1")!;
    expect(fresh.state).toBe("drafting-gdd");
    expect(fresh.gddPath).toBeUndefined(); // the other game's GDD was not adopted
  });

  it("a draft parked by an outage self-revives by re-drafting, not by planning from an unrelated GDD", async () => {
    const { ProviderHealthRegistry } = await import("../agents/providers/provider-health.js");
    const { setLiveChainMemberNames } = await import("../agents/providers/provider-outage.js");
    const registry = ProviderHealthRegistry.getInstance();
    registry.clearProviderState("cm-revive-draft");
    registry.recordOverloaded("cm-revive-draft", "quota wall");
    setLiveChainMemberNames(["cm-revive-draft"]);
    try {
      const campaign = manager.startFromIdea(ctx, "a roguelike about ash");
      tasks.updatedAts.set("task_1", Date.now() - 30 * 60_000);
      tasks.emit("task:failed", "task_1", "Task execution failed: All providers are in cooldown.");
      await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));

      registry.clearProviderState("cm-revive-draft");
      (manager as unknown as { scheduleAutoRevive(id: string, ms: number): void })
        .scheduleAutoRevive(campaign.id, 20);

      await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("drafting-gdd"));
      expect(tasks.submitted).toHaveLength(2);
      expect(tasks.submitted[1]!.prompt).toContain("a roguelike about ash");
      const revived = storage.get(campaign.id)!;
      expect(revived.gddPath).toBeUndefined(); // docs/Game_GDD.md belongs to another game
      expect(revived.autoReviveAt).toBeUndefined();
      expect(revived.draftAttempts).toBe(0); // the outage still charges no round
    } finally {
      setLiveChainMemberNames([]);
      registry.clearProviderState("cm-revive-draft");
    }
  });

  it("resumeActive leaves a still-running task alone", async () => {
    manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await waitFor(() => expect(tasks.submitted).toHaveLength(1));

    await manager.resumeActive(); // task_1 still 'executing' in the fake
    expect(tasks.submitted).toHaveLength(1);
  });

  describe("defects the gate review found (2026-09-07)", () => {
    it("a structural bounce followed by a tree that passes DELIVERS, and the headline follows the newest measurement", async () => {
      writeSlopProject();
      const campaign = await runLadderToDelivery();
      settleMilestone("integrated, all 42 tests pass");
      await waitFor(() => expect(tasks.submitted).toHaveLength(4));
      expect(storage.get(campaign.id)!.milestones[2]!.structureRefused).toBe(true);
      // The sprint places the prefab; the flag must follow the re-measure.
      writeBuiltProject();
      settleMilestone("prefabs placed, all 42 tests pass");
      await waitFor(() => expect(storage.get(campaign.id)!.state).not.toBe("executing"));
      expect(storage.get(campaign.id)!.state).toBe("done");
      expect(storage.get(campaign.id)!.milestones[2]!.structureRefused).toBe(false);
      const report = messages.map((m) => m.text).find((t) => t.includes("Campaign delivery"))!;
      expect(report.split("\n")[0]).not.toContain("NOT DELIVERED");
    });

    it("a terminal failure that merely MENTIONS a provider on a healthy chain stops — no self-revival", async () => {
      const { setLiveChainMemberNames } = await import("../agents/providers/provider-outage.js");
      const { ProviderHealthRegistry } = await import("../agents/providers/provider-health.js");
      ProviderHealthRegistry.getInstance().clearProviderState("claude");
      setLiveChainMemberNames(["claude"]);
      const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      await waitFor(() => expect(tasks.submitted).toHaveLength(1));
      tasks.emit("task:failed", "task_1", "sprite provider 'local' returned PLACEHOLDER");
      await waitFor(() => expect(tasks.submitted).toHaveLength(2));
      // It self-revives with a CHANGED APPROACH, a bounded number of times
      // (Codex 2026-09-11 F#1) — never as an outage pause, which would hand it
      // a fresh attempt budget every cycle forever (the 2026-09-07 defect).
      await failUntilStopped(campaign.id, "sprite provider 'local' returned PLACEHOLDER");
      expect(storage.get(campaign.id)!.autoReviveAt).toBeUndefined();
      expect(messages.at(-1)!.text).toContain("Campaign stopped");
      expect(messages.some((m) => m.text.includes("Self-revival armed"))).toBe(false);
      expect(messages.some((m) => m.text.includes("paused by a provider outage"))).toBe(false);
      // Bounded: exactly the revive budget, not a round per failure forever.
      expect(storage.get(campaign.id)!.implementationRevives).toBe(2);
    });

    it("a tree that still does not compile after the delivery bounces is NOT delivered", async () => {
      writeBuiltProject();
      const campaign = await runLadderToDelivery();
      compileVerdict = { ok: false, ran: true, errors: 37, detail: "37 error(s)" };
      for (let i = 0; i < 4 && storage.get(campaign.id)!.state === "executing"; i++) {
        const before = tasks.submitted.length;
        settleMilestone(`shipping it (round ${i})`);
        await new Promise((r) => setTimeout(r, 150));
        if (tasks.submitted.length === before) break;
      }
      await waitFor(() => expect(storage.get(campaign.id)!.state).not.toBe("executing"));
      expect(storage.get(campaign.id)!.state).toBe("failed");
      expect(storage.get(campaign.id)!.lastError).toContain("does not compile");
      const report = messages.map((m) => m.text).find((t) => t.includes("NOT DELIVERED"))!;
      expect(report.split("\n")[0]).toContain("does not compile");
      expect(report.split("\n")[0]).toContain("37 error(s)");
    });

    it("the second delivery bounce carries the CURRENT reason, not the first one", async () => {
      writeBuiltProject();
      const campaign = await runLadderToDelivery();
      // Bounce 1: no verdict at all (compiles) — the sprint ran no suite.
      runRecordOnSettle = undefined;
      // Sprint B's record is still on disk, written milliseconds before this
      // sprint began: inside the file-clock allowance, where it would pass as
      // this sprint's. A real previous sprint's record is minutes old; say so.
      const sprintBRecord = join(projectRoot, "Recordings", "tests", "playmode-last.json");
      const sprintBTime = new Date(Date.now() - 60_000);
      if (existsSync(sprintBRecord)) utimesSync(sprintBRecord, sprintBTime, sprintBTime);
      tasks.emit("task:completed", "task_3", "done, trust me");
      await waitFor(() => expect(tasks.submitted).toHaveLength(4));
      expect(tasks.submitted[3]!.prompt).toContain("no test run was observed");
      expect(tasks.submitted[3]!.prompt).not.toContain("DOES NOT COMPILE");
      // Bounce 2: an unfiltered green, but the compile is now broken.
      runRecordOnSettle = { total: 42, passed: 42, failed: 0, skipped: 0, unfiltered: true };
      compileVerdict = { ok: false, ran: true, errors: 3 };
      settleMilestone("suite green");
      await waitFor(() => expect(tasks.submitted).toHaveLength(5));
      const prompt = tasks.submitted[4]!.prompt;
      expect(prompt).toContain("THE PROJECT DOES NOT COMPILE");
      expect(prompt).not.toContain("no test run was observed");
      expect(prompt.split("DELIVERY VERIFICATION REQUIRED").length).toBe(2);
      expect(storage.get(campaign.id)!.state).toBe("executing");
    });

    it("an AUDIO remediation sprint is not judged by the sprite count", async () => {
      tasks = new FakeTaskManager();
      storage.close();
      storage = new CampaignStorage(join(dir, "campaigns-audio-gap.db"));
      const planner = {
        planMilestones: vi.fn().mockResolvedValue(LADDER),
        auditCoverage: vi.fn().mockResolvedValueOnce(["Audio production: no SFX cue list implemented"]).mockResolvedValue([]),
      } as unknown as CampaignPlanner;
      manager = new CampaignManager({
        storage, planner, taskManager: tasks as unknown as TaskManager,
      runPlaymodeSuite: suiteRunner,
      verifyCompile: async () => compileVerdict,
      buildPlayer: async (_root: string, target?: string) => { buildTargetsAsked.push(target); return buildVerdict; },
      runPlayer: async (root, artifact) => { playerRuns.push(artifact); if (playerVerdictOnRun) writePlayerVerdict(playerVerdictOnRun.ok, playerVerdictOnRun.extra, root); afterPlayerRun?.(); },
        messenger: async (chatId, text) => { messages.push({ chatId, text }); },
        projectRoot, retryAdoptionGraceMs: 10, completedSettleDelayMs: 0, milestoneTimeBoxMs: 60 * 60_000,
      });
      (manager as unknown as { measurePlaceholderArt: () => { sprites: number; placeholders: number } })
        .measurePlaceholderArt = () => ({ sprites: 100, placeholders: 95 });
      manager.attachEvents();
      const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
      await waitFor(() => expect(tasks.submitted).toHaveLength(1), { timeout: 15_000 });
      settleMilestone("sprint A done");
      await waitFor(() => expect(tasks.submitted).toHaveLength(2), { timeout: 15_000 });
      settleMilestone("sprint B done");
      await waitFor(() => expect(tasks.submitted).toHaveLength(3), { timeout: 15_000 });
      settleMilestone("final report");
      await waitFor(() => expect(tasks.submitted).toHaveLength(4)); // mcov1 (audio)
      const mcov1 = () => storage.get(campaign.id)!.milestones.find((m) => m.id === "mcov1")!;
      for (let i = 0; i < 4 && mcov1().status === "running"; i++) {
        const before = tasks.submitted.length;
        settleMilestone("SFX cue list generated with unity_generate_audio and wired");
        await waitFor(() => expect(mcov1().status !== "running" || tasks.submitted.length > before).toBe(true), { timeout: 15_000 });
      }
      expect(mcov1().status).toBe("green");
      expect(mcov1().artBounced).not.toBe(true);
      expect(tasks.submitted.some((t) => t.prompt.includes("ART NOT PRODUCED"))).toBe(false);
    });

    it("revival resets the art and prose one-shots and strips stale time-box directives", async () => {
      const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      await waitFor(() => expect(tasks.submitted).toHaveLength(1));
      const m = storage.get(campaign.id)!.milestones[0]!;
      m.artBounced = true;
      m.prosOnlyBounced = true;
      m.structureRefused = true;
      m.prompt += "\n\nTIME BOX (6h elapsed, escalation 1/2): this sprint has run far past its budget. NARROW THE SCOPE NOW: x beats another broad attempt." +
        "\n\nTIME BOX EXHAUSTED (9h after two scope narrowings): this attempt is charged. Deliver ONLY the single smallest verifiable increment and stop.";
      const c = storage.get(campaign.id)!;
      c.milestones[0] = m;
      c.state = "failed";
      storage.save(c);
      expect(await manager.tryHandleRevive(ctx.chatId, "kampanya devam")).toBe(true);
      await waitFor(() => expect(tasks.submitted).toHaveLength(2));
      const revived = storage.get(campaign.id)!.milestones[0]!;
      expect(revived.artBounced).toBe(false);
      expect(revived.prosOnlyBounced).toBe(false);
      expect(revived.structureRefused).toBe(false);
      expect(tasks.submitted[1]!.prompt).not.toContain("TIME BOX");
    });

    it("stripTimeBoxDirectives removes both the narrowing blocks and the exhausted line", () => {
      const p = "base\n\nTIME BOX (6h elapsed, escalation 1/2): blah beats another broad attempt.\n\nTIME BOX EXHAUSTED (9h after two scope narrowings): this attempt is charged. Deliver ONLY x and stop.";
      expect(stripTimeBoxDirectives(p)).toBe("base");
    });

    it("a shutdown-caused tip found at boot is resubmitted even when the time box is past its last narrowing", async () => {
      const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      await waitFor(() => expect(tasks.submitted).toHaveLength(1));
      const c = storage.get(campaign.id)!;
      const m = c.milestones[0]!;
      m.timeBoxEscalations = 2;
      m.attempts = 2;
      m.startedAtMs = Date.now() - 7 * 3_600_000;
      storage.save(c);
      tasks.markTerminal("task_1", TaskStatus.blocked, `${SYSTEM_INTERRUPTION_MARKER} Task durduruldu (shutting down)`);
      await manager.resumeActive();
      await waitFor(() => expect(tasks.submitted).toHaveLength(2));
      expect(storage.get(campaign.id)!.state).toBe("executing");
    });

    it("a campaign started while every provider is cooling parks before submitting anything", async () => {
      const { ProviderHealthRegistry } = await import("../agents/providers/provider-health.js");
      const { setLiveChainMemberNames } = await import("../agents/providers/provider-outage.js");
      const registry = ProviderHealthRegistry.getInstance();
      registry.clearProviderState("cm-start");
      registry.recordOverloaded("cm-start", "quota wall");
      setLiveChainMemberNames(["cm-start"]);
      try {
        const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
        await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));
        expect(tasks.submitted).toHaveLength(0);
        expect(storage.get(campaign.id)!.autoReviveAt).toBeGreaterThan(Date.now());
        expect(messages.at(-1)!.text).toContain("every provider is in cooldown");
        registry.clearProviderState("cm-start");
        (manager as unknown as { scheduleAutoRevive(id: string, ms: number): void }).scheduleAutoRevive(campaign.id, 20);
        await waitFor(() => expect(tasks.submitted).toHaveLength(1));
      } finally {
        setLiveChainMemberNames([]);
        registry.clearProviderState("cm-start");
      }
    });

    it("a partial delivery that stopped on a refusal is re-sent after a restart; a plain failure is not", async () => {
      const a = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      const ca = storage.get(a.id)!;
      ca.state = "failed"; ca.lastError = "NOT DELIVERED — The shipped scenes render NOTHING"; ca.deliveryReported = false;
      storage.save(ca);
      const b = manager.startFromGdd(ctx, "# GDD 2", "docs/Game2_GDD.md");
      const cb = storage.get(b.id)!;
      cb.state = "failed"; cb.lastError = "m1 failed after 2 attempts: compile exploded"; cb.deliveryReported = false;
      storage.save(cb);
      expect(storage.listUnreportedDeliveries().map((c) => c.id)).toEqual([a.id]);
    });
  });

  describe("an idea-mode draft is built only after approval (CMP-1)", () => {
    const planMilestones = (): ReturnType<typeof vi.fn> =>
      (manager as unknown as { planner: { planMilestones: ReturnType<typeof vi.fn> } }).planner.planMilestones;

    /** Idea → the first draft lands at the gate → the designer asks for a revision. */
    const toRevision = async (): Promise<string> => {
      const campaign = manager.startFromIdea(ctx, "a match-3 where pigs fly");
      tasks.emit("task:completed", "task_1", "wrote docs/Game_GDD.md");
      await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("awaiting-approval"));
      expect(await manager.tryHandleApproval("cli-local", "no, make it about cats")).toBe(true);
      await waitFor(() => expect(tasks.submitted).toHaveLength(2));
      return campaign.id;
    };

    const expectBackAtTheGate = (id: string, submittedBefore: number): void => {
      const after = storage.get(id)!;
      expect(after.state).toBe("awaiting-approval");
      expect(after.milestones).toHaveLength(0);
      expect(after.gddSha256).toBeUndefined();
      expect(planMilestones()).not.toHaveBeenCalled();
      expect(tasks.submitted).toHaveLength(submittedBefore);
      expect(messages.at(-1)!.text).toContain("never approved");
    };

    it("a person's revival of a failed revision re-opens the gate instead of planning the rejected draft", async () => {
      const id = await toRevision();
      const failed = storage.get(id)!;
      failed.state = "failed";
      failed.lastError = "GDD draft failed";
      storage.save(failed);
      const before = tasks.submitted.length;

      expect(await manager.tryHandleRevive("cli-local", "kampanya devam")).toBe(true);
      await new Promise((r) => setTimeout(r, 100));
      expectBackAtTheGate(id, before);

      // …and the gate still works from there: approval plans and builds.
      expect(await manager.tryHandleApproval("cli-local", "evet")).toBe(true);
      await waitFor(() => expect(storage.get(id)!.state).toBe("executing"));
      expect(planMilestones()).toHaveBeenCalledTimes(1);
    });

    it("a campaign cancelled for its revision budget revives at the gate with a fresh budget", async () => {
      const campaign = manager.startFromIdea(ctx, "a match-3 where pigs fly");
      tasks.emit("task:completed", "task_1", "wrote docs/Game_GDD.md");
      await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("awaiting-approval"));
      const spent = storage.get(campaign.id)!;
      spent.draftAttempts = 3;
      storage.save(spent);
      expect(await manager.tryHandleApproval("cli-local", "still not what I meant")).toBe(true);
      expect(storage.get(campaign.id)!.state).toBe("cancelled");

      expect(await manager.tryHandleRevive("cli-local", "kampanya devam")).toBe(true);
      await new Promise((r) => setTimeout(r, 100));
      expectBackAtTheGate(campaign.id, 1);
      expect(storage.get(campaign.id)!.draftAttempts).toBe(0);
    });

    it("an outage self-revival of a revision re-opens the gate instead of planning", async () => {
      const id = await toRevision();
      const parked = storage.get(id)!;
      parked.state = "failed";
      parked.autoReviveAt = Date.now() + 60_000;
      storage.save(parked);
      const before = tasks.submitted.length;

      (manager as unknown as { scheduleAutoRevive(id: string, ms: number): void }).scheduleAutoRevive(id, 20);
      await waitFor(() => expect(storage.get(id)!.state).toBe("awaiting-approval"));
      await new Promise((r) => setTimeout(r, 50));
      expectBackAtTheGate(id, before);
      expect(storage.get(id)!.autoReviveAt).toBeUndefined();
    });

    it("planning refuses an idea-mode campaign nobody approved, and a boot resume goes back to the gate", async () => {
      const campaign = manager.startFromIdea(ctx, "a match-3 where pigs fly");
      tasks.emit("task:completed", "task_1", "wrote docs/Game_GDD.md");
      await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("awaiting-approval"));

      await (manager as unknown as { planAndLaunch(id: string): Promise<void> }).planAndLaunch(campaign.id);
      expectBackAtTheGate(campaign.id, 1);

      // A row left `planning` before approval (the old revival path) resumes at the gate.
      const planning = storage.get(campaign.id)!;
      planning.state = "planning";
      storage.save(planning);
      await manager.resumeActive();
      await new Promise((r) => setTimeout(r, 50));
      expect(storage.get(campaign.id)!.state).toBe("awaiting-approval");
      expect(planMilestones()).not.toHaveBeenCalled();
    });

    it("'amend gdd' cannot approve a draft that is still in revision", async () => {
      const id = await toRevision();
      expect(await manager.tryHandleAmendment("cli-local", "amend gdd")).toBe(true);
      const after = storage.get(id)!;
      expect(after.gddSha256).toBeUndefined();
      expect(after.gddRevision).toBeUndefined();
      expect(messages.at(-1)!.text).toContain("nobody has approved");
    });
  });

  describe("a recorded stop never wedges a campaign (CMP-2)", () => {
    const incoming = (text: string, userId = "u1"): IncomingMessage =>
      ({ channelType: "cli", chatId: "cli-local", userId, text, timestamp: new Date() }) as unknown as IncomingMessage;

    /** A person cancelled the sprint and the stop was recorded, but the process died before its handler ran. */
    const stopRecordedThenRestart = async (): Promise<string> => {
      const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      await waitFor(() => expect(tasks.submitted).toHaveLength(1));
      tasks.cancel("task_1", { reason: "user" });
      const row = storage.get(campaign.id)!;
      row.stopRequestedAt = Date.now();
      storage.save(row);
      return campaign.id;
    };

    it("a stop recorded before a restart lands the campaign failed and revivable on boot", async () => {
      const id = await stopRecordedThenRestart();
      await manager.resumeActive();
      await waitFor(() => expect(storage.get(id)!.state).toBe("failed"));
      const after = storage.get(id)!;
      expect(tasks.submitted).toHaveLength(1); // nothing resubmitted
      expect(after.lastError).toContain("NOT DELIVERED");
      expect(storage.hasActiveForProject(projectRoot)).toBe(false);
      expect(storage.findLatestRevivable("cli-local")?.id).toBe(id);
      expect(messages.at(-1)!.text).toContain("was cancelled");

      // …and "kampanya devam" brings it back.
      expect(await manager.tryHandleRevive("cli-local", "kampanya devam")).toBe(true);
      await waitFor(() => expect(tasks.submitted).toHaveLength(2));
      expect(storage.get(id)!.state).toBe("executing");
    });

    it("a person's cancel in the lineage is judged at boot even when no stop was stamped", async () => {
      const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      await waitFor(() => expect(tasks.submitted).toHaveLength(1));
      tasks.cancel("task_1", { reason: "user" });
      await manager.resumeActive();
      await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));
      expect(tasks.submitted).toHaveLength(1);
    });

    it("the submission guard carries a recorded stop out instead of returning silently", async () => {
      const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      await waitFor(() => expect(tasks.submitted).toHaveLength(1));
      const stored = storage.get(campaign.id)!;
      stored.stopRequestedAt = Date.now();
      storage.save(stored);

      (manager as unknown as { submitCurrentMilestone(c: unknown): void }).submitCurrentMilestone(storage.get(campaign.id)!);
      await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));
      expect(tasks.submitted).toHaveLength(1);
      expect(tasks.cancelled).toContain("task_1"); // its live work is retired
      expect(messages.at(-1)!.text).toContain("kampanya devam");
    });

    it("'kampanya iptal' cancels the requester's active campaign, frees the project, and can be revived", async () => {
      const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      await waitFor(() => expect(tasks.submitted).toHaveLength(1));

      expect(await manager.tryHandleIncoming(incoming("kampanya iptal"))).toBe(true);
      const after = storage.get(campaign.id)!;
      expect(after.state).toBe("cancelled");
      expect(tasks.cancelled).toContain("task_1");
      expect(storage.hasActiveForProject(projectRoot)).toBe(false);
      expect(messages.at(-1)!.text).toContain("Campaign cancelled");

      // A settle of the cancelled work later does not bring it back to life.
      tasks.emit("task:completed", "task_1", "sprint A done");
      await new Promise((r) => setTimeout(r, 100));
      expect(storage.get(campaign.id)!.state).toBe("cancelled");

      expect(await manager.tryHandleRevive("cli-local", "kampanya devam")).toBe(true);
      await waitFor(() => expect(tasks.submitted).toHaveLength(2));
      expect(storage.get(campaign.id)!.state).toBe("executing");
    });

    it("another person in the chat cannot cancel the campaign", async () => {
      const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      await waitFor(() => expect(tasks.submitted).toHaveLength(1));
      expect(await manager.tryHandleIncoming(incoming("campaign cancel", "someone-else"))).toBe(true);
      expect(storage.get(campaign.id)!.state).toBe("executing");
      expect(tasks.cancelled).not.toContain("task_1");
      expect(await manager.cancelByCommand("cli-local", "u1")).toBe(true);
      expect(storage.get(campaign.id)!.state).toBe("cancelled");
    });
  });

  describe("only the campaign's owner answers its GDD gate, and only on purpose (CMP-4)", () => {
    const say = (text: string, userId = "u1"): Promise<boolean> =>
      manager.tryHandleIncoming({ channelType: "cli", chatId: "cli-local", userId, text, timestamp: new Date() } as unknown as IncomingMessage);
    const planMilestones = (): ReturnType<typeof vi.fn> =>
      (manager as unknown as { planner: { planMilestones: ReturnType<typeof vi.fn> } }).planner.planMilestones;

    const atTheGate = async (): Promise<string> => {
      const campaign = manager.startFromIdea(ctx, "a match-3 where pigs fly");
      tasks.emit("task:completed", "task_1", "wrote docs/Game_GDD.md");
      await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("awaiting-approval"));
      expect(messages.at(-1)!.text).toContain("revise:");
      return campaign.id;
    };

    it("another person's approval in the same chat is not the gate's answer", async () => {
      const id = await atTheGate();
      expect(await say("evet", "someone-else")).toBe(false);
      await new Promise((r) => setTimeout(r, 50));
      expect(storage.get(id)!.state).toBe("awaiting-approval");
      expect(storage.get(id)!.gddSha256).toBeUndefined();
      expect(planMilestones()).not.toHaveBeenCalled();
      // …nor is their revision.
      expect(await say("revise: make it about cats", "someone-else")).toBe(false);
      expect(storage.get(id)!.draftAttempts).toBe(0);
      expect(tasks.submitted).toHaveLength(1);
    });

    it("an unrelated message from the owner falls through instead of spending a revision round", async () => {
      const id = await atTheGate();
      expect(await say("why is the build red?")).toBe(false);
      expect(await say("ok")).toBe(false); // bare "ok" is conversation, not an approval
      const after = storage.get(id)!;
      expect(after.state).toBe("awaiting-approval");
      expect(after.draftAttempts).toBe(0);
      expect(tasks.submitted).toHaveLength(1);
    });

    it("the owner's explicit revision redrafts with the note, and the owner's approval builds", async () => {
      const id = await atTheGate();
      expect(await say("revise: make it about cats")).toBe(true);
      await waitFor(() => expect(tasks.submitted).toHaveLength(2));
      expect(tasks.submitted[1]!.prompt).toContain("make it about cats");
      expect(tasks.submitted[1]!.prompt).not.toContain("revise:");
      expect(storage.get(id)!.draftAttempts).toBe(1);

      tasks.emit("task:completed", "task_2", "revised GDD written");
      await waitFor(() => expect(storage.get(id)!.state).toBe("awaiting-approval"));
      expect(await say("evet")).toBe(true);
      await waitFor(() => expect(storage.get(id)!.state).toBe("executing"));
    });
  });

  describe("a GDD is read only from inside the project (CMP-12)", () => {
    it("a named path that leaves the project is refused, not read", async () => {
      writeFileSync(join(dir, "outside.md"), "# Somebody else's notes\n");
      expect(manager.startFromGddFromDocs(ctx, "../outside.md")).toBeUndefined();

      const say = (text: string): Promise<boolean> =>
        manager.tryHandleIncoming({ channelType: "cli", chatId: "cli-local", userId: "u1", text, timestamp: new Date() } as unknown as IncomingMessage);
      await say("build the game from the GDD at ../outside.md");
      expect(storage.listActive()).toHaveLength(0);
      expect(tasks.submitted).toHaveLength(0);
    });

    it("a GDD link that points outside the project is not followed", () => {
      writeFileSync(join(dir, "outside.md"), "# Somebody else's notes\n");
      symlinkSync(join(dir, "outside.md"), join(projectRoot, "docs", "Linked_GDD.md"));
      expect(manager.startFromGddFromDocs(ctx, "docs/Linked_GDD.md")).toBeUndefined();
      expect(tasks.submitted).toHaveLength(0);
    });
  });

  describe("the gate presents the document the draft just wrote (CMP-5)", () => {
    /** An older document of the repo: written well before any draft began. */
    const stale = (rel: string, text: string): void => {
      mkdirSync(join(projectRoot, rel, ".."), { recursive: true });
      writeFileSync(join(projectRoot, rel), text);
      const past = new Date(Date.now() - 60 * 60_000);
      utimesSync(join(projectRoot, rel), past, past);
    };

    it("a fresh draft in a subfolder wins over an older docs/GDD.md with a closer name", async () => {
      rmSync(join(projectRoot, "docs", "Game_GDD.md"));
      stale("docs/GDD.md", "# Another game's GDD\n");
      const campaign = manager.startFromIdea(ctx, "a roguelike about ash");
      mkdirSync(join(projectRoot, "docs", "design"), { recursive: true });
      writeFileSync(join(projectRoot, "docs", "design", "Ashen_GDD.md"), "# Ashen GDD\n");
      tasks.emit("task:completed", "task_1", "The design is written."); // names no path
      await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("awaiting-approval"));
      expect(storage.get(campaign.id)!.gddPath).toBe("docs/design/Ashen_GDD.md");
    });

    it("the path the draft names wins, and a revision is told which file it revises", async () => {
      rmSync(join(projectRoot, "docs", "Game_GDD.md"));
      stale("docs/GDD.md", "# Another game's GDD\n");
      const campaign = manager.startFromIdea(ctx, "a match-3 where pigs fly");
      writeFileSync(join(projectRoot, "docs", "Pig_Draft_GDD.md"), "# Pig GDD v1\n");
      tasks.emit("task:completed", "task_1", "Wrote the GDD.\n\ndocs/Pig_Draft_GDD.md");
      await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("awaiting-approval"));
      expect(storage.get(campaign.id)!.gddPath).toBe("docs/Pig_Draft_GDD.md");

      expect(await manager.tryHandleApproval("cli-local", "add a boss level")).toBe(true);
      await waitFor(() => expect(tasks.submitted).toHaveLength(2));
      expect(tasks.submitted[1]!.prompt).toContain("`docs/Pig_Draft_GDD.md` — revise THAT file in place");
    });

    it("a revision written beside the old draft is the one presented", async () => {
      rmSync(join(projectRoot, "docs", "Game_GDD.md"));
      const campaign = manager.startFromIdea(ctx, "a match-3 where pigs fly");
      writeFileSync(join(projectRoot, "docs", "Pig_GDD.md"), "# Pig GDD v1\n");
      tasks.emit("task:completed", "task_1", "done");
      await waitFor(() => expect(storage.get(campaign.id)!.gddPath).toBe("docs/Pig_GDD.md"));
      // The first draft is history by the time the revision runs.
      const past = new Date(Date.now() - 60 * 60_000);
      utimesSync(join(projectRoot, "docs", "Pig_GDD.md"), past, past);

      expect(await manager.tryHandleApproval("cli-local", "make it about cats")).toBe(true);
      await waitFor(() => expect(tasks.submitted).toHaveLength(2));
      writeFileSync(join(projectRoot, "docs", "Pig_GDD_v2.md"), "# Pig GDD v2 — cats\n");
      tasks.emit("task:completed", "task_2", "revised");
      await waitFor(() => expect(storage.get(campaign.id)!.state).toBe("awaiting-approval"));
      expect(storage.get(campaign.id)!.gddPath).toBe("docs/Pig_GDD_v2.md");
      expect(messages.at(-1)!.text).toContain("docs/Pig_GDD_v2.md");
    });
  });

  describe("a compile a dirty tree cannot bind is NOT MEASURED, never 'does not compile' (CMP-6)", () => {
    const git = (...args: string[]): string => execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8" });
    const initRepo = (): void => {
      git("init", "-q");
      git("config", "user.email", "t@t");
      git("config", "user.name", "t");
      git("config", "commit.gpgsign", "false");
      git("add", "-A");
      git("commit", "-qm", "baseline");
    };
    /** A compiler that answers green, with a receipt for the run it was given. */
    const greenCompilerWithReceipt = async (_root: string, runId?: string): Promise<{ ok: boolean; ran: boolean; errors: number; detail: string; receipt?: string }> => ({
      ok: true, ran: true, errors: 0, detail: "compiles",
      ...(runId === undefined ? {} : {
        receipt: JSON.stringify({
          schemaVersion: 1, runId, kind: "compile", medium: "compiler", revision: git("rev-parse", "HEAD").trim(),
          execution: { completed: true, exitCode: 0, timedOut: false },
        }),
      }),
    });

    it("the verdict says NOT MEASURED and carries no refusal", async () => {
      initRepo();
      writeFileSync(join(projectRoot, "Uncommitted.cs"), "class Uncommitted {}");
      const campaign = {
        id: "c_dirty", chatId: "chat", channelType: "cli", userId: "u", projectRoot,
        state: "executing", draftAttempts: 0, milestones: [], currentMilestone: 0,
        createdAt: Date.now(), updatedAt: Date.now(),
      } as unknown as Campaign;
      const m = new CampaignManager({
        storage,
        runPlaymodeSuite: suiteRunner,
        verifyCompile: greenCompilerWithReceipt,
        receiptsExpected: true,
        planner: { planMilestones: vi.fn().mockResolvedValue(LADDER) } as unknown as CampaignPlanner,
        taskManager: tasks as unknown as TaskManager,
        messenger: async () => {},
        projectRoot,
      });
      const verdict = await (m as unknown as { measureCompile(c: unknown, ms: unknown): Promise<{ ok: boolean; ran: boolean; refused?: string; detail?: string }> })
        .measureCompile(campaign, { id: "m1", title: "Sprint", prompt: "p", status: "running", attempts: 1 });
      expect(verdict.ok).toBe(false);
      expect(verdict.ran).toBe(false);
      expect(verdict.refused).toBeUndefined();
      expect(verdict.detail).toContain("NOT MEASURED");
      expect(verdict.detail).toContain("commit");
    }, 20_000);

    it("a mid-ladder sprint whose milestone commit failed is not bounced as a compile failure", async () => {
      initRepo();
      // Every commit is rejected by a hook: the sprint's work stays in the tree.
      writeFileSync(join(projectRoot, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
      chmodSync(join(projectRoot, ".git", "hooks", "pre-commit"), 0o755);
      tasks = new FakeTaskManager();
      storage.close();
      storage = new CampaignStorage(join(dir, "campaigns-dirty.db"));
      manager = new CampaignManager({
        storage,
        runPlaymodeSuite: suiteRunner,
        verifyCompile: greenCompilerWithReceipt,
        receiptsExpected: true,
        planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
        taskManager: tasks as unknown as TaskManager,
        messenger: async (chatId, text) => { messages.push({ chatId, text }); },
        projectRoot,
        retryAdoptionGraceMs: 10,
        completedSettleDelayMs: 0,
        milestoneTimeBoxMs: 60 * 60_000,
      });
      manager.attachEvents();

      const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      await waitFor(() => expect(tasks.submitted).toHaveLength(1));
      writeFileSync(join(projectRoot, "SprintA.cs"), "class SprintA {}");
      settleMilestone("sprint A done");
      await waitFor(() => expect(tasks.submitted).toHaveLength(2));
      expect(tasks.submitted[1]!.prompt).not.toContain("DOES NOT COMPILE");
      const after = storage.get(campaign.id)!;
      expect(after.currentMilestone).toBe(1); // the ladder moved on
      expect(after.milestones[0]!.compileVerdict?.detail ?? "").toContain("NOT MEASURED");
    }, 30_000);
  });

  describe("a campaign is only acted on by the manager of its own project (CMP-7)", () => {
    /** The same database and task manager, serving another project from the same working directory. */
    const managerFor = (root: string): CampaignManager =>
      new CampaignManager({
        storage,
        planner: { planMilestones: vi.fn().mockResolvedValue(LADDER), auditCoverage: vi.fn().mockResolvedValue([]) } as unknown as CampaignPlanner,
        taskManager: tasks as unknown as TaskManager,
        messenger: async (chatId, text) => { messages.push({ chatId, text }); },
        projectRoot: root,
        retryAdoptionGraceMs: 10,
        completedSettleDelayMs: 0,
        milestoneTimeBoxMs: 60 * 60_000,
      });
    const otherRoot = (): string => {
      const root = join(dir, "other-game");
      mkdirSync(join(root, "docs"), { recursive: true });
      writeFileSync(join(root, "docs", "Other_GDD.md"), "# Other GDD\n\nA different game.");
      return root;
    };

    it("boot resume and revival in project B never touch project A's campaign", async () => {
      const a = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      await waitFor(() => expect(tasks.submitted).toHaveLength(1));
      tasks.markTerminal("task_1", TaskStatus.failed); // died with the process
      const b = managerFor(otherRoot());

      await b.resumeActive();
      await new Promise((r) => setTimeout(r, 100));
      expect(tasks.submitted).toHaveLength(1); // A's sprint was not resubmitted against B

      const failed = storage.get(a.id)!;
      failed.state = "failed";
      storage.save(failed);
      expect(await b.tryHandleRevive("cli-local", "kampanya devam")).toBe(false);
      expect(storage.get(a.id)!.state).toBe("failed");
      expect(tasks.submitted).toHaveLength(1);
    });

    it("project A's active campaign on a shared chat does not block a campaign for project B", async () => {
      manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      await waitFor(() => expect(tasks.submitted).toHaveLength(1));
      const root = otherRoot();
      const b = managerFor(root);
      const consumed = await b.tryHandleIncoming({
        channelType: "cli", chatId: "cli-local", userId: "u1", text: "build the game from the GDD at docs/Other_GDD.md", timestamp: new Date(),
      } as unknown as IncomingMessage);
      expect(consumed).toBe(true);
      await waitFor(() => expect(storage.listActive().filter((c) => c.projectRoot === root)).toHaveLength(1));
    });

    it("the same project spelled differently is still the same project", async () => {
      const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      await waitFor(() => expect(tasks.submitted).toHaveLength(1));
      tasks.markTerminal("task_1", TaskStatus.failed);
      const same = managerFor(`${projectRoot}${sep}`);
      await same.resumeActive();
      await waitFor(() => expect(tasks.submitted).toHaveLength(2));
      expect(storage.get(campaign.id)!.state).toBe("executing");
    });
  });

  describe("the final sprint's suite proof is a run the campaign makes itself (CMP-8)", () => {
    /** A manager like the harness's, with the suite runner a test chooses (or none). */
    const managerWithSuite = (
      runPlaymodeSuite: ((root: string, runId: string) => Promise<{ receipt?: string } | void>) | undefined,
      extra: { receiptsExpected?: boolean } = {},
    ): CampaignManager => {
      tasks = new FakeTaskManager();
      storage.close();
      storage = new CampaignStorage(join(dir, `campaigns-cmp8-${Math.random().toString(36).slice(2)}.db`));
      const m = new CampaignManager({
        storage,
        ...(runPlaymodeSuite === undefined ? {} : { runPlaymodeSuite }),
        verifyCompile: async () => compileVerdict,
        buildPlayer: async () => buildVerdict,
        runPlayer: async (root) => { writePlayerVerdict(true, {}, root); },
        planner: {
          planMilestones: vi.fn().mockResolvedValue(LADDER),
          auditCoverage: vi.fn().mockResolvedValue([]),
          resolveCoverageGaps: vi.fn(async (_gdd: string, reqs: readonly string[]) => ({ closed: [], open: [...reqs] })),
        } as unknown as CampaignPlanner,
        taskManager: tasks as unknown as TaskManager,
        messenger: async (chatId, text) => { messages.push({ chatId, text }); },
        projectRoot,
        retryAdoptionGraceMs: 10,
        completedSettleDelayMs: 0,
        milestoneTimeBoxMs: 60 * 60_000,
        ...extra,
      });
      m.attachEvents();
      return m;
    };
    const reachFinalSettle = async (m: CampaignManager): Promise<string> => {
      const campaign = m.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      await waitFor(() => expect(tasks.submitted).toHaveLength(1));
      settleMilestone("sprint A done");
      await waitFor(() => expect(tasks.submitted).toHaveLength(2));
      settleMilestone("sprint B done");
      await waitFor(() => expect(tasks.submitted).toHaveLength(3));
      // The worker leaves a fresh, stamped, green, unfiltered record.
      runRecordOnSettle = { total: 42, passed: 42, failed: 0, skipped: 0, unfiltered: true };
      settleMilestone("green, shipping");
      return campaign.id;
    };

    it("a record the worker wrote is not delivery proof when the campaign runs no suite of its own", async () => {
      const m = managerWithSuite(undefined);
      const id = await reachFinalSettle(m);
      await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(3));
      const after = storage.get(id)!;
      expect(after.state).not.toBe("done");
      expect(after.milestones[2]!.testVerdict).toBeUndefined();
      expect(after.milestones[2]!.suiteRunMissing).toContain("no test verifier is configured");
    });

    it("a record the campaign's run did not stamp with its ticket's run id is not delivery proof", async () => {
      const ranWith: string[] = [];
      // A producer that ran and left a green record naming no run.
      const m = managerWithSuite(async (root, runId) => {
        ranWith.push(runId);
        mkdirSync(join(root, "Recordings", "tests"), { recursive: true });
        writeFileSync(join(root, "Recordings", "tests", "playmode-last.json"), JSON.stringify({
          total: 42, passed: 42, failed: 0, skipped: 0, unfiltered: true, measuredAt: new Date().toISOString(),
        }));
      });
      const id = await reachFinalSettle(m);
      await waitFor(() => expect(tasks.submitted.length).toBeGreaterThan(3));
      expect(ranWith.length).toBeGreaterThanOrEqual(1);
      const after = storage.get(id)!;
      expect(after.state).not.toBe("done");
      expect(after.milestones[2]!.suiteRunMissing).toContain("run id the campaign issued");
    });

    it("the campaign's own run, stamped with its ticket, delivers — and the worker's record is removed first", async () => {
      let sawWorkerRecord: boolean | undefined;
      const m = managerWithSuite(async (root, runId) => {
        sawWorkerRecord = existsSync(join(root, "Recordings", "tests", "playmode-last.json"));
        await suiteRunner(root, runId);
      });
      const id = await reachFinalSettle(m);
      await waitFor(() => expect(storage.get(id)!.state).toBe("done"), { timeout: 15_000 });
      expect(sawWorkerRecord).toBe(false);
      expect(storage.get(id)!.milestones[2]!.testVerdictUnfiltered).toBe(true);
    });

    it("an admitted receipt binds the record only when its counts are the record's", async () => {
      const campaign = {
        id: "c_cmp8", chatId: "chat", channelType: "cli", userId: "u", projectRoot,
        state: "executing", draftAttempts: 0, milestones: [], currentMilestone: 0, createdAt: Date.now(), updatedAt: Date.now(),
      } as unknown as Campaign;
      let recordTotal = 42;
      const m = managerWithSuite(async (root, runId) => {
        mkdirSync(join(root, "Recordings", "tests"), { recursive: true });
        writeFileSync(join(root, "Recordings", "tests", "playmode-last.json"), JSON.stringify({
          total: recordTotal, passed: recordTotal, failed: 0, skipped: 0, unfiltered: true, measuredAt: new Date().toISOString(),
        }));
        // What the producer measured, in its receipt; the record names no run.
        return {
          receipt: JSON.stringify({
            schemaVersion: 1, runId, kind: "playmode-suite", medium: "editor", revision: "",
            execution: { completed: true, exitCode: 0, timedOut: false },
            payload: { result: "Passed", total: 42, passed: 42, failed: 0, skipped: 0, exceptions: 0, filter: null, categories: null },
          }),
        };
      }, { receiptsExpected: true });
      type Measured = { run: { found: boolean; green?: boolean }; missing?: string };
      const measure = (): Promise<Measured> =>
        (m as unknown as { measureDeliverySuite(c: unknown, ms: unknown): Promise<Measured> })
          .measureDeliverySuite(campaign, { id: "m_cmp8", title: "Delivery", prompt: "p", status: "running", attempts: 1 });
      const bound = await measure();
      expect(bound.missing).toBeUndefined();
      expect(bound.run.green).toBe(true);
      // A green record that is not the run the receipt describes is some other file.
      recordTotal = 40;
      const other = await measure();
      expect(other.run.found).toBe(false);
      expect(other.missing).toContain("not the run the receipt describes");
    });
  });
});

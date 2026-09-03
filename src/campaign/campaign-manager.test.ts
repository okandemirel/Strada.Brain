import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CampaignManager } from "./campaign-manager.js";
import { CampaignStorage } from "./campaign-storage.js";
import type { CampaignPlanner } from "./campaign-planner.js";
import { GDD_AUDIT_FULL_CHARS } from "./campaign-planner.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { IncomingMessage } from "../channels/channel-messages.interface.js";
import type { Task } from "../tasks/types.js";
import { TaskStatus } from "../tasks/types.js";

class FakeTaskManager extends EventEmitter {
  submitted: Array<{ prompt: string; chatId: string }> = [];
  resumed: string[] = [];
  private counter = 0;
  private statuses = new Map<string, TaskStatus>();
  private parents = new Map<string, string>();
  private results = new Map<string, string>();

  submit(chatId: string, _channelType: string, prompt: string): Task {
    this.counter += 1;
    const id = `task_${this.counter}`;
    this.submitted.push({ chatId, prompt });
    this.statuses.set(id, TaskStatus.executing);
    this.createdAts.set(id, Date.now());
    return { id, chatId, status: TaskStatus.executing } as unknown as Task;
  }

  private createdAts = new Map<string, number>();
  updatedAts = new Map<string, number>();

  verifications = new Map<string, { testsGreen?: boolean; detail: string }>();

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
        } as unknown as Task)
      : null;
  }

  cancelled: string[] = [];
  cancel(taskId: string): void {
    this.cancelled.push(taskId);
    this.statuses.set(taskId, TaskStatus.cancelled);
  }

  markTerminal(taskId: string, status: TaskStatus, result?: string): void {
    this.statuses.set(taskId, status);
    if (result !== undefined) this.results.set(taskId, result);
  }

  /** Simulate the executor's keep-alive minting a retry under a new id. */
  addRetry(parentId: string, status: TaskStatus = TaskStatus.executing): string {
    this.counter += 1;
    const id = `task_${this.counter}`;
    this.statuses.set(id, status);
    this.parents.set(id, parentId);
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

  const ctx = { chatId: "cli-local", channelType: "cli", userId: "u1" };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "campaign-mgr-"));
    projectRoot = join(dir, "project");
    mkdirSync(join(projectRoot, "docs"), { recursive: true });
    writeFileSync(join(projectRoot, "docs", "Game_GDD.md"), "# Test GDD\n\nElement schedule: ...");
    storage = new CampaignStorage(join(dir, "campaigns.db"));
    tasks = new FakeTaskManager();
    messages = [];
    messengerDownFor = undefined;

    const planner = {
      planMilestones: vi.fn().mockResolvedValue(LADDER),
    } as unknown as CampaignPlanner;

    manager = new CampaignManager({
      storage,
      planner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => {
        if (messengerDownFor?.test(text)) throw new Error("messenger unavailable");
        messages.push({ chatId, text });
      },
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    manager.attachEvents();
  });

  afterEach(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const settleMilestone = (result: string) => {
    const last = tasks.submitted.length;
    const taskId = `task_${last}`;
    // The delivery gate requires the FINAL milestone to carry an observed
    // green test verdict; give every settle one so ladder tests exercise the
    // walk rather than the gate (the gate has its own test).
    tasks.verifications.set(taskId, { testsGreen: true, detail: "All 42 tests passed" });
    tasks.emit("task:completed", taskId, result);
  };

  it("GDD mode: plans the ladder and submits sprint 1 immediately (no approval gate)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    expect(campaign.state).toBe("planning");

    await vi.waitFor(() => {
      expect(tasks.submitted).toHaveLength(1);
    });
    expect(tasks.submitted[0]!.prompt).toContain("foundations");
    expect(storage.get(campaign.id)!.state).toBe("executing");
    // The ladder announcement went to the origin conversation.
    expect(messages.some((m) => m.text.includes("Milestone ladder ready"))).toBe(true);
  });

  it("walks the ladder: sprint completion auto-submits the next sprint", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    settleMilestone("sprint A done, committed");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(tasks.submitted[1]!.prompt).toContain("elements");

    settleMilestone("sprint B done");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(3));

    settleMilestone("final report");
    await vi.waitFor(() => {
      expect(storage.get(campaign.id)!.state).toBe("done");
    });
    expect(messages.at(-1)!.text).toContain("Campaign delivery");
  });

  it("retries a failed milestone with the failure appended, then fails loudly", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    tasks.emit("task:failed", "task_1", "compile exploded");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(tasks.submitted[1]!.prompt).toContain("compile exploded");

    tasks.emit("task:failed", "task_2", "compile exploded again");
    await vi.waitFor(() => {
      expect(storage.get(campaign.id)!.state).toBe("failed");
    });
    expect(messages.at(-1)!.text).toContain("Campaign stopped");
  });

  it("nudges a blocked sprint with the autonomous mandate instead of waiting on a person", async () => {
    manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    tasks.emit("task:blocked", "task_1", "blocked:ask_user");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(tasks.submitted[1]!.prompt).toContain("do not ask the user");
  });

  it("idea mode: drafts the GDD, gates on approval, builds after 'evet'", async () => {
    const campaign = manager.startFromIdea(ctx, "a match-3 where pigs fly");
    expect(campaign.state).toBe("drafting-gdd");
    expect(tasks.submitted).toHaveLength(1);
    expect(tasks.submitted[0]!.prompt).toContain("pigs fly");

    // Draft completes; the GDD file exists in docs/.
    tasks.emit("task:completed", "task_1", "wrote docs/Game_GDD.md");
    await vi.waitFor(() => {
      expect(storage.get(campaign.id)!.state).toBe("awaiting-approval");
    });
    expect(messages.at(-1)!.text).toContain("Game_GDD.md");

    // A random message from another chat is not consumed by the gate.
    expect(await manager.tryHandleApproval("other-chat", "evet")).toBe(false);

    // Revision feedback re-drafts instead of launching.
    expect(await manager.tryHandleApproval("cli-local", "daha fazla bölüm ekle")).toBe(true);
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(tasks.submitted[1]!.prompt).toContain("daha fazla bölüm ekle");

    // Second draft lands, designer approves → ladder plans, sprint 1 starts.
    tasks.emit("task:completed", "task_2", "revised GDD written");
    await vi.waitFor(() => {
      expect(storage.get(campaign.id)!.state).toBe("awaiting-approval");
    });
    expect(await manager.tryHandleApproval("cli-local", "evet")).toBe(true);
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(3));
    expect(storage.get(campaign.id)!.state).toBe("executing");
  });

  it("re-drafts when a 'completed' draft never wrote the GDD file", async () => {
    rmSync(join(projectRoot, "docs", "Game_GDD.md"));
    const campaign = manager.startFromIdea(ctx, "a puzzle game");
    expect(campaign.state).toBe("drafting-gdd");

    tasks.emit("task:completed", "task_1", "I described the GDD in chat");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(tasks.submitted[1]!.prompt).toContain("never wrote the GDD file");
  });

  it("resumeActive resubmits the in-flight milestone when the task died with the process", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
    // Simulate crash: the task is terminally failed but its event never arrived.
    tasks.markTerminal("task_1", TaskStatus.failed);

    await manager.resumeActive();
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(storage.get(campaign.id)!.state).toBe("executing");
  });

  it("adopts the executor's own retry instead of resubmitting and burning an attempt", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    // Keep-alive parks task_1 as blocked and mints task_2 as its retry.
    const retryId = tasks.addRetry("task_1");
    tasks.emit("task:blocked", "task_1", "Transient failure — provider cooldown. Auto-retry 1/10 in ~30s.");

    // After the grace window the campaign adopts the retry: no resubmission.
    await vi.waitFor(() => {
      const fresh = storage.get(campaign.id)!;
      expect(fresh.milestones[0]!.taskId).toBe(retryId);
    });
    expect(tasks.submitted).toHaveLength(1);
    expect(storage.get(campaign.id)!.milestones[0]!.attempts).toBe(1); // untouched

    // The adopted retry completing walks the ladder normally.
    tasks.emit("task:completed", retryId, "sprint A done via retry");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
  });

  it("resumes a paused (startup-recovered) task instead of wedging forever", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
    tasks.markTerminal("task_1", TaskStatus.paused);

    await manager.resumeActive();
    expect(tasks.resumed).toContain("task_1");
    await vi.waitFor(() => {
      const fresh = storage.get(campaign.id)!;
      expect(fresh.milestones[0]!.taskId).not.toBe("task_1");
    });
  });

  it("revival cancels the old lineage's live tip before resubmitting", async () => {
    // 2026-09-02 19:23: the executor's boot re-arm revived the old blocked
    // lineage while the campaign resubmitted the sprint — two runs of the
    // same prompt against the same repo.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const stored = storage.get(campaign.id)!;
    stored.state = "failed";
    stored.milestones[0]!.attempts = 2;
    storage.save(stored);
    tasks.markTerminal("task_1", TaskStatus.blocked);

    const handled = await manager.tryHandleRevive("cli-local", "kampanya devam");
    expect(handled).toBe(true);
    expect(tasks.cancelled).toContain("task_1");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
  });

  it("a third time-box overrun charges an attempt instead of running unbounded", async () => {
    // Measured 2026-09-01: after escalation 2/2 the box switched off and m6
    // ran 33h. The third overrun must be a charged, narrowest-scope retry.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
    const stored = storage.get(campaign.id)!;
    stored.milestones[0]!.timeBoxEscalations = 2;
    stored.milestones[0]!.startedAtMs = Date.now() - 7 * 60 * 60_000; // past a 6h box
    storage.save(stored);

    // A blocked settle drives reconcile → escalateIfPastTimeBox.
    tasks.emit("task:blocked", "task_1", "Transient failure — provider hiccup");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));

    const after = storage.get(campaign.id)!;
    expect(after.state).toBe("executing");
    expect(after.milestones[0]!.attempts).toBe(2); // charged
    expect(tasks.submitted[1]!.prompt).toContain("TIME BOX EXHAUSTED");
  });

  it("refuses delivery when the FINAL sprint never ran its tests (one bounce)", async () => {
    // Audited 2026-09-01: "full unfiltered suite" was only prose in the
    // planner prompt — a final sprint whose task printed no test result
    // carried no verdict and delivery was declared anyway.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(3));

    // Final sprint completes with NO observed test verdict.
    tasks.emit("task:completed", "task_3", "everything works, shipping it");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(4));

    expect(storage.get(campaign.id)!.state).toBe("executing");
    expect(tasks.submitted[3]!.prompt).toContain("DELIVERY VERIFICATION REQUIRED");
    expect(messages.some((m) => m.text.includes("Campaign delivery"))).toBe(false);
  });

  it("a milestone retry carries the previous attempt's progress without persisting it", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    tasks.progressBlocks.set(
      "task_1",
      "\n\nPREVIOUS ATTEMPT PROGRESS (verify before redoing any of it):\n- Assets/Scripts/Board.cs",
    );
    tasks.emit("task:failed", "task_1", "compile exploded");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));

    // The SUBMITTED prompt carries the progress block…
    expect(tasks.submitted[1]!.prompt).toContain("PREVIOUS ATTEMPT PROGRESS");
    expect(tasks.submitted[1]!.prompt).toContain("Assets/Scripts/Board.cs");
    // …but the persisted milestone prompt does not (no accumulation).
    const fresh = storage.get(campaign.id)!;
    expect(fresh.milestones[0]!.prompt).not.toContain("PREVIOUS ATTEMPT PROGRESS");
  });

  it("strips retry-machinery noise from the failure tail and keeps only one tail", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    // (Reaped/Auto-retry wording is settlement-deferred by design, so the
    // noise strip is exercised with the non-deferring machinery preface.)
    tasks.emit(
      "task:failed",
      "task_1",
      "Transient failure — worker crashed mid-epoch. Board.cs does not compile",
    );
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
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

    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    // Completion with a clean tree and no commits since the sprint began.
    settleMilestone("sprint A done (allegedly)");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    const bounced = storage.get(campaign.id)!;
    expect(bounced.milestones[0]!.status).toBe("running");
    expect(bounced.milestones[0]!.prompt).toContain("NO WORK DETECTED");
    expect(bounced.milestones[0]!.attempts).toBe(1); // bounce burned no attempt

    // Second completion stands either way (one bounce per milestone).
    settleMilestone("sprint A done again");
    await vi.waitFor(() => expect(storage.get(campaign.id)!.milestones[0]!.status).toBe("green"));
  });

  it("time-box forces scope narrowing when a sprint spins past its budget", async () => {
    // Measured 2026-08-31: m6 ran 22h at attempts=1 because bounces and
    // deferrals deliberately never burn attempts — nothing bounded the run.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    // Backdate the clock past the box, then settle badly.
    const stored = storage.get(campaign.id)!;
    stored.milestones[0]!.startedAtMs = Date.now() - 3 * 60 * 60_000;
    storage.save(stored);

    tasks.emit("task:failed", "task_1", "compile still red");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));

    const fresh = storage.get(campaign.id)!;
    expect(tasks.submitted[1]!.prompt).toContain("TIME BOX");
    expect(tasks.submitted[1]!.prompt).toContain("NARROW THE SCOPE");
    expect(fresh.milestones[0]!.timeBoxEscalations).toBe(1);
    expect(fresh.milestones[0]!.attempts).toBe(1); // escalation burns no attempt
    expect(messages.some((m) => m.text.includes("narrowing scope"))).toBe(true);
  });

  it("the time-box binds the ADOPTION path too (a sprint cannot spin forever unadjudicated)", async () => {
    // Measured 2026-09-01: m6 ran 7h+ with timeBoxEscalations=0 because every
    // settle was adopted as an executor retry and never reached an outcome.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    const stored = storage.get(campaign.id)!;
    stored.milestones[0]!.startedAtMs = Date.now() - 4 * 60 * 60_000;
    storage.save(stored);

    // Executor mints a live retry under a new id: the adoption path.
    const retryId = tasks.addRetry("task_1", TaskStatus.executing);
    tasks.emit("task:blocked", "task_1", "Reaped: no progress signal for 60 minutes.");
    void retryId;

    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    const fresh = storage.get(campaign.id)!;
    expect(fresh.milestones[0]!.timeBoxEscalations).toBe(1);
    expect(tasks.submitted[1]!.prompt).toContain("NARROW THE SCOPE");
  });

  it("an outage-caused settle resubmits WITHOUT charging an attempt", async () => {
    // Measured 2026-09-01 16:16: a four-account quota wall drove attempts
    // 1→2 — the milestone's budget spent on provider downtime, not on work.
    const { ProviderHealthRegistry } = await import("../agents/providers/provider-health.js");
    const { setLiveChainMemberNames } = await import("../agents/providers/provider-outage.js");
    const registry = ProviderHealthRegistry.getInstance();
    registry.clearProviderState("cm-cool");
    registry.recordOverloaded("cm-cool", "quota wall");
    setLiveChainMemberNames(["cm-cool"]);

    try {
      const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
      expect(storage.get(campaign.id)!.milestones[0]!.attempts).toBe(1);

      // Dead promise (tip idle past its horizon) so reconcile judges the
      // outcome instead of deferring — the live 16:16 path.
      tasks.updatedAts.set("task_1", Date.now() - 30 * 60_000);
      tasks.emit("task:failed", "task_1", "Task execution failed: All providers are in cooldown. Auto-retry 1/10 in ~30s.");
      await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));

      expect(storage.get(campaign.id)!.milestones[0]!.attempts).toBe(1); // not charged
    } finally {
      setLiveChainMemberNames([]);
      registry.clearProviderState("cm-cool");
    }
  });

  it("a graceful shutdown does not charge the milestone an attempt", async () => {
    // Measured 2026-09-03 06:45: a daemon restart aborted the in-flight run
    // with "shutting down", the milestone was charged its second attempt and
    // the campaign stopped — on a routine deploy, with no revival armed.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
    tasks.updatedAts.set("task_1", Date.now() - 30 * 60_000);
    tasks.emit("task:blocked", "task_1", "The task was stopped before it finished (shutting down). Any changes it made have been kept.");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));

    expect(storage.get(campaign.id)!.milestones[0]!.attempts).toBe(1);
    expect(storage.get(campaign.id)!.state).toBe("executing");
  });

  it("a BLOCKED outage settle also resubmits without charging an attempt", async () => {
    // Measured 2026-09-02 02:36: the outage surfaced as
    // `blocked:provider_unavailable`, and the blocked-nudge branch (which
    // runs first) charged attempts 1→2 → "blocked after 2 attempts".
    const { ProviderHealthRegistry } = await import("../agents/providers/provider-health.js");
    const { setLiveChainMemberNames } = await import("../agents/providers/provider-outage.js");
    const registry = ProviderHealthRegistry.getInstance();
    registry.clearProviderState("cm-cool2");
    registry.recordOverloaded("cm-cool2", "quota wall");
    setLiveChainMemberNames(["cm-cool2"]);

    try {
      const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
      tasks.updatedAts.set("task_1", Date.now() - 30 * 60_000);
      tasks.emit("task:blocked", "task_1", "Blocked:\n[goal_1] blocked:provider_unavailable. Auto-retry 2/10 in ~30s.");
      await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));

      expect(storage.get(campaign.id)!.milestones[0]!.attempts).toBe(1); // not charged
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
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    // Tip promises a 1s retry but its updatedAt is 10 minutes old: promise dead.
    tasks.updatedAts.set("task_1", Date.now() - 10 * 60_000);
    tasks.emit(
      "task:blocked",
      "task_1",
      "Transient failure — worker crashed. Auto-retry 1/10 in ~1s.",
    );
    // Not deferred: the outcome is judged and the retry branch resubmits.
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(storage.get(campaign.id)!.milestones[0]!.status).toBe("running");
  });

  it("doubled settle emissions cannot consume the deferral and burn an attempt", async () => {
    // Measured 2026-08-29 19:04: one handler logged the defer, the second
    // (same second, doubled task:blocked emission) consumed the one-shot flag
    // and submitted attempt 2 into a 68-minute quota wall.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

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
    registry.recordOverloaded("claude", "quota wall");
    setLiveChainMemberNames(["claude"]);

    try {
      const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
      // Non-outage wording (reconcile must not defer) while the chain cools —
      // the stop-time health check is what must detect the outage.
      tasks.emit("task:failed", "task_1", "2 fresh plans produced nothing new");
      await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
      tasks.emit("task:failed", "task_2", "2 fresh plans produced nothing new");

      await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));
      const parked = storage.get(campaign.id)!;
      expect(parked.autoReviveAt).toBeGreaterThan(Date.now());
      expect(messages.at(-1)!.text).toContain("Self-revival armed");

      // The chain recovers; the (privately re-scheduled, short) appointment fires.
      registry.clearProviderState("claude");
      (manager as unknown as { scheduleAutoRevive(id: string, ms: number): void })
        .scheduleAutoRevive(campaign.id, 20);
      await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("executing"));
      const revived = storage.get(campaign.id)!;
      expect(revived.autoReviveAt).toBeUndefined();
      expect(tasks.submitted.length).toBeGreaterThanOrEqual(3);
    } finally {
      setLiveChainMemberNames([]);
      registry.clearProviderState("claude");
    }
  });

  it("'kampanya devam' revives a failed campaign with a fresh attempt budget", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
    tasks.emit("task:failed", "task_1", "boom");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    tasks.emit("task:failed", "task_2", "boom again");
    await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));

    const consumed = await manager.tryHandleRevive("cli-local", "kampanya devam");
    expect(consumed).toBe(true);
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(3));
    const fresh = storage.get(campaign.id)!;
    expect(fresh.state).toBe("executing");
    expect(fresh.milestones[0]!.attempts).toBe(1); // fresh budget, one new attempt
  });

  it("commits the working tree when a milestone goes green", async () => {
    const { execFileSync } = await import("node:child_process");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8" });
    git("init");
    git("config", "user.email", "test@test.local");
    git("config", "user.name", "Test");

    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    writeFileSync(join(projectRoot, "SprintWork.cs"), "class SprintWork {}");
    tasks.emit("task:completed", "task_1", "sprint A done");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));

    expect(git("status", "--porcelain").trim()).toBe(""); // tree clean
    expect(git("log", "-1", "--pretty=%s")).toContain("milestone green");
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
    } as unknown as CampaignPlanner;
    manager = new CampaignManager({
      storage,
      planner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => messages.push({ chatId, text }),
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    manager.attachEvents();

    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(3));

    settleMilestone("final report"); // last planned milestone → audit fires, finds a gap
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(4));
    expect(tasks.submitted[3]!.prompt).toContain("Dragon boss");
    expect(storage.get(campaign.id)!.state).toBe("executing");

    // The remediation sprint now inherits the visual-evidence gate (its bar
    // demands a captured frame), so a first completion with no frames on disk
    // bounces once — the gap-closing sprint is exactly the one that must not
    // be allowed to go green blind.
    settleMilestone("dragon implemented");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(5));
    expect(tasks.submitted[4]!.prompt).toContain("VISUAL EVIDENCE MISSING");

    settleMilestone("dragon implemented, frames captured");
    await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"));
  });

  it("a spent coverage-remediation sprint delivers the built game WITH the unclosed gaps named", async () => {
    // Audited 2026-09-02: a remediation sprint (mcovN) that exhausted its
    // attempts after every planned sprint had gone green ended the campaign
    // with "❌ Campaign stopped" — nothing at all was reported about the game
    // that was actually built, and the gaps it failed to close were never
    // named either.
    tasks = new FakeTaskManager();
    storage.close();
    storage = new CampaignStorage(join(dir, "campaigns-partial.db"));
    const planner = {
      planMilestones: vi.fn().mockResolvedValue(LADDER),
      auditCoverage: vi.fn().mockResolvedValue(["Dragon boss: no milestone implemented it"]),
    } as unknown as CampaignPlanner;
    manager = new CampaignManager({
      storage,
      planner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => {
        if (messengerDownFor?.test(text)) throw new Error("messenger unavailable");
        messages.push({ chatId, text });
      },
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    manager.attachEvents();

    const campaign = manager.startFromGdd(ctx, "# GDD text", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(3));
    settleMilestone("final report"); // audit finds the gap → mcov1 appended
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(4));

    // The remediation sprint burns both its attempts without landing green.
    tasks.emit("task:failed", "task_4", "the boss scene will not compile");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(5));
    tasks.emit("task:failed", "task_5", "the boss scene will not compile");

    await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"));
    const delivered = storage.get(campaign.id)!;
    expect(delivered.milestones.filter((m) => m.status === "green")).toHaveLength(3);
    expect(delivered.milestones.at(-1)!.status).toBe("failed");
    expect(delivered.deliveryReported).toBe(true);

    const report = messages.at(-1)!.text;
    expect(report).toContain("Campaign delivery");
    expect(report).toContain("Sprint A — Foundations");
    expect(report).toContain("Dragon boss: no milestone implemented it");
    expect(report).toMatch(/unclosed/i);
    expect(report).not.toContain("Campaign stopped");
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
      projectRoot, // no Recordings/ dir → no evidence
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    manager.attachEvents();

    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    settleMilestone("done, everything renders (it says)");
    // Bounced: resubmitted with the missing-evidence demand, attempts NOT burned.
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(tasks.submitted[1]!.prompt).toContain("VISUAL EVIDENCE MISSING");
    const fresh = storage.get(campaign.id)!;
    expect(fresh.milestones[0]!.status).toBe("running");
    expect(fresh.milestones[0]!.attempts).toBe(1);

    // Second completion stands (one-shot bounce) and the ladder advances.
    settleMilestone("done again");
    await vi.waitFor(() => expect(storage.get(campaign.id)!.milestones[0]!.status).toBe("green"));
  });

  it("a completion whose last test run was red is not green (mechanical test gate)", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    tasks.verifications.set("task_1", {
      testsGreen: false,
      detail: "PlayMode verification FAILED: 5 of 95 tests failed",
    });
    tasks.emit("task:completed", "task_1", "sprint A complete, everything works great");

    // Routed to the retry path with the red run named — not green.
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    const fresh = storage.get(campaign.id)!;
    expect(fresh.milestones[0]!.status).not.toBe("green");
    expect(tasks.submitted[1]!.prompt).toContain("Tests were RED at completion");

    // A green-verdict completion passes.
    tasks.verifications.set("task_2", { testsGreen: true, detail: "All 95 tests passed" });
    tasks.emit("task:completed", "task_2", "sprint A complete for real");
    await vi.waitFor(() => expect(storage.get(campaign.id)!.milestones[0]!.status).toBe("green"));
  });

  it("capture evidence demands meaningful, non-identical frames", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
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
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    manager.attachEvents();

    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(3));

    // Final sprint: the executor parks task_3 (emitted twice) and its own
    // retry lands completed inside the grace window.
    const retryId = tasks.addRetry("task_3", TaskStatus.completed);
    tasks.markTerminal(retryId, TaskStatus.completed, "final report via retry");
    tasks.verifications.set(retryId, { testsGreen: true, detail: "All 42 tests passed" });
    tasks.emit("task:blocked", "task_3", "Transient failure — worker crashed mid-epoch.");
    tasks.emit("task:blocked", "task_3", "Transient failure — worker crashed mid-epoch.");

    await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"));
    await new Promise((r) => setTimeout(r, 120));
    expect(auditCalls).toBe(1);
    expect(messages.filter((m) => m.text.includes("Campaign delivery"))).toHaveLength(1);
    expect(tasks.submitted).toHaveLength(3);
  });

  it("a delivery whose final sprint never ran a test SAYS so in the report", async () => {
    // Audited 2026-09-02: the delivery gate is one-shot by design, and the
    // report rendered the waived sprint as a clean green — no "tests:" mark,
    // no caveat, under "game build complete".
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(3));

    // Final sprint completes with no observed test run: one delivery bounce.
    tasks.emit("task:completed", "task_3", "everything works, shipping it");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(4));
    // The bounce text demands a captured frame, which arms the visual gate:
    // one visual bounce, then the ladder proceeds.
    tasks.emit("task:completed", "task_4", "shipping it again");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(5));
    tasks.emit("task:completed", "task_5", "shipping it, third time");
    await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"));

    const report = messages.at(-1)!.text;
    expect(report).toContain("Campaign delivery");
    expect(report).toContain("Sprint C — Delivery");
    expect(report).toMatch(/NO observed test run/);
    expect(report).toContain("How these greens were reached");
    expect(report).toMatch(/Sprint C — Delivery: .*never seen to pass/);
  });

  it("revival restores the delivery-verification gate along with the other evidence gates", async () => {
    // Audited 2026-09-02: reviveAtCurrentMilestone reset the visual and
    // no-work bounces ("fresh budget = fresh gates") but not
    // deliveryVerificationBounced, so a revived final sprint could never be
    // bounced for a missing test run again.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(3));

    tasks.emit("task:completed", "task_3", "shipping it"); // delivery bounce spent
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(4));
    expect(storage.get(campaign.id)!.milestones[2]!.deliveryVerificationBounced).toBe(true);
    tasks.emit("task:failed", "task_4", "boom");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(5));
    tasks.emit("task:failed", "task_5", "boom again");
    await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));

    expect(await manager.tryHandleRevive("cli-local", "kampanya devam")).toBe(true);
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(6));
    const revived = storage.get(campaign.id)!.milestones[2]!;
    expect(revived.deliveryVerificationBounced).toBe(false);
    expect(revived.visualEvidenceBounced).toBe(false);

    // The revived sprint completes with no test run: visual bounce first
    // (its prompt now demands a frame), then the delivery gate must bounce
    // again instead of declaring delivery.
    tasks.emit("task:completed", "task_6", "shipping it after revive");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(7));
    tasks.emit("task:completed", "task_7", "shipping it after revive, again");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(8));
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
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    manager.attachEvents();

    try {
      const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));
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
      await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("executing"));
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

    await vi.waitFor(() => expect(storage.get(campaign.id)!.draftTaskId).toBe(retryId));
    expect(tasks.submitted).toHaveLength(1); // no second drafter
    expect(storage.get(campaign.id)!.draftAttempts).toBe(0); // no revision round spent

    // The adopted retry lands the GDD → the approval gate opens normally.
    tasks.emit("task:completed", retryId, "wrote docs/Game_GDD.md");
    await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("awaiting-approval"));
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
      await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));

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
    await vi.waitFor(() => expect(storage.get(campaign.id)!.draftDeferredSince).toBeGreaterThan(0));
    expect(tasks.submitted).toHaveLength(1); // deferred, nothing redrafted

    // 25 hours of exactly this — the tip still promises a retry that never lands.
    const deferring = storage.get(campaign.id)!;
    deferring.draftDeferredSince = Date.now() - 25 * 60 * 60_000;
    storage.save(deferring);
    tasks.updatedAts.set("task_1", Date.now());
    tasks.emit("task:blocked", "task_1", "Reaped: no progress for 15m. Auto-retry 1/10 in ~600s.");

    // Past the bound the outcome is judged: the round is charged (no outage
    // measured here) and a fresh draft is issued with the cause named.
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
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
    await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("awaiting-approval"));
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
    await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("awaiting-approval"));
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
      await vi.waitFor(() => expect(tasks.submitted).toHaveLength(n + 1));
      expect(storage.get(campaign.id)!.draftAttempts).toBe(n);
      expect(tasks.submitted[n]!.prompt).toContain("never wrote the GDD file");
    }
    // The fourth landing without a file exhausts the budget: stop loudly.
    tasks.emit("task:completed", "task_4", "I described the GDD in chat");
    await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));
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
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
    tasks.emit("task:failed", "task_1", "boom");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    tasks.emit("task:failed", "task_2", "boom again");
    await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));

    // The parked milestone carries a deferral clock from a long-ago wall.
    const parked = storage.get(campaign.id)!;
    parked.milestones[0]!.reconcileDeferredSince = Date.now() - 25 * 60 * 60_000;
    storage.save(parked);

    expect(await manager.tryHandleRevive("cli-local", "kampanya devam")).toBe(true);
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(3));
    expect(storage.get(campaign.id)!.milestones[0]!.attempts).toBe(1);

    // The revived attempt's very first reap: the executor promises a retry.
    tasks.emit("task:blocked", "task_3", "Reaped: no progress for 15m. Auto-retry 2/10 in ~600s.");
    await new Promise((r) => setTimeout(r, 250));

    const fresh = storage.get(campaign.id)!;
    expect(tasks.submitted).toHaveLength(3); // deferred, not resubmitted
    expect(fresh.state).toBe("executing");
    expect(fresh.milestones[0]!.attempts).toBe(1); // not charged
    expect(fresh.milestones[0]!.reconcileDeferredSince).toBeGreaterThan(Date.now() - 60_000);
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
    await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("awaiting-approval"));

    const consumed = await Promise.all([
      manager.tryHandleApproval("cli-local", "evet"),
      manager.tryHandleApproval("cli-local", "evet"),
    ]);
    await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("executing"));
    await new Promise((r) => setTimeout(r, 60));

    expect(consumed.filter(Boolean)).toHaveLength(1);
    expect(planMilestones).toHaveBeenCalledTimes(1);
    expect(tasks.submitted).toHaveLength(2); // the draft + exactly one sprint 1
    expect(messages.filter((m) => m.text.includes("Milestone ladder ready"))).toHaveLength(1);
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
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
    expect(readFileSync(join(projectRoot, "docs", "GDD.md"), "utf8")).toBe(v1);

    // The first build ends; the designer revises the document and re-shares it.
    const first = storage.listActive()[0]!;
    first.state = "cancelled";
    storage.save(first);

    expect(await manager.tryHandleIncoming(share(v2))).toBe(true);
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(readFileSync(join(projectRoot, "docs", "GDD.md"), "utf8")).toBe(v2);
    expect(storage.listActive()[0]!.gddPath).toBe("docs/GDD.md");
  });

  it("the failure tail is REPLACED across revives — exactly one tail, the latest", async () => {
    // Audited 2026-09-02: the strip regex ended on "do not repeat it." but the
    // appended tail continues "do not repeat it — and do NOT spend…", so the
    // strip never matched and every revived budget stacked another stale
    // "The previous attempt ended…" block into the persisted sprint prompt.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
    tasks.emit("task:failed", "task_1", "compile exploded in Board.cs");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    tasks.emit("task:failed", "task_2", "compile exploded in Board.cs again");
    await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));

    expect(await manager.tryHandleRevive("cli-local", "kampanya devam")).toBe(true);
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(3));
    tasks.emit("task:failed", "task_3", "PlayMode red: 3 of 9 tests failed");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(4));

    const prompt = storage.get(campaign.id)!.milestones[0]!.prompt;
    expect(prompt.match(/The previous attempt ended/g) ?? []).toHaveLength(1);
    expect(prompt).toContain("PlayMode red: 3 of 9 tests failed");
    expect(prompt).not.toContain("compile exploded");
    expect(prompt).toContain("build the foundations"); // the sprint body survives the strip
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
    } as unknown as CampaignPlanner;
    manager = new CampaignManager({
      storage,
      planner,
      taskManager: tasks as unknown as TaskManager,
      messenger: async (chatId, text) => messages.push({ chatId, text }),
      projectRoot,
      retryAdoptionGraceMs: 10,
      completedSettleDelayMs: 0,
      milestoneTimeBoxMs: 60 * 60_000,
    });
    manager.attachEvents();

    const hugeGdd = "# GDD\n" + "core loop line\n".repeat(Math.ceil(GDD_AUDIT_FULL_CHARS / 15) + 100);
    expect(hugeGdd.length).toBeGreaterThan(GDD_AUDIT_FULL_CHARS);
    const campaign = manager.startFromGdd(ctx, hugeGdd, "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(3));
    settleMilestone("final report");
    await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"));

    expect(storage.get(campaign.id)!.coverageAuditNote).toMatch(/WINDOWED GDD/);
    expect(messages.at(-1)!.text).toContain("WINDOWED GDD");
  });

  it("a green whose visual gate never ran SAYS so in the delivery report", async () => {
    // Audited 2026-09-02: the visual-evidence gate runs only when the
    // planner-authored prompt happens to contain "captur"; nothing validated
    // that it did, and the report had no mark for it — a sprint whose gate
    // never ran rendered byte-identically to one that passed it.
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done"); // LADDER prompts never demand a capture; no Recordings/
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(3));
    settleMilestone("final report");
    await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"));

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
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
    settleMilestone("sprint A done");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    settleMilestone("sprint B done");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(3));

    messengerDownFor = /Campaign delivery/;
    settleMilestone("final sprint done, all tests green");
    await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("done"));
    expect(messages.some((m) => m.text.includes("Campaign delivery"))).toBe(false);
    expect(storage.get(campaign.id)!.deliveryReported).toBe(false);

    // Next boot: the messenger is back and the unreported delivery is re-sent.
    messengerDownFor = undefined;
    await manager.resumeActive();
    await vi.waitFor(() =>
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
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    // The sprint died with the process after running well past its 1h box.
    const running = storage.get(campaign.id)!;
    running.milestones[0]!.startedAtMs = Date.now() - 2 * 60 * 60_000;
    storage.save(running);
    tasks.markTerminal("task_1", TaskStatus.failed, "worker died: compile error CS0246");

    await manager.resumeActive();
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));

    const after = storage.get(campaign.id)!;
    expect(after.milestones[0]!.timeBoxEscalations).toBe(1);
    expect(after.milestones[0]!.prompt).toContain("NARROW THE SCOPE NOW");
    expect(messages.at(-1)!.text).toContain("narrowing scope");
  });

  it("a boot that finds a FAILED tip charges the attempt, and a spent budget stops the campaign", async () => {
    const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
    expect(storage.get(campaign.id)!.milestones[0]!.attempts).toBe(1);

    tasks.markTerminal("task_1", TaskStatus.failed, "compile error CS0246");
    await manager.resumeActive();
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
    expect(storage.get(campaign.id)!.milestones[0]!.attempts).toBe(2); // charged
    expect(tasks.submitted[1]!.prompt).toContain("The previous attempt ended failed");

    // A second restart on a second dead tip: the budget is spent, so the
    // campaign stops loudly instead of relaunching the sprint again.
    tasks.markTerminal("task_2", TaskStatus.failed, "compile error CS0246 again");
    await manager.resumeActive();
    await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));
    expect(tasks.submitted).toHaveLength(2);
    expect(messages.at(-1)!.text).toContain("Campaign stopped");
  });

  it("a boot during a provider outage resubmits the dead tip WITHOUT charging an attempt", async () => {
    // The boot path must inherit the outage exemption too: charging the
    // provider's downtime to the sprint is what pushed healthy sprints to a stop.
    const { ProviderHealthRegistry } = await import("../agents/providers/provider-health.js");
    const { setLiveChainMemberNames } = await import("../agents/providers/provider-outage.js");
    const registry = ProviderHealthRegistry.getInstance();
    registry.clearProviderState("cm-boot");
    registry.recordOverloaded("cm-boot", "quota wall");
    setLiveChainMemberNames(["cm-boot"]);
    try {
      const campaign = manager.startFromGdd(ctx, "# GDD", "docs/Game_GDD.md");
      await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));
      tasks.markTerminal("task_1", TaskStatus.failed, "All providers are in cooldown");

      await manager.resumeActive();
      await vi.waitFor(() => expect(tasks.submitted).toHaveLength(2));
      expect(storage.get(campaign.id)!.milestones[0]!.attempts).toBe(1); // not charged
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
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

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
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

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
      await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("failed"));

      registry.clearProviderState("cm-revive-draft");
      (manager as unknown as { scheduleAutoRevive(id: string, ms: number): void })
        .scheduleAutoRevive(campaign.id, 20);

      await vi.waitFor(() => expect(storage.get(campaign.id)!.state).toBe("drafting-gdd"));
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
    await vi.waitFor(() => expect(tasks.submitted).toHaveLength(1));

    await manager.resumeActive(); // task_1 still 'executing' in the fake
    expect(tasks.submitted).toHaveLength(1);
  });
});

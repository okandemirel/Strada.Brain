import { describe, it, expect } from "vitest";
import {
  describeBuild,
  buildCampaignStatus,
  formatCampaignStatus,
  formatDuration,
  formatGuardianStatus,
  formatMeasurement,
  isRevivable,
} from "./campaign-status.js";
import type { Campaign } from "./types.js";
import type { Task } from "../tasks/types.js";
import { TaskStatus } from "../tasks/types.js";
import type { RealTreeGuardianSnapshot } from "../daemon/real-tree-guardian.js";
import type { BuiltAsSpecifiedReport } from "../agents/autonomy/built-as-specified.js";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;

function campaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: "camp_1",
    chatId: "chat-a",
    channelType: "telegram",
    userId: "u",
    projectRoot: "/proj",
    state: "executing",
    gddPath: "docs/GDD.md",
    draftAttempts: 0,
    currentMilestone: 1,
    createdAt: NOW - 5 * HOUR,
    updatedAt: NOW - 10 * 60_000,
    milestones: [
      { id: "m1", title: "Foundations", prompt: "p", status: "green", attempts: 1, resultExcerpt: "done" },
      {
        id: "m2",
        title: "Core loop",
        prompt: "p",
        status: "running",
        attempts: 1,
        taskId: "task_9",
        startedAtMs: NOW - 2 * HOUR,
        timeBoxEscalations: 1,
        compileVerdict: { ok: false, ran: true, errors: 3 },
        placeholderArtAtStart: { sprites: 519, placeholders: 394 },
      },
      { id: "m3", title: "Polish", prompt: "p", status: "pending", attempts: 0 },
    ],
    ...overrides,
  };
}

function task(id: string, status: TaskStatus, progress: string, createdAt = NOW - HOUR): Task {
  return {
    id,
    chatId: "chat-a",
    title: `Task ${id}`,
    status,
    createdAt,
    updatedAt: NOW - 60_000,
    progress: [{ timestamp: NOW - 3 * 60_000, message: progress }],
  } as unknown as Task;
}

describe("buildCampaignStatus", () => {
  it("copies milestone measurements and resolves the current task and the chat's active tasks", () => {
    const snapshot = buildCampaignStatus(campaign(), {
      maxMilestoneAttempts: 2,
      milestoneTimeBoxMs: 6 * HOUR,
      getTask: (id) => (id === "task_9" ? task("task_9", TaskStatus.executing, "editing PlayerController.cs") : null),
      listTasks: () => [
        task("task_9", TaskStatus.executing, "editing PlayerController.cs"),
        task("task_12", TaskStatus.executing, "placeholder mission node 3"),
        task("task_3", TaskStatus.completed, "old"),
      ],
    });
    expect(snapshot.milestones[1]).toMatchObject({
      id: "m2",
      attempts: 1,
      maxAttempts: 2,
      timeBoxEscalations: 1,
      compileVerdict: { ok: false, ran: true, errors: 3 },
      placeholderArtAtStart: { sprites: 519, placeholders: 394 },
    });
    expect(snapshot.currentTask).toMatchObject({ id: "task_9", lastProgress: "editing PlayerController.cs" });
    expect(snapshot.activeTasks.map((t) => t.id)).toEqual(["task_9", "task_12"]);
    expect(snapshot.revivable).toBe(false);
  });

  it("carries a requirement's closure, which is not the sprint's outcome (Codex 2026-09-12 V#7)", () => {
    // A repair can end unfinished and its requirement be found delivered by
    // the evidence audit afterwards. The snapshot said only the former, so an
    // API reader could not tell a waived requirement from an open one.
    const withClosure = campaign();
    withClosure.milestones[0] = {
      id: "mcov1",
      title: "Coverage completion 1.1 — Boss",
      prompt: "p",
      status: "failed",
      attempts: 2,
      coverageGap: "Boss: absent",
      coverageClosed: true,
      coverageClosedRevision: "a".repeat(40),
    };
    const snapshot = buildCampaignStatus(withClosure, {
      maxMilestoneAttempts: 2,
      milestoneTimeBoxMs: 6 * HOUR,
      getTask: () => null,
      listTasks: () => [],
    });
    expect(snapshot.milestones[0]).toMatchObject({ id: "mcov1", status: "failed", coverageClosed: true });
    // A sprint with no closure says nothing about one.
    expect(snapshot.milestones[2]!.coverageClosed).toBeUndefined();
  });

  it("marks failed, cancelled, and structurally refused campaigns as revivable", () => {
    expect(isRevivable(campaign({ state: "failed" }))).toBe(true);
    expect(isRevivable(campaign({ state: "cancelled" }))).toBe(true);
    expect(isRevivable(campaign({ state: "done" }))).toBe(false);
    const refused = campaign({ state: "done" });
    refused.milestones[2]!.structureRefused = true;
    expect(isRevivable(refused)).toBe(true);
  });
});

describe("formatCampaignStatus", () => {
  it("renders the measured numbers: attempts, time box left, compile errors, placeholder count, progress age", () => {
    const snapshot = buildCampaignStatus(campaign(), {
      maxMilestoneAttempts: 2,
      milestoneTimeBoxMs: 6 * HOUR,
      getTask: () => task("task_9", TaskStatus.executing, "editing PlayerController.cs"),
      listTasks: () => [task("task_9", TaskStatus.executing, "editing PlayerController.cs")],
    });
    const text = formatCampaignStatus(snapshot, NOW);
    expect(text).toContain("camp_1");
    expect(text).toContain("executing");
    expect(text).toContain("1/3 green");
    expect(text).toContain("m2 Core loop — running, attempt 1/2 ◀");
    expect(text).toContain("m3 Polish — pending, attempt 0/2");
    expect(text).toContain("2h 0m elapsed, 4h 0m left, 1 scope narrowing(s)");
    expect(text).toContain("compile RED (3 errors)");
    expect(text).toContain("placeholder sprites at start: 394/519");
    expect(text).toContain("`task_9` — executing, running 1h 0m");
    expect(text).toContain("Last progress (3m ago): editing PlayerController.cs");
    expect(text).not.toContain("Revivable");
  });

  it("renders the delivery evidence: play-through, player build, GDD numbers and the proofs still owed (2026-09-10)", () => {
    const c = campaign({ state: "failed", lastError: "delivery proofs still missing after the bounce budget: …" });
    c.milestones[2] = {
      ...c.milestones[2]!,
      status: "failed",
      playthroughVerdict: { found: true, ok: false, reasons: ["session 1 never ended after 60 actions (phases seen: Playing)"], scene: "Main", session: 1, actions: 60, autoStarted: false },
      buildVerdict: { ran: true, ok: true, target: "StandaloneOSX", artifactPath: "/p/Builds/StandaloneOSX/Game.app", sizeBytes: 88_000_000, durationMs: 118_000 },
      gddClaims: [
        "GDD boot time ≤ 3 s: MET — scene load → services in 2.4 s (editor play mode, batch)",
        "GDD level count = 12: NOT MET — the game's session catalog reports 3",
        'GDD frame rate ≥ 60 fps: NOT MEASURED — 25.0 fps loop rate … (GDD: "60 fps")',
      ],
      deliveryProofsMissing: ["play-through FAILED in Main: session 1 never ended after 60 actions (phases seen: Playing)", "THE GDD'S OWN NUMBERS ARE NOT MET: level count = 12 measured 3"],
    };
    const text = formatCampaignStatus(
      buildCampaignStatus(c, { maxMilestoneAttempts: 2, milestoneTimeBoxMs: 6 * HOUR, getTask: () => null, listTasks: () => [] }),
      NOW,
    );
    expect(text).toContain("🎮 play-through FAILED in Main: session 1 never ended after 60 actions");
    expect(text).toContain("📦 player built: /p/Builds/StandaloneOSX/Game.app (StandaloneOSX, 83.9 MB, 118 s)");
    expect(text).toContain("📐 GDD numbers: 1 met, 1 NOT met, 1 not measured — GDD level count = 12: NOT MET — the game's session catalog reports 3");
    expect(text).toContain("⛔ proofs still missing: play-through FAILED in Main");
    expect(describeBuild({ ran: false, detail: "no player builder is configured" })).toBe("player build NOT measured — no player builder is configured");
    expect(describeBuild({ ran: true, ok: false, reasons: ["build failed with exit code 21"] })).toBe("player build FAILED — build failed with exit code 21");
  });

  it("says when the compile verdict was not measured and when a campaign can be revived", () => {
    const c = campaign({ state: "failed", lastError: "All providers failed or unavailable", autoReviveAt: NOW + 30 * 60_000 });
    c.milestones[1]!.compileVerdict = { ok: true, ran: false };
    c.milestones[1]!.status = "failed";
    const snapshot = buildCampaignStatus(c, {
      maxMilestoneAttempts: 2,
      milestoneTimeBoxMs: 6 * HOUR,
      getTask: () => null,
      listTasks: () => [],
    });
    const text = formatCampaignStatus(snapshot, NOW);
    expect(text).toContain("compile NOT MEASURED");
    expect(text).toContain("Last error: All providers failed or unavailable");
    expect(text).toContain("Self-revival armed in 30m");
    expect(text).toContain("/campaign revive");
  });

  it("a settled current task 'lasted', it is not 'running' (seen live 2026-09-09: cancelled · running 8h 37m)", () => {
    const c = campaign({ state: "done" });
    const snapshot = buildCampaignStatus(c, {
      maxMilestoneAttempts: 2,
      milestoneTimeBoxMs: HOUR,
      getTask: () => ({ ...task("task_9", TaskStatus.cancelled, "planning done", NOW - 9 * HOUR), updatedAt: NOW - 8 * HOUR } as Task),
      listTasks: () => [],
    });
    const text = formatCampaignStatus(snapshot, NOW);
    expect(text).toContain("`task_9` — cancelled, lasted 1h 0m");
    expect(text).not.toContain("cancelled, running");
  });

  it("reports whether a done campaign's delivery report reached the channel", () => {
    const base = { maxMilestoneAttempts: 2, milestoneTimeBoxMs: HOUR, getTask: () => null, listTasks: () => [] };
    expect(formatCampaignStatus(buildCampaignStatus(campaign({ state: "done", deliveryReported: true }), base), NOW)).toContain(
      "Delivery report was sent",
    );
    expect(formatCampaignStatus(buildCampaignStatus(campaign({ state: "done" }), base), NOW)).toContain(
      "Delivery report is pending",
    );
  });
});

describe("formatGuardianStatus", () => {
  const base: RealTreeGuardianSnapshot = {
    projectRoot: "/proj",
    lastVerdict: "unknown",
    lastCheckedAt: 0,
    lastDetail: "",
    fixTaskStartedAt: 0,
    fixAttempts: 0,
    maxFixAttempts: 3,
    attemptsWithoutProgress: 0,
    escalated: false,
    blindStreak: 0,
    nextVerifyAt: 0,
  };

  it("never calls an unverified tree green", () => {
    const text = formatGuardianStatus(base, NOW);
    expect(text).toContain("tree unknown");
    expect(text).toContain("last verified never");
  });

  it("shows the red verdict with its count, the fix task, and the escalation", () => {
    const text = formatGuardianStatus(
      {
        ...base,
        lastVerdict: "red",
        lastCheckedAt: NOW - 4 * 60_000,
        lastErrorCount: 3,
        bestErrorCount: 3,
        lastDetail: "error CS0246: The type or namespace name 'Foo' could not be found",
        fixTaskId: "task_fix",
        fixTaskStartedAt: NOW - 9 * 60_000,
        fixAttempts: 2,
        nextVerifyAt: NOW + 60_000,
      },
      NOW,
    );
    expect(text).toContain("tree red, last verified 4m ago");
    expect(text).toContain("Errors: 3 (best this episode 3)");
    expect(text).toContain("Fix task `task_fix` running 9m (attempt 2/3)");
    expect(text).toContain("Next verification in 1m");
    expect(text).toContain("CS0246");
    expect(formatGuardianStatus({ ...base, lastVerdict: "red", escalated: true }, NOW)).toContain("Escalated");
  });

  it("states a blind verifier as not watching, with the streak and reason", () => {
    const text = formatGuardianStatus({ ...base, lastVerdict: "blind", blindStreak: 4, lastDetail: "bridge down" }, NOW);
    expect(text).toContain("tree blind");
    expect(text).toContain("could not run for 4 consecutive check(s): bridge down");
  });
});

describe("formatMeasurement", () => {
  const report: BuiltAsSpecifiedReport = {
    measured: true,
    scenes: [],
    shippedScenes: [{ scene: "Assets/Scenes/Main.unity" } as never, { scene: "Assets/Scenes/Menu.unity" } as never],
    shippedRenderers: 27,
    shippedWorldRenderers: 20,
    referencedOnlyRenderers: 0,
    shippedProjectRefs: 40,
    shippedBuiltInRefs: 2,
    shippedMeshRenderers: 5,
    shippedSpriteRenderers: 22,
    artInventory: { prefabs: 31, models: 0, sprites: 519, placeholderSprites: 394, audio: 29, duplicateAudio: 4, shortAudio: 19 },
    unboundPrefabs: ["a", "b"],
    unboundModels: [],
    unboundSprites: new Array(7).fill("s"),
    placeholderSpritePaths: [],
    boundPlaceholderSprites: 12,
    primitiveScripts: ["Assets/Scripts/Gen.cs"],
    primitiveCallSites: 3,
    refusal: "the shipped scene renders 0 project sprites",
    disclosures: [],
    incomplete: [],
  };

  it("prints every gate count verbatim", () => {
    const text = formatMeasurement(report, "/proj", NOW);
    expect(text).toContain("Structural refusal: the shipped scene renders 0 project sprites");
    expect(text).toContain("Shipped scenes* (2): Assets/Scenes/Main.unity, Assets/Scenes/Menu.unity");
    expect(text).toContain("Renderers in shipped scenes: 27 (20 world, 22 sprite, 5 mesh)");
    expect(text).toContain("Prefabs 31 · models 0 · sprites 519");
    expect(text).toContain("Placeholder-grade sprites: 394 (12 bound in shipped scenes)");
    expect(text).toContain("Audio 29 (19 short, 4 duplicate)");
    expect(text).toContain("Unbound: 2 prefabs, 0 models, 7 sprites");
    expect(text).toContain("Geometry built in code: 3 call site(s) in 1 script(s)");
  });

  it("refuses to print counts for an unmeasured project", () => {
    const text = formatMeasurement({ ...report, measured: false }, "/proj", NOW);
    expect(text).toContain("Not measured");
    expect(text).not.toContain("519");
  });
});

describe("formatDuration", () => {
  it("rounds down to minutes, hours, and days", () => {
    expect(formatDuration(59_000)).toBe("0m");
    expect(formatDuration(HOUR + 5 * 60_000)).toBe("1h 5m");
    expect(formatDuration(26 * HOUR)).toBe("1d 2h");
    expect(formatDuration(-5)).toBe("0m");
  });
});

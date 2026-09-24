import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { CommandHandler, chatChannelAccessFromConfig, chatInstanceAuthority } from "./command-handler.js";
import { DMPolicy } from "../security/dm-policy.js";
import { UserProfileStore } from "../memory/unified/user-profile-store.js";
import { UnifiedBudgetManager } from "../budget/unified-budget-manager.js";

describe("CommandHandler /model", () => {
  const sendMarkdown = vi.fn();
  const sendText = vi.fn();

  beforeEach(() => {
    sendMarkdown.mockReset();
    sendText.mockReset();
    sendMarkdown.mockResolvedValue(undefined);
    sendText.mockResolvedValue(undefined);
  });

  it("sets a hard pin explicitly", async () => {
    const setPreference = vi.fn();
    const getActiveInfo = vi.fn(() => ({
      providerName: "kimi",
      model: "kimi-max",
      isDefault: false,
      selectionMode: "strada-hard-pin",
      executionPolicyNote: "Hard pin active.",
    }));
    const handler = new CommandHandler(
      {} as never,
      {
        sendMarkdown,
        sendText,
      } as never,
      {
        isAvailable: () => true,
        setPreference,
        getActiveInfo,
        listExecutionCandidates: () => [],
        listAvailable: () => [],
      } as never,
    );

    await handler.handle("chat-1", "model", ["pin", "kimi/kimi-max"], "user-42");

    expect(setPreference).toHaveBeenCalledWith("user-42", "kimi", "kimi-max", "strada-hard-pin");
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("hard-pinned"),
    );
  });

  it("removes a hard pin by converting it back into a routing bias", async () => {
    const setPreference = vi.fn();
    const getActiveInfo = vi.fn(() => ({
      providerName: "kimi",
      model: "kimi-max",
      isDefault: false,
      selectionMode: "strada-hard-pin",
      executionPolicyNote: "Bias active.",
    }));
    const handler = new CommandHandler(
      {} as never,
      {
        sendMarkdown,
        sendText,
      } as never,
      {
        isAvailable: () => true,
        setPreference,
        getActiveInfo,
        listExecutionCandidates: () => [],
        listAvailable: () => [],
      } as never,
    );

    await handler.handle("chat-1", "model", ["unpin"], "user-42");

    expect(setPreference).toHaveBeenCalledWith("user-42", "kimi", "kimi-max", "strada-preference-bias");
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Removed the hard pin"),
    );
  });
});

describe("CommandHandler /routing", () => {
  const sendMarkdown = vi.fn();
  const sendText = vi.fn();

  beforeEach(() => {
    sendMarkdown.mockReset();
    sendText.mockReset();
    sendMarkdown.mockResolvedValue(undefined);
    sendText.mockResolvedValue(undefined);
  });

  it("renders recent routing decisions together with runtime execution traces", async () => {
    const handler = new CommandHandler(
      {} as never,
      {
        sendMarkdown,
        sendText,
      } as never,
      {
        listAvailable: () => [],
      } as never,
      undefined,
      undefined,
      undefined,
      {
        getRecentArtifactsForIdentity: () => [
          {
            id: "artifact-1",
            kind: "workflow",
            state: "active",
            name: "Compile Fix Loop",
            description: "Reusable compile fix loop",
            lastStateReason: "Promoted after clean verifier runs.",
            projectWorldFingerprint: "unity:pooling",
            stats: {
              shadowSampleCount: 5,
              activeUseCount: 4,
              cleanCount: 4,
              retryCount: 1,
              failureCount: 0,
              blockerCount: 0,
              harmfulCount: 0,
              recentEvaluations: [],
              regressionFingerprints: {},
            },
            updatedAt: Date.now(),
          },
        ],
      } as never,
      "unity:pooling",
    );

    handler.setProviderRouter({
      getPreset: () => "balanced",
      setPreset: () => {},
      getRecentDecisions: () => [
        {
          provider: "kimi",
          reason: "best planner",
          task: { type: "planning", complexity: "moderate", criticality: "normal" },
          timestamp: Date.now(),
        },
      ],
      getRecentExecutionTraces: () => [
        {
          provider: "kimi",
          model: "kimi-for-coding",
          role: "executor",
          phase: "executing",
          source: "tool-turn-affinity",
          reason: "kept the active tool-turn provider pinned to preserve provider-specific tool context",
          task: { type: "coding", complexity: "complex", criticality: "normal" },
          timestamp: Date.now(),
        },
        {
          provider: "gemini",
          model: "gemini-2.5-pro",
          role: "reviewer",
          phase: "clarification-review",
          source: "clarification-review",
          reason: "reviewed whether a proposed user question should stay internal",
          task: { type: "bug-analysis", complexity: "complex", criticality: "high" },
          timestamp: Date.now() + 1,
        },
      ],
      getRecentPhaseOutcomes: () => [
        {
          provider: "reviewer",
          model: "review-model",
          role: "reviewer",
          phase: "completion-review",
          source: "completion-review",
          status: "replanned",
          reason: "Verifier review requested a new approach.",
          task: { type: "code-review", complexity: "complex", criticality: "high" },
          timestamp: Date.now() + 2,
        },
      ],
      getPhaseScoreboard: () => [
        {
          provider: "reviewer",
          role: "reviewer",
          phase: "completion-review",
          sampleSize: 3,
          score: 0.82,
          approvedCount: 2,
          continuedCount: 0,
          replannedCount: 1,
        blockedCount: 0,
        failedCount: 0,
        verifierSampleSize: 3,
        verifierCleanRate: 0.72,
        rollbackRate: 0.33,
        avgRetryCount: 1.33,
        avgTokenCost: 420,
        repeatedFailureCount: 1,
        latestTimestamp: Date.now() + 3,
        latestReason: "Verifier review requested a new approach.",
      },
      ],
    });

    await handler.handle("chat-1", "routing", ["info"], "user-1");

    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("*Recent Routing Decisions*"),
    );
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("*Recent Runtime Execution*"),
    );
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("`executing/executor` -> `kimi`"),
    );
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("model=`kimi-for-coding`"),
    );
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("source=`tool-turn-affinity`"),
    );
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("`clarification-review/reviewer` -> `gemini`"),
    );
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("*Recent Phase Outcomes*"),
    );
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("status=`replanned`"),
    );
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("*Adaptive Phase Scores*"),
    );
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("score=`0.82`"),
    );
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("verifier=`0.72`"),
    );
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("*Runtime Self-Improvement*"),
    );
    expect(sendText).not.toHaveBeenCalled();
  });

  it("reports an empty state when no routing or execution history exists", async () => {
    const handler = new CommandHandler(
      {} as never,
      {
        sendMarkdown,
        sendText,
      } as never,
      {
        listAvailable: () => [],
      } as never,
    );

    handler.setProviderRouter({
      getPreset: () => "balanced",
      setPreset: () => {},
      getRecentDecisions: () => [],
      getRecentExecutionTraces: () => [],
      getRecentPhaseOutcomes: () => [],
      getPhaseScoreboard: () => [],
    });

    await handler.handle("chat-1", "routing", ["info"], "user-1");

    expect(sendText).toHaveBeenCalledWith("chat-1", "No routing decisions recorded yet.");
    expect(sendMarkdown).not.toHaveBeenCalled();
  });
});

describe("CommandHandler /vault", () => {
  const sendMarkdown = vi.fn();
  const sendText = vi.fn();

  beforeEach(() => {
    sendMarkdown.mockReset();
    sendText.mockReset();
    sendMarkdown.mockResolvedValue(undefined);
    sendText.mockResolvedValue(undefined);
  });

  it("reports registered vault status", async () => {
    const vault = {
      id: "unity:abc",
      stats: vi.fn().mockResolvedValue({
        fileCount: 4,
        chunkCount: 9,
        lastIndexedAt: 123,
        dbBytes: 2048,
      }),
    };
    const handler = new CommandHandler(
      {} as never,
      { sendMarkdown, sendText } as never,
    );
    handler.setVaultRegistry({
      list: () => [vault],
      get: () => vault,
    } as never);

    await handler.handle("chat-1", "vault" as never, ["status"], "user-1");

    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("unity:abc: 4 files, 9 chunks"),
    );
  });

  it("initializes and registers a vault from a path", async () => {
    const vault = {
      id: "unity:new",
      init: vi.fn().mockResolvedValue(undefined),
      startWatch: vi.fn().mockResolvedValue(undefined),
      stats: vi.fn().mockResolvedValue({
        fileCount: 1,
        chunkCount: 2,
        lastIndexedAt: 123,
        dbBytes: 512,
      }),
    };
    const createAndRegister = vi.fn().mockResolvedValue(vault);
    const handler = new CommandHandler(
      {} as never,
      { sendMarkdown, sendText } as never,
    );
    handler.setVaultRegistry({
      createAndRegister,
      list: () => [vault],
      get: (id: string) => id === "unity:new" ? vault : undefined,
    } as never);

    await handler.handle("chat-1", "vault" as never, ["init", "/tmp/project"], "user-1");

    expect(createAndRegister).toHaveBeenCalledWith("/tmp/project");
    expect(vault.init).toHaveBeenCalled();
    expect(vault.startWatch).toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("vault unity:new initialized"),
    );
  });

  it("syncs all registered vaults when no vault id is supplied", async () => {
    const vault = {
      id: "unity:abc",
      sync: vi.fn().mockResolvedValue({ changed: 3, durationMs: 17 }),
    };
    const handler = new CommandHandler(
      {} as never,
      { sendMarkdown, sendText } as never,
    );
    handler.setVaultRegistry({
      list: () => [vault],
      get: () => vault,
    } as never);

    await handler.handle("chat-1", "vault" as never, ["sync"], "user-1");

    expect(vault.sync).toHaveBeenCalled();
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("unity:abc: 3 file(s) reindexed in 17ms"),
    );
  });
});

describe("CommandHandler /autonomous", () => {
  it("uses the configured default hours when none are provided", async () => {
    const db = new Database(":memory:");
    const userProfileStore = new UserProfileStore(db);
    const channel = {
      sendMarkdown: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue(undefined),
    };
    const handler = new CommandHandler(
      {} as never,
      channel as never,
      undefined,
      new DMPolicy(channel as never),
      userProfileStore,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        autonomousDefaultEnabled: true,
        autonomousDefaultHours: 36,
      },
    );

    const before = Date.now();
    await handler.handle("chat-1", "autonomous", ["on"], "user-42");
    const result = await userProfileStore.isAutonomousMode("user-42");

    expect(result.enabled).toBe(true);
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 35 * 3600_000);
    expect(result.expiresAt).toBeLessThanOrEqual(before + 36 * 3600_000 + 5_000);
    expect(channel.sendText).toHaveBeenCalledWith(
      "chat-1",
      "Autonomous mode enabled for 36 hours. I'll execute tasks without asking for approval.",
    );
    db.close();
  });

  it("hydrates autonomous status from the configured defaults without overriding explicit off", async () => {
    const db = new Database(":memory:");
    const userProfileStore = new UserProfileStore(db);
    const channel = {
      sendMarkdown: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue(undefined),
    };
    const dmPolicy = new DMPolicy(channel as never);
    const handler = new CommandHandler(
      {} as never,
      channel as never,
      undefined,
      dmPolicy,
      userProfileStore,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        autonomousDefaultEnabled: true,
        autonomousDefaultHours: 12,
      },
    );

    await handler.handle("chat-1", "autonomous", [], "user-42");
    expect(dmPolicy.isAutonomousActive("chat-1", "user-42")).toBe(true);
    expect(channel.sendText).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Autonomous mode is enabled."),
    );

    await userProfileStore.setAutonomousMode("user-42", false);
    channel.sendText.mockClear();

    await handler.handle("chat-1", "autonomous", [], "user-42");
    expect(channel.sendText).toHaveBeenCalledWith(
      "chat-1",
      "Autonomous mode is currently disabled.",
    );
    db.close();
  });
});

describe("CommandHandler /token", () => {
  const sendMarkdown = vi.fn();
  const sendText = vi.fn();

  beforeEach(() => {
    sendMarkdown.mockReset();
    sendText.mockReset();
    sendMarkdown.mockResolvedValue(undefined);
    sendText.mockResolvedValue(undefined);
  });

  function createHandlerWithBudgetManager(updateConfig: ReturnType<typeof vi.fn>) {
    const handler = new CommandHandler(
      {} as never,
      { sendMarkdown, sendText } as never,
    );
    handler.setUnifiedBudgetManager({
      updateConfig,
    } as unknown as UnifiedBudgetManager);
    return handler;
  }

  it("sets a specific token budget", async () => {
    const updateConfig = vi.fn();
    const handler = createHandlerWithBudgetManager(updateConfig);

    await handler.handle("chat-1", "token", ["50000"], "user-42");

    expect(updateConfig).toHaveBeenCalledWith({ interactiveTokenBudget: 50000 });
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("50,000 token"),
    );
  });

  it("sets unlimited token budget with -1", async () => {
    const updateConfig = vi.fn();
    const handler = createHandlerWithBudgetManager(updateConfig);

    await handler.handle("chat-1", "token", ["-1"], "user-42");

    expect(updateConfig).toHaveBeenCalledWith({ interactiveTokenBudget: -1 });
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("unlimited"),
    );
  });

  it("rejects budgets below the minimum threshold", async () => {
    const updateConfig = vi.fn();
    const handler = createHandlerWithBudgetManager(updateConfig);

    await handler.handle("chat-1", "token", ["500"], "user-42");

    expect(updateConfig).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("1,000"),
    );
  });

  it("rejects invalid token budget input", async () => {
    const updateConfig = vi.fn();
    const handler = createHandlerWithBudgetManager(updateConfig);

    await handler.handle("chat-1", "token", ["abc"], "user-42");

    expect(updateConfig).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Could not parse"),
    );
  });
});

describe("CommandHandler /run", () => {
  const sendMarkdown = vi.fn();
  const sendText = vi.fn();

  beforeEach(() => {
    sendMarkdown.mockReset();
    sendText.mockReset();
    sendMarkdown.mockResolvedValue(undefined);
    sendText.mockResolvedValue(undefined);
  });

  it("shows usage and runs nothing when the command is empty", async () => {
    const requestConfirmation = vi.fn().mockResolvedValue("Yes");
    const handler = new CommandHandler(
      {} as never,
      { sendMarkdown, sendText, requestConfirmation } as never,
    );
    handler.setProjectPath(process.cwd());

    await handler.handle("chat-1", "run", [], "user-1");

    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith("chat-1", expect.stringContaining("Usage: /run"));
  });

  it("reports unavailable when no project path is configured", async () => {
    const requestConfirmation = vi.fn().mockResolvedValue("Yes");
    const handler = new CommandHandler(
      {} as never,
      { sendMarkdown, sendText, requestConfirmation } as never,
    );
    // No setProjectPath() call.

    await handler.handle("chat-1", "run", ["echo", "hi"], "user-1");

    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Shell execution is not available"),
    );
  });

  it("requests confirmation and runs the command when approved", async () => {
    const requestConfirmation = vi.fn().mockResolvedValue("Yes");
    const handler = new CommandHandler(
      {} as never,
      { sendMarkdown, sendText, requestConfirmation } as never,
    );
    handler.setProjectPath(process.cwd());

    await handler.handle("chat-1", "run", ["echo", "strada-run-ok"], "user-1");

    expect(requestConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "chat-1",
        userId: "user-1",
        details: expect.stringContaining("echo strada-run-ok"),
      }),
    );
    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("strada-run-ok"),
    );
  });

  it("cancels without running when the user declines confirmation", async () => {
    const requestConfirmation = vi.fn().mockResolvedValue("No");
    const handler = new CommandHandler(
      {} as never,
      { sendMarkdown, sendText, requestConfirmation } as never,
    );
    handler.setProjectPath(process.cwd());

    await handler.handle("chat-1", "run", ["echo", "should-not-run"], "user-1");

    expect(requestConfirmation).toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Command cancelled"),
    );
    expect(sendMarkdown).not.toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("should-not-run"),
    );
  });

  it("declines on a non-interactive channel that cannot confirm", async () => {
    const handler = new CommandHandler(
      {} as never,
      { sendMarkdown, sendText } as never, // no requestConfirmation → not interactive
    );
    handler.setProjectPath(process.cwd());

    await handler.handle("chat-1", "run", ["echo", "no-confirm"], "user-1");

    expect(sendText).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Command cancelled"),
    );
    expect(sendMarkdown).not.toHaveBeenCalled();
  });
});

describe("CommandHandler build commands (/campaign, /measure, /guardian)", () => {
  const sendMarkdown = vi.fn();
  const sendText = vi.fn();
  const NOW = 1_800_000_000_000;

  function makeHandler() {
    return new CommandHandler(
      { listTasks: () => [], getStatus: () => null } as never,
      { sendMarkdown, sendText } as never,
    );
  }

  const snapshot = {
    id: "camp_7",
    chatId: "c",
    channelType: "telegram",
    state: "executing" as const,
    projectRoot: "/p",
    createdAt: NOW - 3_600_000,
    updatedAt: NOW,
    currentMilestone: 0,
    milestones: [
      { id: "m1", title: "Core", status: "running" as const, attempts: 1, maxAttempts: 2, timeBoxEscalations: 0, structureRefused: false, startedAtMs: NOW - 600_000 },
      { id: "m2", title: "Polish", status: "pending" as const, attempts: 0, maxAttempts: 2, timeBoxEscalations: 0, structureRefused: false },
    ],
    milestoneTimeBoxMs: 6 * 3_600_000,
    deliveryReported: false,
    revivable: false,
    activeTasks: [],
  };

  const guardianSnapshot = {
    projectRoot: "/p",
    lastVerdict: "red" as const,
    lastCheckedAt: NOW - 60_000,
    lastErrorCount: 2,
    lastDetail: "error CS0001",
    fixTaskId: "task_fix",
    fixTaskStartedAt: NOW - 120_000,
    fixAttempts: 1,
    maxFixAttempts: 3,
    attemptsWithoutProgress: 0,
    escalated: false,
    blindStreak: 0,
    nextVerifyAt: 0,
  };

  beforeEach(() => {
    sendMarkdown.mockReset();
    sendText.mockReset();
    sendMarkdown.mockResolvedValue(undefined);
    sendText.mockResolvedValue(undefined);
  });

  it("/campaign renders the campaign snapshot and the guardian verdict together", async () => {
    const handler = makeHandler();
    const describeStatus = vi.fn(() => snapshot);
    handler.setCampaignManager({ describeStatus, reviveByCommand: vi.fn() });
    handler.setRealTreeGuardian({ snapshot: () => guardianSnapshot });

    await handler.handle("chat-1", "campaign", []);

    expect(describeStatus).toHaveBeenCalledWith("chat-1");
    const text = String(sendMarkdown.mock.calls[0]?.[1]);
    expect(text).toContain("camp_7");
    expect(text).toContain("m1 Core — running, attempt 1/2");
    expect(text).toContain("Real-tree guardian");
    expect(text).toContain("Errors: 2");
    expect(text).toContain("task_fix");
  });

  it("/campaign without a campaign layer or without a campaign says so instead of inventing one", async () => {
    const handler = makeHandler();
    await handler.handle("chat-1", "campaign", []);
    expect(String(sendText.mock.calls[0]?.[1])).toMatch(/campaign layer is not running/);

    handler.setCampaignManager({ describeStatus: () => undefined, reviveByCommand: vi.fn() });
    await handler.handle("chat-1", "campaign", []);
    expect(String(sendText.mock.calls[1]?.[1])).toMatch(/No campaign for this project yet/);
    expect(sendMarkdown).not.toHaveBeenCalled();
  });

  it("/campaign revive goes through the campaign's own revive path and reports when nothing is revivable", async () => {
    const handler = makeHandler();
    const reviveByCommand = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    handler.setCampaignManager({ describeStatus: () => snapshot, reviveByCommand });

    await handler.handle("chat-1", "campaign", ["revive"]);
    expect(reviveByCommand).toHaveBeenCalledWith("chat-1");
    expect(sendText).not.toHaveBeenCalled();

    await handler.handle("chat-1", "campaign", ["devam"]);
    expect(String(sendText.mock.calls[0]?.[1])).toMatch(/Nothing to revive/);
  });

  it("/measure runs the delivery-gate measurement on the configured project and prints its counts", async () => {
    const handler = makeHandler();
    handler.setProjectPath("/proj");
    const measurer = vi.fn(() => ({
      measured: true,
      scenes: [],
      shippedScenes: [{ scene: "Assets/Main.unity" }],
      shippedRenderers: 9,
      shippedWorldRenderers: 8,
      referencedOnlyRenderers: 0,
      shippedProjectRefs: 5,
      shippedBuiltInRefs: 0,
      shippedMeshRenderers: 1,
      shippedSpriteRenderers: 8,
      artInventory: { prefabs: 3, models: 0, sprites: 50, placeholderSprites: 41, audio: 2, duplicateAudio: 0, shortAudio: 1 },
      unboundPrefabs: [],
      unboundModels: [],
      unboundSprites: ["x"],
      placeholderSpritePaths: [],
      boundPlaceholderSprites: 4,
      primitiveScripts: [],
      primitiveCallSites: 0,
      disclosures: [],
      incomplete: [],
    }));
    handler.setDeliveryMeasurer(measurer as never);

    await handler.handle("chat-1", "measure", []);
    expect(measurer).toHaveBeenCalledWith("/proj");
    const text = String(sendMarkdown.mock.calls[0]?.[1]);
    expect(text).toContain("Placeholder-grade sprites: 41 (4 bound in shipped scenes)");
    expect(text).toContain("Unbound: 0 prefabs, 0 models, 1 sprites");

    // `/campaign measure` is the same measurement.
    await handler.handle("chat-1", "campaign", ["measure"]);
    expect(measurer).toHaveBeenCalledTimes(2);
  });

  it("/measure without a project path or with a failing measurer reports the cause", async () => {
    const handler = makeHandler();
    await handler.handle("chat-1", "measure", []);
    expect(String(sendText.mock.calls[0]?.[1])).toMatch(/No project path/);

    handler.setProjectPath("/proj");
    handler.setDeliveryMeasurer(() => {
      throw new Error("EACCES");
    });
    await handler.handle("chat-1", "measure", []);
    expect(String(sendText.mock.calls[1]?.[1])).toMatch(/Measurement failed: EACCES/);
    expect(sendMarkdown).not.toHaveBeenCalled();
  });

  it("/guardian renders the guardian snapshot alone", async () => {
    const handler = makeHandler();
    await handler.handle("chat-1", "guardian", []);
    expect(String(sendText.mock.calls[0]?.[1])).toMatch(/guardian is not running/);

    handler.setRealTreeGuardian({ snapshot: () => guardianSnapshot });
    await handler.handle("chat-1", "guardian", []);
    expect(String(sendMarkdown.mock.calls[0]?.[1])).toContain("tree red");
  });

  it("/status with no active tasks points at the campaign when one exists", async () => {
    const handler = makeHandler();
    handler.setCampaignManager({ describeStatus: () => snapshot, reviveByCommand: vi.fn() });
    await handler.handle("chat-1", "status", []);
    const text = String(sendMarkdown.mock.calls[0]?.[1]);
    expect(text).toContain("No active tasks.");
    expect(text).toContain("Campaign `camp_7`: executing, 0/2 milestones green · on m1 (attempt 1/2)");
  });

  it("/help lists the build commands", async () => {
    const handler = makeHandler();
    await handler.handle("chat-1", "help", []);
    const text = String(sendMarkdown.mock.calls[0]?.[1]);
    expect(text).toContain("/campaign");
    expect(text).toContain("/measure");
    expect(text).toContain("/guardian");
  });
});

describe("CommandHandler /resume", () => {
  const sendText = vi.fn();
  const sendMarkdown = vi.fn();
  beforeEach(() => {
    sendText.mockReset();
    sendMarkdown.mockReset();
    sendText.mockResolvedValue(undefined);
    sendMarkdown.mockResolvedValue(undefined);
  });

  const handlerWith = (status: string | null) =>
    new CommandHandler(
      {
        resumeTask: () => null,
        getStatus: () => (status === null ? null : { id: "task_1", status }),
        listTasks: () => [],
      } as never,
      { sendText, sendMarkdown } as never,
    );

  it("names the task's real status and the command that applies (measured 2026-09-10: a blocked mission answered 'may not be paused')", async () => {
    await handlerWith("blocked").handle("chat-1", "resume", ["task_1"], "user-1");
    expect(sendText).toHaveBeenCalledWith("chat-1", "Task task_1 is blocked, not paused. Use /retry to run it again.");
  });

  it("a paused task that still cannot resume says why", async () => {
    await handlerWith("paused").handle("chat-1", "resume", ["task_1"], "user-1");
    expect(sendText).toHaveBeenCalledWith("chat-1", expect.stringContaining("is paused but could not be resumed"));
  });

  it("an unknown id is said to be unknown", async () => {
    await handlerWith(null).handle("chat-1", "resume", ["task_9"], "user-1");
    expect(sendText).toHaveBeenCalledWith("chat-1", "Could not resume task task_9: no such task.");
  });
});


describe("/cancel says WHO stopped the work (Codex 2026-09-11 K#6)", () => {
  it("marks the cancellation as a person's, so a campaign obeys it", () => {
    const source = readFileSync("src/tasks/command-handler.ts", "utf8");
    const at = source.indexOf("this.taskManager.cancel(taskId");
    expect(at).toBeGreaterThan(0);
    // An automatic retirement carries no reason; only a person's stop does,
    // and that difference is what keeps an executor cancellation from
    // stranding an autonomous campaign.
    expect(source.slice(at, at + 80)).toContain('{ reason: "user" }');
  });
});

describe("Chat task and daemon commands act only for their owner (TSK-6)", () => {
  interface FakeTask {
    id: string;
    chatId: string;
    userId?: string;
    origin?: "user" | "daemon";
    status: string;
    title: string;
    prompt: string;
    result?: string;
    progress: never[];
    createdAt: number;
    updatedAt: number;
  }
  const sendText = vi.fn();
  const sendMarkdown = vi.fn();
  let tasks: Map<string, FakeTask>;
  let taskManager: {
    getStatus: ReturnType<typeof vi.fn>;
    listTasks: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    pauseTask: ReturnType<typeof vi.fn>;
    resumeTask: ReturnType<typeof vi.fn>;
  };
  const task = (id: string, chatId: string, extra: Partial<FakeTask> = {}): FakeTask => ({
    id, chatId, status: "executing", title: `title of ${id}`, prompt: `secret prompt of ${id}`,
    result: `secret result of ${id}`, progress: [], createdAt: 1, updatedAt: 1, ...extra,
  });

  beforeEach(() => {
    sendText.mockReset().mockResolvedValue(undefined);
    sendMarkdown.mockReset().mockResolvedValue(undefined);
    tasks = new Map([
      ["task_a1", task("task_a1", "chat-A", { userId: "alice" })],
      ["task_g1", task("task_g1", "group", { userId: "alice" })],
      ["task_d1", task("task_d1", "daemon", { origin: "daemon" })],
      ["task_l1", task("task_l1", "chat-A")],
    ]);
    taskManager = {
      getStatus: vi.fn((id: string) => tasks.get(id) ?? null),
      listTasks: vi.fn((chatId: string) => [...tasks.values()].filter((t) => t.chatId === chatId)),
      cancel: vi.fn(() => true),
      pauseTask: vi.fn(() => true),
      resumeTask: vi.fn(() => ({ id: "x" })),
    };
  });

  const handlerWith = (opts: {
    authority?: ReturnType<typeof chatInstanceAuthority>;
    daemon?: { stop: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> };
  } = {}) => {
    const handler = new CommandHandler(
      taskManager as never,
      { sendText, sendMarkdown } as never,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      opts.authority ? { instanceAuthority: opts.authority } : {},
    );
    if (opts.daemon) {
      handler.setHeartbeatLoop({
        start: opts.daemon.start,
        stop: opts.daemon.stop,
        isRunning: () => true,
        getDaemonStatus: () => ({ running: true, intervalMs: 1000, triggerCount: 0, lastTick: null }),
      });
    }
    return handler;
  };
  const allOutput = () =>
    [...sendText.mock.calls, ...sendMarkdown.mock.calls].map((c) => String(c[1])).join("\n");

  it("another chat's /cancel, /pause, /resume <id> is answered 'not found' and leaves the task alone", async () => {
    const handler = handlerWith();
    await handler.handle("chat-B", "cancel", ["task_a1"], "bob", "discord");
    await handler.handle("chat-B", "goal", ["cancel", "task_a1"], "bob", "discord");
    await handler.handle("chat-B", "pause", ["task_a1"], "bob", "discord");
    await handler.handle("chat-B", "resume", ["task_a1"], "bob", "discord");
    expect(taskManager.cancel).not.toHaveBeenCalled();
    expect(taskManager.pauseTask).not.toHaveBeenCalled();
    expect(taskManager.resumeTask).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith("chat-B", "Task task_a1 not found.");
    expect(sendText).toHaveBeenCalledWith("chat-B", "Could not resume task task_a1: no such task.");
  });

  it("another chat's /detail and /status <id> reveal nothing of the task", async () => {
    const handler = handlerWith();
    await handler.handle("chat-B", "detail", ["task_a1"], "bob", "discord");
    await handler.handle("chat-B", "status", ["task_a1"], "bob", "discord");
    expect(allOutput()).not.toContain("secret");
    expect(allOutput()).not.toContain("title of task_a1");
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenLastCalledWith("chat-B", "Task task_a1 not found.");
  });

  it("in a shared room the requester, not the room, owns the task", async () => {
    const handler = handlerWith();
    await handler.handle("group", "cancel", ["task_g1"], "bob", "slack");
    expect(taskManager.cancel).not.toHaveBeenCalled();
    // The bare form picks the caller's own newest task, not the room's.
    await handler.handle("group", "cancel", [], "bob", "slack");
    expect(taskManager.cancel).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenLastCalledWith("group", "No active tasks to cancel.");

    await handler.handle("group", "cancel", ["task_g1"], "alice", "slack");
    expect(taskManager.cancel).toHaveBeenCalledWith("task_g1", { reason: "user" });
  });

  it("the owner keeps every control over their own task, and a legacy row stays its chat's", async () => {
    const handler = handlerWith();
    await handler.handle("chat-A", "detail", ["task_a1"], "alice", "telegram");
    expect(sendMarkdown).toHaveBeenCalledWith("chat-A", expect.stringContaining("secret prompt of task_a1"));
    await handler.handle("chat-A", "pause", ["task_a1"], "alice", "telegram");
    expect(taskManager.pauseTask).toHaveBeenCalledWith("task_a1");
    await handler.handle("chat-A", "cancel", ["task_l1"], "alice", "telegram");
    expect(taskManager.cancel).toHaveBeenCalledWith("task_l1", { reason: "user" });
  });

  it("on a shared chat channel nobody but the owner stops the daemon or touches its tasks", async () => {
    const stop = vi.fn();
    const start = vi.fn();
    const authority = chatInstanceAuthority({ telegram: { kind: "roster", userIds: ["111", "222"] } });
    const handler = handlerWith({ authority, daemon: { stop, start } });
    await handler.handle("chat-222", "daemon", ["stop"], "222", "telegram");
    await handler.handle("chat-222", "daemon", ["start"], "222", "telegram");
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith("chat-222", expect.stringMatching(/^Refused: .*may not control this instance/));
    await handler.handle("chat-222", "cancel", ["task_d1"], "222", "telegram");
    expect(taskManager.cancel).not.toHaveBeenCalled();
    // Reads stay open.
    await handler.handle("chat-222", "daemon", [], "222", "telegram");
    expect(sendMarkdown).toHaveBeenCalledWith("chat-222", expect.stringContaining("Daemon Status"));
  });

  it("a single-user setup keeps its daemon control and its daemon tasks", async () => {
    const stop = vi.fn();
    const authority = chatInstanceAuthority({ telegram: { kind: "roster", userIds: ["111"] } });
    const handler = handlerWith({ authority, daemon: { stop, start: vi.fn() } });
    await handler.handle("chat-111", "daemon", ["stop"], "111", "telegram");
    expect(stop).toHaveBeenCalledTimes(1);
    await handler.handle("chat-111", "cancel", ["task_d1"], "111", "telegram");
    expect(taskManager.cancel).toHaveBeenCalledWith("task_d1", { reason: "user" });

    // With nothing wired (embedded use) the caller is the sole owner, as before.
    const unwiredStop = vi.fn();
    await handlerWith({ daemon: { stop: unwiredStop, start: vi.fn() } })
      .handle("cli-local", "daemon", ["stop"], "cli-user");
    expect(unwiredStop).toHaveBeenCalledTimes(1);
  });

  it("the channels' standing comes from their own allowlists", () => {
    const channels = chatChannelAccessFromConfig({
      telegram: { allowedUserIds: [111] },
      discord: { allowedUserIds: ["d1"], allowedRoleIds: ["role"] },
      slack: { socketMode: false, allowedUserIds: ["U1"] },
      teams: { allowedUserIds: ["t1", "t2"], allowOpenAccess: false },
    } as never);
    const authority = chatInstanceAuthority(channels);
    expect(authority.standingOf({ chatId: "c", userId: "111", channelType: "telegram" }).role).toBe("owner");
    expect(authority.standingOf({ chatId: "c", userId: "U1", channelType: "slack" }).role).toBe("owner");
    // A role opens Discord to people nobody listed: shared, no owner.
    expect(authority.standingOf({ chatId: "c", userId: "d1", channelType: "discord" }))
      .toEqual({ facts: { shared: true }, role: "guest" });
    expect(authority.standingOf({ chatId: "c", userId: "t1", channelType: "teams" }).facts.shared).toBe(true);
    // The portal gates typed commands itself; the local CLI is the operator.
    expect(authority.standingOf({ chatId: "c", userId: "p", channelType: "web" }).role).toBe("owner");
    expect(authority.standingOf({ chatId: "c", userId: "cli-user", channelType: "cli" }).role).toBe("owner");
    expect(authority.standingOf({ chatId: "c", userId: "x" }).role).toBe("unidentified");
  });
});

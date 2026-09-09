import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { CommandHandler } from "./command-handler.js";
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

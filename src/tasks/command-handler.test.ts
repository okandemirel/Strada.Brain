import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { CommandHandler, chatChannelAccessFromConfig, chatInstanceAuthority } from "./command-handler.js";
import { loadConfig } from "../config/config.js";
import type { TaskCommand } from "./types.js";
import { commandPrivilege } from "../channels/web/instance-access.js";
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
    // Tracked, so the agent's vault hint and the portal see it indexing.
    const trackInit = vi.fn();
    const handler = new CommandHandler(
      {} as never,
      { sendMarkdown, sendText } as never,
    );
    handler.setVaultRegistry({
      createAndRegister,
      trackInit,
      list: () => [vault],
      get: (id: string) => id === "unity:new" ? vault : undefined,
    } as never);

    await handler.handle("chat-1", "vault" as never, ["init", "/tmp/project"], "user-1");

    expect(createAndRegister).toHaveBeenCalledWith("/tmp/project");
    expect(vault.init).toHaveBeenCalled();
    expect(trackInit).toHaveBeenCalledWith(vault, expect.any(Promise));
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

  // vault-intelligence#6: a failed reindex read as "nothing to reindex".
  it("names the paths a sync failed to reindex", async () => {
    const vault = {
      id: "unity:abc",
      sync: vi.fn().mockResolvedValue({ changed: 0, failed: 4, durationMs: 17 }),
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

    expect(sendMarkdown).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("unity:abc: 0 file(s) reindexed, 4 path(s) failed to reindex in 17ms"),
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

  it("/campaign revive goes through the campaign's own revive path with the caller's identity, and reports when nothing is revivable", async () => {
    const handler = makeHandler();
    const reviveByCommand = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    handler.setCampaignManager({ describeStatus: () => snapshot, reviveByCommand });

    // Only the owner revives (campaign#5): the caller's identity reaches that check.
    await handler.handle("chat-1", "campaign", ["revive"], "u7");
    expect(reviveByCommand).toHaveBeenCalledWith("chat-1", "u7");
    expect(sendText).not.toHaveBeenCalled();

    await handler.handle("chat-1", "campaign", ["devam"]);
    expect(String(sendText.mock.calls[0]?.[1])).toMatch(/Nothing to revive/);
  });

  it("/campaign cancel reaches the campaign's cancel path with the caller's identity (CMP-2)", async () => {
    const handler = makeHandler();
    const cancelByCommand = vi.fn().mockResolvedValue(true);
    handler.setCampaignManager({ describeStatus: () => snapshot, reviveByCommand: vi.fn(), cancelByCommand });

    await handler.handle("chat-1", "campaign", ["cancel"], "u7");
    expect(cancelByCommand).toHaveBeenCalledWith("chat-1", "u7");
    expect(sendMarkdown).not.toHaveBeenCalled(); // not the status view
  });

  it("/campaign rows and /campaign rejudge print what the campaign layer reads, in either language (W14)", async () => {
    const handler = makeHandler();
    const describeRows = vi.fn(() => "*GDD rows* — m1: 3 passing");
    const rejudgeByCommand = vi.fn(() => "⚖️ Re-judged: 0 of 6 stored greens would be green");
    handler.setCampaignManager({ describeStatus: () => snapshot, reviveByCommand: vi.fn(), describeRows, rejudgeByCommand });

    await handler.handle("chat-1", "campaign", ["rows", "m1"]);
    expect(describeRows).toHaveBeenCalledWith("chat-1", "m1");
    expect(String(sendMarkdown.mock.calls[0]?.[1])).toContain("m1: 3 passing");

    await handler.handle("chat-1", "campaign", ["satırlar"]);
    expect(describeRows).toHaveBeenLastCalledWith("chat-1", undefined);

    await handler.handle("chat-1", "campaign", ["rejudge", "campaign_1787904962170_18d4t"]);
    expect(rejudgeByCommand).toHaveBeenCalledWith("chat-1", "campaign_1787904962170_18d4t");
    expect(String(sendMarkdown.mock.calls.at(-1)?.[1])).toContain("0 of 6");
  });

  it("/campaign waive passes the target, the whole reason and the caller to the campaign's owner check (W14)", async () => {
    const handler = makeHandler();
    const waiveByCommand = vi.fn().mockResolvedValue(true);
    handler.setCampaignManager({ describeStatus: () => snapshot, reviveByCommand: vi.fn(), waiveByCommand });

    await handler.handle("chat-1", "campaign", ["waive", "R-07", "cut", "from", "the", "MVP"], "u7");
    expect(waiveByCommand).toHaveBeenCalledWith("chat-1", "u7", "R-07", "cut from the MVP");

    await handler.handle("chat-1", "campaign", ["muaf", "§16.2", "MVP", "dışı"], "u7");
    expect(waiveByCommand).toHaveBeenLastCalledWith("chat-1", "u7", "§16.2", "MVP dışı");
    expect(sendMarkdown).not.toHaveBeenCalled(); // not the status view

    // No reason, no waiver: the usage line, and the campaign is not asked.
    await handler.handle("chat-1", "campaign", ["waive", "R-07"], "u7");
    expect(waiveByCommand).toHaveBeenCalledTimes(2);
    expect(String(sendText.mock.calls.at(-1)?.[1])).toMatch(/waive <row id, label or §section> <reason>/);
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

  it("a guest cannot waive a campaign's GDD rows, in either language; the single owner can (W14)", async () => {
    const waiveByCommand = vi.fn().mockResolvedValue(true);
    const source = { describeStatus: () => undefined, reviveByCommand: vi.fn(), waiveByCommand };
    const shared = handlerWith({ authority: chatInstanceAuthority({ telegram: { kind: "roster", userIds: ["111", "222"] } }) });
    shared.setCampaignManager(source);
    await shared.handle("chat-222", "campaign", ["waive", "R-07", "not", "needed"], "222", "telegram");
    await shared.handle("chat-222", "campaign", ["feragat", "R-07", "gerek", "yok"], "222", "telegram");
    expect(waiveByCommand).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith("chat-222", expect.stringMatching(/^Refused: .*may not control this instance/));

    const single = handlerWith({ authority: chatInstanceAuthority({ telegram: { kind: "roster", userIds: ["111"] } }) });
    single.setCampaignManager(source);
    await single.handle("chat-111", "campaign", ["waive", "R-07", "not", "needed"], "111", "telegram");
    expect(waiveByCommand).toHaveBeenCalledWith("chat-111", "111", "R-07", "not needed");
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

describe("One owner rule for every chat command and its plain-language form (owner-commands)", () => {
  // THE DEFECT. The shared-instance model (COMMAND_PRIVILEGE) calls /token,
  // /routing preset, /persona delete, /autonomous on, /campaign revive, /run …
  // owner-only, but only the web portal asked it. Telegram, Discord, Slack and
  // Teams dispatch straight to the handler, which checked /daemon and the task
  // commands and nothing else — so any allowlisted member set the instance's
  // budget, routing and personas. The plain-language "I raised the budget to
  // 100000k" skipped the check on every channel, the portal included.
  const OWNER_TASK = "task_owner";
  const GUEST = { chatId: "chat-222", userId: "222", channelType: "telegram" } as const;
  const OWNER = { chatId: "chat-111", userId: "111", channelType: "telegram" } as const;
  const shared = () => chatInstanceAuthority({ telegram: { kind: "roster", userIds: ["111", "222"] } });
  const singleOwner = () => chatInstanceAuthority({ telegram: { kind: "roster", userIds: ["111"] } });

  // Keyed on TaskCommand: a new command does not compile into this table until
  // its forms are written down, and every form the model calls owner-only is
  // then held to the refusal below without another line of test.
  const FORMS: Readonly<Record<TaskCommand, ReadonlyArray<readonly string[]>>> = {
    tasks: [[]],
    help: [[]],
    agent: [[], ["status"]],
    measure: [[]],
    guardian: [[]],
    status: [[], [OWNER_TASK]],
    detail: [[OWNER_TASK]],
    cancel: [[], [OWNER_TASK]],
    pause: [[], [OWNER_TASK]],
    resume: [[], [OWNER_TASK]],
    goal: [["list"], ["cancel", OWNER_TASK], ["build", "a", "level"]],
    retry: [[]],
    continue: [[]],
    daemon: [[], ["status"], ["triggers"], ["start"], ["stop"], ["restart"]],
    autonomous: [[], ["status"], ["on", "168"], ["off"]],
    model: [[], ["list"], ["info"], ["openai"], ["pin", "openai"], ["unpin"], ["reset"], ["bias", "openai"], ["sabitle", "openai"]],
    campaign: [[], ["cancel"], ["revive"], ["resume"], ["devam"], ["continue"]],
    run: [["rm", "-rf", "build"]],
    routing: [[], ["info"], ["preset", "performance"]],
    token: [[], ["-1"], ["100000k"]],
    persona: [[], ["list"], ["switch", "formal"], ["create", "mine"], ["delete", "ownerstyle"], ["sil", "ownerstyle"]],
    vault: [[], ["status"], ["init", "/tmp/elsewhere"], ["sync"]],
  };
  const forms = (Object.entries(FORMS) as Array<[TaskCommand, ReadonlyArray<readonly string[]>]>)
    .flatMap(([command, list]) => list.map((args) => ({ command, args: [...args], privilege: commandPrivilege(command, args) })));
  const label = (f: { command: string; args: string[] }) => `/${f.command} ${f.args.join(" ")}`.trim();

  /**
   * Every dependency the handler can reach, each one recording any call made
   * on it. A refused command touches none of them: that is what "refused"
   * means, whichever handler a future command adds.
   */
  function world(authority: ReturnType<typeof chatInstanceAuthority>) {
    const touched: string[] = [];
    const replies: string[] = [];
    const recorder = (name: string, impl: Record<string, (...args: unknown[]) => unknown> = {}) =>
      new Proxy({}, {
        get: (_target, prop) => {
          if (typeof prop !== "string" || prop === "then") return undefined;
          return (...args: unknown[]) => {
            touched.push(`${name}.${prop}`);
            return impl[prop]?.(...args);
          };
        },
      });
    const ownerTask = {
      id: OWNER_TASK, chatId: OWNER.chatId, userId: OWNER.userId, status: "executing",
      title: "title of the owner's task", prompt: "secret prompt", result: "secret result",
      progress: [], createdAt: 1, updatedAt: 1,
    };
    const taskManager = recorder("taskManager", {
      getStatus: (id) => (id === OWNER_TASK ? ownerTask : null),
      listTasks: (chatId) => (chatId === OWNER.chatId ? [ownerTask] : []),
    });
    const channel = new Proxy({}, {
      get: (_target, prop) => {
        if (typeof prop !== "string" || prop === "then") return undefined;
        return async (...args: unknown[]) => {
          if (prop === "sendText" || prop === "sendMarkdown") replies.push(String(args[1]));
          else touched.push(`channel.${prop}`);
          return undefined;
        };
      },
    });
    const handler = new CommandHandler(
      taskManager as never,
      channel as never,
      recorder("providerManager") as never,
      recorder("dmPolicy") as never,
      recorder("userProfileStore") as never,
      recorder("soulLoader") as never,
      recorder("runtimeArtifacts") as never,
      "fingerprint",
      recorder("heartbeat") as never,
      { instanceAuthority: authority },
    );
    handler.setProviderRouter(recorder("providerRouter") as never);
    handler.setUnifiedBudgetManager(recorder("budget") as never);
    handler.setTaskCheckpointStore(recorder("checkpoints", {
      loadLatest: async () => ({ taskId: "task_cp", chatId: GUEST.chatId, stage: "budget_exceeded", touchedFiles: [], lastUserMessage: "go", timestamp: 1 }),
    }) as never);
    handler.setOrchestrator(recorder("orchestrator", { continueFromCheckpoint: async () => ({ status: "resumed" }) }) as never);
    handler.setVaultRegistry(recorder("vaults") as never);
    handler.setProjectPath("/tmp/project-that-must-not-be-touched");
    handler.setCampaignManager(recorder("campaign") as never);
    handler.setRealTreeGuardian(recorder("guardian") as never);
    handler.setDeliveryMeasurer(((root: string) => { touched.push(`measure(${root})`); return {} as never; }));
    // What the wiring itself calls (the campaign layer's gate) is not a command's doing.
    touched.length = 0;
    return { handler, touched, replies };
  }

  const run = async (w: ReturnType<typeof world>, who: typeof GUEST | typeof OWNER, command: TaskCommand, args: string[]) =>
    w.handler.handle(who.chatId, command, args, who.userId, who.channelType).catch(() => undefined);

  it("covers every privileged command the model names", () => {
    const privileged = [...new Set(forms.filter((f) => f.privilege.kind === "owner-only").map((f) => f.command))].sort();
    expect(privileged).toEqual(["autonomous", "campaign", "daemon", "model", "persona", "routing", "run", "token", "vault"]);
  });

  it("refuses every owner-only form a guest types before it touches anything", async () => {
    const leaks: string[] = [];
    for (const form of forms.filter((f) => f.privilege.kind === "owner-only")) {
      const w = world(shared());
      await run(w, GUEST, form.command, form.args);
      const refused = w.replies.length === 1 && /^Refused: guest identity 222 may not /.test(w.replies[0]!);
      if (!refused || w.touched.length > 0) {
        leaks.push(`${label(form)} → touched [${w.touched.join(", ")}], replied ${JSON.stringify(w.replies)}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it("leaves the owner of a single-user roster every one of those powers", async () => {
    const refused: string[] = [];
    for (const form of forms.filter((f) => f.privilege.kind === "owner-only")) {
      const w = world(singleOwner());
      await run(w, OWNER, form.command, form.args);
      if (w.replies.some((r) => r.startsWith("Refused"))) refused.push(label(form));
    }
    expect(refused).toEqual([]);
  });

  // On a shared roster every caller was a guest, the operator included, so the
  // gate above refused the owner every one of these forms too: nobody could
  // revive a failed campaign from chat, and no other surface revives one. The
  // operator is named per channel, from the environment, and keeps them all;
  // the rest of the roster is refused exactly as before.
  it("leaves the operator named for a shared roster every one of those powers, and nobody else", async () => {
    const config = loadConfig({
      UNITY_PROJECT_PATH: process.cwd(),
      ANTHROPIC_API_KEY: "sk-test-key-123",
      ALLOWED_TELEGRAM_USER_IDS: "111,222",
      TELEGRAM_OWNER_USER_IDS: "111",
    });
    const named = () => chatInstanceAuthority(chatChannelAccessFromConfig(config));
    const ownerRefused: string[] = [];
    const guestLeaks: string[] = [];
    for (const form of forms.filter((f) => f.privilege.kind === "owner-only")) {
      const owner = world(named());
      await run(owner, OWNER, form.command, form.args);
      if (owner.replies.some((r) => r.startsWith("Refused"))) ownerRefused.push(label(form));

      const guest = world(named());
      await run(guest, GUEST, form.command, form.args);
      const refused = guest.replies.length === 1
        && /^Refused: guest identity 222 may not .* only the instance owner 111 may/.test(guest.replies[0]!);
      if (!refused || guest.touched.length > 0) {
        guestLeaks.push(`${label(form)} → touched [${guest.touched.join(", ")}], replied ${JSON.stringify(guest.replies)}`);
      }
    }
    expect(ownerRefused).toEqual([]);
    expect(guestLeaks).toEqual([]);
  });

  it("names the operator on every roster channel, a role- or open-admitted one included", () => {
    const authority = chatInstanceAuthority(chatChannelAccessFromConfig(loadConfig({
      UNITY_PROJECT_PATH: process.cwd(),
      ANTHROPIC_API_KEY: "sk-test-key-123",
      ALLOWED_DISCORD_ROLE_IDS: "role",
      DISCORD_OWNER_USER_IDS: "d-op",
      ALLOWED_SLACK_USER_IDS: "U1,U2",
      SLACK_OWNER_USER_IDS: "U2",
      TEAMS_ALLOW_OPEN_ACCESS: "true",
      TEAMS_OWNER_USER_IDS: "t-op, t-op2",
      ALLOWED_TELEGRAM_USER_IDS: "111,222",
    })));
    const role = (channelType: string, userId: string) => authority.standingOf({ chatId: "c", userId, channelType }).role;
    expect([role("discord", "d-op"), role("discord", "someone-with-the-role")]).toEqual(["owner", "guest"]);
    expect([role("slack", "U2"), role("slack", "U1")]).toEqual(["owner", "guest"]);
    expect([role("teams", "t-op"), role("teams", "t-op2"), role("teams", "anyone")]).toEqual(["owner", "owner", "guest"]);
    // Still shared: naming the operator does not make the others' traffic theirs.
    expect(authority.standingOf({ chatId: "c", userId: "d-op", channelType: "discord" }).facts.shared).toBe(true);
    // Nobody named, nobody owns a shared roster (the rule before this).
    expect(role("telegram", "111")).toBe("guest");
  });

  it("keeps a guest's reads and own-traffic forms open, and never hands it the owner's task", async () => {
    const wrong: string[] = [];
    for (const form of forms.filter((f) => f.privilege.kind !== "owner-only")) {
      const w = world(shared());
      await run(w, GUEST, form.command, form.args);
      if (w.replies.some((r) => r.startsWith("Refused"))) wrong.push(`${label(form)} refused`);
      const acted = w.touched.filter((t) => /^taskManager\.(cancel|pauseTask|resumeTask)$/.test(t));
      if (form.privilege.kind === "task" && acted.length > 0) wrong.push(`${label(form)} → ${acted.join(", ")}`);
      if (w.replies.some((r) => r.includes("secret") || r.includes("owner's task"))) wrong.push(`${label(form)} revealed the task`);
    }
    expect(wrong).toEqual([]);
  });

  it("refuses a guest's plain-language budget change exactly like /token", async () => {
    const guest = world(shared());
    const handled = await guest.handler.tryHandleImplicitRecovery(
      GUEST.chatId, "I raised the budget to 100000k", GUEST.userId, GUEST.channelType,
    );
    expect(handled).toBe(true);
    expect(guest.touched).not.toContain("budget.updateConfig");
    expect(guest.touched).not.toContain("orchestrator.continueFromCheckpoint");
    expect(guest.replies.join("\n")).toMatch(/^Refused: guest identity 222 may not change this instance's setup/);

    const owner = world(singleOwner());
    await owner.handler.tryHandleImplicitRecovery(OWNER.chatId, "I raised the budget to 100000k", OWNER.userId, OWNER.channelType);
    expect(owner.touched).toContain("budget.updateConfig");
    expect(owner.touched).toContain("orchestrator.continueFromCheckpoint");
  });

  it("gives the campaign layer's sentences the rule its commands answer to", async () => {
    // "kampanya devam" is `/campaign revive` in words and is matched by the
    // campaign layer, not by detectCommand — so the handler hands it the rule.
    type Gate = (caller: { chatId: string; userId?: string; channelType?: string }, command: TaskCommand, args: readonly string[]) => Promise<boolean>;
    const gateOf = (authority: ReturnType<typeof chatInstanceAuthority>) => {
      const w = world(authority);
      let gate: Gate | undefined;
      w.handler.setCampaignManager({ describeStatus: () => undefined, reviveByCommand: async () => false, setCommandGate: (g: Gate) => { gate = g; } });
      return { gate: gate!, replies: w.replies };
    };

    const guest = gateOf(shared());
    expect(await guest.gate(GUEST, "campaign", ["revive"])).toBe(true);
    expect(guest.replies).toEqual([expect.stringMatching(/^Refused: guest identity 222 may not control this instance "\/campaign revive"/)]);
    // A form the model leaves open stays open.
    expect(await guest.gate(GUEST, "campaign", ["cancel"])).toBe(false);

    const owner = gateOf(singleOwner());
    expect(await owner.gate(OWNER, "campaign", ["revive"])).toBe(false);
    expect(owner.replies).toEqual([]);
  });

  // The refusal is the verdict and the notice a courtesy. The orchestrator asks
  // this rule while a run is set up, so a notice the platform rejects (a chat
  // it cannot reach) failed the whole run instead of refusing one directive.
  it("keeps a refusal whose notice cannot be delivered, without throwing", async () => {
    const handler = new CommandHandler(
      {} as never,
      { sendText: async () => { throw new Error("400: Bad Request: chat not found"); } } as never,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { instanceAuthority: shared() },
    );
    await expect(handler.commandGate(GUEST, "autonomous", ["on"])).resolves.toBe(true);
  });

  it("asks the portal who a web caller is, because the portal gates only typed commands", async () => {
    // The portal's identities live in its identity store; the handler used to
    // call every web caller the owner because the portal gates `/token`. The
    // plain-language budget line is not a command to the portal and reached
    // the handler unchecked.
    const OWNER_PROFILE = "owner-profile";
    const portal = {
      instanceStandingOf: (caller: { userId?: string; channelType?: string }) =>
        caller.channelType !== "web"
          ? undefined
          : {
            facts: { shared: true, ownerProfileId: OWNER_PROFILE },
            role: caller.userId === OWNER_PROFILE ? "owner" as const : "guest" as const,
          },
    };
    const authority = chatInstanceAuthority(chatChannelAccessFromConfig({} as never), portal);
    expect(authority.standingOf({ chatId: "c", userId: "guest-profile", channelType: "web" }).role).toBe("guest");
    expect(authority.standingOf({ chatId: "c", userId: OWNER_PROFILE, channelType: "web" }).role).toBe("owner");
    // A gated channel the source does not answer for is the local operator.
    expect(authority.standingOf({ chatId: "c", userId: "cli-user", channelType: "cli" }).role).toBe("owner");

    const guest = world(authority);
    await guest.handler.tryHandleImplicitRecovery("ws-guest", "budget 1k", "guest-profile", "web");
    expect(guest.touched).not.toContain("budget.updateConfig");
    expect(guest.replies.join("\n")).toMatch(/^Refused: guest identity guest-profile/);

    const owner = world(authority);
    await owner.handler.tryHandleImplicitRecovery("ws-owner", "budget 1k", OWNER_PROFILE, "web");
    expect(owner.touched).toContain("budget.updateConfig");
  });
});

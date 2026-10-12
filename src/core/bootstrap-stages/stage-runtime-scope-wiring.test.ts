/**
 * GDD-drift W15: the scope gate's parts reach the CampaignManager the daemon
 * actually builds. The writer (W06), the filtered acceptance run (W08), the
 * stored checks and verdicts (W03) and the CAMPAIGN_SCOPE_GATE mode were each
 * tested on their own while the one construction site production runs passed
 * none of them: the gate stayed off whatever the flag said, and shadow or on
 * would have had no writer and no runner. Tested but never wired is this
 * codebase's recurring failure, so the manager here is built by
 * initializeTaskRuntimeStage itself — dropping any argument at that site
 * fails a test below.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type * as winston from "winston";
import { AcceptanceAuthor } from "../../campaign/acceptance-author.js";
import type { CampaignManager } from "../../campaign/campaign-manager.js";
import { CampaignStorage } from "../../campaign/campaign-storage.js";
import type { AcceptanceSuiteRunner } from "../../campaign/scope-types.js";
import type { Config } from "../../config/config.js";
import { initializeTaskRuntimeStage } from "./stage-runtime.js";

const ROOT_PREFIX = "stage-scope-wiring-";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  // Last in, first out: a root goes only after the manager holding its
  // database has closed it — Windows will not remove an open SQLite file.
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
// Every boot opens a real campaigns.db under its own temp root; the suite has
// to take them all with it.
afterAll(() => {
  expect(readdirSync(tmpdir()).filter((name) => name.startsWith(ROOT_PREFIX))).toEqual([]);
});

function providerManager() {
  return {
    getProvider: vi.fn(() => ({ name: "invented-chain" })),
    listExecutionCandidates: vi.fn(() => [{ name: "invented-writer", defaultModel: "quill-1" }]),
    getProviderByName: vi.fn((name: string, model?: string) => ({ name: `${name}:${model ?? ""}` })),
  };
}

function toolRegistry() {
  return {
    getAvailableToolNames: () => ["unity_playmode_verify"],
    execute: vi.fn(async () => ({ content: "PlayMode verification passed: 1 of 1 tests passed" })),
  };
}

/** Boots the task runtime stage with the campaign section given (or none) and returns what it built. */
async function boot(
  campaign: Config["campaign"] | undefined,
  options: { readonly registry?: ReturnType<typeof toolRegistry>; readonly streamingEnabled?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), ROOT_PREFIX));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const providers = providerManager();
  const config = {
    unityProjectPath: root,
    memory: { enabled: true, dbPath: join(root, "memory") },
    tasks: { concurrencyLimit: 1, messageBurstWindowMs: 0, messageBurstMaxMessages: 1 },
    autoUpdate: { enabled: false },
    streamingEnabled: options.streamingEnabled ?? true,
    autonomousDefaultEnabled: false,
    autonomousDefaultHours: 1,
    interaction: {},
    language: "en",
    ...(campaign ? { campaign } : {}),
  } as unknown as Config;
  const taskManager = Object.assign(new EventEmitter(), {
    recoverOnStartup: vi.fn(),
    findLatestUserChat: vi.fn(() => undefined),
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as winston.Logger;
  const result = await initializeTaskRuntimeStage(
    {
      daemonMode: false,
      config,
      logger,
      orchestrator: { setTaskManager: vi.fn(), setCommandGate: vi.fn() } as never,
      providerManager: providers as never,
      channel: { name: "invented", sendMarkdown: vi.fn(async () => {}) } as never,
      dmPolicy: {} as never,
      soulLoader: {} as never,
      activityRegistry: { getActiveChatIds: vi.fn(() => []) } as never,
      startupNotices: [],
      ...(options.registry ? { toolRegistry: options.registry as never } : {}),
    },
    {
      createTaskStorage: () => ({ initialize: vi.fn() }) as never,
      createBackgroundExecutor: () =>
        ({ setTaskManager: vi.fn(), setCampaignDesignDocs: vi.fn(), setWorkspaceCommittedListener: vi.fn() }) as never,
      createTaskManager: () => taskManager as never,
      createCommandHandler: () =>
        ({
          setProviderRouter: vi.fn(),
          setProjectPath: vi.fn(),
          setCampaignManager: vi.fn(),
          setRealTreeGuardian: vi.fn(),
          commandGate: vi.fn(),
        }) as never,
      createMessageRouter: () => ({ setCampaignManager: vi.fn() }) as never,
      createProgressReporter: vi.fn(),
    },
  );
  cleanups.push(async () => {
    result.realTreeGuardian?.stop();
    // Awaited: dispose closes campaigns.db and waits out any probe the manager
    // still has running in the root.
    await result.campaignManager?.dispose();
  });
  // A campaign layer that failed to come up is logged and swallowed by the
  // stage; a wiring test that let that pass would be testing nothing.
  expect(logger.warn).not.toHaveBeenCalledWith("Campaign layer disabled", expect.anything());
  expect(result.campaignManager).toBeDefined();
  return { manager: result.campaignManager!, providers, root, config, logger };
}

/** The manager's private dependencies, read the way only a wiring test should. */
function internals(manager: CampaignManager) {
  return manager as unknown as {
    readonly storage: CampaignStorage;
    readonly acceptanceAuthor: AcceptanceAuthor | null;
    readonly runAcceptanceSuite?: AcceptanceSuiteRunner;
    readonly maxRequirementRows?: number;
  };
}

describe("production construction wires the scope gate (GDD-drift W15)", () => {
  it("passes CAMPAIGN_SCOPE_GATE's mode, the writer, the acceptance run and the row cap", async () => {
    const registry = toolRegistry();
    const { manager } = await boot(
      { scopeGate: "shadow", acceptanceWriter: { provider: "invented-writer", model: "quill-1" }, maxRequirementRows: 321 },
      { registry },
    );
    expect(manager.scopeGateWiring()).toEqual({
      mode: "shadow",
      writer: "invented-writer:quill-1 (configured)",
      runner: true,
    });
    expect(internals(manager).maxRequirementRows).toBe(321);
  });

  it("the gate reads the mode it was configured with, on as well as shadow", async () => {
    const { manager } = await boot({ scopeGate: "on", maxRequirementRows: 400 }, { registry: toolRegistry() });
    expect(manager.scopeGateWiring().mode).toBe("on");
    // A second value, so a row cap pinned to a constant at the site fails too.
    expect(internals(manager).maxRequirementRows).toBe(400);
    // No writer configured is auto, not no writer.
    expect(manager.scopeGateWiring().writer).toBe("auto (the first healthy model that did not work on the milestone)");
  });

  it("the writer is W06's AcceptanceAuthor over the daemon's own provider manager, streaming as configured", async () => {
    const { manager, providers } = await boot(
      { scopeGate: "shadow", acceptanceWriter: { provider: "invented-writer", model: "quill-1" }, maxRequirementRows: 400 },
      { registry: toolRegistry() },
    );
    const author = internals(manager).acceptanceAuthor;
    expect(author).toBeInstanceOf(AcceptanceAuthor);
    expect((author as unknown as { streaming?: boolean }).streaming).toBe(true);
    const picked = author!.pickWriter(["a-worker-model"]);
    expect(providers.listExecutionCandidates).toHaveBeenCalled();
    expect(providers.getProviderByName).toHaveBeenCalledWith("invented-writer", "quill-1");
    expect(picked?.writer).toEqual({ provider: "invented-writer", model: "quill-1", independence: "different-model" });
  });

  it("the writer streams only when the daemon does: STREAMING_ENABLED=false reaches it as false", async () => {
    // The boot above streams, so a site that hardcoded `streaming: true` passed
    // it; the value has to follow the config in both directions.
    const { manager } = await boot({ scopeGate: "shadow", maxRequirementRows: 400 }, { registry: toolRegistry(), streamingEnabled: false });
    const author = internals(manager).acceptanceAuthor;
    expect(author).toBeInstanceOf(AcceptanceAuthor);
    expect((author as unknown as { streaming?: boolean }).streaming).toBe(false);
  });

  it("the acceptance run is W08's filtered unity_playmode_verify call through the daemon's tool registry", async () => {
    const registry = toolRegistry();
    const { manager, root } = await boot({ scopeGate: "shadow", maxRequirementRows: 400 }, { registry });
    const run = internals(manager).runAcceptanceSuite;
    expect(run).toBeTypeOf("function");
    const filter = "Strada.Acceptance.M1.Acceptance_M1.R1_aaaaaa;Strada.Acceptance.M1.Acceptance_M1.R2_bbbbbb";
    const out = await run!(root, "run-invented-1", { testFilter: filter });
    expect(registry.execute).toHaveBeenCalledWith(
      "unity_playmode_verify",
      { evidenceRunId: "run-invented-1", testFilter: filter },
      expect.objectContaining({ projectPath: root }),
    );
    expect(out.content).toContain("1 of 1 tests passed");
  });

  it("no tool registry means no acceptance runner: not admitted, never a pass", async () => {
    const { manager } = await boot({ scopeGate: "shadow", maxRequirementRows: 400 });
    expect(manager.scopeGateWiring().runner).toBe(false);
    expect(internals(manager).runAcceptanceSuite).toBeUndefined();
  });

  it("the stored checks and verdicts live in the campaign store under the memory directory (W03)", async () => {
    const { manager, config } = await boot({ scopeGate: "shadow", maxRequirementRows: 400 });
    const storage = internals(manager).storage;
    expect(storage).toBeInstanceOf(CampaignStorage);
    expect((storage as unknown as { db: { name: string } }).db.name).toBe(join(config.memory.dbPath, "campaigns.db"));
    expect(storage.listJudgements("no-such-campaign")).toEqual([]);
    expect(storage.listAcceptance("no-such-campaign")).toEqual([]);
  });

  it("off mode: the parts are built but nothing is called — no provider is listed, no tool runs", async () => {
    const registry = toolRegistry();
    const { manager, providers } = await boot({ scopeGate: "off", maxRequirementRows: 400 }, { registry });
    expect(manager.scopeGateWiring().mode).toBe("off");
    expect(providers.listExecutionCandidates).not.toHaveBeenCalled();
    expect(providers.getProviderByName).not.toHaveBeenCalled();
    expect(registry.execute).not.toHaveBeenCalled();
  });

  it("a config with no campaign section keeps the campaign layer, with the gate off, and says so", async () => {
    const { manager, logger } = await boot(undefined, { registry: toolRegistry() });
    expect(manager.scopeGateWiring().mode).toBe("off");
    // Off because the section is missing is not off because it was asked for:
    // the log names the gap, or a config path that lost the section would
    // switch the gate off without a trace.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/no campaign section.*scope gate is off/i),
      expect.objectContaining({ missing: "campaign" }),
    );
  });

  it("a config with the campaign section raises no missing-section warning", async () => {
    const { logger } = await boot({ scopeGate: "off", maxRequirementRows: 400 }, { registry: toolRegistry() });
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringMatching(/no campaign section/i), expect.anything());
  });
});

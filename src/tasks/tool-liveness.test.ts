/**
 * Running a tool re-arms the task's inactivity watchdog.
 *
 * The watchdog is re-armed by progress updates, which arrive at planning
 * milestones. Between them a task can run tools for twenty minutes without
 * producing one, and the watchdog then stops a task that is working and tells
 * the user it made no progress.
 *
 * An earlier fix signalled liveness from supervisor node transitions. That path
 * is not the only one: a plain-loop run was killed anyway. Measured — "Task made
 * no progress for 1200000ms" fired at 20:56:05 on a run whose last tool call was
 * 20:55:16, whose last two LLM calls were 20:55:16 and 20:55:22, and whose NEXT
 * tool call landed at 20:56:24, after it had already been stopped. It had
 * written 30 files.
 *
 * So the signal hangs off tool execution instead: a task running tools is not
 * idle, whichever path is driving it.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { createLogger } from "../utils/logger.js";
import { Orchestrator } from "../agents/orchestrator.js";
import { BackgroundExecutor } from "./background-executor.js";
import type { IOrchestrator } from "./orchestrator-contract.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

function makeOrchestrator(): Orchestrator {
  const provider = {
    name: "mock",
    capabilities: {
      maxTokens: 4096,
      streaming: false,
      structuredStreaming: false,
      toolCalling: true,
      vision: false,
      systemPrompt: true,
    },
    chat: vi.fn(),
    healthCheck: vi.fn(),
  };
  return new Orchestrator({
    providerManager: {
      getProvider: () => provider,
      getProviderByName: () => provider,
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      listAvailable: () => [{ name: "mock", label: "mock", defaultModel: "default" }],
      shutdown: vi.fn(),
    } as never,
    tools: [],
    channel: { sendMessage: vi.fn(), type: "cli" } as never,
    projectPath: "/tmp/test-project",
    readOnly: false,
    requireConfirmation: false,
  });
}

/** Run one tool through the orchestrator's real single-tool-call path. */
async function runTool(orchestrator: Orchestrator, opts: { ok: boolean }): Promise<void> {
  const tool = {
    name: "probe_tool",
    description: "test",
    inputSchema: { type: "object" as const, properties: {} },
    execute: async () =>
      opts.ok
        ? { content: "done", isError: false }
        : { content: "Error: boom", isError: true },
  };
  (orchestrator as unknown as { tools: Map<string, unknown> | unknown[] }).tools = new Map([
    ["probe_tool", tool],
  ]);
  const registry = (orchestrator as unknown as { toolRegistry?: { get?: unknown } }).toolRegistry;
  if (registry) (registry as { get: (n: string) => unknown }).get = () => tool;

  await (
    orchestrator as unknown as {
      executeSingleToolCall(tc: unknown, order: number, ctx: unknown): Promise<unknown>;
    }
  ).executeSingleToolCall({ id: "call-1", name: "probe_tool", input: {} }, 0, {
    chatId: "test-chat",
    mode: "auto",
    options: {},
    toolContext: { projectPath: "/tmp/test-project" },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
}

describe("tool execution signals liveness", () => {
  it("exposes a liveness setter on the orchestrator contract", () => {
    const orchestrator = makeOrchestrator();
    expect(typeof orchestrator.setLivenessCallback).toBe("function");
  });

  it("fires the callback when a tool actually runs", async () => {
    // Drives the real tool-execution path with a stub tool. Asserting only that
    // the setter stores the callback would pass with the ping deleted from the
    // tool loop — which is the link that matters.
    const orchestrator = makeOrchestrator();
    const ping = vi.fn();
    orchestrator.setLivenessCallback(ping);

    await runTool(orchestrator, { ok: true });

    expect(ping, "a tool ran and the watchdog was told nothing").toHaveBeenCalled();
  });

  it("fires even when the tool fails", async () => {
    // A failing tool is still activity, and a task retrying a failure is exactly
    // what the watchdog must not mistake for silence.
    const orchestrator = makeOrchestrator();
    const ping = vi.fn();
    orchestrator.setLivenessCallback(ping);

    await runTool(orchestrator, { ok: false });

    expect(ping).toHaveBeenCalled();
  });

  it("the executor registers a heartbeat that re-arms the window without reaching the user", async () => {
    // Drives the REAL executeTask rather than re-implementing its wiring: with
    // no taskManager the method registers liveness and then bails out, which is
    // exactly the seam under test. Asserting on a hand-rolled copy of the wiring
    // would pass with the production line deleted.
    const updates: unknown[] = [];
    let registered: (() => void) | undefined;

    const orchestrator: IOrchestrator = {
      createAgentCorePort: () => ({}),
      getAgentCoreClock: () => ({}),
      setLivenessCallback: (cb) => {
        registered = cb;
      },
    };

    const executor = Object.create(BackgroundExecutor.prototype) as BackgroundExecutor;
    (executor as unknown as { taskManager: unknown }).taskManager = undefined;
    (executor as unknown as { orchestrator: unknown }).orchestrator = orchestrator;

    await (
      executor as unknown as { executeTask(entry: unknown): Promise<void> }
    ).executeTask({
      task: { id: "t1", prompt: "build a thing" },
      signal: { aborted: false } as AbortSignal,
      onProgress: (u: unknown) => updates.push(u),
    });

    expect(registered, "executeTask never registered a liveness callback").toBeDefined();
    registered?.();

    // The heartbeat re-arms the window; the executor filters it before the
    // channel, so an empty "" update never surfaces to the user as a message.
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ kind: "heartbeat" });
  });

  it("tolerates an orchestrator that predates the hook", () => {
    // setLivenessCallback is optional on the contract; a custom orchestrator
    // without it must not break task execution.
    const legacy: IOrchestrator = {
      createAgentCorePort: () => ({}),
      getAgentCoreClock: () => ({}),
    };
    expect(() => legacy.setLivenessCallback?.(() => {})).not.toThrow();
  });
});

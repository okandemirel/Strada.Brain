/**
 * audited 2026-09-02: the pre-tool-call intervention scan evaluated every
 * matched instinct on every tool call and then threw the verdict away. Of the
 * four actions, `suggest`/`enrich` were never inspected, `warn` reached only
 * logger.debug, and `auto_apply` wrote an audit row — so a learned warning
 * could never reach the model, the user, or the tool result, while the scan
 * was still paid per call. A warn-tier match is now appended to the tool
 * result the model reads, and logged as the intervention it was.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { createMockProvider, createMockChannel } from "../test-helpers.js";
import { createLogger } from "../utils/logger.js";
import { InterventionEngine } from "../learning/intervention/intervention-engine.js";
import type { Instinct } from "../learning/types.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

function instinct(overrides: Partial<Instinct>): Instinct {
  return {
    id: `instinct_${Math.random().toString(36).slice(2)}` as Instinct["id"],
    name: "Prefer the module API",
    type: "workflow",
    status: "active",
    confidence: 0.65,
    trustLevel: "warn_enabled",
    triggerPattern: "probe_read",
    action: "Read through StradaModule.Resolve instead of touching the scene directly.",
    contextConditions: [],
    stats: { timesSuggested: 3, timesApplied: 3, timesFailed: 0, successRate: 1, averageExecutionMs: 0 },
    createdAt: Date.now() as Instinct["createdAt"],
    updatedAt: Date.now() as Instinct["updatedAt"],
    sourceTrajectoryIds: [],
    tags: [],
    ...overrides,
  } as Instinct;
}

function build(matched: Instinct[]) {
  const probe = {
    name: "probe_read",
    description: "probe_read",
    inputSchema: { type: "object" as const, properties: {} },
    metadata: { readOnly: true },
    execute: vi.fn().mockResolvedValue({ content: "ran" }),
  };
  const storage = { logIntervention: vi.fn() };
  const orch = new Orchestrator({
    providerManager: {
      getProvider: () => createMockProvider(),
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: [probe] as never,
    channel: createMockChannel() as never,
    projectPath: "/tmp/test-project",
    readOnly: false,
    requireConfirmation: false,
    instinctRetriever: { getMatchedInstincts: vi.fn().mockResolvedValue(matched) } as never,
    interventionEngine: new InterventionEngine(storage as never),
  } as never);
  const run = () =>
    (
      orch as unknown as {
        executeToolCalls: (
          chatId: string,
          calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
          options: Record<string, unknown>,
        ) => Promise<Array<{ content: string; isError?: boolean }>>;
      }
    ).executeToolCalls("chat1", [{ id: "tc1", name: "probe_read", input: {} }], { mode: "interactive" });
  return { run, probe, storage };
}

describe("a warn-tier instinct reaches the model", () => {
  it("appends the learned warning to the tool result and logs the intervention", async () => {
    const warned = instinct({});
    const { run, probe, storage } = build([warned]);

    const [result] = await run();

    expect(probe.execute, "the tool itself must still run").toHaveBeenCalledTimes(1);
    expect(result?.isError).toBeFalsy();
    expect(result?.content, "the warning died in logger.debug").toContain("[learned warning");
    expect(result?.content).toContain(warned.action);
    expect(storage.logIntervention).toHaveBeenCalledTimes(1);
    expect(storage.logIntervention.mock.calls[0]?.[0]).toMatchObject({
      instinctId: warned.id,
      toolName: "probe_read",
      tier: "warn",
    });
  });

  it("leaves the result untouched for a passive (trust 'new') instinct", async () => {
    const { run, storage } = build([instinct({ trustLevel: "new" })]);

    const [result] = await run();

    expect(result?.content).toBe("ran");
    expect(storage.logIntervention).not.toHaveBeenCalled();
  });

  it("leaves the result untouched when nothing matched", async () => {
    const { run } = build([]);

    const [result] = await run();

    expect(result?.content).toBe("ran");
  });
});

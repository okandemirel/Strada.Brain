/**
 * The phase's write restriction has to hold at the gate, not only at the offer.
 *
 * `buildWorkerToolDefinitions` removes write tools from what the model is shown
 * while the agent is PLANNING, REPLANNING or REFLECTING. That is where the rule
 * lived and the only place it was enforced. A write named in a response anyway —
 * a remembered tool name, a replayed call, a name the model simply produced —
 * went straight to the tool, because the restriction was a property of the menu
 * rather than of the kitchen.
 *
 * This is the same shape as the batch_execute hole fixed in c34c50c9: a rule
 * enforced on one path, and everything that arrives by another path exempt by
 * construction. It is worth stating plainly, because it is the pattern rather
 * than either instance that keeps producing these.
 *
 * The restriction only applies where the phase is known: a call with no agent
 * state attached is left exactly as it was, so this is a tightening of a known
 * case and not a new refusal of unknown ones.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { AgentPhase, createInitialState } from "./agent-state.js";
import { createMockProvider, createMockChannel } from "../test-helpers.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

function tool(name: string, mutates: boolean) {
  return {
    name,
    description: name,
    inputSchema: { type: "object" as const, properties: {} },
    metadata: { readOnly: !mutates },
    execute: vi.fn().mockResolvedValue({ content: "ran" }),
  };
}

let orch: Orchestrator;
let writeTool: ReturnType<typeof tool>;
let readTool: ReturnType<typeof tool>;

beforeEach(() => {
  writeTool = tool("file_write", true);
  readTool = tool("file_read", false);
  orch = new Orchestrator({
    providerManager: {
      getProvider: () => createMockProvider(),
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: [writeTool, readTool] as never,
    channel: createMockChannel() as never,
    projectPath: "/tmp/test-project",
    readOnly: false,
    requireConfirmation: false,
  });
});

const run = (toolName: string, phase?: AgentPhase) =>
  (
    orch as unknown as {
      executeToolCalls: (
        chatId: string,
        calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
        options: Record<string, unknown>,
      ) => Promise<Array<{ content: string; isError?: boolean }>>;
    }
  ).executeToolCalls(
    "chat1",
    [{ id: "tc1", name: toolName, input: { path: "Assets/Modules/AModule/A.cs", content: "// x" } }],
    phase === undefined
      ? { mode: "background" }
      : { mode: "background", agentState: { ...createInitialState("t"), phase } },
  );

describe("a write named while the agent is not executing", () => {
  for (const phase of [AgentPhase.PLANNING, AgentPhase.REPLANNING, AgentPhase.REFLECTING]) {
    it(`is refused in ${phase}`, async () => {
      const [result] = await run("file_write", phase);

      expect(writeTool.execute, `the write ran during ${phase}`).not.toHaveBeenCalled();
      expect(result?.isError).toBe(true);
      expect(result?.content).toMatch(/plan|reflect/i);
    });
  }

  it("still runs while executing", async () => {
    await run("file_write", AgentPhase.EXECUTING);
    expect(writeTool.execute).toHaveBeenCalledTimes(1);
  });

  it("leaves reads alone in every phase", async () => {
    await run("file_read", AgentPhase.PLANNING);
    expect(readTool.execute).toHaveBeenCalledTimes(1);
  });

  it("does not refuse when no phase is known", async () => {
    // Callers that attach no agent state keep their previous behaviour; this
    // rule tightens a known case rather than guessing at unknown ones.
    await run("file_write", undefined);
    expect(writeTool.execute).toHaveBeenCalledTimes(1);
  });
});

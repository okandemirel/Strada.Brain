/**
 * A synthesized chain is a batch the model did not have to spell out.
 *
 * CompositeTool runs each of its steps through ToolRegistry.execute, so none of
 * them passes executeSingleToolCall, where every write gate lives. The review
 * switched on the composite's own name and fell to `default: return {
 * approved: true }`; isDestructiveForConfirmation knew only batch_execute; the
 * size estimate read the composite's input instead of its steps; and the prompt,
 * when one fired, read "Confirm file edit: `unknown`". A chain carrying a
 * file_delete or `rm -r Assets/Modules` ran with no review and no prompt: the
 * hole batch_execute had before it was gated.
 *
 * These drive the real dispatch path with a real CompositeTool, registered the
 * way ChainManager registers one, and hold each chain to what the same write
 * gets when it is made directly.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { createMockProvider, createMockChannel } from "../test-helpers.js";
import { createLogger } from "../utils/logger.js";
import { ApprovalLevel } from "../security/dm-policy.js";
import { CompositeTool } from "../learning/chains/composite-tool.js";
import { computeCompositeMetadata, type ChainStepMapping } from "../learning/chains/chain-types.js";
import type { ToolRegistry } from "../core/tool-registry.js";

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

type ToolCallInput = { id: string; name: string; input: Record<string, unknown> };
type Result = { content: string; isError?: boolean };

let tools: Record<string, ReturnType<typeof tool>>;
let composites: Record<string, CompositeTool>;
// In the ToolRegistry and not in the orchestrator: registered after it was
// built, as a hot-loaded skill's tools are.
let lateTools: Record<string, ReturnType<typeof tool>>;
let requestConfirmation: ReturnType<typeof vi.fn>;
let orch: Orchestrator;

function build(level: ApprovalLevel): void {
  tools = {
    file_read: tool("file_read", false),
    file_write: tool("file_write", true),
    file_edit: tool("file_edit", true),
    file_delete: tool("file_delete", true),
    shell_exec: tool("shell_exec", true),
    batch_execute: tool("batch_execute", true),
  };
  composites = {};
  lateTools = {};
  // Strada.MCP's batch_execute looks each operation up through Brain's
  // ToolRegistry (setToolResolver), where ChainManager registers composites:
  // a chain named in a batch runs.
  tools.batch_execute!.execute.mockImplementation(async (input: Record<string, unknown>, ctx: unknown) => {
    for (const op of input["operations"] as Array<{ tool: string; input: Record<string, unknown> }>) {
      await (tools[op.tool] ?? composites[op.tool] ?? lateTools[op.tool])!.execute(op.input, ctx as never);
    }
    return { content: "ran" };
  });
  const channel = { ...createMockChannel(), requestConfirmation };
  orch = new Orchestrator({
    providerManager: {
      getProvider: () => createMockProvider(),
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: Object.values(tools) as never,
    channel: channel as never,
    projectPath: "/tmp/test-project",
    readOnly: false,
    requireConfirmation: true,
    conformanceFrameworkPathsOnly: true,
    dmPolicyConfig: { defaultLevel: level },
  } as never);
}

/**
 * A chain over the mock tools, registered as ChainManager registers one.
 * `held: false` leaves it in the registry only: the view of an orchestrator
 * built from a registry snapshot (a per-agent or delegated one) before the
 * chain was synthesized.
 */
function chain(
  name: string,
  toolSequence: string[],
  parameterMappings: ChainStepMapping[],
  { held = true }: { held?: boolean } = {},
): void {
  const resolve = (n: string) => tools[n] ?? lateTools[n];
  const registry = {
    has: (n: string) => resolve(n) !== undefined,
    get: resolve,
    execute: (n: string, input: Record<string, unknown>, ctx: unknown) => resolve(n)!.execute(input, ctx),
  } as unknown as ToolRegistry;
  const composite = new CompositeTool(
    {
      name,
      description: name,
      inputSchema: {},
      chainMetadata: { toolSequence, parameterMappings, successRate: 1, occurrences: 3 },
    },
    registry,
    { emit: vi.fn() } as never,
  );
  if (held) orch.addTool(composite, computeCompositeMetadata(toolSequence.map(() => undefined)));
  composites[name] = composite;
}

const fromUser = (stepIndex: number, parameterName: string, sourceKey = parameterName): ChainStepMapping => ({
  stepIndex,
  parameterName,
  source: "userInput",
  sourceKey,
});

const run = async (
  name: string,
  input: Record<string, unknown>,
  mode: "interactive" | "background" = "interactive",
): Promise<Result> => {
  const [result] = await (
    orch as unknown as {
      executeToolCalls: (
        chatId: string,
        calls: ToolCallInput[],
        options: Record<string, unknown>,
      ) => Promise<Result[]>;
    }
  ).executeToolCalls("chat1", [{ id: "tc1", name, input }], { mode });
  return result!;
};

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

beforeEach(() => {
  requestConfirmation = vi.fn().mockResolvedValue("Yes");
});

describe("a synthesized chain is judged like the calls it contains", () => {
  it("asks before a chain that deletes a file, as it asks before the delete alone", async () => {
    build(ApprovalLevel.DESTRUCTIVE_ONLY);
    requestConfirmation.mockResolvedValue("No");
    const path = "Assets/Modules/AModule/Old.cs";

    await run("file_delete", { path });
    expect(requestConfirmation, "the direct rule changed; this test is now vacuous").toHaveBeenCalledTimes(1);
    expect(tools.file_delete!.execute).not.toHaveBeenCalled();
    requestConfirmation.mockClear();

    chain("read_then_delete", ["file_read", "file_delete"], [fromUser(0, "path"), fromUser(1, "path")]);
    await run("read_then_delete", { path });

    expect(requestConfirmation, "a chained file_delete ran unconfirmed").toHaveBeenCalledTimes(1);
    expect(tools.file_delete!.execute, "the user said no and the chain deleted anyway").not.toHaveBeenCalled();
    expect(tools.file_read!.execute, "a refused chain ran its first step").not.toHaveBeenCalled();
    // The human has to see what they are approving, not "file edit: unknown".
    const { question, details } = requestConfirmation.mock.calls[0]![0] as { question: string; details: string };
    expect(question).toContain("read_then_delete");
    expect(details).toContain(`file_delete: ${path}`);
  });

  it("measures a chain's edits, not the chain's own input, against the SMART line threshold", async () => {
    build(ApprovalLevel.SMART);
    const path = "Assets/Modules/AModule/A.cs";

    await run("file_edit", { path, old_text: "a", new_text: lines(200) });
    expect(requestConfirmation, "the direct rule changed; this test is now vacuous").toHaveBeenCalledTimes(1);
    requestConfirmation.mockClear();
    tools.file_edit!.execute.mockClear();

    // The chain's own `content` is one line; the edit it carries is 200.
    chain("edit_twice", ["file_edit", "file_edit"], [
      fromUser(0, "path"),
      fromUser(0, "old_text", "first_old"),
      fromUser(0, "new_text", "first_new"),
      fromUser(1, "path"),
      fromUser(1, "old_text", "second_old"),
      fromUser(1, "new_text", "second_new"),
    ]);
    await run("edit_twice", {
      path,
      content: "x",
      first_old: "a",
      first_new: "b",
      second_old: "c",
      second_new: lines(200),
    });
    expect(requestConfirmation, "a 200-line chained edit was sized as one line").toHaveBeenCalledTimes(1);
    requestConfirmation.mockClear();

    // And measured, not merely unknown: two one-line edits stay under it.
    await run("edit_twice", { path, first_old: "a", first_new: "b", second_old: "c", second_new: "d" });
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(tools.file_edit!.execute).toHaveBeenCalledTimes(4);
  });

  it("refuses a chain whose shell step would be refused alone", async () => {
    build(ApprovalLevel.SMART);
    const command = "rm -r Assets/Modules";

    const direct = await run("shell_exec", { command }, "background");
    expect(direct.isError, "the direct rule changed; this test is now vacuous").toBe(true);
    expect(tools.shell_exec!.execute).not.toHaveBeenCalled();

    chain("look_then_run", ["file_read", "shell_exec"], [fromUser(0, "path"), fromUser(1, "command")]);
    const chained = await run("look_then_run", { path: "Assets", command }, "background");

    expect(tools.shell_exec!.execute, "a chained rm -r ran unreviewed").not.toHaveBeenCalled();
    expect(chained.isError).toBe(true);
    expect(chained.content).toContain("looks destructive");
  });

  it("holds a chain's file_write to the framework-paths wall", async () => {
    build(ApprovalLevel.SMART);

    chain("read_then_write", ["file_read", "file_write"], [fromUser(0, "path"), fromUser(1, "path"), fromUser(1, "content")]);
    const result = await run("read_then_write", { path: "Assets/Scripts/Loose.cs", content: "class L {}" });

    expect(tools.file_write!.execute, "loose game code was written through a chain").not.toHaveBeenCalled();
    expect(requestConfirmation, "a generic prompt replaced the wall").not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Assets/Modules/");
  });

  it("refuses a write whose input is only known once an earlier step has run", async () => {
    // What file_read returns decides where file_write lands, or what it
    // writes; no review before the chain runs can see either, so the chain is
    // not run on trust. `content` is the case a missing-field check would
    // wave through: the path alone is a conforming one.
    for (const fed of ["path", "content"]) {
      build(ApprovalLevel.SMART);
      chain("read_then_write_it", ["file_read", "file_write"], [
        fromUser(0, "path"),
        fromUser(1, "path"),
        fromUser(1, "content"),
        { stepIndex: 1, parameterName: fed, source: "previousOutput", sourceKey: "result" },
      ]);

      const result = await run(
        "read_then_write_it",
        { path: "Assets/Modules/AModule/A.cs", content: "// reviewed" },
        "background",
      );

      expect(tools.file_read!.execute, fed).not.toHaveBeenCalled();
      expect(tools.file_write!.execute, `a write whose ${fed} came from step 1 ran`).not.toHaveBeenCalled();
      expect(result.isError, fed).toBe(true);
      expect(result.content).toContain(`chain cannot be reviewed: step 2 (file_write) takes ${fed}`);
    }
  });

  it("still runs a chain whose steps would each be approved directly", async () => {
    build(ApprovalLevel.SMART);
    chain("read_then_write", ["file_read", "file_write"], [fromUser(0, "path"), fromUser(1, "path"), fromUser(1, "content")]);

    const result = await run(
      "read_then_write",
      { path: "Assets/Modules/AModule/A.cs", content: "// ok" },
      "background",
    );

    expect(result.isError, result.content).toBeFalsy();
    expect(tools.file_read!.execute).toHaveBeenCalledTimes(1);
    expect(tools.file_write!.execute).toHaveBeenCalledTimes(1);
  });
});

describe("a synthesized chain named as an operation of batch_execute", () => {
  // The batch's destructive check, size estimate and prompt read one level:
  // a chain among its operations was judged by its own name and input, so a
  // chain the direct path prompts for ran unprompted one hop away.
  const batchOf = (name: string, input: Record<string, unknown>) => ({ operations: [{ tool: name, input }] });

  it("does not delete a file unconfirmed under DESTRUCTIVE_ONLY", async () => {
    build(ApprovalLevel.DESTRUCTIVE_ONLY);
    requestConfirmation.mockResolvedValue("No");
    const path = "Assets/Modules/AModule/Old.cs";

    await run("batch_execute", batchOf("file_delete", { path }));
    expect(requestConfirmation, "the direct rule changed; this test is now vacuous").toHaveBeenCalledTimes(1);
    expect(tools.file_delete!.execute).not.toHaveBeenCalled();

    chain("read_then_delete", ["file_read", "file_delete"], [fromUser(0, "path"), fromUser(1, "path")]);
    const result = await run("batch_execute", batchOf("read_then_delete", { path }));

    expect(tools.file_delete!.execute, "a chained file_delete in a batch ran unconfirmed").not.toHaveBeenCalled();
    expect(tools.file_read!.execute, "a refused batch ran its chain's first step").not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    // The agent is told where the chain can run: on its own, where its steps
    // are reviewed and named in the prompt.
    expect(result.content).toContain("nests read_then_delete");
  });

  it("does not run a chained rm -r that the same chain called directly is prompted for", async () => {
    build(ApprovalLevel.DESTRUCTIVE_ONLY);
    requestConfirmation.mockResolvedValue("No");
    const command = "rm -r Assets/Modules";
    chain("look_then_run", ["file_read", "shell_exec"], [fromUser(0, "path"), fromUser(1, "command")]);

    await run("look_then_run", { path: "Assets", command });
    expect(requestConfirmation, "the direct rule changed; this test is now vacuous").toHaveBeenCalledTimes(1);
    expect(tools.shell_exec!.execute).not.toHaveBeenCalled();

    for (const mode of ["interactive", "background"] as const) {
      const result = await run("batch_execute", batchOf("look_then_run", { path: "Assets", command }), mode);
      expect(tools.shell_exec!.execute, `a chained rm -r in a batch ran (${mode})`).not.toHaveBeenCalled();
      expect(result.isError, mode).toBe(true);
    }
  });

  it("does not size a chain's 200-line edit by the chain's own input under SMART", async () => {
    build(ApprovalLevel.SMART);
    requestConfirmation.mockResolvedValue("No");
    chain("edit_twice", ["file_edit", "file_edit"], [
      fromUser(0, "path"),
      fromUser(0, "old_text", "first_old"),
      fromUser(0, "new_text", "first_new"),
      fromUser(1, "path"),
      fromUser(1, "old_text", "second_old"),
      fromUser(1, "new_text", "second_new"),
    ]);

    await run("batch_execute", batchOf("edit_twice", {
      path: "Assets/Modules/AModule/A.cs",
      content: "x",
      first_old: "a",
      first_new: "b",
      second_old: "c",
      second_new: lines(200),
    }));

    expect(tools.file_edit!.execute, "a 200-line chained edit in a batch ran unprompted").not.toHaveBeenCalled();
  });
});

describe("a tool the registry resolves that this orchestrator does not hold", () => {
  // batch_execute resolves each operation through the live ToolRegistry, and a
  // chain each of its steps, while every judge of them read the orchestrator's
  // own tools. An orchestrator built from a registry snapshot does not hold a
  // chain synthesized after it was built: the chain's name was taken for a
  // read, and the batch ran it with no review and no prompt.
  const batchOf = (name: string, input: Record<string, unknown>) => ({ operations: [{ tool: name, input }] });

  it("does not delete a file unconfirmed through a chain synthesized after the orchestrator was built", async () => {
    build(ApprovalLevel.DESTRUCTIVE_ONLY);
    requestConfirmation.mockResolvedValue("No");
    const path = "Assets/Modules/AModule/Old.cs";
    chain("read_then_delete", ["file_read", "file_delete"], [fromUser(0, "path"), fromUser(1, "path")], { held: false });

    for (const mode of ["interactive", "background"] as const) {
      const result = await run("batch_execute", batchOf("read_then_delete", { path }), mode);
      expect(tools.file_delete!.execute, `a late chain's file_delete in a batch ran unconfirmed (${mode})`).not.toHaveBeenCalled();
      expect(tools.file_read!.execute, `a refused batch ran its chain's first step (${mode})`).not.toHaveBeenCalled();
      expect(result.isError, mode).toBe(true);
    }
  });

  it("does not run a late chain's rm -r in the background", async () => {
    build(ApprovalLevel.SMART);
    chain("look_then_run", ["file_read", "shell_exec"], [fromUser(0, "path"), fromUser(1, "command")], { held: false });

    const result = await run(
      "batch_execute",
      batchOf("look_then_run", { path: "Assets", command: "rm -r Assets/Modules" }),
      "background",
    );

    expect(tools.shell_exec!.execute, "a late chain's rm -r in a batch ran unreviewed").not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it("does not take a hot-loaded writer it does not hold for a read", async () => {
    build(ApprovalLevel.SMART);
    lateTools.skill_write_asmdef = tool("skill_write_asmdef", true);

    const result = await run(
      "batch_execute",
      batchOf("skill_write_asmdef", { path: "Assets/Modules/AModule/A.asmdef" }),
      "background",
    );

    expect(lateTools.skill_write_asmdef!.execute, "a writer only the registry holds ran unreviewed in a batch").not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content).toContain("skill_write_asmdef");
  });

  it("does not take a chain step it does not hold for a read", async () => {
    build(ApprovalLevel.SMART);
    lateTools.skill_write_asmdef = tool("skill_write_asmdef", true);
    chain("read_then_skill", ["file_read", "skill_write_asmdef"], [fromUser(0, "path"), fromUser(1, "path")]);

    const result = await run("read_then_skill", { path: "Assets/Modules/AModule/A.asmdef" }, "background");

    expect(lateTools.skill_write_asmdef!.execute, "a chain step only the registry holds ran unreviewed").not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it("still runs a batch of tools it holds", async () => {
    build(ApprovalLevel.SMART);

    const result = await run(
      "batch_execute",
      batchOf("file_write", { path: "Assets/Modules/AModule/A.cs", content: "// ok" }),
      "background",
    );

    expect(result.isError, result.content).toBeFalsy();
    expect(tools.file_write!.execute).toHaveBeenCalledTimes(1);
  });
});

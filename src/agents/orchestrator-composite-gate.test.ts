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
let requestConfirmation: ReturnType<typeof vi.fn>;
let orch: Orchestrator;

function build(level: ApprovalLevel): void {
  tools = {
    file_read: tool("file_read", false),
    file_write: tool("file_write", true),
    file_edit: tool("file_edit", true),
    file_delete: tool("file_delete", true),
    shell_exec: tool("shell_exec", true),
  };
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

/** A chain over the mock tools, registered as ChainManager registers one. */
function chain(name: string, toolSequence: string[], parameterMappings: ChainStepMapping[]): void {
  const registry = {
    has: (n: string) => n in tools,
    get: (n: string) => tools[n],
    execute: (n: string, input: Record<string, unknown>, ctx: unknown) => tools[n]!.execute(input, ctx),
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
  orch.addTool(composite, computeCompositeMetadata(toolSequence.map(() => undefined)));
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

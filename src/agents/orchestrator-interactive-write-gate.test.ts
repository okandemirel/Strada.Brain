/**
 * The write review has to run on every policy branch, not only self_managed.
 *
 * `reviewSelfManagedWriteOperation` holds the framework-paths wall and the
 * batch_execute operation review. Until 2026-09-02 it was called from exactly
 * one place: the `executionPolicy.mode === "self_managed"` arm of
 * executeSingleToolCall. An ordinary interactive chat (requireEditConfirmation
 * on, autonomous mode off) resolves every write to `user_confirm`, which went
 * straight to a generic destructive/threshold check — so a loose
 * Assets/Scripts/*.cs edit ran with no wall and no prompt, and a batch_execute
 * carrying thirty writes and a file_delete ran with no review and no prompt.
 *
 * The existing gate tests call the private review directly with a literal
 * "interactive" argument, which only flavors the message; these drive the
 * real dispatch path so the mode is what is under test.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
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

type ToolCallInput = { id: string; name: string; input: Record<string, unknown> };

let orch: Orchestrator;
let fileEdit: ReturnType<typeof tool>;
let fileWrite: ReturnType<typeof tool>;
let batch: ReturnType<typeof tool>;
let requestConfirmation: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fileEdit = tool("file_edit", true);
  fileWrite = tool("file_write", true);
  batch = tool("batch_execute", true);
  requestConfirmation = vi.fn().mockResolvedValue("Yes");
  const channel = { ...createMockChannel(), requestConfirmation };
  orch = new Orchestrator({
    providerManager: {
      getProvider: () => createMockProvider(),
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: [fileEdit, fileWrite, batch] as never,
    channel: channel as never,
    projectPath: "/tmp/test-project",
    readOnly: false,
    requireConfirmation: true,
    conformanceFrameworkPathsOnly: true,
  } as never);
});

const runInteractive = (call: ToolCallInput) =>
  (
    orch as unknown as {
      executeToolCalls: (
        chatId: string,
        calls: ToolCallInput[],
        options: Record<string, unknown>,
      ) => Promise<Array<{ content: string; isError?: boolean }>>;
    }
  ).executeToolCalls("chat1", [call], { mode: "interactive" });

describe("interactive (user_confirm) writes pass the same local review as self-managed ones", () => {
  it("refuses a loose Assets/Scripts/*.cs file_edit instead of running it unprompted", async () => {
    const [result] = await runInteractive({
      id: "tc1",
      name: "file_edit",
      input: { path: "Assets/Scripts/PlayerController.cs", old_text: "a", new_text: "b" },
    });

    expect(fileEdit.execute, "loose game code was edited in interactive mode").not.toHaveBeenCalled();
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("Assets/Modules/");
  });

  it("refuses a loose file_write with the wall's reason before any confirmation prompt", async () => {
    const [result] = await runInteractive({
      id: "tc1",
      name: "file_write",
      input: { path: "Assets/Scripts/PlayerController.cs", content: "class X {}" },
    });

    expect(fileWrite.execute).not.toHaveBeenCalled();
    expect(requestConfirmation, "a generic prompt replaced the wall").not.toHaveBeenCalled();
    expect(result?.content).toContain("Assets/Modules/");
  });

  it("reviews the operations inside a batch_execute", async () => {
    const [result] = await runInteractive({
      id: "tc1",
      name: "batch_execute",
      input: {
        operations: [
          { tool: "file_write", input: { path: "Assets/Modules/AModule/A.cs", content: "// ok" } },
          { tool: "file_write", input: { path: "Assets/Scripts/Loose.cs", content: "class L {}" } },
        ],
      },
    });

    expect(batch.execute, "a batch carrying loose game code ran").not.toHaveBeenCalled();
    expect(result?.isError).toBe(true);
    expect(result?.content).toMatch(/batched file_write was refused/);
  });

  it("asks the user before running a batch that carries a destructive operation", async () => {
    await runInteractive({
      id: "tc1",
      name: "batch_execute",
      input: {
        operations: [
          { tool: "file_write", input: { path: "Assets/Modules/AModule/A.cs", content: "// ok" } },
          { tool: "file_delete", input: { path: "Assets/Modules/AModule/Old.cs" } },
        ],
      },
    });

    expect(requestConfirmation, "a batched file_delete ran unconfirmed").toHaveBeenCalledTimes(1);
    expect(batch.execute).toHaveBeenCalledTimes(1);
  });

  it("still lets a conforming edit through", async () => {
    await runInteractive({
      id: "tc1",
      name: "file_edit",
      input: { path: "Assets/Modules/AModule/A.cs", old_text: "a", new_text: "b" },
    });
    expect(fileEdit.execute).toHaveBeenCalledTimes(1);
  });
});

// audited 2026-09-02: the confirmation check was handed a stub diff with
// `totalChanges: 1`, so DMPolicy's SMART line threshold (50) compared 1 >= 50
// on every write ever made — SMART silently degraded to DESTRUCTIVE_ONLY and
// an edit that rewrote 800 lines ran with no prompt. Sizes are now derived
// from the tool input; a size that cannot be derived is not reported as one
// line.
describe("SMART approval sees the real size of a write", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

  it("asks before a file_edit that replaces more lines than the threshold", async () => {
    await runInteractive({
      id: "tc1",
      name: "file_edit",
      input: { path: "Assets/Modules/AModule/A.cs", old_string: "a", new_string: lines(80) },
    });
    expect(requestConfirmation, "an 80-line edit ran unprompted").toHaveBeenCalledTimes(1);
    expect(fileEdit.execute).toHaveBeenCalledTimes(1);
  });

  it("does not ask for a small file_edit", async () => {
    await runInteractive({
      id: "tc1",
      name: "file_edit",
      input: { path: "Assets/Modules/AModule/A.cs", old_string: "a", new_string: lines(3) },
    });
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(fileEdit.execute).toHaveBeenCalledTimes(1);
  });

  it("asks when a write tool's size cannot be derived, instead of calling it one line", async () => {
    const opaque = tool("project_apply_patch", true);
    orch = new Orchestrator({
      providerManager: {
        getProvider: () => createMockProvider(),
        getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
        shutdown: vi.fn(),
      } as never,
      tools: [opaque] as never,
      channel: { ...createMockChannel(), requestConfirmation } as never,
      projectPath: "/tmp/test-project",
      readOnly: false,
      requireConfirmation: true,
      conformanceFrameworkPathsOnly: true,
    } as never);

    await runInteractive({ id: "tc1", name: "project_apply_patch", input: { patchId: "p1" } });

    expect(requestConfirmation, "an unmeasurable write ran unprompted").toHaveBeenCalledTimes(1);
  });
});

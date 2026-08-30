/**
 * The write gate has to hold on both dispatch paths, not one.
 *
 * `batch_execute` takes an array of operations and calls `tool.execute` on each
 * directly, so nothing in a batch passes through `executeSingleToolCall` — where
 * every gate the product has actually lives. The self-managed write review
 * switches on tool name, and `batch_execute` fell to `default: return {
 * approved: true }`: an unconditional stamp that never read the operations
 * array.
 *
 * Measured over five days: 177 batch calls carrying 1,345 inner operations,
 * including 261 `file_write`, 31 `file_delete`, 29 `file_rename` and 21
 * `shell_exec`. More writes went through the ungated batch path than the gated
 * direct one.
 *
 * These tests drive the review through the orchestrator, because the point is
 * not that a parser works — it is that a batch is judged by the same rules a
 * direct call is judged by.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { createMockProvider, createMockChannel } from "../test-helpers.js";

type Review = { approved: boolean; reason?: string };

/** Reach the private review the way executeSingleToolCall does. */
const review = (
  orch: Orchestrator,
  toolName: string,
  input: Record<string, unknown>,
): Promise<Review> =>
  Promise.resolve(
    (
      orch as unknown as {
        reviewSelfManagedWriteOperation: (
          chatId: string,
          toolName: string,
          input: Record<string, unknown>,
          mode: unknown,
          options: unknown,
        ) => Promise<Review> | Review;
      }
    ).reviewSelfManagedWriteOperation("chat1", toolName, input, "interactive", {}),
  );

function tool(name: string, mutates: boolean) {
  return {
    name,
    description: name,
    inputSchema: { type: "object" as const, properties: {} },
    metadata: { readOnly: !mutates },
    execute: vi.fn().mockResolvedValue({ content: "ok" }),
  };
}

let orch: Orchestrator;

beforeEach(() => {
  orch = new Orchestrator({
    providerManager: {
      getProvider: () => createMockProvider(),
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: [
      tool("file_read", false),
      tool("file_write", true),
      tool("file_delete", true),
      tool("batch_execute", true),
    ] as never,
    channel: createMockChannel() as never,
    projectPath: "/tmp/test-project",
    readOnly: false,
    requireConfirmation: true,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("a batch is judged like the calls it contains", () => {
  it("approves a batch whose writes would each be approved directly", async () => {
    const result = await review(orch, "batch_execute", {
      operations: [
        { tool: "file_write", input: { path: "Assets/Modules/AModule/A.cs", content: "// a" } },
        { tool: "file_read", input: { path: "Assets/B.cs" } },
      ],
    });

    expect(result.approved, result.reason).toBe(true);
  });

  it("refuses a batch containing a write the direct path would refuse", async () => {
    // A direct file_write with no path is refused for "target path is missing".
    // Inside a batch it was approved, and then ran.
    const direct = await review(orch, "file_write", { content: "// no path" });
    expect(direct.approved, "the direct rule changed; this test is now vacuous").toBe(false);

    const batched = await review(orch, "batch_execute", {
      operations: [{ tool: "file_write", input: { content: "// no path" } }],
    });

    expect(batched.approved).toBe(false);
    expect(batched.reason).toContain("file_write");
  });

  it("refuses the whole batch, not just the bad operation", async () => {
    // The operations run in sequence against one workspace: approving the ones
    // before a refused write leaves the project half-changed.
    const result = await review(orch, "batch_execute", {
      operations: [
        { tool: "file_write", input: { path: "Assets/Modules/GoodModule/Good.cs", content: "// fine" } },
        { tool: "file_delete", input: {} },
      ],
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("file_delete");
  });

  it("lets reads through without treating them as writes", async () => {
    const result = await review(orch, "batch_execute", {
      operations: [
        { tool: "file_read", input: {} },
        { tool: "file_read", input: { path: "Assets/B.cs" } },
      ],
    });

    expect(result.approved, result.reason).toBe(true);
  });

  it("refuses a batch it cannot read rather than finding no writes in it", async () => {
    // The original hole in its purest form: an unreadable operations array must
    // not be equivalent to an empty one.
    for (const input of [
      {},
      { operations: "file_write" },
      { operations: [] },
      { operations: [{ tool: "file_write" }] },
    ]) {
      const result = await review(orch, "batch_execute", input);
      expect(result.approved, `approved unreadable batch: ${JSON.stringify(input)}`).toBe(false);
    }
  });

  it("refuses a batch nested inside a batch", async () => {
    const result = await review(orch, "batch_execute", {
      operations: [
        {
          tool: "batch_execute",
          input: { operations: [{ tool: "file_write", input: { path: "A.cs", content: "x" } }] },
        },
      ],
    });

    expect(result.approved).toBe(false);
  });
});
